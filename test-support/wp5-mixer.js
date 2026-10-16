// WP5 test support: a model of what the browser does with the operations `playout.js` emits, plus a simulated sender and a
// simulated network, so the scheduler can be judged by what would come out of the speaker.
//
//   simulate({ seconds, net, playout })  -> { samples, analysis, latency, ops, stats, violations }
//
// The mixer renders every segment sample by sample: a segment plays frames [off, off+n) of its packet at `rate`, times a
// linear fade in and fade out and a constant gain; overlapping segments add. The source is a steady 440 Hz sine of amplitude
// 0.5 whose phase depends only on the sample's position in the stream, so any hole, repeat, or skip that is not smoothed
// shows up as silence or as a jump between neighbouring samples (the sine's own largest step is 0.03).
//
// `ops` are applied exactly as the receiver applies them: `cancel` only helps before a segment has started, `update` only
// changes the part of a fade that is still in the future, a `play` after its start time starts late. Anything that would be
// wrong on a real AudioContext is counted in `violations`.
import { createPlayout } from '../src/audio/playout.js';

export const RATE = 48000;
export const FRAMES = 4096;
export const PACKET = FRAMES / RATE; // 85.33 ms
const FREQ = 440;
const AMP = 0.5;

/** The test signal at a (possibly fractional) stream position in samples. */
export const sine = position => AMP * Math.sin((2 * Math.PI * FREQ * position) / RATE);

export function createMixerModel() {
  const entries = new Map();
  const v = { lateStarts: 0, lateCancels: 0, lateUpdates: 0, unknownUpdates: 0 };
  return {
    violations: v,
    apply(ops, now) {
      for (const op of ops) {
        if (op.op === 'play') {
          if (op.seg.at < now - 1e-9) v.lateStarts++;
          entries.set(op.seg.id, { seg: { ...op.seg, entry: undefined }, updatedAt: -Infinity, cancelled: false });
        } else if (op.op === 'update') {
          const e = entries.get(op.seg.id);
          if (!e) { v.unknownUpdates++; continue; }
          if (now > Math.min(e.seg.end, op.seg.stopAt ?? Infinity) - 1e-9) v.lateUpdates++;
          e.seg.fadeOut = op.seg.fadeOut;
          e.seg.stopAt = op.seg.stopAt;
          e.updatedAt = now;
        } else if (op.op === 'cancel') {
          const e = entries.get(op.id);
          if (!e) continue;
          if (e.seg.at < now) v.lateCancels++;
          else e.cancelled = true;
        }
      }
    },
    entries: () => [...entries.values()].filter(e => !e.cancelled),
    /** Render [0, seconds) to samples at RATE. */
    render(seconds) {
      const out = new Float32Array(Math.ceil(seconds * RATE));
      for (const { seg, updatedAt } of this.entries()) {
        const end = Math.min(seg.end, seg.stopAt ?? Infinity);
        const first = Math.max(0, Math.ceil(seg.at * RATE));
        const lastI = Math.min(out.length - 1, Math.ceil(end * RATE) - 1); // [at, end): a boundary sample belongs to the later segment
        const rampStart = seg.fadeOut > 0 ? Math.max(updatedAt, end - seg.fadeOut) : Infinity;
        for (let i = first; i <= lastI; i++) {
          const t = i / RATE;
          const local = t - seg.at;
          let g = seg.gain;
          if (seg.fadeIn > 0 && local < seg.fadeIn) g *= local / seg.fadeIn;
          if (t > rampStart && end > rampStart) g *= Math.max(0, (end - t) / (end - rampStart));
          out[i] += g * sine(seg.src * FRAMES + seg.off + local * seg.srate * seg.rate);
        }
      }
      return out;
    },
  };
}

