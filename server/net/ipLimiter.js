// Per-address limits: how many sockets, how many requests per minute, and who is banned (design 4.8, test group D).
// All state is in memory, keyed by the peer's IP as the kernel reports it (it cannot be spoofed over TCP), and bounded.
import { LIMITS } from '../../src/net/protocol.js';

/** A token bucket: `capacity` tokens at most, refilled at `perSec`. `take()` is false when it is empty. */
export function createBucket({ capacity, perSec }, clock) {
  let tokens = capacity;
  let at = clock.now();
  const refill = () => {
    const now = clock.now();
    if (now > at) tokens = Math.min(capacity, tokens + ((now - at) / 1000) * perSec);
    at = now;
  };
  return {
    take(count = 1) {
      refill();
      if (tokens < count) return false;
      tokens -= count;
      return true;
    },
    peek(count = 1) { refill(); return tokens >= count; },
    get tokens() { refill(); return tokens; },
    get idleMs() { return clock.now() - at; },
  };
}

const perMinute = count => ({ capacity: count, perSec: count / 60 });

export const DEFAULT_BUCKETS = Object.freeze({
  hello: perMinute(LIMITS.helloPerIpPerMin),
  join: perMinute(LIMITS.joinPerIpPerMin),
  upgrade: { capacity: 30, perSec: 2 },          // WebSocket upgrades: generous for a reconnect storm, small for a flood
  assetMiss: perMinute(20),                       // refused or missing image requests (E3)
});

/**
 * @param clock  { now() }
 * @param {object} [options]
 * @param {object} [options.limits]  defaults to LIMITS from src/net/protocol.js
 * @param {object} [options.buckets]  per-IP bucket definitions by name (merged over DEFAULT_BUCKETS)
 * @param {(ip: string) => boolean} [options.exempt]  addresses that are never banned or struck (the GM's own computer)
 * @param {number} [options.maxTracked]  how many addresses are remembered at once
 */
export function createIpLimiter(clock, { limits = LIMITS, buckets = {}, exempt = () => false, maxTracked = 4096 } = {}) {
  const definitions = { ...DEFAULT_BUCKETS, ...buckets };
  const sockets = new Map();   // ip -> open sockets
  const bans = new Map();      // ip -> ban end (ms)
  const strikes = new Map();   // ip -> [timestamps]
  const hits = new Map();      // ip -> Map(name -> bucket)
  let total = 0;
  let operations = 0;

  const sweep = () => {
    const now = clock.now();
    for (const [ip, until] of bans) if (until <= now) bans.delete(ip);
    for (const [ip, list] of strikes) {
      while (list.length && now - list[0] > 60_000) list.shift();
      if (!list.length) strikes.delete(ip);
    }
    for (const [ip, named] of hits) {
      for (const [name, bucket] of named) if (bucket.idleMs > 120_000) named.delete(name);
      if (!named.size) hits.delete(ip);
    }
  };
  const tick = () => { if (++operations % 256 === 0) sweep(); };
  const room = map => {
    // Bounded memory: when a map is full, forget the oldest entry.
    if (map.size >= maxTracked) map.delete(map.keys().next().value);
  };

  const banned = ip => {
    tick();
    const until = bans.get(ip);
    if (until === undefined) return false;
    if (until <= clock.now()) { bans.delete(ip); return false; }
    return true;
  };

  const limiter = {
    banned,
    bannedUntil: ip => (banned(ip) ? bans.get(ip) : 0),
    ban(ip, ms = limits.banMs) {
      if (!ip || exempt(ip)) return false;
      room(bans);
      bans.set(ip, clock.now() + ms);
      return true;
    },
    unban(ip) { bans.delete(ip); strikes.delete(ip); },
    /**
     * Records `count` failed proofs from `ip`. `failedProofsBeforeBan` of them within a minute ban the address for
     * `banMs`. Returns true when the address is banned afterwards.
     */
    strike(ip, count = 1) {
      if (!ip || exempt(ip)) return false;
      tick();
      const now = clock.now();
      let list = strikes.get(ip);
      if (!list) { room(strikes); list = []; strikes.set(ip, list); }
      for (let i = 0; i < count; i++) list.push(now);
      while (list.length && now - list[0] > 60_000) list.shift();
      if (list.length >= limits.failedProofsBeforeBan) {
        strikes.delete(ip);
        limiter.ban(ip, limits.banMs);
      }
      return banned(ip);
    },
    strikesOf(ip) {
      const now = clock.now();
      return (strikes.get(ip) ?? []).filter(at => now - at <= 60_000).length;
    },

    /** Would a new socket from `ip` be accepted? (does not count it) */
    canOpen(ip) {
      if (banned(ip)) return false;
      if (total >= limits.maxSocketsTotal) return false;
      return (sockets.get(ip) ?? 0) < limits.maxSocketsPerIp;
    },
    /** Counts a new socket; false when the per-IP or the global cap is reached (or the address is banned). */
    openSocket(ip) {
      if (!limiter.canOpen(ip)) return false;
      if (!sockets.has(ip)) room(sockets);
      sockets.set(ip, (sockets.get(ip) ?? 0) + 1);
      total += 1;
      return true;
    },
    closeSocket(ip) {
      const count = sockets.get(ip);
      if (!count) return;
      if (count <= 1) sockets.delete(ip); else sockets.set(ip, count - 1);
      total = Math.max(0, total - 1);
    },

    /** Takes one token from the named per-IP bucket. False when the address is over its rate. */
    hit(ip, name) {
      const definition = definitions[name];
      if (!definition) throw new RangeError(`ipLimiter: unknown bucket "${name}"`);
      tick();
      let named = hits.get(ip);
      if (!named) { room(hits); named = new Map(); hits.set(ip, named); }
      let bucket = named.get(name);
      if (!bucket) { bucket = createBucket(definition, clock); named.set(name, bucket); }
      return bucket.take();
    },
    /** True when the named bucket still has a token for `ip` (nothing is taken). */
    peek(ip, name) {
      const definition = definitions[name];
      if (!definition) throw new RangeError(`ipLimiter: unknown bucket "${name}"`);
      const bucket = hits.get(ip)?.get(name);
      return bucket ? bucket.peek() : true;
    },
    get totalSockets() { return total; },
    socketsOf: ip => sockets.get(ip) ?? 0,
    stats: () => ({ sockets: total, addresses: sockets.size, bans: bans.size }),
  };
  return limiter;
}
