// The GM's audio broadcaster (replaces broadcastAudio.js at the switch; same factory name and state shape).
//
//   createAudioBroadcaster({ workletUrl, onState }) -> { start, stop, resume, setDevice, selectAllDevices, setPlayerVolume, setPlayerMuted, dispose }
//   state: { active, busy, connected, listeners, devices, playerVolume, playerMuted, capturePaused, error }
//          devices: [{ id, name, address, selected, ready }] plus, new and optional, { mode: 'rtc' | 'ws' | 'idle', state, quality }
//
// Capture graph (GM page, a secure context):
//   getDisplayMedia (audio) -> AudioContext(48 kHz) -> MediaStreamSource -> Gain (the players' volume / mute)
//        -> MediaStreamDestination -> one audio track -> an RTCPeerConnection per listening phone     (rtcSender.js)
//        -> (only while some phone is on the fallback) AudioWorklet encoder -> /__realm/audio          (wsSender.js)
// The volume and mute act on the Gain, so both paths carry them and the phones do not apply them a second time.
import { gmChannel } from './audioChannel.js';
import { createRtcSender } from './rtcSender.js';
import { createWsSender } from './wsSender.js';

const PREFS_KEY = 'night-city-audio-recipients';
function readPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    return Object.assign(Object.create(null), saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {});
  } catch { return Object.create(null); }
}
function savePreferences(preferences) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(preferences)); } catch { /* the session still works */ }
}

