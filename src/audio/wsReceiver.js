// The player's fallback audio path: RFA3 packets from /__realm/audio -> playout.js -> AudioBufferSourceNodes (design 5.4).
//
// All decisions are made by the pure scheduler (playout.js); this file only (1) feeds it decoded packets, (2) carries out its
// operations on a real AudioContext, and (3) reports statistics. No AudioWorklet is used (phones on http:// do not have one).
import { decodeAudioPacket } from './pcm.js';
import { createPlayout, createResampler } from './playout.js';

/** An AudioContext pinned to 48 kHz so the browser resamples the final mix continuously (no per-packet click at 44.1 kHz). */
export function createPinnedContext(AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext) {
  try { return new AudioContextClass({ sampleRate: 48000, latencyHint: 'playback' }); } catch { /* older browsers reject the option */ }
  try { return new AudioContextClass({ latencyHint: 'playback' }); } catch { return new AudioContextClass(); }
}

export function createWsReceiver({
  context, output, socketFactory, send, onState, setIntervalImpl = (...a) => globalThis.setInterval(...a), clearIntervalImpl = (...a) => globalThis.clearInterval(...a),
  playoutOptions = {}, pumpMs = 25, reportMs = 4000,
}) {
  const ctxRate = context.sampleRate;
  const needsResample = Math.abs(ctxRate - 48000) > 1;
  const resampler = needsResample ? createResampler(48000, ctxRate) : null;
  const playout = createPlayout({ clock: () => context.currentTime, ordered: true, ...playoutOptions });
  const nodes = new Map(); // seg id -> { source, gain }
  let socket = null;
  let pumpTimer = null;
  let reportTimer = null;
  let disposed = false;
  let lastSilent = 0;
  const silentRing = [];
  const counters = { packets: 0, malformed: 0, decodeMs: 0 };

  function realise(ops) {
    for (const op of ops) {
      if (op.op === 'play') {
        const seg = op.seg;
        if (!seg.data) continue;
        const source = context.createBufferSource();
        source.buffer = seg.data;
        source.playbackRate.value = seg.rate;
        const gain = context.createGain();
        // Start on the context's own sample grid: a start time between two samples makes the browser interpolate the first
        // sample of every packet, and the rounding of two neighbours can then leave a one-sample gap or overlap.
        const at = Math.max(Math.round(seg.at * ctxRate) / ctxRate, context.currentTime);
        const g = gain.gain;
        g.setValueAtTime(seg.fadeIn > 0 ? 0 : seg.gain, at);
        if (seg.fadeIn > 0) g.linearRampToValueAtTime(seg.gain, at + seg.fadeIn);
        if (seg.fadeOut > 0) { g.setValueAtTime(seg.gain, Math.max(at + seg.fadeIn, seg.end - seg.fadeOut)); g.linearRampToValueAtTime(0, seg.end); }
        source.connect(gain);
        gain.connect(output);
        source.onended = () => { try { source.disconnect(); gain.disconnect(); } catch { /* gone */ } nodes.delete(seg.id); };
        nodes.set(seg.id, { source, gain });
        try {
          if (seg.off === 0 && seg.n >= seg.data.length) source.start(at);
          else source.start(at, seg.off / seg.srate, seg.n / seg.srate);
        } catch { nodes.delete(seg.id); }
      } else if (op.op === 'update') {
        const entry = nodes.get(op.seg.id);
        if (!entry) continue;
        const seg = op.seg;
        const g = entry.gain.gain;
        const end = Math.min(seg.end, seg.stopAt ?? Infinity);
        const from = Math.max(context.currentTime, end - seg.fadeOut);
        try {
          g.cancelScheduledValues(from);
          g.setValueAtTime(g.value > 0 && from <= context.currentTime ? g.value : seg.gain, from);
          g.linearRampToValueAtTime(0, end);
          if (seg.stopAt !== undefined) entry.source.stop(seg.stopAt);
        } catch { /* a node that already ended */ }
      } else if (op.op === 'cancel') {
        const entry = nodes.get(op.id);
        if (!entry) continue;
        try { entry.source.stop(); entry.source.disconnect(); entry.gain.disconnect(); } catch { /* ignore */ }
        nodes.delete(op.id);
      }
    }
  }

  function onPacket(buffer) {
    if (disposed || !(buffer instanceof ArrayBuffer) || context.state !== 'running') return;
    const started = performance.now();
    const pcm = decodeAudioPacket(buffer);
    if (!pcm || pcm.seq === undefined) { counters.malformed++; return; }
    let data = pcm.data;
    if (!data[1]) data = [data[0], data[0]];
    if (resampler) data = resampler.process(data);
    const frames = data[0].length;
    const audio = context.createBuffer(2, frames, ctxRate);
    audio.copyToChannel(data[0], 0);
    audio.copyToChannel(data[1], 1);
    counters.packets++;
    counters.decodeMs += performance.now() - started;
    realise(playout.push({ seq: pcm.seq, ts: pcm.ts, frames, rate: ctxRate, flags: pcm.flags, data: audio }));
  }

  function report() {
    const s = playout.stats();
    const now = Date.now();
    silentRing.push({ t: now, ms: (s.silentSeconds - lastSilent) * 1000 });
    lastSilent = s.silentSeconds;
    while (silentRing.length && silentRing[0].t < now - 30000) silentRing.shift();
    const silentMs30s = Math.round(silentRing.reduce((sum, e) => sum + e.ms, 0));
    const stats = {
      mode: 'ws', lossPct: +s.lossPct.toFixed(2), concealedPct: 0, jitterBufferMs: Math.round(s.bufferedMs), targetMs: Math.round(s.targetMs),
      underruns: s.underruns, silentMs30s, bufferedMs: Math.round(s.bufferedMs), skipped: s.trimmed + s.relaySkipped + s.stale,
    };
    onState?.({ ...stats, playout: s, rx: { ...counters, ctx: context.state } });
    send?.({ type: 'AUDIO_STATS', sid: 'ws', ...stats });
  }

  return {
    /** One AUDIO_STATS now (used right after a reconnect so the server can see the sound never stopped). */
    reportNow: report,
    start() {
      if (disposed || socket) return;
      socket = socketFactory({ onMessage: onPacket, onClose: () => {}, onFinal: () => onState?.({ mode: 'ws', failed: true }) });
      socket.start();
      pumpTimer = setIntervalImpl(() => { if (context.state === 'running') realise(playout.pump()); }, pumpMs);
      reportTimer = setIntervalImpl(report, reportMs);
    },
    /** Silence quickly and forget the stream (broadcast ended, unselected, switched to WebRTC). The socket stays open. */
    flush() { realise(playout.stop()); },
    stop() {
      this.flush();
      clearIntervalImpl(pumpTimer); clearIntervalImpl(reportTimer);
      pumpTimer = reportTimer = null;
      socket?.close();
      socket = null;
    },
    get running() { return !!socket; },
    stats: () => ({ ...playout.stats(), ...counters, resampling: needsResample }),
    dispose() { disposed = true; this.stop(); },
  };
}
