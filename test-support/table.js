// Boot a table: a server, a GM and N players, over real loopback sockets. Used by the acceptance scripts.
//
//   const table = await startTable({ players: 8 });           // new stack (v3), server in a child process
//   const old = await startTable({ stack: 'v2', players: 8 }); // the pre-rewrite server from .backup-pre-network-rewrite (baselines)
//   await table.gm.publish(table.scene);                       // GM sends a complete scene
//   table.players[0].moveToken('tok0', 3601, 3300);            // PLAYER_TOKEN_MOVE
//   await table.close();
//
// The clients speak the wire protocol of design 4.3 / 4.5 themselves (src/net/hmac.js, protocol.js and syncPatch.js are the
// only shared code), so they test the server and are independent of the browser-side links of WP4.
// If the new stack is not there (yet), startTable throws ServerUnavailable with a readable message.
import { spawn } from 'node:child_process';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { PATHS, PROTOCOL_VERSION, SUBPROTOCOL, authProtocol, fnv1a } from '../src/net/protocol.js';
import { deriveDk, inviteKey, joinProof, randomHex, srvProof, wsProof } from '../src/net/hmac.js';
import { applyPatch } from '../src/syncPatch.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BACKUP = join(ROOT, '.backup-pre-network-rewrite');
const HERE = fileURLToPath(import.meta.url);

export class ServerUnavailable extends Error {
  constructor(reason) { super(`server not available: ${reason}`); this.name = 'ServerUnavailable'; }
}
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => performance.now();

export function quantiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const q = p => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : NaN);
  return { n: sorted.length, min: sorted[0], p50: q(0.5), p95: q(0.95), p99: q(0.99), max: sorted.at(-1), mean: sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1) };
}

// ---------------------------------------------------------------------------------------------------------------------
// HTTP and scenes
// ---------------------------------------------------------------------------------------------------------------------

/** Plain HTTP request with full control of headers (Host, Origin, Cookie). Never throws on a refused request. */
export function http(method, base, path, { headers = {}, body, localAddress, timeoutMs = 10000 } = {}) {
  return new Promise(resolve => {
    const url = new URL(path, base);
    const payload = body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const request = httpRequest({
      host: url.hostname, port: url.port, method, path: url.pathname + url.search, localAddress, agent: false,
      headers: { ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload), ...(typeof body === 'object' && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}) } : {}), ...headers },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, headers: response.headers, text, get json() { try { return JSON.parse(text); } catch { return null; } } });
      });
      response.on('error', error => resolve({ status: 0, error: error.message, headers: {}, text: '' }));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('timeout')));
    request.on('error', error => resolve({ status: 0, error: error.message, headers: {}, text: '' }));
    request.end(payload);
  });
}

/** The scene of the acceptance tests (design 6.4 N3): 4096x4096 map, 5,000 fog cells, 30 tokens. `owners[i]` owns token tok<i>. */
export function makeScene({ fog = 5000, tokens = 30, owners = [], extra = {} } = {}) {
  const url = `http://x${PATHS.assets}${'a'.repeat(64)}`;
  const fogCells = [];
  for (let i = 0; i < fog; i += 1) fogCells.push(`${Math.floor(i / 82)},${i % 82}`);
  return {
    mapImageSrc: url, mapWidth: 4096, mapHeight: 4096, gridSize: 50, showFog: true, fogCells, playerCanMoveTokens: true, showGrid: true, snapToGrid: true,
    tokens: Array.from({ length: tokens }, (_, i) => ({
      id: `tok${i}`, name: `T${i}`, x: i < 16 ? 3100 + i * 60 : 3000 + (i % 10) * 50, y: i < 16 ? 3300 : 3200 + Math.floor(i / 10) * 50, // tok0..tok15 (the movable ones) stand on open ground, outside the fog gridSize: 1, imageSrc: url,
      ownerId: owners[i] ?? null, visibleToPlayers: true,
    })),
    markers: [], areaEffects: [], combat: { entries: [], activeId: null, round: 1 }, ...extra,
  };
}

