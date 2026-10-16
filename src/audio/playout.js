// The fallback path's playout scheduler (design 5.4). Pure: it never touches an AudioContext, a timer or a socket.
//
// The receiver tells it about packets (`push`) and calls `pump()` every ~25 ms; both return a list of OPERATIONS that the
// receiver carries out on a real AudioContext (wsReceiver.js) and a test carries out on a model mixer (test-support/wp5-mixer.js):
//
//   { op:'play',   seg }   start a piece of a packet at seg.at (AudioContext time) ...
//   { op:'update', seg }   ... the same segment, with a changed fadeOut / stopAt (only ever called before the change matters)
//   { op:'cancel', id }    a segment that has not started yet is withdrawn
//
// A segment is `{ id, kind:'real'|'conceal', src, off, n, srate, rate, gain, fadeIn, fadeOut, at, len, end, stopAt? }`:
// play frames [off, off+n) of packet `src` (its sample rate `srate`) at playbackRate `rate`, scaled by `gain`, with a linear
// fade in over `fadeIn` seconds from `at` and a linear fade out over the last `fadeOut` seconds before `end`.
//
// What it decides, in one place and with no hidden state other than the target delay T:
//   * packets are placed by sequence number; late and duplicate packets are dropped; the sequence wraps at 2^32
//   * start: wait until T seconds are queued. Underrun: fade the tail out (5 ms), wait until T/2 is queued, fade in.
//   * a gap of up to `maxConceal` packets is covered by looping the tail of the last packet with 3 ms crossfades and a decay
//     (no click, no hole); a longer gap is a skip: sound continues at once from the newer packet with a 5 ms crossfade.
//   * a burst after a stall that leaves more than T + `overflow` buffered is cut back to T from the OLDEST end (segments that
//     have not started are cancelled, the oldest packets are discarded): lateness is recovered, not kept.
//   * slow drift between the sender's and the phone's clock is absorbed by a tiny playbackRate trim (at most +-0.3 %, slewed),
//     never by a jump. Every segment boundary is sample-continuous at any rate.
//   * T is the only adaptive state: it grows to 1.5 x the gap after an underrun (cap `maxTarget`), to 1.3 x the worst recent
//     lateness, and decays 10 % per 10 s of clean play back to `floor`.
import { createJitter } from './jitter.js';

export const PLAYOUT_DEFAULTS = Object.freeze({
  target: 1.2,        // initial T, seconds (design 5.4 says 0.9; its own acceptance table needs > 1.0 s to absorb a 1 s stall)
  floor: 1.2,         // T never decays below this (it only grows after an underrun and then falls back to here)
  maxTarget: 2.5,
  restartFraction: 0.5, // after an underrun wait until T * this (at most restartMax) is queued
  restartMax: 0.75,
  fade: 0.005,        // fade in/out and crossfade length
  overflow: 0.15,     // cut back to T when more than T + overflow is buffered
  guard: 0.05,        // segments starting less than this far ahead are treated as already running
  lowWater: 0.04,     // buffer level at which an empty queue is answered with a fade-out
  leadIn: 0.03,       // delay between "start now" and the first sample (time for the receiver to build nodes)
  maxConceal: 2,      // packets
  loop: 0.024,        // concealment loops the last 24 ms of the previous packet
  loopFade: 0.003,
  concealDecay: 0.25, // seconds until a concealed sound has faded away
  ordered: true,      // the transport delivers in order (WebSocket): a gap is permanent
  trimGain: 0.02, maxTrim: 0.003, deadband: 0.05, slew: 0.0005, // drift controller
  decayEvery: 10, decayFactor: 0.9,
  lateGrow: 1.3,
});