/** Holes (digital silence) and jumps in a rendered steady sine. Leading and trailing silence do not count. */
export function analyze(samples, { silenceEps = 1e-4, minHoleMs = 10, jump = 0.12 } = {}) {
  let first = 0;
  while (first < samples.length && Math.abs(samples[first]) < silenceEps) first++;
  let lastSound = samples.length - 1;
  while (lastSound > first && Math.abs(samples[lastSound]) < silenceEps) lastSound--;
  const holes = [];
  const jumps = [];
  let run = 0;
  let maxStep = 0;
  for (let i = first + 1; i <= lastSound; i++) {
    const x = samples[i];
    if (Math.abs(x) < silenceEps) run++;
    else {
      if (run * 1000 >= minHoleMs * RATE) holes.push({ atS: (i - run) / RATE, ms: (run * 1000) / RATE });
      run = 0;
      const step = Math.abs(x - samples[i - 1]);
      if (step > maxStep && samples[i - 1] !== 0) maxStep = step;
      if (step > jump && Math.abs(samples[i - 1]) >= silenceEps) jumps.push({ atS: i / RATE, size: step });
    }
  }
  return { first: first / RATE, last: lastSound / RATE, holes, jumps, maxStep, dropouts: holes.length, discontinuities: jumps.length,
    silenceMs: holes.reduce((s, h) => s + h.ms, 0) };
}

// ---- network profiles (design 6.5, WebSocket column) -------------------------------------------------------------------
// Each profile returns { base, jitter, tcpLoss, holds: [[startS, lengthS], ...] }. Delivery is strictly FIFO (a TCP stream).
export const PROFILES = {
  clean: () => ({ base: 0.001, jitter: 0, holds: [] }),
  good: () => ({ base: 0.003, jitter: 0.01, tcpLoss: 0.005, holds: [] }),
  busy: () => ({ base: 0.008, jitter: 0.025, tcpLoss: 0.03, holds: [] }),
  bad: () => ({ base: 0.015, jitter: 0.06, tcpLoss: 0.06, holds: [] }),
  jitter80: () => ({ base: 0.005, jitter: 0.08, holds: [] }),
  stall300: seconds => ({ base: 0.003, jitter: 0.01, holds: every(8, 12, 0.3, seconds) }),
  stall700: seconds => ({ base: 0.003, jitter: 0.01, holds: every(8, 12, 0.7, seconds) }),
  stall1000: seconds => ({ base: 0.003, jitter: 0.01, holds: every(8, 15, 1.0, seconds) }),
  roam: () => ({ base: 0.003, jitter: 0.01, holds: [[10, 3]] }),
  wifi: seconds => ({ base: 0.004, jitter: 0.025, holds: [...every(7, 12, 0.45, seconds), [25, 1.3]] }),
};
function every(start, step, length, seconds) {
  const list = [];
  for (let t = start; t < seconds; t += step) list.push([t, length]);
  return list;
}

/** Small deterministic random numbers so a failing run can be repeated. */
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/**
 * Run a simulated sender -> relay -> network -> playout -> mixer for `seconds` of sender time.
 *
 * net:   a profile object (see PROFILES) plus optional
 *          relayQueue (default 8): during a hold the relay keeps only this many newest packets (older ones are skipped)
 *          kernel (default 10):    packets already written to the socket when the hold begins (they are delivered late, in order)
 *          reorder: probability that a packet swaps places with its successor (an unordered transport)
 *          lose: probability that a packet is lost for good (an unordered transport)
 * drift: sender clock rate error in ppm (positive: the sender's clock is fast relative to the phone's)
 * freezes: [[startS, lengthS], ...] windows in which the phone's main thread is blocked (events wait for the end)
 * pumpEvery: seconds between timer pumps (default 0.025)
 * playout: options for createPlayout
 */
