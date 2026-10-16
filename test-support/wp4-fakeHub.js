// A tiny in-process stand-in for the real hub, written ONLY from design 4.3 - 4.6 and Appendix A (not from any server code),
// so that the client packages (connection, joinClient, gmLink, playerLink, facade) can be tested end to end before the real
// hub exists. It speaks the protocol over fake sockets and a fake fetch: no ports, no HTTP, no ws.
//
//   const hub = createFakeHub();
//   hub.WebSocketClass   give to links as transportOptions.WebSocketClass
//   hub.fetchImpl        give to links as transportOptions.fetchImpl (answers /hello, /join and /assets; data: URLs go to real fetch)
//   hub.url              give to links as transportOptions.url
//
// What it implements: POST /hello (one-time 15 s nonces) and /join (link and code proofs, srvProof, dk, admit modes), the
// upgrade check (players: rf3 + auth.* proof; GM: rf3 only), HELLO / RESUME / GM_STATUS / STATE_FULL / STATE_PATCH with a
// 64-patch history and resume, ACK with idempotent replay by aid, PONG, the owner / paused / fog / away rules for moves and
// end-turn, the ping cooldown, roster, JOIN_REQUEST / TABLE, TABLE_CMD (kick admit deny lock unlock rotate mode rename), the
// GM slot (a second GM replaces the first with 4001) and the asset endpoints (X-RF required, quota -> 507).
// It is deliberately NOT a copy of the real rules engine; the real hub tests live in test/hub.*.test.js.
import { createHash } from 'node:crypto';
import { PATHS, CLOSE, LIMITS, PROTOCOL_VERSION, SUBPROTOCOL, parseAuthProtocol, cleanName, isHex } from '../src/net/protocol.js';
import { wsProof, joinProof, srvProof, deriveDk, inviteKey, randomHex, randomSecret, randomCode, safeEqualHex, playerIdOf, normalizeCode } from '../src/net/hmac.js';
import { projectForPlayers } from '../src/playerView.js';
import { diffState } from '../src/syncPatch.js';
import { canPlayerMoveToken } from '../src/ownership.js';

const OPEN = 1, CLOSED = 3;
const realFetch = globalThis.fetch;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonResponse = (status, body = {}) => ({
  ok: status >= 200 && status < 300, status, headers: new Map(),
  json: async () => JSON.parse(JSON.stringify(body)), text: async () => JSON.stringify(body),
});

