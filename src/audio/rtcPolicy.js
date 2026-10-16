// Decisions about the WebRTC path, kept out of the browser glue so they can be tested with canned numbers (design 5.2, 5.4).
// Pure: no timers, no RTCPeerConnection; every call is given the time in milliseconds.
//
//   createReceiverPolicy()  the phone: turns getStats() samples into a jitterBufferTarget and a report for AUDIO_STATS
//   createSenderPolicy()    the GM page, one per listening device: when to restart ICE, when to fall back to the WebSocket
//                           path, when to try WebRTC again and when to switch back

export const RTC_POLICY = Object.freeze({
  // jitterBufferTarget (milliseconds)
  initialTarget: 800, minTarget: 500, maxTarget: 2000, growth: 1.3, decayPerMinute: 50, silenceEventMs: 20,
  // connection supervision (milliseconds)
  connectTimeoutMs: 6000, disconnectedRestartMs: 2000, disconnectedFallbackMs: 8000, restartTimeoutMs: 6000,
  silentLimitMs: 3000, silentWindowMs: 30000, healthyResetMs: 30000,
  retryEveryMs: 60000, promoteAfterMs: 10000, probationSilentMs: 1000,
});

const RATE = 48; // samples per millisecond at 48 kHz

// ---------------------------------------------------------------------------------------------------------------------
// Receiver side
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Feed it one getStats() inbound-rtp sample about every 2 s: `{ packetsReceived, packetsLost, concealedSamples,
 * silentConcealedSamples, totalSamplesReceived, jitterBufferDelay, jitterBufferEmittedCount, concealmentEvents? }`
 * (cumulative counters, as the browser reports them).
 *
 * jitterBufferTarget rule (design 5.2): starts at 800 ms; when a stretch of silent concealment (the browser ran dry) of D ms
 * is seen the target becomes max(target, 1.3 x D), capped at 2000; it then decays by 50 ms per minute without silence,
 * to a floor of 500 ms.
 */
