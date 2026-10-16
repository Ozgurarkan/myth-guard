// Composition of the access-control modules (design 7.2). The hub (WP3) and the audio signalling (WP5) only see what
// createAccess() returns:
//
//   router(req, res, next)        every HTTP route of 4.4 (Connect-style; the Vite plugin uses it too)
//   authenticateUpgrade(req)      -> { ok: true, role, kind, device, playerId, name, ip, label, pending, protocol }
//                                  | { ok: false, status, reason, closeCode? }       (no socket exists before it says ok)
//   socketOpened(ip) -> boolean, socketClosed(ip)        per-IP and total socket caps
//   strike(ip, n?) -> boolean (banned now), ban(ip, ms), banned(ip)
//   table                         the GM's controls over admission (mode, lock, kick, rotate...) and its change events
//   assets, metrics, lan, hostGuard, limiter
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { ADMISSION_MODES, LIMITS, PROTOCOL_VERSION } from '../../src/net/protocol.js';
import { createAssetRoutes, createAssetStore, createEgressPacer } from './assets.js';
import { createClock } from './clock.js';
import { createDevices } from './devices.js';
import { createHandshake } from './handshake.js';
import { createHostGuard } from './hostGuard.js';
import { APP_ID, createHttpRouter } from './http.js';
import { createInvite } from './invite.js';
import { createIpLimiter } from './ipLimiter.js';
import { createLan } from './lan.js';
import { createMetrics } from './status.js';
import { createTableStore } from './tableStore.js';

/** Where table.json lives unless told otherwise: `.realm-data/` in the project folder (override: REALM_DATA_DIR). */
export const defaultDataDir = () => process.env.REALM_DATA_DIR || fileURLToPath(new URL('../../.realm-data', import.meta.url));

/** "ABCD-EFGH" for display; the dash is not part of the code. */
export const displayCode = code => `${code.slice(0, 4)}-${code.slice(4)}`;

/**
 * @param {object} [options]
 * @param {string|null} [options.dataDir]  folder of table.json; null keeps the table in memory only
 * @param [options.clock]  createClock() / createFakeClock()
 * @param [options.hostGuard]  createHostGuard(...) (default: this computer's own names)
 * @param [options.limiter]  createIpLimiter(...)
 * @param [options.metrics]  createMetrics(...)
 * @param {() => Set<string>} [options.projectAssetsPinned]  hashes of the images the live scene refers to
 * @param {object} [options.assetLimits]  overrides for the image store (maxBytes, maxAsset, ...); tests use small ones
 * @param {Map<string, object>|null} [options.site]  built site from loadSite(); omit when Vite serves the files
 * @param {'report-only'|'enforce'|'off'} [options.cspMode]
 * @param {number} [options.assetEgressKBps]  pace big image responses while sound is live (0 = off)
 * @param {() => boolean} [options.audioLive]  is sound being broadcast right now (for egress pacing)
 * @param [options.lanInterfaces]  os.networkInterfaces()-shaped object or function, for tests
 * @param {string} [options.hostname]  this computer's name, for tests
 */
