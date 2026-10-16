import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostGuard, parseHost } from '../server/net/hostGuard.js';
import { addressFor, cleanIp, lanAddresses, subnetOf } from '../server/net/lan.js';
import { deviceLabel } from '../server/net/ua.js';

const guard = createHostGuard({ hostname: 'GM-PC' });

test('C2 an IP literal, localhost, the machine name and name.local are accepted, with or without a port', () => {
  for (const host of ['192.168.1.10:5173', '10.0.0.5', '127.0.0.1:5173', 'localhost', 'localhost:5173', '[::1]:5173', '[fe80::1]:5173',
    'GM-PC', 'gm-pc:5173', 'GM-PC.local', 'gm-pc.LOCAL:5173']) {
    assert.equal(guard.hostAllowed(host), true, host);
  }
});

test('C1 names that are not the user\'s own are refused (the DNS-rebinding case) and so is every malformed Host', () => {
  for (const host of ['evil.test', 'evil.test:5173', 'localhost.evil.test', 'gm-pc.evil.test', '127.0.0.1.evil.test', 'attacker.example:5173',
    '', undefined, null, 'localhost:99999', 'localhost:0', 'localhost:abc', 'a b', 'user@localhost', 'localhost/x', 'localhost, evil.test',
    '[::1', '::1', 'localhost.', '.localhost', 'a..b', 'x'.repeat(300), '[evil]:5173', 'gm-pc.local.evil.test']) {
    assert.equal(guard.hostAllowed(host), false, String(host));
  }
});

test('strictIp accepts only this computer\'s own addresses (plus loopback) as IP literals', () => {
  const strict = createHostGuard({ hostname: 'GM-PC', strictIp: true, getAddresses: () => [{ address: '192.168.1.10' }] });
  assert.equal(strict.hostAllowed('192.168.1.10:5173'), true);
  assert.equal(strict.hostAllowed('127.0.0.1:5173'), true);
  assert.equal(strict.hostAllowed('192.168.1.99:5173'), false);
  assert.equal(strict.hostAllowed('localhost'), true);
});

test('parseHost splits host and port and lowercases', () => {
  assert.deepEqual(parseHost('LocalHost:5173'), { hostname: 'localhost', port: '5173' });
  assert.deepEqual(parseHost('[::1]:80'), { hostname: '::1', port: '80' });
  assert.deepEqual(parseHost('10.0.0.5'), { hostname: '10.0.0.5', port: null });
  assert.equal(parseHost('a:b:c'), null);
});

test('C3 Origin must be http://<the same host:port as the Host header>; a missing Origin passes only when not required', () => {
  const host = '192.168.1.10:5173';
  assert.equal(guard.originAllowed(`http://${host}`, host, { required: true }), true);
  assert.equal(guard.originAllowed('http://localhost:5173', 'localhost:5173', { required: true }), true);
  assert.equal(guard.originAllowed('http://LOCALHOST:5173', 'localhost:5173', { required: true }), true);
  assert.equal(guard.originAllowed('http://localhost', 'localhost:80', { required: true }), true, 'default port');
  assert.equal(guard.originAllowed(undefined, host, { required: false }), true);
  assert.equal(guard.originAllowed(undefined, host, { required: true }), false);
  assert.equal(guard.originAllowed('', host, { required: true }), false);
  for (const origin of ['null', 'https://192.168.1.10:5173', 'http://evil.test', 'http://evil.test:5173', 'http://192.168.1.10:5174',
    'http://192.168.1.10', 'http://192.168.1.10:5173/', 'http://192.168.1.10:5173/x', 'ws://192.168.1.10:5173', 'file://', 'http://user@192.168.1.10:5173']) {
    assert.equal(guard.originAllowed(origin, host, { required: false }), false, origin);
  }
});

test('B2/C1 a matching Origin does not rescue a Host that is not allowed (DNS rebinding with a consistent Origin)', () => {
  assert.equal(guard.originAllowed('http://evil.test:5173', 'evil.test:5173', { required: true }), false);
  assert.equal(guard.originAllowed('http://evil.test:5173', 'evil.test:5173', { required: false }), false);
});

test('isLoopback accepts the computer\'s own loopback forms only', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.1.2.3']) assert.equal(guard.isLoopback(ip), true, ip);
  for (const ip of ['192.168.1.10', '10.0.0.1', '::ffff:10.0.0.1', '::', '1.127.0.0.1', '', undefined, null, '127.0.0.1.evil', 'localhost']) {
    assert.equal(guard.isLoopback(ip), false, String(ip));
  }
});

test('loopbackHostAllowed is the host rule for the GM: localhost, 127.x and ::1 only', () => {
  for (const host of ['localhost:5173', '127.0.0.1:5173', '[::1]:5173', 'localhost']) assert.equal(guard.loopbackHostAllowed(host), true, host);
  for (const host of ['192.168.1.10:5173', 'GM-PC:5173', 'evil.test', '', undefined]) assert.equal(guard.loopbackHostAllowed(host), false, String(host));
});

// ---- lan.js and ua.js ride along: they are the replacements for lanAddresses / deviceLabel of identity.js ----------

const network = {
  Ethernet: [{ family: 'IPv4', address: '192.168.1.10', netmask: '255.255.255.0', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
  'vEthernet (WSL)': [{ family: 'IPv4', address: '172.20.0.1', netmask: '255.255.240.0', internal: false }],
  Loopback: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
  Weird: [{ family: 'IPv4', address: '169.254.3.3', netmask: '255.255.0.0', internal: false }],
  Office: [{ family: 'IPv4', address: '10.60.25.83', netmask: '255.255.254.0', internal: false }],
};

test('lanAddresses ranks private ranges first, virtual adapters last, and drops loopback / link-local / IPv6', () => {
  assert.deepEqual(lanAddresses(network).map(a => a.address), ['192.168.1.10', '10.60.25.83', '172.20.0.1']);
  assert.equal(lanAddresses(network)[2].virtual, true);
});

test('subnetOf and addressFor pick the GM address on the player\'s subnet by netmask', () => {
  assert.equal(subnetOf('192.168.1.77', network).address, '192.168.1.10');
  assert.equal(subnetOf('10.60.25.200', network).address, '10.60.25.83', '/23 spans 25.x');
  assert.equal(subnetOf('10.60.24.9', network).address, '10.60.25.83');
  assert.equal(subnetOf('10.60.26.9', network), null);
  assert.equal(subnetOf('::ffff:192.168.1.5', network).address, '192.168.1.10');
  assert.equal(addressFor('8.8.8.8', network), '192.168.1.10', 'no match: the first LAN address');
  assert.equal(addressFor('192.168.1.5', {}), null);
  assert.equal(cleanIp('::ffff:1.2.3.4'), '1.2.3.4');
});

test('deviceLabel keeps the labels of the old identity.js and recognises a few more browsers', () => {
  assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36'), 'Android · Chrome');
  assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Version/17.0 Mobile/15E148 Safari/604.1'), 'iPhone / iPad · Safari');
  assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36 Edg/120'), 'Windows · Edge');
  assert.equal(deviceLabel('Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0'), 'Linux · Firefox');
  assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) CriOS/120 Mobile Safari/604.1'), 'iPhone / iPad · Chrome');
  assert.equal(deviceLabel(''), 'Player · Browser');
  assert.equal(deviceLabel(undefined), 'Player · Browser');
  assert.equal(deviceLabel(42), 'Player · Browser');
});
