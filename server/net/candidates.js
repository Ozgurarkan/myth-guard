// Pure SDP sanitising and ICE-candidate rewriting for the audio signalling relay (design 5.3).
//
// Why: browsers hide their host addresses behind random "<uuid>.local" names that only resolve if multicast DNS works
// between the two devices, and Wi-Fi access points often filter multicast. So the server replaces the address of every
// host candidate: an ANSWER from a phone gets the phone's own IP as the server sees it on the authenticated socket, an OFFER
// from the GM page gets the GM computer's LAN address on the phone's subnet. A side effect is a security property: a
// phone can only ever make the GM's browser send UDP to the phone's own address.
//
// Nothing here touches sockets or the clock, and nothing throws on hostile input: every function returns a result object.
import { splitSdp, joinSdp, parseCandidate, formatCandidate, mediaSections } from '../../src/net/sdp.js';
import { TYPE_CAPS } from '../../src/net/protocol.js';

export const SDP_LIMITS = Object.freeze({
  maxBytes: TYPE_CAPS.AUDIO_OFFER.max,   // 12 KiB, the same cap as the frame that carries it
  maxLine: 1024,
  maxLines: 256,
  maxCandidates: 8,
});

// Attribute names that can appear in an audio-only Chrome/Firefox/Safari offer or answer. Anything else is dropped
// (and counted), which also removes data-channel (sctp), simulcast and other features this app never negotiates.
const ATTRIBUTES = new Set([
  'group', 'extmap-allow-mixed', 'msid-semantic', 'rtcp', 'candidate', 'end-of-candidates', 'ice-ufrag', 'ice-pwd',
  'ice-options', 'ice-lite', 'fingerprint', 'setup', 'mid', 'extmap', 'sendrecv', 'sendonly', 'recvonly', 'inactive',
  'msid', 'rtcp-mux', 'rtcp-rsize', 'rtcp-xr', 'rtpmap', 'rtcp-fb', 'fmtp', 'ssrc', 'ssrc-group', 'ptime', 'maxptime',
]);
const LINE_TYPES = new Set(['v', 'o', 's', 't', 'c', 'm', 'a', 'b']);

// ---------------------------------------------------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------------------------------------------------

/** `::ffff:192.168.1.5` -> `192.168.1.5`. Anything else is returned unchanged. */
export const stripMapped = address => (typeof address === 'string' ? address.replace(/^::ffff:/i, '') : address);

/** `[a, b, c, d]` for a dotted-quad IPv4 string, otherwise null. */
export function parseIPv4(address) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address ?? '');
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every(n => n <= 255) ? octets : null;
}

export const isLoopbackV4 = ([a]) => a === 127;
/** Private (RFC 1918), link-local (169.254/16) or CGNAT (100.64/10, e.g. Tailscale) space: addresses a home LAN can have. */
export const isLanV4 = ([a, b]) => a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
  (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);

/**
 * May this address appear in a candidate that reaches a browser?
 * `role` is the sender of the SDP: 'player' (an answer, address = the phone's IP) or 'gm' (an offer, address = a GM LAN IP).
 * Public, multicast, unspecified and IPv6 addresses are refused; loopback only when `allowLoopback` (tests, one-PC development).
 */
export function addressUsable(address, { allowLoopback = false } = {}) {
  const octets = parseIPv4(address);
  if (!octets) return false;
  if (isLoopbackV4(octets)) return allowLoopback;
  if (octets[0] === 0 || octets[0] >= 224) return false;
  return isLanV4(octets);
}

