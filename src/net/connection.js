// One resilient control connection per window (design 4.5 and 4.10). Replaces src/sessionTransport.js.
//
// Wi-Fi is rude to long-lived sockets: phones sleep, routers drop idle connections, a half-open socket can look healthy for
// minutes. This connection therefore
//   - authenticates inside the HTTP upgrade (players: POST /hello, then the `auth.*` sub-protocol; the GM offers only
//     'rf3' and is recognised by the server from loopback + Host + Origin + the rf-gm cookie, Appendix A.6),
//   - pings every few seconds, measures the round trip, and abandons a socket that has gone silent,
//   - reconnects with exponential backoff and jitter, and at once when the device wakes (online / pageshow / visible),
//   - follows the close-code policy: 4001, 4002 and 4004 are final, 4003 retries slowly, 4008 backs off 30 s, 4011 retries
//     once with a fresh nonce,
//   - answers the server's HELLO with RESUME { rev, aids } and re-sends the actions that were never acknowledged, so a move
//     sent just before a drop is neither lost nor applied twice.
//
// Everything that touches the outside world is injected (clock, WebSocket class, fetch, window/document, random), so the
// same tests run against a fake socket and, later, against the real hub.
import { PATHS, CLOSE, LIMITS, SUBPROTOCOL, PROTOCOL_VERSION, authProtocol, isHex } from './protocol.js';
import { wsProof } from './hmac.js';
import { createNetStats } from './netStats.js';

/** The real clock. Tests pass a fake with the same five members. */
export function createSystemClock() {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: id => clearInterval(id),
  };
}

/** Close codes after which the connection must not try again by itself. */
const FINAL = new Map([
  [CLOSE.REPLACED, 'replaced'],
  [CLOSE.KICKED, 'kicked'],
  [CLOSE.TOO_OLD, 'outdated'],
]);

const read = value => (typeof value === 'function' ? value() : value);

/**
 * Statuses passed to `onStatus`:
 *   connecting | reconnecting | open | waiting   (the usual cycle; 'waiting' = the GM has not admitted this device yet)
 *   locked        4003: the table is locked or admission was denied; retries every `lockedRetryMs`
 *   replaced      4001: another GM window took over (final)
 *   kicked        4002: the GM removed this device (final)
 *   outdated      4004 or a HELLO of another protocol version: reload the page (final)
 *   unauthorized  the proof was refused twice in a row (final): the device key is no longer valid
 *
 * @param {object} options
 * @param {'player'|'gm'} options.role
 * @param {string} [options.url]            any URL of the table page; ws://.../__realm/ws is derived from it
 * @param {string|(()=>string)} [options.device] player: the device id (32 hex)
 * @param {string|(()=>string|null)} [options.dk] player: the device key (64 hex)
 * @param {Function} [options.WebSocketClass]
 * @param {Function} [options.fetchImpl]
 * @param {object}   [options.clock]        { now, setTimeout, clearTimeout, setInterval, clearInterval }
 * @param {()=>number} [options.random]     0..1, for the backoff jitter
 * @param {object}   [options.env]          { window, document } for the wake-up events (defaults to the globals)
 * @param {()=>{rev:(number|null)}} [options.resume] what to put in RESUME
 * @param {Function} [options.onOpen]       called once per socket, after HELLO and RESUME: the connection is usable
 * @param {Function} [options.onMessage]    (message, { action }) for everything except PONG; `action` is the original
 *                                          object of an acknowledged action (for ACK frames)
 * @param {Function} [options.onStatus]
 * @param {Function} [options.onLatency]    (rttMs) after every PONG
 * @param {Function} [options.onClose]      ({ code, status, final }) every time a socket is lost or refused
 * @param {Function} [options.onActionExpired] (action) an unacknowledged action was dropped after `actionRetryMs`
 */
