// The player's side of the broadcast (replaces receiveAudio.js at the switch; same factory name and state shape).
//
//   createAudioReceiver(onState) -> { enable(), dispose() }
//   state: { active, enabled, connected, needsResume, reconnecting, selected, masterVolume, masterMuted, error }
//          plus, new and optional: mode ('rtc' | 'ws' | 'off'), quality ('good' | 'fair' | 'poor'), awake ('wake-lock' | 'video' | ...)
//
// Primary path: WebRTC into a hidden <audio> element (rtcReceiver.js). Fallback: the WebSocket path (wsReceiver.js), started when
// the GM or the server says so (AUDIO_FALLBACK). The GM page applies the volume and mute to the sound itself, so the receiver
// only reports them. Everything is unlocked by the one tap that already exists ("Tap to hear the music").
import { playerChannel } from './audioChannel.js';
import { createRtcReceiver } from './rtcReceiver.js';
import { createWsReceiver, createPinnedContext } from './wsReceiver.js';
import { createAudioSocket } from './audioSocket.js';
import { createKeepAwake } from './keepAwake.js';

// A 0.1 s silent WAV: playing it inside the tap unlocks the <audio> element for the rest of the page's life (iOS requires this).
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgLsAAAB3AQACABAAZGF0YQAAAAA=';

