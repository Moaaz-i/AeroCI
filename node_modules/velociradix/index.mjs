// velociradix — Zero-dependency, ultra-fast C++17 HTTP Engine JS Facade
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from 'node:module';
import { extname, resolve } from "node:path";

const require = createRequire(import.meta.url);

let native;
try {
  native = require('./bin/velociradix.node');
} catch {
  throw new Error(
    'velociradix native addon not found. Run `npm rebuild velociradix` ' +
      '(or reinstall without --ignore-scripts) so the C++ engine compiles.'
  );
}

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];

// --- HTTP Error Classes ---
class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.details = details;
  }
}
class BadRequestError extends HttpError { constructor(msg = 'Bad Request', details) { super(400, msg, details); } }
class UnauthorizedError extends HttpError { constructor(msg = 'Unauthorized', details) { super(401, msg, details); } }
class ForbiddenError extends HttpError { constructor(msg = 'Forbidden', details) { super(403, msg, details); } }
class NotFoundError extends HttpError { constructor(msg = 'Not Found', details) { super(404, msg, details); } }
class InternalServerError extends HttpError { constructor(msg = 'Internal Server Error', details) { super(500, msg, details); } }

// --- Crypto & JWT Helpers ---
function base64UrlEncode(str) {
  return Buffer.from(str).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(str) {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return Buffer.from(b64, 'base64').toString('utf8');
}

function jwtSign(payload, secret, opts = {}) {
  const header = { alg: opts.alg || 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    iat: payload.iat || now,
    ...(opts.expiresIn ? { exp: now + opts.expiresIn } : {}),
  };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const signature = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function jwtVerify(token, secret) {
  if (!token || typeof token !== 'string') throw new UnauthorizedError('Invalid token format');
  const parts = token.split('.');
  if (parts.length !== 3) throw new UnauthorizedError('Invalid token structure');
  const [headerB64, payloadB64, signatureB64] = parts;
  const expectedSig = createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (signatureB64 !== expectedSig) throw new UnauthorizedError('Invalid token signature');
  const payload = JSON.parse(base64UrlDecode(payloadB64));
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
    throw new UnauthorizedError('Token expired');
  }
  return payload;
}

function encryptValue(text, secretKey) {
  const key = createHmac('sha256', secretKey).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(String(text), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
}

function decryptValue(encryptedText, secretKey) {
  try {
    const key = createHmac('sha256', secretKey).digest();
    const parts = encryptedText.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(parts[1], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return undefined;
  }
}

// --- Request & Context Classes ---
class Request {
  constructor(ptr) {
    this._reset(ptr);
  }
  _reset(ptr) {
    this._ptr = ptr;
    this._method = undefined;
    this._path = undefined;
    this._query = undefined;
    this._body = undefined;
    this._headers = undefined;
    this._params = undefined;
  }
  get method() { return this._method ??= (native.getMethod(this._ptr) || 'GET'); }
  get url() { return this.path; }
  get path() { return this._path ??= (native.getPath(this._ptr) || '/'); }
  get query() { return this._query ??= native.getQuery(this._ptr); }
  get body() { return this._body ??= native.getBody(this._ptr); }
  get headers() { return this._headers ??= (native.getHeaders(this._ptr) || {}); }
  get params() { return this._params ??= (native.getParams(this._ptr) || {}); }
}

const MAX_POOL_SIZE = 8192;
const contextPool = [];

function acquireContext(ptr, appInstance) {
  if (contextPool.length > 0) {
    const ctx = contextPool.pop();
    ctx._reset(ptr, appInstance);
    return ctx;
  }
  return new Context(ptr, appInstance);
}

function releaseContext(ctx) {
  if (ctx._sse) return;
  if (contextPool.length < MAX_POOL_SIZE) {
    ctx._ptr = 0;
    ctx._app = null;
    ctx.statusCode = 200;
    ctx.done = false;
    ctx._headers = undefined;
    ctx._state = undefined;
    ctx._timers = undefined;
    ctx._session = undefined;
    if (ctx._req) ctx._req._reset(0);
    contextPool.push(ctx);
  }
}

class Context {
  constructor(ptr, appInstance) {
    this._req = new Request(ptr);
    this._reset(ptr, appInstance);
  }

  _reset(ptr, appInstance) {
    this._ptr = ptr;
    this._app = appInstance;
    this.statusCode = 200;
    this.done = false;
    this._headers = undefined;
    this._state = undefined;
    this._timers = undefined;
    this._session = undefined;
    this._sse = false;
    this._sanitizedQuery = false;
    this.query = Context.prototype.query;
    this._req._reset(ptr);
  }

  get req() { return this._req; }
  get res() { return this; }
  status(c) { this.statusCode = c; return this; }
  setHeader(k, v) { (this._headers ??= {})[k] = String(v); return this; }
  set(k, v) {
    if (typeof k === 'object' && k !== null) {
      for (const key in k) this.setHeader(key, k[key]);
    } else if (k) {
      this.setHeader(k, v);
    }
    return this;
  }
  setCookie(name, value, opts = {}) {
    let c = `${name}=${value}`;
    if (opts.httpOnly) c += '; HttpOnly';
    if (opts.secure) c += '; Secure';
    if (opts.maxAge !== undefined) c += `; Max-Age=${opts.maxAge}`;
    if (opts.path) c += `; Path=${opts.path}`;
    if (opts.domain) c += `; Domain=${opts.domain}`;
    if (opts.sameSite) c += `; SameSite=${opts.sameSite}`;
    const prev = this._headers?.['Set-Cookie'];
    (this._headers ??= {})['Set-Cookie'] = prev ? prev + ', ' + c : c;
    return this;
  }
  clearCookie(name, opts = {}) {
    return this.setCookie(name, '', { ...opts, maxAge: 0 });
  }
  setEncryptedCookie(name, value, secret, opts = {}) {
    const enc = encryptValue(JSON.stringify(value), secret);
    return this.setCookie(name, enc, opts);
  }
  getEncryptedCookie(name, secret) {
    const val = this.cookie(name);
    if (!val) return undefined;
    const dec = decryptValue(val, secret);
    try { return dec ? JSON.parse(dec) : undefined; } catch { return undefined; }
  }
  send(v) {
    if (this.done) return this;
    this.done = true;
    let body;
    if (typeof v === 'string') {
      body = v;
    } else if (v instanceof Uint8Array) {
      body = v;
      ensureContentType(this, 'application/octet-stream');
    } else {
      body = JSON.stringify(v ?? '');
    }
    if (typeof body === 'string') {
      ensureContentType(this, 'text/plain');
    }
    native.respond(this._ptr, this.statusCode, this._headers, body);
    return this;
  }
  json(v) { ensureContentType(this, 'application/json'); return this.send(JSON.stringify(v)); }
  html(v) { ensureContentType(this, 'text/html; charset=utf-8'); return this.send(String(v)); }
  redirect(url, code = 302) { this.setHeader('Location', url); return this.status(code).send(''); }
  attachment(filename) { return this.setHeader('Content-Disposition', `attachment; filename="${filename}"`); }
  noCache() {
    return this.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
  }
  cache(seconds) { return this.setHeader('Cache-Control', `public, max-age=${seconds}`); }
  get(name) {
    if (!name) return undefined;
    if (Object.prototype.hasOwnProperty.call(this._req, 'headers')) {
      const hdrs = this._req.headers;
      return hdrs[name.toLowerCase()] ?? hdrs[name];
    }
    return native.getHeader(this._ptr, name);
  }
  param(k) {
    if (!k) return undefined;
    if (Object.prototype.hasOwnProperty.call(this._req, 'params')) {
      return this._req.params[k];
    }
    return native.getParam(this._ptr, k);
  }
  query(k) { return queryParse(this.req.query)[k]; }
  cookie(k) { return cookieParse(this.req.headers.cookie)[k]; }
  get params() { return this.req.params; }
  get path() { return this.req.path; }
  get method() { return this.req.method; }
  get url() { return this.req.url; }
  get request() { return this.req; }
  get metrics() { return { uptime: process.uptime(), memory: process.memoryUsage() }; }
  get ips() {
    if (!this._app?._trustProxy) return [];
    const xff = this.get('x-forwarded-for');
    return xff ? xff.split(',').map((s) => s.trim()) : [];
  }
  get ip() {
    if (this._app?._trustProxy) {
      const ips = this.ips;
      if (ips.length > 0) return ips[0];
      const xreal = this.get('x-real-ip');
      if (xreal) return xreal;
    }
    return '127.0.0.1';
  }
  get secure() {
    return this._app?._trustProxy ? (this.get('x-forwarded-proto') || '').toLowerCase() === 'https' : false;
  }
  get xhr() {
    return (this.get('x-requested-with') || '').toLowerCase() === 'xmlhttprequest';
  }
  get requestId() {
    let rid = this.get('x-request-id');
    if (!rid) {
      rid = randomBytes(8).toString('hex');
      this.setHeader('X-Request-ID', rid);
    }
    return rid;
  }
  bearerToken() {
    const auth = this.get('authorization');
    return (auth && auth.startsWith('Bearer ')) ? auth.slice(7).trim() : undefined;
  }
  basicAuth() {
    const auth = this.get('authorization');
    if (!auth || !auth.startsWith('Basic ')) return undefined;
    try {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      return idx !== -1 ? { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) } : undefined;
    } catch {
      return undefined;
    }
  }
  jwtSign(payload, secret, opts) {
    return jwtSign(payload, secret, opts);
  }
  jwtVerify(secret) {
    const token = this.bearerToken();
    if (!token) throw new UnauthorizedError('Missing Bearer token');
    return jwtVerify(token, secret);
  }
  accepts(...types) {
    const accept = this.get('accept');
    if (!accept || accept.includes('*/*')) return types[0] ?? true;
    for (let i = 0; i < types.length; i++) {
      if (accept.includes(types[i])) return types[i];
    }
    return false;
  }
  is(type) {
    const ct = this.get('content-type') || '';
    return type.includes('/') ? ct.includes(type) : (ct.includes(`/${type}`) || ct.includes(type));
  }
  body() {
    if (!this.req.body) return Promise.resolve({});
    try { return Promise.resolve(JSON.parse(this.req.body)); } catch { return Promise.resolve({}); }
  }
  onChunk(cb) {
    return this.req.body && this.req.body.length ? Promise.resolve(cb(Buffer.from(this.req.body))) : Promise.resolve();
  }
  sendStream(stream, ct) {
    if (this.done) return Promise.resolve();
    const chunks = [];
    return new Promise((resolve, reject) => {
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', resolve);
      stream.on('error', reject);
    }).then(() => {
      if (ct) this.setHeader('Content-Type', ct);
      this.send(Buffer.concat(chunks));
    });
  }
  sendFile(filepath, opts = {}) {
    const fullPath = resolve(filepath);
    if (!existsSync(fullPath)) {
      return this.status(404).send('File Not Found');
    }
    const stat = statSync(fullPath);
    const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
    this.setHeader('ETag', etag);

    if (this.get('if-none-match') === etag) {
      return this.status(304).send('');
    }

    const range = this.get('range');
    if (range && range.startsWith('bytes=')) {
      const parts = range.slice(6).split('-');
      const start = parseInt(parts[0], 10) || 0;
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunksize = end - start + 1;
      const content = readFileSync(fullPath).subarray(start, end + 1);

      this.status(206).set({
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': opts.contentType || getMimeType(fullPath),
      });
      return this.send(content);
    }

    this.setHeader('Content-Type', opts.contentType || getMimeType(fullPath));
    this.setHeader('Content-Length', stat.size);
    const data = readFileSync(fullPath);
    return this.send(data);
  }
  compress() {
    if (this.done || !this._headers) return this;
    const enc = this.get('accept-encoding') || '';
    let bodyData;
    if (enc.includes('gzip')) {
      this.setHeader('Content-Encoding', 'gzip');
    } else if (enc.includes('deflate')) {
      this.setHeader('Content-Encoding', 'deflate');
    }
    return this;
  }
  renderHtml(template, data = {}) {
    let output = template;
    for (const key in data) {
      output = output.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), sanitizeString(String(data[key])));
    }
    return this.html(output);
  }
  sanitizeHtml(str) {
    return sanitizeString(str);
  }
  validate(schema) {
    if (!schema) return true;
    if (typeof schema.safeParse === 'function' || typeof schema.parse === 'function') {
      schema = { body: schema };
    }
    if (schema.params) {
      const err = schema.params(this.params);
      if (err) throw new BadRequestError(`Invalid params: ${err}`);
    }
    if (schema.query) {
      const err = schema.query(queryParse(this.req.query));
      if (err) throw new BadRequestError(`Invalid query: ${err}`);
    }
    if (schema.body) {
      let parsedBody = {};
      if (this.req.body) {
        try { parsedBody = JSON.parse(this.req.body); } catch { parsedBody = this.req.body; }
      }
      if (typeof schema.body.safeParse === 'function') {
        const result = schema.body.safeParse(parsedBody);
        if (!result.success) {
          const formatted = result.error?.issues ? result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ') : (result.error?.message || 'Validation failed');
          throw new BadRequestError(`Invalid body: ${formatted}`);
        }
      } else if (typeof schema.body.parse === 'function') {
        try {
          schema.body.parse(parsedBody);
        } catch (e) {
          throw new BadRequestError(`Invalid body: ${e.message}`);
        }
      } else if (typeof schema.body === 'function') {
        const err = schema.body(parsedBody);
        if (err) throw new BadRequestError(`Invalid body: ${err}`);
      }
    }
    if (schema.headers) {
      const err = schema.headers(this.req.headers);
      if (err) throw new BadRequestError(`Invalid headers: ${err}`);
    }
    return true;
  }
  time(label) {
    (this._timers ??= {})[label] = process.hrtime.bigint();
    return this;
  }
  timeEnd(label) {
    if (!this._timers?.[label]) return this;
    const dur = Number(process.hrtime.bigint() - this._timers[label]) / 1e6;
    const val = `${label};dur=${dur.toFixed(2)}`;
    const prev = this.get('server-timing');
    this.setHeader('Server-Timing', prev ? `${prev}, ${val}` : val);
    return this;
  }
  csrfToken() {
    let token = this.cookie('_csrf');
    if (!token) {
      token = randomBytes(16).toString('hex');
      this.setCookie('_csrf', token, { httpOnly: true, sameSite: 'Strict', path: '/' });
    }
    return token;
  }
  get state() { return this._state ??= {}; }
  get session() { return this._session ??= {}; }
  sse(cb) { this.done = true; return native.sseBegin(this._ptr, cb); }
}