/** Same as the server's canonical JSON, so a client can verify `sum` of a STATE_PATCH. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(item => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  const parts = [];
  for (const key of Object.keys(value).sort()) if (value[key] !== undefined) parts.push(`${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${parts.join(',')}}`;
}
export const stateHash = state => fnv1a(canonicalJson(state));

// ---------------------------------------------------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------------------------------------------------

/** Wraps a `ws` socket: message log hooks, waiters, byte counters. */
function peer(ws, extra = {}) {
  const waiters = new Set();
  const p = {
    ws, last: null, framesIn: 0, bytesIn: 0, closeCode: null, closedAt: null, byType: Object.create(null), log: extra.record ? [] : null,
    state: null, rev: null, fulls: 0, patches: 0, divergence: 0, gaps: 0, sumsChecked: 0, onFrame: null,
    ...extra,
    open: ws.readyState === WebSocket.OPEN,
    send: obj => ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)),
    /** Resolves with { msg, at } for the next message the predicate accepts (messages already received are not considered). */
    waitFor(test, timeoutMs = 5000, label = 'message') {
      return new Promise((resolve, reject) => {
        const waiter = { test, resolve: value => { clearTimeout(waiter.timer); waiters.delete(waiter); resolve(value); } };
        waiter.timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`timed out after ${timeoutMs} ms waiting for ${label}`)); }, timeoutMs);
        waiters.add(waiter);
      });
    },
    next: (type, ms) => p.waitFor(m => m.type === type, ms, type),
    /** The first message of this type, even if it arrived before anybody asked. */
    first: (type, ms) => (p.firsts[type] ? Promise.resolve({ msg: p.firsts[type], at: 0 }) : p.next(type, ms)),
    firsts: Object.create(null),
    close: (code = 1000) => { try { ws.close(code); } catch { /* closed */ } },
    terminate: () => ws.terminate(),
    closed: () => new Promise(resolve => (p.closeCode !== null ? resolve(p.closeCode) : ws.once('close', code => resolve(code)))),
  };
  ws.on('message', (data, binary) => {
    const at = now();
    p.framesIn += 1;
    p.bytesIn += data.length;
    if (binary) { p.byType.binary = (p.byType.binary ?? 0) + 1; return; }
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    p.last = msg;
    p.firsts[msg.type] ??= msg;
    p.byType[msg.type] = (p.byType[msg.type] ?? 0) + 1;
    p.log?.push(msg);
    p.onFrame?.(msg, at, data);
    for (const waiter of [...waiters]) if (waiter.test(msg)) waiter.resolve({ msg, at });
  });
  ws.on('close', code => { p.closeCode = code; p.open = false; p.closedAt = now(); for (const waiter of waiters) clearTimeout(waiter.timer); });
  ws.on('error', () => {});
  return p;
}

/** Keeps a player's copy of the view in step with STATE_FULL / STATE_PATCH, exactly like the browser link does. */
function trackState(p, { autoResync = true } = {}) {
  p.onFrame = (msg, at, data) => {
    if (msg.type === 'STATE_FULL') { p.fullBytes = data.length; if (p.keepRaw) p.fullRaw = data; p.wireAtFull = p.ws._socket?.bytesRead; p.state = msg.state; p.rev = msg.rev; p.fulls += 1; p.lastStateAt = at; return; }
    if (msg.type !== 'STATE_PATCH') return;
    p.patches += 1;
    p.lastPatchBytes = data.length;
    p.lastStateAt = at;
    if (p.state === null || msg.base !== p.rev) { p.gaps += 1; if (autoResync) p.send({ type: 'RESYNC' }); return; }
    p.state = applyPatch(p.state, msg.patch);
    p.rev = msg.rev;
    if (msg.sum !== undefined) {
      p.sumsChecked += 1;
      if (stateHash(p.state) !== msg.sum) { p.divergence += 1; if (autoResync) p.send({ type: 'RESYNC' }); }
    }
  };
}

