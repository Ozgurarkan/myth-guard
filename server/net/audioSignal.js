// Audio signalling and listener registry (design 5.2-5.4, 7.5). It plugs into the hub through the interface of 7.3:
//
//   hub.extend({ playerTypes, gmTypes, onSessionOpen, onSessionClose, onGmChange })
//   hub.upgradeAudio(handler)               -> the fallback relay (audioRelay.js) serves /__realm/audio sockets
//   hub.sendTo(device, obj), hub.sendGm(obj), hub.sessions.{byDevice, gm, players}
//   access.table.list()                     -> the device registry that bounds the listener registry (S5 / test G3)
//
// Message flow (all on the authenticated control sockets; nothing here accepts a connection of its own):
//
//   player  AUDIO_LISTEN {enabled, caps:{rtc,jbt}, playing?}        server -> GM  AUDIO_LISTENER {device, ready, selected, caps, mode, ...}
//   GM      AUDIO_STATUS {active} / AUDIO_CONTROLS {volume,muted} / AUDIO_SELECT {settings:[{id,selected}]}
//                                                                    server -> players  AUDIO_STATUS / AUDIO_CONTROLS {.., selected}
//   GM      AUDIO_OFFER {to, sid, sdp}   server rewrites candidates  -> player AUDIO_OFFER {sid, sdp}
//   player  AUDIO_ANSWER {sid, sdp}      server rewrites candidates  -> GM     AUDIO_ANSWER {from, sid, sdp}
//   player  AUDIO_STATS {sid, mode, ...}                             -> GM     AUDIO_STATS {from, ...}
//   GM      AUDIO_FALLBACK {to, sid, reason}                         -> player AUDIO_FALLBACK {sid, reason}   (the WebSocket path)
//   GM      AUDIO_STOP {to?, sid?, path?}                            -> player(s) AUDIO_STOP {sid?, path?}
//
// A listener's `mode`: idle (not wanted) - pending (wanted, waiting for the GM's offer) - rtc (offer sent) - ws (fallback).
// The server itself decides one thing: a phone that reports caps.rtc=false goes straight to `ws`. Every other fallback
// decision belongs to the GM page (rtcPolicy.js), which sees the connection state.
import { LIMITS, isHex, isId, cleanName } from '../../src/net/protocol.js';
import { rewriteSdp, pickLocalAddress, stripMapped } from './candidates.js';
import { createAudioRelay } from './audioRelay.js';
import { networkInterfaces } from 'node:os';

const MAX_SELECTION = 64;
const MAX_SIDS = 4;
const RESUME_MS = 3000;  // how long a reconnected phone has to confirm that its sound never stopped
const GRACE_MS = 30000; // a phone whose control socket blinked keeps its audio state this long

const num = (value, lo, hi) => (Number.isFinite(value) ? Math.max(lo, Math.min(hi, value)) : 0);
const word = (value, fallback = '') => (typeof value === 'string' && /^[a-z0-9-]{1,32}$/.test(value) ? value : fallback);

/** The local IPv4 addresses with their netmasks, most likely first. `lan.lanAddresses()` (WP2) supplies the ordering. */
function defaultAddresses(lan, interfaces) {
  const masks = new Map();
  for (const entries of Object.values(interfaces())) {
    for (const e of entries ?? []) if (e.family === 'IPv4' && !e.internal) masks.set(e.address, e.netmask);
  }
  const listed = (lan?.lanAddresses?.() ?? []).map(item => (typeof item === 'string' ? { address: item } : item));
  const base = listed.length ? listed : [...masks.keys()].map(address => ({ address }));
  return base.map(item => ({ address: item.address, netmask: item.netmask ?? masks.get(item.address) }));
}