export function createAudioBroadcaster({ workletUrl, onState }, { channel = gmChannel, deps = {} } = {}) {
  let state = { active: false, busy: false, connected: false, listeners: 0, devices: [],
    playerVolume: 1, playerMuted: false, capturePaused: false, error: '' };
  let capture, context, source, gain, destination;
  let generation = 0;
  let disposed = false;
  let resuming = false;
  let wsSender = null;
  const known = new Map();   // device -> latest AUDIO_LISTENER
  const quality = new Map(); // device -> { mode, state }
  const preferences = readPreferences();
  const update = patch => { state = { ...state, ...patch }; if (!disposed) onState(state); };

  function publishDevices() {
    const devices = [...known.values()].map(l => ({
      id: l.device,
      name: preferences[l.device]?.name || l.name || l.label || 'Player browser',
      address: l.address || 'Unknown address',
      selected: preferences[l.device]?.selected === true,
      ready: l.ready === true,
      mode: quality.get(l.device)?.mode ?? l.mode ?? 'idle',
      state: quality.get(l.device)?.state ?? l.state ?? 'off',
    }));
    update({ devices, listeners: devices.filter(d => d.selected && d.ready).length });
  }

  const rtcSender = createRtcSender({
    send: message => channel.send(message),
    getTrack: () => destination?.stream.getAudioTracks()[0] ?? null,
    getStream: () => destination?.stream,
    onDevice: (device, info) => { quality.set(device, info); publishDevices(); },
    onFallbackCount: count => {
      if (!context || !gain) return;
      wsSender ??= createWsSender({ context, tap: gain, workletUrl, ...deps.wsSender });
      void wsSender.setListeners(count);
    },
    ...deps.rtcSender,
  });

  function sendSelection(only) {
    const ids = only ? [only] : Object.keys(preferences).filter(id => /^[0-9a-f]{32}$/.test(id)).slice(0, 64);
    const settings = ids.map(id => ({ id, selected: preferences[id]?.selected === true }));
    if (settings.length) channel.send({ type: 'AUDIO_SELECT', settings });
  }
  function sendControls() { channel.send({ type: 'AUDIO_CONTROLS', volume: state.playerVolume, muted: state.playerMuted }); }
  function applyGain() {
    if (!gain || !context) return;
    gain.gain.setTargetAtTime(state.playerMuted ? 0 : state.playerVolume, context.currentTime, 0.02);
  }

  const unsubscribe = channel.subscribe(message => {
    if (disposed) return;
    if (message.type === 'AUDIO_LISTENER') {
      if (message.gone) { known.delete(message.device); quality.delete(message.device); }
      else known.set(message.device, { ...known.get(message.device), ...message });
      publishDevices();
      rtcSender.listener(message);
    } else if (message.type === 'AUDIO_ANSWER') void rtcSender.answer(message);
    else if (message.type === 'AUDIO_STATS') { rtcSender.stats(message); }
  });
  const unsubscribeOpen = channel.onOpen(open => {
    update({ connected: open });
    if (open) {
      sendSelection();
      channel.send({ type: 'AUDIO_STATUS', active: state.active });
      sendControls();
    } else update({ listeners: 0 });
  });
  update({ connected: channel.open });
  if (channel.open) { sendSelection(); channel.send({ type: 'AUDIO_STATUS', active: state.active }); sendControls(); }

  function recoverCapture() {
    if (!state.active || !context || context.state === 'running' || resuming) return;
    resuming = true;
    context.resume().catch(() => {}).finally(() => { resuming = false; });
  }
  const onVisible = () => { if (document.visibilityState === 'visible') recoverCapture(); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pageshow', recoverCapture);

  function stop() {
    generation++;
    rtcSender.setActive(false);
    wsSender?.dispose();
    wsSender = null;
    capture?.getTracks().forEach(track => track.stop());
    try { source?.disconnect(); gain?.disconnect(); } catch { /* ignore */ }
    if (context) { context.onstatechange = null; context.close().catch(() => {}); }
    capture = context = source = gain = destination = null;
    update({ active: false, busy: false, capturePaused: false });
    channel.send({ type: 'AUDIO_STATUS', active: false });
  }

  async function start() {
    if (state.busy || state.active || disposed) return;
    if (!navigator.mediaDevices?.getDisplayMedia || !globalThis.AudioContext) {
      update({ error: 'Open the GM screen at http://localhost:5173 in desktop Chrome or Edge to share PC audio.' });
      return;
    }
    const ticket = ++generation;
    update({ busy: true, error: '' });
    try {
      // Created and resumed during the button gesture, before the asynchronous screen picker.
      context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      context.onstatechange = () => { update({ capturePaused: context?.state !== 'running' }); recoverCapture(); };
      const resumed = context.resume().catch(error => error);
      const selected = await (deps.getDisplayMedia ?? (options => navigator.mediaDevices.getDisplayMedia(options)))({
        video: { displaySurface: 'monitor', frameRate: 1 },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude',
      });
      if (ticket !== generation) { selected.getTracks().forEach(track => track.stop()); return; }
      capture = selected;
      if (!capture.getAudioTracks().length) {
        throw new Error('No audio was shared. Try again: choose Entire Screen and enable Share system audio, or choose a music tab with Share tab audio enabled.');
      }
      for (const track of capture.getTracks()) track.addEventListener('ended', stop, { once: true });
      // Retain the browser's stop-sharing control, but never send screen frames.
      for (const track of capture.getVideoTracks()) track.enabled = false;
      const resumeError = await resumed;
      if (resumeError instanceof Error) throw resumeError;
      if (ticket !== generation) return;
      source = context.createMediaStreamSource(new MediaStream(capture.getAudioTracks()));
      gain = context.createGain();
      gain.gain.value = state.playerMuted ? 0 : state.playerVolume;
      destination = context.createMediaStreamDestination();
      destination.stream.getAudioTracks()[0].contentHint = 'music';
      source.connect(gain);
      gain.connect(destination);
      update({ active: true, busy: false });
      rtcSender.setActive(true);
      channel.send({ type: 'AUDIO_STATUS', active: true });
    } catch (error) {
      if (ticket !== generation) return;
      stop();
      update({ error: error.name === 'NotAllowedError'
        ? 'Audio sharing was canceled or denied. Click Broadcast PC Audio to try again.'
        : error.message || 'Could not start audio capture.' });
    }
  }

  function setPlayerControls(patch) {
    update(patch);
    applyGain();
    if (destination) for (const track of destination.stream.getAudioTracks()) track.enabled = !state.playerMuted;
    sendControls();
  }
  function setDevice(id, patch) {
    const device = state.devices.find(item => item.id === id);
    if (!device) return;
    preferences[id] = { selected: device.selected, name: device.name, ...preferences[id], ...patch };
    savePreferences(preferences);
    publishDevices();
    if (patch.selected !== undefined) sendSelection(id);
  }

  return {
    start, stop, resume: recoverCapture,
    setDevice,
    selectAllDevices: selected => { for (const device of state.devices) setDevice(device.id, { selected }); },
    setPlayerVolume: volume => setPlayerControls({ playerVolume: Math.max(0, Math.min(1, volume)) }),
    setPlayerMuted: muted => setPlayerControls({ playerMuted: muted }),
    dispose() {
      disposed = true;
      unsubscribe(); unsubscribeOpen();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', recoverCapture);
      stop();
      rtcSender.dispose();
    },
  };
}
