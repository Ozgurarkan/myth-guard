import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoster } from '../server/net/roster.js';
import { createFakeClock } from '../server/net/clock.js';
import { createFakeMetrics } from '../test-support/fakeAccess.js';

const live = (device, extra = {}) => ({
  isOpen: true, role: 'player', device, playerId: `pid-${device}`, name: '', label: 'Chrome · Android', rtt: null, loss: null, pending: false,
  get displayName() { return this.name || this.label; }, ...extra,
});

function setup({ registry } = {}) {
  const clock = createFakeClock();
  const sent = [];
  const sessions = [];
  const roster = createRoster({
    clock, metrics: createFakeMetrics(), sessions: () => sessions, registry,
    audioOf: device => (device === 'd1' ? { mode: 'webrtc' } : null),
    sendToGm: message => { sent.push(message); return true; },
  });
  return { clock, sent, sessions, roster };
}

test('one entry per device: several windows collapse and the best round-trip time wins', () => {
  const { sessions, roster } = setup();
  sessions.push(live('d1', { name: 'Thorin', rtt: 80, loss: 2 }), live('d1', { name: 'Thorin', rtt: 25, loss: 0 }), live('d2', { rtt: null }));
  const players = roster.entries();
  assert.equal(players.length, 2);
  const thorin = players.find(p => p.deviceId === 'd1');
  assert.deepEqual([thorin.name, thorin.rtt, thorin.loss, thorin.online, thorin.admitted], ['Thorin', 25, 0, true, true]);
  assert.deepEqual(thorin.audio, { mode: 'webrtc' });
  const other = players.find(p => p.deviceId === 'd2');
  assert.equal(other.name, 'Chrome · Android', 'without a chosen name the device label is shown (as before)');
  assert.equal(other.device, 'Chrome · Android');
  assert.equal(other.rtt, null);
  assert.equal(other.id, 'pid-d2');
});

test('the roster knows devices that are offline or waiting, and hides closed sockets, non-players and removed devices', () => {
  const registry = () => [
    { device: 'd1', playerId: 'pid-d1', name: 'Thorin', label: 'Chrome', status: 'admitted' },
    { device: 'd3', playerId: 'pid-d3', name: 'Mira', label: 'Safari', status: 'admitted' },
    { device: 'd4', playerId: 'pid-d4', name: 'Newcomer', label: 'Firefox', status: 'pending' },
    { device: 'd5', playerId: 'pid-d5', name: 'Gone', label: 'Edge', status: 'revoked' },
  ];
  const { sessions, roster } = setup({ registry });
  sessions.push(live('d1', { rtt: 40 }), live('d6', { isOpen: false }), { ...live('gm'), role: 'gm' });
  const byDevice = Object.fromEntries(roster.entries().map(p => [p.deviceId, p]));
  assert.deepEqual(Object.keys(byDevice).sort(), ['d1', 'd3', 'd4']);
  assert.equal(byDevice.d1.online, true);
  assert.equal(byDevice.d3.online, false);
  assert.equal(byDevice.d3.name, 'Mira');
  assert.equal(byDevice.d4.admitted, false);
  assert.equal(byDevice.d1.name, 'Thorin', 'the registry name shows until the window sets its own');
});

test('a pending socket is listed as waiting, not admitted', () => {
  const { sessions, roster } = setup();
  sessions.push(live('d9', { pending: true }));
  const [entry] = roster.entries();
  assert.equal(entry.admitted, false);
  assert.equal(entry.online, true);
});

test('updates are debounced: a burst of joins is one message, and an earlier request wins over a later one', () => {
  const { clock, sent, sessions, roster } = setup();
  sessions.push(live('d1'));
  roster.soon(40); roster.soon(40); roster.soon(1000);
  clock.advance(39);
  assert.equal(sent.length, 0);
  clock.advance(1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'PLAYER_ROSTER');
  sessions.push(live('d2'));
  roster.soon(1000);
  roster.soon(10);                                  // sooner than the pending one: reschedules
  clock.advance(10);
  assert.equal(sent.length, 2);
  clock.advance(5000);
  assert.equal(sent.length, 2, 'the replaced timer is gone');
});

test('an unchanged roster is not sent again, unless forced, and reset() makes the next one go out', () => {
  const { clock, sent, sessions, roster } = setup();
  sessions.push(live('d1'));
  roster.soon(0); clock.advance(0);
  roster.soon(0); clock.advance(0);
  assert.equal(sent.length, 1);
  assert.equal(roster.now(), true);
  assert.equal(sent.length, 2, 'now() always sends (a GM window just connected)');
  roster.reset();
  roster.soon(0); clock.advance(0);
  assert.equal(sent.length, 3);
});

test('a failing registry or audio provider never breaks the roster', () => {
  const clock = createFakeClock();
  const sent = [];
  const roster = createRoster({
    clock, sessions: () => [live('d1')], registry: () => { throw new Error('boom'); }, audioOf: () => { throw new Error('boom'); },
    sendToGm: m => { sent.push(m); return true; },
  });
  assert.equal(roster.entries().length, 1);
  roster.now();
  assert.equal(sent.length, 1);
});

test('without a GM the roster waits (sendToGm returns false) and goes out as soon as one is there', () => {
  const clock = createFakeClock();
  let gm = false;
  const sent = [];
  const roster = createRoster({ clock, sessions: () => [live('d1')], sendToGm: m => { if (gm) sent.push(m); return gm; } });
  roster.soon(0); clock.advance(0);
  assert.equal(sent.length, 0);
  gm = true;
  roster.soon(0); clock.advance(0);
  assert.equal(sent.length, 1, 'a failed send is not remembered as sent');
});

test('dispose stops all timers', () => {
  const { clock, sent, sessions, roster } = setup();
  sessions.push(live('d1'));
  roster.soon(100);
  roster.dispose();
  clock.advance(1000);
  assert.equal(sent.length, 0);
  roster.soon(10);
  assert.equal(clock.pending, 0);
});
