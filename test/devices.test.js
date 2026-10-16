import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS } from '../src/net/protocol.js';
import { randomHex } from '../src/net/hmac.js';
import { createFakeClock } from '../server/net/clock.js';
import { createDevices } from '../server/net/devices.js';
import { createTableStore } from '../server/net/tableStore.js';

function setup() {
  const clock = createFakeClock();
  const store = createTableStore({ file: null, clock });
  const events = [];
  const devices = createDevices({ store, clock, emit: event => events.push(event) });
  const add = (over = {}) => {
    const device = randomHex(16);
    const result = devices.register({ device, dk: randomHex(32), name: 'Aria', label: 'Android · Chrome', ip: '192.168.1.5', how: 'link', nonce: randomHex(16), srv: randomHex(16), status: 'admitted', ...over });
    return { device, result };
  };
  return { clock, store, devices, events, add };
}

test('register stores the device; the registry view never contains a key', () => {
  const { devices, add, events } = setup();
  const { device, result } = add({ name: '  Thorin‮ the Bold  ' });
  assert.deepEqual(result, { ok: true, status: 'admitted' });
  assert.equal(devices.find(device).name, 'Thorin the Bold', 'names are cleaned');
  const listed = devices.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].device, device);
  assert.match(listed[0].playerId, /^[0-9a-f]{24}$/);
  assert.equal(JSON.stringify(listed).includes(devices.find(device).dk), false, 'dk never leaves');
  assert.ok(!('dk' in listed[0]));
  assert.deepEqual(events.map(e => e.kind), ['join']);
  assert.equal(devices.find('nope'), null);
  assert.equal(devices.find(undefined), null);
});

test('A11 the 17th admitted device is refused and the 5th pending device is refused', () => {
  const { devices, add } = setup();
  for (let i = 0; i < LIMITS.maxAdmittedDevices; i++) assert.equal(add().result.ok, true, `device ${i + 1}`);
  const seventeenth = add();
  assert.deepEqual(seventeenth.result, { ok: false, reason: 'full' });
  assert.equal(devices.find(seventeenth.device), null);

  const ask = setup();
  for (let i = 0; i < LIMITS.maxPendingDevices; i++) assert.equal(ask.add({ status: 'pending' }).result.ok, true, `pending ${i + 1}`);
  assert.deepEqual(ask.add({ status: 'pending' }).result, { ok: false, reason: 'full' });
});

test('a pending request is refused while the table is already full of admitted devices', () => {
  const { add } = setup();
  for (let i = 0; i < LIMITS.maxAdmittedDevices; i++) add();
  assert.deepEqual(add({ status: 'pending' }).result, { ok: false, reason: 'full' });
});

test('the cap can be raised in table.json', () => {
  const { store, add } = setup();
  store.data.limits.maxAdmittedDevices = 17;
  for (let i = 0; i < 17; i++) assert.equal(add().result.ok, true);
  assert.equal(add().result.ok, false);
});

test('A8 admit moves pending to admitted; deny removes the device and pauses its next request', () => {
  const { devices, add, events, clock } = setup();
  const a = add({ status: 'pending' }).device;
  const b = add({ status: 'pending' }).device;
  assert.equal(devices.admit(a), true);
  assert.equal(devices.find(a).status, 'admitted');
  assert.equal(devices.admit(a), false, 'only pending devices can be admitted');
  assert.equal(devices.deny(b), true);
  assert.equal(devices.find(b), null);
  assert.equal(devices.deny(b), false);
  assert.deepEqual(events.map(e => e.kind), ['join', 'join', 'admit', 'deny']);
  // The same device id asking again right away is pushed back for a minute.
  const again = devices.register({ device: b, dk: randomHex(32), name: 'x', how: 'link', nonce: randomHex(16), srv: randomHex(16), status: 'pending' });
  assert.deepEqual(again, { ok: false, reason: 'cooldown' });
  clock.advance(61_000);
  assert.equal(devices.register({ device: b, dk: randomHex(32), name: 'x', how: 'link', nonce: randomHex(16), srv: randomHex(16), status: 'pending' }).ok, true);
});

test('admit is refused when the table is full', () => {
  const { devices, add } = setup();
  const waiting = add({ status: 'pending' }).device;
  for (let i = 0; i < LIMITS.maxAdmittedDevices; i++) add();
  assert.equal(devices.admit(waiting), false);
  assert.equal(devices.find(waiting).status, 'pending');
});