export function createAudioSignal({
  hub, access, metrics, clock, lan,
  relay = createAudioRelay({ metrics, clock }),
  options = {},
} = {}) {
  if (!hub?.extend) throw new TypeError('createAudioSignal needs the hub (7.3)');
  const allowLoopback = options.allowLoopback === true;
  const interfaces = options.interfaces ?? networkInterfaces;
  const graceMs = options.graceMs ?? GRACE_MS;
  const count = (name, n = 1) => { try { metrics?.inc?.(name, n); } catch { /* ignore */ } };
  const gauge = (name, v) => { try { metrics?.gauge?.(name, v); } catch { /* ignore */ } };
  const log = line => { try { metrics?.log?.(line); } catch { /* ignore */ } };

  let active = false;
  let reconnecting = false;
  let controls = { volume: 1, muted: false };
  const listeners = new Map();   // device -> listener
  const selection = new Map();   // device -> { selected }

  // ---- helpers -------------------------------------------------------------------------------------------------------
  function knownDevice(device) {
    if (!isHex(device, 16)) return false;
    try {
      const list = access?.table?.list?.();
      if (Array.isArray(list)) {
        const entry = list.find(item => (item.device ?? item.id) === device);
        return !!entry && entry.status !== 'revoked' && entry.status !== 'pending' && entry.admitted !== false;
      }
    } catch { /* fall through to live sessions */ }
    return (hub.sessions?.byDevice?.(device) ?? []).length > 0;
  }
  const selectedOf = device => selection.get(device)?.selected === true;
  const online = l => !!l.session && l.session.open !== false;
  const wants = l => online(l) && l.enabled && selectedOf(l.device) && active;
  const toSession = (l, message) => { if (online(l)) { try { l.session.sendJson(message); } catch { /* socket closing */ } } };
  const toGm = message => { try { hub.sendGm(message); } catch { /* no GM */ } };
  const gmUp = () => !!hub.sessions?.gm?.();

  function view(l, extra = {}) {
    return {
      type: 'AUDIO_LISTENER', device: l.device, name: l.name, address: l.ip, label: l.label,
      ready: online(l) && l.enabled, selected: selectedOf(l.device), caps: l.caps, mode: l.mode,
      state: l.stats?.mode ?? 'off', ...extra,
    };
  }
  const notify = (l, extra) => { toGm(view(l, extra)); publishGauges(); };

  function publishGauges() {
    let rtc = 0, ws = 0;
    for (const l of listeners.values()) { if (l.mode === 'rtc') rtc++; else if (l.mode === 'ws') ws++; }
    gauge('audio.listeners', listeners.size); gauge('audio.rtc', rtc); gauge('audio.ws', ws);
  }

  function sync(l) { relay.setEligible(l.device, wants(l) && l.mode === 'ws'); }

  /** Re-evaluate what a listener should be doing after anything that affects it changed. */
  function decide(l) {
    if (!wants(l)) {
      l.mode = 'idle';
      sync(l);
      notify(l); // the GM lists every connected device, wanted or not ("Ready" / "Needs a tap")
      return;
    }
    if (l.mode === 'idle') {
      if (!l.caps.rtc) {
        l.mode = 'ws';
        toSession(l, { type: 'AUDIO_FALLBACK', sid: '', reason: 'no-rtc' });
        count('audio.fallback');
      } else l.mode = 'pending';
    }
    sync(l);
    notify(l);
  }

  function sendControls(session, device) {
    try { session.sendJson({ type: 'AUDIO_CONTROLS', volume: controls.volume, muted: controls.muted, selected: selectedOf(device) }); } catch { /* closing */ }
  }
  function sendStatus(session) {
    try { session.sendJson({ type: 'AUDIO_STATUS', active, reconnecting }); } catch { /* closing */ }
  }
  function broadcastStatus() {
    for (const session of hub.sessions?.players?.() ?? []) sendStatus(session);
  }
  function broadcastControls() {
    for (const session of hub.sessions?.players?.() ?? []) sendControls(session, session.device);
  }

  function remove(l, why) {
    clock?.clearTimeout?.(l.timer);
    clock?.clearTimeout?.(l.resumeTimer);
    listeners.delete(l.device);
    relay.setEligible(l.device, false);
    toGm({ type: 'AUDIO_LISTENER', device: l.device, gone: true, ready: false, selected: false, mode: 'idle' });
    publishGauges();
    if (why) log(`audio: listener ${l.device.slice(0, 8)} removed (${why})`);
  }

  // ---- player messages -----------------------------------------------------------------------------------------------
  function onListen(session, msg) {
    const device = session.device;
    if (!knownDevice(device)) { count('audio.rejected.unknown-device'); return; }
    let l = listeners.get(device);
    if (!l && listeners.size >= LIMITS.maxAdmittedDevices + LIMITS.maxPendingDevices) { count('audio.rejected.registry-full'); return; }
    const enabled = msg?.enabled === true;
    const caps = { rtc: msg?.caps?.rtc === true, jbt: msg?.caps?.jbt === true };
    const playing = msg?.playing === 'rtc' || msg?.playing === 'ws' ? msg.playing : null;
    const fresh = !l;
    if (!l) {
      l = { device, session: null, name: '', ip: '', label: '', enabled: false, caps, mode: 'idle', sids: [], stats: null, timer: null };
      listeners.set(device, l);
    }
    clock?.clearTimeout?.(l.timer);
    l.timer = null;
    const sameSession = l.session === session;
    l.session = session;
    l.name = cleanName(session.name);
    l.ip = stripMapped(session.ip) ?? '';
    l.label = cleanName(session.label, 60);
    // A reconnected control socket that still has working audio keeps it: a Wi-Fi blink must not restart the sound.
    const sameShape = !fresh && !sameSession && enabled && caps.rtc === l.caps.rtc && (l.mode === 'rtc' || l.mode === 'ws');
    const keeps = sameShape && playing === l.mode;
    // The hub's validator keeps only the documented fields of AUDIO_LISTEN, so `playing` normally does not arrive. Then the
    // old state is kept provisionally and the phone has 3 s to confirm it with an AUDIO_STATS of the same mode.
    const provisional = sameShape && msg?.playing === undefined;
    clock?.clearTimeout?.(l.resumeTimer);
    l.resumeTimer = null;
    l.resume = null;
    const changed = enabled !== l.enabled || caps.rtc !== l.caps.rtc;
    l.enabled = enabled;
    l.caps = caps;
    if (provisional && !changed) {
      l.resume = { mode: l.mode, session };
      l.resumeTimer = clock?.setTimeout?.(() => {
        if (!l.resume) return;
        l.resume = null; l.resumeTimer = null; l.mode = 'idle'; l.sids = [];
        decide(l);
      }, RESUME_MS) ?? null;
    } else if (!keeps && (changed || !sameSession)) { l.mode = 'idle'; l.sids = []; }
    count('audio.listen');
    sendStatus(session);
    sendControls(session, device);
    decide(l);
  }

  function onAnswer(session, msg) {
    const l = listeners.get(session.device);
    if (!l || l.session !== session || !isId(msg?.sid) || !l.sids.includes(msg.sid)) { count('audio.rejected.answer-unexpected'); return; }
    const result = rewriteSdp(msg.sdp, { address: session.ip, role: 'player', allowLoopback });
    if (!result.ok) {
      count(`audio.rejected.answer-${result.reason}`);
      log(`audio: answer from ${l.device.slice(0, 8)} refused (${result.reason})`);
      notify(l, { error: `answer-${result.reason}` });
      return;
    }
    count('audio.answer');
    toGm({ type: 'AUDIO_ANSWER', from: l.device, sid: msg.sid, sdp: result.sdp });
  }

  function onStats(session, msg) {
    const l = listeners.get(session.device);
    if (!l || l.session !== session) return;
    const mode = ['rtc', 'ws', 'off', 'failed'].includes(msg?.mode) ? msg.mode : 'off';
    const stats = {
      mode, sid: isId(msg?.sid) ? msg.sid : '',
      lossPct: num(msg?.lossPct, 0, 100), concealedPct: num(msg?.concealedPct, 0, 100),
      jitterBufferMs: num(msg?.jitterBufferMs, 0, 60000), targetMs: num(msg?.targetMs, 0, 60000),
      underruns: Math.round(num(msg?.underruns, 0, 1e7)), silentMs30s: Math.round(num(msg?.silentMs30s, 0, 30000)),
      rttMs: Math.round(num(msg?.rttMs, 0, 60000)), bufferedMs: Math.round(num(msg?.bufferedMs, 0, 60000)),
      skipped: Math.round(num(msg?.skipped, 0, 1e7)),
    };
    l.stats = stats;
    if (l.resume && l.resume.session === session && stats.mode === l.resume.mode) {
      clock?.clearTimeout?.(l.resumeTimer);
      l.resume = null; l.resumeTimer = null;
      count('audio.resumed');
    }
    count('audio.stats');
    toGm({ type: 'AUDIO_STATS', from: l.device, ...stats });
  }

  // ---- GM messages ---------------------------------------------------------------------------------------------------
  function onGmStatus(_session, msg) {
    const next = msg?.active === true;
    if (next === active && !reconnecting) return;
    active = next;
    reconnecting = false;
    relay.setActive(active);
    broadcastStatus();
    for (const l of listeners.values()) {
      if (!active) l.sids = [];
      decide(l);
    }
  }

  function onGmControls(_session, msg) {
    if (!Number.isFinite(msg?.volume) || typeof msg?.muted !== 'boolean') return;
    controls = { volume: Math.max(0, Math.min(1, msg.volume)), muted: msg.muted };
    broadcastControls();
  }

  function onGmSelect(_session, msg) {
    if (!Array.isArray(msg?.settings)) return;
    for (const item of msg.settings.slice(0, MAX_SELECTION)) {
      const device = item?.id;
      if (typeof item?.selected !== 'boolean' || !knownDevice(device)) { count('audio.rejected.select'); continue; }
      if (!selection.has(device) && selection.size >= MAX_SELECTION) continue;
      const was = selectedOf(device);
      selection.set(device, { selected: item.selected });
      const l = listeners.get(device);
      for (const session of hub.sessions?.byDevice?.(device) ?? []) sendControls(session, device);
      if (l) {
        if (was && !item.selected) toSession(l, { type: 'AUDIO_STOP' });
        decide(l);
      }
    }
  }

  function onGmOffer(session, msg) {
    const l = isHex(msg?.to, 16) ? listeners.get(msg.to) : null;
    if (!l || !wants(l) || !isId(msg?.sid)) { count('audio.rejected.offer-target'); return; }
    if (!l.caps.rtc) { count('audio.rejected.offer-no-rtc'); return; }
    const address = pickLocalAddress(l.ip, defaultAddresses(lan, interfaces));
    const result = rewriteSdp(msg.sdp, { address, role: 'gm', allowLoopback });
    if (!result.ok) {
      count(`audio.rejected.offer-${result.reason}`);
      log(`audio: offer for ${l.device.slice(0, 8)} refused (${result.reason})`);
      toGm({ type: 'AUDIO_LISTENER', device: l.device, error: `offer-${result.reason}`, ready: online(l) && l.enabled, selected: true, mode: l.mode });
      return;
    }
    l.sids.push(msg.sid);
    while (l.sids.length > MAX_SIDS) l.sids.shift();
    if (l.mode === 'pending' || l.mode === 'idle') l.mode = 'rtc';
    count('audio.offer');
    toSession(l, { type: 'AUDIO_OFFER', sid: msg.sid, sdp: result.sdp });
    sync(l);
    notify(l);
  }

  function onGmFallback(_session, msg) {
    const l = isHex(msg?.to, 16) ? listeners.get(msg.to) : null;
    if (!l || !wants(l)) { count('audio.rejected.fallback-target'); return; }
    l.mode = 'ws';
    l.sids = [];
    count('audio.fallback');
    log(`audio: ${l.device.slice(0, 8)} falls back to the WebSocket path (${word(msg?.reason, 'unspecified')})`);
    toSession(l, { type: 'AUDIO_FALLBACK', sid: isId(msg?.sid) ? msg.sid : '', reason: word(msg?.reason, 'unspecified') });
    sync(l);
    notify(l);
  }

  function onGmStop(_session, msg) {
    const targets = msg?.to === undefined ? [...listeners.values()] : isHex(msg.to, 16) && listeners.has(msg.to) ? [listeners.get(msg.to)] : [];
    const path = msg?.path === 'ws' || msg?.sid === 'ws' ? 'ws' : undefined; // the hub's validator keeps `sid` but not `path`: sid 'ws' names the path
    const sid = path ? undefined : isId(msg?.sid) ? msg.sid : undefined;
    for (const l of targets) {
      toSession(l, { type: 'AUDIO_STOP', ...(sid ? { sid } : {}), ...(path ? { sid: 'ws', path } : {}) });
      if (path === 'ws') { if (l.mode === 'ws') l.mode = 'rtc'; }
      else if (!sid) { l.mode = 'idle'; l.sids = []; }
      sync(l);
      notify(l);
    }
  }

  // ---- lifecycle -----------------------------------------------------------------------------------------------------
  function onSessionOpen(session) {
    if (session.role === 'gm') return;
    sendStatus(session);
    sendControls(session, session.device);
  }

  function onSessionClose(session) {
    const l = listeners.get(session.device);
    if (!l || l.session !== session) return;
    const others = (hub.sessions?.byDevice?.(session.device) ?? []).filter(s => s !== session && s.role !== 'gm');
    if (others.length) { l.session = others[others.length - 1]; return; }
    l.session = null;
    sync(l);
    notify(l);
    l.timer = clock?.setTimeout?.(() => remove(l, 'control socket gone'), graceMs) ?? null;
    if (!clock) remove(l, 'control socket gone');
  }

  function onGmChange(connected) {
    if (connected) {
      reconnecting = false;
      for (const l of listeners.values()) notify(l);
      return;
    }
    // The GM page went away. Players keep their screen and show "reconnecting" instead of silence being unexplained.
    reconnecting = active;
    active = false;
    relay.setActive(false);
    broadcastStatus();
    for (const l of listeners.values()) { l.sids = []; sync(l); }
  }

  // Which listener entries a revoked device leaves behind is the registry's business (kick closes its sockets);
  // forget selections of devices the registry no longer knows so the map stays bounded by it.
  try {
    access?.table?.on?.('change', () => {
      for (const device of [...selection.keys()]) if (!knownDevice(device)) selection.delete(device);
      for (const l of [...listeners.values()]) if (!knownDevice(l.device)) remove(l, 'device removed');
    });
  } catch { /* the registry has no events in a test double */ }

  hub.extend({
    playerTypes: { AUDIO_LISTEN: onListen, AUDIO_ANSWER: onAnswer, AUDIO_STATS: onStats },
    gmTypes: {
      AUDIO_OFFER: onGmOffer, AUDIO_CONTROLS: onGmControls, AUDIO_STATUS: onGmStatus,
      AUDIO_SELECT: onGmSelect, AUDIO_FALLBACK: onGmFallback, AUDIO_STOP: onGmStop,
    },
    onSessionOpen, onSessionClose, onGmChange,
    rosterAudio: device => audioOf(device),
  });
  hub.upgradeAudio((ws, auth) => relay.attach(ws, auth));

  function audioOf(device) {
    const l = listeners.get(device);
    if (!l || l.mode === 'idle') return { mode: 'off', state: 'off' };
    const s = l.stats ?? {};
    return {
      mode: l.mode === 'rtc' ? 'webrtc' : l.mode === 'ws' ? 'ws' : 'off', state: s.mode ?? (l.mode === 'pending' ? 'waiting' : 'connecting'),
      rttMs: s.rttMs ?? 0, lossPct: s.lossPct ?? 0, concealedPct: s.concealedPct ?? 0, jitterBufferMs: s.jitterBufferMs ?? 0, underruns: s.underruns ?? 0,
    };
  }

  return {
    /** Snapshot of the registry, for /diag and the roster. */
    listeners: () => [...listeners.values()].map(l => ({
      device: l.device, name: l.name, ip: l.ip, label: l.label, enabled: l.enabled, online: online(l), selected: selectedOf(l.device),
      caps: { ...l.caps }, mode: l.mode, stats: l.stats ? { ...l.stats } : null,
    })),
    /** The `audio` object of a device in the roster / diag (design 4.12). */
    audioOf,
    /** The GM-side audio state the server knows. */
    onGmAudioState: () => ({ active, reconnecting, volume: controls.volume, muted: controls.muted, selected: [...selection.values()].filter(s => s.selected).length, listeners: listeners.size }),
    relay,
    close() { for (const l of listeners.values()) clock?.clearTimeout?.(l.timer); listeners.clear(); relay.close(); },
  };
}
