import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioSignal } from '../server/net/audioSignal.js';
import { candidateAddresses } from '../server/net/candidates.js';
import { PLAYER_TYPES, GM_TYPES } from '../src/net/protocol.js';
import { createClock, createFakeMetrics, createFakeHub, createFakeAccess, FAKE_INTERFACES, hex16 } from '../test-support/wp5-fakes.js';
import { EDGE_OFFER, EDGE_ANSWER } from '../test-support/wp5-sdp-edge.js';

const A = hex16(0xa1);
const B = hex16(0xb2);
const C = hex16(0xc3);
const LAN = { lanAddresses: () => [{ address: '10.60.25.83' }, { address: '192.168.1.10' }] };

function setup({ devices = [A, B], options = {} } = {}) {
  const clock = createClock();
  const metrics = createFakeMetrics();
  const hub = createFakeHub({ metrics });
  const access = createFakeAccess(devices.map(device => ({ device })));
  const signal = createAudioSignal({ hub, access, metrics, clock, lan: LAN, options: { interfaces: FAKE_INTERFACES, ...options } });
  const gm = hub.addGm();
  const player = (device, extra) => hub.addPlayer(device, extra);
  const listen = (session, extra = {}) => hub.deliver(session, { type: 'AUDIO_LISTEN', enabled: true, caps: { rtc: true, jbt: true }, ...extra });
  const select = (device, selected = true) => hub.deliver(gm, { type: 'AUDIO_SELECT', settings: [{ id: device, selected }] });
  const start = () => hub.deliver(gm, { type: 'AUDIO_STATUS', active: true });
  return { clock, metrics, hub, access, signal, gm, player, listen, select, start };
}

test('it plugs into the hub with exactly the message types the protocol catalogue allows from each side', () => {
  const { hub } = setup();
  const [extension] = hub.extensions;
  assert.deepEqual(Object.keys(extension.playerTypes).sort(), ['AUDIO_ANSWER', 'AUDIO_LISTEN', 'AUDIO_STATS']);
  assert.deepEqual(Object.keys(extension.gmTypes).sort(), ['AUDIO_CONTROLS', 'AUDIO_FALLBACK', 'AUDIO_OFFER', 'AUDIO_SELECT', 'AUDIO_STATUS', 'AUDIO_STOP']);
  for (const type of Object.keys(extension.playerTypes)) assert.ok(PLAYER_TYPES.has(type), type);
  for (const type of Object.keys(extension.gmTypes)) assert.ok(GM_TYPES.has(type), type);
  assert.equal(typeof extension.onSessionOpen, 'function');
  assert.equal(typeof extension.onSessionClose, 'function');
  assert.equal(typeof extension.onGmChange, 'function');
  assert.ok(hub.openAudio('player', A), 'hub.upgradeAudio was registered');
});

test('full WebRTC flow: listen -> select -> offer (rewritten to the GM LAN address) -> answer (rewritten to the phone IP) -> stats', () => {
  const { hub, gm, player, listen, select, start, signal } = setup();
  const phone = player(A, { ip: '::ffff:192.168.1.42' });
  start();
  listen(phone);
  assert.deepEqual(phone.last('AUDIO_STATUS'), { type: 'AUDIO_STATUS', active: true, reconnecting: false });
  assert.equal(phone.last('AUDIO_CONTROLS').selected, false, 'new arrivals never inherit a selection');
  assert.equal(gm.last('AUDIO_LISTENER').ready, true);
  assert.equal(gm.last('AUDIO_LISTENER').selected, false);
  select(A);
  assert.equal(phone.last('AUDIO_CONTROLS').selected, true);
  const wanted = gm.last('AUDIO_LISTENER');
  assert.deepEqual([wanted.device, wanted.ready, wanted.selected, wanted.mode, wanted.address], [A, true, true, 'pending', '192.168.1.42']);

  hub.deliver(gm, { type: 'AUDIO_OFFER', to: A, sid: 's1', sdp: EDGE_OFFER });
  const offer = phone.last('AUDIO_OFFER');
  assert.equal(offer.sid, 's1');
  assert.deepEqual(candidateAddresses(offer.sdp), ['192.168.1.10'], 'the GM address on the phone\'s subnet, not the mDNS name');
  assert.equal(signal.listeners()[0].mode, 'rtc');

  hub.deliver(phone, { type: 'AUDIO_ANSWER', sid: 's1', sdp: EDGE_ANSWER });
  const answer = gm.last('AUDIO_ANSWER');
  assert.equal(answer.from, A);
  assert.deepEqual(candidateAddresses(answer.sdp), ['192.168.1.42'], 'the phone\'s own address as the server sees it (::ffff: removed)');

  hub.deliver(phone, { type: 'AUDIO_STATS', sid: 's1', mode: 'rtc', lossPct: 1.5, concealedPct: 2, jitterBufferMs: 800, underruns: 0, silentMs30s: 0 });
  assert.deepEqual([gm.last('AUDIO_STATS').from, gm.last('AUDIO_STATS').lossPct, gm.last('AUDIO_STATS').jitterBufferMs], [A, 1.5, 800]);
  assert.deepEqual(signal.audioOf(A), { mode: 'webrtc', state: 'rtc', rttMs: 0, lossPct: 1.5, concealedPct: 2, jitterBufferMs: 800, underruns: 0 });
});

