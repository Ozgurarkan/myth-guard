// Packet arrival statistics for the fallback audio path (design 5.4). Pure: every call is given the arrival time, nothing
// reads a clock, so a test drives it with made-up numbers.
//
// Feed it one `observe({ seq, ts, arrival })` per received packet:
//   seq      the 32-bit packet number (wraps)
//   ts       sample index of the packet's first frame (wraps), at `rate`
//   arrival  seconds on the receiver's clock
//
// It keeps what the player needs to size its buffer and what the GM wants to see:
//   - an extended (unwrapped) sequence number, so "late", "duplicate" and "lost" mean something across a wrap
//   - RFC 3550 interarrival jitter (smoothed with 1/16)
//   - loss, duplicates and reordering since the stream began
//   - lateness: how far behind its best-ever pace a packet arrived. The best pace is the smallest (arrival - media time)
//     seen in the last `window` seconds. Lateness is what a buffer has to absorb: after a 700 ms stall the first packet
//     of the burst has lateness ~0.7 s.

const WRAP = 2 ** 32;
/** Signed distance from b to a over a 32-bit wrap. */
const diff32 = (a, b) => (a - b) | 0;

/**
 * Turns wrapping 32-bit sequence numbers into a monotonic JS number.
 * A jump back of more than `resetBack` packets (or forward of more than `resetForward`) is a new stream, not a late packet.
 */
export function createSeqUnwrapper({ resetBack = 512, resetForward = 1 << 20 } = {}) {
  let highest = null; // extended
  let highestRaw = 0;
  return {
    /** -> { ext, kind: 'first' | 'next' | 'back' | 'reset' } */
    next(seq) {
      const raw = seq >>> 0;
      if (highest === null) { highest = raw; highestRaw = raw; return { ext: raw, kind: 'first' }; }
      const d = diff32(raw, highestRaw);
      if (d < -resetBack || d > resetForward) { highest = raw; highestRaw = raw; return { ext: raw, kind: 'reset' }; }
      if (d > 0) { highest += d; highestRaw = raw; return { ext: highest, kind: 'next' }; }
      return { ext: highest + d, kind: 'back' };
    },
    get highest() { return highest; },
    reset() { highest = null; },
  };
}

export function createJitter({ rate = 48000, window = 30, bucket = 1 } = {}) {
  let seqs = createSeqUnwrapper();
  let tsBase = null;
  let tsHighest = 0;
  let tsRaw = 0;
  let stats;
  let seen; // recent extended seqs, for duplicate detection
  let buckets; // [{ t, min, max }]
  let lastTransit = null;
  let jitter = 0;

  const fresh = () => {
    stats = { received: 0, duplicates: 0, reordered: 0, resets: 0, baseSeq: null, highestSeq: null, lastLateness: 0 };
    seen = new Set();
    buckets = [];
    lastTransit = null;
    jitter = 0;
    tsBase = null;
  };
  fresh();

  /** Extended sample timestamp (monotonic as long as the sender's is). */
  const unwrapTs = ts => {
    const raw = ts >>> 0;
    if (tsBase === null) { tsBase = raw; tsHighest = raw; tsRaw = raw; return raw; }
    const d = diff32(raw, tsRaw);
    if (d > 0) { tsHighest += d; tsRaw = raw; return tsHighest; }
    return tsHighest + d;
  };

  function note(transit, arrival) {
    const slot = Math.floor(arrival / bucket);
    let last = buckets[buckets.length - 1];
    if (!last || last.slot !== slot) {
      last = { slot, min: transit, max: transit };
      buckets.push(last);
      const cutoff = slot - Math.ceil(window / bucket);
      while (buckets.length && buckets[0].slot < cutoff) buckets.shift();
    } else {
      if (transit < last.min) last.min = transit;
      if (transit > last.max) last.max = transit;
    }
  }
  const baseline = () => buckets.reduce((m, b) => Math.min(m, b.min), Infinity);

  return {
    /**
     * @returns {{ ext:number, kind:'new'|'duplicate'|'reordered'|'reset', lateness:number }}
     *   `reset` means the sequence jumped so far that this is a new stream; every statistic restarted.
     */
    observe({ seq, ts = null, arrival }) {
      let { ext, kind } = seqs.next(seq);
      if (kind === 'reset') {
        const resets = stats.resets + 1;
        fresh();
        stats.resets = resets;
      }
      if (stats.baseSeq === null) stats.baseSeq = ext;
      if (seen.has(ext)) { stats.duplicates++; return { ext, kind: 'duplicate', lateness: 0 }; }
      seen.add(ext);
      if (seen.size > 512) seen.delete(seen.values().next().value);
      stats.received++;
      let result = kind === 'back' ? 'reordered' : kind === 'reset' ? 'reset' : 'new';
      if (kind === 'back') stats.reordered++;
      if (stats.highestSeq === null || ext > stats.highestSeq) stats.highestSeq = ext;

      let lateness = 0;
      if (ts !== null && ts !== undefined) {
        const media = unwrapTs(ts) / rate;
        const transit = arrival - media;
        note(transit, arrival);
        lateness = Math.max(0, transit - baseline());
        stats.lastLateness = lateness;
        if (kind !== 'back' && lastTransit !== null) jitter += (Math.abs(transit - lastTransit) - jitter) / 16;
        if (kind !== 'back') lastTransit = transit;
      }
      return { ext, kind: result, lateness };
    },

    /** Worst lateness (seconds) of any packet in the last `window` seconds. */
    worstLateness() {
      if (!buckets.length) return 0;
      const base = baseline();
      return Math.max(0, buckets.reduce((m, b) => Math.max(m, b.max), -Infinity) - base);
    },

    snapshot() {
      const expected = stats.baseSeq === null ? 0 : stats.highestSeq - stats.baseSeq + 1;
      const lost = Math.max(0, expected - stats.received);
      return {
        received: stats.received, expected, lost, lossPct: expected ? (100 * lost) / expected : 0,
        duplicates: stats.duplicates, reordered: stats.reordered, resets: stats.resets,
        jitterMs: jitter * 1000, lateMs: stats.lastLateness * 1000, worstLateMs: this.worstLateness() * 1000,
      };
    },

    /** Forget the best pace seen so far (the sender's clock paused, or the path got slower for good): lateness restarts from 0. */
    rebase() { buckets = []; lastTransit = null; stats.lastLateness = 0; },

    reset() { seqs = createSeqUnwrapper(); fresh(); },
  };
}

export { WRAP as SEQ_MODULUS };