export function createReceiverPolicy(options = {}) {
  const cfg = { ...RTC_POLICY, ...options };
  let target = cfg.initialTarget;
  let previous = null;
  let lastDecay = null;
  let lastSilence = null;
  let underruns = 0;
  let longestSilentMs = 0;
  const window = []; // { t, silentMs, lost, received, concealed, total }
  let latest = { lossPct: 0, concealedPct: 0, jitterBufferMs: 0 };

  return {
    get target() { return Math.round(target); },

    /** @returns {{ target:number, changed:boolean, report:object }} */
    update(sample, now) {
      const before = Math.round(target);
      if (lastDecay === null) lastDecay = now;
      if (previous) {
        const d = key => Math.max(0, (sample[key] ?? 0) - (previous[key] ?? 0));
        const silentMs = d('silentConcealedSamples') / RATE;
        window.push({ t: now, silentMs, lost: d('packetsLost'), received: d('packetsReceived'), concealed: d('concealedSamples'), total: d('totalSamplesReceived') });
        while (window.length && window[0].t < now - cfg.silentWindowMs) window.shift();
        if (silentMs >= cfg.silenceEventMs) {
          underruns++;
          longestSilentMs = Math.max(longestSilentMs, silentMs);
          target = Math.min(cfg.maxTarget, Math.max(target, cfg.growth * silentMs));
          lastSilence = now;
          lastDecay = now;
        } else if (now - lastDecay >= 1000) {
          const quiet = lastSilence === null || now - lastSilence >= 60000;
          if (quiet) target = Math.max(cfg.minTarget, target - (cfg.decayPerMinute * (now - lastDecay)) / 60000);
          lastDecay = now;
        }
        const sum = key => window.reduce((s, w) => s + w[key], 0);
        const got = sum('received') + sum('lost');
        const emitted = sample.jitterBufferEmittedCount ?? 0;
        latest = {
          lossPct: got ? (100 * sum('lost')) / got : 0,
          concealedPct: sum('total') ? (100 * sum('concealed')) / sum('total') : 0,
          jitterBufferMs: emitted ? (1000 * (sample.jitterBufferDelay ?? 0)) / emitted : latest.jitterBufferMs,
        };
      }
      previous = { ...sample };
      return { target: Math.round(target), changed: Math.round(target) !== before, report: this.report() };
    },

    /** What goes into AUDIO_STATS (everything is a plain finite number). */
    report() {
      return {
        lossPct: +latest.lossPct.toFixed(2), concealedPct: +latest.concealedPct.toFixed(2),
        jitterBufferMs: Math.round(latest.jitterBufferMs), targetMs: Math.round(target), underruns,
        silentMs30s: Math.round(window.reduce((s, w) => s + w.silentMs, 0)), longestSilentMs: Math.round(longestSilentMs),
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Sender side (GM page), one policy per listening device
// ---------------------------------------------------------------------------------------------------------------------

/**
 * States: idle - connecting - connected - disconnected - restarting - fallback - retrying - probation.
 *
 * Actions returned by tick():
 *   { type:'restart',  reason }   build a fresh offer for this device (the one allowed ICE restart)
 *   { type:'fallback', reason }   send AUDIO_FALLBACK: this device now hears the WebSocket path
 *   { type:'retry' }              while on the fallback, offer WebRTC again in the background
 *   { type:'promote' }            the retry has been healthy long enough: AUDIO_STOP the WebSocket path
 * Events are fed with begin(), connection(state), stats(report), stop().
 */
export function createSenderPolicy(options = {}) {
  const cfg = { ...RTC_POLICY, ...options };
  let state = 'idle';
  let since = 0;
  let restarted = false;
  let lastRetry = 0;
  let healthySince = null;
  let reason = '';
  let silentMs30s = 0;

  const go = (next, now) => { state = next; since = now; };
  const toFallback = (why, now) => { reason = why; lastRetry = now; healthySince = null; go('fallback', now); return { type: 'fallback', reason: why }; };

  return {
    get state() { return state; },
    get reason() { return reason; },
    get restarted() { return restarted; },

    /** An offer was sent to the device. */
    begin(now) { restarted = false; silentMs30s = 0; healthySince = null; go('connecting', now); },
    /** The WebSocket path is in use and WebRTC is being tried again. */
    beginRetry(now) { silentMs30s = 0; healthySince = null; go('retrying', now); },
    stop() { state = 'idle'; restarted = false; healthySince = null; },
    /** For a device that cannot do WebRTC at all (no RTCPeerConnection): straight to the fallback. */
    unsupported(now) { return toFallback('no-rtc', now); },

    /** RTCPeerConnection.connectionState of the device's connection (the current one, including a retry). */
    connection(connectionState, now) {
      switch (state) {
        case 'connecting': case 'restarting':
          if (connectionState === 'connected') { go('connected', now); healthySince = now; }
          else if (connectionState === 'failed') return toFallback('ice-failed', now);
          break;
        case 'connected':
          if (connectionState === 'disconnected') { go('disconnected', now); healthySince = null; }
          else if (connectionState === 'failed') return toFallback('ice-failed', now);
          break;
        case 'disconnected':
          if (connectionState === 'connected') { go('connected', now); healthySince = now; }
          else if (connectionState === 'failed') return toFallback('ice-failed', now);
          break;
        case 'retrying':
          if (connectionState === 'connected') { go('probation', now); healthySince = now; }
          else if (connectionState === 'failed') go('fallback', now); // the next retry counts from when this one began
          break;
        case 'probation':
          if (connectionState === 'disconnected' || connectionState === 'failed') { lastRetry = now; healthySince = null; go('fallback', now); }
          break;
        default: break;
      }
      return null;
    },

    /** The player's AUDIO_STATS: { silentMs30s, ... }. */
    stats(report, now) {
      silentMs30s = Number(report?.silentMs30s) || 0;
      if (state === 'connected' && silentMs30s > cfg.silentLimitMs) return toFallback('concealment', now);
      if (state === 'probation' && silentMs30s > cfg.probationSilentMs) { lastRetry = now; healthySince = null; go('fallback', now); }
      return null;
    },

    /** Call about once a second. Returns at most one action. */
    tick(now) {
      const waited = now - since;
      switch (state) {
        case 'connecting':
          if (waited >= cfg.connectTimeoutMs) return toFallback('timeout', now);
          break;
        case 'connected':
          if (healthySince !== null && now - healthySince >= cfg.healthyResetMs) restarted = false;
          break;
        case 'disconnected':
          if (!restarted && waited >= cfg.disconnectedRestartMs) { restarted = true; go('restarting', now); return { type: 'restart', reason: 'disconnected' }; }
          if (restarted && waited >= cfg.disconnectedFallbackMs) return toFallback('disconnected', now);
          break;
        case 'restarting':
          if (waited >= cfg.restartTimeoutMs) return toFallback('restart-timeout', now);
          break;
        case 'fallback':
          if (now - lastRetry >= cfg.retryEveryMs) { lastRetry = now; go('retrying', now); return { type: 'retry' }; }
          break;
        case 'retrying':
          if (waited >= cfg.connectTimeoutMs) go('fallback', now);
          break;
        case 'probation':
          if (healthySince !== null && now - healthySince >= cfg.promoteAfterMs) { go('connected', now); healthySince = now; restarted = false; return { type: 'promote' }; }
          break;
        default: break;
      }
      return null;
    },
  };
}