test('the offer address follows the phone\'s subnet (netmask match), else the first LAN address', () => {
  const { hub, gm, player, listen, select, start } = setup();
  start();
  const other = player(A, { ip: '10.60.25.200' });
  listen(other); select(A);
  hub.deliver(gm, { type: 'AUDIO_OFFER', to: A, sid: 's1', sdp: EDGE_OFFER });
  assert.deepEqual(candidateAddresses(other.last('AUDIO_OFFER').sdp), ['10.60.25.83']);
  const far = player(B, { ip: '172.20.9.9' });
  listen(far); select(B);
  hub.deliver(gm, { type: 'AUDIO_OFFER', to: B, sid: 's2', sdp: EDGE_OFFER });
  assert.deepEqual(candidateAddresses(far.last('AUDIO_OFFER').sdp), ['10.60.25.83'], 'no match: the first address');
});

test('G1: a hostile answer never reaches the GM: oversize, malformed, wrong sid, extra media, foreign addresses', () => {
  const { hub, gm, player, listen, select, start, metrics } = setup();
  const phone = player(A);
  start(); listen(phone); select(A);
  hub.deliver(gm, { type: 'AUDIO_OFFER', to: A, sid: 's1', sdp: EDGE_OFFER });
  gm.clear();
  const handler = hub.extensions[0].playerTypes.AUDIO_ANSWER; // the hub's cap would stop an oversize frame first; the server must also refuse it itself
  handler(phone, { type: 'AUDIO_ANSWER', sid: 's1', sdp: EDGE_ANSWER + 'a=x:' + 'y'.repeat(13000) });
  handler(phone, { type: 'AUDIO_ANSWER', sid: 's1', sdp: 'not sdp at all' });
  handler(phone, { type: 'AUDIO_ANSWER', sid: 's1', sdp: EDGE_ANSWER + 'm=audio 9 UDP/TLS/RTP/SAVPF 0\r\na=mid:1\r\n' });
  handler(phone, { type: 'AUDIO_ANSWER', sid: 'never-offered', sdp: EDGE_ANSWER });
  handler(phone, { type: 'AUDIO_ANSWER', sid: 5, sdp: EDGE_ANSWER });
  handler(phone, { type: 'AUDIO_ANSWER', sid: 's1', sdp: 12345 });
  handler(phone, null);
  assert.equal(gm.of('AUDIO_ANSWER').length, 0);
  assert.ok(metrics.startsWith('audio.rejected.answer').length >= 3);
  // an answer that lists other hosts is passed on with only the phone's own address
  const sneaky = EDGE_ANSWER.replace('a=ice-ufrag', 'a=candidate:9 1 udp 1 8.8.8.8 4000 typ srflx\r\na=candidate:8 1 udp 2 10.1.1.1 4001 typ host\r\na=ice-ufrag');
  handler(phone, { type: 'AUDIO_ANSWER', sid: 's1', sdp: sneaky });
  assert.equal(gm.of('AUDIO_ANSWER').length, 1);
  assert.deepEqual([...new Set(candidateAddresses(gm.last('AUDIO_ANSWER').sdp))], ['192.168.1.42']);
});

