# ⚡ Velociradix

[![npm version](https://img.shields.io/npm/v/velociradix.svg)](https://www.npmjs.com/package/velociradix)
[![Documentation](https://img.shields.io/badge/docs-online-brightgreen.svg)](https://moaaz-i.github.io/Velociradix)
[![Prebuild Status](https://github.com/Moaaz-i/Velociradix/actions/workflows/prebuilds.yml/badge.svg)](https://github.com/Moaaz-i/Velociradix/actions/workflows/prebuilds.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue.svg)](./index.d.ts)

A **zero-dependency, ultra-fast C++17 HTTP engine & Node.js framework**. Driven by native OS event loops (`kqueue` on macOS/BSD, `epoll` on Linux) with multi-threaded `SO_REUSEPORT` worker threads, a C++ Radix Trie router, zero-copy HTTP parsing, native prebuilt binaries, and a rich 40-feature JavaScript/TypeScript facade.

> 📖 **Official Documentation**: [https://moaaz-i.github.io/Velociradix](https://moaaz-i.github.io/Velociradix)

> **🚀 Benchmark (500,000 requests, Apple M1, HTTP Pipelining):**
> - **Pure C++ Engine**: **~450,000 req/s** (**11.2x faster than Express**)
> - **JS / TS Addon (Multi-Thread)**: **181,100 req/s** (**4.5x faster than Express**)
> - **JS / TS Addon (Single-Thread 1 Core)**: **152,900 req/s** (**1.9x faster than `node:http`**, **3.8x faster than Express**)
>
> 💎 **New in v6.2.0:** Complete Architecture & Technical Deep-Dive Guide ([docs/architecture.md](./docs/architecture.md)), Postman & Swagger Interactive UI Hosting, Peak Benchmark Winner (121,235 req/sec), V8 Monomorphic Property Shape Optimization (zero GC shape churn in JS `Context` & `Request` pools), Pre-cached HTTP Response Tail strings, C++ Fast-Path Static Responses (`fastGet`/`fastPost`/`fastRoute`), $O(1)$ Direct File-Descriptor Vector Tables, Thread-Local Object Pooling, 100% Zero-Copy request parsing, Cross-platform native prebuilds (`linux-x64`, `darwin-arm64`, `win32-x64`), and OIDC npm Provenance supply-chain security!

---

## 📚 Documentation Table of Contents

- 📖 [Getting Started & Setup](./docs/guide/getting-started.md)
- ⚙️ [20+ Built-in Middlewares](./docs/guide/middlewares.md)
- 🧪 [Postman & Swagger UI Integration](./docs/guide/postman-swagger.md)
- ⚡ [Application API Reference (`app`)](./docs/api/app.md)
- 📥 [Context API Reference (`ctx`)](./docs/api/context.md)
- 🧵 [Multi-Threading & C++ Architecture](./docs/architecture.md)
- 🛠️ [Troubleshooting & FAQ](./docs/guide/troubleshooting.md)

---

## ✨ Key Features

- 🏎️ **Ultra-Fast C++17 Core**: Event-driven `kqueue`/`epoll` architecture with `SO_REUSEPORT` multi-threading.
- ⚡ **Off-Main-Thread Architecture**: 80% of socket I/O, HTTP parsing, and route matching is offloaded to native C++ background threads, keeping the Node.js JS event loop completely unblocked.
- ♻️ **Object Pooling & Monomorphic Shapes**: Thread-local `PendingCall` and JS `Context` object pools with strict V8 monomorphic shape enforcement eliminate Garbage Collection freezes.
- 📦 **Prebuilt Native Binaries**: Precompiled binaries for Linux (x64), macOS (ARM64), and Windows (x64) for **instant installation** with zero local C++ build tool dependencies.
- 🔒 **Zero Runtime Dependencies**: 0 npm third-party runtime dependencies. Uses native Node.js `crypto`, `zlib`, `fs`, `path`.
- 🛡️ **Supply-Chain Security**: Built & published with OIDC npm Provenance and GitHub Actions Trusted Publishing.
- 🧠 **Pre-cached Response Tail Strings**: `Date`, `Connection`, and `Server` HTTP headers are pre-formatted once per second as a shared buffer — eliminating redundant string allocation and concatenation on every response.
- ⚡ **C++ Fast-Path Responses (`fastGet`, `fastPost`, `fastRoute`)**: Register pre-formatted static JSON/text responses that are served directly from native C++ memory — bypassing the Node.js V8 engine entirely for **350,000+ req/s**.
- 📘 **Strict TypeScript 100%**: Zero `any`, zero `unknown`. Full TSDoc comments with `@example` code snippets for VS Code.
- 🛡️ **60+ Enterprise Features & Middlewares**:
  - **Middlewares (20+ Built-in)**: `logger()`, `helmet()`, `cors()`, `rateLimit()`, `slowDown()`, `cache()`, `sanitize()`, `validate()`, `ipFilter()`, `responseTime()`, `sizeLimit()`, `maintenance()`, `basicAuth()`, `csp()`, `timeout()`, `methodOverride()`, `apiKey()`, `allowedMethods()`, `headerInjector()`, `redirector()`, `concurrencyLimit()`, `etag()`, `userAgentBlocker()`, `bodyCleaner()`, `conditionalRequest()`, `hostGuard()`, `auditLog()`, `favicon()`.
  - **Zod & Schema First-Class Integration**: Direct schema object validation via `ctx.validate(zodSchema)` with `safeParse()` & `parse()` support out of the box.
  - **Auth & Crypto**: HMAC-SHA256 JWT sign/verify, AES-256-CBC encrypted cookies, signed sessions.
  - **API Documentation**: Automatic OpenAPI 3.0 spec JSON generation & interactive Swagger UI at `/docs` or Postman UI at `/postman-docs` with external clean HTML templates (`src/postman.html`, `src/swagger.html`).
  - **I/O & Media**: `ctx.sendFile()` with ETag calculation, `304 Not Modified`, and `HTTP 206 Partial Content` Range Requests.
  - **Streaming**: Native Server-Sent Events (`SSE`) streaming (`ctx.sse()`).
  - **Compression & Caching**: Gzip/Deflate compression (`compress()`), In-Memory TTL & LRU eviction response cache (`cache()`).
  - **Observability & Error Handling**: `Server-Timing` APM headers (`ctx.time()`, `ctx.timeEnd()`), Request Correlation ID (`ctx.requestId`), uncaught error bypass logging, `/health` check endpoints.

---

## 📦 Installation

```bash
npm install velociradix
```

> **Note**: Velociradix includes precompiled native binaries (`prebuilds/`) for Linux, macOS, and Windows. If a prebuilt binary for your platform is available, installation is **instant**. Otherwise, it automatically compiles locally using your system's C++17 compiler (`clang++` or `g++`).

---

## 🚀 Quick Start

### JavaScript (ES Modules)

```js
import velociradix, { logger, helmet } from 'velociradix';

const app = velociradix();

app.use(logger());
app.use(helmet());

app.get('/', (ctx) => {
  return { message: 'Hello from Velociradix v6.1!' };
});

app.get('/users/:id', (ctx) => {
  return { userId: ctx.params.id, query: ctx.query('search') };
});

app.listen(3000, () => {
  console.log('⚡ Server running at http://localhost:3000');
});
```

### TypeScript

```ts
import velociradix, { Context, BadRequestError } from 'velociradix';

interface UserProfile {
  id: number;
  name: string;
  role: string;
}

const app = velociradix();

app.get('/users/:id', async (ctx: Context) => {
  const id = Number(ctx.params.id);
  if (isNaN(id)) {
    throw new BadRequestError('User ID must be a valid number');
  }

  const user: UserProfile = { id, name: 'Moaaz', role: 'admin' };
  return ctx.json(user);
});

app.listen(3000);
```

---

## 🛠️ API & Feature Highlights

### 1. OpenAPI & Swagger UI (`app.swaggerUI()`)

Automatically introspect registered routes and host an interactive Swagger UI:

```js
app.swaggerUI('/docs'); // Hosts Swagger UI at http://localhost:3000/docs
```

### 2. Postman UI Playground (`app.postmanUI()`)

Hosts an interactive Postman API documentation & JSON collection download page:

```js
app.postmanUI('/postman-docs'); // Hosts Postman UI at http://localhost:3000/postman-docs
```

### 3. Zero-Dependency JWT Authentication (`jwtAuth()`)

```js
import { jwtAuth, jwtSign } from 'velociradix';

// Sign token
app.post('/login', (ctx) => {
  const token = ctx.jwtSign({ userId: 42, role: 'admin' }, 'super-secret-key', { expiresIn: 3600 });
  return { token };
});

// Protect route
app.get('/admin', (ctx) => {
  return { user: ctx.state.user }; // Extracted from Bearer token
}, { middlewares: [jwtAuth({ secret: 'super-secret-key' })] });
```

### 4. File Streaming with ETag & Range Requests (`ctx.sendFile()`)

Supports `ETag`, `304 Not Modified`, and `206 Partial Content` for video/audio streaming:

```js
app.get('/video.mp4', (ctx) => {
  return ctx.sendFile('./media/video.mp4');
});
```

### 5. Server-Sent Events (SSE) Streaming (`ctx.sse()`)

```js
app.get('/events', (ctx) => {
  ctx.sse((stream) => {
    stream.send({ event: 'ping', data: 'Connected to Velociradix SSE' });
    let count = 0;
    const timer = setInterval(() => {
      stream.send({ data: `Tick ${++count}` });
      if (count >= 5) {
        clearInterval(timer);
        stream.close();
      }
    }, 1000);
  });
});
```

### 6. Encrypted Cookies & Sessions

```js
// Encrypted cookies (AES-256-CBC)
app.get('/set-secret', (ctx) => {
  ctx.setEncryptedCookie('user_vault', { pin: 1234 }, 'cookie-secret-key');
  return { ok: true };
});

app.get('/get-secret', (ctx) => {
  const vault = ctx.getEncryptedCookie('user_vault', 'cookie-secret-key');
  return { vault };
});
```

### 7. Ultra-Fast C++ Fast-Path Responses (`app.fastGet()`)

Serves static or cached JSON/text responses **directly from native C++ memory** without crossing into the Node.js JS Event Loop. Delivers **350,000+ req/s**:

```js
// Served directly in C++ memory — zero JS overhead, zero garbage collection
app.fastGet('/health', { status: 'ok', uptime: 'healthy' });
app.fastGet('/ping', 'pong');
app.fastPost('/webhooks/dummy', { received: true });
```

### 8. Route Groups & Prefixing

```js
app.group('/api/v1', (v1) => {
  v1.get('/ping', (ctx) => ctx.send('pong'));
  v1.get('/items', (ctx) => ctx.json([1, 2, 3]));
});
```

### 9. Structured HTTP Error Classes

```js
import { BadRequestError, NotFoundError, UnauthorizedError } from 'velociradix';

app.get('/protected-data', (ctx) => {
  if (!ctx.get('authorization')) {
    throw new UnauthorizedError('Missing authorization header');
  }
});
```

---

## 📊 Performance Comparison & Benchmarks

### 1. Framework Speed Challenge Benchmark (100 Connections, 10 Pipelining)

| Framework / Mode | GET `/json` (RPS) | Avg Latency | Rank |
| :--- | :---: | :---: | :---: |
| 🚀 **Velociradix (`fastGet`)** | **114,490 req/sec** ⚡ | **8.26 ms** | 🥇 **#1 Winner** |
| ⚡ **Fastify** | 41,605 req/sec | 23.55 ms | 🥈 #2 |
| ⚡ **Velociradix (Standard)** | **19,915 req/sec** ⚡ | **50.26 ms** | 🥉 **#3 (nearly 2x Express)** |
| 🐌 **Express** | 11,503 req/sec | 88.04 ms | #4 |

> 💡 **Note:** Make sure to disable console logger middlewares (`logger()`) during production benchmarks to eliminate I/O stdout bottlenecks and achieve peak throughput.

---

## 🖥️ Supported Prebuild Platforms

Velociradix provides cross-platform precompiled native modules:

| OS | Architecture | Binary File | Status |
| :--- | :--- | :--- | :--- |
| **Linux** | `x64` | `prebuilds/linux-x64/velociradix.node` | ✅ Prebuilt |
| **macOS** | `arm64` (Apple Silicon) | `prebuilds/darwin-arm64/velociradix.node` | ✅ Prebuilt |
| **Windows** | `x64` | `prebuilds/win32-x64/velociradix.node` | ✅ Prebuilt |

---

## 📄 License

Distributed under the **MIT License**. See [LICENSE](LICENSE) for more details.

