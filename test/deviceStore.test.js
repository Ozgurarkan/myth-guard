import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceStore, deviceStore, device, STORAGE_KEYS } from '../src/net/deviceStore.js';
import { isHex, isId } from '../src/net/protocol.js';

const memoryStorage = (seed = {}) => {
  const data = new Map(Object.entries(seed));
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: key => { data.delete(key); },
    data,
  };
};
const brokenStorage = () => ({
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceededError'); },
  removeItem() { throw new Error('SecurityError'); },
});

test('the device id is created once, is 32 lowercase hex, and survives a new store on the same storage', () => {
  const local = memoryStorage();
  const first = createDeviceStore({ local, session: memoryStorage() });
  assert.equal(first.device(), null, 'no identity until it is asked for');
  const id = first.ensureDevice();
  assert.ok(isHex(id, 16));
  assert.equal(first.ensureDevice(), id);
  assert.equal(local.data.get(STORAGE_KEYS.device), id);
  const second = createDeviceStore({ local, session: memoryStorage() });
  assert.equal(second.device(), id, 'a reload keeps the identity');
});

test('dk is validated, stored, and makes the browser a member only together with the device', () => {
  const store = createDeviceStore({ local: memoryStorage(), session: memoryStorage() });
  assert.equal(store.isMember(), false);
  store.ensureDevice();
  assert.throws(() => store.setDk('short'), TypeError);
  assert.throws(() => store.setDk('A'.repeat(64)), TypeError, 'uppercase hex is not a dk');
  assert.equal(store.isMember(), false);
  store.setDk('ab'.repeat(32));
  assert.equal(store.dk(), 'ab'.repeat(32));
  assert.equal(store.isMember(), true);
  store.forgetKey();
  assert.equal(store.isMember(), false);
  assert.ok(store.device(), 'forgetting the key keeps the device id');
});

test('garbage in storage is ignored, never trusted', () => {
  const local = memoryStorage({ [STORAGE_KEYS.device]: 'not-hex', [STORAGE_KEYS.dk]: '12' });
  const session = memoryStorage({ [STORAGE_KEYS.invite]: 'x', [STORAGE_KEYS.aid]: '??' });
  const store = createDeviceStore({ local, session });
  assert.equal(store.device(), null);
  assert.equal(store.dk(), null);
  assert.equal(store.invite(), null);
  const id = store.ensureDevice();
  assert.ok(isHex(id, 16), 'a bad stored id is replaced by a fresh one');
  assert.match(store.nextAid(), /^[0-9a-f]{6}-1$/);
});

test('when storage throws everywhere the identity still works for this visit (in-memory fallback)', () => {
  const store = createDeviceStore({ local: brokenStorage(), session: brokenStorage() });
  const id = store.ensureDevice();
  assert.ok(isHex(id, 16));
  assert.equal(store.ensureDevice(), id, 'stable inside the visit');
  store.setDk('cd'.repeat(32));
  assert.equal(store.isMember(), true);
  store.setName('Aria');
  assert.equal(store.name(), 'Aria');
  store.setInvite('A'.repeat(22));
  assert.equal(store.invite(), 'A'.repeat(22));
  const a = store.nextAid(), b = store.nextAid();
  assert.notEqual(a, b);
  store.forget();
  assert.equal(store.device(), null);
  assert.equal(store.name(), 'Aria', 'forgetting the identity keeps the name');
});

test('with no storage at all (null) it is memory only; with missing globals it does not throw', () => {
  const store = createDeviceStore({ local: null, session: null });
  assert.ok(store.ensureDevice());
  // The default store looks the globals up lazily: in Node there is no usable localStorage, and that must be fine.
  assert.ok(isHex(device(), 16));
  assert.equal(deviceStore.device(), device());
  assert.equal(typeof deviceStore.name(), 'string');
});

test('the name uses the key the app has always used and is cleaned', () => {
  const local = memoryStorage({ 'realm-player-name': 'Thorin' });
  const store = createDeviceStore({ local, session: memoryStorage() });
  assert.equal(store.name(), 'Thorin');
  store.setName('  Bruenor\n  Battlehammer ');
  assert.equal(local.data.get('realm-player-name'), 'Bruenor Battlehammer');
});

test('action ids are valid ids, strictly increasing within a tab, continue after a reload, and differ between tabs', () => {
  const session = memoryStorage();
  const tab = createDeviceStore({ local: memoryStorage(), session });
  const ids = Array.from({ length: 40 }, () => tab.nextAid());
  for (const aid of ids) assert.ok(isId(aid), aid);
  assert.equal(new Set(ids).size, 40);
  const counters = ids.map(aid => parseInt(aid.split('-')[1], 36));
  assert.deepEqual(counters, Array.from({ length: 40 }, (_, i) => i + 1));
  const reloaded = createDeviceStore({ local: memoryStorage(), session });
  const next = reloaded.nextAid();
  assert.equal(next.split('-')[0], ids[0].split('-')[0], 'same tab: same prefix');
  assert.equal(parseInt(next.split('-')[1], 36), 41, 'same tab: the counter continues');
  const otherTab = createDeviceStore({ local: memoryStorage(), session: memoryStorage() });
  assert.notEqual(otherTab.nextAid().split('-')[0], ids[0].split('-')[0], 'a new tab can never repeat an id the server remembers');
});

test('the invite secret lives in session storage only and is validated', () => {
  const local = memoryStorage();
  const session = memoryStorage();
  const store = createDeviceStore({ local, session });
  assert.throws(() => store.setInvite('short'), TypeError);
  store.setInvite('abcdefghijklmnopqrstuv');
  assert.equal(store.invite(), 'abcdefghijklmnopqrstuv');
  assert.equal(local.data.has(STORAGE_KEYS.invite), false, 'never in localStorage');
  store.clearInvite();
  assert.equal(store.invite(), null);
});

test('forget() removes device, key, action counter and invite', () => {
  const local = memoryStorage();
  const session = memoryStorage();
  const store = createDeviceStore({ local, session });
  store.ensureDevice(); store.setDk('ab'.repeat(32)); store.setInvite('abcdefghijklmnopqrstuv'); store.nextAid();
  store.forget();
  assert.equal(local.data.has(STORAGE_KEYS.device), false);
  assert.equal(local.data.has(STORAGE_KEYS.dk), false);
  assert.equal(session.data.has(STORAGE_KEYS.aid), false);
  assert.equal(session.data.has(STORAGE_KEYS.invite), false);
});
