// Connection statistics for the debug overlay and for the `onNetStats` handler (design 4.10, 4.12).
//
// Pure bookkeeping, no timers of its own: the connection feeds it samples and asks for a snapshot. The clock is injected
// so tests (and the overlay) agree on what "since" means.

/** Nearest-rank percentile of an already sorted array of numbers (null for an empty array). */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

/**
 * @param {{ now: () => number }} clock
 * @param {{ samples?: number }} [options] how many of the latest round-trip times are kept for p50 / p95
 */
export function createNetStats(clock, { samples = 64 } = {}) {
  const rtts = [];
  const counters = {
    reconnects: 0, bytesIn: 0, bytesOut: 0, patches: 0, fulls: 0, messagesIn: 0, messagesOut: 0,
    divergence: 0, expired: 0, pings: 0, pongs: 0,
  };
  let last = null;
  let openedAt = null;
  let lastClose = null;
  let loss = 0;

  return {
    /** A round-trip time in milliseconds (from a PING/PONG pair). */
    recordRtt(ms) {
      if (!Number.isFinite(ms) || ms < 0) return;
      last = ms;
      rtts.push(ms);
      if (rtts.length > samples) rtts.shift();
    },
    /** Add `n` to a named counter (unknown names are created, so the overlay can show extra ones). */
    count(name, n = 1) { counters[name] = (counters[name] ?? 0) + n; },
    setLoss(percent) { loss = percent; },
    markOpen() { openedAt = clock.now(); },
    markClosed(code, reason = '') { openedAt = null; lastClose = { code, reason, at: clock.now() }; },
    get latest() { return last; },
    snapshot() {
      const sorted = [...rtts].sort((a, b) => a - b);
      return {
        rtt: { last, p50: percentile(sorted, 50), p95: percentile(sorted, 95), samples: sorted.length },
        ...counters,
        loss,
        sinceMs: openedAt === null ? null : Math.max(0, clock.now() - openedAt),
        lastClose,
      };
    },
  };
}
