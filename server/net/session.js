// One Session per WebSocket: who it belongs to, its rate buckets, its strikes, its send queue health.
//
// A session never throws on bad input and never talks to other sessions. The hub owns the wiring; the policies that
// are about ONE socket (rate limits, strikes, backlog / stale / slow-close, counters) live here so they can be tested
// with a fake socket and a fake clock (design 4.5, 4.6, 4.13).
import { LIMITS, TYPE_CAPS, CLOSE } from '../../src/net/protocol.js';

const OPEN = 1;
const CONNECTING = 0;
const noop = () => {};

/**
 * Wraps a clock ({ now, setTimeout, clearTimeout, setInterval, clearInterval }) so that timer handles can always be
 * cancelled and never keep the process alive. Without a clock the real timers are used.
 */
export function timers(clock) {
  const c = clock ?? {};
  const now = typeof c.now === 'function' ? () => c.now() : () => Date.now();
  const unref = handle => { try { handle?.unref?.(); } catch { /* a fake clock may not have unref */ } return handle; };
  const setT = typeof c.setTimeout === 'function' ? (fn, ms) => c.setTimeout(fn, ms) : (fn, ms) => setTimeout(fn, ms);
  const clearT = typeof c.clearTimeout === 'function' ? h => c.clearTimeout(h) : h => clearTimeout(h);
  const setI = typeof c.setInterval === 'function' ? (fn, ms) => c.setInterval(fn, ms) : (fn, ms) => setInterval(fn, ms);
  const clearI = typeof c.clearInterval === 'function' ? h => c.clearInterval(h) : h => clearInterval(h);
  return {
    now,
    /** Run `fn` once after `ms`. Returns a function that cancels it. */
    after(ms, fn) {
      const handle = unref(setT(fn, ms));
      return () => clearT(handle);
    },
    /** Run `fn` every `ms`. Returns a function that stops it. */
    every(ms, fn) {
      const handle = unref(setI(fn, ms));
      return () => clearI(handle);
    },
  };
}

/** Metrics that tolerate a missing sink or a sink that throws (a broken counter must never break a socket). */
export function safeMetrics(metrics) {
  const call = (name, ...args) => {
    try { if (typeof metrics?.[name] === 'function') metrics[name](...args); } catch { /* never let accounting break the table */ }
  };
  return {
    inc: (name, n = 1) => call('inc', name, n),
    observe: (name, value) => call('observe', name, value),
    gauge: (name, value) => call('gauge', name, value),
    log: line => call('log', line),
  };
}

/** Token bucket: `burst` tokens, refilled at `perSec`. Time comes from the caller. */
export function createBucket({ burst, perSec }, now) {
  return { burst, perSec, tokens: burst, at: now };
}

