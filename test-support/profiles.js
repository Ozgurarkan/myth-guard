// Impairment profiles shared by the TCP proxy (tcpImpair.js) and the UDP relay (udpImpair.js). Design 6.5.
//
// A profile has a steady part (delay, jitter, loss) and a list of timed events (stalls / blackouts).
// Everything random goes through an injectable `random` so a test can replay the same network.

export const PROFILE_NAMES = Object.freeze([
  'clean', 'good', 'busy', 'bad', 'jitter80', 'stall300', 'stall700', 'stall1000', 'drop400', 'roam', 'wifi',
]);

/** mulberry32: small seeded PRNG returning floats in [0, 1). */
export function seededRandom(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Gilbert-Elliott parameters for "average loss, mean burst length": the bad state drops everything,
 * leaves with probability q = 1 / meanBurst per packet, and is entered with probability p so that
 * the stationary share of the bad state equals `avgLoss` (share = p / (p + q)).
 */
export function geParams(avgLoss, meanBurst) {
  const q = 1 / meanBurst;
  return { p: (avgLoss * q) / (1 - avgLoss), q };
}

const none = () => [];
const every = (startMs, stepMs, holdMs, kind = 'hold') => (seconds) => {
  const out = [];
  for (let at = startMs; at < seconds * 1000; at += stepMs) out.push({ atMs: at, holdMs, kind });
  return out;
};

// Steady parts: tcp = { baseMs, jitterMs, loss (per 1460-byte segment, each loss costs a 300 ms RTO) }
//               udp = { delay, jitter, loss, burst: { p, q } | null }
const DEFS = {
  clean: { about: 'loopback', tcp: { baseMs: 0, jitterMs: 0, loss: 0 }, udp: { delay: 0, jitter: 0, loss: 0, burst: null }, events: none },
  good: {
    about: 'healthy home Wi-Fi',
    tcp: { baseMs: 3, jitterMs: 10, loss: 0.005 }, udp: { delay: 3, jitter: 10, loss: 0.005, burst: null }, events: none,
  },
  busy: {
    about: 'several phones active',
    tcp: { baseMs: 8, jitterMs: 25, loss: 0.03 }, udp: { delay: 8, jitter: 25, loss: 0.03, burst: null }, events: none,
  },
  bad: {
    about: 'weak signal',
    tcp: { baseMs: 15, jitterMs: 60, loss: 0.06 }, udp: { delay: 15, jitter: 60, loss: 0, burst: geParams(0.05, 4) }, events: none,
  },
  jitter80: {
    about: 'bufferbloat-like',
    tcp: { baseMs: 5, jitterMs: 80, loss: 0 }, udp: { delay: 5, jitter: 80, loss: 0, burst: null }, events: none,
  },
  stall300: { about: 'queueing stall 300 ms every 10 s', tcp: { baseMs: 0, jitterMs: 0, loss: 0 }, udp: { delay: 0, jitter: 0, loss: 0, burst: null }, events: every(8000, 10000, 300) },
  stall700: { about: 'queueing stall 700 ms every 10 s', tcp: { baseMs: 0, jitterMs: 0, loss: 0 }, udp: { delay: 0, jitter: 0, loss: 0, burst: null }, events: every(8000, 10000, 700) },
  stall1000: { about: 'queueing stall 1000 ms every 15 s', tcp: { baseMs: 0, jitterMs: 0, loss: 0 }, udp: { delay: 0, jitter: 0, loss: 0, burst: null }, events: every(8000, 15000, 1000) },
  drop400: { about: 'blackout without queueing, 400 ms every 10 s (UDP only)', tcp: null, udp: { delay: 0, jitter: 0, loss: 0, burst: null }, events: every(8000, 10000, 400, 'drop') },
  roam: {
    about: 'one 3 s outage',
    tcp: { baseMs: 0, jitterMs: 0, loss: 0 }, udp: { delay: 0, jitter: 0, loss: 0, burst: null },
    events: seconds => (seconds * 1000 > 10000 ? [{ atMs: 10000, holdMs: 3000, kind: 'hold' }] : []),
  },
  wifi: {
    about: 'mixed real-life Wi-Fi: stalls 250-700 ms every 9-15 s and one 1300 ms stall',
    tcp: { baseMs: 4, jitterMs: 25, loss: 0 }, udp: { delay: 4, jitter: 25, loss: 0, burst: { p: 0.004, q: 0.3 } },
    events: (seconds, random = Math.random) => {
      const out = [];
      for (let at = 7000; at < seconds * 1000; at += 9000 + random() * 6000) out.push({ atMs: Math.round(at), holdMs: Math.round(250 + random() * 450), kind: 'hold' });
      if (seconds * 1000 > 25000) out.push({ atMs: 25000, holdMs: 1300, kind: 'hold' });
      return out.sort((a, b) => a.atMs - b.atMs);
    },
  },
};

/** -> { name, about, tcp|null, udp|null } (copies; callers may modify them). */
export function getProfile(name) {
  const def = DEFS[name];
  if (!def) throw new Error(`Unknown impairment profile "${name}". Known: ${PROFILE_NAMES.join(', ')}`);
  return {
    name,
    about: def.about,
    tcp: def.tcp ? { ...def.tcp } : null,
    udp: def.udp ? { ...def.udp, burst: def.udp.burst ? { ...def.udp.burst } : null } : null,
  };
}

/** Timed events of a profile for a run of `seconds`: [{ atMs, holdMs, kind: 'hold' | 'drop' }]. Pure. */
export function eventsFor(name, seconds, random = Math.random) {
  if (!DEFS[name]) getProfile(name);
  return DEFS[name].events(seconds, random);
}

export const supports = (name, kind) => Boolean(getProfile(name)[kind]);

/**
 * Put a TCP proxy (tcpImpair.js) or a UDP relay (udpImpair.js) into a profile and schedule its events.
 * `kind` is 'tcp' or 'udp'. Returns { events, stop() }; stop() cancels events that have not fired yet.
 */
export function applyProfile(target, kind, name, { seconds = 60, random = Math.random, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const profile = getProfile(name);
  const steady = profile[kind];
  if (!steady) throw new Error(`Profile "${name}" is not defined for ${kind.toUpperCase()}`);
  const events = eventsFor(name, seconds, random);
  if (kind === 'tcp') {
    Object.assign(target.state, { baseMs: steady.baseMs, jitterMs: steady.jitterMs, loss: steady.loss });
  } else {
    Object.assign(target.impair, steady);
  }
  const timers = events.map(event => setTimer(() => {
    if (kind === 'tcp') target.stall(event.holdMs);
    else target.blackout(event.holdMs, event.kind === 'hold');
  }, event.atMs));
  return { name, events, stop: () => timers.forEach(timer => clearTimer(timer)) };
}
