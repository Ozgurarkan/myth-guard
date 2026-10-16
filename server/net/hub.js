// The table's hub: one GM, many players, one server on the GM's computer (design 4.5 - 4.7, 4.11, 4.13).
//
//   HTTP upgrade -> access.authenticateUpgrade (nobody gets a WebSocket without passing it)
//                -> a Session per socket -> validateFrame -> rate buckets -> handlers
//   GM     --SCENE-->  stateSync (project, diff, history) --STATE_FULL / STATE_PATCH--> players
//   player --PLAYER_TOKEN_MOVE / PLAYER_END_TURN--> actions (rules) --> GM, and the optimistic move --> everyone
//   player --PLAYER_PING--> MAP_PING to everyone and the GM
//
// Access control (who may connect, the device registry, admission modes) belongs to `access` (WP2); audio signalling
// plugs in through `extend` / `upgradeAudio` (WP5). This file knows nothing about either beyond those interfaces.
import { WebSocketServer } from 'ws';
import {
  PATHS, CLOSE, LIMITS, TYPE_CAPS, PROTOCOL_VERSION, SUBPROTOCOL, ACK_REASONS, isHex, cleanName,
} from '../../src/net/protocol.js';
import { randomHex } from '../../src/net/hmac.js';
import { validateFrame } from './validate.js';
import { createSession, timers, safeMetrics } from './session.js';
import { createStateSync } from './stateSync.js';
import { createRoster } from './roster.js';
import { moveToken, mapPing, endTurn, createMemory } from './actions.js';

export const LEGACY_PATH = '/session-sync';
export const LEGACY_MESSAGE = 'Myth Guard was updated. Reload this page.';

const STATUS_TEXT = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 421: 'Misdirected Request',
  426: 'Upgrade Required', 429: 'Too Many Requests', 503: 'Service Unavailable',
};
const MEMORY_DEVICES = 256; // per-device action memories kept (devices are few; this only bounds a hostile registry)
const TICK_MS = 250;
const GRACE_MS = 1000;      // after close(), sockets that have not finished the handshake are terminated

const deflate = () => ({
  threshold: 1024,
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
  zlibDeflateOptions: { level: 3, memLevel: 7 },
  concurrencyLimit: 2,
});

const cleanIp = value => String(value ?? '').replace(/^::ffff:/, '');
const noop = () => {};