export function createPlayout(options = {}) {
  const cfg = { ...PLAYOUT_DEFAULTS, ...options };
  const clock = options.clock;
  if (typeof clock !== 'function') throw new TypeError('createPlayout needs clock: () => seconds on the audio clock');
  const jitter = createJitter({ rate: 48000 });
  const emit = (name, data) => { try { options.onEvent?.(name, { ...data, at: clock() }); } catch { /* a listener must not break playout */ } };

  let mode = 'idle'; // idle | buffering | playing
  let queue = [];    // packets not yet scheduled, sorted by ext: { ext, seq, frames, srate, dur }
  let expect = null; // ext of the next packet to schedule
  let nextTime = 0;  // audio-clock time where the next segment starts
  let segs = [];     // live segments, in time order
  let lastReal = null; // { ext, frames, srate }: source for concealment
  let T = cfg.target;
  let cleanSince = 0;
  let gapStart = null;
  let join = false;      // the next segment continues after a content jump: crossfade
  let freshFade = false; // the next segment starts after silence: fade in
  let curRate = 1;
  let level = null;
  let nextId = 1;
  let staleStreak = { last: 0, count: 0 };
  const c = {
    pushed: 0, played: 0, late: 0, duplicates: 0, underruns: 0, hardCuts: 0, concealedPackets: 0, jumps: 0, trimmed: 0,
    trims: 0, stale: 0, rebases: 0, relaySkipped: 0, resets: 0, startups: 0, silentSeconds: 0,
  };

  const dur = e => e.frames / e.srate;
  const queued = () => queue.reduce((s, e) => s + dur(e), 0);
  const last = () => segs[segs.length - 1] ?? null;
  const prune = now => { while (segs.length && segs[0].end <= now) segs.shift(); };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function insert(entry) {
    let i = queue.length;
    while (i > 0 && queue[i - 1].ext > entry.ext) i--;
    queue.splice(i, 0, entry);
  }

  function fadeTail(seg, ops, length = cfg.fade) {
    seg.fadeOut = Math.min(length, seg.len);
    ops.push({ op: 'update', seg });
    return seg.fadeOut;
  }

  function addSeg(seg, ops) {
    seg.id = nextId++;
    seg.end = seg.at + seg.len;
    segs.push(seg);
    ops.push({ op: 'play', seg });
    return seg;
  }

  // ---- placing real packets --------------------------------------------------------------------------------------
  function place(entry, now, ops) {
    const len = entry.frames / (entry.srate * curRate);
    let at = nextTime;
    let fadeIn = 0;
    if (freshFade) { fadeIn = cfg.fade; freshFade = false; join = false; }
    else if (join) {
      join = false;
      const prev = last();
      const room = Math.max(0, nextTime - now - 0.002);
      const x = prev && prev.end > now ? Math.min(cfg.fade, prev.len, room) : 0;
      if (x >= 0.0005) { fadeTail(prev, ops, x); at = nextTime - x; fadeIn = x; }
      else { fadeIn = cfg.fade; if (prev && prev.end > now) c.hardCuts++; }
    }
    addSeg({ kind: 'real', src: entry.ext, entry, data: entry.data, off: 0, n: entry.frames, srate: entry.srate, rate: curRate, gain: 1, fadeIn, fadeOut: 0, at, len }, ops);
    nextTime = at + len;
    lastReal = { ext: entry.ext, frames: entry.frames, srate: entry.srate, data: entry.data };
    c.played++;
  }

  // ---- concealing a short gap ------------------------------------------------------------------------------------
  function conceal(gap, now, ops) {
    const { srate, frames } = lastReal;
    const x = cfg.loopFade;
    const period = Math.min(cfg.loop, frames / srate);
    const total = gap * (frames / srate);
    const prev = last();
    // The first loop fades in while the tail of the previous segment fades out (a crossfade of `lead` seconds).
    let lead = 0;
    if (prev && prev.end > now + 0.002) {
      lead = Math.min(x, prev.len, nextTime - now - 0.002);
      if (lead >= 0.0005) fadeTail(prev, ops, lead); else lead = 0;
    }
    const k = Math.max(1, Math.ceil((total + lead - x) / (period - x)));
    const each = (total + lead + (k - 1) * x) / k;
    const start = nextTime - lead;
    const n = Math.min(frames, Math.max(1, Math.round(each * srate)));
    for (let j = 0; j < k; j++) {
      const at = start + j * (each - x);
      const gain = Math.max(0, 1 - (j * (each - x)) / cfg.concealDecay);
      addSeg({ kind: 'conceal', src: lastReal.ext, data: lastReal.data, off: frames - n, n, srate, rate: 1, gain,
        fadeIn: j === 0 ? (lead || x) : x, fadeOut: j === k - 1 ? 0 : x, at, len: n / srate }, ops);
    }
    nextTime += total;
    join = true;
    c.concealedPackets += gap;
    emit('conceal', { gap });
  }

  // ---- the scheduling loop ---------------------------------------------------------------------------------------
  function schedule(now, ops) {
    let placed = false;
    while (queue.length) {
      const head = queue[0];
      if (head.ext < expect) { queue.shift(); c.late++; continue; }
      if (head.ext === expect) { queue.shift(); place(head, now, ops); expect++; placed = true; continue; }
      const gap = head.ext - expect;
      if (!cfg.ordered && nextTime - now > cfg.guard + cfg.lowWater) break; // an unordered transport may still deliver it
      if (gap <= cfg.maxConceal && lastReal) {
        conceal(gap, now, ops);
        expect = head.ext;
      } else {
        expect = head.ext;
        join = true;
        c.jumps++;
        emit('jump', { gap });
      }
    }
    return placed;
  }

  // ---- cutting back an oversized buffer from the oldest end ---------------------------------------------------------
  function trim(now, ops) {
    const future = segs.filter(s => s.at >= now + cfg.guard);
    if (!future.length) return;
    const kept = segs.filter(s => s.at < now + cfg.guard);
    for (const s of future) {
      ops.push({ op: 'cancel', id: s.id });
      if (s.kind === 'real') { insert(s.entry); c.played--; }
    }
    segs = kept;
    const tail = last();
    const realKept = [...kept].reverse().find(s => s.kind === 'real');
    lastReal = realKept ? { ext: realKept.src, frames: realKept.entry.frames, srate: realKept.srate, data: realKept.data } : lastReal;
    const end = tail ? tail.end : now + cfg.leadIn;
    const wanted = Math.max(0, T - (end - now));
    let total = queued();
    let dropped = 0;
    while (queue.length > 1 && total - dur(queue[0]) >= wanted) { total -= dur(queue.shift()); dropped++; }
    nextTime = end;
    if (queue.length) expect = queue[0].ext;
    if (tail) join = true; else freshFade = true;
    c.trimmed += dropped;
    c.trims++;
    emit('trim', { dropped });
  }

  // ---- states ----------------------------------------------------------------------------------------------------
  function tryStart(now) {
    if (!queue.length) return;
    // Packets that arrived later than T behind their best pace are already past their slot: they are old news.
    // A burst after a stall has lateness that FALLS by a packet each time. Lateness that stays the same means the sender's clock
    // paused (capture suspended and resumed) or the path got slower for good: nothing is old, the baseline moved.
    while (queue.length > 1 && queue[0].lateness > T) {
      const l = queue[0].lateness;
      staleStreak = staleStreak.count && Math.abs(l - staleStreak.last) < 0.06 ? { last: l, count: staleStreak.count + 1 } : { last: l, count: 1 };
      if (staleStreak.count >= 3) {
        jitter.rebase();
        for (const e of queue) e.lateness = 0;
        staleStreak = { last: 0, count: 0 };
        emit('rebase', { lateness: l });
        c.rebases++;
        break;
      }
      emit('stale', { lateness: l, ext: queue[0].ext });
      queue.shift();
      c.stale++;
    }
    const need = mode === 'idle' ? T : Math.min(cfg.restartMax, cfg.restartFraction * T);
    let total = queued();
    if (total < need) return;
    while (queue.length > 1 && total - dur(queue[0]) >= T) { total -= dur(queue.shift()); c.trimmed++; }
    expect = queue[0].ext;
    nextTime = now + cfg.leadIn;
    freshFade = true;
    join = false;
    level = null;
    if (gapStart !== null) {
      const gap = nextTime - gapStart;
      c.silentSeconds += gap;
      T = clamp(Math.max(T, 1.5 * gap), cfg.floor, cfg.maxTarget);
      emit('restart', { gap, target: T });
      gapStart = null;
    } else c.startups++;
    cleanSince = now;
    mode = 'playing';
  }

  function pump(at) {
    const now = at ?? clock();
    const ops = [];
    prune(now);
    if (mode === 'playing' && nextTime <= now + 0.002) {
      // The chain ran dry before we could fade it (the thread was blocked): nothing left to soften.
      c.underruns++; c.hardCuts++;
      emit('underrun', { hard: true });
      gapStart = nextTime;
      mode = 'buffering';
    }
    if (mode !== 'playing') tryStart(now);
    if (mode === 'playing') {
      const placed = schedule(now, ops);
      let ahead = nextTime - now;
      if (!queue.length && ahead <= cfg.lowWater) {
        const tail = last();
        if (tail && tail.end > now) fadeTail(tail, ops);
        c.underruns++;
        emit('underrun', { hard: false });
        gapStart = nextTime;
        mode = 'buffering';
      } else {
        if (ahead > T + cfg.overflow && queue.length === 0) {
          trim(now, ops);
          schedule(now, ops);
          ahead = nextTime - now;
        }
        if (placed) {
          level = level === null ? ahead : level + 0.1 * (ahead - level);
          const err = level - T;
          const want = Math.abs(err) < cfg.deadband ? 1 : 1 + clamp(err * cfg.trimGain, -cfg.maxTrim, cfg.maxTrim);
          curRate += clamp(want - curRate, -cfg.slew, cfg.slew);
        }
        // T falls back towards its floor only once the buffer has settled at T, and in small steps, so that the
        // drift controller (not a content skip) takes the excess out.
        if (T > cfg.floor && now - cleanSince >= cfg.decayEvery && (level === null || level <= T + cfg.deadband)) {
          T = Math.max(cfg.floor, T - Math.min(T * (1 - cfg.decayFactor), 0.04));
          cleanSince = now;
        }
        const late = Math.min(cfg.maxTarget, cfg.lateGrow * jitter.worstLateness());
        if (late > T) { T = late; cleanSince = now; }
      }
    }
    return ops;
  }

  function stopAll(now, ops, quick = 0.02) {
    for (const s of segs) {
      if (s.at >= now + 0.001) ops.push({ op: 'cancel', id: s.id });
      else if (s.end > now + 0.001) {
        s.stopAt = Math.min(s.end, now + quick);
        s.fadeOut = Math.min(quick, s.stopAt - now);
        ops.push({ op: 'update', seg: s });
      }
    }
    segs = [];
    queue = [];
    expect = null;
    lastReal = null;
    gapStart = null;
    join = false;
    freshFade = false;
    level = null;
    curRate = 1;
    mode = 'idle';
  }

  return {
    /**
     * @param {{ seq:number, ts?:number, frames:number, rate?:number, flags?:number, data?:any }} packet metadata; `data` (the decoded
     *   samples, an AudioBuffer in the browser) is carried along untouched and comes back as `seg.data` of the segments that play it
     * @returns {object[]} operations to carry out now
     */
    push(packet) {
      const now = clock();
      const seen = jitter.observe({ seq: packet.seq, ts: packet.ts ?? null, arrival: now });
      const ops = [];
      if (seen.kind === 'reset') { stopAll(now, ops); c.resets++; }
      else if (seen.kind === 'duplicate') { c.duplicates++; return ops; }
      c.pushed++;
      if (packet.flags > 0) c.relaySkipped += packet.flags;
      if (expect !== null && seen.ext < expect) { c.late++; return ops; }
      if (queue.some(e => e.ext === seen.ext)) { c.duplicates++; return ops; }
      insert({ ext: seen.ext, seq: packet.seq, frames: packet.frames, srate: packet.rate ?? 48000, lateness: seen.lateness, data: packet.data });
      return ops.concat(pump(now));
    },
    pump,
    /** Stop everything quickly and forget the stream (broadcast ended, listener unselected). */
    stop() { const ops = []; stopAll(clock(), ops); jitter.reset(); return ops; },
    /** Exts whose samples the caller must still hold: queued, playing, and the concealment source. */
    needed() {
      const set = new Set(queue.map(e => e.ext));
      for (const s of segs) set.add(s.src);
      if (lastReal) set.add(lastReal.ext);
      return set;
    },
    get mode() { return mode; },
    get target() { return T; },
    stats() {
      const now = clock();
      const j = jitter.snapshot();
      return {
        mode, targetMs: T * 1000, bufferedMs: mode === 'playing' ? Math.max(0, nextTime - now) * 1000 + queued() * 1000 : queued() * 1000,
        queuedPackets: queue.length, rate: curRate, ...c, lossPct: j.lossPct, jitterMs: j.jitterMs, worstLateMs: j.worstLateMs,
      };
    },
  };
}

