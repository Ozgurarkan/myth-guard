// The HTTP surface (design 3.7, 4.4): one Connect-style middleware that guards every request, serves the routes of
// 4.4 and, when it has a built site, the static files. The Vite dev server uses the same middleware without a site and
// falls through to Vite with `next()`.
//
//   Host allowlist (421) -> ban check for /__realm/* -> routes -> static map or next()
//
// Everything here fails closed: a path it does not understand is a 400/404, never a file read.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { constants, brotliCompressSync, gzipSync } from 'node:zlib';
import { extname, join, relative, sep } from 'node:path';
import { LIMITS, PATHS, PROTOCOL_VERSION } from '../../src/net/protocol.js';
import { readBody, tooLarge } from './assets.js';

export const APP_ID = 'realm-forge';
const UNKNOWN_V2_PATH = '/session-sync';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json', '.wasm': 'application/wasm',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.txt', '.ico', '.map']);

// ---- node http server limits (4.4) ------------------------------------------------------------------------------

export const HTTP_LIMITS = Object.freeze({
  headersTimeout: 10_000, requestTimeout: 30_000, keepAliveTimeout: 5_000, maxHeaderSize: 8 * 1024, maxConnections: 200,
  connectionsCheckingInterval: 2_000, keepAliveProbeMs: 10_000,
});

/** Options for `http.createServer(options, handler)`. */
export function httpServerOptions(overrides = {}) {
  const limits = { ...HTTP_LIMITS, ...overrides };
  return {
    headersTimeout: limits.headersTimeout, requestTimeout: limits.requestTimeout, keepAliveTimeout: limits.keepAliveTimeout,
    maxHeaderSize: limits.maxHeaderSize, connectionsCheckingInterval: limits.connectionsCheckingInterval,
  };
}

/** Applies the settable limits to a server that somebody else created (the Vite dev server). */
export function hardenHttpServer(server, overrides = {}) {
  const limits = { ...HTTP_LIMITS, ...overrides };
  server.headersTimeout = limits.headersTimeout;
  server.requestTimeout = limits.requestTimeout;
  server.keepAliveTimeout = limits.keepAliveTimeout;
  server.maxConnections = limits.maxConnections;
  server.on('connection', socket => socket.setKeepAlive(true, limits.keepAliveProbeMs));
  return server;
}

// ---- the built site ---------------------------------------------------------------------------------------------

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

const sha256 = text => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
const unescapeHtml = text => text.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** CSP source tokens for the inline scripts and inline event-handler attributes of one HTML page. */
export function inlineScriptHashes(html) {
  const tokens = new Set();
  for (const match of html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (match[1].trim()) tokens.add(sha256(match[1]));
  }
  for (const match of html.matchAll(/\son[a-z]+\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    tokens.add("'unsafe-hashes'");
    tokens.add(sha256(unescapeHtml(match[1] ?? match[2] ?? '')));
  }
  return [...tokens];
}

/** Reads the build folder into memory, compressed once. Returns Map<url, file>. */
export async function loadSite(root) {
  const files = new Map();
  for await (const path of walk(root)) {
    const url = '/' + relative(root, path).split(sep).join('/');
    const extension = extname(path).toLowerCase();
    const body = await readFile(path);
    const file = {
      type: TYPES[extension] || 'application/octet-stream',
      etag: `"${createHash('sha1').update(body).digest('hex').slice(0, 20)}"`,
      // Vite fingerprints everything in /assets/, so those files never change under one name.
      cache: url.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      identity: body,
      scriptHashes: extension === '.html' ? inlineScriptHashes(body.toString('utf8')) : [],
    };
    if (COMPRESSIBLE.has(extension) && body.length > 512) {
      file.br = brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } });
      file.gzip = gzipSync(body, { level: 9 });
    }
    files.set(url, file);
  }
  return files;
}

// ---- headers ------------------------------------------------------------------------------------------------------

