// velociradix N-API addon: exposes the pure-C++ HTTP engine to JavaScript.
// The C++ engine owns sockets, parsing, the event loop and the trie router;
// JS supplies route handlers. Handlers are invoked on the Node main thread
// via a napi_threadsafe_function. The bridge is NON-blocking: the worker
// dispatches the request to JS and returns immediately (Context::took_over);
// the JS main thread later delivers the response through App::respond_async,
// which appends it in per-connection request order.
//
// Build (macOS): clang++ -shared -undefined dynamic_lookup -fPIC \
//   -I deps/node-*/include/node src/addon.cpp bin/libvelociradix.a
#include <node_api.h>

#include "velociradix.hpp"

#include <algorithm>
#include <atomic>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <io.h>
#ifndef R_OK
#define R_OK 4
#endif
#define access _access
#else
#include <unistd.h>
#endif

#define NAPI_CALL(env, call) \
    do { if ((call) != napi_ok) { napi_throw_error((env), nullptr, #call); return nullptr; } } while (0)

// ---------------------------------------------------------------------------
// Per-request state shared between a C++ worker thread and the JS main thread
// ---------------------------------------------------------------------------
struct AddonApp;

struct PendingCall {
    AddonApp* app = nullptr;
    velociradix::Conn* conn = nullptr; // opaque; ref held by cpp_handler
    uint64_t seq = 0;                  // per-connection request order
    bool keep_alive = true;

    int route_id = 0;
    std::string method, path, query, body;
    std::vector<std::pair<std::string, std::string>> headers;
    std::vector<std::pair<std::string, std::string>> params;

    // Set exactly once, by js_respond (normal) or js_sse_begin (SSE).
    std::atomic<bool> responded{false};
    std::atomic<bool> sse_closed{false}; // guards SSE close (double-close safe)
    napi_ref sse_cb_ref = nullptr;
};

static thread_local std::vector<PendingCall*> g_pc_pool;

static PendingCall* acquire_pending_call() {
    if (!g_pc_pool.empty()) {
        PendingCall* pc = g_pc_pool.back();
        g_pc_pool.pop_back();
        pc->responded.store(false);
        pc->sse_closed.store(false);
        pc->sse_cb_ref = nullptr;
        pc->method.clear();
        pc->path.clear();
        pc->query.clear();
        pc->body.clear();
        pc->headers.clear();
        pc->params.clear();
        return pc;
    }
    return new PendingCall();
}

static void release_pending_call(PendingCall* pc) {
    if (!pc) return;
    if (pc->sse_cb_ref) {
        delete pc;
        return;
    }
    if (g_pc_pool.size() < 2048) {
        g_pc_pool.push_back(pc);
    } else {
        delete pc;
    }
}

struct AddonApp {
    velociradix::App* app = nullptr;
    napi_env env = nullptr;
    napi_threadsafe_function tsfn = nullptr;
    napi_ref dispatch_ref = nullptr;
    std::vector<std::pair<std::string, std::string>> static_routes; // (prefix, base dir)
    std::thread listener;
    std::atomic<bool> listening{false};
    std::atomic<bool> destroyed{false};
    int next_route_id = 1;
    std::mutex pc_mtx;
    std::vector<PendingCall*> sse_pcs; // freed on destroy; avoids UAF after close()
};

static std::mutex g_mtx;
static std::vector<AddonApp*> g_apps;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
static std::string js_to_string(napi_env env, napi_value v) {
    char buf[512];
    size_t len = 0;
    if (napi_get_value_string_utf8(env, v, buf, sizeof(buf), &len) == napi_ok) {
        if (len < sizeof(buf) - 1) {
            return std::string(buf, len);
        }
    }
    size_t needed = 0;
    napi_get_value_string_utf8(env, v, nullptr, 0, &needed);
    std::string s(needed, '\0');
    if (needed > 0) napi_get_value_string_utf8(env, v, &s[0], needed + 1, &needed);
    return s;
}

static inline void mk_string(napi_env env, std::string_view s, napi_value* out) {
    napi_create_string_utf8(env, s.data(), s.size(), out);
}

static napi_status make_string_map(napi_env env,
                            const std::vector<std::pair<std::string, std::string>>& kv,
                            napi_value* out) {
    napi_status st = napi_create_object(env, out);
    if (st != napi_ok) return st;
    if (kv.empty()) return napi_ok;
    for (const auto& p : kv) {
        napi_value k, v;
        mk_string(env, p.first, &k);
        mk_string(env, p.second, &v);
        st = napi_set_property(env, *out, k, v);
        if (st != napi_ok) return st;
    }
    return napi_ok;
}

static napi_status make_params_map(napi_env env,
                            const std::vector<std::pair<std::string, std::string>>& params,
                            napi_value* out) {
    napi_status st = napi_create_object(env, out);
    if (st != napi_ok) return st;
    if (params.empty()) return napi_ok;
    for (const auto& p : params) {
        napi_value k, v;
        mk_string(env, p.first, &k);
        mk_string(env, p.second, &v);
        st = napi_set_property(env, *out, k, v);
        if (st != napi_ok) return st;
    }
    return napi_ok;
}

static void read_map(napi_env env, napi_value obj,
                     std::vector<std::pair<std::string, std::string>>& out) {
    napi_value names = nullptr;
    uint32_t count = 0;
    if (napi_get_property_names(env, obj, &names) != napi_ok) return;
    if (napi_get_array_length(env, names, &count) != napi_ok) return;
    for (uint32_t i = 0; i < count; ++i) {
        napi_value k, v;
        if (napi_get_element(env, names, i, &k) != napi_ok) continue;
        if (napi_get_property(env, obj, k, &v) != napi_ok) continue;
        std::string ks = js_to_string(env, k);
        napi_valuetype t;
        napi_typeof(env, v, &t);
        std::string vs;
        if (t == napi_string) {
            vs = js_to_string(env, v);
        } else if (t == napi_boolean) {
            bool b = false;
            napi_get_value_bool(env, v, &b);
            vs = b ? "true" : "false";
        } else if (t == napi_number) {
            double d = 0;
            napi_get_value_double(env, v, &d);
            char buf[40];
            snprintf(buf, sizeof(buf), "%g", d);
            vs = buf;
        }
        out.emplace_back(std::move(ks), std::move(vs));
    }
}

static PendingCall* pending_from(napi_env env, napi_value v) {
    double addr = 0;
    if (napi_get_value_double(env, v, &addr) != napi_ok) return nullptr;
    return (PendingCall*)(uintptr_t)addr;
}

static AddonApp* get_app(napi_env env, napi_value v) {
    void* p = nullptr;
    if (napi_get_value_external(env, v, &p) != napi_ok) return nullptr;
    return (AddonApp*)p;
}

static napi_value make_fn(napi_env env, napi_callback cb, const char* name) {
    napi_value f;
    napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, nullptr, &f);
    return f;
}

static napi_value sse_send_fn(napi_env env, napi_callback_info info);
static napi_value sse_close_fn(napi_env env, napi_callback_info info);

// Calls global JSON.stringify(value) and stores the result in *out.
static bool json_stringify(napi_env env, napi_value value, napi_value* out) {
    napi_value global, JSON, stringify;
    if (napi_get_global(env, &global) != napi_ok) return false;
    if (napi_get_named_property(env, global, "JSON", &JSON) != napi_ok) return false;
    if (napi_get_named_property(env, JSON, "stringify", &stringify) != napi_ok) return false;
    return napi_call_function(env, JSON, stringify, 1, &value, out) == napi_ok;
}

// ---------------------------------------------------------------------------
// The C++ route handler: bridge one request to the JS main thread and wait.
// ---------------------------------------------------------------------------
static void cpp_handler(velociradix::Context& ctx, AddonApp* a, int route_id) {
    if (!a->tsfn) {
        ctx.status(503).send("JS dispatcher not registered");
        return;
    }

    // Static files: served entirely in C++, never touch JS.
    if (ctx.req.method == "GET") {
        for (const auto& sp : a->static_routes) {
            const std::string& prefix = sp.first;
            const std::string& base = sp.second;
            size_t pl = prefix.size();
            if (ctx.req.path.rfind(prefix, 0) != 0) continue;
            if (ctx.req.path.size() != pl && ctx.req.path[pl] != '/') continue;
            std::string rest = std::string(ctx.req.path.substr(pl));
            while (!rest.empty() && rest[0] == '/') rest.erase(0, 1);
            if (rest.find("..") != std::string::npos) continue; // traversal guard
            std::string full = base + "/" + rest;
            if (::access(full.c_str(), R_OK) == 0) {
                ctx.serve_file(full);
                return;
            }
        }
    }

    PendingCall* pc = acquire_pending_call();
    pc->app = a;
    pc->conn = ctx.conn;
    pc->seq = a->app->alloc_seq(ctx.conn);
    pc->keep_alive = ctx.req.keep_alive();
    pc->route_id = route_id;
    pc->method = ctx.req.method;
    pc->path = ctx.req.path;
    pc->query = ctx.req.query_string;
    pc->body = ctx.req.body;
    pc->headers.reserve(ctx.req.headers.size());
    for (const auto& h : ctx.req.headers) {
        pc->headers.emplace_back(h.first, h.second);
    }
    pc->params.reserve(ctx.params.size());
    for (const auto& kv : ctx.params) {
        pc->params.emplace_back(kv.first, kv.second);
    }

    // Take over: hold a connection reference so the JS main thread can safely
    // deliver the response later, then dispatch and return WITHOUT waiting.
    a->app->hold_conn(ctx.conn);
    napi_status st = napi_call_threadsafe_function(a->tsfn, pc, napi_tsfn_blocking);
    if (st != napi_ok) {
        a->app->release_conn(ctx.conn);
        release_pending_call(pc);
        ctx.status(503).send("dispatcher busy");
        return;
    }
    ctx.took_over = true;
}

// ---------------------------------------------------------------------------
// napi_threadsafe_function call_js: runs on the Node main thread.
// Dispatches to the JS `dispatch` function, or invokes an SSE producer cb.
// ---------------------------------------------------------------------------
static void dispatch_js(napi_env env, napi_value /*js_cb*/, void* context, void* data) {
    auto* a = (AddonApp*)context;
    auto* pc = (PendingCall*)data;

    if (!a->dispatch_ref) return;
    napi_value dispatch;
    if (napi_get_reference_value(env, a->dispatch_ref, &dispatch) != napi_ok) return;

    // Minimal hot path: pass only (routeId, ptr). All request fields (method,
    // path, query, body, headers, params) are fetched lazily by JS via the
    // native getters below, only when a handler actually reads them.
    napi_value args[2];
    napi_create_int32(env, pc->route_id, &args[0]);
    napi_create_double(env, (double)(uintptr_t)pc, &args[1]);

    napi_value ret, undef;
    napi_get_undefined(env, &undef);
    napi_status st = napi_call_function(env, undef, dispatch, 2, args, &ret);
    if (st != napi_ok) {
        bool pending = false;
        napi_is_exception_pending(env, &pending);
        if (pending) {
            napi_value exc;
            napi_get_and_clear_last_exception(env, &exc);
        }
    }
}

// ---------------------------------------------------------------------------
// Lazy request accessors (called from JS only while the PendingCall is alive:
// i.e. before js_respond frees it, which happens after the handler returns).
// ---------------------------------------------------------------------------
static napi_value js_get_field(napi_env env, napi_callback_info info, const std::string PendingCall::*member) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* pc = pending_from(env, argv[0]);
    if (!pc) {
        napi_value undef;
        napi_get_undefined(env, &undef);
        return undef;
    }
    napi_value s;
    mk_string(env, pc->*member, &s);
    return s;
}
static napi_value js_get_method(napi_env env, napi_callback_info info) { return js_get_field(env, info, &PendingCall::method); }
static napi_value js_get_path(napi_env env, napi_callback_info info) { return js_get_field(env, info, &PendingCall::path); }
static napi_value js_get_query(napi_env env, napi_callback_info info) { return js_get_field(env, info, &PendingCall::query); }
static napi_value js_get_body(napi_env env, napi_callback_info info) { return js_get_field(env, info, &PendingCall::body); }

static napi_value js_get_headers(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* pc = pending_from(env, argv[0]);
    if (!pc) {
        napi_value undef;
        napi_get_undefined(env, &undef);
        return undef;
    }
    napi_value obj;
    make_string_map(env, pc->headers, &obj);
    return obj;
}

static napi_value js_get_params(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* pc = pending_from(env, argv[0]);
    if (!pc) {
        napi_value undef;
        napi_get_undefined(env, &undef);
        return undef;
    }
    napi_value obj;
    make_params_map(env, pc->params, &obj);
    return obj;
}

static napi_value js_get_param(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* pc = pending_from(env, argv[0]);
    if (!pc || argc < 2) {
        napi_value undef;
        napi_get_undefined(env, &undef);
        return undef;
    }
    char buf[128];
    size_t len = 0;
    if (napi_get_value_string_utf8(env, argv[1], buf, sizeof(buf), &len) == napi_ok) {
        std::string_view name(buf, len);
        for (const auto& p : pc->params) {
            if (p.first == name) {
                napi_value s;
                mk_string(env, p.second, &s);
                return s;
            }
        }
    }
    napi_value undef;
    napi_get_undefined(env, &undef);
    return undef;
}

static napi_value js_get_header(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* pc = pending_from(env, argv[0]);
    if (!pc || argc < 2) {
        napi_value undef;
        napi_get_undefined(env, &undef);
        return undef;
    }
    std::string name = js_to_string(env, argv[1]);
    size_t len = name.size();
    if (len > 0) {
        for (const auto& h : pc->headers) {
            if (h.first.size() == len) {
                bool match = true;
                for (size_t i = 0; i < len; ++i) {
                    if (std::tolower((unsigned char)h.first[i]) != std::tolower((unsigned char)name[i])) {
                        match = false;
                        break;
                    }
                }
                if (match) {
                    napi_value s;
                    mk_string(env, h.second, &s);
                    return s;
                }
            }
        }
    }
    napi_value undef;
    napi_get_undefined(env, &undef);
    return undef;
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------
static napi_value sse_send_fn(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2] = { nullptr, nullptr };
    void* ctxdata = nullptr;
    napi_get_cb_info(env, info, &argc, argv, nullptr, &ctxdata);
    auto* pc = (PendingCall*)ctxdata;
    if (argc < 1 || !pc->app) return nullptr;

    napi_value data_str;
    if (!json_stringify(env, argv[0], &data_str)) return nullptr;
    std::string body = js_to_string(env, data_str);

    std::string event;
    if (argc >= 2 && argv[1]) {
        napi_valuetype t;
        napi_typeof(env, argv[1], &t);
        if (t == napi_string) event = js_to_string(env, argv[1]);
    }

    pc->app->app->sse_send(pc->conn, body, event);
    return nullptr;
}

static napi_value sse_close_fn(napi_env env, napi_callback_info info) {
    void* ctxdata = nullptr;
    napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &ctxdata);
    auto* pc = (PendingCall*)ctxdata;
    if (!pc->app) return nullptr;
    AddonApp* a = pc->app;
    if (pc->sse_closed.exchange(true)) return nullptr;
    a->app->sse_end(pc->conn);
    a->app->release_conn(pc->conn);
    // Defer freeing pc to destroy_app so lingering JS timers that still hold
    // sendEvent/close never touch freed memory.
    {
        std::lock_guard<std::mutex> lk(a->pc_mtx);
        a->sse_pcs.push_back(pc);
    }
    return nullptr;
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
static void stop_app(AddonApp* a) {
    if (a->listening.exchange(false)) {
        a->app->close();
    }
    if (a->listener.joinable()) a->listener.join();
}

static void destroy_app(AddonApp* a) {
    if (a->destroyed.exchange(true)) return;
    stop_app(a);
    if (a->tsfn) {
        napi_release_threadsafe_function(a->tsfn, napi_tsfn_release);
        a->tsfn = nullptr;
    }
    if (a->dispatch_ref) {
        napi_delete_reference(a->env, a->dispatch_ref);
        a->dispatch_ref = nullptr;
    }
    {
        std::lock_guard<std::mutex> lk(g_mtx);
        g_apps.erase(std::remove(g_apps.begin(), g_apps.end(), a), g_apps.end());
    }
    {
        std::lock_guard<std::mutex> lk(a->pc_mtx);
        for (auto* p : a->sse_pcs) delete p;
        a->sse_pcs.clear();
    }
    delete a->app;
    delete a;
}

static void finalize_app(napi_env env, void* data, void* /*hint*/) {
    (void)env;
    destroy_app((AddonApp*)data);
}

static void env_cleanup(void* /*arg*/) {
    std::vector<AddonApp*> copy;
    {
        std::lock_guard<std::mutex> lk(g_mtx);
        copy = g_apps;
    }
    for (auto* a : copy) {
        if (a->listening.load()) a->app->close();
        if (a->listener.joinable()) a->listener.join();
    }
}

// ---------------------------------------------------------------------------
// JS-exported functions
// ---------------------------------------------------------------------------
static napi_value js_create_app(napi_env env, napi_callback_info info) {
    (void)info;
    auto* a = new AddonApp();
    a->env = env;
    a->app = new velociradix::App();
    {
        std::lock_guard<std::mutex> lk(g_mtx);
        g_apps.push_back(a);
    }
    napi_value ext;
    napi_create_external(env, a, finalize_app, nullptr, &ext);
    return ext;
}

static napi_value js_add_route(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value argv[3];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* a = get_app(env, argv[0]);
    if (!a || argc < 3) return nullptr;
    std::string method = js_to_string(env, argv[1]);
    std::string path = js_to_string(env, argv[2]);

    int id = a->next_route_id++;
    velociradix::Handler h = [a, id](velociradix::Context& ctx) { cpp_handler(ctx, a, id); };
    a->app->add_route(method, path, h, {});

    napi_value r;
    napi_create_int32(env, id, &r);
    return r;
}

static napi_value js_register_fast_route(napi_env env, napi_callback_info info) {
    size_t argc = 6;
    napi_value argv[6];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* a = get_app(env, argv[0]);
    if (!a || argc < 6) return nullptr;

    std::string method = js_to_string(env, argv[1]);
    std::string path = js_to_string(env, argv[2]);
    int32_t status = 200;
    napi_get_value_int32(env, argv[3], &status);

    std::vector<std::pair<std::string, std::string>> headers;
    read_map(env, argv[4], headers);
    std::string body = js_to_string(env, argv[5]);

    a->app->fast_route(method, path, (int)status, headers, body);

    napi_value undef;
    napi_get_undefined(env, &undef);
    return undef;
}

static napi_value js_register_dispatch(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* a = get_app(env, argv[0]);
    if (!a || argc < 2) return nullptr;

    if (a->dispatch_ref) napi_delete_reference(env, a->dispatch_ref);
    napi_create_reference(env, argv[1], 1, &a->dispatch_ref);

    if (a->tsfn) napi_release_threadsafe_function(a->tsfn, napi_tsfn_release);
    napi_value resource_name;
    napi_create_string_utf8(env, "velociradix-dispatch", NAPI_AUTO_LENGTH, &resource_name);
    napi_create_threadsafe_function(env, argv[1], nullptr, resource_name,
                                    0, 4096, nullptr, nullptr, a, dispatch_js, &a->tsfn);
    napi_value undef;
    napi_get_undefined(env, &undef);
    return undef;
}

static napi_value js_enable_cors(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* a = get_app(env, argv[0]);
    if (a) a->app->enable_cors();
    napi_value undef;
    napi_get_undefined(env, &undef);
    return undef;
}

static napi_value js_set_static(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value argv[3];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* a = get_app(env, argv[0]);
    if (a && argc >= 3) {
        std::string prefix = js_to_string(env, argv[1]);
        std::string base = js_to_string(env, argv[2]);
        a->static_routes.emplace_back(prefix, base);
    }
    napi_value undef;
    napi_get_undefined(env, &undef);
    return undef;
}

static napi_value js_set_workers(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* a = get_app(env, argv[0]);
    if (a && argc >= 2) {
        int32_t n = 0;
        napi_get_value_int32(env, argv[1], &n);
        if (n > 0) a->app->set_workers((size_t)n);
    }
    napi_value undef;
    napi_get_undefined(env, &undef);
    return undef;
}

static napi_value js_set_payload_limit(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* a = get_app(env, argv[0]);
    if (a && argc >= 2) {
        double d = 0;
        napi_get_value_double(env, argv[1], &d);
        a->app->set_payload_limit((size_t)d);
    }
    napi_value undef;
    napi_get_undefined(env, &undef);
    return undef;
}

static napi_value js_listen(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value argv[3];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* a = get_app(env, argv[0]);
    if (!a || argc < 2) return nullptr;
    int port = 0;
    napi_get_value_int32(env, argv[1], &port);
    std::string host = "0.0.0.0";
    if (argc >= 3 && argv[2]) {
        napi_valuetype t;
        napi_typeof(env, argv[2], &t);
        if (t == napi_string) host = js_to_string(env, argv[2]);
    }
    if (a->listening.exchange(true)) {
        napi_value undef;
        napi_get_undefined(env, &undef);
        return undef;
    }
    a->listener = std::thread([a, port, host]() {
        try {
            a->app->listen(port, host);
        } catch (const std::exception&) {
        }
    });
    napi_value undef;
    napi_get_undefined(env, &undef);
    return undef;
}

static napi_value js_close(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* a = get_app(env, argv[0]);
    if (a) stop_app(a);
    napi_value undef;
    napi_get_undefined(env, &undef);
    return undef;
}

static napi_value js_respond(napi_env env, napi_callback_info info) {
    size_t argc = 4;
    napi_value argv[4] = { nullptr, nullptr, nullptr, nullptr };
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* pc = pending_from(env, argv[0]);
    if (!pc) {
        napi_value undef;
        napi_get_undefined(env, &undef);
        return undef;
    }
    int status = 200;
    if (argc >= 2 && argv[1]) {
        napi_get_value_int32(env, argv[1], &status);
    }
    std::vector<std::pair<std::string, std::string>> headers;
    if (argc >= 3 && argv[2]) {
        napi_valuetype t;
        if (napi_typeof(env, argv[2], &t) == napi_ok && t == napi_object) {
            read_map(env, argv[2], headers);
        }
    }
    std::string body;
    if (argc >= 4 && argv[3]) {
        napi_valuetype t;
        if (napi_typeof(env, argv[3], &t) == napi_ok && t == napi_string) {
            body = js_to_string(env, argv[3]);
        } else if (t == napi_object) {
            void* data = nullptr;
            size_t len = 0;
            if (napi_get_buffer_info(env, argv[3], &data, &len) == napi_ok) {
                body.assign((const char*)data, len);
            } else {
                napi_typedarray_type ty;
                size_t tlen = 0;
                void* tdata = nullptr;
                if (napi_get_typedarray_info(env, argv[3], &ty, &tlen, &tdata, nullptr, nullptr) == napi_ok &&
                    ty == napi_uint8_array) {
                    body.assign((const char*)tdata, tlen);
                }
            }
        }
    }
    if (!pc->app || pc->responded.exchange(true)) {
        napi_value undef;
        napi_get_undefined(env, &undef);
        return undef;
    }
    // Non-blocking: hand the response to the engine, which appends it to the
    // connection in per-connection request order and releases the conn ref.
    // After this the worker never touches `pc` again, so it is freed here.
    pc->app->app->respond_async(pc->conn, pc->seq, status, std::move(headers),
                                std::move(body), pc->keep_alive);
    release_pending_call(pc);
    napi_value undef;
    napi_get_undefined(env, &undef);
    return undef;
}

static napi_value js_sse_begin(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* pc = pending_from(env, argv[0]);
    if (!pc || argc < 2 || !pc->app) {
        napi_value undef;
        napi_get_undefined(env, &undef);
        return undef;
    }
    if (pc->responded.exchange(true)) {
        napi_value undef;
        napi_get_undefined(env, &undef);
        return undef;
    }
    if (pc->sse_cb_ref) napi_delete_reference(env, pc->sse_cb_ref);
    napi_create_reference(env, argv[1], 1, &pc->sse_cb_ref);

    AddonApp* a = pc->app;
    a->app->begin_sse(pc->conn);

    // Runs on the Node main thread (called synchronously from dispatch_js),
    // so the producer callback can be invoked directly. sendEvent/close are
    // bound to `pc`, which lives until close() (freed at destroy).
    napi_value cb;
    if (napi_get_reference_value(env, pc->sse_cb_ref, &cb) != napi_ok) {
        napi_value undef;
        napi_get_undefined(env, &undef);
        return undef;
    }
    napi_value send_fn, close_fn;
    napi_create_function(env, "sendEvent", NAPI_AUTO_LENGTH, sse_send_fn, pc, &send_fn);
    napi_create_function(env, "close", NAPI_AUTO_LENGTH, sse_close_fn, pc, &close_fn);
    napi_value argv2[2] = { send_fn, close_fn };
    napi_value ret, undef;
    napi_get_undefined(env, &undef);
    napi_call_function(env, undef, cb, 2, argv2, &ret);
    return undef;
}

static napi_value Init(napi_env env, napi_value exports) {
    napi_add_env_cleanup_hook(env, env_cleanup, nullptr);
    const struct { const char* name; napi_callback cb; } fns[] = {
        { "createApp", js_create_app },
        { "addRoute", js_add_route },
        { "registerFastRoute", js_register_fast_route },
        { "registerDispatch", js_register_dispatch },
        { "enableCors", js_enable_cors },
        { "setStatic", js_set_static },
        { "setPayloadLimit", js_set_payload_limit },
        { "setWorkers", js_set_workers },
        { "listen", js_listen },
        { "close", js_close },
        { "respond", js_respond },
        { "sseBegin", js_sse_begin },
        { "getMethod", js_get_method },
        { "getPath", js_get_path },
        { "getQuery", js_get_query },
        { "getBody", js_get_body },
        { "getHeaders", js_get_headers },
        { "getParams", js_get_params },
        { "getParam", js_get_param },
        { "getHeader", js_get_header },
    };
    for (const auto& f : fns) {
        napi_value fn = make_fn(env, f.cb, f.name);
        napi_set_named_property(env, exports, f.name, fn);
    }
    return exports;
}

#define NODE_GYP_MODULE_NAME velociradix
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