/**
 * Stateful linear resampler for a context that could not be pinned to the sender's rate (design 5.4). It carries the fractional
 * read position and the last input sample across calls, so the output is one continuous stream however the input is cut:
 * resample(a) followed by resample(b) equals resample(a ++ b). `process(channels)` takes and returns arrays of Float32Array.
 */
export function createResampler(inRate, outRate) {
  const step = inRate / outRate;
  let position = 0;     // read position, in input samples, relative to the start of the next block (may be negative: -1 = the carried sample)
  let carry = null;     // last input sample of each channel from the previous block
  return {
    process(channels) {
      const n = channels[0].length;
      const out = [];
      let count = 0;
      for (let p = position; p < n - 1 + 1e-9; p += step) count++;
      for (let c = 0; c < channels.length; c++) {
        const input = channels[c];
        const result = new Float32Array(count);
        let p = position;
        for (let i = 0; i < count; i++, p += step) {
          const k = Math.floor(p);
          const frac = p - k;
          const a = k < 0 ? (carry ? carry[c] : input[0]) : input[k];
          const b = k + 1 < n ? input[k + 1] : input[n - 1];
          result[i] = a + (b - a) * frac;
        }
        out.push(result);
      }
      position += count * step - n;
      carry = channels.map(ch => ch[n - 1]);
      return out;
    },
    reset() { position = 0; carry = null; },
  };
}