test('an answer is only accepted from the socket that was offered to', () => {
  const { hub, gm, player, listen, select, start } = setup();
  const phone = player(A);
  start(); listen(phone); select(A);
  hub.deliver(gm, { type: 'AUDIO_OFFER', to: A, sid: 's1', sdp: EDGE_OFFER });
  const tab2 = player(A);
  hub.deliver(tab2, { type: 'AUDIO_ANSWER', sid: 's1', sdp: EDGE_ANSWER });
  assert.equal(gm.of('AUDIO_ANSWER').length, 0);
  hub.deliver(phone, { type: 'AUDIO_ANSWER', sid: 's1', sdp: EDGE_ANSWER });
  assert.equal(gm.of('AUDIO_ANSWER').length, 1);
});

test('offers go only to a listening, selected device while the GM is broadcasting, and only if the SDP survives', () => {
  const { hub, gm, player, listen, select, start, metrics } = setup();
  const phone = player(A);
  hub.deliver(gm, { type: 'AUDIO_OFFER', to: A, sid: 's0', sdp: EDGE_OFFER });
  assert.equal(phone.of('AUDIO_OFFER').length, 0, 'not listening');
  listen(phone);
  hub.deliver(gm, { type: 'AUDIO_OFFER', to: A, sid: 's0', sdp: EDGE_OFFER });
  assert.equal(phone.of('AUDIO_OFFER').length, 0, 'not selected, not broadcasting');
  select(A);
  hub.deliver(gm, { type: 'AUDIO_OFFER', to: A, sid: 's0', sdp: EDGE_OFFER });
  assert.equal(phone.of('AUDIO_OFFER').length, 0, 'not broadcasting');
  start();
  hub.deliver(gm, { type: 'AUDIO_OFFER', to: A, sid: 's0', sdp: 'garbage' });
  assert.equal(phone.of('AUDIO_OFFER').length, 0);
  assert.match(gm.last('AUDIO_LISTENER').error, /^offer-/);
  hub.deliver(gm, { type: 'AUDIO_OFFER', to: hex16(0xdead), sid: 's0', sdp: EDGE_OFFER });
  hub.deliver(gm, { type: 'AUDIO_OFFER', to: A, sid: 'bad sid!', sdp: EDGE_OFFER });
  assert.equal(phone.of('AUDIO_OFFER').length, 0);
  assert.ok(metrics.get('audio.rejected.offer-target') >= 3);
  hub.deliver(gm, { type: 'AUDIO_OFFER', to: A, sid: 's1', sdp: EDGE_OFFER });
  assert.equal(phone.of('AUDIO_OFFER').length, 1);
});

test('a phone without RTCPeerConnection goes straight to the WebSocket path, and only a selected one is fed', () => {
  const { gm, player, listen, select, start, signal, hub } = setup();
  const phone = player(A);
  start();
  listen(phone, { caps: { rtc: false, jbt: false } });
  assert.equal(phone.of('AUDIO_FALLBACK').length, 0, 'not selected yet');
  const ws = hub.openAudio('player', A);
  assert.equal(signal.relay.isEligible(A), false);
  select(A);
  assert.deepEqual(phone.last('AUDIO_FALLBACK'), { type: 'AUDIO_FALLBACK', sid: '', reason: 'no-rtc' });
  assert.equal(signal.relay.isEligible(A), true);
  assert.equal(gm.last('AUDIO_LISTENER').mode, 'ws');
  assert.ok(ws);
  select(A, false);
  assert.equal(phone.last('AUDIO_STOP').type, 'AUDIO_STOP');
  assert.equal(signal.relay.isEligible(A), false);
});