/** Refuse an upgrade with a bare status line: no body, and no hint which check failed. */
function refuse(socket, status) {
  try {
    socket.on('error', noop);
    if (socket.writable) {
      socket.write(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  } catch { /* the peer is gone */ }
  try { socket.destroy(); } catch { /* gone */ }
}

function textOf(raw) {
  if (typeof raw === 'string') return { body: raw, bytes: Buffer.byteLength(raw) };
  let buffer;
  if (Buffer.isBuffer(raw)) buffer = raw;
  else if (Array.isArray(raw)) buffer = Buffer.concat(raw);
  else if (raw instanceof ArrayBuffer) buffer = Buffer.from(raw);
  else if (ArrayBuffer.isView(raw)) buffer = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  else return null;
  return { body: buffer.toString('utf8'), bytes: buffer.length };
}

/**
 * @param {object} options
 * @param {object} options.access      WP2's access object (design 7.2)
 * @param {object} [options.metrics]   defaults to access.metrics
 * @param {object} [options.clock]     { now, setTimeout, clearTimeout, setInterval, clearInterval }
 * @param {Array<object>} [options.extensions]  objects shaped like the argument of `extend`
 * @param {object} [options.limits]    LIMITS overrides (tests shorten times)
 * @param {number} [options.revBase]   first revision (tests); default is random so restarts never collide
 */
export function createHub({ access, metrics, clock, extensions = [], limits: limitOverrides, caps = TYPE_CAPS, revBase } = {}) {
  if (!access) throw new TypeError('createHub: `access` is required');
  const limits = { ...LIMITS, ...(limitOverrides ?? {}) };
  const t = timers(clock);
  const m = safeMetrics(metrics ?? access.metrics);
  const started = t.now();
  const serverId = randomHex(8);

  const stateSync = createStateSync({ clock, limits, metrics: m, revBase });
  const handleProtocols = protocols => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false);
  const wssPlayer = new WebSocketServer({ noServer: true, handleProtocols, maxPayload: limits.playerMaxPayload, perMessageDeflate: deflate() });
  const wssGm = new WebSocketServer({ noServer: true, handleProtocols, maxPayload: limits.gmMaxPayload, perMessageDeflate: deflate() });
  const wssAudio = new WebSocketServer({ noServer: true, handleProtocols, maxPayload: limits.audioMaxPayload, perMessageDeflate: false });
  const wssRefuse = new WebSocketServer({ noServer: true, handleProtocols, maxPayload: 1024, perMessageDeflate: false }); // only ever closes

  const sessions = new Set();     // every open Session (players, pending players, the GM)
  const byDevice = new Map();     // device -> Set<Session>
  const audioSockets = new Set(); // raw sockets of /__realm/audio (their handler is WP5's)
  const memory = new Map();       // device -> { acks: Map, actions: createMemory() }
  const hooks = { open: [], close: [], gmChange: [] };
  const typeHandlers = { player: new Map(), gm: new Map() };
  const extraTypes = { player: new Set(), gm: new Set() };
  const disposers = [];
  let rosterAudio = null;
  let audioHandler = null;
  let gm = null;
  let closing = false;
  let closePromise = null;
  let whenEmpty = null;

  const guard = (label, fn) => (...args) => {
    try { return fn(...args); } catch (error) { m.inc('handlerErrors'); m.log(`${label}: ${error?.stack ?? error}`); return undefined; }
  };
  const gmPresent = () => Boolean(gm?.isOpen);
  const players = () => [...sessions].filter(s => s.role === 'player' && !s.pending && s.isOpen);
  const sendGm = obj => (gm?.isOpen ? gm.sendJson(obj) : false);
  const keyOf = s => s.device ?? `session-${s.id}`;

  // ── Roster ───────────────────────────────────────────────────────────────────
  const roster = createRoster({
    clock,
    metrics: m,
    sessions: () => [...sessions].filter(s => s.role === 'player'),
    registry: () => access.table?.list?.() ?? [],
    audioOf: device => (rosterAudio ? rosterAudio(device) : null),
    sendToGm: sendGm,
  });

  // ── Per-device memory: action ids already answered, ping and end-turn guards ───────────────────────────────────
  function memoryOf(key) {
    let entry = memory.get(key);
    if (!entry) {
      entry = { acks: new Map(), actions: createMemory() };
      memory.set(key, entry);
      while (memory.size > MEMORY_DEVICES) memory.delete(memory.keys().next().value);
    }
    return entry;
  }
  function remember(entry, aid, ack) {
    entry.acks.set(String(aid), ack);
    while (entry.acks.size > limits.actionMemory) entry.acks.delete(entry.acks.keys().next().value);
  }

  // ── Sending ──────────────────────────────────────────────────────────────────
  function sendTo(device, obj) {
    let sent = 0;
    for (const s of byDevice.get(device) ?? []) {
      if (s.pending || !s.isOpen || s.bufferedAmount > limits.backlogStopBytes) continue;
      if (s.sendJson(obj)) sent += 1;
    }
    return sent;
  }
  function broadcastPlayers(obj, { droppable = false } = {}) {
    const text = JSON.stringify(obj);
    for (const s of players()) {
      if (droppable && s.bufferedAmount > limits.backlogStopBytes) { s.dropped += 1; continue; }
      s.send(text);
    }
  }
  const gmStatusMessage = () => ({ type: 'GM_STATUS', connected: gmPresent() });

  // ── Table (admission) ────────────────────────────────────────────────────────
  function tableMessage() {
    const table = access.table;
    let code = null;
    try { code = table?.invite?.()?.code ?? null; } catch { /* no invite yet */ }
    return { type: 'TABLE', mode: table?.mode?.() ?? 'open', locked: Boolean(table?.locked?.()), code };
  }
  const sendTable = () => sendGm(tableMessage());

  function deviceOfPlayerId(id) {
    for (const s of sessions) if (s.playerId === id && s.device) return s.device;
    try { return access.table?.list?.().find(entry => entry.playerId === id)?.device ?? null; } catch { return null; }
  }

  function kickSession(s) {
    s.sendJson({ type: 'KICKED' });
    s.close(CLOSE.KICKED, 'Removed from the table');
  }
  function denySession(s) {
    s.sendJson({ type: 'DENIED' });
    s.close(CLOSE.NOT_ADMITTED, 'Not admitted');
  }
  function admitSession(s) {
    if (!s.pending) return;
    s.pending = false;
    s.sendJson({ type: 'ADMITTED' });
    beginResume(s);
    roster.soon();
  }

  /** Bring the live sockets in line with the device registry (kick, deny, admit happen in access; the sockets live here). */
  const reconcile = guard('reconcile', () => {
    let list;
    try { list = access.table?.list?.(); } catch { return; }
    if (!Array.isArray(list)) return;
    const known = new Map(list.map(entry => [entry.device, entry]));
    for (const s of [...sessions]) {
      if (s.role !== 'player' || !s.device || s.closed) continue;
      const entry = known.get(s.device);
      const status = entry?.status;
      if (!entry || status === 'revoked' || status === 'denied') {
        if (s.pending) denySession(s); else kickSession(s);
      } else if (s.pending && status === 'admitted') admitSession(s);
    }
    roster.soon();
    sendTable();
  });

  const tableCommand = guard('TABLE_CMD', msg => {
    const table = access.table;
    if (!table) return;
    let device = msg.device;
    if (device && isHex(device, 12)) device = deviceOfPlayerId(device) ?? undefined; // the roster shows playerIds
    switch (msg.op) {
      case 'kick':
        if (device) {
          table.kick(device);
          memory.delete(device);
          for (const s of [...(byDevice.get(device) ?? [])]) kickSession(s);
        }
        break;
      case 'admit': if (device) table.admit(device); break;
      case 'deny': if (device) table.deny(device); break;
      case 'lock': table.lock(); break;
      case 'unlock': table.unlock(); break;
      case 'rotate': table.rotate(); break;
      case 'mode': table.setMode(msg.mode); break;
      case 'rename':
        if (device) {
          table.rename(device, msg.name);
          for (const s of byDevice.get(device) ?? []) s.name = msg.name;
        }
        break;
      default: break;
    }
    reconcile();
  });

  // ── Resume handshake (4.5) ─────────────────────────────────────────────────────
  /** HELLO has been sent. Wait up to resumeWaitMs for RESUME, then serve state. */
  function beginResume(s) {
    s.awaitingResume = true;
    if (s.resumeReceived) { completeResume(s, s.resumeReceived.rev, s.resumeReceived.aids); return; }
    s.cancelResumeWait?.();
    s.cancelResumeWait = t.after(limits.resumeWaitMs, guard('resume-timeout', () => {
      s.cancelResumeWait = null;
      completeResume(s, null, []);
    }));
  }

  function completeResume(s, rev, aids) {
    s.cancelResumeWait?.();
    s.cancelResumeWait = null;
    if (!s.awaitingResume || s.closed || s.pending) return;
    s.awaitingResume = false;
    s.sendJson(gmStatusMessage());
    const outcome = stateSync.attach(s, rev);
    m.inc(`resume.${outcome}`);
    // Actions the phone is unsure about: answer every one we already processed (never applied twice).
    const entry = memory.get(keyOf(s));
    if (entry) for (const aid of aids) { const ack = entry.acks.get(String(aid)); if (ack) s.sendJson(ack); }
  }

  // ── Player messages ──────────────────────────────────────────────────────────
  function ackMessage(aid, result, extra) {
    const ack = { type: 'ACK', ok: result.ok === true, ...extra };
    if (aid !== undefined) ack.aid = aid;
    if (!result.ok && ACK_REASONS.has(result.reason)) ack.reason = result.reason;
    return ack;
  }

  /** Run an action with idempotency: an aid seen before is answered from memory and never applied twice. */
  function runAction(s, msg, extra, rule) {
    const entry = memoryOf(keyOf(s));
    if (msg.aid !== undefined) {
      const known = entry.acks.get(String(msg.aid));
      if (known) { s.sendJson(known); m.inc('actions.replayed'); return; }
    }
    const result = rule(entry.actions); // stateSync.scene flushes any queued scene first
    const ack = ackMessage(msg.aid, result.ack ?? { ok: true }, extra);
    if (msg.aid !== undefined) remember(entry, msg.aid, ack);
    if (result.toGm) sendGm(result.toGm);
    if (result.mutate) stateSync.mutate(result.mutate);
    if (msg.aid !== undefined || result.ack?.ok === false) s.sendJson(ack);
    m.inc(result.ack?.ok === false ? 'actions.rejected' : 'actions.accepted');
  }

  const PLAYER = {
    PING(s, msg) {
      s.sendJson({ type: 'PONG', t: msg.t, s: t.now() });
      if (msg.rtt !== undefined && msg.rtt >= 0) {
        const rtt = Math.round(Math.min(msg.rtt, 9999));
        if (s.rtt === null || Math.abs(rtt - s.rtt) >= 20) roster.soon(1000);
        s.rtt = rtt;
      }
      if (msg.loss !== undefined) s.loss = msg.loss;
    },
    RESUME(s, msg) {
      s.resumeReceived = { rev: msg.rev, aids: msg.aids };
      if (s.awaitingResume) completeResume(s, msg.rev, msg.aids);
    },
    RESYNC(s) { stateSync.requestFull(s); },
    REQUEST_FULL_STATE(s) { stateSync.requestFull(s); },
    PLAYER_NAME(s, msg) {
      const name = cleanName(msg.name, limits.nameMax);
      const changed = name !== s.name;
      for (const other of byDevice.get(s.device) ?? [s]) other.name = name;
      if (changed) {
        try { access.table?.rename?.(s.device, name); } catch { /* the registry may refuse; the name still shows */ }
        roster.soon();
      }
    },
    PLAYER_TOKEN_MOVE(s, msg) {
      runAction(s, msg, { action: 'move', id: msg.id }, () => moveToken({ scene: stateSync.scene, actor: s, msg, gmPresent: gmPresent() }));
    },
    PLAYER_PING(s, msg) {
      const entry = memoryOf(keyOf(s));
      if (msg.aid !== undefined) {
        if (entry.acks.has(String(msg.aid))) { m.inc('actions.replayed'); return; }
        remember(entry, msg.aid, { type: 'ACK', aid: msg.aid, ok: true, action: 'ping' });
      }
      const result = mapPing({ scene: stateSync.scene, actor: s, msg, memory: entry.actions, now: t.now() });
      if (!result) return;
      broadcastPlayers(result.ping, { droppable: true });
      sendGm(result.ping);
    },
    PLAYER_END_TURN(s, msg) {
      runAction(s, msg, { action: 'end-turn', id: msg.tokenId }, memoryOfActions => endTurn({
        scene: stateSync.scene, actor: s, msg, gmPresent: gmPresent(), memory: memoryOfActions, now: t.now(),
      }));
    },
  };

  const GM = {
    PING(s, msg) { s.sendJson({ type: 'PONG', t: msg.t, s: t.now() }); },
    RESUME() { /* the GM does not resume: it is sent REQUEST_FULL_STATE instead */ },
    SCENE(s, msg) { stateSync.setScene(msg.scene, { defer: true }); },
    TABLE_CMD(s, msg) { tableCommand(msg); },
  };

  function dispatch(s, msg) {
    const type = msg.type;
    if (s.role === 'gm') {
      if (s !== gm) return; // a replaced window is on its way out
      if (Object.hasOwn(GM, type)) { GM[type](s, msg); return; }
      for (const handler of typeHandlers.gm.get(type) ?? []) handler(s, msg);
      return;
    }
    if (s.pending) {
      // Waiting to be let in: the connection stays alive, nothing else is served.
      if (type === 'PING') PLAYER.PING(s, msg);
      else if (type === 'RESUME') s.resumeReceived = { rev: msg.rev, aids: msg.aids };
      return;
    }
    if (Object.hasOwn(PLAYER, type)) { PLAYER[type](s, msg); return; }
    for (const handler of typeHandlers.player.get(type) ?? []) handler(s, msg);
  }

  function onMessage(s, raw, isBinary) {
    if (s.closed) return;
    s.touch();
    if (isBinary) {
      m.inc('reject.binary');
      s.close(CLOSE.UNSUPPORTED_DATA, 'Binary frames are not allowed');
      return;
    }
    const frame = textOf(raw);
    if (!frame) { s.violation('malformed'); return; }
    s.msgsIn += 1;
    s.bytesIn += frame.bytes;
    const result = validateFrame(s.role, frame.body, frame.bytes, extraTypes[s.role], { limits, caps });
    if (!result.ok) { s.violation(result.code); return; }
    if (!s.allow(result.type)) { s.violation('ratelimit'); return; }
    try {
      dispatch(s, result.msg);
    } catch (error) {
      m.inc('handlerErrors');
      m.log(`handler ${result.type}: ${error?.stack ?? error}`);
    }
  }

  // ── Connections ──────────────────────────────────────────────────────────────
  function helloMessage(s) {
    return {
      type: 'HELLO', v: PROTOCOL_VERSION, role: s.role, playerId: s.playerId, name: s.name,
      rev: s.role === 'player' ? stateSync.rev : undefined,
      server: { id: serverId, started },
      limits: {
        maxScene: caps.SCENE.max, playerMaxPayload: limits.playerMaxPayload, heartbeatMs: limits.heartbeatMs,
        silenceMs: limits.silenceMs, resumeWaitMs: limits.resumeWaitMs,
      },
    };
  }

  /**
   * Take over an upgraded WebSocket. `auth` is the ok-result of access.authenticateUpgrade.
   * Public so tests and custom transports can connect a fake socket.
   */
  function connect(ws, auth) {
    ws.on('error', noop); // a broken client must not stop the server
    const role = auth.role === 'gm' ? 'gm' : 'player';
    const s = createSession({
      socket: ws, role, auth, limits, caps, clock, metrics: m,
      onAbuse: session => { try { access.strike?.(session.ip, limits.strikesToClose); } catch { /* ignore */ } },
    });
    sessions.add(s);
    if (s.device && role === 'player') {
      let mine = byDevice.get(s.device);
      if (!mine) { mine = new Set(); byDevice.set(s.device, mine); }
      // Several windows on one device are fine; more than the cap replaces the oldest (it may be a dead connection).
      while (role === 'player' && mine.size >= limits.socketsPerDevice) {
        const oldest = mine.values().next().value;
        mine.delete(oldest);
        oldest.close(CLOSE.REPLACED, 'Too many windows on this device');
      }
      mine.add(s);
    }
    m.inc('sessions.opened');
    m.gauge('sessions.open', sessions.size);

    ws.on('message', (raw, isBinary) => onMessage(s, raw, isBinary));
    ws.on('pong', () => s.touch());
    ws.on('close', guard('close', () => onClose(s)));

    if (closing) s.close(CLOSE.SHUTDOWN, 'Server stopping');
    if (role === 'gm') {
      const previous = gm;
      gm = s;
      previous?.close(CLOSE.REPLACED, 'Another GM window took over');
      s.sendJson(helloMessage(s));
      s.sendJson({ type: 'REQUEST_FULL_STATE' });
      sendTable();
      try {
        for (const entry of access.table?.list?.() ?? []) {
          if (entry.status === 'pending') s.sendJson({ type: 'JOIN_REQUEST', device: entry.device, name: entry.name ?? '', label: entry.label ?? '', ip: entry.ip ?? '' });
        }
      } catch { /* no registry */ }
      roster.reset();
      roster.soon(0);
      broadcastPlayers(gmStatusMessage());
      for (const hook of hooks.gmChange) guard('onGmChange', hook)(true);
    } else {
      s.sendJson(helloMessage(s));
      if (s.playerId) s.sendJson({ type: 'PLAYER_ID', id: s.playerId });
      if (s.pending) s.sendJson({ type: 'WAIT' });
      else beginResume(s);
      roster.soon(0);
    }
    for (const hook of hooks.open) guard('onSessionOpen', hook)(s);
    return s;
  }

  function onClose(s) {
    s.markClosed();
    sessions.delete(s);
    stateSync.detach(s);
    if (s.device && s.role === 'player') {
      const mine = byDevice.get(s.device);
      mine?.delete(s);
      if (mine && mine.size === 0) byDevice.delete(s.device);
    }
    if (s.countedIp !== undefined) { try { access.socketClosed?.(s.countedIp); } catch { /* ignore */ } }
    m.inc('sessions.closed');
    m.gauge('sessions.open', sessions.size);
    if (s === gm) {
      gm = null;
      broadcastPlayers(gmStatusMessage());
      for (const hook of hooks.gmChange) guard('onGmChange', hook)(false);
    }
    if (s.role === 'player') roster.soon();
    for (const hook of hooks.close) guard('onSessionClose', hook)(s);
    whenEmpty?.();
  }

  // ── HTTP upgrade ─────────────────────────────────────────────────────────────
  function upgrade(request, socket, head) {
    let url;
    try { url = new URL(request.url ?? '/', 'http://localhost'); } catch { return; }
    const path = url.pathname;
    if (path === LEGACY_PATH) {
      // A phone with a cached v2 page: fail visibly, not silently.
      try {
        socket.on('error', noop);
        socket.end(`HTTP/1.1 426 Upgrade Required\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(LEGACY_MESSAGE)}\r\nConnection: close\r\n\r\n${LEGACY_MESSAGE}`);
      } catch { /* gone */ }
      return;
    }
    const isAudio = path === PATHS.audioWs;
    if (path !== PATHS.ws && !isAudio) return; // not ours (Vite's own HMR socket, for one)
    socket.on('error', noop);
    const ip = cleanIp(request.socket?.remoteAddress);
    if (closing) { refuse(socket, 503); return; }
    const offered = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(p => p.trim());
    if (!offered.includes(SUBPROTOCOL)) { m.inc('reject.protocol'); refuse(socket, 400); return; }

    // The per-IP slot is claimed after authentication and freed when the session closes; if the WebSocket handshake
    // never produces a session, when the raw socket closes.
    let counted = false;
    let upgraded = false;
    const release = () => { if (counted) { counted = false; try { access.socketClosed?.(ip); } catch { /* ignore */ } } };
    socket.once('close', () => { if (!upgraded) release(); });

    const finish = guard('upgrade', auth => {
      if (!auth?.ok) {
        // A refusal the client must be able to read (a stale nonce, a removed device) is delivered as a close code.
        if (Number.isInteger(auth?.closeCode) && auth.closeCode >= 4000 && auth.closeCode <= 4999 && !socket.destroyed) {
          wssRefuse.handleUpgrade(request, socket, head, ws => { ws.on('error', noop); ws.close(auth.closeCode, 'Refused'); });
          return;
        }
        refuse(socket, Number.isInteger(auth?.status) ? auth.status : 403);
        return;
      }
      if (socket.destroyed) return;
      try {
        if (access.socketOpened && access.socketOpened(ip) === false) { m.inc('reject.ip-cap'); refuse(socket, 503); return; }
        counted = Boolean(access.socketOpened);
      } catch { refuse(socket, 503); return; }
      const role = auth.role === 'gm' ? 'gm' : 'player';
      if (auth.kind === 'audio' || (auth.kind === undefined && isAudio)) {
        if (!audioHandler) { release(); refuse(socket, 404); return; }
        wssAudio.handleUpgrade(request, socket, head, ws => {
          upgraded = true;
          ws.on('error', noop);
          ws.isAlive = true;
          ws.on('pong', () => { ws.isAlive = true; });
          audioSockets.add(ws);
          ws.on('close', () => { audioSockets.delete(ws); release(); whenEmpty?.(); });
          try { audioHandler(ws, { ...auth, role, ip: auth.ip ?? ip }); } catch (error) {
            m.inc('handlerErrors');
            m.log(`audio handler: ${error?.message ?? error}`);
            ws.close(1011, 'error');
          }
        });
        return;
      }
      (role === 'gm' ? wssGm : wssPlayer).handleUpgrade(request, socket, head, ws => {
        upgraded = true;
        const session = connect(ws, { ...auth, role, ip: auth.ip ?? ip });
        if (counted) { session.countedIp = ip; counted = false; }
        const v = url.searchParams.get('v');
        if (v !== null && v !== String(PROTOCOL_VERSION)) session.close(CLOSE.TOO_OLD, 'Reload this page');
      });
    });

    let result;
    try { result = access.authenticateUpgrade(request); } catch (error) {
      m.inc('handlerErrors');
      m.log(`authenticateUpgrade threw: ${error?.message ?? error}`);
      refuse(socket, 403);
      return;
    }
    if (result && typeof result.then === 'function') result.then(finish, () => refuse(socket, 403));
    else finish(result);
  }

  // ── Periodic work ────────────────────────────────────────────────────────────
  const stopTick = t.every(TICK_MS, guard('tick', () => stateSync.tick()));
  const stopHeartbeat = t.every(limits.serverPingMs, guard('heartbeat', () => {
    const now = t.now();
    for (const s of [...sessions]) {
      if (now - s.lastSeen > limits.serverDeadMs) { m.inc('sessions.dead'); s.terminate(); continue; }
      try { s.socket.ping?.(); } catch { /* closing */ }
    }
    for (const ws of [...audioSockets]) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* closing */ }
    }
  }));

  // ── Table events ─────────────────────────────────────────────────────────────
  const table = access.table;
  if (typeof table?.on === 'function') {
    for (const [event, fn] of [
      ['change', () => reconcile()],
      ['joinRequest', request => {
        sendGm({ type: 'JOIN_REQUEST', device: request?.device ?? '', name: request?.name ?? '', label: request?.label ?? '', ip: request?.ip ?? '' });
      }],
    ]) {
      const handler = guard(`table.${event}`, fn);
      const off = table.on(event, handler);
      disposers.push(typeof off === 'function' ? off : () => table.off?.(event, handler));
    }
  }

  // ── Public interface (design 7.3) ────────────────────────────────────────────
  const hub = {
    /** Install the 'upgrade' handler for PATHS.ws and PATHS.audioWs on an HTTP server. Returns a function that closes the hub. */
    attach(httpServer) {
      if (!httpServer) return () => hub.close();
      httpServer.on('upgrade', upgrade);
      httpServer.once('close', () => hub.close());
      return () => hub.close();
    },

    /** Connect an already-upgraded WebSocket (tests, custom transports). `auth` is an ok-result of authenticateUpgrade. */
    connect,

    /**
     * Graceful shutdown: sockets get close code 4010 (clients reconnect with backoff), stragglers are terminated after
     * a short grace period. Resolves when everything is closed. Safe to call twice.
     */
    close() {
      if (closePromise) return closePromise;
      closing = true;
      stopTick();
      stopHeartbeat();
      roster.dispose();
      for (const dispose of disposers.splice(0)) { try { dispose(); } catch { /* ignore */ } }
      // The 'upgrade' listener stays: while closing it answers 503, instead of an upgrade falling through to the HTTP handlers.
      for (const s of [...sessions]) s.close(CLOSE.SHUTDOWN, 'Server stopping');
      for (const ws of [...audioSockets]) { try { ws.close(CLOSE.SHUTDOWN, 'Server stopping'); } catch { /* gone */ } }
      closePromise = new Promise(resolve => {
        let finished = false;
        let stopGrace = noop;
        const finish = () => {
          if (finished) return;
          finished = true;
          stopGrace();
          whenEmpty = null;
          wssPlayer.close(); wssGm.close(); wssAudio.close(); wssRefuse.close();
          resolve();
        };
        whenEmpty = () => { if (sessions.size === 0 && audioSockets.size === 0) finish(); };
        stopGrace = t.after(GRACE_MS, () => {
          for (const s of [...sessions]) s.terminate();
          for (const ws of [...audioSockets]) { try { ws.terminate(); } catch { /* gone */ } }
          finish();
        });
        whenEmpty();
      });
      return closePromise;
    },

    sessions: {
      byDevice: device => [...(byDevice.get(device) ?? [])].filter(s => !s.closed),
      gm: () => (gm?.isOpen ? gm : null),
      players: () => players(),
      all: () => [...sessions],
    },
    sendTo,
    sendGm,

    /** Register extra message handlers and lifecycle hooks (audio signalling plugs in here). May be called many times. */
    extend({ playerTypes, gmTypes, onSessionOpen, onSessionClose, onGmChange, rosterAudio: audioStatus } = {}) {
      for (const [role, handlers] of [['player', playerTypes], ['gm', gmTypes]]) {
        for (const [type, handler] of Object.entries(handlers ?? {})) {
          if (typeof handler !== 'function') continue;
          if (!typeHandlers[role].has(type)) typeHandlers[role].set(type, []);
          typeHandlers[role].get(type).push(guard(`extension ${type}`, handler));
          extraTypes[role].add(type);
        }
      }
      if (typeof onSessionOpen === 'function') hooks.open.push(onSessionOpen);
      if (typeof onSessionClose === 'function') hooks.close.push(onSessionClose);
      if (typeof onGmChange === 'function') hooks.gmChange.push(onGmChange);
      if (typeof audioStatus === 'function') rosterAudio = audioStatus;
      return hub;
    },

    /** How /__realm/audio sockets are served: handler(ws, auth). Authentication has already happened. */
    upgradeAudio(handler) { audioHandler = typeof handler === 'function' ? handler : null; },

    /** Ask for a roster update (an extension changed something the roster shows, such as a device's audio status). */
    refreshRoster(delay = 40) { roster.soon(delay); },

    /** For realm.js, the status page and tests. */
    state: stateSync,
    roster,
    pinnedHashes: () => stateSync.pinnedHashes(),
    describe() {
      return {
        rev: stateSync.rev,
        gm: { connected: gmPresent(), since: gm?.connectedAt ?? null },
        sockets: { player: players().length, pending: [...sessions].filter(s => s.pending).length, gm: gmPresent() ? 1 : 0, audio: audioSockets.size },
        devices: [...sessions].filter(s => s.role === 'player').map(s => s.describe()),
        serverId,
        started,
      };
    },
  };

  for (const extension of extensions) hub.extend(extension);
  return hub;
}