// The peer is built inside the 'open' event: the server's first frames can arrive in the same TCP chunk as the 101 response.
function openSocket(url, protocols, headers, { localAddress, handshakeTimeout = 8000, extra = {} } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols, { headers, localAddress, perMessageDeflate: true, handshakeTimeout });
    ws.once('open', () => resolve(peer(ws, extra)));
    ws.once('unexpected-response', (_request, response) => { response.resume(); reject(Object.assign(new Error(`upgrade refused: HTTP ${response.statusCode}`), { status: response.statusCode })); });
    ws.once('error', error => reject(error));
  });
}

/**
 * A fresh loopback source address (127.x.y.z). The server limits hello / join / upgrade per source address, and every test
 * client on this PC shares 127.0.0.1; giving each connection its own address keeps those limits from throttling the harness.
 * The limits themselves are tested with the LAN address in accept-security.mjs.
 */
let addressCounter = 0;
export const freshAddress = () => { addressCounter += 1; return `127.${10 + (addressCounter >> 16 & 0x7f)}.${addressCounter >> 8 & 255}.${1 + (addressCounter & 255) % 254}`; };

/** First-time admission (design 4.3). Returns { device, dk, status, cookie } or throws. `invite` = { how: 'link'|'code', value }. */
export async function joinDevice(server, invite, { name = 'Player', device = randomHex(16), localAddress = freshAddress() } = {}) {
  const key = inviteKey(invite.how, invite.value);
  const nonce = randomHex(16);
  const response = await http('POST', server.base, PATHS.join, {
    localAddress, body: { v: PROTOCOL_VERSION, device, name, nonce, how: invite.how, proof: joinProof(key, device, nonce) },
  });
  if (response.status !== 200) throw Object.assign(new Error(`join refused: HTTP ${response.status} ${response.text.slice(0, 80)}`), { status: response.status, response });
  const body = response.json;
  if (srvProof(key, device, nonce, body.srv) !== body.srvProof) throw new Error('the server could not prove it knows the invite (srvProof mismatch)');
  const cookie = String(response.headers['set-cookie'] ?? '').split(';')[0];
  return { device, dk: deriveDk(key, device, nonce, body.srv), status: body.status, cookie };
}

/** Open the authenticated control socket of an admitted device. Resolves when HELLO has arrived (and RESUME was sent). */
export async function connectPlayer(server, identity, { name = 'Player', resume = { rev: null, aids: [] }, record = false, localAddress = freshAddress(), track = true } = {}) {
  const { device, dk, cookie } = identity;
  if (server.stack === 'v2') {
    const p = await openSocket(`ws://127.0.0.1:${server.port}/session-sync?role=player`, [], {}, { localAddress, extra: { record, device, name, stack: 'v2' } });
    if (track) trackState(p);
    const id = await p.first('PLAYER_ID', 5000).catch(() => null);
    p.playerId = id?.msg.id ?? null;
    return p;
  }
  const hello = await http('POST', server.base, PATHS.hello, { body: { device }, localAddress });
  if (hello.status !== 200) throw Object.assign(new Error(`hello refused: HTTP ${hello.status}`), { status: hello.status });
  const { nonce } = hello.json;
  const proof = wsProof(dk, device, nonce, 'player');
  const p = await openSocket(`ws://${server.hostName ?? '127.0.0.1'}:${server.port}${PATHS.ws}?role=player`, [SUBPROTOCOL, authProtocol(device, nonce, proof)], {
    Origin: `http://${server.hostName ?? '127.0.0.1'}:${server.port}`, ...(cookie ? { Cookie: cookie } : {}),
  }, { localAddress, extra: { record, device, name, stack: 'v3', cookie } });
  if (track) trackState(p);
  const helloMsg = (await p.first('HELLO', 5000)).msg;
  p.playerId = helloMsg.playerId; p.helloMessage = helloMsg;
  // a resumed device still holds the state it had: seed it, or the first patch would look like a gap
  if (resume?.state) { p.state = resume.state; p.rev = resume.rev; }
  if (resume) p.send({ type: 'RESUME', rev: resume.rev, aids: resume.aids ?? [] });
  return p;
}