export function createAccess(options = {}) {
  const clock = options.clock ?? createClock();
  const metrics = options.metrics ?? createMetrics(clock);
  const lan = createLan(options.lanInterfaces ?? networkInterfaces);
  const hostGuard = options.hostGuard ?? createHostGuard({ getAddresses: lan.addresses, hostname: options.hostname });
  const limiter = options.limiter ?? createIpLimiter(clock, { exempt: hostGuard.isLoopback });
  const dataDir = options.dataDir === undefined ? defaultDataDir() : options.dataDir;
  const store = createTableStore({ file: dataDir ? join(dataDir, 'table.json') : null, clock, log: line => metrics.log(line) });
  const loaded = store.load();
  if (loaded.corrupt) metrics.inc('table.corrupt');

  const listeners = { change: new Set(), joinRequest: new Set() };
  const fire = (event, payload) => {
    for (const listener of [...listeners[event]]) {
      try { listener(payload); } catch { metrics.inc('table.listenerErrors'); }
    }
  };

  const devices = createDevices({
    store, clock,
    emit(event) {
      fire('change', event);
      if (event.kind === 'join' && event.status === 'pending') {
        const record = devices.find(event.device);
        if (record) fire('joinRequest', { device: event.device, playerId: devices.playerIdOf(event.device), name: record.name, label: record.label, ip: record.ip });
      }
    },
  });
  devices.start();
  const invite = createInvite({ store, clock });
  const assets = createAssetStore({ ...options.assetLimits, pin: options.projectAssetsPinned });
  const state = { port: 0 };

  // ---- the table (what the GM controls) ------------------------------------------------------------------------
  const table = {
    mode: () => store.data.mode,
    locked: () => store.data.mode === 'locked',
    setMode(mode) {
      if (!ADMISSION_MODES.has(mode)) return false;
      if (mode === 'locked') { table.lock(); return true; }
      if (store.data.mode === mode) return true;
      if (table.locked()) invite.rotateCode();
      store.data.mode = mode;
      store.data.modeBeforeLock = mode;
      store.save();
      fire('change', { kind: 'mode', mode });
      return true;
    },
    /** Locks the table: new devices are refused, known devices reconnect. The typed code changes. */
    lock(reason = 'gm') {
      if (table.locked()) return false;
      store.data.modeBeforeLock = store.data.mode;
      store.data.mode = 'locked';
      invite.rotateCode();
      store.save();
      metrics.log(`table: locked (${reason})`);
      fire('change', { kind: 'lock', reason });
      return true;
    },
    unlock() {
      if (!table.locked()) return false;
      store.data.mode = store.data.modeBeforeLock === 'ask' ? 'ask' : 'open';
      invite.rotateCode();
      store.save();
      fire('change', { kind: 'unlock', mode: store.data.mode });
      return true;
    },
    /** New invite secret and code: every old QR code and code stops working; admitted devices are unaffected. */
    rotate() {
      invite.rotate();
      metrics.log('table: invite rotated');
      fire('change', { kind: 'rotate' });
    },
    kick: device => devices.revoke(device),
    admit: device => devices.admit(device),
    deny: device => devices.deny(device),
    rename: (device, name) => devices.rename(device, name),
    list: () => devices.list(),
    /** `{ code, codeDisplay, codeFresh, urlFor(address, port?) }`; reading it does not extend the code's freshness. */
    invite() {
      const current = invite.current();
      return {
        code: current.code,
        codeDisplay: displayCode(current.code),
        codeFresh: current.codeFresh,
        urlFor: (address, port = state.port) => invite.urlFor(address, port),
      };
    },
    /** The GM is looking at the invite (dialog open): the typed code is accepted for 10 more minutes. */
    inviteShown() { invite.markShown(); },
    /** The `TABLE` message body for the GM. */
    view: () => ({ mode: store.data.mode, locked: table.locked(), code: displayCode(invite.current().code), codeFresh: invite.codeFresh() }),
    on(event, listener) {
      if (!listeners[event]) throw new RangeError(`table.on: unknown event "${event}"`);
      listeners[event].add(listener);
      return () => listeners[event].delete(listener);
    },
  };

  const handshake = createHandshake({
    devices, invite, store, limiter, hostGuard, clock, metrics,
    onCodeFlood: () => table.lock('code-flood'),
  });

  // ---- diagnostics ---------------------------------------------------------------------------------------------
  const diagProviders = [];
  const info = port => {
    invite.markShown();
    const current = invite.current();
    return {
      app: APP_ID,
      protocol: PROTOCOL_VERSION,
      port,
      addresses: lan.addresses().map(entry => ({
        ...entry,
        url: `http://${entry.address}:${port}/player.html`,
        joinUrl: invite.urlFor(entry.address, port),
      })),
      code: current.code,
      codeDisplay: displayCode(current.code),
      mode: store.data.mode,
      locked: table.locked(),
      devices: devices.list(),
      images: { count: assets.size, bytes: assets.bytes },
      persist: store.persisted,
    };
  };
  const diag = () => {
    const snapshot = metrics.snapshot();
    const body = {
      app: APP_ID,
      version: PROTOCOL_VERSION,
      protocol: PROTOCOL_VERSION,
      uptimeS: snapshot.uptimeS,
      table: {
        mode: store.data.mode, locked: table.locked(), persist: store.persisted,
        devices: devices.count('admitted'), pending: devices.count('pending'), revoked: devices.count('revoked'),
      },
      sockets: limiter.stats(),
      rejects: snapshot.rejects,
      assets: assets.stats(),
      counters: snapshot.counters,
      gauges: snapshot.gauges,
      timings: snapshot.timings,
      memory: snapshot.memory,
    };
    for (const provider of diagProviders) {
      try { Object.assign(body, provider()); } catch { metrics.inc('diag.providerErrors'); }
    }
    return body;
  };

  metrics.gauge('sockets.total', () => limiter.totalSockets);
  metrics.gauge('devices.admitted', () => devices.count('admitted'));
  metrics.gauge('devices.pending', () => devices.count('pending'));
  metrics.gauge('assets.count', () => assets.size);
  metrics.gauge('assets.bytes', () => assets.bytes);

  const pacer = options.assetEgressKBps > 0 ? createEgressPacer({ kBps: options.assetEgressKBps, clock }) : null;
  const assetRoutes = createAssetRoutes({ store: assets, handshake, limiter, metrics, clock, pacer, audioLive: options.audioLive });
  const router = createHttpRouter({
    site: options.site ?? null, assetRoutes, handshake, metrics, hostGuard, limiter, info, diag,
    onPort: port => { state.port = port; }, cspMode: options.cspMode,
  });

  return {
    router,
    authenticateUpgrade: req => handshake.authenticateUpgrade(req),
    socketOpened(ip) {
      const ok = limiter.openSocket(ip);
      if (!ok) metrics.inc('reject.ip-cap');
      return ok;
    },
    socketClosed: ip => limiter.closeSocket(ip),
    /**
     * Strikes against an address; true when it is banned afterwards. One call carrying LIMITS.strikesToClose or more is
     * the hub reporting a socket that was closed for abuse (4008): the address is banned for LIMITS.strikeBanMs (30 s).
     * Smaller numbers are failed proofs: LIMITS.failedProofsBeforeBan of them within a minute ban it for LIMITS.banMs.
     */
    strike(ip, count = 1) {
      if (count >= LIMITS.strikesToClose) { metrics.inc('reject.abuse'); limiter.ban(ip, LIMITS.strikeBanMs); return limiter.banned(ip); }
      return limiter.strike(ip, count);
    },
    /** An outright ban (the hub uses it after closing a socket with ABUSE: LIMITS.strikeBanMs). */
    ban: (ip, ms = LIMITS.strikeBanMs) => limiter.ban(ip, ms),
    banned: ip => limiter.banned(ip),
    table,
    assets,
    metrics,
    lan,
    hostGuard,
    limiter,
    clock,
    /** Adds fields to GET /__realm/diag: `fn()` returns an object that is merged into the body (the hub adds sessions). */
    extendDiag(fn) { diagProviders.push(fn); },
    get persisted() { return store.persisted; },
    get port() { return state.port; },
    /** Test and tooling access; not part of the contract the hub relies on. */
    internals: { store, devices, invite, handshake },
    /** Writes table.json and stops timers. */
    close() { devices.close(); store.save(); },
  };
}