function ensureContentType(ctx, type) {
  if (ctx._headers?.['Content-Type'] === undefined && ctx._headers?.['content-type'] === undefined) {
    (ctx._headers ??= {})['Content-Type'] = type;
  }
}

function sanitizeString(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function getMimeType(file) {
  const ext = extname(file).toLowerCase();
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
  };
  return map[ext] || 'application/octet-stream';
}

function queryParse(q) {
  const out = {};
  if (!q) return out;
  for (const pair of q.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    out[decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq))] = decodeURIComponent(eq === -1 ? '' : pair.slice(eq + 1));
  }
  return out;
}

function cookieParse(h) {
  const out = {};
  if (!h) return out;
  for (const part of h.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function runChain(mws, handler, ctx) {
  const n = mws.length;
  if (n === 0) return handler(ctx);
  let i = 0;
  const next = () => (i < n ? mws[i++](ctx, next) : handler(ctx));
  return next();
}

function respondRes(ctx, status, body) {
  native.respond(ctx._ptr, status, ctx._headers, body);
}

function respondValue(ctx, status, value) {
  if (typeof value === 'string') {
    ensureContentType(ctx, 'text/plain');
    respondRes(ctx, status, value);
    return;
  }
  if (value instanceof Uint8Array) {
    ensureContentType(ctx, 'application/octet-stream');
    respondRes(ctx, status, value);
    return;
  }
  ensureContentType(ctx, 'application/json');
  respondRes(ctx, status, JSON.stringify(value ?? ''));
}

// --- Built-in Middlewares ---
function loggerMiddleware(opts = {}) {
  const logFn = opts.logger ?? console.log;
  const includeRes = opts.includeRes ?? false;
  return async (ctx, next) => {
    const start = Date.now();
    try {
      await next();
    } catch (err) {
      const errStatus = (ctx.statusCode && ctx.statusCode !== 200)
        ? ctx.statusCode
        : (err instanceof HttpError ? err.status : ((err && err.status) || 500));
      ctx.statusCode = errStatus;
      throw err;
    } finally {
      const duration = Date.now() - start;
      if (includeRes) {
        logFn(`${ctx.req.method} ${ctx.req.path} -> ${ctx.statusCode} (${duration}ms) [res: status=${ctx.statusCode}, done=${ctx.done}]`);
      } else {
        logFn(`${ctx.req.method} ${ctx.req.path} -> ${ctx.statusCode} (${duration}ms)`);
      }
    }
  };
}

function corsMiddleware(opts = {}) {
  const origin = opts.origin ?? '*';
  const methods = opts.methods ?? 'GET,POST,PUT,DELETE,PATCH,OPTIONS';
  const headers = opts.headers ?? 'Content-Type,Authorization';
  const allowCredentials = opts.credentials ? 'true' : null;
  const maxAge = opts.maxAge ? String(opts.maxAge) : null;

  return (ctx, next) => {
    ctx.set({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': methods,
      'Access-Control-Allow-Headers': headers,
    });
    if (allowCredentials) ctx.setHeader('Access-Control-Allow-Credentials', allowCredentials);
    if (maxAge) ctx.setHeader('Access-Control-Max-Age', maxAge);

    return ctx.req.method === 'OPTIONS' ? ctx.status(204).send('') : next();
  };
}

function bearerAuthMiddleware(opts = {}) {
  const { token, verify } = opts;
  return (ctx, next) => {
    const t = ctx.bearerToken();
    if (!t) return ctx.status(401).json({ error: 'Missing Bearer token' });
    if (token && t !== token) return ctx.status(401).json({ error: 'Invalid Bearer token' });
    if (verify && !verify(t, ctx)) return ctx.status(401).json({ error: 'Unauthorized' });
    return next();
  };
}

function jwtAuthMiddleware(opts = {}) {
  const secret = opts.secret;
  return (ctx, next) => {
    try {
      ctx.state.user = ctx.jwtVerify(secret);
      return next();
    } catch (err) {
      return ctx.status(401).json({ error: err.message });
    }
  };
}

function compressMiddleware(opts = {}) {
  const threshold = opts.threshold ?? 1024;
  return async (ctx, next) => {
    await next();
    const enc = ctx.get('accept-encoding') || '';
    if (ctx.done || (!enc.includes('gzip') && !enc.includes('deflate'))) return;
    // Applied before send
  };
}

function csrfMiddleware(opts = {}) {
  return (ctx, next) => {
    const token = ctx.csrfToken();
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(ctx.req.method)) {
      const headerToken = ctx.get('x-csrf-token') || ctx.query('_csrf');
      if (!headerToken || headerToken !== token) {
        return ctx.status(403).json({ error: 'Invalid or missing CSRF token' });
      }
    }
    return next();
  };
}

function cacheMiddleware(opts = {}) {
  const ttlMs = opts.ttlMs ?? 10000;
  const maxSize = opts.maxSize ?? 1000;
  const store = new Map();

  const gcTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of store.entries()) {
      if (now >= record.exp) store.delete(key);
    }
  }, Math.max(ttlMs, 5000));
  if (gcTimer.unref) gcTimer.unref();

  return (ctx, next) => {
    if (ctx.req.method !== 'GET') return next();
    const key = ctx.req.url;
    const now = Date.now();
    const cached = store.get(key);
    if (cached && now < cached.exp) {
      ctx.set(cached.headers);
      return ctx.status(cached.status).send(cached.body);
    }
    if (cached) {
      store.delete(key);
    }
    const origSend = ctx.send.bind(ctx);
    ctx.send = (body) => {
      if (store.size >= maxSize) {
        const firstKey = store.keys().next().value;
        if (firstKey !== undefined) store.delete(firstKey);
      }
      store.set(key, {
        body,
        headers: ctx._headers || {},
        status: ctx.statusCode,
        exp: Date.now() + ttlMs,
      });
      return origSend(body);
    };
    return next();
  };
}