export function simulate({ seconds = 40, net = PROFILES.clean(), seed = 1, drift = 0, freezes = [], pumpEvery = 0.025, playout = {}, startAt = 1, dupes = 0 } = {}) {
  const random = rng(seed);
  const count = Math.floor(seconds / PACKET);
  const speed = 1 + drift * 1e-6;
  const sendTime = k => startAt + (k * PACKET) / speed;

  // --- network: arrival time of every packet -------------------------------------------------------------------------
  const holds = net.holds ?? [];
  const relayQueue = net.relayQueue ?? 8;
  const kernel = net.kernel ?? 10;
  const arrivals = [];
  let last = -Infinity;
  const heldIn = new Map(); // hold index -> packets whose natural arrival falls inside it
  let flagsFor = new Map();
  for (let k = 0; k < count; k++) {
    const sent = sendTime(k);
    let at = sent + (net.base ?? 0) + random() * (net.jitter ?? 0);
    if (net.tcpLoss) {
      const segments = Math.ceil((FRAMES * 0.5 + 28) / 1460);
      for (let s = 0; s < segments; s++) if (random() < net.tcpLoss) { at += 0.3; break; }
    }
    arrivals.push({ k, at, sent });
  }
  // holds: packets arriving inside a hold are released at its end, keeping only the kernel buffer's first packets and the relay's newest
  holds.forEach(([start, length], index) => {
    const end = start + length;
    const inside = arrivals.filter(a => a.at >= start && a.at < end && a.dropped !== true);
    heldIn.set(index, inside);
    const keep = new Set(inside.slice(0, kernel).concat(inside.slice(Math.max(kernel, inside.length - relayQueue))));
    let skipped = 0;
    for (const a of inside) {
      if (keep.has(a)) { if (skipped) { flagsFor.set(a.k, Math.min(255, skipped)); skipped = 0; } a.at = end + 0.0005 * (a.k % 7); }
      else { a.dropped = true; skipped++; }
    }
  });
  const delivered = arrivals.filter(a => !a.dropped);
  if (!net.reorder && !net.lose) {
    for (const a of delivered) { a.at = Math.max(a.at, last); last = a.at; } // FIFO
  } else {
    for (const a of delivered) { if (random() < (net.reorder ?? 0)) a.at += PACKET * (0.5 + random()); }
  }
  const events = [];
  for (const a of delivered) {
    if (random() < (net.lose ?? 0)) continue;
    events.push({ time: a.at, type: 'packet', k: a.k });
    if (random() < dupes) events.push({ time: a.at + 0.01, type: 'packet', k: a.k });
  }
  for (let t = 0; t < seconds + 6; t += pumpEvery) events.push({ time: t, type: 'pump' });
  // a frozen main thread runs everything that was waiting when it wakes up
  const adjusted = events.map((e, i) => {
    let time = e.time;
    for (const [fs, fl] of freezes) if (time >= fs && time < fs + fl) time = fs + fl;
    return { ...e, time, order: i };
  });
  adjusted.sort((a, b) => a.time - b.time || a.order - b.order);

  // --- run -----------------------------------------------------------------------------------------------------------
  let now = 0;
  const player = createPlayout({ clock: () => now, ...playout });
  const model = createMixerModel();
  const opsLog = [];
  const sendBase = seq => (seq >>> 0);
  for (const e of adjusted) {
    now = e.time;
    let ops;
    if (e.type === 'pump') ops = player.pump(now);
    else ops = player.push({ seq: sendBase(e.k), ts: e.k * FRAMES, frames: FRAMES, rate: RATE, flags: flagsFor.get(e.k) ?? 0 });
    if (ops.length) { model.apply(ops, now); opsLog.push(...ops.map(op => ({ time: now, op: op.op }))); }
  }
  const end = seconds + 4;
  const samples = model.render(end);
  const analysis = analyze(samples);
  // latency of a real segment = when it plays minus when its first sample was produced
  const lat = model.entries().filter(e => e.seg.kind === 'real').map(({ seg }) => ({ at: seg.at, ms: (seg.at - (startAt + (seg.src * FRAMES + seg.off) / RATE / speed)) * 1000 }))
    .sort((a, b) => a.at - b.at);
  const latency = {
    startMs: lat[10]?.ms, endMs: lat.at(-1)?.ms, maxMs: Math.max(...lat.map(l => l.ms)),
    series: lat,
    // time from the end of the last freeze/hold until latency is back below `limit`
    recoveredWithin(limitMs, afterS) { const l = lat.find(x => x.at >= afterS && x.ms <= limitMs); return l ? l.at - afterS : Infinity; },
  };
  return { samples, analysis, latency, ops: opsLog, stats: player.stats(), violations: model.violations, model, player };
}
