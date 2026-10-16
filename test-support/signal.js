// The audio test signal and the in-page measuring instruments (design 5.6).
//
//  Source   a continuous 440 Hz sine at amplitude 0.5. Every `beacon.everyMs` the tone jumps to a higher pitch for
//           `beacon.lenMs` (phase-continuous, so it is not a click): the "beacons" let us measure end-to-end delay.
//  Tap      an AudioWorklet that sees EVERY output sample of the receiving page and reports
//             gap      digital silence >= 0.4 ms between two stretches of sound   (a dropout is a gap >= 10 ms)
//             jump     a step > 0.12 between neighbouring samples                 (the sine's own largest step is 0.03)
//             beacon   the start of each pitch change
//           A worklet needs a secure context, so the receiving page is served from http://localhost for the measurement
//           only. The receiver code under test does not use the tap and does not know about it.
//
// Page scripts are built as strings: they are run with Page.addScriptToEvaluateOnNewDocument (cdp.js).

const DEFAULTS = { freq: 440, amp: 0.5, minGapMs: 0.4, jumpThreshold: 0.12, silenceEps: 1e-4 };

export const SOURCE = Object.freeze({ ...DEFAULTS, rate: 48000, beaconHz: 880 });

export const TAP_WORKLET_SOURCE = String.raw`
registerProcessor('rf-tap', class extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.eps = o.silenceEps; this.jump = o.jumpThreshold; this.minRun = Math.max(1, Math.round(o.minGapMs / 1000 * sampleRate));
    this.beaconHz = o.beaconHz; this.prev = null; this.run = 0; this.seen = false;
    this.lastRise = -1; this.n = 0; this.beaconOn = false; this.beaconQuiet = 0;
  }
  process(inputs) {
    const x = inputs[0] && inputs[0][0];
    if (!x) return true;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      const t = currentTime + i / sampleRate;
      if (Math.abs(v) < this.eps) this.run++;
      else {
        if (this.seen && this.run >= this.minRun) this.port.postMessage({ k: 'gap', ms: this.run / sampleRate * 1000, t: t - this.run / sampleRate });
        this.run = 0; this.seen = true;
        if (this.prev !== null && Math.abs(v - this.prev) > this.jump) this.port.postMessage({ k: 'jump', size: Math.abs(v - this.prev), t });
      }
      // pitch beacon: period of consecutive rising zero crossings shorter than rate / (0.8 * beaconHz)
      if (this.prev !== null && this.prev <= 0 && v > 0) {
        const n = this.n + i;
        if (this.lastRise >= 0) {
          const hz = sampleRate / (n - this.lastRise);
          if (hz > this.beaconHz * 0.8 && hz < this.beaconHz * 1.25) { if (!this.beaconOn) { this.beaconOn = true; this.port.postMessage({ k: 'beacon', t }); } this.beaconQuiet = 0; }
          else if (this.beaconOn && ++this.beaconQuiet > 3) this.beaconOn = false;
        }
        this.lastRise = n;
      }
      this.prev = v;
    }
    this.n += x.length;
    return true;
  }
});`;

/**
 * Script for the RECEIVING page: defines window.__tap and window.__installTap(ctx, node) and, depending on options,
 *   tapDestination  everything connected to ctx.destination is also fed to the tap (first node per context)
 *   tapStream       a MediaStream assigned to an element's srcObject (WebRTC <audio>) is fed to the tap
 *   forceRate       every AudioContext the page creates is forced to this sampleRate (simulates a 44.1 / 32 / 96 kHz phone)
 */
export function tapPageScript({ tapDestination = true, tapStream = true, forceRate = 0, beaconHz = SOURCE.beaconHz } = {}) {
  const options = { ...DEFAULTS, beaconHz };
  return String.raw`(() => {
  if (window.__tap) return;
  const tap = window.__tap = { available: window.isSecureContext, gaps: [], jumps: [], beacons: [], sr: 0, contexts: 0, startedWall: 0, error: null };
  const NativeContext = window.AudioContext || window.webkitAudioContext;
  window.__NativeAudioContext = NativeContext;
  const options = ${JSON.stringify(options)};
  const source = ${JSON.stringify(TAP_WORKLET_SOURCE)};
  const forceRate = ${Number(forceRate) || 0};
  if (forceRate && NativeContext) {
    window.AudioContext = class extends NativeContext { constructor(o = {}) { super({ ...o, sampleRate: forceRate }); } };
  }
  window.__installTap = async (ctx, node) => {
    if (!window.isSecureContext || !ctx.audioWorklet) { tap.available = false; tap.error = 'no AudioWorklet (insecure origin)'; return false; }
    try {
      await ctx.audioWorklet.addModule('data:text/javascript,' + encodeURIComponent(source));
      const probe = new AudioWorkletNode(ctx, 'rf-tap', { numberOfOutputs: 0, processorOptions: options });
      probe.port.onmessage = event => {
        const m = event.data;
        const wall = Date.now() - (ctx.currentTime - m.t) * 1000; // wall-clock time at which the sample was rendered
        if (m.k === 'gap') tap.gaps.push({ ms: m.ms, t: m.t, wall });
        else if (m.k === 'jump') tap.jumps.push({ size: m.size, t: m.t, wall });
        else if (m.k === 'beacon') tap.beacons.push({ t: m.t, wall });
      };
      tap.sr = ctx.sampleRate; tap.contexts += 1; tap.startedWall = tap.startedWall || Date.now();
      window.__connectOriginal(node, probe);
      return true;
    } catch (error) { tap.error = String(error); return false; }
  };
  window.__connectOriginal = (from, to) => AudioNode.prototype.__origConnect.call(from, to);
  AudioNode.prototype.__origConnect = AudioNode.prototype.connect;
  ${tapDestination ? String.raw`
  AudioNode.prototype.connect = function (destination, ...rest) {
    const result = AudioNode.prototype.__origConnect.call(this, destination, ...rest);
    if (destination && destination === this.context.destination && !this.context.__tapped) {
      this.context.__tapped = true;
      window.__installTap(this.context, this);
    }
    return result;
  };` : ''}
  ${tapStream ? String.raw`
  const srcObject = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
    configurable: true, enumerable: true, get() { return srcObject.get.call(this); },
    set(stream) {
      srcObject.set.call(this, stream);
      if (stream && stream.getAudioTracks && stream.getAudioTracks().length && !this.__tapped) {
        this.__tapped = true;
        const ctx = new NativeContext();
        ctx.resume().catch(() => {});
        window.__installTap(ctx, ctx.createMediaStreamSource(stream));
      }
    },
  });` : ''}
})();`;
}

