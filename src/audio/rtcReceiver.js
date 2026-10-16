// The player's primary audio path: one RTCPeerConnection answering the GM's offer, played through a hidden <audio> element, with
// the browser's own jitter buffer and loss concealment doing the work off the page's main thread (design 5.2).
//
// iceServers is empty (host candidates only; the server rewrites them to real addresses, design 5.3). The answer is sent once ICE
// gathering is complete (no trickle). Statistics come from getStats() every 2 s into rtcPolicy, which sets jitterBufferTarget.
import { createReceiverPolicy } from './rtcPolicy.js';

const wait = (ms, setTimeoutImpl) => new Promise(resolve => setTimeoutImpl(resolve, ms));

export function createRtcReceiver({
  audioElement, send, onState, RTCPeerConnectionClass = globalThis.RTCPeerConnection,
  setIntervalImpl = (...a) => globalThis.setInterval(...a), clearIntervalImpl = (...a) => globalThis.clearInterval(...a),
  setTimeoutImpl = (...a) => globalThis.setTimeout(...a), statsMs = 2000, reportMs = 4000,
}) {
  let pc = null;
  let sid = '';
  let policy = null;
  let statsTimer = null;
  let lastReport = 0;
  let rttMs = 0;
  let receiverRef = null;
  let active = true; // false: connected but kept silent (a background retry while the WebSocket path plays)

  const state = patch => onState?.({ mode: 'rtc', sid, ...patch });

  function applyTarget(ms) {
    const receiver = receiverRef;
    if (!receiver) return;
    try {
      if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = ms;
      else if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = ms / 1000;
    } catch { /* unsupported value: the browser keeps its default */ }
  }

  async function poll() {
    if (!pc) return;
    try {
      const report = await pc.getStats();
      let inbound = null;
      report.forEach(item => {
        if (item.type === 'inbound-rtp' && (item.kind === 'audio' || item.mediaType === 'audio')) inbound = item;
        else if (item.type === 'candidate-pair' && item.nominated && typeof item.currentRoundTripTime === 'number') rttMs = item.currentRoundTripTime * 1000;
      });
      if (!inbound) return;
      const now = Date.now();
      const result = policy.update(inbound, now);
      if (result.changed) applyTarget(result.target);
      if (now - lastReport >= reportMs) {
        lastReport = now;
        const stats = { sid, mode: 'rtc', ...result.report, rttMs: Math.round(rttMs) };
        state({ ...result.report, rttMs: Math.round(rttMs) });
        send?.({ type: 'AUDIO_STATS', ...stats });
      }
    } catch { /* the connection closed while asking */ }
  }

  function close() {
    clearIntervalImpl(statsTimer);
    statsTimer = null;
    const old = pc;
    pc = null;
    receiverRef = null;
    if (old) {
      old.ontrack = null; old.onconnectionstatechange = null;
      try { old.close(); } catch { /* closed already */ }
    }
    if (audioElement && audioElement.srcObject && sid) { try { audioElement.srcObject = null; } catch { /* ignore */ } }
  }

  return {
    /** Answer an offer. Resolves when the answer has been sent (or the attempt failed). `listen` false = stay silent for now. */
    async answer(newSid, sdp, { listen = true } = {}) {
      close();
      sid = newSid;
      active = listen;
      policy = createReceiverPolicy();
      lastReport = 0;
      if (!RTCPeerConnectionClass) { state({ failed: true, reason: 'no-rtc' }); return false; }
      try {
        const connection = new RTCPeerConnectionClass({ iceServers: [] });
        pc = connection;
        connection.ontrack = event => {
          receiverRef = event.receiver;
          applyTarget(policy.target);
          try {
            if (audioElement) {
              audioElement.srcObject = event.streams?.[0] ?? new MediaStream([event.track]);
              audioElement.muted = !active;
              const played = audioElement.play();
              played?.catch?.(() => state({ needsTap: true }));
            }
          } catch { state({ needsTap: true }); }
        };
        connection.onconnectionstatechange = () => { if (pc === connection) state({ connection: connection.connectionState }); };
        await connection.setRemoteDescription({ type: 'offer', sdp });
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        if (connection.iceGatheringState !== 'complete') {
          await Promise.race([
            new Promise(resolve => connection.addEventListener('icegatheringstatechange', () => connection.iceGatheringState === 'complete' && resolve())),
            wait(2500, setTimeoutImpl),
          ]);
        }
        if (pc !== connection) return false; // superseded while we waited
        send?.({ type: 'AUDIO_ANSWER', sid, sdp: connection.localDescription.sdp });
        statsTimer = setIntervalImpl(poll, statsMs);
        return true;
      } catch (error) {
        state({ failed: true, reason: String(error?.name ?? 'error') });
        return false;
      }
    },
    /** Let a silent (retry) connection be heard. */
    activate() { active = true; if (audioElement) { audioElement.muted = false; audioElement.play?.().catch?.(() => state({ needsTap: true })); } },
    deactivate() { active = false; if (audioElement) audioElement.muted = true; },
    close,
    get sid() { return sid; },
    get connected() { return pc?.connectionState === 'connected'; },
    get present() { return pc !== null; },
    get target() { return policy?.target ?? 800; },
  };
}
