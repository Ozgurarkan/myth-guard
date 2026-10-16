import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioRelay, RELAY_DEFAULTS } from '../server/net/audioRelay.js';
import { createAdpcmEncoder, peekRfa3, encodePCM, createAdpcmEncoder as enc2 } from '../src/audio/pcm.js';
import { CLOSE, LIMITS } from '../src/net/protocol.js';
import { createClock, createFakeMetrics, createFakeWs, hex16 } from '../test-support/wp5-fakes.js';

const A = hex16(0xa1);
const B = hex16(0xb2);

const encoder = createAdpcmEncoder();
const silence = [new Float32Array(4096), new Float32Array(4096)];
const packet = seq => Buffer.from(encoder.encode(silence, 48000, { seq, ts: seq * 4096 }));

function setup() {
  const clock = createClock();
  const metrics = createFakeMetrics();
  const relay = createAudioRelay({ metrics, clock });
  const gm = createFakeWs();
  relay.attach(gm, { role: 'gm' });
  const listener = (device, { eligible = true } = {}) => {
    const ws = createFakeWs();
    relay.attach(ws, { role: 'player', device });
    if (eligible) relay.setEligible(device, true);
    return ws;
  };
  const send = (seq, ws = gm) => ws.emit('message', packet(seq), true);
  relay.setActive(true);
  return { clock, metrics, relay, gm, listener, send };
}
const seqs = ws => ws.sent.map(p => peekRfa3(p).seq);
const flags = ws => ws.sent.map(p => peekRfa3(p).flags);

test('G2: only eligible listeners receive frames; the packet arrives byte for byte', () => {
  const { relay, listener, send } = setup();
  const one = listener(A, { eligible: false });
  send(0);
  assert.equal(one.sent.length, 0, 'an unselected listener receives no frames');
  relay.setEligible(A, true);
  send(1);
  assert.deepEqual(seqs(one), [1]);
  assert.deepEqual(one.sent[0], packet(1));
  relay.setEligible(A, false);
  send(2);
  assert.deepEqual(seqs(one), [1]);
});

test('nothing flows while the GM is not broadcasting, and stopping clears what was queued', () => {
  const { relay, listener, send } = setup();
  const one = listener(A);
  one.frozen = true;
  for (let i = 0; i < 5; i++) send(i);
  relay.setActive(false);
  one.thaw();
  send(9);
  assert.ok(seqs(one).every(s => s < 5), 'no packet from after the stop');
  assert.equal(relay.stats().listeners[0].queued, 0);
  relay.setActive(true);
  send(10);
  assert.equal(seqs(one).at(-1), 10);
});

test('G2: players cannot broadcast: their frames are ignored and counted, text from the GM is ignored, junk is rejected', () => {
  const { relay, listener, gm, send, metrics } = setup();
  const one = listener(A), other = listener(B);
  one.emit('message', packet(1), true);
  one.emit('message', Buffer.from('{"type":"AUDIO_STATUS"}'), false);
  assert.equal(other.sent.length, 0);
  gm.emit('message', Buffer.from(JSON.stringify({ type: 'x' })), false);
  gm.emit('message', Buffer.alloc(10), true);                       // too short
  gm.emit('message', Buffer.from(encodePCM([new Float32Array(64)], 48000)), true); // old raw PCM is not RFA3
  gm.emit('message', Buffer.from(enc2().encode(silence, 48000)), true); // RFA2 has no sequence number
  const bad = packet(3);
  bad[16] = 9;
  gm.emit('message', bad, true);
  gm.emit('message', Buffer.alloc(LIMITS.audioMaxPayload + 1), true);
  assert.equal(one.sent.length + other.sent.length, 0);
  assert.equal(relay.stats().rejected, 6);
  assert.ok(metrics.get('audio.relay.malformed') >= 4);
  send(4);
  assert.deepEqual(seqs(one), [4]);
});

test('a listener that keeps sending frames is closed 4008', () => {
  const { listener } = setup();
  const one = listener(A);
  for (let i = 0; i <= RELAY_DEFAULTS.maxStrayFrames + 1; i++) one.emit('message', Buffer.from('x'), true);
  assert.equal(one.closed.code, CLOSE.ABUSE);
});

test('G4: a frozen listener costs a bounded queue: at most 8 packets and 64 KB, at most 2 writes in flight, newest kept', () => {
  const { relay, listener, send } = setup();
  const frozen = listener(A);
  const healthy = listener(B);
  frozen.frozen = true;
  let worstQueued = 0, worstBytes = 0;
  for (let i = 0; i < 400; i++) {
    send(i);
    const s = relay.stats().listeners.find(l => l.device === A);
    worstQueued = Math.max(worstQueued, s.queued);
    worstBytes = Math.max(worstBytes, s.queuedBytes);
  }
  assert.ok(worstQueued <= RELAY_DEFAULTS.maxPackets, `queue grew to ${worstQueued}`);
  assert.ok(worstBytes <= RELAY_DEFAULTS.maxBytes);
  assert.equal(frozen.sent.length, RELAY_DEFAULTS.maxInflight, 'only the writes allowed in flight were handed to the socket');
  assert.equal(healthy.sent.length, 400, 'the other listener lost nothing and never waited');
  assert.ok(relay.stats().listeners.find(l => l.device === A).dropped >= 400 - RELAY_DEFAULTS.maxPackets - RELAY_DEFAULTS.maxInflight);
  // the phone recovers: it gets the newest packets, in order, and the first one says how many were skipped
  frozen.thaw();
  const after = seqs(frozen).slice(RELAY_DEFAULTS.maxInflight);
  assert.deepEqual(after, [392, 393, 394, 395, 396, 397, 398, 399]);
  const skipFlags = flags(frozen).slice(RELAY_DEFAULTS.maxInflight);
  assert.equal(skipFlags[0], 255, 'the count saturates at 255');
  assert.deepEqual(skipFlags.slice(1), [0, 0, 0, 0, 0, 0, 0]);
});