/** The GM window. v3: loopback + Host localhost + Origin + the rf-gm cookie from GET /. */
export async function connectGm(server, { record = false, answerFullState = true } = {}) {
  const extra = { record, stack: server.stack, scene: null, published: 0 };
  let g;
  if (server.stack === 'v2') g = await openSocket(`ws://127.0.0.1:${server.port}/session-sync?role=gm`, [], {}, { extra });
  else {
    const host = `localhost:${server.port}`;
    const page = await http('GET', server.base, '/', { headers: { Host: host } });
    const cookie = [].concat(page.headers['set-cookie'] ?? []).map(c => c.split(';')[0]).find(c => c.startsWith('rf-gm='));
    if (!cookie) throw new Error(`GET / gave no rf-gm cookie (HTTP ${page.status})`);
    g = await openSocket(`ws://127.0.0.1:${server.port}${PATHS.ws}?role=gm`, [SUBPROTOCOL], { Host: host, Origin: `http://${host}`, Cookie: cookie }, { extra });
    server.gmCookie = cookie;
  }
  g.publish = scene => { g.scene = scene; g.published += 1; g.send({ type: 'SCENE', scene }); };
  g.onFrame = msg => { if (msg.type === 'REQUEST_FULL_STATE' && answerFullState && g.scene) g.send({ type: 'SCENE', scene: g.scene }); };
  await g.first('HELLO', 5000).catch(() => {});
  return g;
}

/** GM-only REST: { info, diag } for the v3 server, using the rf-gm cookie of the GM window. */
export async function gmGet(server, path) {
  const host = `localhost:${server.port}`;
  if (!server.gmCookie) {
    const page = await http('GET', server.base, '/', { headers: { Host: host } });
    server.gmCookie = [].concat(page.headers['set-cookie'] ?? []).map(c => c.split(';')[0]).find(c => c.startsWith('rf-gm='));
  }
  return http('GET', server.base, path, { headers: { Host: host, Cookie: server.gmCookie ?? '' } });
}

