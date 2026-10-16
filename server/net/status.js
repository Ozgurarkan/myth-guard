// Counters, gauges, small histograms and a ring buffer of log lines (design 4.12). Everyone calls this;
// /__realm/diag returns snapshot(), /__realm/diag/log returns logTail().
//
// Nothing secret is ever kept: log lines are scrubbed of anything that looks like a key, proof, token or cookie
// before they are stored, as a second line of defence behind callers that already avoid logging secrets.

const RING = 500;
const SAMPLES = 256;

/** Scrubs a log line. 64 hex characters (keys, proofs, hashes) and invite material are removed; ids are shortened. */
export function redact(line) {
  return String(line)
    .replace(/auth\.[0-9a-f]{32}\.[0-9a-f]{32}\.[0-9a-f]{64}/gi, 'auth.[redacted]')
    .replace(/\b(rf-gm|rf-d|cookie|authorization|set-cookie)\s*[=:]\s*[^;\s,]+/gi, '$1=[redacted]')
    .replace(/#?\bjoin=[A-Za-z0-9_-]+/g, 'join=[redacted]')
    .replace(/\b(?:secret|serverSecret|dk|proof|srvProof|srv|key|code)\s*[=:]\s*["']?[A-Za-z0-9_-]{8,}["']?/gi, match => `${match.split(/[=:]/)[0]}=[redacted]`)
    .replace(/\b[0-9a-f]{64,}\b/gi, '[hex]')
    .replace(/\b([0-9a-f]{6})[0-9a-f]{26}\b/gi, '$1…')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 400);
}

const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);

/** @param clock  { now() } */
export function createMetrics(clock) {
  const startedAt = clock.now();
  const counters = new Map();
  const gauges = new Map();    // name -> number | () => number
  const histograms = new Map(); // name -> { samples: number[], count, sum }
  const lines = [];

  const metrics = {
    inc(name, count = 1) { counters.set(name, (counters.get(name) ?? 0) + count); },
    count: name => counters.get(name) ?? 0,
    gauge(name, value) { gauges.set(name, value); },
    observe(name, value) {
      if (!Number.isFinite(value)) return;
      let h = histograms.get(name);
      if (!h) { h = { samples: [], count: 0, sum: 0 }; histograms.set(name, h); }
      h.samples.push(value);
      if (h.samples.length > SAMPLES) h.samples.shift();
      h.count += 1;
      h.sum += value;
    },
    /** One line into the ring buffer (last 500). Returns the stored (scrubbed) text. */
    log(line) {
      const text = redact(line);
      lines.push({ t: clock.now(), line: text });
      if (lines.length > RING) lines.shift();
      return text;
    },
    logTail: (count = RING) => lines.slice(-count).map(({ t, line }) => `${new Date(t).toISOString()} ${line}`),
    snapshot() {
      const flatCounters = Object.fromEntries([...counters].sort(([a], [b]) => a.localeCompare(b)));
      const rejects = {};
      for (const [name, value] of counters) if (name.startsWith('reject.')) rejects[name.slice(7)] = value;
      const flatGauges = {};
      for (const [name, value] of gauges) {
        try { flatGauges[name] = typeof value === 'function' ? value() : value; } catch { flatGauges[name] = null; }
      }
      const timings = {};
      for (const [name, h] of histograms) {
        const sorted = [...h.samples].sort((a, b) => a - b);
        timings[name] = { count: h.count, mean: h.count ? h.sum / h.count : null, p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), max: sorted.at(-1) ?? null };
      }
      const memory = process.memoryUsage();
      return {
        uptimeS: Math.round((clock.now() - startedAt) / 1000),
        counters: flatCounters,
        rejects,
        gauges: flatGauges,
        timings,
        memory: { rssMB: Math.round(memory.rss / 1048576), heapMB: Math.round(memory.heapUsed / 1048576) },
      };
    },
  };
  return metrics;
}