test('the GM decides a fallback; the WebSocket path starts feeding that device; a later AUDIO_STOP path:ws hands it back to WebRTC', () => {
  const { hub, gm, player, listen, select, start, signal } = setup();
  const phone = player(A);
  start(); listen(phone); select(A);
  hub.deliver(gm, { type: 'AUDIO_OFFER', to: A, sid: 's1', sdp: EDGE_OFFER });
  assert.equal(signal.relay.isEligible(A), false, 'WebRTC is in charge');
  hub.deliver(gm, { type: 'AUDIO_FALLBACK', to: A, sid: 's1', reason: 'ice-failed' });
  assert.deepEqual(phone.last('AUDIO_FALLBACK'), { type: 'AUDIO_FALLBACK', sid: 's1', reason: 'ice-failed' });
  assert.equal(signal.relay.isEligible(A), true);
  assert.equal(signal.listeners()[0].mode, 'ws');
  // a retry offer while on the fallback keeps the WebSocket path running
  hub.deliver(gm, { type: 'AUDIO_OFFER', to: A, sid: 's2', sdp: EDGE_OFFER });
  assert.equal(phone.last('AUDIO_OFFER').sid, 's2');
  assert.equal(signal.relay.isEligible(A), true);
  hub.deliver(gm, { type: 'AUDIO_STOP', to: A, sid: 'ws' }); // the validator keeps sid but not path, so sid 'ws' names the WebSocket path
  assert.deepEqual(phone.last('AUDIO_STOP'), { type: 'AUDIO_STOP', sid: 'ws', path: 'ws' });
  assert.equal(signal.relay.isEligible(A), false);
  assert.equal(signal.listeners()[0].mode, 'rtc');
  // weird reasons are normalised, not echoed
  hub.deliver(gm, { type: 'AUDIO_FALLBACK', to: A, sid: 's3', reason: '<script>alert(1)</script>' });
  assert.equal(phone.last('AUDIO_FALLBACK').reason, 'unspecified');
});

test('AUDIO_STOP without a target stops everybody; with a sid only that connection', () => {
  const { hub, gm, player, listen, select, start, signal } = setup();
  const one = player(A), two = player(B);
  start(); listen(one); listen(two); select(A); select(B);
  hub.deliver(gm, { type: 'AUDIO_STOP', to: A, sid: 's1' });
  assert.deepEqual(one.last('AUDIO_STOP'), { type: 'AUDIO_STOP', sid: 's1' });
  assert.equal(two.of('AUDIO_STOP').length, 0);
  assert.equal(signal.listeners().find(l => l.device === A).mode, 'pending', 'a sid-only stop closes one connection, not the listener');
  hub.deliver(gm, { type: 'AUDIO_STOP' });
  assert.equal(two.of('AUDIO_STOP').length, 1);
  assert.deepEqual(signal.listeners().map(l => l.mode), ['idle', 'idle']);
});

test('volume and mute are the GM\'s alone, are clamped, and every player hears them with its own `selected`', () => {
  const { hub, gm, player, listen, select } = setup();
  const one = player(A), two = player(B);
  listen(one); listen(two); select(A);
  hub.deliver(gm, { type: 'AUDIO_CONTROLS', volume: 7, muted: true });
  assert.deepEqual(one.last('AUDIO_CONTROLS'), { type: 'AUDIO_CONTROLS', volume: 1, muted: true, selected: true });
  assert.deepEqual(two.last('AUDIO_CONTROLS'), { type: 'AUDIO_CONTROLS', volume: 1, muted: true, selected: false });
  hub.deliver(gm, { type: 'AUDIO_CONTROLS', volume: 0.35, muted: false });
  assert.equal(two.last('AUDIO_CONTROLS').volume, 0.35);
  hub.deliver(gm, { type: 'AUDIO_CONTROLS', volume: 'loud', muted: false });
  hub.deliver(gm, { type: 'AUDIO_CONTROLS', volume: NaN, muted: false });
  assert.equal(two.last('AUDIO_CONTROLS').volume, 0.35, 'junk is ignored');
  assert.throws(() => hub.deliver(one, { type: 'AUDIO_CONTROLS', volume: 1, muted: false }), /not accepted from a player/, 'players cannot send GM controls');
  assert.throws(() => hub.deliver(one, { type: 'AUDIO_STATUS', active: true }), /not accepted/);
  assert.throws(() => hub.deliver(one, { type: 'AUDIO_OFFER', to: A, sid: 'x', sdp: EDGE_OFFER }), /not accepted/);
});

test('a late joiner gets the current status and controls at once, before it says anything', () => {
  const { hub, gm, player, start } = setup();
  start();
  hub.deliver(gm, { type: 'AUDIO_CONTROLS', volume: 0.6, muted: false });
  const late = player(B);
  assert.deepEqual(late.last('AUDIO_STATUS'), { type: 'AUDIO_STATUS', active: true, reconnecting: false });
  assert.deepEqual(late.last('AUDIO_CONTROLS'), { type: 'AUDIO_CONTROLS', volume: 0.6, muted: false, selected: false });
});