/** The invite for tests: the link secret from /__realm/info when a LAN address exists, otherwise the typed code. */
export async function fetchInvite(server) {
  const response = await gmGet(server, PATHS.info);
  if (response.status !== 200) throw new Error(`GET ${PATHS.info} -> HTTP ${response.status}`);
  const info = response.json;
  const link = info.addresses?.map(a => a.joinUrl).find(Boolean);
  const secret = link && /#join=([A-Za-z0-9_-]{22})/.exec(link)?.[1];
  return { info, link: link ?? null, secret: secret ?? null, code: info.code, invite: secret ? { how: 'link', value: secret } : { how: 'code', value: info.code } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------------------------------------------------

/** Which stacks can start here? -> { v3: reason|null, v2: reason|null } (null = available). */
export function stackAvailability() {
  const need = (...files) => files.filter(f => !existsSync(join(ROOT, f)));
  const v3 = need('server/net/realm.js', 'server/net/access.js', 'server/net/hub.js');
  const v2 = need('.backup-pre-network-rewrite/server/sessionSync.js');
  return {
    v3: v3.length ? `missing ${v3.join(', ')}` : null,
    v2: v2.length ? `missing ${v2.join(', ')}` : null,
  };
}
export const defaultStack = () => (stackAvailability().v3 ? 'v2' : 'v3');

async function bootInProcess({ stack, port = 0, host = '127.0.0.1', root = join(ROOT, 'dist'), site = false, dataDir = null }) {
  if (stack === 'v2') {
    const { createRealm } = await import(pathToFileURL(join(BACKUP, 'server/sessionSync.js')).href);
    const realm = createRealm();
    const server = createServer((req, res) => realm.middleware(req, res, () => { res.statusCode = 404; res.end('nf'); }));
    realm.attach(server);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    return { port: server.address().port, close: async () => { server.closeAllConnections?.(); await new Promise(r => server.close(r)); }, realm };
  }
  const reason = stackAvailability().v3;
  if (reason) throw new ServerUnavailable(reason);
  let realmModule, httpModule;
  try {
    realmModule = await import(pathToFileURL(join(ROOT, 'server/net/realm.js')).href);
    httpModule = await import(pathToFileURL(join(ROOT, 'server/net/http.js')).href);
  } catch (error) { throw new ServerUnavailable(`the new server failed to load (${error.message.split('\n')[0]})`); }
  const siteMap = site ? await httpModule.loadSite(root) : null;
  const realm = realmModule.createRealm({ dataDir, site: siteMap });
  const server = createServer(httpModule.httpServerOptions?.() ?? {}, (req, res) => realm.middleware(req, res, () => { res.writeHead(404, { 'Content-Length': '0' }); res.end(); }));
  httpModule.hardenHttpServer?.(server);
  realm.attach(server);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return { port: server.address().port, realm, close: async () => { await realm.close(); server.closeAllConnections?.(); await new Promise(r => server.close(r)); } };
}

/**
 * Start a server. `child: true` runs it in its own process (accurate memory numbers, a crash cannot take the script down).
 * -> { stack, port, base, memory(), close(), child|null, realm|null }
 */
export async function startServer({ stack = defaultStack(), child = false, ...options } = {}) {
  const availability = stackAvailability()[stack];
  if (availability) throw new ServerUnavailable(`${stack === 'v3' ? 'new' : 'old (backup)'} stack: ${availability}`);
  if (!child) {
    const booted = await bootInProcess({ stack, ...options });
    return {
      stack, port: booted.port, base: `http://127.0.0.1:${booted.port}`, hostName: '127.0.0.1', realm: booted.realm ?? null, child: null,
      memory: async () => ({ ...process.memoryUsage() }), gc: async () => { globalThis.gc?.(); }, close: booted.close,
    };
  }
  const proc = spawn(process.execPath, ['--expose-gc', HERE, '--child', JSON.stringify({ stack, ...options })], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const pending = new Map();
  let seq = 0;
  const ready = new Promise((resolve, reject) => {
    proc.on('message', msg => {
      if (msg.type === 'ready') resolve(msg);
      else if (msg.type === 'error') reject(msg.unavailable ? new ServerUnavailable(msg.message) : new Error(msg.message));
      else if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    });
    proc.once('exit', code => reject(new Error(`server process exited with code ${code}`)));
  });
  const { port } = await ready;
  const ask = type => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); proc.send({ type, id }); });
  let exitCode = null;
  proc.on('exit', code => { exitCode = code; });
  return {
    stack, port, base: `http://127.0.0.1:${port}`, realm: null, child: proc,
    get exitCode() { return exitCode; },
    memory: async () => (await ask('memory')).usage,
    metrics: async () => (await ask('metrics')).metrics,
    gc: async () => { await ask('gc'); },
    close: async () => {
      if (exitCode === null) { proc.send({ type: 'close' }); await Promise.race([new Promise(r => proc.once('exit', r)), sleep(5000)]); }
      if (exitCode === null) proc.kill();
    },
  };
}

/** A running table. */
export async function startTable({ stack = defaultStack(), players = 0, scene = null, child = false, names = [], ...options } = {}) {
  const server = await startServer({ stack, child, ...options });
  const table = { stack, server, port: server.port, base: server.base, players: [], gm: null, scene, identities: [], invite: null };
  const closers = [];
  table.addPlayer = options => addPlayerTo(table, options);
  table.close = async () => {
    for (const p of table.players) p.terminate();
    table.gm?.terminate();
    await sleep(30);
    for (const fn of closers) await fn();
    await server.close();
  };
  try {
    table.gm = await connectGm(server);
    if (stack === 'v3') table.invite = await fetchInvite(server);
    if (scene) table.gm.publish(scene);
    for (let i = 0; i < players; i += 1) await table.addPlayer({ name: names[i] ?? `Player ${i + 1}` });
    return table;
  } catch (error) {
    await table.close().catch(() => {});
    throw error;
  }
}