/**
 * Script for the GM page: replaces getDisplayMedia with an oscillator stream (a human click and a real screen are not
 * available to the harness) and schedules the pitch beacons. Records window.__beaconWalls (wall-clock ms when each
 * beacon leaves the oscillator) and exposes window.__testCapture (the stream).
 */
export function fakeCaptureScript({ freq = SOURCE.freq, amp = SOURCE.amp, beacon = { everyMs: 5000, lenMs: 60, hz: SOURCE.beaconHz, count: 40, firstMs: 3000 } } = {}) {
  return String.raw`(() => {
  window.__beaconWalls = [];
  const fake = async () => {
    const ctx = new AudioContext({ sampleRate: ${SOURCE.rate} });
    await ctx.resume();
    const osc = ctx.createOscillator(); osc.frequency.value = ${freq};
    const gain = ctx.createGain(); gain.gain.value = ${amp};
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain); gain.connect(dest); osc.start();
    const b = ${JSON.stringify(beacon)};
    if (b) for (let k = 0; k < b.count; k++) {
      const at = ctx.currentTime + (b.firstMs + k * b.everyMs) / 1000;
      osc.frequency.setValueAtTime(b.hz, at);
      osc.frequency.setValueAtTime(${freq}, at + b.lenMs / 1000);
      window.__beaconWalls.push(Date.now() + (b.firstMs + k * b.everyMs));
    }
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 10;
    const stream = new MediaStream([...dest.stream.getAudioTracks(), ...canvas.captureStream(1).getVideoTracks()]);
    window.__testCapture = stream; window.__testContext = ctx;
    return stream;
  };
  if (navigator.mediaDevices) Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: fake });
})();`;
}

/**
 * Script for BOTH pages of a WebRTC run: records every RTCPeerConnection in window.__pcs and, when `relay` is given,
 * rewrites the remote description so that all media goes through the UDP relay (udpImpair.js). The app's own signalling
 * (the server's candidate rewrite) is untouched; only what the browser is finally told about the peer is replaced.
 *   role 'gm'      the GM is told that the player lives at relay.gmFacingPort
 *   role 'player'  the phone is told that the GM lives at relay.playerFacingPort
 * window.__udpPort() returns the real local UDP port of the first connection (to tell the relay where to forward to).
 */