function requestIdMiddleware(opts = {}) {
  const headerName = opts.headerName || 'X-Request-ID';
  return (ctx, next) => {
    const rid = ctx.requestId;
    ctx.setHeader(headerName, rid);
    return next();
  };
}

function validateMiddleware(schema = {}) {
  return (ctx, next) => {
    ctx.validate(schema);
    return next();
  };
}

function sanitizeMiddleware() {
  return async (ctx, next) => {
    const rawParams = ctx.params;
    if (rawParams) {
      for (const k in rawParams) {
        if (typeof rawParams[k] === 'string') {
          rawParams[k] = sanitizeString(rawParams[k]);
        }
      }
    }
    if (!ctx._sanitizedQuery) {
      const origQuery = ctx.query;
      ctx.query = function(k) {
        const val = origQuery.call(this, k);
        return typeof val === 'string' ? sanitizeString(val) : val;
      };
      ctx._sanitizedQuery = true;
    }
    await next();
  };
}

function sessionMiddleware(opts = {}) {
  const secret = opts.secret || 'default-secret-key';
  const name = opts.name || '_session';
  return (ctx, next) => {
    const existing = ctx.getEncryptedCookie(name, secret);
    ctx._session = existing || {};
    const res = next();
    ctx.setEncryptedCookie(name, ctx._session, secret, opts.cookie);
    return res;
  };
}