/** Attach to a table: admit and connect one more player. */
export async function addPlayerTo(table, options = {}) {
  const identity = table.stack === 'v3' ? await joinDevice(table.server, table.invite.invite, options) : { device: randomHex(16), dk: null, cookie: null };
  const p = await connectPlayer(table.server, identity, options);
  table.players.push(p);
  table.identities.push(identity);
  return p;
}

// ---------------------------------------------------------------------------------------------------------------------
// Static site (browser scripts)
// ---------------------------------------------------------------------------------------------------------------------

/** newest modification time under the folders/files that go into the build */
function newest(paths) {
  let time = 0;
  const walk = path => {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    if (stat.isDirectory()) for (const entry of readdirSync(path)) walk(join(path, entry));
    else time = Math.max(time, stat.mtimeMs);
  };
  paths.forEach(walk);
  return time;
}

/** Rebuild dist/ when the sources are newer than the build (the browser scripts test what the user will run). */
export async function ensureBuilt({ log = console.log } = {}) {
  const dist = join(ROOT, 'dist/index.html');
  const sources = ['src', 'index.html', 'player.html', 'vite.config.js', 'public'].map(p => join(ROOT, p));
  if (existsSync(dist) && statSync(dist).mtimeMs >= newest(sources)) return false;
  log('dist/ is older than the sources: running "vite build" (this takes a moment)');
  await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: ROOT, stdio: 'inherit' });
    proc.on('exit', code => (code === 0 ? resolve() : reject(new Error(`vite build failed (exit ${code})`))));
  });
  return true;
}

/** The built site + realm on a free port, for the Edge scripts. Uses the project's own production server. */
export async function startSiteServer({ host = '0.0.0.0', port = 0, dataDir = null } = {}) {
  const candidates = ['server/net/serve.js', 'server/serve.js'].filter(f => existsSync(join(ROOT, f)));
  if (stackAvailability().v3) throw new ServerUnavailable(`new stack: ${stackAvailability().v3}`);
  for (const file of candidates) {
    const mod = await import(pathToFileURL(join(ROOT, file)).href);
    const started = await mod.startProductionServer({ port, root: join(ROOT, 'dist'), host, dataDir, quiet: true });
    if (started?.port) return { port: started.port, base: `http://127.0.0.1:${started.port}`, stack: 'v3', server: started, close: () => started.close() };
  }
  throw new ServerUnavailable('no production server with the new interface (server/net/serve.js)');
}

// ---------------------------------------------------------------------------------------------------------------------
// Child entry: `node test-support/table.js --child '{"stack":"v3",...}'`
// ---------------------------------------------------------------------------------------------------------------------

if (process.argv[2] === '--child' && process.send) {
  const options = JSON.parse(process.argv[3] ?? '{}');
  try {
    const booted = await bootInProcess(options);
    // CPU use and event-loop delay since the server booted, for the stress test
    const loop = monitorEventLoopDelay({ resolution: 5 });
    loop.enable();
    const cpuAtStart = process.cpuUsage();
    const loopStartedAt = performance.now();
    process.on('message', async msg => {
      if (msg.type === 'memory') process.send({ id: msg.id, usage: process.memoryUsage() });
      else if (msg.type === 'metrics') {
        const wall = (performance.now() - loopStartedAt) / 1000;
        const cpu = process.cpuUsage(cpuAtStart);
        process.send({ id: msg.id, metrics: { cpuPercent: Math.round(((cpu.user + cpu.system) / 1e6 / wall) * 1000) / 10, loop: { mean: loop.mean / 1e6, p50: loop.percentile(50) / 1e6, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 } } });
      }
      else if (msg.type === 'gc') { globalThis.gc?.(); process.send({ id: msg.id }); }
      else if (msg.type === 'close') { await booted.close().catch(() => {}); process.exit(0); }
    });
    process.on('uncaughtException', error => { console.error('server child: uncaught exception', error); process.exit(70); });
    process.on('unhandledRejection', error => { console.error('server child: unhandled rejection', error); process.exit(71); });
    process.send({ type: 'ready', port: booted.port });
  } catch (error) {
    process.send({ type: 'error', message: error.message, unavailable: error instanceof ServerUnavailable });
    process.exit(1);
  }
}