const toInt = octets => (((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0);

/**
 * The local address to offer a phone: the one whose subnet contains the phone's address (netmask match when the entry has
 * a `netmask`, otherwise a /24 comparison), else the first entry. `addresses` is `[{ address, netmask? }]` (or plain strings).
 * Returns null when there are no addresses.
 */
export function pickLocalAddress(playerIp, addresses) {
  const list = (addresses ?? []).map(entry => (typeof entry === 'string' ? { address: entry } : entry))
    .filter(entry => parseIPv4(entry?.address));
  if (!list.length) return null;
  const player = parseIPv4(stripMapped(playerIp));
  if (player) {
    for (const entry of list) {
      const mine = parseIPv4(entry.address);
      const mask = parseIPv4(entry.netmask);
      const bits = mask ? toInt(mask) : 0xffffff00;
      if (((toInt(mine) ^ toInt(player)) & bits) === 0) return entry.address;
    }
  }
  return list[0].address;
}

// ---------------------------------------------------------------------------------------------------------------------
// Sanitising
// ---------------------------------------------------------------------------------------------------------------------

const refuse = reason => ({ ok: false, reason });

/**
 * Structural clean-up of a session description that came from a browser through the signalling socket.
 *
 * Refuses (`{ ok:false, reason }`): not a string, over 12 KiB, non-ASCII or control characters, over-long or too many
 * lines, not starting with `v=0`, no audio section or more than one, an audio section that is not DTLS-SRTP over UDP
 * (no fingerprint, no ice-ufrag/ice-pwd), no usable candidate.
 * Cleans (`{ ok:true, sdp, dropped }`): drops non-audio media sections (and removes them from the BUNDLE group), every
 * attribute that is not on the allowlist, tcp and component-2 candidates, relay/srflx/prflx candidates; keeps at most 8
 * candidates. It does NOT change addresses: that is `rewriteSdp`.
 */
export function sanitizeSdp(sdp, options = {}) {
  const maxBytes = options.maxBytes ?? SDP_LIMITS.maxBytes;
  if (typeof sdp !== 'string' || !sdp) return refuse('not-a-string');
  if (sdp.length > maxBytes) return refuse('too-big');
  if (/[^\t\r\n\x20-\x7e]/.test(sdp)) return refuse('charset');
  const raw = splitSdp(sdp);
  if (raw.length > SDP_LIMITS.maxLines) return refuse('too-many-lines');
  if (raw[0] !== 'v=0') return refuse('not-sdp');
  if (raw.some(line => line.length > SDP_LIMITS.maxLine)) return refuse('line-too-long');

  let dropped = 0;
  const lines = [];
  for (const line of raw) {
    if (line.length < 2 || line[1] !== '=' || !LINE_TYPES.has(line[0])) { dropped++; continue; }
    if (line[0] === 'a') {
      const name = /^a=([A-Za-z0-9-]+)/.exec(line)?.[1];
      if (!name || !ATTRIBUTES.has(name)) { dropped++; continue; }
    }
    lines.push(line);
  }

  const { session, media } = mediaSections(lines);
  const audio = media.filter(section => section.kind === 'audio');
  if (audio.length !== 1) return refuse(audio.length ? 'multiple-audio' : 'no-audio');
  dropped += media.filter(section => section.kind !== 'audio').reduce((sum, section) => sum + section.lines.length, 0);

  const section = audio[0];
  const header = section.lines[0];
  if (!/^m=audio \d+ UDP\/TLS\/RTP\/SAVPF( \d+)+$/.test(header)) return refuse('not-dtls-srtp');
  const has = prefix => section.lines.some(line => line.startsWith(prefix)) || session.some(line => line.startsWith(prefix));
  if (!has('a=fingerprint:')) return refuse('no-fingerprint');
  if (!has('a=ice-ufrag:') || !has('a=ice-pwd:')) return refuse('no-ice-credentials');

  // Candidates: UDP host candidates of component 1 only, at most eight, no duplicates.
  const kept = [];
  const seen = new Set();
  const body = [];
  for (const line of section.lines) {
    if (!line.startsWith('a=candidate:')) { body.push(line); continue; }
    const candidate = parseCandidate(line);
    if (!candidate || candidate.transport !== 'udp' || candidate.type !== 'host' || candidate.component !== 1) { dropped++; continue; }
    const key = `${candidate.address}|${candidate.port}`;
    if (seen.has(key) || kept.length >= SDP_LIMITS.maxCandidates) { dropped++; continue; }
    seen.add(key);
    kept.push(candidate);
    body.push(line);
  }
  if (!kept.length) return refuse('no-candidates');
  // session-level candidates are not used by browsers for audio; refuse them rather than guess
  if (session.some(line => line.startsWith('a=candidate:'))) return refuse('session-candidates');

  // BUNDLE must only name the section that is left.
  const mid = section.mid;
  const sessionLines = session.map(line => (line.startsWith('a=group:BUNDLE') ? `a=group:BUNDLE${mid != null ? ' ' + mid : ''}` : line))
    .filter(line => !(line.startsWith('a=group:BUNDLE') && mid == null));

  return { ok: true, sdp: joinSdp([...sessionLines, ...body]), dropped, candidates: kept.length };
}

/**
 * `sanitizeSdp`, then give every host candidate the address `address` (deduplicated, because several mDNS names usually
 * collapse to one real address) and refuse the result when that address is not one a LAN browser could reach.
 *
 *   rewriteSdp(answerFromPhone, { address: sessionIp, role: 'player' })
 *   rewriteSdp(offerFromGm,     { address: gmLanAddressOnPhonesSubnet, role: 'gm' })
 *
 * Returns `{ ok:true, sdp, candidates, dropped }` or `{ ok:false, reason }`.
 */
export function rewriteSdp(sdp, { address, role = 'player', allowLoopback = false, ...rest } = {}) {
  const clean = sanitizeSdp(sdp, rest);
  if (!clean.ok) return clean;
  const ip = stripMapped(address);
  if (!addressUsable(ip, { allowLoopback })) return refuse(role === 'player' ? 'player-address' : 'gm-address');
  const out = [];
  const seen = new Set();
  let candidates = 0;
  let dropped = clean.dropped;
  for (const line of splitSdp(clean.sdp)) {
    if (!line.startsWith('a=candidate:')) { out.push(line); continue; }
    const candidate = parseCandidate(line); // cannot be null: sanitizeSdp already parsed it
    candidate.address = ip;
    const key = `${candidate.port}`;
    if (seen.has(key)) { dropped++; continue; }
    seen.add(key);
    candidates++;
    out.push(formatCandidate(candidate));
  }
  return { ok: true, sdp: joinSdp(out), candidates, dropped };
}

/** The addresses of the candidates in an SDP (for tests and for the "only the player's own IP" check). */
export const candidateAddresses = sdp => splitSdp(sdp).filter(line => line.startsWith('a=candidate:'))
  .map(line => parseCandidate(line)?.address).filter(Boolean);
