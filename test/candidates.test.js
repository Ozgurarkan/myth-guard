import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeSdp, rewriteSdp, pickLocalAddress, addressUsable, parseIPv4, stripMapped, candidateAddresses, SDP_LIMITS,
} from '../server/net/candidates.js';
import { splitSdp, joinSdp, listCandidates } from '../src/net/sdp.js';
import { EDGE_OFFER, EDGE_ANSWER } from '../test-support/wp5-sdp-edge.js';

const withLines = (sdp, edit) => joinSdp(edit(splitSdp(sdp)));
const candidateLine = (n, address, port, extra = '') => `a=candidate:${n} 1 udp ${2113937151 - n} ${address} ${port} typ host generation 0 network-cost 999${extra}`;
const insertAfterRtcp = (sdp, ...lines) => withLines(sdp, all => { const at = all.findIndex(l => l.startsWith('a=rtcp:')); all.splice(at + 1, 0, ...lines); return all; });

test('G1: an Edge answer from a phone becomes an answer whose only candidate address is that phone\'s IP (mDNS name replaced)', () => {
  assert.match(candidateAddresses(EDGE_ANSWER)[0], /\.local$/);
  const result = rewriteSdp(EDGE_ANSWER, { address: '::ffff:192.168.1.42', role: 'player' });
  assert.equal(result.ok, true);
  assert.deepEqual(candidateAddresses(result.sdp), ['192.168.1.42']);
  assert.equal(result.candidates, 1);
  assert.equal(result.dropped, 0, 'nothing in a real Edge answer needs to be dropped');
  const before = listCandidates(EDGE_ANSWER)[0].candidate;
  const after = listCandidates(result.sdp)[0].candidate;
  assert.equal(after.port, before.port, 'the port is kept');
  assert.equal(after.priority, before.priority);
  assert.equal(after.foundation, before.foundation);
  // everything except the candidate line is byte-identical
  const strip = sdp => splitSdp(sdp).filter(l => !l.startsWith('a=candidate:'));
  assert.deepEqual(strip(result.sdp), strip(EDGE_ANSWER));
  assert.ok(result.sdp.endsWith('\r\n'));
});

test('an Edge offer from the GM page gets the GM computer\'s LAN address', () => {
  const result = rewriteSdp(EDGE_OFFER, { address: '192.168.1.10', role: 'gm' });
  assert.equal(result.ok, true);
  assert.deepEqual(candidateAddresses(result.sdp), ['192.168.1.10']);
  assert.ok(result.sdp.includes('a=msid:'), 'the sender\'s stream description is kept');
  assert.ok(result.sdp.includes('a=ssrc:'), 'ssrc lines are kept');
});

test('G1: only the answering player\'s own address can come out, whatever candidates the answer claims', () => {
  const hostile = insertAfterRtcp(EDGE_ANSWER,
    'a=candidate:9 1 udp 1000 8.8.8.8 5000 typ srflx raddr 0.0.0.0 rport 0',
    'a=candidate:10 1 udp 1000 10.9.9.9 5001 typ host',
    'a=candidate:11 1 tcp 1000 10.9.9.9 5002 typ host tcptype passive',
    'a=candidate:12 1 udp 1000 203.0.113.9 5003 typ relay raddr 1.1.1.1 rport 1',
    'a=candidate:13 2 udp 1000 10.9.9.9 5004 typ host',
    'a=candidate:14 1 udp 1000 127.0.0.1 5005 typ host');
  const result = rewriteSdp(hostile, { address: '192.168.1.42' });
  assert.equal(result.ok, true);
  assert.deepEqual(new Set(candidateAddresses(result.sdp)), new Set(['192.168.1.42']));
  const ports = listCandidates(result.sdp).map(c => c.candidate.port);
  assert.ok(ports.includes(5001) && !ports.includes(5002) && !ports.includes(5003) && !ports.includes(5004), 'tcp, relay, srflx and component 2 are gone');
  assert.ok(result.dropped >= 4);
});