export function createFakeHub({
  url = 'http://table.test:5173', mode = 'open', maxDevices = 16, maxScene = 8 * 1024 * 1024, assetQuota = Infinity,
  now = () => Date.now(), resumeWaitMs = LIMITS.resumeWaitMs, label = 'Fake · Test', gmAllowed = true,
} = {}) {
  const started = now();
  const serverSecret = randomHex(32);
  const serverId = randomHex(4);
  const invite = { secret: randomSecret(), code: randomCode() };
  const devices = new Map();   // device -> { dk, status:'admitted'|'pending'|'revoked', name, actions: Map(aid -> ack), memory }
  const nonces = new Map();    // nonce -> { device, at }
  const sessions = new Set();  // server-side sessions (players and the GM)
  const assets = new Map();    // hash -> bytes
  const upgrades = [];         // { role, protocols, ok, why }
  const received = [];         // every frame a client sent: { role, device, message }
  const sentToPlayers = [];    // every text frame sent to a player: { device, text }
  let table = { mode, locked: mode === 'locked', code: invite.code };
  let gm = null;
  let scene = null;
  let view = null;
  let rev = Math.floor(Math.random() * 1e6) + 100;
  let history = [];
  let rosterTimer = null;
  const faults = { helloStatus: [], upgradeClose: [], rogue: false, outage: false };

  const hub = {
    url, serverId, invite, devices, sessions, assets, upgrades, received, sentToPlayers, faults, fake: true,
    get view() { return view; },
    get scene() { return scene; },
    get rev() { return rev; },
    get table() { return { ...table }; },
    get historyLength() { return history.length; },
    gm: () => gm,
    players: () => [...sessions].filter(session => session.role === 'player' && session.open),
    sessionsOf: device => [...sessions].filter(session => session.device === device),
    framesTo: device => sentToPlayers.filter(entry => entry.device === device).map(entry => JSON.parse(entry.text)),
    receivedOf: type => received.filter(entry => entry.message?.type === type),

    // ── test controls ────────────────────────────────────────────────────────
    setMode(next) { table.mode = next; table.locked = next === 'locked'; tellGm(); },
    lock() { hub.setMode('locked'); },
    rotate() { invite.secret = randomSecret(); invite.code = randomCode(); table.code = invite.code; tellGm(); },
    admit(device) { admitDevice(device); },
    deny(device) {
      const record = devices.get(device);
      if (!record) return;
      devices.delete(device);
      for (const session of hub.sessionsOf(device)) { session.send({ type: 'DENIED' }); session.close(CLOSE.NOT_ADMITTED); }
    },
    kick(device) {
      const record = devices.get(device);
      if (!record) return;
      record.status = 'revoked';
      record.dk = null;
      for (const session of hub.sessionsOf(device)) { session.send({ type: 'KICKED', reason: 'removed by the GM' }); session.close(CLOSE.KICKED); }
      rosterSoon();
    },
    /** Close every socket from the server side with `code` (1006 = the wire just died). */
    closeAll(code = 1006, role) { for (const session of [...sessions]) if (!role || session.role === role) session.close(code); },
    /** Next `count` upgrades are accepted and then closed with `code` (4011 = proof refused). */
    refuseUpgrades(count, code = CLOSE.AUTH) { faults.upgradeClose = Array(count).fill(code); },
    /** Next `count` POST /hello answer with this HTTP status. */
    failHello(count, status = 500) { faults.helloStatus = Array(count).fill(status); },
    /** While true every player upgrade fails before a socket exists (the Wi-Fi is down); the GM is unaffected. */
    setOutage(value = true) { faults.outage = value; },
    /** From now on the server answers /join with a wrong srvProof (a rogue access point). */
    setRogue(value = true) { faults.rogue = value; },
    setScene(next) { setScene(next); },
    close() { for (const session of [...sessions]) session.close(1001); clearTimeout(rosterTimer); },
  };

  // ── sending ────────────────────────────────────────────────────────────────
  function deliver(socket, fn) { setTimeout(() => { if (socket.readyState === OPEN) fn(); }, 0); }

  function makeSession(socket, role, device) {
    const session = {
      socket, role, device, open: true, resumed: false, rtt: null, resumeTimer: null,
      playerId: device ? playerIdOf(serverSecret, device) : 'gm',
      send(object) {
        const text = typeof object === 'string' ? object : JSON.stringify(object);
        if (role === 'player') sentToPlayers.push({ device, text });
        deliver(socket, () => socket.onmessage?.({ data: text }));
        return true;
      },
      close(code = 1000, reason = '') {
        if (!session.open) return;
        session.open = false;
        clearTimeout(session.resumeTimer);
        sessions.delete(session);
        setTimeout(() => {
          if (socket.readyState === CLOSED) return;
          socket.readyState = CLOSED;
          socket.onclose?.({ code, reason, wasClean: code !== 1006 });
        }, 0);
        if (session === gm) { gm = null; for (const player of hub.players()) player.send({ type: 'GM_STATUS', connected: false }); }
        rosterSoon();
      },
    };
    sessions.add(session);
    return session;
  }

  // ── state ──────────────────────────────────────────────────────────────────
  function sendFull(session) { session.send({ type: 'STATE_FULL', rev, state: view }); session.syncedRev = rev; }

  function publish(next) {
    const first = view === null;
    const patch = first ? null : diffState(view, next);
    view = next;
    if (!first && !patch) return;
    rev += 1;
    if (first) { history = []; for (const player of hub.players()) if (player.resumed) sendFull(player); return; }
    const message = { type: 'STATE_PATCH', rev, base: rev - 1, patch };
    history.push(message);
    if (history.length > LIMITS.patchHistory) history.shift();
    for (const player of hub.players()) {
      if (!player.resumed) continue;
      if (player.syncedRev === rev - 1) { player.send(message); player.syncedRev = rev; } else sendFull(player);
    }
  }

  function setScene(next) { scene = next; publish(projectForPlayers(next)); }

  function sendState(session, resumeRev) {
    if (!view) return;
    const behind = Number.isFinite(resumeRev) ? rev - resumeRev : null;
    if (behind === 0) { session.syncedRev = rev; return; }
    const chain = behind > 0 && behind <= LIMITS.resumeMaxPatches ? history.filter(item => item.rev > resumeRev) : null;
    if (chain && chain.length === behind && chain[0].base === resumeRev) {
      for (const item of chain) session.send(item);
      session.syncedRev = rev;
    } else sendFull(session);
  }

  function tellGm() {
    gm?.send({ type: 'TABLE', ...table });
  }
  function rosterSoon() {
    if (rosterTimer) return;
    rosterTimer = setTimeout(() => {
      rosterTimer = null;
      const byId = new Map();
      for (const session of hub.players()) {
        const record = devices.get(session.device);
        const known = byId.get(session.playerId)?.rtt ?? null;
        byId.set(session.playerId, {
          id: session.playerId, name: record?.name || label, device: label,
          rtt: known === null ? session.rtt : session.rtt === null ? known : Math.min(known, session.rtt),
          online: true, admitted: true, audio: 'off',
        });
      }
      gm?.send({ type: 'PLAYER_ROSTER', players: [...byId.values()] });
    }, 15);
  }

  // ── admission ──────────────────────────────────────────────────────────────
  function admitDevice(device) {
    const record = devices.get(device);
    if (!record || record.status !== 'pending') return;
    record.status = 'admitted';
    for (const session of hub.sessionsOf(device)) { session.send({ type: 'ADMITTED' }); hello(session); }
    rosterSoon();
  }

  function hello(session) {
    session.send({
      type: 'HELLO', v: PROTOCOL_VERSION, role: session.role, playerId: session.playerId,
      name: session.role === 'player' ? devices.get(session.device)?.name ?? '' : undefined,
      rev, server: { id: serverId, started }, limits: { maxScene },
    });
    session.resumeTimer = setTimeout(() => afterResume(session, { rev: null, aids: [] }), resumeWaitMs);
    session.resumeTimer.unref?.();
  }

  function afterResume(session, message) {
    if (session.resumed || !session.open) return;
    clearTimeout(session.resumeTimer);
    session.resumed = true;
    if (session.role === 'gm') return;
    session.send({ type: 'GM_STATUS', connected: !!gm });
    sendState(session, message.rev);
    const record = devices.get(session.device);
    for (const aid of Array.isArray(message.aids) ? message.aids : []) {
      if (record?.actions.has(aid)) session.send({ type: 'ACK', aid, ...record.actions.get(aid) });
    }
    rosterSoon();
  }

  // ── messages ───────────────────────────────────────────────────────────────
  const onMap = (value, size) => Math.max(0, Math.min(value, Number(size) || value));
  function remember(record, aid, result) {
    record.actions.set(aid, result);
    if (record.actions.size > LIMITS.actionMemory) record.actions.delete(record.actions.keys().next().value);
  }

  function fromPlayer(session, message) {
    const record = devices.get(session.device);
    if (!record || record.status !== 'admitted') return;
    switch (message.type) {
      case 'PING':
        session.send({ type: 'PONG', t: message.t, s: now() });
        if (Number.isFinite(message.rtt)) { const first = session.rtt === null; session.rtt = Math.round(message.rtt); if (first) rosterSoon(); }
        break;
      case 'RESUME': afterResume(session, message); break;
      case 'RESYNC': case 'REQUEST_FULL_STATE': if (view) sendFull(session); break;
      case 'PLAYER_NAME':
        if (typeof message.name === 'string') { record.name = cleanName(message.name); rosterSoon(); }
        break;
      case 'PLAYER_TOKEN_MOVE': {
        if (typeof message.aid === 'string' && record.actions.has(message.aid)) { session.send({ type: 'ACK', aid: message.aid, ...record.actions.get(message.aid) }); break; }
        let result;
        const token = scene?.tokens?.find(item => item.id === message.id);
        if (typeof message.id !== 'string' || !Number.isFinite(message.x) || !Number.isFinite(message.y)) result = { ok: false, reason: 'invalid' };
        else if (!token || token.ownerId !== session.playerId) result = { ok: false, reason: 'blocked' };
        else if (!gm) result = { ok: false, reason: 'away' };
        else if (scene.playerCanMoveTokens === false) result = { ok: false, reason: 'paused' };
        else if (!canPlayerMoveToken(scene, token, session.playerId)) result = { ok: false, reason: 'blocked' };
        else {
          const x = onMap(message.x, scene.mapWidth), y = onMap(message.y, scene.mapHeight);
          gm.send({ type: 'PLAYER_TOKEN_MOVE', playerId: session.playerId, id: token.id, x, y });
          token.x = x; token.y = y;
          publish(projectForPlayers(scene));
          result = { ok: true };
        }
        if (typeof message.aid === 'string') { remember(record, message.aid, result); session.send({ type: 'ACK', aid: message.aid, ...result }); }
        break;
      }
      case 'PLAYER_PING': {
        if (!scene || !Number.isFinite(message.x) || !Number.isFinite(message.y)) break;
        const at = now();
        if (record.memory.lastPing !== undefined && at - record.memory.lastPing < 700) break;
        record.memory.lastPing = at;
        const ping = { type: 'MAP_PING', id: session.playerId, name: record.name || label, x: onMap(message.x, scene.mapWidth), y: onMap(message.y, scene.mapHeight) };
        for (const player of hub.players()) player.send(ping);
        gm?.send(ping);
        break;
      }
      case 'PLAYER_END_TURN': {
        if (typeof message.aid === 'string' && record.actions.has(message.aid)) { session.send({ type: 'ACK', aid: message.aid, ...record.actions.get(message.aid) }); break; }
        const token = scene?.tokens?.find(item => item.id === message.tokenId);
        let result = { ok: true };
        if (!gm) result = { ok: false, reason: 'away' };
        else if (!token || token.ownerId !== session.playerId || scene.combat?.activeId !== token.id) result = { ok: false, reason: 'not-your-turn' };
        else {
          const at = now();
          const last = record.memory.lastEndTurn;
          if (!(last?.id === token.id && at - last.at < 1500)) {
            record.memory.lastEndTurn = { id: token.id, at };
            gm.send({ type: 'PLAYER_END_TURN', playerId: session.playerId, tokenId: token.id, name: token.name || '' });
          }
        }
        if (typeof message.aid === 'string') remember(record, message.aid, result);
        session.send({ type: 'ACK', aid: message.aid, ...result });
        break;
      }
      default: hub.strikes = (hub.strikes ?? 0) + 1;
    }
  }

  function fromGm(session, message) {
    switch (message.type) {
      case 'PING': session.send({ type: 'PONG', t: message.t, s: now() }); break;
      case 'RESUME': afterResume(session, message); break;
      case 'SCENE': if (message.scene && typeof message.scene === 'object') setScene(message.scene); break;
      case 'TABLE_CMD': {
        const { op } = message;
        if (op === 'kick') hub.kick(message.device);
        else if (op === 'admit') admitDevice(message.device);
        else if (op === 'deny') hub.deny(message.device);
        else if (op === 'lock') hub.setMode('locked');
        else if (op === 'unlock') hub.setMode('open');
        else if (op === 'mode') hub.setMode(message.mode);
        else if (op === 'rotate') hub.rotate();
        else if (op === 'rename') { const record = devices.get(message.device); if (record) { record.name = cleanName(message.name); rosterSoon(); } }
        break;
      }
      default: hub.strikes = (hub.strikes ?? 0) + 1;
    }
  }

  // ── the upgrade (design 4.3 step 3) ────────────────────────────────────────
  function upgrade(socket) {
    const target = new URL(socket.url);
    const role = target.searchParams.get('role');
    const protocols = socket.protocols;
    const entry = { role, protocols: [...protocols], ok: false, why: '' };
    upgrades.push(entry);
    const refuse = why => {
      entry.why = why;
      socket.readyState = CLOSED;
      socket.onerror?.({ type: 'error' });
      socket.onclose?.({ code: 1006, reason: '', wasClean: false });
    };
    if (socket.readyState === CLOSED) return;
    if (target.pathname !== PATHS.ws) return refuse('path');
    if (!protocols.includes(SUBPROTOCOL)) return refuse('subprotocol');
    let device = null;
    if (role === 'gm') {
      if (!gmAllowed || protocols.length !== 1) return refuse('gm-auth');
    } else if (role === 'player') {
      if (faults.outage) return refuse('outage');
      const auth = parseAuthProtocol(protocols);
      if (!auth) return refuse('no-auth');
      const issued = nonces.get(auth.nonce);
      nonces.delete(auth.nonce);                               // single use
      if (!issued || issued.device !== auth.device || now() - issued.at > LIMITS.nonceTtlMs) return refuse('nonce');
      const record = devices.get(auth.device);
      if (!record || record.status === 'revoked' || !record.dk) return refuse('device');
      if (!safeEqualHex(wsProof(record.dk, auth.device, auth.nonce, 'player'), auth.proof)) return refuse('proof');
      device = auth.device;
    } else return refuse('role');
    entry.ok = true;
    socket.readyState = OPEN;
    socket.protocol = SUBPROTOCOL;
    const session = makeSession(socket, role, device);
    socket.session = session;
    socket.onopen?.({ type: 'open' });
    if (faults.upgradeClose.length) { session.close(faults.upgradeClose.shift()); return; }

    if (role === 'gm') {
      const previous = gm;
      gm = session;
      previous?.close(CLOSE.REPLACED, 'Another GM window took over');
      hello(session);
      session.send({ type: 'REQUEST_FULL_STATE' });
      tellGm();
      for (const [id, record] of devices) if (record.status === 'pending') session.send({ type: 'JOIN_REQUEST', device: id, name: record.name, label });
      for (const player of hub.players()) player.send({ type: 'GM_STATUS', connected: true });
      rosterSoon();
    } else if (devices.get(device).status === 'pending') {
      session.send({ type: 'WAIT' });
    } else hello(session);
  }

  // ── client-side socket class ───────────────────────────────────────────────
  class FakeHubSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    static instances = [];
    constructor(address, protocols = []) {
      this.url = String(address);
      this.protocols = Array.isArray(protocols) ? protocols : [protocols];
      this.readyState = 0;
      this.protocol = '';
      this.bufferedAmount = 0;
      this.binaryType = 'blob';
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      FakeHubSocket.instances.push(this);
      setTimeout(() => upgrade(this), 0);
    }
    send(data) {
      if (this.readyState !== OPEN) throw new Error('InvalidStateError');
      const session = this.session;
      setTimeout(() => {
        if (!session.open) return;
        let message;
        try { message = JSON.parse(data); } catch { return; }
        received.push({ role: session.role, device: session.device, message });
        try { (session.role === 'gm' ? fromGm : fromPlayer)(session, message); } catch (error) { hub.handlerErrors = [...(hub.handlerErrors ?? []), error]; }
      }, 0);
    }
    close(code = 1005, reason = '') {
      if (this.readyState === CLOSED || this.readyState === 2) return;
      if (this.readyState === 0) { this.readyState = CLOSED; this.onclose?.({ code, reason, wasClean: true }); return; }
      this.readyState = CLOSED;
      this.session?.close(code, reason);
      this.onclose?.({ code, reason, wasClean: true });
    }
    terminate() { this.close(1006); }
  }
  hub.WebSocketClass = FakeHubSocket;

  // ── fetch ──────────────────────────────────────────────────────────────────
  hub.fetchImpl = async (input, init = {}) => {
    const address = String(input?.url ?? input);
    if (address.startsWith('data:') || address.startsWith('blob:')) return realFetch(input, init);
    const target = new URL(address, url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers ?? {});
    await new Promise(resolve => setTimeout(resolve, 0));

    if (target.pathname === PATHS.hello && method === 'POST') {
      if (faults.helloStatus.length) return jsonResponse(faults.helloStatus.shift(), { error: 'fault' });
      const body = JSON.parse(init.body);
      if (!isHex(body?.device, 16)) return jsonResponse(400, { error: 'bad-request' });
      const nonce = randomHex(16);
      nonces.set(nonce, { device: body.device, at: now() });
      return jsonResponse(200, { nonce, ttl: 15 });
    }

    if (target.pathname === PATHS.join && method === 'POST') {
      const body = JSON.parse(init.body);
      hub.joins = (hub.joins ?? 0) + 1;
      hub.lastJoin = body;
      const { device, nonce, how } = body ?? {};
      if (body?.v !== PROTOCOL_VERSION || !isHex(device, 16) || !isHex(nonce, 16)) return jsonResponse(400, { error: 'bad-request' });
      const key = how === 'link' ? inviteKey('link', invite.secret) : how === 'code' ? inviteKey('code', invite.code) : null;
      if (!key || !safeEqualHex(joinProof(key, device, nonce), body.proof)) return jsonResponse(403, { error: 'bad-proof' });
      let record = devices.get(device);
      if (record?.status === 'revoked') return jsonResponse(403, { error: 'bad-proof' });
      if (!record) {
        if (table.locked) return jsonResponse(403, { error: 'locked' });
        if ([...devices.values()].filter(item => item.status !== 'revoked').length >= maxDevices) return jsonResponse(403, { error: 'full' });
        record = { status: table.mode === 'ask' ? 'pending' : 'admitted', name: cleanName(body.name), actions: new Map(), memory: {} };
        devices.set(device, record);
        if (record.status === 'pending') gm?.send({ type: 'JOIN_REQUEST', device, name: record.name, label });
      }
      const srv = randomHex(16);
      record.dk = deriveDk(key, device, nonce, srv);
      return jsonResponse(200, {
        status: record.status, srv,
        srvProof: faults.rogue ? randomHex(32) : srvProof(key, device, nonce, srv),
      });
    }

    if (target.pathname.startsWith(PATHS.assets)) {
      const rest = target.pathname.slice(PATHS.assets.length);
      const gmHeaders = headers.get('x-rf') === '1';
      if (method === 'POST' && rest === 'missing') {
        if (!gmHeaders) return jsonResponse(403, {});
        const wanted = JSON.parse(init.body);
        return jsonResponse(200, wanted.filter(hash => !assets.has(hash)));
      }
      if (method === 'PUT') {
        if (!gmHeaders) return jsonResponse(403, {});
        const bytes = Buffer.from(await new Response(init.body).arrayBuffer());
        if (sha256(bytes) !== rest) return jsonResponse(400, {});
        const total = [...assets.values()].reduce((sum, item) => sum + item.length, 0);
        if (total + bytes.length > assetQuota) return jsonResponse(507, {});
        assets.set(rest, bytes);
        return jsonResponse(201, {});
      }
      if (method === 'GET') return assets.has(rest) ? jsonResponse(200, {}) : jsonResponse(404, {});
    }
    return jsonResponse(404, {});
  };

  hub.normalizeCode = normalizeCode;
  return hub;
}