test('the GM window going away shows players "reconnecting" and stops the relay; coming back re-announces every listener', () => {
  const { hub, gm, player, listen, select, start, signal } = setup();
  const phone = player(A);
  start(); listen(phone, { caps: { rtc: false, jbt: false } }); select(A);
  assert.equal(signal.relay.isEligible(A), true);
  hub.dropSession(gm);
  assert.deepEqual(phone.last('AUDIO_STATUS'), { type: 'AUDIO_STATUS', active: false, reconnecting: true });
  assert.equal(signal.relay.isEligible(A), false);
  const back = hub.addGm();
  assert.equal(back.of('AUDIO_LISTENER').length, 1);
  assert.equal(back.last('AUDIO_LISTENER').device, A);
  assert.equal(back.last('AUDIO_LISTENER').selected, true, 'selections survive a GM reload within the server\'s life');
  hub.deliver(back, { type: 'AUDIO_STATUS', active: true });
  assert.deepEqual(phone.last('AUDIO_STATUS'), { type: 'AUDIO_STATUS', active: true, reconnecting: false });
  assert.equal(signal.relay.isEligible(A), true);
  hub.deliver(back, { type: 'AUDIO_STATUS', active: false });
  assert.equal(phone.last('AUDIO_STATUS').active, false);
  assert.equal(signal.relay.isEligible(A), false);
});

test('G3: the listener registry is bounded by the device registry; 2,000 unknown sockets create nothing and tell the GM nothing', () => {
  const { hub, gm, signal, metrics } = setup({ devices: [A] });
  gm.clear();
  for (let i = 0; i < 2000; i++) {
    const stranger = hub.addPlayer(hex16(0x100000 + i));
    hub.deliver(stranger, { type: 'AUDIO_LISTEN', enabled: true, caps: { rtc: true, jbt: true } });
    hub.dropSession(stranger);
  }
  assert.equal(signal.listeners().length, 0);
  assert.equal(gm.of('AUDIO_LISTENER').length, 0);
  assert.equal(metrics.get('audio.rejected.unknown-device'), 2000);
  const stranger = hub.addPlayer(hex16(0xfeed));
  hub.deliver(gm, { type: 'AUDIO_SELECT', settings: [{ id: hex16(0xfeed), selected: true }, { id: 'zzz', selected: true }, { id: A, selected: 'yes' }] });
  assert.equal(stranger.of('AUDIO_CONTROLS').filter(m => m.selected).length, 0, 'selecting a device the registry does not know does nothing');
  assert.equal(metrics.get('audio.rejected.select'), 3);
});

test('G3: even a full table of known devices cannot grow the registry beyond cap + pending', () => {
  const devices = Array.from({ length: 40 }, (_, i) => hex16(0x2000 + i));
  const { hub, signal } = setup({ devices });
  for (const device of devices) {
    const phone = hub.addPlayer(device);
    hub.deliver(phone, { type: 'AUDIO_LISTEN', enabled: true, caps: { rtc: true, jbt: true } });
  }
  assert.equal(signal.listeners().length, 20);
});

test('a kicked device disappears from the registry and the selection', () => {
  const { hub, gm, access, player, listen, select, signal } = setup();
  const phone = player(A);
  listen(phone); select(A);
  access.revoke(A);
  assert.equal(signal.listeners().length, 0);
  assert.equal(gm.last('AUDIO_LISTENER').gone, true);
  assert.equal(signal.onGmAudioState().selected, 0);
  assert.ok(hub);
});