test('A9 revoke deletes the key, keeps a tombstone, and the same id can never come back', () => {
  const { devices, add, events } = setup();
  const { device } = add();
  assert.equal(devices.revoke(device), true);
  const record = devices.find(device);
  assert.equal(record.status, 'revoked');
  assert.equal(record.dk, null);
  assert.equal(record.srv, null);
  assert.equal(devices.list().length, 0, 'a kicked device is not listed');
  assert.equal(devices.revoke(device), false);
  assert.equal(events.at(-1).kind, 'kick');
  const retry = devices.register({ device, dk: randomHex(32), name: 'x', how: 'link', nonce: randomHex(16), srv: randomHex(16), status: 'admitted' });
  assert.deepEqual(retry, { ok: false, reason: 'revoked' });
  assert.equal(devices.rename(device, 'again'), false);
  assert.equal(devices.admit(device), false);
});

test('revoking frees a slot at the table', () => {
  const { devices, add } = setup();
  const first = add().device;
  for (let i = 1; i < LIMITS.maxAdmittedDevices; i++) add();
  assert.equal(add().result.ok, false);
  devices.revoke(first);
  assert.equal(add().result.ok, true);
});

test('tombstones are bounded', () => {
  const { devices, add } = setup();
  for (let i = 0; i < 300; i++) { const { device } = add(); devices.revoke(device); }
  assert.ok(devices.count('revoked') <= 256);
});

test('the rf-d cookie is bound to the device by a MAC with the server secret', () => {
  const { devices, add, store } = setup();
  const { device } = add();
  const value = devices.cookieValue(device);
  assert.match(value, /^[0-9a-f]{32}\.[0-9a-f]{32}$/);
  assert.equal(devices.deviceFromCookie(value), device);
  const [id, mac] = value.split('.');
  assert.equal(devices.deviceFromCookie(`${id}.${mac.replace(/.$/, c => (c === '0' ? '1' : '0'))}`), null, 'one wrong digit');
  assert.equal(devices.deviceFromCookie(`${randomHex(16)}.${mac}`), null, 'a MAC from another device');
  for (const junk of [undefined, null, '', 'abc', `${id}.`, `${id}.${mac}.x`, `${id.toUpperCase()}.${mac}`, 42]) assert.equal(devices.deviceFromCookie(junk), null);
  store.data.serverSecret = randomHex(32);
  assert.equal(devices.deviceFromCookie(value), null, 'a different server secret invalidates every cookie');
});

test('playerId is stable per device and differs between devices', () => {
  const { devices, add } = setup();
  const a = add().device;
  const b = add().device;
  assert.equal(devices.playerIdOf(a), devices.playerIdOf(a));
  assert.notEqual(devices.playerIdOf(a), devices.playerIdOf(b));
});

test('A8 a pending request that nobody answers is denied after five minutes (fake clock)', () => {
  const { devices, add, clock, events } = setup();
  const { device } = add({ status: 'pending' });
  clock.advance(LIMITS.pendingTtlMs - 1);
  assert.equal(devices.find(device).status, 'pending');
  clock.advance(2);
  assert.equal(devices.find(device), null);
  assert.deepEqual(events.at(-1), { kind: 'deny', device, reason: 'timeout' });
  assert.equal(clock.pending, 0, 'no timer is left behind');
});

test('admitting a pending device cancels its expiry; start() re-arms devices loaded as pending', () => {
  const { devices, add, clock, store } = setup();
  const { device } = add({ status: 'pending' });
  devices.admit(device);
  clock.advance(LIMITS.pendingTtlMs * 2);
  assert.equal(devices.find(device).status, 'admitted');

  const loaded = randomHex(16);
  store.data.devices[loaded] = { dk: randomHex(32), name: '', status: 'pending', createdAt: clock.now() - 60_000 };
  devices.start();
  clock.advance(LIMITS.pendingTtlMs - 59_000);
  assert.equal(devices.find(loaded), null, 'expires relative to when it asked, not to the restart');
});

test('rename cleans the name; touch updates where a device was last seen', () => {
  const { devices, add, clock } = setup();
  const { device } = add();
  assert.equal(devices.rename(device, 'a\u0000b\n  c'), true);
  assert.equal(devices.find(device).name, 'ab c');
  clock.advance(1000);
  devices.touch(device, { ip: '192.168.1.77', label: 'iPhone / iPad · Safari' });
  assert.equal(devices.find(device).ip, '192.168.1.77');
  assert.equal(devices.find(device).lastSeen, clock.now());
  devices.touch('unknown');
});