test('skipped packets are counted exactly in the flags byte of the next packet that is sent', () => {
  const { listener, send } = setup();
  const one = listener(A);
  one.frozen = true;
  for (let i = 0; i < 14; i++) send(i); // 2 in flight, 8 queued, 4 dropped
  one.thaw();
  const got = seqs(one);
  assert.deepEqual(got, [0, 1, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.equal(flags(one)[2], 4);
  assert.deepEqual(flags(one).filter((f, i) => i !== 2), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('a socket that already holds unsent data is not written to until it drains', () => {
  const { listener, send } = setup();
  const one = listener(A);
  one.bufferedAmount = RELAY_DEFAULTS.highWater + 1;
  send(0); send(1);
  assert.equal(one.sent.length, 0);
  one.bufferedAmount = 0;
  send(2);
  assert.deepEqual(seqs(one), [0, 1, 2]);
});

test('a listener that makes no progress for 10 s is closed with 4009, its queue freed; the others carry on', () => {
  const { clock, relay, listener, send } = setup();
  const stuck = listener(A), fine = listener(B);
  stuck.frozen = true;
  for (let i = 0; i < 20; i++) { send(i); clock.advance(85); }
  assert.equal(stuck.closed, null);
  clock.advance(LIMITS.slowCloseMs);
  send(20);
  assert.equal(stuck.closed.code, CLOSE.SLOW);
  assert.equal(fine.sent.length, 21);
  assert.equal(relay.stats().slowClosed, 1);
  assert.equal(relay.stats().listeners.some(l => l.device === A), false, 'its record is gone with the socket');
});

test('progress resets the slow timer: a listener that is merely slow stays connected', () => {
  const { clock, listener, send } = setup();
  const slow = listener(A);
  slow.frozen = true;
  for (let i = 0; i < 300; i++) {
    send(i);
    clock.advance(85);
    if (i % 60 === 59) slow.thaw(); // a write completes every ~5 s
  }
  assert.equal(slow.closed, null);
});

test('turning eligibility on starts from an empty queue (no stale sound from an earlier stretch)', () => {
  const { relay, listener, send } = setup();
  const one = listener(A);
  one.frozen = true;
  for (let i = 0; i < 6; i++) send(i);
  relay.setEligible(A, false);
  relay.setEligible(A, true);
  assert.equal(relay.stats().listeners[0].queued, 0);
  one.thaw();
  send(6);
  assert.equal(seqs(one).at(-1), 6);
  assert.equal(flags(one).at(-1), 0, 'a fresh start does not claim skipped packets');
});

test('a second GM audio socket replaces the first (4001); at most two sockets per device; a stranger role is refused', () => {
  const { relay, gm, listener, send } = setup();
  const second = createFakeWs();
  relay.attach(second, { role: 'gm' });
  assert.equal(gm.closed.code, CLOSE.REPLACED);
  const one = listener(A);
  const three = [listener(A), listener(A)];
  assert.equal(one.closed.code, 1000);
  assert.equal(three[0].closed, null);
  send(1, second);
  assert.deepEqual(seqs(three[1]), [1]);
  assert.equal(three[0].sent.length, 1, 'both remaining windows of the device get the stream');
  const odd = createFakeWs();
  relay.attach(odd, { role: 'spectator' });
  assert.equal(odd.closed.code, CLOSE.AUTH);
  const noDevice = createFakeWs();
  relay.attach(noDevice, { role: 'player' });
  assert.equal(noDevice.closed.code, CLOSE.AUTH);
});

test('closing a socket removes it; a closed listener is not written to', () => {
  const { relay, listener, send } = setup();
  const one = listener(A);
  one.close(1001);
  send(1);
  assert.equal(one.sent.length, 0);
  assert.equal(relay.stats().listeners.length, 0);
  assert.equal(relay.hasListenerSocket(A), false);
});

test('heartbeat: pings go out every 15 s and a socket that stays silent for 30 s is terminated', () => {
  const { clock, listener } = setup();
  const one = listener(A);
  clock.advance(LIMITS.serverPingMs);
  assert.equal(one.pings, 1);
  one.emit('pong');
  clock.advance(LIMITS.serverPingMs);
  assert.equal(one.pings, 2);
  clock.advance(LIMITS.serverDeadMs + LIMITS.serverPingMs);
  assert.equal(one.closed.code, 1006);
});

test('a send error does not leave the write counter stuck', () => {
  const { relay, listener, send } = setup();
  const one = listener(A);
  one.send = (data, options, callback) => callback(new Error('EPIPE'));
  send(1); send(2); send(3);
  assert.equal(relay.stats().listeners[0].queued, 0, 'errors still release the in-flight slot');
});

test('close() shuts every socket with 4010', () => {
  const { relay, gm, listener } = setup();
  const one = listener(A);
  relay.close();
  assert.equal(one.closed.code, CLOSE.SHUTDOWN);
  assert.equal(gm.closed.code, CLOSE.SHUTDOWN);
});

test('fan-out cost: 16 listeners x 3,000 packets (4.2 minutes of sound) in well under a second of CPU', () => {
  const { relay, gm, listener } = setup();
  const sockets = Array.from({ length: 16 }, (_, i) => listener(hex16(0x500 + i)));
  const started = process.hrtime.bigint();
  for (let i = 0; i < 3000; i++) gm.emit('message', packet(i), true);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(sockets.every(ws => ws.sent.length === 3000));
  assert.ok(ms < 1500, `${ms.toFixed(0)} ms`);
  assert.equal(relay.stats().sent, 48000);
});