function slowDownMiddleware(opts = {}) {
  const delayMs = opts.delayMs ?? 500;
  const delayAfter = opts.delayAfter ?? 5;
  const windowMs = opts.windowMs ?? opts.resetTimeMs ?? 60000;
  const hits = new Map();

  const gcTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of hits.entries()) {
      if (now > record.resetTime) hits.delete(key);
    }
  }, Math.max(windowMs, 5000));
  if (gcTimer.unref) gcTimer.unref();

  return async (ctx, next) => {
    const ip = ctx.ip;
    const now = Date.now();
    let record = hits.get(ip);
    if (!record || now > record.resetTime) {
      record = { count: 1, resetTime: now + windowMs };
      hits.set(ip, record);
    } else {
      record.count++;
    }
    if (record.count > delayAfter) {
      const extraDelay = (record.count - delayAfter) * delayMs;
      await new Promise((r) => setTimeout(r, extraDelay));
    }
    return next();
  };
}

function rateLimitMiddleware(opts = {}) {
  const windowMs = opts.windowMs ?? 60000;
  const max = opts.max ?? 100;
  const message = opts.message ?? 'Too Many Requests';
  const hits = new Map();

  const gcTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of hits.entries()) {
      if (now > record.resetTime) hits.delete(key);
    }
  }, Math.max(windowMs, 5000));
  if (gcTimer.unref) gcTimer.unref();

  return (ctx, next) => {
    const ip = ctx.ip;
    const now = Date.now();
    let record = hits.get(ip);
    if (!record || now > record.resetTime) {
      record = { count: 1, resetTime: now + windowMs };
      hits.set(ip, record);
    } else {
      record.count++;
    }
    ctx.set({
      'X-RateLimit-Limit': max,
      'X-RateLimit-Remaining': Math.max(0, max - record.count),
    });
    return record.count > max ? ctx.status(429).send(message) : next();
  };
}

function helmetMiddleware(opts = {}) {
  return (ctx, next) => {
    ctx.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': opts.frameOptions ?? 'SAMEORIGIN',
      'X-XSS-Protection': '1; mode=block',
      'Strict-Transport-Security': 'max-age=15552000; includeSubDomains',
      'Referrer-Policy': opts.referrerPolicy ?? 'no-referrer',
    });
    return next();
  };
}

// 1. IP Restriction / Whitelist / Blacklist Middleware
function ipFilterMiddleware(opts = {}) {
  const allow = opts.allow ? new Set(opts.allow) : null;
  const deny = opts.deny ? new Set(opts.deny) : null;
  const statusCode = opts.statusCode ?? 403;
  return (ctx, next) => {
    const clientIp = ctx.ip;
    if (deny && deny.has(clientIp)) return ctx.status(statusCode).send('Forbidden IP');
    if (allow && !allow.has(clientIp)) return ctx.status(statusCode).send('IP Not Allowed');
    return next();
  };
}

// 2. Response Time Header Middleware
function responseTimeMiddleware(opts = {}) {
  const headerName = opts.headerName ?? 'X-Response-Time';
  const digits = opts.digits ?? 2;
  return async (ctx, next) => {
    const start = process.hrtime.bigint();
    await next();
    const duration = Number(process.hrtime.bigint() - start) / 1e6;
    ctx.setHeader(headerName, `${duration.toFixed(digits)}ms`);
  };
}

// 3. Request Size Limiter Middleware
function sizeLimitMiddleware(opts = {}) {
  const maxSize = opts.maxSize ?? 1024 * 1024; // 1MB default
  return (ctx, next) => {
    const len = parseInt(ctx.get('content-length') || '0', 10);
    if (len > maxSize) return ctx.status(413).send('Payload Too Large');
    return next();
  };
}

// 4. Maintenance Mode Middleware
function maintenanceMiddleware(opts = {}) {
  const enabled = opts.enabled ?? true;
  const message = opts.message ?? 'Service Unavailable for Maintenance';
  const retryAfter = opts.retryAfter ?? 300;
  return (ctx, next) => {
    if (typeof enabled === 'function' ? enabled(ctx) : enabled) {
      ctx.setHeader('Retry-After', String(retryAfter));
      return ctx.status(530).send(message);
    }
    return next();
  };
}

// 5. Basic Authentication Middleware
function basicAuthMiddleware(opts = {}) {
  const users = opts.users ?? {};
  const realm = opts.realm ?? 'Secure Area';
  return (ctx, next) => {
    const creds = ctx.basicAuth();
    if (!creds || !users[creds.username] || users[creds.username] !== creds.password) {
      ctx.setHeader('WWW-Authenticate', `Basic realm="${realm}"`);
      return ctx.status(401).send('Unauthorized');
    }
    ctx.state.user = creds.username;
    return next();
  };
}

// 6. Security Headers (Permissions Policy & CSP) Middleware
function cspMiddleware(opts = {}) {
  const policy = opts.policy ?? "default-src 'self'";
  return (ctx, next) => {
    ctx.setHeader('Content-Security-Policy', policy);
    return next();
  };
}

// 7. Timeout Middleware
function timeoutMiddleware(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 5000;
  return (ctx, next) => {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (!ctx.done) {
          ctx.status(504).send('Gateway Timeout');
        }
        reject(new Error('Request Timeout'));
      }, timeoutMs);
    });
    return Promise.race([next(), timeoutPromise]).finally(() => clearTimeout(timer));
  };
}

// 8. CORS Preflight & Methods Guard Middleware
function methodOverrideMiddleware(opts = {}) {
  const headerName = opts.headerName ?? 'x-http-method-override';
  return (ctx, next) => {
    const override = ctx.get(headerName);
    if (override && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(override.toUpperCase())) {
      ctx.req._method = override.toUpperCase();
    }
    return next();
  };
}

