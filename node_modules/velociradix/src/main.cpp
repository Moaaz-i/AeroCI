#include "velociradix.hpp"

#include <cstdlib>
#include <iostream>
#include <string>

using namespace velociradix;

int main(int argc, char* argv[]) {
    int port = 8080;
    std::string host = "127.0.0.1";
    int workers = 0; // 0 = all cores
    if (argc >= 2) port = std::atoi(argv[1]);
    if (argc >= 3) host = argv[2];
    if (argc >= 4) workers = std::atoi(argv[3]);

    App app;
    app.enable_cors();
    if (workers > 0) app.set_workers((size_t)workers);

    app.get("/", [](Context& ctx) {
        ctx.send("Hello from velociradix (pure C++ engine)");
    });

    app.get("/api/products/:id", [](Context& ctx) {
        ctx.json(json::object({
            {"ok", "true"},
            {"productId", json::string(ctx.params["id"])},
        }));
    });

    app.get("/api/search", [](Context& ctx) {
        ctx.json(json::object({
            {"query", json::string(ctx.query("q"))},
        }));
    });

    app.post("/api/create", [](Context& ctx) {
        ctx.status(201).json(json::object({{"ok", "true"}}));
    });

    app.use([](Context&, const std::function<void()>& next) {
        next();
    });

    app.group("/api/v1", [](RouteGroup& g) {
        g.get("/ping", [](Context& ctx) {
            ctx.json(json::object({{"pong", "true"}}));
        });
    });

    std::cout << "velociradix listening on http://" << host << ":" << port << std::endl;
    app.listen(port, host);
    return 0;
}
