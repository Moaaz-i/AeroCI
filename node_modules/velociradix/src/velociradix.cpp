#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "velociradix.hpp"

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <memory>
#include <mutex>
#include <sstream>
#ifdef _WIN32
#ifndef _CRT_SECURE_NO_WARNINGS
#define _CRT_SECURE_NO_WARNINGS
#endif
#ifndef FD_SETSIZE
#define FD_SETSIZE 1024
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <io.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/types.h>
#pragma comment(lib, "ws2_32.lib")
typedef int socklen_t;
typedef intptr_t ssize_t;

struct WSAInit {
    WSAInit() {
        WSADATA wsa;
        WSAStartup(MAKEWORD(2, 2), &wsa);
    }
    ~WSAInit() {
        WSACleanup();
    }
};
static WSAInit g_wsa_init;

#else
#include <fcntl.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#include <arpa/inet.h>
#endif

#ifdef __APPLE__
#include <sys/event.h>
#include <sys/time.h>
#include <mach/thread_policy.h>
#include <mach/thread_act.h>
#elif defined(_WIN32)
// Windows socket polling fallback
#else
#include <sys/epoll.h>
#include <sched.h>
#include <pthread.h>
#endif

#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif

namespace velociradix {

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------
namespace json {

std::string string(const std::string& s) {
    std::string o;
    o.reserve(s.size() + 2);
    o += '"';
    for (char c : s) {
        switch (c) {
            case '"':  o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            case '\b': o += "\\b"; break;
            case '\f': o += "\\f"; break;
            default:
                if ((unsigned char)c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", (unsigned)c);
                    o += buf;
                } else {
                    o += c;
                }
        }
    }
    o += '"';
    return o;
}

std::string object(std::initializer_list<std::pair<std::string, std::string>> kv) {
    std::string o = "{";
    bool first = true;
    for (const auto& p : kv) {
        if (!first) o += ',';
        first = false;
        o += json::string(p.first);
        o += ':';
        o += p.second;
    }
    o += '}';
    return o;
}

} // namespace json

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
static int hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static std::string url_decode(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (size_t i = 0; i < s.size(); ++i) {
        if (s[i] == '%' && i + 2 < s.size()) {
            int hi = hexval(s[i + 1]);
            int lo = hexval(s[i + 2]);
            if (hi >= 0 && lo >= 0) {
                out += (char)((hi << 4) | lo);
                i += 2;
            } else {
                out += s[i];
            }
        } else if (s[i] == '+') {
            out += ' ';
        } else {
            out += s[i];
        }
    }
    return out;
}

static std::string url_encode(const std::string& s) {
    static const char* hex = "0123456789ABCDEF";
    std::string out;
    out.reserve(s.size());
    for (unsigned char c : s) {
        if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
            out += (char)c;
        } else {
            out += '%';
            out += hex[c >> 4];
            out += hex[c & 0xF];
        }
    }
    return out;
}

static void to_lower(std::string& s) {
    for (auto& c : s) c = (char)std::tolower((unsigned char)c);
}

static void split_path(const std::string& p, std::vector<std::string>& segs) {
    segs.clear();
    size_t i = 1;
    while (i < p.size()) {
        size_t slash = p.find('/', i);
        size_t end = (slash == std::string::npos) ? p.size() : slash;
        if (end > i) {
            std::string seg(p, i, end - i);
            if (seg.find('%') != std::string::npos) seg = url_decode(seg);
            segs.push_back(std::move(seg));
        }
        if (slash == std::string::npos) break;
        i = slash + 1;
    }
}

static void append_uint(std::string& o, size_t v) {
    char b[32];
    int n = 0;
    do { b[n++] = (char)('0' + v % 10); v /= 10; } while (v);
    while (n) o += b[--n];
}

static const char* status_phrase(int code) {
    switch (code) {
        case 200: return "OK";
        case 201: return "Created";
        case 204: return "No Content";
        case 301: return "Moved Permanently";
        case 302: return "Found";
        case 304: return "Not Modified";
        case 400: return "Bad Request";
        case 401: return "Unauthorized";
        case 403: return "Forbidden";
        case 404: return "Not Found";
        case 413: return "Payload Too Large";
        case 500: return "Internal Server Error";
        case 501: return "Not Implemented";
        default:  return "Unknown";
    }
}

static std::string http_date(time_t t) {
    struct tm tm;
#ifdef _WIN32
    gmtime_s(&tm, &t);
#else
    gmtime_r(&t, &tm);
#endif
    char buf[64];
    std::strftime(buf, sizeof(buf), "%a, %d %b %Y %H:%M:%S GMT", &tm);
    return buf;
}

static const std::string& cached_date() {
    static thread_local time_t g_ts = 0;
    static thread_local std::string g_str;
    time_t now = time(nullptr);
    if (now != g_ts) {
        g_ts = now;
        g_str = http_date(now);
    }
    return g_str;
}

// Pre-built tail fragments (refreshed once per second) to avoid repeated
// string concatenation on the hot response-building path.
struct CachedTail {
    time_t ts = 0;
    std::string keep_alive; // "Connection: keep-alive\r\nDate: ...\r\nServer: velociradix\r\n\r\n"
    std::string close_conn; // "Connection: close\r\nDate: ...\r\nServer: velociradix\r\n\r\n"
};
static thread_local CachedTail g_tail;

static void refresh_tail() {
    time_t now = time(nullptr);
    if (now == g_tail.ts) return;
    g_tail.ts = now;
    const std::string& d = http_date(now);
    g_tail.keep_alive  = "Connection: keep-alive\r\nDate: ";
    g_tail.keep_alive += d;
    g_tail.keep_alive += "\r\nServer: velociradix\r\n\r\n";
    g_tail.close_conn  = "Connection: close\r\nDate: ";
    g_tail.close_conn += d;
    g_tail.close_conn += "\r\nServer: velociradix\r\n\r\n";
}

static bool set_nonblocking(int fd) {
#ifdef _WIN32
    u_long mode = 1;
    return ioctlsocket(fd, FIONBIO, &mode) == 0;
#else
    int flags = fcntl(fd, F_GETFL, 0);
    return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
#endif
}

static void ignore_sigpipe() {
#ifndef _WIN32
    static std::once_flag once;
    std::call_once(once, [] { std::signal(SIGPIPE, SIG_IGN); });
#endif
}