test('several mDNS names for the same socket collapse to one candidate after the rewrite; at most 8 host candidates are kept', () => {
  const many = insertAfterRtcp(EDGE_ANSWER, ...Array.from({ length: 20 }, (_, i) => candidateLine(100 + i, `${i}-name.local`, 6000 + (i % 12))));
  const clean = sanitizeSdp(many);
  assert.equal(clean.ok, true);
  assert.ok(clean.candidates <= SDP_LIMITS.maxCandidates);
  const result = rewriteSdp(many, { address: '10.0.0.7' });
  assert.equal(result.ok, true);
  const ports = listCandidates(result.sdp).map(c => c.candidate.port);
  assert.equal(new Set(ports).size, ports.length, 'no duplicate address:port');
  assert.ok(ports.length <= 8);
});

test('sanitizeSdp refuses the shapes design 5.3 lists, with a reason', () => {
  const cases = {
    'not-a-string': 42,
    'too-big': EDGE_ANSWER + 'a=x:' + 'y'.repeat(SDP_LIMITS.maxBytes),
    'charset': EDGE_ANSWER + 'a=mid:é\r\n',
    'not-sdp': 'hello\r\nworld\r\n',
    'no-audio': joinSdp(splitSdp(EDGE_ANSWER).filter(l => !l.startsWith('m=audio'))),
    'multiple-audio': EDGE_ANSWER + 'm=audio 9 UDP/TLS/RTP/SAVPF 0\r\na=mid:1\r\n',
    'not-dtls-srtp': EDGE_ANSWER.replace('UDP/TLS/RTP/SAVPF', 'RTP/AVP'),
    'no-fingerprint': joinSdp(splitSdp(EDGE_ANSWER).filter(l => !l.startsWith('a=fingerprint'))),
    'no-ice-credentials': joinSdp(splitSdp(EDGE_ANSWER).filter(l => !l.startsWith('a=ice-pwd'))),
    'no-candidates': joinSdp(splitSdp(EDGE_ANSWER).filter(l => !l.startsWith('a=candidate'))),
    'line-too-long': EDGE_ANSWER + 'a=ssrc:1 cname:' + 'x'.repeat(2000) + '\r\n',
    'too-many-lines': EDGE_ANSWER + 'a=ptime:20\r\n'.repeat(300),
  };
  for (const [reason, sdp] of Object.entries(cases)) {
    const result = sanitizeSdp(sdp);
    assert.deepEqual([reason, result.ok, result.reason], [reason, false, reason === 'too-big' ? 'too-big' : reason]);
  }
  assert.equal(sanitizeSdp('').ok, false);
  assert.equal(sanitizeSdp(null).ok, false);
  assert.equal(sanitizeSdp(undefined).ok, false);
  assert.equal(sanitizeSdp({}).ok, false);
});

test('a candidate at session level is refused (browsers do not use it for audio, so it can only be an attack)', () => {
  const sdp = withLines(EDGE_ANSWER, all => { all.splice(3, 0, candidateLine(1, 'x.local', 9)); return all; });
  assert.equal(sanitizeSdp(sdp).reason, 'session-candidates');
});

test('data channels, video and unknown attributes are removed, and BUNDLE only names the audio section', () => {
  const sdp = withLines(EDGE_OFFER, all => {
    all[all.indexOf('a=group:BUNDLE 0')] = 'a=group:BUNDLE 0 1 2';
    all.push('m=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0', 'a=mid:1', 'a=sctp-port:5000', 'a=candidate:1 1 udp 1 evil.local 9 typ host',
      'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=mid:2', 'a=rtpmap:96 VP8/90000');
    all.splice(5, 0, 'a=sctpmap:5000 webrtc-datachannel 1024', 'a=evil-attribute:1', 'u=http://example.com', 'z=0 0');
    return all;
  });
  const result = sanitizeSdp(sdp);
  assert.equal(result.ok, true);
  const lines = splitSdp(result.sdp);
  assert.equal(lines.filter(l => l.startsWith('m=')).length, 1);
  assert.ok(lines.includes('a=group:BUNDLE 0'));
  for (const gone of ['sctp', 'evil', 'VP8', 'u=', 'z=']) assert.ok(!result.sdp.includes(gone), gone);
  assert.ok(result.dropped >= 8);
  assert.equal(listCandidates(result.sdp).length, 1, 'the candidate that belonged to the data channel is gone with its section');
});

