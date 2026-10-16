// The GM page's WebRTC senders: one RTCPeerConnection per listening device, all fed from the same audio track (design 5.2, 5.4).
//
// The server tells this module who is listening (AUDIO_LISTENER); this module offers, supervises each connection with a per-device
// rtcPolicy (connect timeout, one ICE restart, fallback, retry, promotion) and tells the server what it decided
// (AUDIO_OFFER / AUDIO_FALLBACK / AUDIO_STOP). It never plays anything: the capture graph lives in broadcastAudio3.js.
import { mungeOpus } from '../net/sdp.js';
import { createSenderPolicy } from './rtcPolicy.js';

const wait = (ms, setTimeoutImpl) => new Promise(resolve => setTimeoutImpl(resolve, ms));

export function createRtcSender({
  send, getTrack, getStream, RTCPeerConnectionClass = globalThis.RTCPeerConnection, now = () => Date.now(),
  setIntervalImpl = (...a) => globalThis.setInterval(...a), clearIntervalImpl = (...a) => globalThis.clearInterval(...a),
  setTimeoutImpl = (...a) => globalThis.setTimeout(...a), bitrate = 96000, onDevice, onFallbackCount,
}) {
  const devices = new Map(); // device -> entry
  let counter = 0;
  let active = false;
  let timer = null;

  const newSid = () => `g${(++counter).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  function publish(entry) {
    onDevice?.(entry.device, {
      mode: entry.policy.state === 'fallback' || entry.policy.state === 'retrying' || entry.policy.state === 'probation' ? 'ws' : entry.main ? 'rtc' : 'idle',
      state: entry.policy.state, reason: entry.policy.reason, stats: entry.stats,
    });
    onFallbackCount?.([...devices.values()].filter(e => ['fallback', 'retrying', 'probation'].includes(e.policy.state)).length);
  }

  async function makeConnection(entry, { retry = false } = {}) {
    const track = getTrack();
    if (!track || !RTCPeerConnectionClass) return null;
    const sid = newSid();
    const pc = new RTCPeerConnectionClass({ iceServers: [] });
    const slot = { pc, sid };
    pc.addTrack(track, getStream?.() ?? new MediaStream([track]));
    pc.onconnectionstatechange = () => {
      if (slot.pc.__dead) return;
      const mine = slot === entry.main || slot === entry.retry;
      if (!mine) return;
      handle(entry, entry.policy.connection(pc.connectionState, now()));
    };
    try {
      const offer = await pc.createOffer();
      offer.sdp = mungeOpus(offer.sdp, { bitrate });
      await pc.setLocalDescription(offer);
      if (pc.iceGatheringState !== 'complete') {
        await Promise.race([
          new Promise(resolve => pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && resolve())),
          wait(2500, setTimeoutImpl),
        ]);
      }
      send({ type: 'AUDIO_OFFER', to: entry.device, sid, sdp: pc.localDescription.sdp });
      return slot;
    } catch {
      closeSlot(slot);
      return null;
    }
  }

  function closeSlot(slot) {
    if (!slot) return;
    slot.pc.__dead = true;
    try { slot.pc.onconnectionstatechange = null; slot.pc.close(); } catch { /* closed */ }
  }

  function handle(entry, action) {
    if (!action) { publish(entry); return; }
    if (action.type === 'restart') {
      closeSlot(entry.main);
      entry.main = null;
      void offerMain(entry, true);
    } else if (action.type === 'fallback') {
      const sid = entry.main?.sid ?? 'none';
      closeSlot(entry.main);
      entry.main = null;
      send({ type: 'AUDIO_FALLBACK', to: entry.device, sid, reason: action.reason });
    } else if (action.type === 'retry') {
      void (async () => { entry.retry = await makeConnection(entry, { retry: true }); if (!entry.retry) entry.policy.connection('failed', now()); publish(entry); })();
    } else if (action.type === 'promote') {
      closeSlot(entry.main);
      entry.main = entry.retry;
      entry.retry = null;
      send({ type: 'AUDIO_STOP', to: entry.device, sid: 'ws' }); // the reserved sid 'ws' names the WebSocket path
    }
    if (entry.policy.state === 'fallback' && entry.retry && action.type !== 'retry') { closeSlot(entry.retry); entry.retry = null; }
    publish(entry);
  }

  async function offerMain(entry, isRestart = false) {
    if (entry.offering) return;
    entry.offering = true;
    try {
      entry.main = await makeConnection(entry);
      if (entry.main) { if (!isRestart) entry.policy.begin(now()); }
      else handle(entry, entry.policy.unsupported(now()));
    } finally { entry.offering = false; publish(entry); }
  }

  function entryOf(device) {
    let entry = devices.get(device);
    if (!entry) {
      entry = { device, policy: createSenderPolicy(), main: null, retry: null, offering: false, stats: null, ready: false, selected: false };
      devices.set(device, entry);
    }
    return entry;
  }

  function drop(device) {
    const entry = devices.get(device);
    if (!entry) return;
    closeSlot(entry.main); closeSlot(entry.retry);
    entry.policy.stop();
    devices.delete(device);
    onFallbackCount?.([...devices.values()].filter(e => ['fallback', 'retrying', 'probation'].includes(e.policy.state)).length);
  }

  function ensureTimer() {
    if (timer || !active) return;
    timer = setIntervalImpl(() => { for (const entry of [...devices.values()]) handle(entry, entry.policy.tick(now())); }, 1000);
  }

  return {
    /** The GM started or stopped broadcasting. */
    setActive(on) {
      active = on === true;
      if (!active) { for (const device of [...devices.keys()]) drop(device); clearIntervalImpl(timer); timer = null; }
      else ensureTimer();
    },
    /** AUDIO_LISTENER from the server. */
    listener(message) {
      const device = message.device;
      if (typeof device !== 'string') return;
      if (message.gone) { drop(device); return; }
      const entry = devices.get(device);
      const wanted = active && message.ready === true && message.selected === true;
      if (!wanted) { if (entry) drop(device); return; }
      const e = entryOf(device);
      if ((message.mode === 'ws' || message.caps?.rtc === false) && e.policy.state === 'idle') { handle(e, e.policy.unsupported(now())); return; }
      if (message.caps?.rtc === false) return; // this phone cannot do WebRTC: it stays on the WebSocket path
      if (message.mode === 'idle' || (message.mode === 'pending' && e.main)) {
        // the server lost its record of this device (or a socket blinked): start over with a fresh connection
        if (e.main) { closeSlot(e.main); e.main = null; }
      }
      if (!e.main && !e.offering && e.policy.state !== 'fallback' && e.policy.state !== 'retrying' && e.policy.state !== 'probation' && message.mode !== 'ws') void offerMain(e);
    },
    /** AUDIO_ANSWER from the server. */
    async answer(message) {
      const entry = devices.get(message.from);
      if (!entry) return;
      const slot = [entry.main, entry.retry].find(s => s && s.sid === message.sid);
      if (!slot) return;
      try { await slot.pc.setRemoteDescription({ type: 'answer', sdp: mungeOpus(message.sdp, { bitrate }) }); } catch { closeSlot(slot); handle(entry, entry.policy.connection('failed', now())); }
    },
    /** AUDIO_STATS from the server (what the phone measured). */
    stats(message) {
      const entry = devices.get(message.from);
      if (!entry) return;
      entry.stats = message;
      handle(entry, entry.policy.stats(message, now()));
    },
    info(device) { const e = devices.get(device); return e ? { state: e.policy.state, reason: e.policy.reason, stats: e.stats } : null; },
    count: () => devices.size,
    dispose() { for (const device of [...devices.keys()]) drop(device); clearIntervalImpl(timer); timer = null; },
  };
}
