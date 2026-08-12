#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <initializer_list>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <vector>

namespace velociradix {

// ---------------------------------------------------------------------------
// Minimal JSON helpers (values are raw JSON fragments)
// ---------------------------------------------------------------------------
namespace json {
// Encodes a string as a JSON string literal (quoted + escaped).
std::string string(const std::string& s);
// Builds {"key":value, ...} from raw-value fragments.
std::string object(std::initializer_list<std::pair<std::string, std::string>> kv);
inline std::string number(long long n) { return std::to_string(n); }
} // namespace json

struct Request {
    std::string_view method;
    std::string_view path;         // without query string
    std::string_view query_string; // raw "a=1&b=2"
    std::string_view http_version; // "HTTP/1.1"
    std::string_view body;

    std::string_view header(std::string_view name) const; // lowercase name
    std::string query(std::string_view key) const;
    std::string cookie(std::string_view key) const;
    bool keep_alive() const;

    std::vector<std::pair<std::string_view, std::string_view>> headers; // lowercase names
    mutable std::unordered_map<std::string, std::string> query_cache;
    mutable std::unordered_map<std::string, std::string> cookie_cache;
};

struct Response {
    int status = 200;
    std::string body;

    void set_header(const std::string& name, const std::string& value);
    void set_cookie(const std::string& name, const std::string& value,
                    const std::string& attributes = "");
    const std::string* get_header(const std::string& name) const;

    std::vector<std::pair<std::string, std::string>> headers; // lowercase names
};

struct Conn; // opaque connection handle (defined internally)

// Server-Sent Events stream. Safe to use from any thread.
class SseStream {
public:
    void send_event(const std::string& data, const std::string& event = "");
    void close();

private:
    friend struct Context;
    explicit SseStream(Conn* c) : conn_(c) {}
    Conn* conn_;
    bool closed_ = false;
};

struct Context {
    Request& req;
    Response& res;
    std::unordered_map<std::string, std::string> params;
    bool ended = false;
    bool took_over = false; // handler owns the response (async/native); skip finalize
    Conn* conn;

    Context(Request& r, Response& rs, Conn* c) : req(r), res(rs), conn(c) {}

    Context& status(int code) { res.status = code; return *this; }
    void set_header(const std::string& name, const std::string& value) { res.set_header(name, value); }
    void set_cookie(const std::string& name, const std::string& value, const std::string& attributes = "") { res.set_cookie(name, value, attributes); }
    void send(const std::string& text);
    void json(const std::string& raw_json);
    void html(const std::string& body);
    void redirect(const std::string& location, int code = 302);
    void sse(const std::function<void(SseStream&)>& producer);
    void serve_file(const std::string& filepath);
    std::string query(std::string_view key) const { return req.query(key); }
    std::string cookie(std::string_view key) const { return req.cookie(key); }
};

using Handler = std::function<void(Context&)>;
using Middleware = std::function<void(Context&, const std::function<void()>& next)>;

class App;
class RouteGroup;

class RouteGroup {
public:
    RouteGroup& get(const std::string& path, Handler h, std::vector<Middleware> mws = {});
    RouteGroup& post(const std::string& path, Handler h, std::vector<Middleware> mws = {});
    RouteGroup& put(const std::string& path, Handler h, std::vector<Middleware> mws = {});
    RouteGroup& del(const std::string& path, Handler h, std::vector<Middleware> mws = {});

private:
    friend class App;
    RouteGroup(App* app, std::string prefix);
    App* app_;
    std::string prefix_;
};

class App {
public:
    App();
    ~App();
    App(const App&) = delete;
    App& operator=(const App&) = delete;

    App& get(const std::string& path, Handler h, std::vector<Middleware> mws = {});
    App& post(const std::string& path, Handler h, std::vector<Middleware> mws = {});
    App& put(const std::string& path, Handler h, std::vector<Middleware> mws = {});
    App& del(const std::string& path, Handler h, std::vector<Middleware> mws = {});
    App& patch(const std::string& path, Handler h, std::vector<Middleware> mws = {});
    App& head(const std::string& path, Handler h, std::vector<Middleware> mws = {});
    App& options(const std::string& path, Handler h, std::vector<Middleware> mws = {});
    App& fast_route(const std::string& method, const std::string& path, int status,
                     const std::vector<std::pair<std::string, std::string>>& headers,
                     const std::string& body);
    void add_route(const std::string& method, const std::string& path,
                   Handler h, std::vector<Middleware> mws = {});
    App& use(Middleware mw);                                  // global middleware
    App& enable_cors();                                       // adds CORS headers + OPTIONS preflight
    App& set_workers(size_t n);                               // event-loop threads (default: cores)
    App& set_static_dir(const std::string& dir);              // serve unmatched GETs from dir
    App& set_payload_limit(size_t bytes);                     // max request body size
    App& group(const std::string& prefix, const std::function<void(RouteGroup&)>& cb);

    // Blocks the calling thread until close() is called (e.g. from another thread).
    void listen(int port, const std::string& host = "0.0.0.0");
    void close();

    // Cross-thread APIs for native/async handlers. `Conn` is opaque.
    // The handler must call hold_conn() when it takes over a request and must
    // release exactly one reference per hold (respond_async releases one).
    void hold_conn(Conn* c);
    void release_conn(Conn* c);
    // Worker-thread only: assigns the next per-connection request sequence.
    uint64_t alloc_seq(Conn* c);
    void respond_async(Conn* c, uint64_t seq, int status,
                       std::vector<std::pair<std::string, std::string>> headers,
                       std::string body, bool keep_alive);
    void begin_sse(Conn* c);
    void sse_send(Conn* c, const std::string& data, const std::string& event);
    void sse_end(Conn* c);

private:
    friend class RouteGroup;
    struct Worker;
    struct TrieNode;
    friend struct Context;
    friend struct Worker;
    friend struct Conn;

    void handle_request(Conn* c, Request& req);
    void finalize(Conn* c, const Request& req, Response& res);
    static void run_chain(const std::vector<Middleware>& mws, size_t idx, Context& ctx, const Handler& h);
    static bool match_route(TrieNode* node, const std::string& method,
                            const std::vector<std::string>& segs, size_t idx,
                            Handler& out, std::vector<Middleware>& out_mws,
                            std::unordered_map<std::string, std::string>& params);

    TrieNode* root_ = nullptr;
    std::vector<Middleware> global_mws_;
    std::atomic<bool> running_{false};
    bool cors_ = false;
    size_t workers_n_ = 0;
    size_t payload_limit_ = 16 * 1024 * 1024;
    std::string static_dir_;

    std::mutex wake_mutex_;
    std::vector<int> wake_fds_;
    std::vector<std::thread> threads_;
};

} // namespace velociradix