static std::string_view find_header(const Request& req, std::string_view name) {
    for (const auto& h : req.headers) {
        if (h.first == name) return h.second;
    }
    return {};
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------
std::string_view Request::header(std::string_view name) const {
    return find_header(*this, name);
}

std::string Request::query(std::string_view key) const {
    std::string key_str(key);
    auto it = query_cache.find(key_str);
    if (it != query_cache.end()) return it->second;
    std::string value;
    if (!query_string.empty()) {
        size_t i = 0;
        while (i <= query_string.size()) {
            size_t amp = query_string.find('&', i);
            size_t end = (amp == std::string_view::npos) ? query_string.size() : amp;
            if (end > i) {
                size_t eq = query_string.find('=', i);
                if (eq != std::string_view::npos && eq < end) {
                    std::string k = url_decode(std::string(query_string.substr(i, eq - i)));
                    if (k == key) {
                        value = url_decode(std::string(query_string.substr(eq + 1, end - eq - 1)));
                        break;
                    }
                }
            }
            if (amp == std::string_view::npos) break;
            i = amp + 1;
        }
    }
    query_cache[key_str] = value;
    return value;
}

std::string Request::cookie(std::string_view key) const {
    std::string key_str(key);
    auto it = cookie_cache.find(key_str);
    if (it != cookie_cache.end()) return it->second;
    std::string value;
    std::string_view chdr = find_header(*this, "cookie");
    if (!chdr.empty()) {
        size_t i = 0;
        while (i <= chdr.size()) {
            size_t semi = chdr.find(';', i);
            size_t end = (semi == std::string_view::npos) ? chdr.size() : semi;
            size_t eq = chdr.find('=', i);
            if (eq != std::string_view::npos && eq < end) {
                std::string_view k = chdr.substr(i, eq - i);
                while (!k.empty() && (k.front() == ' ' || k.front() == '\t')) k.remove_prefix(1);
                while (!k.empty() && (k.back() == ' ' || k.back() == '\t')) k.remove_suffix(1);
                if (k == key) {
                    value = url_decode(std::string(chdr.substr(eq + 1, end - eq - 1)));
                    break;
                }
            }
            if (semi == std::string_view::npos) break;
            i = semi + 1;
        }
    }
    cookie_cache[key_str] = value;
    return value;
}

bool Request::keep_alive() const {
    std::string_view conn = find_header(*this, "connection");
    if (http_version == "HTTP/1.0") {
        return !conn.empty() && conn.find("keep-alive") != std::string_view::npos;
    }
    if (!conn.empty()) return conn.find("close") == std::string_view::npos;
    return true;
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------
void Response::set_header(const std::string& name, const std::string& value) {
    std::string lname = name;
    to_lower(lname);
    for (auto& h : headers) {
        if (h.first == lname) { h.second = value; return; }
    }
    headers.emplace_back(std::move(lname), value);
}

const std::string* Response::get_header(const std::string& name) const {
    for (const auto& h : headers) {
        if (h.first == name) return &h.second;
    }
    return nullptr;
}

void Response::set_cookie(const std::string& name, const std::string& value,
                          const std::string& attributes) {
    std::string c = name + "=" + url_encode(value);
    if (!attributes.empty()) c += attributes;
    set_header("set-cookie", c);
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------
void Context::send(const std::string& text) {
    if (ended) return;
    ended = true;
    res.body = text;
}

void Context::json(const std::string& raw) {
    if (ended) return;
    res.set_header("content-type", "application/json");
    send(raw);
}

void Context::html(const std::string& body) {
    if (ended) return;
    res.set_header("content-type", "text/html");
    send(body);
}

void Context::redirect(const std::string& location, int code) {
    if (ended) return;
    res.set_header("location", location);
    res.status = code;
    send("");
}

// ---------------------------------------------------------------------------
// HTTP request parser
// Returns bytes consumed; 0 = need more data; -1 = malformed.
// ---------------------------------------------------------------------------
static long parse_request(char* data, size_t len, Request& req) {
    if (len < 4) return 0;
    
    std::string_view sv(data, len);
    size_t header_end_pos = sv.find("\r\n\r\n");
    if (header_end_pos == std::string_view::npos) return 0; // incomplete header
    
    const char* he = data + header_end_pos;
    const char* end = he;
    // request line: METHOD SP TARGET SP VERSION
    const char* p = data;
    const char* sp1 = (const char*)memchr(p, ' ', (size_t)(end - p));
    if (!sp1) return -1;
    req.method = std::string_view(p, sp1 - p);
    p = sp1 + 1;
    const char* sp2 = (const char*)memchr(p, ' ', (size_t)(end - p));
    if (!sp2) return -1;
    const char* ts = p;
    const char* qmark = (const char*)memchr(ts, '?', (size_t)(sp2 - ts));
    if (!qmark) {
        const char* qenc = nullptr;
        for (const char* k = ts; k + 2 < sp2; ++k) {
            if (*k == '%' && k[1] == '3' && (k[2] == 'F' || k[2] == 'f')) {
                qenc = k;
                break;
            }
        }
        if (qenc) {
            req.path = std::string_view(ts, qenc - ts);
            req.query_string = std::string_view(qenc + 3, sp2 - (qenc + 3));
        } else {
            req.path = std::string_view(ts, sp2 - ts);
            req.query_string = std::string_view();
        }
    } else {
        req.path = std::string_view(ts, qmark - ts);
        req.query_string = std::string_view(qmark + 1, (sp2 - qmark) - 1);
    }
    p = sp2 + 1;
    const char* le = (const char*)memchr(p, '\r', (size_t)(end - p));
    if (!le) return -1;
    req.http_version = std::string_view(p, le - p);

    // headers
    char* h = const_cast<char*>(le + 2);
    while (h < end) {
        // The last header line's '\r' sits exactly at `end`, so the search range
        // must include `end` itself.
        const char* line_end = (const char*)memchr(h, '\r', (size_t)(end - h) + 1);
        if (!line_end || line_end[1] != '\n') return -1;
        const char* colon = (const char*)memchr(h, ':', (size_t)(line_end - h));
        if (colon) {
            size_t name_len = colon - h;
            for (size_t k = 0; k < name_len; ++k) h[k] = (char)std::tolower((unsigned char)h[k]);
            std::string_view name(h, name_len);
            while (!name.empty() && (name.back() == ' ' || name.back() == '\t')) name.remove_suffix(1);

            const char* vs = colon + 1;
            while (vs < line_end && (*vs == ' ' || *vs == '\t')) ++vs;
            std::string_view value(vs, line_end - vs);
            while (!value.empty() && (value.back() == ' ' || value.back() == '\t')) value.remove_suffix(1);
            
            req.headers.emplace_back(name, value);
        }
        h = const_cast<char*>(line_end + 2);
    }

    // body
    size_t content_length = 0;
    for (const auto& hd : req.headers) {
        if (hd.first == "content-length") {
            try {
                // std::stoul requires null terminated, but string_view isn't. So we copy it.
                content_length = (size_t)std::stoul(std::string(hd.second));
            } catch (...) {
                return -1;
            }
        } else if (hd.first == "transfer-encoding") {
            return -1; // chunked not supported
        }
    }
    size_t consumed = (size_t)(end - data) + 4;
    if (consumed + content_length > len) return 0; // need body
    req.body = std::string_view(data + consumed, content_length);
    return (long)(consumed + content_length);
}

// ---------------------------------------------------------------------------
// Router (prefix trie with :params)
// ---------------------------------------------------------------------------
struct App::TrieNode {
    std::unordered_map<std::string, TrieNode*> children;
    TrieNode* param_child = nullptr;
    std::string param_name;
    TrieNode* wildcard_child = nullptr;
    std::string wildcard_name;
    std::unordered_map<std::string, std::pair<Handler, std::vector<Middleware>>> methods;

    ~TrieNode() {
        for (auto& c : children) delete c.second;
        delete param_child;
        delete wildcard_child;
    }
};

void App::add_route(const std::string& method, const std::string& route,
                    Handler h, std::vector<Middleware> mws) {
    TrieNode* cur = root_;
    size_t i = 1;
    while (i <= route.size()) {
        size_t slash = route.find('/', i);
        size_t end = (slash == std::string::npos) ? route.size() : slash;
        std::string seg = route.substr(i, end - i);
        if (seg.empty()) {
            if (slash == std::string::npos) break;
            i = slash + 1;
            continue;
        }
        if (seg == "*" || seg[0] == '*') {
            if (!cur->wildcard_child) {
                cur->wildcard_child = new TrieNode();
                cur->wildcard_name = (seg.size() > 1 && seg[0] == '*') ? seg.substr(1) : "*";
            }
            cur = cur->wildcard_child;
        } else if (seg[0] == ':') {
            if (!cur->param_child) {
                cur->param_child = new TrieNode();
                cur->param_name = seg.substr(1);
            }
            cur = cur->param_child;
        } else {
            auto it = cur->children.find(seg);
            if (it == cur->children.end()) {
                TrieNode* n = new TrieNode();
                cur->children[seg] = n;
                cur = n;
            } else {
                cur = it->second;
            }
        }
        if (slash == std::string::npos) break;
        i = slash + 1;
    }
    cur->methods[method] = { std::move(h), std::move(mws) };
}

bool App::match_route(TrieNode* node, const std::string& method,
                      const std::vector<std::string>& segs, size_t idx,
                      Handler& out, std::vector<Middleware>& out_mws,
                      std::unordered_map<std::string, std::string>& params) {
    if (idx == segs.size()) {
        auto it = node->methods.find(method);
        if (it == node->methods.end()) it = node->methods.find("ALL");
        if (it == node->methods.end() && method == "HEAD") it = node->methods.find("GET");
        if (it != node->methods.end()) {
            out = it->second.first;
            out_mws = it->second.second;
            return true;
        }
        if (node->wildcard_child) {
            auto wit = node->wildcard_child->methods.find(method);
            if (wit == node->wildcard_child->methods.end()) wit = node->wildcard_child->methods.find("ALL");
            if (wit == node->wildcard_child->methods.end() && method == "HEAD") wit = node->wildcard_child->methods.find("GET");
            if (wit != node->wildcard_child->methods.end()) {
                out = wit->second.first;
                out_mws = wit->second.second;
                return true;
            }
        }
        return false;
    }
    const std::string& seg = segs[idx];

    // 1. Try static match
    auto it = node->children.find(seg);
    if (it != node->children.end() &&
        match_route(it->second, method, segs, idx + 1, out, out_mws, params)) {
        return true;
    }

    // 2. Try param match (:param)
    if (node->param_child) {
        params[node->param_name] = seg;
        if (match_route(node->param_child, method, segs, idx + 1, out, out_mws, params)) {
            return true;
        }
        params.erase(node->param_name);
    }

    // 3. Try wildcard match (*)
    if (node->wildcard_child) {
        if (match_route(node->wildcard_child, method, segs, idx + 1, out, out_mws, params)) {
            return true;
        }
        auto wit = node->wildcard_child->methods.find(method);
        if (wit == node->wildcard_child->methods.end()) wit = node->wildcard_child->methods.find("ALL");
        if (wit == node->wildcard_child->methods.end() && method == "HEAD") wit = node->wildcard_child->methods.find("GET");
        if (wit != node->wildcard_child->methods.end()) {
            out = wit->second.first;
            out_mws = wit->second.second;
            return true;
        }
    }

    return false;
}

void App::run_chain(const std::vector<Middleware>& mws, size_t idx, Context& ctx, const Handler& h) {
    if (idx < mws.size()) {
        Middleware mw = mws[idx];
        std::function<void()> next = [&mws, idx, &ctx, &h]() { run_chain(mws, idx + 1, ctx, h); };
        mw(ctx, next);
    } else {
        h(ctx);
    }
}

// ---------------------------------------------------------------------------
// Connection + Worker (event loop)
// ---------------------------------------------------------------------------
struct Conn {
    int fd = -1;
    App::Worker* worker = nullptr;

    std::string in;    // read buffer
    size_t consumed = 0;
    std::string out;   // pending write data
    size_t out_offset = 0; // write offset to eliminate O(N) erase(0, n) memory shifts
    std::mutex wmtx;   // guards out for cross-thread writes
    std::atomic<bool> closed{false};
    std::atomic<bool> streaming{false};
    std::atomic<bool> want_close{false};
    bool peer_half_closed = false;
    bool write_enabled = false;

    // Refcounted lifetime: refs 1 = owned by the worker; async handlers may
    // hold extra refs across the JS round-trip. The last release deletes.
    std::atomic<int> refs{1};
    // Ordered async responses: responses are appended to `out` in request
    // order, so HTTP/1.1 pipelining stays correct even when JS handlers
    // complete out of order.
    std::mutex rmtx;
    uint64_t next_req_seq = 1;
    uint64_t next_resp_seq = 1;
    std::unordered_map<uint64_t, std::string> pending_resp;

    void append(const char* data, size_t len) {
        std::lock_guard<std::mutex> lk(wmtx);
        if (closed) return;
        if (out_offset > 0 && out_offset == out.size()) {
            out.clear();
            out_offset = 0;
        }
        out.append(data, len);
    }
    void append(const std::string& s) { append(s.data(), s.size()); }
};

// ---- platform event-loop abstraction ------------------------------------
struct ev_event {
    int fd;
    bool read;
    bool write;
    bool err;
};

#ifdef _WIN32
struct WinLoop {
    std::mutex mtx;
    fd_set read_fds;
    fd_set write_fds;
    int max_fd = 0;
    
    WinLoop() {
        FD_ZERO(&read_fds);
        FD_ZERO(&write_fds);
    }
};
static WinLoop* get_loop(int loop) { return (WinLoop*)(intptr_t)loop; }
#endif

static int ev_create() {
#ifdef __APPLE__
    return kqueue();
#elif defined(_WIN32)
    return (int)(intptr_t)new WinLoop();
#else
    return epoll_create1(EPOLL_CLOEXEC);
#endif
}

static bool ev_mod(int loop, int fd, bool r, bool w) {
#ifdef __APPLE__
    struct kevent ch[2];
    int n = 0;
    EV_SET(&ch[n++], fd, EVFILT_READ, EV_ADD | (r ? EV_ENABLE : EV_DISABLE), 0, 0, nullptr);
    EV_SET(&ch[n++], fd, EVFILT_WRITE, EV_ADD | (w ? EV_ENABLE : EV_DISABLE), 0, 0, nullptr);
    return kevent(loop, ch, n, nullptr, 0, nullptr) >= 0;
#elif defined(_WIN32)
    WinLoop* wl = get_loop(loop);
    std::lock_guard<std::mutex> lk(wl->mtx);
    if (r) FD_SET((SOCKET)fd, &wl->read_fds); else FD_CLR((SOCKET)fd, &wl->read_fds);
    if (w) FD_SET((SOCKET)fd, &wl->write_fds); else FD_CLR((SOCKET)fd, &wl->write_fds);
    if (fd > wl->max_fd) wl->max_fd = fd;
    return true;
#else
    struct epoll_event e{};
    e.events = (r ? EPOLLIN : 0) | (w ? EPOLLOUT : 0);
    e.data.fd = fd;
    return epoll_ctl(loop, EPOLL_CTL_MOD, fd, &e) == 0;
#endif
}

static bool ev_add(int loop, int fd, bool r, bool w) {
#ifdef __APPLE__
    struct kevent ch[2];
    int n = 0;
    if (r) EV_SET(&ch[n++], fd, EVFILT_READ, EV_ADD | EV_ENABLE, 0, 0, nullptr);
    if (w) EV_SET(&ch[n++], fd, EVFILT_WRITE, EV_ADD | EV_ENABLE, 0, 0, nullptr);
    return n > 0 && kevent(loop, ch, n, nullptr, 0, nullptr) >= 0;
#elif defined(_WIN32)
    return ev_mod(loop, fd, r, w);
#else
    struct epoll_event e{};
    e.events = (r ? EPOLLIN : 0) | (w ? EPOLLOUT : 0);
    e.data.fd = fd;
    return epoll_ctl(loop, EPOLL_CTL_ADD, fd, &e) == 0;
#endif
}

static int ev_wait(int loop, ev_event* evs, int max) {
#ifdef __APPLE__
    struct kevent out[256];
    int n = kevent(loop, nullptr, 0, out, std::min(max, 256), nullptr);
    for (int i = 0; i < n; ++i) {
        evs[i].fd = (int)out[i].ident;
        evs[i].err = (out[i].flags & EV_ERROR) != 0;
        evs[i].read = (out[i].filter == EVFILT_READ);
        evs[i].write = (out[i].filter == EVFILT_WRITE);
    }
    return n;
#elif defined(_WIN32)
    WinLoop* wl = get_loop(loop);
    fd_set r, w;
    int max_fd;
    {
        std::lock_guard<std::mutex> lk(wl->mtx);
        r = wl->read_fds;
        w = wl->write_fds;
        max_fd = wl->max_fd;
    }
    int n = select(max_fd + 1, &r, &w, nullptr, nullptr);
    if (n <= 0) return n;
    
    int count = 0;
    for (int i = 0; i <= max_fd && count < max; ++i) {
        bool is_r = FD_ISSET((SOCKET)i, &r);
        bool is_w = FD_ISSET((SOCKET)i, &w);
        if (is_r || is_w) {
            evs[count].fd = i;
            evs[count].err = false;
            evs[count].read = is_r;
            evs[count].write = is_w;
            count++;
        }
    }
    return count;
#else
    struct epoll_event out[256];
    int n = epoll_wait(loop, out, std::min(max, 256), -1);
    for (int i = 0; i < n; ++i) {
        evs[i].fd = out[i].data.fd;
        evs[i].err = (out[i].events & (EPOLLERR | EPOLLHUP)) != 0;
        evs[i].read = (out[i].events & EPOLLIN) != 0;
        evs[i].write = (out[i].events & EPOLLOUT) != 0;
    }
    return n;
#endif
}

static int make_wake_pipe(int fds[2]) {
#ifdef _WIN32
    SOCKET listener = socket(AF_INET, SOCK_DGRAM, 0);
    if (listener == INVALID_SOCKET) return -1;
    struct sockaddr_in addr;
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0;
    if (bind(listener, (struct sockaddr*)&addr, sizeof(addr)) == SOCKET_ERROR) {
        closesocket(listener);
        return -1;
    }
    int len = sizeof(addr);
    getsockname(listener, (struct sockaddr*)&addr, &len);
    
    SOCKET sender = socket(AF_INET, SOCK_DGRAM, 0);
    if (sender == INVALID_SOCKET) {
        closesocket(listener);
        return -1;
    }
    if (connect(sender, (struct sockaddr*)&addr, len) == SOCKET_ERROR) {
        closesocket(listener);
        closesocket(sender);
        return -1;
    }
    fds[0] = (int)listener;
    fds[1] = (int)sender;
    return 0;
#else
    return ::pipe(fds);
#endif
}

static int sys_write(int fd, const void* buf, size_t count) {
#ifdef _WIN32
    return send((SOCKET)fd, (const char*)buf, (int)count, 0);
#else
    return ::write(fd, buf, count);
#endif
}

static int sys_read(int fd, void* buf, size_t count) {
#ifdef _WIN32
    return recv((SOCKET)fd, (char*)buf, (int)count, 0);
#else
    return ::read(fd, buf, count);
#endif
}

static int sys_read_file(int fd, void* buf, size_t count) {
#ifdef _WIN32
    return _read(fd, buf, (unsigned int)count);
#else
    return ::read(fd, buf, count);
#endif
}

static void sys_close(int fd) {
#ifdef _WIN32
    closesocket((SOCKET)fd);
#else
    ::close(fd);
#endif
}

static void sys_close_file(int fd) {
#ifdef _WIN32
    _close(fd);
#else
    ::close(fd);
#endif
}

struct App::Worker {
    App* app;
    int loop_fd = -1;
    int listen_fd = -1;
    int wake_pipe[2] = { -1, -1 };
    std::vector<Conn*> conns;

    explicit Worker(App* a, int lfd) : app(a), listen_fd(lfd) {}

    Conn* get_conn(int fd) const {
        if (fd < 0 || (size_t)fd >= conns.size()) return nullptr;
        return conns[(size_t)fd];
    }
    void set_conn(int fd, Conn* c) {
        if (fd < 0) return;
        if ((size_t)fd >= conns.size()) conns.resize((size_t)fd + 128, nullptr);
        conns[(size_t)fd] = c;
    }
    void remove_conn(int fd) {
        if (fd >= 0 && (size_t)fd < conns.size()) conns[(size_t)fd] = nullptr;
    }

    void request_write(int fd) { 
        ev_mod(loop_fd, fd, true, true); 
#ifdef _WIN32
        char notify = 'W';
        sys_write(wake_pipe[1], &notify, 1);
#endif
    }
    void request_write_off(int fd) { ev_mod(loop_fd, fd, true, false); }

    void run() {
        ignore_sigpipe();

        loop_fd = ev_create();
        if (loop_fd < 0) return;
        if (make_wake_pipe(wake_pipe) < 0) { sys_close(loop_fd); return; }
        set_nonblocking(wake_pipe[0]);

        {
            std::lock_guard<std::mutex> lk(app->wake_mutex_);
            app->wake_fds_.push_back(wake_pipe[1]);
        }

        ev_add(loop_fd, wake_pipe[0], true, false);
        ev_add(loop_fd, listen_fd, true, false);

        ev_event events[256];
        while (app->running_.load()) {
            int n = ev_wait(loop_fd, events, 256);
            if (n < 0) {
                if (errno == EINTR) continue;
                break;
            }
            for (int i = 0; i < n; ++i) {
                ev_event& e = events[i];
                if (e.fd == wake_pipe[0]) {
                    char junk[128];
                    while (sys_read(wake_pipe[0], junk, sizeof(junk)) > 0) {}
                    continue;
                }
                if (e.fd == listen_fd) {
                    accept_loop();
                    continue;
                }
                Conn* c = get_conn(e.fd);
                if (!c) continue;
                if (e.err) { close_conn(e.fd, c); continue; }
                if (e.read) {
                    on_readable(e.fd, c);
                    if (!get_conn(e.fd)) continue;
                }
                if (e.write) {
                    flush(c);
                    if (!get_conn(e.fd)) continue;
                    if ((c->want_close || c->peer_half_closed) && (c->out.empty() || c->out_offset == c->out.size())) {
                        close_conn(e.fd, c);
                    }
                }
            }
        }

        for (size_t i = 0; i < conns.size(); ++i) {
            Conn* c = conns[i];
            if (!c) continue;
            c->closed = true;
            sys_close((int)i);
            if (--c->refs == 0) delete c;
        }
        conns.clear();
        sys_close(listen_fd);
        sys_close(wake_pipe[0]);
        sys_close(loop_fd);
    }

    void accept_loop() {
        for (;;) {
            int cfd = ::accept(listen_fd, nullptr, nullptr);
            if (cfd < 0) {
                if (errno == EINTR) continue;
                break; // EAGAIN
            }
            set_nonblocking(cfd);
#ifdef SO_NOSIGPIPE
            int one = 1;
            setsockopt(cfd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#endif
            Conn* c = new Conn();
            c->fd = cfd;
            c->worker = this;
            ev_add(loop_fd, cfd, true, false);
            set_conn(cfd, c);
        }
    }

    void on_readable(int fd, Conn* c) {
        for (;;) {
            size_t old_len = c->in.size();
            c->in.resize(old_len + 16384);
            ssize_t n = sys_read(fd, &c->in[old_len], 16384);
            if (n > 0) {
                c->in.resize(old_len + (size_t)n);
                if (c->in.size() > app->payload_limit_) { // max request body
                    send_error(c, 413, "Payload Too Large");
                    c->in.clear();
                    c->consumed = 0;
                    c->want_close = true;
                    return;
                }
            } else {
                c->in.resize(old_len);
                if (n == 0) {
                    c->peer_half_closed = true;
                    break;
                }
                if (errno == EINTR) continue;
                if (errno == EAGAIN || errno == EWOULDBLOCK) break;
                close_conn(fd, c);
                return;
            }
            if (c->peer_half_closed) break;
        }
        if (!c->streaming) process_pending(c);
        flush(c);
        if (!get_conn(fd)) return;
        if ((c->want_close || c->peer_half_closed) && (c->out.empty() || c->out_offset == c->out.size())) {
            close_conn(fd, c);
        }
    }

    void process_pending(Conn* c) {
        static thread_local Request scratch;
        for (;;) {
            if (c->streaming) break;
            char* data = c->in.data() + c->consumed;
            size_t avail = c->in.size() - c->consumed;
            if (avail == 0) break;

            scratch.headers.clear();
            scratch.query_cache.clear();
            scratch.cookie_cache.clear();
            long n = parse_request(data, avail, scratch);
            if (n == 0) break; // incomplete
            if (n < 0) {
                send_error(c, 400, "Bad Request");
                c->consumed = c->in.size();
                c->want_close = true;
                break;
            }
            app->handle_request(c, scratch);
            c->consumed += (size_t)n;
            if (c->want_close) break;
        }
        if (c->consumed >= c->in.size()) {
            c->in.clear();
            c->consumed = 0;
        } else if (c->consumed > 65536) {
            c->in.erase(0, c->consumed);
            c->consumed = 0;
        }
    }

    void send_error(Conn* c, int status, const char* msg) {
        std::string res;
        res += "HTTP/1.1 ";
        res += std::to_string(status);
        res += " ";
        res += status_phrase(status);
        res += "\r\nContent-Length: ";
        res += std::to_string(std::strlen(msg));
        res += "\r\nConnection: close\r\nServer: velociradix\r\n\r\n";
        res += msg;
        c->append(res);
    }

    void flush(Conn* c) {
        std::unique_lock<std::mutex> lk(c->wmtx);
        if (c->closed) return;
        while (c->out_offset < c->out.size()) {
            ssize_t n = sys_write(c->fd, c->out.data() + c->out_offset, c->out.size() - c->out_offset);
            if (n > 0) {
                c->out_offset += (size_t)n;
                if (c->out_offset == c->out.size()) {
                    c->out.clear();
                    c->out_offset = 0;
                }
                continue;
            }
            if (n < 0 && errno == EINTR) continue;
            if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                lk.unlock();
                request_write(c->fd);
                return;
            }
            // fatal error
            lk.unlock();
            close_conn(c->fd, c);
            return;
        }
        if ((c->out.empty() || c->out_offset == c->out.size()) && c->write_enabled) {
            c->out.clear();
            c->out_offset = 0;
            c->write_enabled = false;
            lk.unlock();
            request_write_off(c->fd);
        }
    }

    void close_conn(int fd, Conn* c) {
        remove_conn(fd);
        c->closed = true;
        sys_close(fd);
        if (--c->refs == 0) delete c;
    }
};

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------
void Context::sse(const std::function<void(SseStream&)>& producer) {
    if (ended || !conn) return;
    ended = true;

    res.set_header("content-type", "text/event-stream");
    res.set_header("cache-control", "no-cache");
    res.set_header("connection", "keep-alive");

    {
        std::lock_guard<std::mutex> lk(conn->wmtx);
        conn->streaming = true;
        std::string& o = conn->out;
        o += "HTTP/1.1 200 OK\r\n";
        for (const auto& h : res.headers) {
            o += h.first;
            o += ": ";
            o += h.second;
            o += "\r\n";
        }
        o += "\r\n";
    }

    SseStream* stream = new SseStream(conn);
    std::thread([producer, stream]() {
        producer(*stream);
        stream->close();
        delete stream;
    }).detach();
}

void SseStream::send_event(const std::string& data, const std::string& event) {
    if (closed_ || !conn_) return;
    std::string frame;
    if (!event.empty()) {
        frame += "event: ";
        frame += event;
        frame += "\n";
    }
    frame += "data: ";
    frame += data;
    frame += "\n\n";
    conn_->append(frame);
    if (conn_->worker) conn_->worker->request_write(conn_->fd);
}

void SseStream::close() {
    if (closed_) return;
    closed_ = true;
    if (!conn_) return;
    {
        std::lock_guard<std::mutex> lk(conn_->wmtx);
        conn_->streaming = false;
        conn_->want_close = true;
    }
    if (conn_->worker) conn_->worker->request_write(conn_->fd);
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------
static const char* mime_for(const std::string& path) {
    size_t dot = path.find_last_of('.');
    if (dot == std::string::npos) return "application/octet-stream";
    std::string ext = path.substr(dot);
    if (ext == ".html") return "text/html";
    if (ext == ".css") return "text/css";
    if (ext == ".js") return "application/javascript";
    if (ext == ".mjs") return "application/javascript";
    if (ext == ".json") return "application/json";
    if (ext == ".png") return "image/png";
    if (ext == ".jpg" || ext == ".jpeg") return "image/jpeg";
    if (ext == ".gif") return "image/gif";
    if (ext == ".svg") return "image/svg+xml";
    if (ext == ".ico") return "image/x-icon";
    if (ext == ".txt") return "text/plain";
    if (ext == ".xml") return "application/xml";
    if (ext == ".pdf") return "application/pdf";
    if (ext == ".woff") return "font/woff";
    if (ext == ".woff2") return "font/woff2";
    return "application/octet-stream";
}

void Context::serve_file(const std::string& filepath) {
    if (ended) return;
#ifdef _WIN32
    int fd = ::_open(filepath.c_str(), _O_RDONLY | _O_BINARY);
#else
    int fd = ::open(filepath.c_str(), O_RDONLY);
#endif
    if (fd < 0) {
        res.status = 404;
        json(json::object({{"error", json::string("Not Found")}}));
        return;
    }
    struct stat st{};
#ifdef _WIN32
    if (fstat(fd, &st) < 0 || (st.st_mode & _S_IFDIR)) {
#else
    if (fstat(fd, &st) < 0 || S_ISDIR(st.st_mode)) {
#endif
        sys_close_file(fd);
        res.status = 404;
        json(json::object({{"error", json::string("Not Found")}}));
        return;
    }
    if (st.st_size > (off_t)(64 * 1024 * 1024)) {
        sys_close(fd);
        res.status = 413;
        json(json::object({{"error", json::string("File too large")}}));
        return;
    }
    std::string data((size_t)st.st_size, '\0');
    size_t got = 0;
    while (got < data.size()) {
        ssize_t r = sys_read_file(fd, data.data() + got, data.size() - got);
        if (r <= 0) break;
        got += (size_t)r;
    }
    sys_close_file(fd);
    res.set_header("content-type", mime_for(filepath));
    res.body = std::move(data);
    ended = true;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
App::App() { root_ = new TrieNode(); }

App::~App() {
    if (running_.load()) close();
    delete root_;
}

App& App::get(const std::string& p, Handler h, std::vector<Middleware> mws) {
    add_route("GET", p, std::move(h), std::move(mws));
    return *this;
}
App& App::post(const std::string& p, Handler h, std::vector<Middleware> mws) {
    add_route("POST", p, std::move(h), std::move(mws));
    return *this;
}
App& App::put(const std::string& p, Handler h, std::vector<Middleware> mws) {
    add_route("PUT", p, std::move(h), std::move(mws));
    return *this;
}
App& App::del(const std::string& p, Handler h, std::vector<Middleware> mws) {
    add_route("DELETE", p, std::move(h), std::move(mws));
    return *this;
}
App& App::patch(const std::string& p, Handler h, std::vector<Middleware> mws) {
    add_route("PATCH", p, std::move(h), std::move(mws));
    return *this;
}
App& App::head(const std::string& p, Handler h, std::vector<Middleware> mws) {
    add_route("HEAD", p, std::move(h), std::move(mws));
    return *this;
}
App& App::options(const std::string& p, Handler h, std::vector<Middleware> mws) {
    add_route("OPTIONS", p, std::move(h), std::move(mws));
    return *this;
}
App& App::use(Middleware mw) {
    global_mws_.push_back(std::move(mw));
    return *this;
}
App& App::enable_cors() { cors_ = true; return *this; }
App& App::set_workers(size_t n) { workers_n_ = n; return *this; }
App& App::set_payload_limit(size_t bytes) { payload_limit_ = bytes; return *this; }
App& App::set_static_dir(const std::string& dir) { static_dir_ = dir; return *this; }

App& App::group(const std::string& prefix, const std::function<void(RouteGroup&)>& cb) {
    RouteGroup g(this, prefix);
    cb(g);
    return *this;
}

RouteGroup::RouteGroup(App* app, std::string prefix) : app_(app), prefix_(std::move(prefix)) {}

static std::string join_prefix(const std::string& prefix, const std::string& p) {
    if (prefix.empty()) return p;
    if (!p.empty() && p[0] == '/') return prefix + p;
    if (prefix.back() == '/') return prefix + p;
    return prefix + "/" + p;
}

RouteGroup& RouteGroup::get(const std::string& p, Handler h, std::vector<Middleware> mws) {
    app_->add_route("GET", join_prefix(prefix_, p), std::move(h), std::move(mws));
    return *this;
}
RouteGroup& RouteGroup::post(const std::string& p, Handler h, std::vector<Middleware> mws) {
    app_->add_route("POST", join_prefix(prefix_, p), std::move(h), std::move(mws));
    return *this;
}
RouteGroup& RouteGroup::put(const std::string& p, Handler h, std::vector<Middleware> mws) {
    app_->add_route("PUT", join_prefix(prefix_, p), std::move(h), std::move(mws));
    return *this;
}
RouteGroup& RouteGroup::del(const std::string& p, Handler h, std::vector<Middleware> mws) {
    app_->add_route("DELETE", join_prefix(prefix_, p), std::move(h), std::move(mws));
    return *this;
}

void App::listen(int port, const std::string& host) {
    ignore_sigpipe();
    int listen_fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (listen_fd < 0) return;

    int opt = 1;
#ifdef _WIN32
    setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, (const char*)&opt, sizeof(opt));
#else
    setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
#endif
#ifdef SO_REUSEPORT
    setsockopt(listen_fd, SOL_SOCKET, SO_REUSEPORT, &opt, sizeof(opt));
#endif

    struct sockaddr_in addr;
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    inet_pton(AF_INET, host.c_str(), &addr.sin_addr);

    if (::bind(listen_fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        sys_close(listen_fd);
        throw std::runtime_error("velociradix: bind() failed");
    }
    if (::listen(listen_fd, 4096) < 0) {
        sys_close(listen_fd);
        throw std::runtime_error("velociradix: listen() failed");
    }
    set_nonblocking(listen_fd);

    running_.store(true);

    size_t nw = workers_n_;
    if (nw == 0) {
        unsigned int hw = std::thread::hardware_concurrency();
        nw = (hw > 0) ? hw : 1;
    }

    for (size_t i = 0; i < nw; ++i) {
        threads_.emplace_back([this, listen_fd, i]() {
#if defined(_WIN32)
            (void)i; // Suppress unused capture warning
#endif
#if defined(__linux__)
            cpu_set_t cpuset;
            CPU_ZERO(&cpuset);
            CPU_SET(i % std::thread::hardware_concurrency(), &cpuset);
            pthread_setaffinity_np(pthread_self(), sizeof(cpu_set_t), &cpuset);
#elif defined(__APPLE__)
            thread_affinity_policy_data_t policy = { (int)i };
            thread_policy_set(pthread_mach_thread_np(pthread_self()),
                              THREAD_AFFINITY_POLICY,
                              (thread_policy_t)&policy,
                              THREAD_AFFINITY_POLICY_COUNT);
#endif
            Worker w(this, listen_fd);
            w.run();
        });
    }

    for (auto& t : threads_) t.join();
    threads_.clear();

    {
        std::lock_guard<std::mutex> lk(wake_mutex_);
        for (int fd : wake_fds_) sys_close(fd);
        wake_fds_.clear();
    }
    running_.store(false);
}

void App::close() {
    running_.store(false);
    {
        std::lock_guard<std::mutex> lk(wake_mutex_);
        for (int fd : wake_fds_) {
            char b = 1;
            ssize_t n = sys_write(fd, &b, 1);
            (void)n;
        }
    }
}

App& App::fast_route(const std::string& method, const std::string& path, int status,
                     const std::vector<std::pair<std::string, std::string>>& headers,
                     const std::string& body) {
    std::string resp;
    resp.reserve(256 + body.size());
    resp += "HTTP/1.1 ";
    append_uint(resp, (size_t)status);
    resp += " ";
    resp += status_phrase(status);
    resp += "\r\n";
    bool has_ct = false;
    bool has_cl = false;
    for (const auto& h : headers) {
        resp += h.first;
        resp += ": ";
        resp += h.second;
        resp += "\r\n";
        std::string name_lower = h.first;
        for (auto& c : name_lower) c = (char)std::tolower((unsigned char)c);
        if (name_lower == "content-type") has_ct = true;
        if (name_lower == "content-length") has_cl = true;
    }
    if (!has_ct) resp += "content-type: application/json\r\n";
    if (!has_cl) {
        resp += "content-length: ";
        append_uint(resp, body.size());
        resp += "\r\n";
    }
    resp += "connection: keep-alive\r\n\r\n";
    resp += body;

    add_route(method, path, [resp](Context& ctx) {
        ctx.took_over = true;
        Conn* c = ctx.conn;
        std::string date_hdr = "date: " + cached_date() + "\r\n";
        std::string full_resp = resp;
        size_t pos = full_resp.find("\r\n");
        if (pos != std::string::npos) {
            full_resp.insert(pos + 2, date_hdr);
        }
        c->out.append(full_resp);
        c->worker->flush(c);
    });

    return *this;
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------
void App::handle_request(Conn* c, Request& req) {
    Response res;
    Context ctx(req, res, c);

    if (cors_) {
        res.set_header("access-control-allow-origin", "*");
        res.set_header("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
        res.set_header("access-control-allow-headers", "Content-Type,Authorization");
        res.set_header("access-control-max-age", "86400");
        if (req.method == "OPTIONS") {
            res.status = 204;
            res.body.clear();
            ctx.ended = true;
            finalize(c, req, res);
            return;
        }
    }

    static thread_local std::vector<std::string> segs;
    split_path(std::string(req.path), segs);
    Handler handler;
    std::vector<Middleware> route_mws;
    std::unordered_map<std::string, std::string> params;
    bool found = match_route(root_, std::string(req.method), segs, 0, handler, route_mws, params);

    if (found) {
        ctx.params = std::move(params);
        std::vector<Middleware> chain;
        chain.reserve(global_mws_.size() + route_mws.size());
        chain.insert(chain.end(), global_mws_.begin(), global_mws_.end());
        chain.insert(chain.end(), route_mws.begin(), route_mws.end());
        try {
            run_chain(chain, 0, ctx, handler);
        } catch (const std::exception& e) {
            if (!ctx.ended) {
                res.status = 500;
                const char* msg = e.what();
                ctx.json(json::object({{"error", json::string(msg ? msg : "Internal Server Error")}}));
            }
        }
        if (!ctx.ended) ctx.send("");
    } else if (!static_dir_.empty() && req.method == "GET") {
        try {
            ctx.serve_file(static_dir_ + std::string(req.path));
        } catch (...) {
            res.status = 500;
            ctx.json(json::object({{"error", json::string("Internal Server Error")}}));
        }
    } else {
        res.status = 404;
        ctx.json(json::object({{"error", json::string("Route not found")}}));
    }

    if (!ctx.took_over) finalize(c, req, res);
}

void App::finalize(Conn* c, const Request& req, Response& res) {
    if (c->streaming.load()) return; // SSE already wrote headers

    bool keep_alive = req.keep_alive();
    if (!keep_alive) c->want_close.store(true);

    std::lock_guard<std::mutex> lk(c->wmtx);
    std::string& o = c->out;
    o += "HTTP/1.1 ";
    append_uint(o, (size_t)res.status);
    o += " ";
    o += status_phrase(res.status);
    o += "\r\n";

    bool has_cl = false;
    for (const auto& h : res.headers) {
        o += h.first;
        o += ": ";
        o += h.second;
        o += "\r\n";
        std::string hname = h.first;
        to_lower(hname);
        if (hname == "content-length") has_cl = true;
    }
    if (!has_cl) {
        o += "Content-Length: ";
        append_uint(o, res.body.size());
        o += "\r\n";
    }
    refresh_tail();
    o += keep_alive ? g_tail.keep_alive : g_tail.close_conn;
    o += res.body;
}

// ---------------------------------------------------------------------------
// Cross-thread async handler APIs (used by the JS addon)
// ---------------------------------------------------------------------------
void App::hold_conn(Conn* c) { c->refs.fetch_add(1); }
void App::release_conn(Conn* c) { if (--c->refs == 0) delete c; }
uint64_t App::alloc_seq(Conn* c) { return c->next_req_seq++; }

void App::respond_async(Conn* c, uint64_t seq, int status,
                        std::vector<std::pair<std::string, std::string>> headers,
                        std::string body, bool keep_alive) {
    std::string raw;
    raw.reserve(256 + body.size() + headers.size() * 32);
    raw += "HTTP/1.1 ";
    append_uint(raw, (size_t)status);
    raw += " ";
    raw += status_phrase(status);
    raw += "\r\n";
    bool has_cl = false;
    for (const auto& h : headers) {
        raw += h.first;
        raw += ": ";
        raw += h.second;
        raw += "\r\n";
        if (h.first.size() == 14) {
            char b[15];
            for (size_t i = 0; i < 14; ++i) b[i] = (char)tolower((unsigned char)h.first[i]);
            b[14] = '\0';
            if (std::memcmp(b, "content-length", 14) == 0) has_cl = true;
        }
    }
    if (!has_cl) {
        raw += "Content-Length: ";
        append_uint(raw, body.size());
        raw += "\r\n";
    }
    refresh_tail();
    raw += keep_alive ? g_tail.keep_alive : g_tail.close_conn;
    raw += body;

    bool appended = false;
    {
        std::lock_guard<std::mutex> lk(c->rmtx);
        c->pending_resp.emplace(seq, std::move(raw));
        while (true) {
            auto it = c->pending_resp.find(c->next_resp_seq);
            if (it == c->pending_resp.end()) break;
            {
                std::lock_guard<std::mutex> lk2(c->wmtx);
                if (!c->closed) {
                    c->out += it->second;
                    if (!keep_alive) c->want_close.store(true);
                    appended = true;
                }
            }
            c->pending_resp.erase(it);
            c->next_resp_seq++;
        }
    }
    if (appended && c->worker) c->worker->request_write(c->fd);
    // Release the async handler's reference (one per hold_conn).
    release_conn(c);
}

void App::begin_sse(Conn* c) {
    std::lock_guard<std::mutex> lk(c->wmtx);
    if (c->streaming.load() || c->closed) return;
    c->streaming = true;
    std::string& o = c->out;
    o += "HTTP/1.1 200 OK\r\n";
    o += "content-type: text/event-stream\r\n";
    o += "cache-control: no-cache\r\n";
    o += "connection: keep-alive\r\n";
    o += "Date: ";
    o += cached_date();
    o += "\r\nServer: velociradix\r\n\r\n";
    if (c->worker) c->worker->request_write(c->fd);
}

void App::sse_send(Conn* c, const std::string& data, const std::string& event) {
    std::string frame;
    if (!event.empty()) {
        frame += "event: ";
        frame += event;
        frame += "\n";
    }
    frame += "data: ";
    frame += data;
    frame += "\n\n";
    {
        std::lock_guard<std::mutex> lk(c->wmtx);
        if (c->closed || !c->streaming.load()) return;
        c->out += frame;
    }
    if (c->worker) c->worker->request_write(c->fd);
}

void App::sse_end(Conn* c) {
    {
        std::lock_guard<std::mutex> lk(c->wmtx);
        c->streaming = false;
        c->want_close = true;
    }
    if (c->worker) c->worker->request_write(c->fd);
}

} // namespace velociradix