/** The CSP of design 3.7 for one Host. `host` has passed the Host allowlist, so it holds only [A-Za-z0-9.:\[\]-]. */
export function buildCsp(host, scriptHashes = []) {
  const scripts = ["'self'", ...scriptHashes].join(' ');
  return [
    "default-src 'self'", `script-src ${scripts}`, "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
    "media-src 'self' blob: mediastream:", `connect-src 'self' ws://${host} wss://${host}`, "worker-src 'self' blob:",
    "frame-src 'self' blob:", 'object-src blob:', "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ].join('; ');
}

const PERMISSIONS_GM = 'camera=(), microphone=(), geolocation=(), display-capture=(self)';
const PERMISSIONS_PLAYER = 'camera=(), microphone=(), geolocation=(), display-capture=()';

/** Dev server only: paths that must never reach Vite (it would serve any file of the project folder). */
const DEV_DENIED = [
  '/.realm-data', '/.backup', '/.git', '/.env', '/.npm-cache', '/.tools', '/server/', '/test/', '/test-support/', '/docs/', '/scripts/',
  '/artifacts/', '/dist/', '/package.json', '/package-lock.json', '/@fs/',
];
const devDenied = path => {
  const lower = path.toLowerCase();
  return DEV_DENIED.some(prefix => lower.startsWith(prefix));
};

// ---- the router ---------------------------------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {Map<string, object>|null} deps.site  from loadSite(); null in dev (Vite serves the files)
 * @param deps.assetRoutes  createAssetRoutes(...)
 * @param deps.handshake  createHandshake(...)
 * @param deps.metrics  createMetrics(...)
 * @param deps.hostGuard  createHostGuard(...)
 * @param deps.limiter  createIpLimiter(...)
 * @param {(port: number) => object} deps.info  body of GET /__realm/info (called after the GM check)
 * @param {() => object} deps.diag  body of GET /__realm/diag
 * @param {'report-only'|'enforce'|'off'} [deps.cspMode]
 */
export function createHttpRouter({ site, assetRoutes, handshake, metrics, hostGuard, limiter, info, diag, onPort = () => {}, cspMode = 'report-only' }) {
  const cspHeader = cspMode === 'enforce' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only';

  const setBaseHeaders = (response, path) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Permissions-Policy', path === '/' || path === '/index.html' ? PERMISSIONS_GM : PERMISSIONS_PLAYER);
  };
  /** Only for a Host that passed the allowlist: it is written into the policy. */
  const setSecurityHeaders = (response, path, host, scriptHashes) => {
    setBaseHeaders(response, path);
    if (cspMode !== 'off') response.setHeader(cspHeader, buildCsp(host, scriptHashes));
  };
  // The installed Android/iOS player is a trusted native WebView, not an
  // arbitrary website. Echo only its two fixed origins for cross-origin calls
  // to the table host; normal browser traffic retains the same-origin policy.
  const setNativePlayerCors = (response, ctx) => {
    if (!hostGuard.isNativePlayerOrigin?.(ctx.origin)) return false;
    response.setHeader('Access-Control-Allow-Origin', ctx.origin);
    response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Vary', 'Origin');
    return true;
  };

  const empty = (response, status, headers = {}) => {
    response.writeHead(status, { 'Content-Length': '0', 'Cache-Control': 'no-store', ...headers });
    response.end();
  };
  const text = (response, status, body, headers = {}) => {
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    response.end(body);
  };
  const json = (response, status, body, headers = {}) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    response.end(JSON.stringify(body));
  };

  const serveStatic = (request, response, path, host) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') { empty(response, 405, { Allow: 'GET, HEAD' }); return; }
    const file = site.get(path === '/' ? '/index.html' : path);
    if (!file) { text(response, 404, 'Not found'); return; }
    setSecurityHeaders(response, path, host, file.scriptHashes);
    const accepts = String(request.headers['accept-encoding'] || '');
    const encoding = file.br && /\bbr\b/.test(accepts) ? 'br' : file.gzip && /\bgzip\b/.test(accepts) ? 'gzip' : null;
    const body = encoding === 'br' ? file.br : encoding === 'gzip' ? file.gzip : file.identity;
    const headers = { 'Content-Type': file.type, 'Cache-Control': file.cache, ETag: file.etag, Vary: 'Accept-Encoding' };
    if (encoding) headers['Content-Encoding'] = encoding;
    if (request.headers['if-none-match'] === file.etag) { response.writeHead(304, headers); response.end(); return; }
    headers['Content-Length'] = body.length;
    response.writeHead(200, headers);
    response.end(request.method === 'HEAD' ? undefined : body);
  };

  /** POST with a small JSON body: hello and join. */
  const postJson = async (request, response, ctx, handler) => {
    if (request.method !== 'POST') { empty(response, 405, { Allow: 'POST' }); return; }
    if (!/^application\/json\s*(;|$)/i.test(String(request.headers['content-type'] || ''))) { json(response, 415, { error: 'bad-request' }); return; }
    let body;
    try {
      body = JSON.parse((await readBody(request, LIMITS.httpBodyMax)).toString('utf8'));
    } catch (error) {
      if (error?.status === 413) { metrics.inc('reject.oversize'); tooLarge(request, response); return; }
      metrics.inc('reject.malformed');
      json(response, 400, { error: 'bad-request' });
      return;
    }
    const result = handler(ctx, body);
    json(response, result.status, result.body, result.setCookie ? { 'Set-Cookie': result.setCookie } : {});
  };

  const failed = response => {
    metrics.inc('http.errors');
    if (!response.headersSent) { try { response.writeHead(500, { 'Content-Length': '0' }); } catch { /* socket gone */ } }
    try { response.end(); } catch { /* socket gone */ }
  };

  const gmOnly = (ctx, response) => {
    if (handshake.isGm(ctx).ok) return true;
    metrics.inc('reject.gm');
    empty(response, 403);
    return false;
  };

  const route = (request, response, next) => {
    metrics.inc('http.requests');
    if (request.method === 'HEAD') {
      // Same status and headers as GET, never a body (Node already drops it on the wire; this keeps fakes honest too).
      const end = response.end.bind(response);
      response.end = () => end();
    }
    const ctx = handshake.describe(request);
    const port = request.socket?.localPort;
    if (port) onPort(port);

    if (typeof request.url !== 'string' || !request.url.startsWith('/')) { empty(response, 400); return; }
    if (!hostGuard.hostAllowed(ctx.host)) {
      metrics.inc('reject.host');
      setBaseHeaders(response, '');
      empty(response, 421, { Connection: 'close' });
      return;
    }
    const host = ctx.host;
    const rawPath = request.url.split('?')[0];
    let path;
    try { path = decodeURIComponent(rawPath); } catch { empty(response, 400); return; }
    if (path.includes('\0') || path.includes('\\')) { empty(response, 400); return; }

    setSecurityHeaders(response, path, host, []);
    const nativePlayer = setNativePlayerCors(response, ctx);
    if (request.method === 'OPTIONS' && nativePlayer) { empty(response, 204); return; }

    if (path.startsWith('/__realm/') || path === '/__realm') {
      if (path === PATHS.hello || path === PATHS.join) {
        // These two answer a banned address themselves (with the generic body).
        const handler = path === PATHS.hello ? handshake.hello : handshake.join;
        postJson(request, response, ctx, handler).catch(() => failed(response));
        return;
      }
      if (limiter.banned(ctx.ip)) { metrics.inc('reject.banned'); empty(response, 403); return; }
      if (path === PATHS.status) {
        if (request.method !== 'GET' && request.method !== 'HEAD') { empty(response, 405, { Allow: 'GET, HEAD' }); return; }
        if (!hostGuard.isLoopback(ctx.ip)) { empty(response, 403); return; }
        json(response, 200, { app: APP_ID, version: PROTOCOL_VERSION });
        return;
      }
      if (path === PATHS.info || path === PATHS.diag || path === `${PATHS.diag}/log`) {
        if (request.method !== 'GET' && request.method !== 'HEAD') { empty(response, 405, { Allow: 'GET, HEAD' }); return; }
        if (!gmOnly(ctx, response)) return;
        if (path === PATHS.info) json(response, 200, info(port || 0));
        else if (path === PATHS.diag) json(response, 200, diag());
        else json(response, 200, { lines: metrics.logTail() });
        return;
      }
      if (path.startsWith(PATHS.assets)) { assetRoutes.handle(request, response, ctx); return; }
      empty(response, 404);
      return;
    }

    if (path === UNKNOWN_V2_PATH) {
      text(response, 426, 'Myth Guard was updated. Reload this page.', { Upgrade: 'websocket', Connection: 'Upgrade' });
      return;
    }

    if (path === '/' || path === '/index.html') {
      if (!hostGuard.isLoopback(ctx.ip)) {
        // Other devices never get the GM page.
        empty(response, 302, { Location: '/player.html' });
        return;
      }
      // The GM's own browser: hand it the private cookie that the GM WebSocket will have to present.
      if (hostGuard.loopbackHostAllowed(ctx.host)) response.setHeader('Set-Cookie', handshake.gmSetCookie());
    }

    if (site) { serveStatic(request, response, path, host); return; }
    // Dev server: refuse the paths Vite would serve from the project folder, then let Vite handle the rest.
    if (devDenied(path) || /%25|%2e|%5c|%2f/i.test(rawPath) || path.split('/').includes('..')) { text(response, 404, 'Not found'); return; }
    next();
  };

  return function realmRouter(request, response, next = () => { response.statusCode = 404; response.end(); }) {
    try {
      route(request, response, next);
    } catch (error) {
      metrics.log(`http: handler error (${error?.name ?? 'Error'})`);
      failed(response);
    }
  };
}