test('the rewrite refuses an address a LAN browser could not use: public, loopback (unless allowed), multicast, IPv6, junk', () => {
  for (const address of ['8.8.8.8', '127.0.0.1', '::1', 'fe80::1', '224.0.0.1', '0.0.0.0', '256.1.1.1', 'evil.example', '', null, undefined, '192.168.1']) {
    const result = rewriteSdp(EDGE_ANSWER, { address, role: 'player' });
    assert.deepEqual([String(address), result.ok, result.reason], [String(address), false, 'player-address']);
  }
  assert.equal(rewriteSdp(EDGE_OFFER, { address: '8.8.8.8', role: 'gm' }).reason, 'gm-address');
  assert.equal(rewriteSdp(EDGE_ANSWER, { address: '127.0.0.1', allowLoopback: true }).ok, true, 'one-PC development and the acceptance harness opt in');
  for (const address of ['10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.0.1', '169.254.3.4', '100.64.1.1']) {
    assert.equal(addressUsable(address), true, address);
  }
  for (const address of ['172.15.0.1', '172.32.0.1', '192.169.0.1', '11.0.0.1', '100.63.0.1', '100.128.0.1']) {
    assert.equal(addressUsable(address), false, address);
  }
});

test('rewriteSdp passes the sanitiser\'s refusals through unchanged', () => {
  assert.deepEqual(rewriteSdp('nope', { address: '192.168.1.2' }), { ok: false, reason: 'not-sdp' });
});

test('pickLocalAddress prefers the interface whose subnet holds the phone, falls back to the first', () => {
  const addresses = [
    { address: '10.60.25.83', netmask: '255.255.255.0' },
    { address: '192.168.1.10', netmask: '255.255.255.0' },
    { address: '172.20.0.5', netmask: '255.255.0.0' },
  ];
  assert.equal(pickLocalAddress('192.168.1.42', addresses), '192.168.1.10');
  assert.equal(pickLocalAddress('::ffff:10.60.25.200', addresses), '10.60.25.83');
  assert.equal(pickLocalAddress('172.20.99.1', addresses), '172.20.0.5', 'a /16 netmask is honoured');
  assert.equal(pickLocalAddress('192.168.2.42', addresses), '10.60.25.83', 'no match: the first');
  assert.equal(pickLocalAddress('fe80::1', addresses), '10.60.25.83');
  assert.equal(pickLocalAddress('192.168.1.42', []), null);
  assert.equal(pickLocalAddress('192.168.1.42', null), null);
  assert.equal(pickLocalAddress('192.168.1.42', ['10.0.0.1', '192.168.1.9']), '192.168.1.9', 'plain strings use a /24 match');
  assert.equal(pickLocalAddress('192.168.1.42', [{ address: 'garbage' }, { address: '10.0.0.1' }]), '10.0.0.1');
});

test('small address helpers', () => {
  assert.deepEqual(parseIPv4('1.2.3.4'), [1, 2, 3, 4]);
  assert.equal(parseIPv4('1.2.3'), null);
  assert.equal(parseIPv4('1.2.3.999'), null);
  assert.equal(stripMapped('::ffff:10.0.0.1'), '10.0.0.1');
  assert.equal(stripMapped('::FFFF:10.0.0.1'), '10.0.0.1');
  assert.equal(stripMapped(null), null);
});

test('fuzz: random mutations of a real answer never throw and never let a foreign address through', () => {
  let seed = 12345;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const base = splitSdp(EDGE_ANSWER);
  const junk = ['a=candidate:1 1 udp 9 6.6.6.6 99 typ host', 'm=audio 1 X', 'a=\u0000', '', 'v=0', 'a=fmtp:111 ' + 'x'.repeat(500), 'zz', 'a=candidate:'];
  for (let n = 0; n < 3000; n++) {
    const lines = base.slice();
    for (let k = 0; k < 1 + Math.floor(rand() * 4); k++) {
      const op = rand();
      const at = Math.floor(rand() * lines.length);
      if (op < 0.33) lines.splice(at, 1);
      else if (op < 0.66) lines.splice(at, 0, junk[Math.floor(rand() * junk.length)]);
      else lines[at] = lines[at].slice(0, Math.floor(rand() * lines[at].length));
    }
    const result = rewriteSdp(joinSdp(lines), { address: '192.168.7.7' });
    assert.equal(typeof result.ok, 'boolean');
    if (result.ok) for (const address of candidateAddresses(result.sdp)) assert.equal(address, '192.168.7.7');
  }
});
