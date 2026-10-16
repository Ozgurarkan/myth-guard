// WP5 test doubles for the interfaces WP2 (access, metrics, lan) and WP3 (hub) expose to the audio server modules (design 7.3).
// They are deliberately strict: a message the audio code sends that is not in the protocol catalogue, or is larger than its cap,
// fails the test that provoked it.
import { EventEmitter } from 'node:events';
import { PLAYER_TYPES, GM_TYPES, SERVER_TO_PLAYER, SERVER_TO_GM, TYPE_CAPS } from '../src/net/protocol.js';

export function createClock(start = 1000) {
  let time = start;
  let ids = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(fn, ms) { const id = ++ids; timers.set(id, { at: time + ms, fn, every: 0 }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id = ++ids; timers.set(id, { at: time + ms, fn, every: ms }); return id; },
    clearInterval(id) { timers.delete(id); },
    advance(ms) {
      const target = time + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= target && (!next || t.at < next.t.at)) next = { id, t };
        if (!next) break;
        time = next.t.at;
        if (next.t.every) next.t.at += next.t.every; else timers.delete(next.id);
        next.t.fn();
      }
      time = target;
    },
    get pending() { return timers.size; },
  };
}

export function createFakeMetrics() {
  const counters = new Map();
  const gauges = new Map();
  const lines = [];
  return {
    inc(name, n = 1) { counters.set(name, (counters.get(name) ?? 0) + n); },
    observe() {},
    gauge(name, value) { gauges.set(name, value); },
    log(line) { lines.push(line); },
    get: name => counters.get(name) ?? 0,
    gaugeOf: name => gauges.get(name),
    counters, gauges, lines,
    startsWith: prefix => [...counters].filter(([k]) => k.startsWith(prefix)),
  };
}

const bytesOf = obj => Buffer.byteLength(JSON.stringify(obj));

export function createFakeSession({ device, role = 'player', ip = '192.168.1.42', name = 'Aria', label = 'Android · Chrome', hubLog }) {
  const sent = [];
  const session = {
    device, role, ip, name, label, playerId: `p-${device?.slice(0, 6)}`, rtt: 12, bufferedAmount: 0, open: true, closed: null,
    sent,
    sendJson(obj) {
      const allowed = role === 'gm' ? SERVER_TO_GM : SERVER_TO_PLAYER;
      if (!allowed.has(obj.type)) throw new Error(`${obj.type} is not in the server -> ${role} catalogue`);
      if (bytesOf(obj) > TYPE_CAPS[obj.type].max) throw new Error(`${obj.type} is ${bytesOf(obj)} bytes, cap ${TYPE_CAPS[obj.type].max}`);
      if (!session.open) return;
      sent.push(obj);
      hubLog?.push({ to: role === 'gm' ? 'gm' : device, ...obj });
    },
    send(text) { session.sendJson(JSON.parse(text)); },
    close(code, reason) { session.open = false; session.closed = { code, reason }; },
    of: type => sent.filter(m => m.type === type),
    last: type => sent.filter(m => m.type === type).at(-1),
    clear() { sent.length = 0; },
  };
  return session;
}

export function createFakeWs() {
  const ws = new EventEmitter();
  Object.assign(ws, {
    readyState: 1, bufferedAmount: 0, sent: [], pending: [], closed: null, pings: 0, frozen: false,
    send(data, options, callback) {
      ws.sent.push(data);
      if (ws.frozen) ws.pending.push(callback); else callback?.();
    },
    /** Let the writes that a frozen socket was holding complete. */
    thaw() { ws.frozen = false; const list = ws.pending.splice(0); for (const cb of list) cb?.(); },
    close(code, reason) { ws.readyState = 3; ws.closed = { code, reason }; ws.emit('close', code, reason); },
    terminate() { ws.close(1006, 'terminated'); },
    ping() { ws.pings++; },
  });
  return ws;
}

export function createFakeHub({ metrics } = {}) {
  const hubLog = [];
  const extensions = [];
  const sessions = [];
  let gmConnected = false;
  let audioHandler = null;
  const live = () => sessions.filter(s => s.open);
  const hub = {
    log: hubLog,
    extensions,
    sessions: {
      byDevice: device => live().filter(s => s.device === device && s.role === 'player'),
      gm: () => live().find(s => s.role === 'gm') ?? null,
      players: () => live().filter(s => s.role === 'player'),
    },
    sendTo(device, obj) { for (const s of hub.sessions.byDevice(device)) s.sendJson(obj); },
    sendGm(obj) { hub.sessions.gm()?.sendJson(obj); },
    extend(extension) { extensions.push(extension); },
    upgradeAudio(handler) { audioHandler = handler; },

    // ---- test driving -------------------------------------------------------------------------------------------
    addPlayer(device, extra = {}) {
      const session = createFakeSession({ device, hubLog, ...extra });
      sessions.push(session);
      for (const e of extensions) e.onSessionOpen?.(session);
      return session;
    },
    addGm() {
      const session = createFakeSession({ device: undefined, role: 'gm', hubLog });
      sessions.push(session);
      gmConnected = true;
      for (const e of extensions) e.onGmChange?.(true);
      return session;
    },
    dropSession(session) {
      session.open = false;
      for (const e of extensions) e.onSessionClose?.(session);
      if (session.role === 'gm') { gmConnected = false; for (const e of extensions) e.onGmChange?.(false); }
    },
    /** What the hub does with a frame from a session: whitelist by direction, enforce the cap, then dispatch. */
    deliver(session, msg) {
      const allowed = session.role === 'gm' ? GM_TYPES : PLAYER_TYPES;
      if (!allowed.has(msg.type)) throw new Error(`${msg.type} is not accepted from a ${session.role}`);
      const cap = TYPE_CAPS[msg.type];
      if (bytesOf(msg) > cap.max) throw new Error(`${msg.type} is ${bytesOf(msg)} bytes, cap ${cap.max}`);
      for (const e of extensions) {
        const table = session.role === 'gm' ? e.gmTypes : e.playerTypes;
        table?.[msg.type]?.(session, msg);
      }
    },
    openAudio(role, device, extra = {}) {
      const ws = createFakeWs();
      audioHandler(ws, { ok: true, role, device, ip: '192.168.1.42', ...extra });
      return ws;
    },
    get gmConnected() { return gmConnected; },
    metrics,
  };
  return hub;
}

export function createFakeAccess(devices = []) {
  const handlers = [];
  const state = { devices: new Map(devices.map(d => [d.device, { status: 'admitted', ...d }])) };
  return {
    table: {
      list: () => [...state.devices.values()],
      on: (event, fn) => { if (event === 'change') handlers.push(fn); },
    },
    add(device, extra = {}) { state.devices.set(device, { device, status: 'admitted', ...extra }); },
    revoke(device) { state.devices.delete(device); for (const fn of handlers) fn(); },
  };
}

export const FAKE_INTERFACES = () => ({
  Ethernet: [{ family: 'IPv4', internal: false, address: '10.60.25.83', netmask: '255.255.255.0' }],
  'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.1.10', netmask: '255.255.255.0' }],
  lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }],
});

export const hex16 = n => n.toString(16).padStart(32, '0');