export function createAudioReceiver(onState, {
  channel = playerChannel, documentRef = globalThis.document, windowRef = globalThis.window,
  RTCPeerConnectionClass = globalThis.RTCPeerConnection, identity, keepAwake = createKeepAwake(), createContext = createPinnedContext,
  socketOptions = {}, playoutOptions = {},
} = {}) {
  let state = { active: false, enabled: false, connected: false, needsResume: false, reconnecting: false, selected: false,
    masterVolume: 1, masterMuted: false, error: '', mode: 'off', quality: 'good' };
  let disposed = false;
  let context = null;
  let output = null;
  let element = null;
  let rtc = null;
  let ws = null;
  let resuming = false;
  const update = patch => { state = { ...state, ...patch }; if (!disposed) onState(state); };

  const caps = () => ({
    rtc: !!RTCPeerConnectionClass,
    jbt: !!globalThis.RTCRtpReceiver && 'jitterBufferTarget' in (globalThis.RTCRtpReceiver.prototype ?? {}),
  });
  const playing = () => (rtc?.connected ? 'rtc' : ws?.running ? 'ws' : null);
  const sendListen = () => {
    channel.send({ type: 'AUDIO_LISTEN', enabled: state.enabled, caps: caps(), playing: playing() });
    // The hub's validator keeps only the documented fields of AUDIO_LISTEN, so also say it with an AUDIO_STATS the server accepts:
    // after a control-socket blink this is what tells it the sound never stopped.
    if (playing() === 'ws') ws.reportNow();
    else if (playing() === 'rtc') channel.send({ type: 'AUDIO_STATS', sid: rtc.sid || 'rtc', mode: 'rtc' });
  };

  function ensureElement() {
    if (element || !documentRef) return element;
    element = documentRef.createElement('audio');
    element.setAttribute('playsinline', '');
    element.setAttribute('aria-hidden', 'true');
    element.autoplay = true;
    element.preload = 'auto';
    element.style.display = 'none';
    documentRef.body.appendChild(element);
    element.addEventListener('pause', () => { if (state.enabled && state.active && state.selected && !element.ended && state.mode === 'rtc') update({ needsResume: true }); });
    element.addEventListener('playing', () => { if (state.needsResume && (!context || context.state === 'running')) update({ needsResume: false }); });
    return element;
  }

  function ensureRtc() {
    rtc ??= createRtcReceiver({
      audioElement: ensureElement(), RTCPeerConnectionClass, send: m => channel.send(m),
      onState: s => {
        if (s.failed) update({ error: '' });
        if (s.lossPct !== undefined) update({ stats: s });
        if (s.concealedPct !== undefined) update({ quality: s.lossPct > 8 || s.concealedPct > 15 ? 'poor' : s.lossPct > 2 || s.concealedPct > 5 ? 'fair' : 'good' });
        if (s.needsTap) update({ needsResume: true });
      },
    });
    return rtc;
  }

  function ensureWs() {
    if (ws || !context) return ws;
    ws = createWsReceiver({
      context, output, playoutOptions,
      send: m => channel.send(m),
      socketFactory: handlers => createAudioSocket({
        role: 'player', identity: identity ?? defaultIdentity, ...handlers, ...socketOptions,
      }),
      onState: s => {
        if (s.jitterBufferMs !== undefined) update({ stats: s, quality: s.underruns > 3 ? 'poor' : s.underruns > 0 || s.silentMs30s > 0 ? 'fair' : 'good' });
      },
    });
    return ws;
  }

  function stopPaths() {
    rtc?.close();
    ws?.stop();
    ws = null;
    update({ mode: 'off' });
  }

  function recoverAudio() {
    if (disposed || !state.enabled) return;
    if (context && context.state !== 'running' && !resuming) {
      resuming = true;
      context.resume().catch(() => {}).finally(() => { resuming = false; });
    }
    if (element && element.srcObject && element.paused && state.mode === 'rtc') element.play?.().then(() => update({ needsResume: false })).catch(() => update({ needsResume: true }));
  }

  const onVisible = () => { if (documentRef?.visibilityState === 'visible') recoverAudio(); };
  documentRef?.addEventListener?.('visibilitychange', onVisible);
  windowRef?.addEventListener?.('pageshow', recoverAudio);
  windowRef?.addEventListener?.('online', recoverAudio);

  const unsubscribe = channel.subscribe(message => {
    if (disposed) return;
    switch (message.type) {
      case 'AUDIO_STATUS':
        if (message.reconnecting) { update({ reconnecting: true }); break; }
        update({ active: message.active === true, reconnecting: false });
        if (!message.active) stopPaths();
        break;
      case 'AUDIO_CONTROLS':
        update({ masterVolume: message.volume, masterMuted: message.muted, selected: message.selected === true });
        if (!state.selected) stopPaths();
        break;
      case 'AUDIO_OFFER':
        if (!state.enabled || !state.selected || !state.active || typeof message.sdp !== 'string') break;
        // while the WebSocket path is playing, a new offer is a background retry: connect it, but keep it silent until promoted
        void ensureRtc().answer(String(message.sid ?? ''), message.sdp, { listen: !ws?.running }).then(ok => {
          if (ok && !ws?.running) update({ mode: 'rtc' });
        });
        break;
      case 'AUDIO_FALLBACK':
        if (!state.enabled || !state.selected) break;
        rtc?.close();
        if (ensureWs()) { ws.start(); update({ mode: 'ws' }); }
        else update({ error: 'Sound needs a tap to start.' });
        break;
      case 'AUDIO_STOP':
        if (message.sid === 'ws' || message.path === 'ws') { ws?.stop(); ws = null; rtc?.activate(); update({ mode: 'rtc' }); }
        else if (message.sid) { if (rtc?.sid === message.sid) rtc.close(); }
        else stopPaths();
        break;
      default: break;
    }
  });
  const unsubscribeOpen = channel.onOpen(open => {
    update({ connected: open });
    if (open) sendListen();
    else update({ reconnecting: state.active });
  });
  update({ connected: channel.open });
  if (channel.open) sendListen();

  async function enable() {
    if (disposed) return;
    if (state.enabled && context?.state === 'running' && !state.needsResume) return;
    try {
      if (!context) {
        context = createContext();
        output = context.createGain();
        output.connect(context.destination);
        context.onstatechange = () => {
          update({ needsResume: context.state !== 'running' });
          if (context.state !== 'running') recoverAudio();
        };
      }
      const el = ensureElement();
      if (el && !el.srcObject && !el.src) { el.src = SILENT_WAV; el.muted = true; el.play?.().catch(() => {}); }
      else if (el) el.play?.().catch(() => {});
      await context.resume();
      if (el && el.src === SILENT_WAV) { el.pause?.(); el.removeAttribute('src'); el.muted = false; }
      keepAwake.setMediaSession?.('Myth Guard', 'Sound from the game master');
      const mode = await keepAwake.start();
      update({ enabled: true, needsResume: false, error: '', awake: mode });
      sendListen();
      recoverAudio();
    } catch {
      update({ error: 'Audio could not start. Tap anywhere on the player screen to retry.' });
    }
  }

  return {
    enable,
    dispose() {
      disposed = true;
      unsubscribe(); unsubscribeOpen();
      documentRef?.removeEventListener?.('visibilitychange', onVisible);
      windowRef?.removeEventListener?.('pageshow', recoverAudio);
      windowRef?.removeEventListener?.('online', recoverAudio);
      rtc?.close();
      ws?.dispose();
      keepAwake.dispose?.();
      element?.remove?.();
      if (context) { context.onstatechange = null; context.close().catch(() => {}); }
    },
  };
}

// The device id and key of this browser (src/net/deviceStore.js, WP4), loaded when the fallback socket first needs them so that
// importing this file in a test or a tool does not pull the network layer in.
async function defaultIdentity() {
  const { deviceStore } = await import('../net/deviceStore.js');
  return { device: deviceStore.device(), dk: deviceStore.dk() };
}
