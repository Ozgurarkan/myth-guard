import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitSdp, joinSdp, parseCandidate, formatCandidate, listCandidates, mediaSections, mungeOpus, opusFmtp, hasOpus, OPUS_DEFAULTS,
} from '../src/net/sdp.js';
import { EDGE_OFFER, EDGE_ANSWER } from '../test-support/wp5-sdp-edge.js';

test('split and join round-trip a real Edge offer byte for byte (CRLF, final CRLF)', () => {
  assert.ok(EDGE_OFFER.startsWith('v=0\r\n') && EDGE_OFFER.endsWith('\r\n'));
  assert.equal(joinSdp(splitSdp(EDGE_OFFER)), EDGE_OFFER);
  assert.equal(joinSdp(splitSdp(EDGE_OFFER.replace(/\r\n/g, '\n'))), EDGE_OFFER, 'LF-only input is accepted and normalised');
  assert.deepEqual(splitSdp(''), []);
  assert.deepEqual(splitSdp(null), []);
  assert.equal(joinSdp([]), '');
});

test('parseCandidate reads the mDNS host candidate Edge produces and formatCandidate reproduces the line', () => {
  const [{ line, candidate }] = listCandidates(EDGE_OFFER);
  assert.equal(candidate.component, 1);
  assert.equal(candidate.transport, 'udp');
  assert.equal(candidate.type, 'host');
  assert.match(candidate.address, /^[0-9a-f-]{36}\.local$/);
  assert.equal(candidate.port, 60729);
  assert.deepEqual(candidate.extras, ['generation', '0', 'network-cost', '999']);
  assert.equal(formatCandidate(candidate), line);
});

test('parseCandidate accepts the bare forms and refuses malformed lines', () => {
  const full = 'a=candidate:1 1 udp 2113937151 192.168.1.5 5000 typ host';
  assert.equal(parseCandidate(full).address, '192.168.1.5');
  assert.equal(parseCandidate('candidate:1 1 udp 2113937151 192.168.1.5 5000 typ host').port, 5000);
  assert.equal(parseCandidate('1 1 UDP 2113937151 192.168.1.5 5000 typ host').transport, 'udp', 'transport is lower-cased');
  const srflx = parseCandidate('a=candidate:2 1 udp 1677729535 8.8.8.8 5000 typ srflx raddr 192.168.1.5 rport 5000');
  assert.equal(srflx.type, 'srflx');
  assert.deepEqual(srflx.extras, ['raddr', '192.168.1.5', 'rport', '5000']);
  for (const bad of ['', 'a=candidate:', 'a=candidate:1 1 udp 1 1.2.3.4 99999 typ host', 'a=candidate:1 3 udp 1 1.2.3.4 5 typ host',
    'a=candidate:1 1 udp -1 1.2.3.4 5 typ host', 'a=candidate:1 1 udp 1 1.2.3.4 5 nottyp host', 'a=candidate:!! 1 udp 1 1.2.3.4 5 typ host',
    'a=candidate:1 1 udp 1 1.2.3.4', null, undefined, 42]) {
    assert.equal(parseCandidate(bad), null, String(bad));
  }
});

test('mediaSections separates the session part from the m= sections and finds the mid', () => {
  const { session, media } = mediaSections(splitSdp(EDGE_OFFER));
  assert.equal(session[0], 'v=0');
  assert.ok(session.includes('a=group:BUNDLE 0'));
  assert.equal(media.length, 1);
  assert.equal(media[0].kind, 'audio');
  assert.equal(media[0].mid, '0');
  assert.ok(media[0].lines[0].startsWith('m=audio 9 UDP/TLS/RTP/SAVPF 111 '));
  const two = mediaSections(['v=0', 'm=audio 9 X', 'a=mid:a', 'm=video 9 X', 'a=mid:v']);
  assert.deepEqual(two.media.map(m => [m.kind, m.mid]), [['audio', 'a'], ['video', 'v']]);
});

test('mungeOpus writes exactly the fmtp line the experiments measured (design 5.2) and changes nothing else', () => {
  const out = mungeOpus(EDGE_OFFER);
  const a = splitSdp(EDGE_OFFER), b = splitSdp(out);
  assert.equal(b.length, a.length);
  const changed = b.filter((line, i) => line !== a[i]);
  assert.deepEqual(changed, ['a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=96000']);
  assert.ok(out.endsWith('\r\n'));
  assert.ok(out.includes('a=fmtp:63 111/111'), 'the RED line is untouched');
});

test('mungeOpus is idempotent, works on the answer too, clamps the bitrate to 64-160 kbit/s', () => {
  const once = mungeOpus(EDGE_ANSWER, { bitrate: 128000 });
  assert.ok(once.includes('maxaveragebitrate=128000'));
  assert.equal(mungeOpus(once, { bitrate: 128000 }), once);
  assert.match(mungeOpus(EDGE_OFFER, { bitrate: 1 }), /maxaveragebitrate=64000/);
  assert.match(mungeOpus(EDGE_OFFER, { bitrate: 9e9 }), /maxaveragebitrate=160000/);
  assert.match(mungeOpus(EDGE_OFFER, { bitrate: 'x' }), /maxaveragebitrate=96000/);
  assert.equal(opusFmtp(), `minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=${OPUS_DEFAULTS.bitrate}`);
});

test('mungeOpus adds the fmtp line when there is none (after the rtcp-fb lines of that payload type) and ignores SDPs without Opus', () => {
  const bare = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111 0', 'a=rtpmap:111 opus/48000/2', 'a=rtcp-fb:111 transport-cc', 'a=rtpmap:0 PCMU/8000'];
  const out = splitSdp(mungeOpus(joinSdp(bare)));
  assert.equal(out[4], 'a=fmtp:111 ' + opusFmtp());
  assert.equal(out[5], 'a=rtpmap:0 PCMU/8000');
  const noOpus = joinSdp(['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 0', 'a=rtpmap:0 PCMU/8000']);
  assert.equal(mungeOpus(noOpus), noOpus);
  assert.equal(hasOpus(EDGE_OFFER), true);
  assert.equal(hasOpus(noOpus), false);
});

test('mungeOpus uses the payload type the browser chose, not a fixed 111', () => {
  const sdp = joinSdp(['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 opus/48000/2', 'a=fmtp:96 minptime=10;useinbandfec=1']);
  assert.ok(mungeOpus(sdp).includes('a=fmtp:96 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=96000'));
});
