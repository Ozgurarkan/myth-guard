import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { LIMITS } from '../src/net/protocol.js';
import { createFakeClock } from '../server/net/clock.js';
import { createTableStore, freshTable, sanitizeTable } from '../server/net/tableStore.js';
import { randomHex } from '../src/net/hmac.js';
import { tempDir } from '../test-support/wp2-fixtures.js';

const open = (dir, clock = createFakeClock(), lines = []) => {
  const store = createTableStore({ file: join(dir, 'table.json'), clock, log: line => lines.push(line) });
  return { store, lines, clock };
};

test('a missing file starts a fresh table and writes table.json', t => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const { store } = open(join(dir, 'nested', 'folder'));
  const result = store.load();
  assert.deepEqual(result, { fresh: true, corrupt: false, dropped: 0 });
  assert.equal(store.persisted, true);
  const saved = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  assert.equal(saved.mode, 'open');
  assert.match(saved.serverSecret, /^[0-9a-f]{64}$/);
  assert.match(saved.invite.secret, /^[A-Za-z0-9_-]{22}$/);
  assert.match(saved.invite.code, /^[A-HJKMNP-Z2-9]{8}$/);
  assert.equal(saved.limits.maxAdmittedDevices, LIMITS.maxAdmittedDevices);
  assert.deepEqual(fs.readdirSync(join(dir, 'nested', 'folder')), ['table.json'], 'no temp file is left behind');
});

test('A16 the table survives a restart: secret, invite, mode and devices come back', t => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const first = open(dir);
  first.store.load();
  const device = randomHex(16);
  first.store.data.mode = 'ask';
  first.store.data.devices[device] = { dk: randomHex(32), name: 'Aria', label: 'Android · Chrome', ip: '192.168.1.5', how: 'link', status: 'admitted', createdAt: 5, lastSeen: 6, joinNonce: randomHex(16), srv: randomHex(16) };
  first.store.save();

  const second = open(dir);
  assert.deepEqual(second.store.load(), { fresh: false, corrupt: false, dropped: 0 });
  assert.equal(second.store.data.serverSecret, first.store.data.serverSecret);
  assert.deepEqual(second.store.data.invite, first.store.data.invite);
  assert.equal(second.store.data.mode, 'ask');
  assert.equal(second.store.data.devices[device].name, 'Aria');
  assert.equal(second.store.data.devices[device].dk, first.store.data.devices[device].dk);
});

test('A16 a corrupt file gives a fresh table, a log line and a kept copy of the old file - never a crash', t => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const file = join(dir, 'table.json');
  const broken = ['{ not json', '', '[]', 'null', '{"version":1}', JSON.stringify({ ...freshTable(createFakeClock()), serverSecret: 'short' }),
    JSON.stringify({ ...freshTable(createFakeClock()), mode: 'wide-open' }), JSON.stringify({ ...freshTable(createFakeClock()), version: 99 }),
    JSON.stringify({ ...freshTable(createFakeClock()), invite: { secret: 'x', code: 'y' } }), JSON.stringify({ ...freshTable(createFakeClock()), devices: [] })];
  for (const [index, text] of broken.entries()) {
    fs.writeFileSync(file, text);
    const { store, lines } = open(dir, createFakeClock(1000 + index));
    const result = store.load();
    assert.equal(result.corrupt, true, `case ${index}`);
    assert.equal(result.fresh, true);
    assert.match(lines[0], /could not be read/);
    assert.match(lines[0], /Players must join again/);
    assert.equal(store.data.mode, 'open');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1, 'a clean table.json replaced it');
    assert.ok(fs.readdirSync(dir).some(name => name.startsWith('table.json.corrupt-')), 'the damaged file was kept');
  }
});

test('an oversized file is treated as corrupt without being parsed', t => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  fs.writeFileSync(join(dir, 'table.json'), ' '.repeat(3 * 1024 * 1024));
  const { store } = open(dir);
  assert.equal(store.load().corrupt, true);
});

test('unusable device entries are dropped one by one; the rest of the table is kept', () => {
  const clock = createFakeClock();
  const table = freshTable(clock);
  const good = randomHex(16);
  const raw = JSON.parse(JSON.stringify(table));
  raw.devices = {
    [good]: { dk: randomHex(32), name: 'Ok', status: 'admitted', createdAt: 1 },
    'not-hex': { dk: randomHex(32), status: 'admitted' },
    [randomHex(16)]: { dk: 'short', status: 'admitted' },
    [randomHex(16)]: { dk: randomHex(32), status: 'owner' },
    [randomHex(16)]: { dk: randomHex(32), status: 'revoked' },
    [randomHex(16)]: { dk: null, status: 'revoked' },
    [randomHex(16)]: 42,
  };
  Object.defineProperty(raw.devices, '__proto__', { value: { dk: randomHex(32), status: 'admitted' }, enumerable: true });
  const { table: clean, dropped } = sanitizeTable(raw, clock);
  assert.equal(dropped, 6);
  assert.equal(Object.keys(clean.devices).length, 2);
  assert.equal(clean.devices[good].name, 'Ok');
  assert.equal(Object.getPrototypeOf(clean.devices), null, 'no prototype to pollute');
  assert.equal(clean.devices.__proto__, undefined);
});

test('limits in table.json can be raised by hand and are clamped to sane values', () => {
  const clock = createFakeClock();
  const raw = JSON.parse(JSON.stringify(freshTable(clock)));
  raw.limits = { maxAdmittedDevices: 24, maxPendingDevices: 99999 };
  const { table } = sanitizeTable(raw, clock);
  assert.equal(table.limits.maxAdmittedDevices, 24);
  assert.equal(table.limits.maxPendingDevices, 16);
  raw.limits = { maxAdmittedDevices: 'many' };
  assert.equal(sanitizeTable(raw, clock).table.limits.maxAdmittedDevices, LIMITS.maxAdmittedDevices);
});

test('a disk that cannot be written keeps the table in memory and says so once', t => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const blocker = join(dir, 'blocker');
  fs.writeFileSync(blocker, 'a file where a folder should be');
  const { store, lines } = open(join(blocker, 'sub'));
  const result = store.load();
  assert.equal(result.fresh, true);
  assert.equal(store.persisted, false);
  store.data.mode = 'locked';
  assert.equal(store.save(), false);
  assert.equal(store.data.mode, 'locked', 'the table keeps working');
  assert.equal(lines.filter(line => /cannot be written/.test(line)).length, 1, 'one log line, not one per save');
});

test('without a file (null) everything stays in memory and nothing touches the disk', () => {
  const store = createTableStore({ file: null, clock: createFakeClock() });
  assert.equal(store.load().fresh, true);
  assert.equal(store.persisted, false);
  assert.equal(store.save(), false);
  assert.equal(store.data.mode, 'open');
});

test('two loads return the same result and the data getter loads on demand', t => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const { store } = open(dir);
  const secret = store.data.serverSecret;
  assert.equal(store.load().fresh, true);
  assert.equal(store.data.serverSecret, secret);
});