// 9. API Key Authorization Middleware
function apiKeyMiddleware(opts = {}) {
  const keys = new Set(opts.keys ?? []);
  const headerName = opts.headerName ?? 'x-api-key';
  const queryName = opts.queryName ?? 'api_key';
  return (ctx, next) => {
    const key = ctx.get(headerName) || ctx.query(queryName);
    if (!key || !keys.has(key)) {
      return ctx.status(401).json({ error: 'Invalid or missing API key' });
    }
    return next();
  };
}

// 10. HTTP Method Whitelist Guard Middleware
function allowedMethodsMiddleware(opts = {}) {
  const allowed = new Set((opts.methods ?? ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']).map((m) => m.toUpperCase()));
  return (ctx, next) => {
    if (!allowed.has(ctx.req.method.toUpperCase())) {
      ctx.setHeader('Allow', Array.from(allowed).join(', '));
      return ctx.status(405).send('Method Not Allowed');
    }
    return next();
  };
}

// 11. Custom Header Injection Middleware
function headerInjectorMiddleware(headers = {}) {
  return (ctx, next) => {
    ctx.set(headers);
    return next();
  };
}

// 12. Single URL Redirector Middleware
function redirectorMiddleware(rules = {}) {
  return (ctx, next) => {
    const target = rules[ctx.req.path];
    if (target) return ctx.redirect(target.url || target, target.code || 301);
    return next();
  };
}

// 13. Dynamic Request Throttler Middleware
function concurrencyLimitMiddleware(opts = {}) {
  const maxConcurrent = opts.maxConcurrent ?? 50;
  let active = 0;
  return async (ctx, next) => {
    if (active >= maxConcurrent) {
      return ctx.status(503).send('Server Busy');
    }
    active++;
    try {
      await next();
    } finally {
      active--;
    }
  };
}

// 14. ETag Auto Generator Middleware
function etagMiddleware(opts = {}) {
  const weak = opts.weak ?? true;
  return async (ctx, next) => {
    await next();
    if (ctx.req.method === 'GET' && ctx._bodyData && !ctx.get('etag')) {
      const hash = createHmac('sha256', 'velociradix-etag').update(String(ctx._bodyData)).digest('hex').slice(0, 16);
      const tag = `${weak ? 'W/' : ''}"${hash}"`;
      ctx.setHeader('ETag', tag);
      if (ctx.get('if-none-match') === tag) {
        return ctx.status(304).send('');
      }
    }
  };
}

// 15. User Agent Blocker Middleware
function userAgentBlockerMiddleware(opts = {}) {
  const botPatterns = opts.bots ?? [/curl/i, /wget/i, /python-requests/i, /postman/i];
  return (ctx, next) => {
    const ua = ctx.get('user-agent') || '';
    if (botPatterns.some((pattern) => pattern.test(ua))) {
      return ctx.status(403).send('Automated User-Agent Blocked');
    }
    return next();
  };
}

// 16. JSON Pre-Parser & Normalizer Middleware
function bodyCleanerMiddleware(opts = {}) {
  const trimStrings = opts.trim ?? true;
  return async (ctx, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(ctx.req.method) && ctx.is('json')) {
      try {
        const bodyObj = await ctx.body();
        if (trimStrings && bodyObj && typeof bodyObj === 'object') {
          for (const key in bodyObj) {
            if (typeof bodyObj[key] === 'string') bodyObj[key] = bodyObj[key].trim();
          }
        }
        ctx.state.cleanedBody = bodyObj;
      } catch {}
    }
    return next();
  };
}

// 17. Conditional Request Guard (If-Match / If-Modified-Since) Middleware
function conditionalRequestMiddleware() {
  return (ctx, next) => {
    const ifModifiedSince = ctx.get('if-modified-since');
    if (ifModifiedSince && ctx.req.method === 'GET') {
      const modifiedTime = new Date(ifModifiedSince).getTime();
      if (!isNaN(modifiedTime) && Date.now() <= modifiedTime) {
        return ctx.status(304).send('');
      }
    }
    return next();
  };
}

// 18. Host Header Guard Middleware
function hostGuardMiddleware(opts = {}) {
  const allowedHosts = new Set(opts.hosts ?? []);
  return (ctx, next) => {
    const host = (ctx.get('host') || '').split(':')[0];
    if (allowedHosts.size > 0 && !allowedHosts.has(host)) {
      return ctx.status(400).send('Invalid Host Header');
    }
    return next();
  };
}

// 19. Request Audit / Event Emitting Middleware
function auditLogMiddleware(opts = {}) {
  const onAudit = opts.onAudit ?? ((event) => console.log('[AUDIT]', JSON.stringify(event)));
  return async (ctx, next) => {
    const startTime = Date.now();
    await next();
    onAudit({
      timestamp: new Date().toISOString(),
      method: ctx.req.method,
      path: ctx.req.path,
      status: ctx.statusCode,
      ip: ctx.ip,
      durationMs: Date.now() - startTime,
      user: ctx.state.user ?? null,
    });
  };
}

// 20. Favicon Fast Dismiss Middleware
function faviconMiddleware(opts = {}) {
  const icon = opts.icon ?? '';
  return (ctx, next) => {
    if (ctx.req.path === '/favicon.ico') {
      ctx.setHeader('Content-Type', 'image/x-icon');
      ctx.setHeader('Cache-Control', 'public, max-age=86400');
      return ctx.status(200).send(icon);
    }
    return next();
  };
}

function getPostmanDocHtml(collection) {
  const requestListItems = collection.item.map((item, idx) => `
        <div class="request-item" onclick="scrollToReq('req-${idx}')">
          <span class="badge badge-${item.request.method.toLowerCase()}">${item.request.method}</span>
          <span>${item.name}</span>
        </div>
      `).join('');

  const requestCards = collection.item.map((item, idx) => `
      <div class="request-card" id="req-${idx}">
        <div class="request-card-header">
          <span class="badge badge-${item.request.method.toLowerCase()}">${item.request.method}</span>
          <span class="request-card-title">${item.name}</span>
        </div>
        <div class="url-bar">
          <strong style="color: var(--method-${item.request.method.toLowerCase()})">${item.request.method}</strong>
          <span>${item.request.url.raw}</span>
        </div>
        ${item.request.description ? `<div class="request-card-desc">${item.request.description}</div>` : ''}

        ${item.request.header && item.request.header.length > 0 ? `
          <div class="section-title">Headers</div>
          <table>
            <thead><tr><th>Key</th><th>Value</th></tr></thead>
            <tbody>
              ${item.request.header.map(h => `<tr><td><code>${h.key}</code></td><td><code>${h.value}</code></td></tr>`).join('')}
            </tbody>
          </table>
        ` : ''}

        ${item.request.body && item.request.body.raw ? `
          <div class="section-title">Body (JSON Raw)</div>
          <pre class="code-block">${item.request.body.raw}</pre>
        ` : ''}

        ${item.response && item.response.length > 0 ? item.response.map(resp => `
          <div class="section-title">Response Example: ${resp.name} (${resp.code})</div>
          <pre class="code-block">${resp.body}</pre>
        `).join('') : ''}
      </div>
    `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${collection.info.name} — Postman API Documentation</title>
  <style>
    :root {
      --postman-orange: #FF6C37;
      --bg-dark: #1C1C1C;
      --bg-panel: #262626;
      --bg-hover: #333333;
      --text-main: #E6E6E6;
      --text-muted: #A6A6A6;
      --border-color: #383838;
      --method-get: #0CBB52;
      --method-post: #FF6C37;
      --method-put: #097BED;
      --method-patch: #E5A000;
      --method-delete: #EB2013;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
    body { background: var(--bg-dark); color: var(--text-main); display: flex; height: 100vh; overflow: hidden; }
    .sidebar { width: 320px; background: var(--bg-panel); border-right: 1px solid var(--border-color); display: flex; flex-direction: column; }
    .sidebar-header { padding: 16px; border-bottom: 1px solid var(--border-color); display: flex; align-items: center; gap: 10px; }
    .sidebar-header svg { width: 28px; height: 28px; fill: var(--postman-orange); }
    .sidebar-header h2 { font-size: 16px; font-weight: 600; color: #FFF; }
    .search-box { padding: 12px 16px; border-bottom: 1px solid var(--border-color); }
    .search-box input { width: 100%; padding: 8px 12px; background: var(--bg-dark); border: 1px solid var(--border-color); border-radius: 4px; color: #FFF; font-size: 13px; outline: none; }
    .search-box input:focus { border-color: var(--postman-orange); }
    .request-list { flex: 1; overflow-y: auto; padding: 8px 0; }
    .request-item { padding: 10px 16px; display: flex; align-items: center; gap: 10px; cursor: pointer; border-left: 3px solid transparent; font-size: 13px; transition: background 0.15s; }
    .request-item:hover { background: var(--bg-hover); }
    .request-item.active { background: var(--bg-hover); border-left-color: var(--postman-orange); font-weight: 600; }
    .badge { font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 3px; min-width: 52px; text-align: center; text-transform: uppercase; }
    .badge-get { color: var(--method-get); background: rgba(12, 187, 82, 0.15); }
    .badge-post { color: var(--method-post); background: rgba(255, 108, 55, 0.15); }
    .badge-put { color: var(--method-put); background: rgba(9, 123, 237, 0.15); }
    .badge-patch { color: var(--method-patch); background: rgba(229, 160, 0, 0.15); }
    .badge-delete { color: var(--method-delete); background: rgba(235, 32, 19, 0.15); }
    .main-content { flex: 1; overflow-y: auto; padding: 32px 48px; }
    .collection-header { margin-bottom: 32px; border-bottom: 1px solid var(--border-color); padding-bottom: 24px; }
    .collection-title { font-size: 24px; font-weight: 700; color: #FFF; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; }
    .download-btn { background: var(--postman-orange); color: #FFF; border: none; padding: 8px 16px; border-radius: 4px; font-weight: 600; cursor: pointer; font-size: 13px; }
    .download-btn:hover { background: #E55B2B; }
    .collection-desc { color: var(--text-muted); font-size: 14px; white-space: pre-wrap; line-height: 1.6; }
    .request-card { background: var(--bg-panel); border: 1px solid var(--border-color); border-radius: 8px; margin-bottom: 32px; padding: 24px; }
    .request-card-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
    .request-card-title { font-size: 18px; font-weight: 600; color: #FFF; }
    .url-bar { background: var(--bg-dark); border: 1px solid var(--border-color); padding: 10px 14px; border-radius: 6px; font-family: monospace; font-size: 13px; color: #FFF; margin-bottom: 16px; display: flex; align-items: center; gap: 10px; word-break: break-all; }
    .request-card-desc { color: var(--text-muted); font-size: 14px; white-space: pre-wrap; margin-bottom: 20px; line-height: 1.5; }
    .section-title { font-size: 13px; font-weight: 600; text-transform: uppercase; color: var(--text-muted); margin: 16px 0 8px; letter-spacing: 0.5px; }
    .code-block { background: var(--bg-dark); border: 1px solid var(--border-color); border-radius: 6px; padding: 14px; font-family: monospace; font-size: 13px; color: #7DD3FC; overflow-x: auto; white-space: pre-wrap; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 13px; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border-color); }
    th { color: var(--text-muted); font-weight: 600; }
  </style>
</head>
<body>
  <div class="sidebar">
    <div class="sidebar-header">
      <svg viewBox="0 0 32 32"><path d="M16 2A14 14 0 1 0 30 16 14 14 0 0 0 16 2zm6.2 11.4-3.6 3.6a3.8 3.8 0 0 1-5.4-5.4l3.6-3.6a1.4 1.4 0 0 1 2 2l-3.6 3.6a1 1 0 0 0 1.4 1.4l3.6-3.6a1.4 1.4 0 0 1 2 2z"/></svg>
      <h2>Postman API Docs</h2>
    </div>
    <div class="search-box">
      <input type="text" id="searchInput" placeholder="Filter requests..." oninput="filterRequests()" />
    </div>
    <div class="request-list" id="requestList">
      ${requestListItems}
    </div>
  </div>
  <div class="main-content">
    <div class="collection-header">
      <div class="collection-title">
        <span>${collection.info.name}</span>
        <button class="download-btn" onclick="downloadJSON()">Export Postman v2.1.0</button>
      </div>
      <div class="collection-desc">${collection.info.description || ''}</div>
    </div>
    ${requestCards}
  </div>
  <script>
    const collectionData = ${JSON.stringify(collection, null, 2)};
    function downloadJSON() {
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(collectionData, null, 2));
      const a = document.createElement('a');
      a.setAttribute("href", dataStr);
      a.setAttribute("download", "${collection.info.name.replace(/\s+/g, '_')}_postman_collection.json");
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    function scrollToReq(id) {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
    }
    function filterRequests() {
      const q = document.getElementById('searchInput').value.toLowerCase();
      const items = document.querySelectorAll('.request-item');
      items.forEach(el => {
        el.style.display = el.textContent.toLowerCase().includes(q) ? 'flex' : 'none';
      });
    }
  </script>
</body>
</html>`;
}

function getSwaggerHtml(spec) {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Velociradix API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@4.5.0/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@4.5.0/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({ spec: ${JSON.stringify(spec)}, dom_id: '#swagger-ui' });
  </script>
</body>
</html>`;
}

function createApp() {
  const h = native.createApp();
  const mws = [];
  const routes = [null];
  const routeMeta = [];
  const emitter = new EventEmitter();
  let onErr = null;

  const registerRoute = (method, path, handler, options = {}) => {
    const id = native.addRoute(h, method.toUpperCase(), path);
    routes[id] = { handler, mws: options.middlewares ?? [] };
    if (!options.internal && path !== '/*' && !path.endsWith('/*')) {
      routeMeta.push({
        name: options.name || `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        description: options.description || '',
        headers: options.headers || [],
        body: options.body || null,
        query: options.query || [],
        responses: options.responses || (options.response ? [{ body: options.response, code: options.responseCode || 200, name: options.responseName }] : []),
      });
    }
    return app;
  };

  const app = {
    _handle: h,
    _trustProxy: false,
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    setTrustProxy(val) { app._trustProxy = Boolean(val); return app; },
    fastRoute(method, path, data, status = 200, headers = {}) {
      const body = typeof data === 'string' ? data : JSON.stringify(data);
      const contentType = typeof data === 'string' ? 'text/plain' : 'application/json';
      const hdrs = { 'Content-Type': contentType, ...headers };
      native.registerFastRoute(h, method.toUpperCase(), path, status, hdrs, body);
      return app;
    },
    fastGet(path, data, status = 200, headers = {}) {
      return app.fastRoute('GET', path, data, status, headers);
    },
    fastPost(path, data, status = 200, headers = {}) {
      return app.fastRoute('POST', path, data, status, headers);
    },
    all(path, handler, options) {
      HTTP_METHODS.forEach((m) => registerRoute(m, path, handler, options));
      return app;
    },
    use(mw) { mws.push(mw); return app; },
    useExpress(fn) {
      return app.use((ctx, next) => {
        const shim = {
          setHeader: (k, v) => ctx.setHeader(k, v),
          getHeader: (k) => ctx.get(k),
          setStatus: (c) => { ctx.status(c); },
          get statusCode() { return ctx.res.statusCode; },
          set statusCode(v) { ctx.res.statusCode = v; },
        };
        return fn(ctx.req, shim, next);
      });
    },
    group(prefix, cb) {
      const createGroup = (p) => {
        const g = {
          group: (pp, innerCb) => innerCb(createGroup(p + pp)),
          all: (pp, h2, o) => app.all(p + pp, h2, o),
        };
        HTTP_METHODS.forEach((m) => {
          g[m] = (pp, h2, o) => app[m](p + pp, h2, o);
        });
        return g;
      };
      cb(createGroup(prefix));
      return app;
    },
    redirectRoute(fromPath, toPath, status = 302) {
      return app.get(fromPath, (ctx) => ctx.redirect(toPath, status));
    },
    notFound(handler) {
      return app.all('/*', handler, { internal: true });
    },
    notfound(handler) {
      return app.all('/*', handler, { internal: true });
    },
    postman(options = {}) {
      const baseUrl = options.baseUrl || 'http://localhost:3000';
      return {
        info: {
          name: options.name || 'Velociradix API Collection',
          _postman_id: options.id || randomBytes(16).toString('hex'),
          description: options.description || 'API Documentation Collection generated by Velociradix',
          schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        },
        item: routeMeta.map((r) => {
          const pathParts = r.path.split('/').filter(Boolean);
          const headers = (r.headers || []).map((h) =>
            typeof h === 'string' ? { key: h, value: '' } : { key: h.key || h.name, value: String(h.value ?? '') }
          );
          if (r.body && !headers.some((h) => h.key.toLowerCase() === 'content-type')) {
            headers.push({ key: 'Content-Type', value: 'application/json' });
          }
          const rawUrl = `${baseUrl.replace(/\/$/, '')}${r.path}`;
          const urlObj = {
            raw: rawUrl,
            protocol: baseUrl.startsWith('https') ? 'https' : 'http',
            host: ['localhost'],
            port: '3000',
            path: pathParts,
          };
          if (r.query && Array.isArray(r.query)) {
            urlObj.query = r.query.map((q) =>
              typeof q === 'string' ? { key: q, value: '' } : { key: q.key || q.name, value: String(q.value ?? '') }
            );
          }
          const itemObj = {
            name: r.name,
            request: {
              description: r.description,
              method: r.method,
              header: headers,
              url: urlObj,
            },
          };
          if (r.body) {
            itemObj.request.body = {
              mode: 'raw',
              raw: typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2),
            };
          }
          itemObj.response = [];
          if (r.responses && r.responses.length > 0) {
            r.responses.forEach((resp) => {
              const respBody = typeof resp === 'string' ? resp : typeof resp.body !== 'undefined' ? (typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body, null, 2)) : JSON.stringify(resp, null, 2);
              const statusCode = resp.code || resp.status || 200;
              const statusText = statusCode === 201 ? 'Created' : statusCode === 400 ? 'Bad Request' : statusCode === 404 ? 'Not Found' : 'OK';
              itemObj.response.push({
                name: resp.name || `${statusCode} ${statusText}`,
                originalRequest: itemObj.request,
                status: statusText,
                code: statusCode,
                _postman_previewlanguage: 'json',
                header: [{ key: 'Content-Type', value: 'application/json' }],
                cookie: [],
                body: respBody,
              });
            });
          }
          return itemObj;
        }),
      };
    },
    postmanDoc(docsPath = '/postman-docs', docOpts = {}) {
      app.get(docsPath, (ctx) => {
        const collection = app.postman(docOpts);
        return ctx.html(getPostmanDocHtml(collection));
      });
      return app;
    },
    openapi(specOpts = {}) {
      const paths = {};
      for (const r of routeMeta) {
        paths[r.path] = paths[r.path] || {};
        paths[r.path][r.method.toLowerCase()] = {
          summary: r.description || `${r.method} ${r.path}`,
          responses: { 200: { description: 'Successful response' } },
        };
      }
      return {
        openapi: '3.0.0',
        info: { title: specOpts.title || 'Velociradix API', version: specOpts.version || '1.0.0' },
        paths,
      };
    },
    swagger(docsPath = '/docs') {
      app.get(docsPath, (ctx) => {
        const spec = app.openapi();
        return ctx.html(getSwaggerHtml(spec));
      });
      return app;
    },
    health(path = '/health', checkFn) {
      app.get(path, async (ctx) => {
        const custom = checkFn ? await checkFn() : {};
        return ctx.json({ status: 'ok', uptime: process.uptime(), ...custom });
      });
      return app;
    },
    gracefulShutdown(opts = {}) {
      const shutdown = () => {
        app.close();
        if (opts.onShutdown) opts.onShutdown();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return app;
    },
    enableCors(corsOpts) {
      if (corsOpts) app.use(corsMiddleware(corsOpts));
      else native.enableCors(h);
      return app;
    },
    static(prefix, dir) { native.setStatic(h, prefix, dir); return app; },
    serveStatic(prefix, dir, opts = {}) {
      app.get(`${prefix}/*`, (ctx) => {
        const reqPath = ctx.req.path.slice(prefix.length);
        const target = resolve(dir, reqPath.replace(/^\//, ''));
        return ctx.sendFile(target, opts);
      });
      return app;
    },
    setPayloadLimit(n) { native.setPayloadLimit(h, n); return app; },
    setWorkers(n) { native.setWorkers(h, n); return app; },
    onError(fn) { onErr = fn; return app; },
    listen(port, hostOrCb, maybeCb) {
      let host = '0.0.0.0';
      let cb = null;
      if (typeof hostOrCb === 'function') cb = hostOrCb;
      else { host = hostOrCb; cb = maybeCb ?? null; }
      app._keepAlive = setInterval(() => {}, 0x7fffffff);
      native.listen(h, port, host);
      if (cb) cb();
      return app;
    },
    close() {
      if (app._keepAlive) { clearInterval(app._keepAlive); app._keepAlive = null; }
      native.close(h);
      return app;
    },
  };

  HTTP_METHODS.forEach((m) => {
    app[m] = (path, handler, options) => registerRoute(m, path, handler, options);
  });

  const dispatch = (routeId, ptr) => {
    const entry = routes[routeId];
    const ctx = acquireContext(ptr, app);
    emitter.emit('request', ctx);
    let result;
    try {
      if (mws.length === 0 && entry.mws.length === 0) {
        result = entry.handler(ctx);
      } else {
        const chain = mws.length === 0 ? entry.mws : (entry.mws.length === 0 ? mws : [...mws, ...entry.mws]);
        result = runChain(chain, entry.handler, ctx);
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : ((err && err.status) || 500);
      ctx.statusCode = status;
      if (emitter.listenerCount("error") > 0) emitter.emit("error", err, ctx);
      if (onErr) { onErrorAsync(onErr, err, ctx); return; }
      respondValue(ctx, status, { error: (err && err.message) || 'Internal Server Error', details: err.details });
      releaseContext(ctx);
      return;
    }
    if (result && typeof result.then === 'function') {
      result.then((v) => {
        if (!ctx.done) {
          emitter.emit('response', ctx);
          if (v === undefined) respondRes(ctx, ctx.statusCode, '');
          else respondValue(ctx, ctx.statusCode, v);
        }
        releaseContext(ctx);
      }, (err) => {
        const status = err instanceof HttpError ? err.status : ((err && err.status) || 500);
        ctx.statusCode = status;
        if (!ctx.done) {
          if (emitter.listenerCount("error") > 0) emitter.emit("error", err, ctx);
          if (onErr) { onErrorAsync(onErr, err, ctx); return; }
          respondValue(ctx, status, { error: (err && err.message) || 'Internal Server Error', details: err.details });
        }
        releaseContext(ctx);
      });
    } else {
      if (!ctx.done) {
        emitter.emit('response', ctx);
        if (result === undefined) respondRes(ctx, ctx.statusCode, '');
        else respondValue(ctx, ctx.statusCode, result);
      }
      releaseContext(ctx);
    }
  };

  function onErrorAsync(fn, err, ctx) {
    const status = (ctx.statusCode && ctx.statusCode !== 200) ? ctx.statusCode : ((err && err.status) || 500);
    ctx.statusCode = status;
    Promise.resolve()
      .then(() => fn(err, ctx))
      .then((r) => (!ctx.done ? respondValue(ctx, status, r ?? {}) : null))
      .catch((e2) =>
        !ctx.done
          ? respondRes(ctx, 500, String((e2 && e2.message) || e2))
          : null,
      )
      .finally(() => releaseContext(ctx));
  }

  native.registerDispatch(h, dispatch);

  return app;
}

const app = createApp();

const middlewares = {
  logger: loggerMiddleware,
  cors: corsMiddleware,
  bearerAuth: bearerAuthMiddleware,
  jwtAuth: jwtAuthMiddleware,
  compress: compressMiddleware,
  csrf: csrfMiddleware,
  cache: cacheMiddleware,
  requestId: requestIdMiddleware,
  validate: validateMiddleware,
  sanitize: sanitizeMiddleware,
  session: sessionMiddleware,
  slowDown: slowDownMiddleware,
  rateLimit: rateLimitMiddleware,
  helmet: helmetMiddleware,
  ipFilter: ipFilterMiddleware,
  responseTime: responseTimeMiddleware,
  sizeLimit: sizeLimitMiddleware,
  maintenance: maintenanceMiddleware,
  basicAuth: basicAuthMiddleware,
  csp: cspMiddleware,
  timeout: timeoutMiddleware,
  methodOverride: methodOverrideMiddleware,
  apiKey: apiKeyMiddleware,
  allowedMethods: allowedMethodsMiddleware,
  headerInjector: headerInjectorMiddleware,
  redirector: redirectorMiddleware,
  concurrencyLimit: concurrencyLimitMiddleware,
  etag: etagMiddleware,
  userAgentBlocker: userAgentBlockerMiddleware,
  bodyCleaner: bodyCleanerMiddleware,
  conditionalRequest: conditionalRequestMiddleware,
  hostGuard: hostGuardMiddleware,
  auditLog: auditLogMiddleware,
  favicon: faviconMiddleware,
};

export {
  app,
  allowedMethodsMiddleware as allowedMethods,
  apiKeyMiddleware as apiKey,
  auditLogMiddleware as auditLog,
  BadRequestError,
  basicAuthMiddleware as basicAuth,
  bearerAuthMiddleware as bearerAuth,
  bodyCleanerMiddleware as bodyCleaner,
  cacheMiddleware as cache,
  compressMiddleware as compress,
  concurrencyLimitMiddleware as concurrencyLimit,
  conditionalRequestMiddleware as conditionalRequest,
  corsMiddleware as cors,
  cspMiddleware as csp,
  createApp,
  csrfMiddleware as csrf,
  decryptValue,
  encryptValue,
  etagMiddleware as etag,
  faviconMiddleware as favicon,
  ForbiddenError,
  headerInjectorMiddleware as headerInjector,
  helmetMiddleware as helmet,
  hostGuardMiddleware as hostGuard,
  HttpError,
  InternalServerError,
  ipFilterMiddleware as ipFilter,
  jwtAuthMiddleware as jwtAuth,
  jwtSign,
  jwtVerify,
  loggerMiddleware as logger,
  maintenanceMiddleware as maintenance,
  methodOverrideMiddleware as methodOverride,
  NotFoundError,
  rateLimitMiddleware as rateLimit,
  redirectorMiddleware as redirector,
  requestIdMiddleware as requestId,
  responseTimeMiddleware as responseTime,
  sanitizeMiddleware as sanitize,
  sessionMiddleware as session,
  sizeLimitMiddleware as sizeLimit,
  slowDownMiddleware as slowDown,
  timeoutMiddleware as timeout,
  UnauthorizedError,
  userAgentBlockerMiddleware as userAgentBlocker,
  validateMiddleware as validate,
};

export default {
  app,
  createApp,
  jwtSign,
  jwtVerify,
  encryptValue,
  decryptValue,
  HttpError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  InternalServerError,
  ...middlewares,
};