export function rtcPageScript({ role, relay = null }) {
  return String.raw`(() => {
  const pcs = window.__pcs = [];
  const Native = window.RTCPeerConnection;
  if (!Native) return;
  const relay = ${JSON.stringify(relay && { host: relay.host ?? '127.0.0.1', port: role === 'gm' ? relay.gmFacingPort : relay.playerFacingPort })};
  const rewrite = sdp => {
    if (!relay) return sdp;
    let kept = false;
    return sdp.split(/\r?\n/).map(line => {
      if (!line.startsWith('a=candidate:')) return line;
      const f = line.slice(12).split(' ');
      if (kept || f[2].toLowerCase() !== 'udp' || f[7] !== 'host' || f[4].includes(':')) return null;
      kept = true; f[4] = relay.host; f[5] = String(relay.port);
      return 'a=candidate:' + f.join(' ');
    }).filter(line => line !== null).join('\r\n');
  };
  window.RTCPeerConnection = class extends Native {
    constructor(...args) {
      super(...args);
      pcs.push(this);
      const set = this.setRemoteDescription.bind(this);
      this.setRemoteDescription = description => set(description && description.sdp ? { type: description.type, sdp: rewrite(description.sdp) } : description);
    }
  };
  window.__udpPort = () => {
    for (const pc of pcs) {
      const sdp = pc.localDescription && pc.localDescription.sdp || '';
      for (const line of sdp.split(/\r?\n/)) {
        if (!line.startsWith('a=candidate:')) continue;
        const f = line.slice(12).split(' ');
        if (f[2].toLowerCase() === 'udp' && f[7] === 'host' && !f[4].includes(':')) return Number(f[5]);
      }
    }
    return 0;
  };
  window.__rtcStats = async () => {
    const out = [];
    for (const pc of pcs) {
      const report = await pc.getStats(); const entry = { state: pc.connectionState, ice: pc.iceConnectionState };
      report.forEach(s => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio') entry.inbound = s;
        if (s.type === 'outbound-rtp' && s.kind === 'audio') entry.outbound = s;
        if (s.type === 'candidate-pair' && s.nominated) entry.pair = { rtt: s.currentRoundTripTime, state: s.state };
      });
      out.push(entry);
    }
    return out;
  };
})();`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Node side
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Continuous source for the WebSocket-path sender: next(frames) -> Float32Array, phase kept across calls.
 * With `beacon`, the pitch rises to beacon.hz for beacon.lenMs every beacon.everyMs (phase-continuous). beaconStarts() lists
 * the sample indexes at which the beacons start.
 */
export function createSineSource({ rate = SOURCE.rate, freq = SOURCE.freq, amp = SOURCE.amp, beacon = null } = {}) {
  let index = 0;
  let phase = 0;
  const starts = [];
  return {
    rate,
    get position() { return index; },
    beaconStarts: () => starts.slice(),
    next(frames) {
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i += 1, index += 1) {
        let f = freq;
        if (beacon) {
          const ms = (index / rate) * 1000 - beacon.firstMs;
          if (ms >= 0) {
            const inCycle = ms % beacon.everyMs;
            if (inCycle < beacon.lenMs) {
              f = beacon.hz;
              if (inCycle < 1000 / rate + 1e-9 && (starts.length === 0 || index - starts.at(-1) > rate / 2)) starts.push(index);
            }
          }
        }
        phase += (2 * Math.PI * f) / rate;
        if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
        out[i] = amp * Math.sin(phase);
      }
      return out;
    },
  };
}

/**
 * Real-time pacing for a sender: calls send(frames, k) for packet k at wall time start + k * frames / rate until `seconds`
 * have passed. Resolves with { packets, startWall }. `stop()` ends it early.
 */
export function paceSender({ send, frames = 4096, rate = SOURCE.rate, seconds, startAfterMs = 200, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  let stopped = false;
  const startWall = now() + startAfterMs;
  const done = (async () => {
    let k = 0;
    while (!stopped && now() - startWall < seconds * 1000) {
      const wait = startWall + (k * frames * 1000) / rate - now();
      if (wait > 0) await sleep(wait);
      if (stopped) break;
      send(frames, k);
      k += 1;
    }
    return { packets: k, startWall };
  })();
  return { done, stop: () => { stopped = true; }, startWall };
}

/**
 * Turn the tap's raw log into the numbers of design 5.9.
 *   sourceBeaconWalls  wall-clock ms at which each beacon left the source (any length; matched by time, not by count)
 *   skipFirstMs        ignore events in the first part of the run (connection set-up, first sound)
 *   sinceWall          ignore events before this wall-clock time (the start of the measured window)
 */
export function summarizeTap(tap, { seconds, minDropoutMs = 10, sourceBeaconWalls = [], skipFirstMs = 0, sinceWall = 0 } = {}) {
  const t0 = tap.startedWall || 0;
  const keep = e => (!skipFirstMs || e.wall - t0 >= skipFirstMs) && e.wall >= sinceWall;
  const gaps = tap.gaps.filter(keep);
  const dropouts = gaps.filter(g => g.ms >= minDropoutMs);
  const jumps = tap.jumps.filter(keep);
  const sources = [...sourceBeaconWalls].sort((a, b) => a - b);
  const latencies = [];
  for (const beacon of tap.beacons) {
    let source = null;
    for (const wall of sources) if (wall <= beacon.wall + 50) source = wall; else break;
    if (source !== null && beacon.wall - source < 15000) latencies.push({ atMs: Math.round(beacon.wall - t0), ms: Math.round(beacon.wall - source) });
  }
  return {
    available: tap.available !== false && !tap.error,
    error: tap.error ?? null,
    contextRate: tap.sr,
    dropouts: dropouts.length,
    dropoutMs: dropouts.map(g => Math.round(g.ms)),
    totalSilenceMs: Math.round(dropouts.reduce((sum, g) => sum + g.ms, 0)),
    discontinuities: jumps.length,
    discontinuitiesPerMinute: seconds ? +((jumps.length * 60) / seconds).toFixed(2) : null,
    latency: latencies.length ? {
      samples: latencies.length, first: latencies[0].ms, last: latencies.at(-1).ms,
      max: Math.max(...latencies.map(l => l.ms)), mean: Math.round(latencies.reduce((s, l) => s + l.ms, 0) / latencies.length), series: latencies,
    } : null,
  };
}