export function createConnection({
  role, url, device, dk, WebSocketClass, fetchImpl, clock = createSystemClock(), random = Math.random, env,
  resume, onOpen, onMessage, onStatus, onLatency, onClose, onActionExpired,
  // Timing. The two legacy names keep old `transportOptions` working.
  reconnectDelay = 500, maxReconnectDelay = 6000, jitter = 0.3,
  heartbeatMs = LIMITS.heartbeatMs, silenceMs = LIMITS.silenceMs, probeMs = 3000, connectTimeoutMs = 8000,
  helloTimeoutMs = 5000, lockedRetryMs = 15000, abuseBackoffMs = 30000, actionRetryMs = LIMITS.actionRetryMs,
}) {
  if (role !== 'player' && role !== 'gm') throw new TypeError("role must be 'player' or 'gm'");
  const Socket = WebSocketClass ?? globalThis.WebSocket;
  const OPEN = Socket?.OPEN ?? 1;
  const CONNECTING = Socket?.CONNECTING ?? 0;
  const doFetch = (...args) => (fetchImpl ?? globalThis.fetch)(...args);
  const stats = createNetStats(clock);
  const pageUrl = () => url ?? globalThis.location?.href;

  let socket = null;
  let ready = false;        // HELLO received on the current socket
  let waiting = false;      // the server answered WAIT: not admitted yet
  let resumed = false;      // RESUME already sent on the current socket (it is allowed once)
  let halted = false;       // a final close code, or close() was called
  let connecting = false;   // a connect() is between "decided" and "socket created" (the /hello round trip)
  let generation = 0;
  let attempts = 0;
  let authFailures = 0;
  let holdUntil = 0;        // no wake-up reconnects before this time (abuse back-off)
  let lastHeard = 0;
  let rtt = null;
  let status = null;
  let server = null;
  let limits = {};
  let everReady = false;
  let retryTimer = null;
  let beatTimer = null;
  let probeTimer = null;
  let connectTimer = null;
  const pending = new Map(); // aid -> { obj, text, timer }
  const recent = [];         // last pings: { t, answered } for the loss estimate

  const setStatus = next => {
    if (next === status) return;
    status = next;
    onStatus?.(next);
  };
  const clearSocketTimers = () => {
    clock.clearInterval(beatTimer); clock.clearTimeout(probeTimer); clock.clearTimeout(connectTimer);
    beatTimer = probeTimer = connectTimer = null;
  };
  const clearRetry = () => { clock.clearTimeout(retryTimer); retryTimer = null; };

  // ── sending ────────────────────────────────────────────────────────────────
  const writeText = text => {
    if (!socket || socket.readyState !== OPEN) return false;
    try { socket.send(text); } catch { return false; }
    stats.count('bytesOut', text.length);
    stats.count('messagesOut');
    return true;
  };

  function forget(aid) {
    const entry = pending.get(aid);
    if (!entry) return null;
    clock.clearTimeout(entry.timer);
    pending.delete(aid);
    return entry.obj;
  }

  const connection = {
    /**
     * Send a JSON message. Returns false (and sends nothing) unless the connection is ready, i.e. the server has said HELLO
     * and has not put this device on hold. With `{ aid }` the message is an action: it carries the id, is remembered until
     * the server's ACK, and is re-sent after a reconnect for up to `actionRetryMs`.
     */
    send(obj, { aid } = {}) {
      if (!ready || waiting) return false;
      const message = aid === undefined ? obj : { ...obj, aid };
      const text = JSON.stringify(message);
      if (!writeText(text)) return false;
      if (aid !== undefined) {
        forget(aid);
        const timer = clock.setTimeout(() => {
          const expired = forget(aid);
          if (expired) { stats.count('expired'); onActionExpired?.(expired); }
        }, actionRetryMs);
        pending.set(aid, { obj: message, text, timer });
      }
      return true;
    },
    /** Send a pre-serialised frame as it is (caller keeps it within the type's cap). */
    sendRaw(text) { return ready && !waiting && writeText(text); },
    /** Reconnect right now (the device just woke up or came back online), or check that a quiet socket is alive. */
    nudge() { wake(); },
    /** Stop for good: no further attempts, no events. */
    close() {
      halted = true;
      generation++;
      clearRetry();
      clearSocketTimers();
      removeListeners();
      for (const aid of [...pending.keys()]) forget(aid);
      const current = socket;
      socket = null;
      ready = false;
      if (current) { current.onclose = current.onerror = current.onmessage = current.onopen = null; try { current.close?.(); } catch { /* gone */ } }
      stats.markClosed(1000, 'closed by the application');
    },
    /** Same as send (the old transport's name). */
    postMessage(obj) { return connection.send(obj); },
    get open() { return ready && !waiting && socket?.readyState === OPEN; },
    get latency() { return rtt; },
    get stats() { return stats.snapshot(); },
    get status() { return status; },
    get server() { return server; },
    get limits() { return limits; },
    get pendingActions() { return [...pending.keys()]; },
    /** Counters other layers add to (for example `divergence`). */
    count: (name, n) => stats.count(name, n),
  };

  // ── connecting ─────────────────────────────────────────────────────────────
  function schedule(delay) {
    clearRetry();
    let wait = delay;
    if (wait === undefined) {
      const ceiling = Math.min(maxReconnectDelay, reconnectDelay * 2 ** attempts);
      attempts++;
      wait = ceiling * (1 - jitter + random() * 2 * jitter);
    }
    retryTimer = clock.setTimeout(connect, wait);
  }

  /** Something failed before a socket existed (the /hello round trip). */
  function failedBeforeSocket(kind) {
    if (kind === 'revoked') { halt('kicked', CLOSE.KICKED, true); return; }
    if (kind === 'auth') {
      authFailures++;
      if (authFailures >= 2) { halt('unauthorized', CLOSE.AUTH, true); return; }
      setStatus('reconnecting');
      stats.markClosed(CLOSE.AUTH, 'hello refused');
      onClose?.({ code: CLOSE.AUTH, status: 'reconnecting', final: false });
      schedule(0);
      return;
    }
    setStatus('reconnecting');
    stats.markClosed(1006, kind);
    onClose?.({ code: 1006, status: 'reconnecting', final: false });
    schedule();
  }

  function halt(finalStatus, code, final = true) {
    halted = true;
    clearRetry();
    clearSocketTimers();
    removeListeners();
    stats.markClosed(code, finalStatus);
    setStatus(finalStatus);
    onClose?.({ code, status: finalStatus, final });
  }

  /** POST /hello: a one-time nonce. Resolves the nonce or throws 'auth' | 'revoked' | 'network'. */
  async function fetchNonce(deviceId) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer;
    const timeout = new Promise((_, reject) => { timer = clock.setTimeout(() => { controller?.abort(); reject(new Error('network')); }, helloTimeoutMs); });
    try {
      const request = (async () => {
        const response = await doFetch(new URL(PATHS.hello, pageUrl()).href, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: deviceId }),
          credentials: 'same-origin', signal: controller?.signal,
        });
        if (response.status === 401 || response.status === 403) {
          let reason = null;
          try { reason = (await response.json())?.error ?? null; } catch { /* generic */ }
          throw new Error(reason === 'revoked' || reason === 'kicked' ? 'revoked' : 'auth');
        }
        if (!response.ok) throw new Error('network');
        const body = await response.json();
        if (!isHex(body?.nonce, 16)) throw new Error('network');
        return body.nonce;
      })();
      return await Promise.race([request, timeout]);
    } catch (error) {
      throw error?.message === 'auth' || error?.message === 'revoked' ? error : new Error('network');
    } finally { clock.clearTimeout(timer); }
  }

  async function connect() {
    if (halted || connecting) return;
    clearRetry();
    connecting = true;
    const mine = ++generation;
    setStatus(everReady || attempts ? 'reconnecting' : 'connecting');
    let protocols = [SUBPROTOCOL];
    if (role === 'player') {
      try {
        const deviceId = read(device);
        const key = read(dk);
        if (!isHex(deviceId, 16) || !isHex(key, 32)) throw new Error('auth');
        const nonce = await fetchNonce(deviceId);
        if (mine !== generation || halted) { connecting = false; return; }
        protocols = [SUBPROTOCOL, authProtocol(deviceId, nonce, wsProof(key, deviceId, nonce, 'player'))];
      } catch (error) {
        connecting = false;
        if (mine !== generation || halted) return;
        failedBeforeSocket(error.message);
        return;
      }
    }
    connecting = false;
    if (halted) return;

    const target = new URL(PATHS.ws, pageUrl());
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    target.searchParams.set('role', role);
    let active;
    try { active = new Socket(target.href, protocols); } catch { failedBeforeSocket('network'); return; }
    socket = active;
    ready = false; waiting = false; resumed = false;
    active.binaryType = 'arraybuffer';
    // A phone on weak Wi-Fi can wait minutes for a SYN: give up on a socket that says nothing at all.
    connectTimer = clock.setTimeout(() => abandon(active, 4000), connectTimeoutMs);

    active.onopen = () => {
      if (active !== socket) return;
      lastHeard = clock.now();
      clearSocketTimers();
      connectTimer = clock.setTimeout(() => abandon(active, 4000), connectTimeoutMs); // now waiting for HELLO
      beatTimer = clock.setInterval(() => heartbeat(active), heartbeatMs);
    };
    active.onmessage = event => {
      if (active !== socket) return;
      lastHeard = clock.now();
      clock.clearTimeout(connectTimer); connectTimer = null;
      if (typeof event.data !== 'string') return; // binary on the control socket is a protocol error; ignore it
      stats.count('bytesIn', event.data.length);
      stats.count('messagesIn');
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
      handle(active, message);
    };
    active.onerror = () => { try { active.close(); } catch { /* ignore */ } };
    active.onclose = event => { if (active === socket && !halted) abandon(active, event?.code ?? 1006, event?.reason); };
  }

  function handle(active, message) {
    switch (message.type) {
      case 'PONG': {
        clock.clearTimeout(probeTimer); probeTimer = null;
        if (Number.isFinite(message.t)) {
          rtt = Math.max(1, clock.now() - message.t);
          stats.recordRtt(rtt);
          stats.count('pongs');
          const sample = recent.find(entry => entry.t === message.t);
          if (sample) sample.answered = true;
          stats.setLoss(lossPercent());
          onLatency?.(rtt);
        }
        return;
      }
      case 'HELLO': {
        if (message.v !== undefined && message.v !== PROTOCOL_VERSION) { terminate(active); socket = null; ready = false; halt('outdated', CLOSE.TOO_OLD); return; }
        server = message.server ?? null;
        limits = message.limits ?? {};
        onMessage?.(message, {});            // the link may reconcile (for example forget a revision of another server)
        if (active !== socket || halted) return;
        if (!ready) becomeReady(active); // a repeated HELLO is information, not a new session
        return;
      }
      case 'WAIT':
        waiting = true;
        ready = false;
        setStatus('waiting');
        onMessage?.(message, {});
        return;
      case 'ADMITTED':
        waiting = false;
        onMessage?.(message, {});
        if (active === socket && !halted && !ready) becomeReady(active); // some hubs send HELLO only after ADMITTED
        return;
      case 'TABLE_LOCKED':
        setStatus('locked');
        break;
      case 'STATE_FULL': stats.count('fulls'); break;
      case 'STATE_PATCH': stats.count('patches'); break;
      case 'ACK': {
        const action = typeof message.aid === 'string' ? forget(message.aid) : null;
        onMessage?.(message, { action });
        return;
      }
      default:
    }
    onMessage?.(message, {});
  }

  function becomeReady(active) {
    waiting = false;
    ready = true;
    attempts = 0;
    authFailures = 0;
    holdUntil = 0;
    if (everReady) stats.count('reconnects');
    everReady = true;
    stats.markOpen();
    setStatus('open');
    if (!resumed) {
      resumed = true;
      const state = resume?.() ?? {};
      writeText(JSON.stringify({ type: 'RESUME', rev: Number.isFinite(state.rev) ? state.rev : null, aids: [...pending.keys()].slice(-8) }));
      // Whatever the server never saw is applied now; whatever it already did is answered from its memory (same aid).
      for (const entry of pending.values()) writeText(entry.text);
    }
    if (active === socket) onOpen?.(connection);
  }

  const lossPercent = () => {
    const settled = recent.slice(0, -1); // the newest ping may still be on its way
    return settled.length ? Math.round((100 * settled.filter(entry => !entry.answered).length) / settled.length) : 0;
  };

  function ping() {
    const t = clock.now();
    recent.push({ t, answered: false });
    if (recent.length > 16) recent.shift();
    stats.count('pings');
    const message = { type: 'PING', t };
    if (Number.isFinite(rtt)) message.rtt = Math.round(Math.min(rtt, 9999));
    const loss = lossPercent();
    if (loss > 0) message.loss = loss;
    const reconnects = stats.snapshot().reconnects;
    if (reconnects > 0) message.rec = Math.min(reconnects, 999);
    return writeText(JSON.stringify(message));
  }

  function heartbeat(active) {
    if (active !== socket) return;
    if (!waiting && clock.now() - lastHeard > silenceMs) { abandon(active, 4000); return; }
    if (ready && !waiting) ping();
  }

  function terminate(dead) {
    dead.onopen = dead.onmessage = dead.onerror = dead.onclose = null;
    try { dead.terminate ? dead.terminate() : dead.close(); } catch { /* already gone */ }
  }

  /** Give up on a socket: do not wait for the operating system to notice it died. */
  function abandon(dead, code = 4000, reason = '') {
    if (dead !== socket) return;
    terminate(dead);
    socket = null;
    ready = false;
    waiting = false;
    clearSocketTimers();
    rtt = null;
    stats.markClosed(code, reason);
    if (FINAL.has(code)) { halt(FINAL.get(code), code); return; }
    if (code === CLOSE.AUTH) {
      authFailures++;
      if (authFailures >= 2) { halt('unauthorized', code); return; }
      setStatus('reconnecting');
      onClose?.({ code, status: 'reconnecting', final: false });
      schedule(0); // once, at once, with a fresh nonce
      return;
    }
    if (code === CLOSE.NOT_ADMITTED) {
      setStatus('locked');
      onClose?.({ code, status: 'locked', final: false });
      schedule(lockedRetryMs);
      return;
    }
    setStatus('reconnecting');
    onClose?.({ code, status: 'reconnecting', final: false });
    if (code === CLOSE.ABUSE) { holdUntil = clock.now() + abuseBackoffMs; schedule(abuseBackoffMs); return; }
    schedule();
  }

  // ── waking up ──────────────────────────────────────────────────────────────
  /** The device is awake again: replace a dead socket now, or check that a quiet one is alive. */
  function wake() {
    if (halted || connecting) return;
    if (clock.now() < holdUntil) return;
    if (!socket) {
      attempts = 0;
      connect();
    } else if (socket.readyState === OPEN && ready && !waiting) {
      const active = socket;
      ping();
      clock.clearTimeout(probeTimer);
      probeTimer = clock.setTimeout(() => abandon(active, 4000), probeMs);
    }
  }
  const win = () => env?.window ?? globalThis.window;
  const doc = () => env?.document ?? globalThis.document;
  const onVisible = () => { if (doc()?.visibilityState === 'visible') wake(); };
  function removeListeners() {
    win()?.removeEventListener?.('online', wake);
    win()?.removeEventListener?.('pageshow', wake);
    doc()?.removeEventListener?.('visibilitychange', onVisible);
  }
  win()?.addEventListener?.('online', wake);
  win()?.addEventListener?.('pageshow', wake);
  doc()?.addEventListener?.('visibilitychange', onVisible);

  connect();
  return connection;
}