export function takeToken(bucket, now) {
  const elapsed = Math.max(0, now - bucket.at);
  bucket.at = Math.max(bucket.at, now);
  bucket.tokens = Math.min(bucket.burst, bucket.tokens + (elapsed * bucket.perSec) / 1000);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

// Whole-socket flood limits on top of the per-type buckets (a client that rotates through all types is still bounded).
const GLOBAL_BUCKET = { player: { burst: 100, perSec: 60 }, gm: { burst: 200, perSec: 150 } };

let nextSessionId = 1;

export class Session {
  /**
   * @param {object} options
   * @param {object} options.socket     a `ws` WebSocket (or the fake of test-support/fakeSocket.js)
   * @param {'player'|'gm'} options.role
   * @param {object} [options.auth]     the ok-result of access.authenticateUpgrade: { device, playerId, name, ip, label, pending }
   * @param {object} [options.limits]   LIMITS (tests may shrink the times)
   * @param {object} [options.caps]     TYPE_CAPS
   * @param {object} [options.clock]
   * @param {object} [options.metrics]
   * @param {(session: Session) => void} [options.onAbuse]  called once when the strike limit closes the socket
   */
  constructor({ socket, role, auth = {}, limits = LIMITS, caps = TYPE_CAPS, clock, metrics, onAbuse }) {
    this.id = nextSessionId++;
    this.socket = socket;
    this.role = role;
    this.device = auth.device ?? null;
    this.playerId = auth.playerId ?? null;
    this.name = auth.name ?? '';
    this.ip = auth.ip ?? '';
    this.label = auth.label ?? '';
    this.pending = Boolean(auth.pending);
    this.rtt = null;
    this.loss = null;
    this.closed = false;
    this.limits = limits;
    this.caps = caps;
    this.t = timers(clock);
    this.m = safeMetrics(metrics);
    this.onAbuse = onAbuse;
    const now = this.t.now();
    this.connectedAt = now;
    this.lastSeen = now;
    // counters (diag)
    this.msgsIn = 0; this.msgsOut = 0; this.bytesIn = 0; this.bytesOut = 0; this.strikeCount = 0; this.dropped = 0;
    // sync state, owned by stateSync
    this.syncedRev = null;
    this.stale = false;
    this.staleSince = 0;
    this.overSince = null;
    this.lastFullAt = null;
    this.fullDue = null;
    // resume handshake, owned by the hub
    this.awaitingResume = false;
    this.resumeReceived = null;
    this.cancelResumeWait = null;
    // buckets
    this.buckets = new Map();
    const global = GLOBAL_BUCKET[role] ?? GLOBAL_BUCKET.player;
    this.globalBucket = createBucket(global, now);
    this.strikes = [];
    this.cancelClose = null;
  }

  get isOpen() { return !this.closed && this.socket?.readyState === OPEN; }
  get bufferedAmount() { return Number(this.socket?.bufferedAmount) || 0; }
  /** The label shown to others: the chosen name, or the device label. */
  get displayName() { return this.name || this.label; }

  /** Any frame or pong proves the peer is alive. */
  touch() { this.lastSeen = this.t.now(); }

  /** Rate check for one message type. Unknown types share a small default bucket. */
  allow(type) {
    const now = this.t.now();
    if (!takeToken(this.globalBucket, now)) return false;
    const cap = Object.hasOwn(this.caps, type) ? this.caps[type] : null;
    if (!cap || cap.burst === null || cap.burst === undefined) return true;
    let bucket = this.buckets.get(type);
    if (!bucket) { bucket = createBucket(cap, now); this.buckets.set(type, bucket); }
    return takeToken(bucket, now);
  }

  /** Record a protocol violation. Returns true when this one closed the socket. */
  violation(code) {
    this.m.inc(`reject.${code}`);
    this.dropped += 1;
    return this.strike();
  }

  strike() {
    this.strikeCount += 1;
    this.m.inc('strikes');
    const now = this.t.now();
    this.strikes.push(now);
    const from = now - this.limits.strikeWindowMs;
    while (this.strikes.length && this.strikes[0] < from) this.strikes.shift();
    // The GM comes from this very computer: its mistakes are counted, never punished.
    if (this.role !== 'player' || this.strikes.length < this.limits.strikesToClose) return false;
    this.m.inc('sessions.abuse');
    this.m.log(`abuse: closing ${this.ip} (${this.device ?? 'no device'}) after ${this.strikes.length} strikes`);
    try { this.onAbuse?.(this); } catch { /* ignore */ }
    this.close(CLOSE.ABUSE, 'Too many invalid messages');
    return true;
  }

  /** Send a prepared string. Returns false when the socket is not open or refused it. */
  send(text) {
    if (this.closed || this.socket?.readyState !== OPEN) return false;
    try {
      this.socket.send(text, error => { if (error) this.m.inc('sendErrors'); });
    } catch {
      this.m.inc('sendErrors');
      return false;
    }
    this.msgsOut += 1;
    this.bytesOut += Buffer.byteLength(text);
    return true;
  }

  /**
   * Send an object. `droppable` messages (a map ping) are skipped while the socket is backed up: nobody needs a
   * ping from ten seconds ago, and a stuck phone must not grow server memory.
   */
  sendJson(obj, { droppable = false } = {}) {
    if (droppable && this.bufferedAmount > this.limits.backlogStopBytes) { this.dropped += 1; this.m.inc('dropped.backlog'); return false; }
    let text;
    try { text = JSON.stringify(obj); } catch { this.m.inc('sendErrors'); return false; }
    return this.send(text);
  }

  // ── Backlog policy (4.5): stale -> one snapshot once drained -> closed 4009 when it never drains ────────────────
  markStale() {
    if (this.stale) return;
    this.stale = true;
    this.staleSince = this.t.now();
    this.m.inc('sessions.stale');
  }

  clearStale() { this.stale = false; this.overSince = null; }

  /** 'ok' | 'stale' (still backed up) | 'drained' (stale and ready for a snapshot) | 'closed' (gave up). */
  checkBacklog() {
    const now = this.t.now();
    const buffered = this.bufferedAmount;
    const { backlogStopBytes, backlogResumeBytes, slowCloseMs } = this.limits;
    if (this.stale) {
      if (buffered < backlogResumeBytes) return 'drained';
      if (now - this.staleSince >= slowCloseMs) return this.#slow();
      return 'stale';
    }
    if (buffered > backlogStopBytes) {
      this.overSince ??= now;
      if (now - this.overSince >= slowCloseMs) return this.#slow();
    } else this.overSince = null;
    return 'ok';
  }

  #slow() {
    this.m.inc('sessions.slow');
    this.m.log(`slow: closing ${this.ip} (${this.device ?? 'no device'}), ${this.bufferedAmount} bytes queued`);
    this.close(CLOSE.SLOW, 'Connection too slow');
    return 'closed';
  }

  /** Close politely; terminate if the peer does not finish the handshake within two seconds. */
  close(code = 1000, reason = '') {
    const socket = this.socket;
    if (!socket || socket.readyState > OPEN) return;
    if (socket.readyState !== OPEN && socket.readyState !== CONNECTING) return;
    try { socket.close(code, String(reason).slice(0, 100)); } catch { try { socket.terminate?.(); } catch { /* gone */ } }
    this.cancelClose?.();
    this.cancelClose = this.t.after(2000, () => { this.cancelClose = null; if (!this.closed) { try { socket.terminate?.(); } catch { /* gone */ } } });
  }

  terminate() {
    try { this.socket?.terminate?.(); } catch { /* gone */ }
  }

  /** Called by the hub when the socket's 'close' event fires. */
  markClosed() {
    this.closed = true;
    this.cancelClose?.();
    this.cancelClose = null;
    this.cancelResumeWait?.();
    this.cancelResumeWait = null;
  }

  /** What the status page shows for this socket. */
  describe() {
    return {
      id: this.id, role: this.role, device: this.device, ip: this.ip, label: this.label, rtt: this.rtt, loss: this.loss,
      backlogBytes: this.bufferedAmount, stale: this.stale, strikes: this.strikeCount,
      msgsIn: this.msgsIn, msgsOut: this.msgsOut, bytesIn: this.bytesIn, bytesOut: this.bytesOut, lastSeen: this.lastSeen,
    };
  }
}

export const createSession = options => new Session(options);

export { noop };