test('a control socket that blinks keeps working audio; one that comes back without it starts over', () => {
  const { hub, gm, player, listen, select, start, signal, clock } = setup();
  const phone = player(A);
  start(); listen(phone); select(A);
  hub.deliver(gm, { type: 'AUDIO_OFFER', to: A, sid: 's1', sdp: EDGE_OFFER });
  hub.dropSession(phone);
  assert.equal(gm.last('AUDIO_LISTENER').ready, false, 'the GM sees it offline');
  assert.equal(signal.listeners().length, 1, 'but the record is kept for a while');
  clock.advance(5000);
  const again = player(A);
  listen(again, { playing: 'rtc' });
  assert.equal(signal.listeners()[0].mode, 'rtc', 'the phone says its WebRTC audio never stopped');
  assert.equal(again.of('AUDIO_OFFER').length, 0, 'no new offer');
  hub.dropSession(again);
  clock.advance(5000);
  const confirmed = player(A);
  listen(confirmed);
  hub.deliver(confirmed, { type: 'AUDIO_STATS', sid: 's1', mode: 'rtc' }); // the same thing, the way the real validator lets it through
  clock.advance(5000);
  assert.equal(signal.listeners()[0].mode, 'rtc', 'an AUDIO_STATS of the same mode confirms it');
  hub.dropSession(confirmed);
  clock.advance(5000);
  const third = player(A);
  listen(third); // came back, and says nothing about what is playing (the validator drops that field)
  assert.equal(signal.listeners()[0].mode, 'rtc', 'kept provisionally');
  clock.advance(3100);
  assert.equal(signal.listeners()[0].mode, 'pending', 'nobody confirmed it: start over');
  assert.equal(gm.last('AUDIO_LISTENER').mode, 'pending', 'the GM is told to offer again');
});

test('after 30 s without a control socket the listener is forgotten and the relay stops feeding it', () => {
  const { hub, gm, player, listen, select, start, signal, clock } = setup();
  const phone = player(A);
  start(); listen(phone, { caps: { rtc: false, jbt: false } }); select(A);
  assert.equal(signal.relay.isEligible(A), true);
  hub.dropSession(phone);
  assert.equal(signal.relay.isEligible(A), false, 'offline devices get no frames');
  clock.advance(29000);
  assert.equal(signal.listeners().length, 1);
  clock.advance(2000);
  assert.equal(signal.listeners().length, 0);
  assert.equal(gm.last('AUDIO_LISTENER').gone, true);
});

test('a second window of the same device takes over; closing it hands back to the first', () => {
  const { hub, gm, player, listen, select, start, signal } = setup();
  const first = player(A), second = player(A);
  start(); listen(first); select(A);
  hub.deliver(gm, { type: 'AUDIO_OFFER', to: A, sid: 's1', sdp: EDGE_OFFER });
  assert.equal(first.of('AUDIO_OFFER').length, 1);
  listen(second);
  hub.deliver(gm, { type: 'AUDIO_OFFER', to: A, sid: 's2', sdp: EDGE_OFFER });
  assert.equal(second.of('AUDIO_OFFER').length, 1);
  assert.equal(first.of('AUDIO_OFFER').length, 1, 'offers follow the window that is listening');
  hub.dropSession(second);
  assert.equal(signal.listeners().length, 1, 'the other window keeps the record');
  assert.equal(signal.listeners()[0].online, true);
});

test('AUDIO_STATS is clamped and normalised before the GM sees it', () => {
  const { hub, gm, player, listen } = setup();
  const phone = player(A);
  listen(phone);
  hub.deliver(phone, { type: 'AUDIO_STATS', sid: 'a b', mode: 'hacked', lossPct: -5, concealedPct: 1e9, jitterBufferMs: NaN, underruns: 1.7, silentMs30s: Infinity, extra: 'x'.repeat(100) });
  const stats = gm.last('AUDIO_STATS');
  assert.deepEqual(stats, { type: 'AUDIO_STATS', from: A, mode: 'off', sid: '', lossPct: 0, concealedPct: 100, jitterBufferMs: 0, targetMs: 0, underruns: 2, silentMs30s: 0, rttMs: 0, bufferedMs: 0, skipped: 0 });
});

test('every message the audio server sends is in the protocol catalogue and inside its cap (the fake sessions enforce this)', () => {
  const { hub, gm, player, listen, select, start } = setup();
  const phone = player(A, { name: 'N'.repeat(300) });
  start(); listen(phone); select(A);
  hub.deliver(gm, { type: 'AUDIO_OFFER', to: A, sid: 's1', sdp: EDGE_OFFER });
  hub.deliver(phone, { type: 'AUDIO_ANSWER', sid: 's1', sdp: EDGE_ANSWER });
  assert.ok(gm.last('AUDIO_LISTENER').name.length <= 40);
});
