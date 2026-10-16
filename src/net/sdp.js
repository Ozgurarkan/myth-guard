// Small, pure SDP helpers shared by the GM page, the player page and the server (design 5.2, 5.3).
//
// No DOM, no Node API: the same file is bundled for the browser and imported by server/net/candidates.js.
// SDP is line based text ("type=value", CRLF separated); nothing here tries to be a full SDP library. It does exactly
// what Realm Forge needs: split and join, parse and print an ICE candidate, tune the Opus line, and find the media sections.

export const CRLF = '\r\n';

/** Lines of an SDP, tolerant of LF-only input, without empty lines. */
export const splitSdp = sdp => String(sdp ?? '').split(/\r?\n/).filter(line => line.length > 0);

/** Lines back to SDP text: CRLF separated, with the final CRLF the spec requires. */
export const joinSdp = lines => (lines.length ? lines.join(CRLF) + CRLF : '');

/**
 * `a=candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> [raddr x rport y] [tcptype t] ...`
 * (the leading `a=` / `candidate:` is optional). Returns null when the line is not a well-formed candidate.
 */
export function parseCandidate(line) {
  const text = String(line ?? '').replace(/^a=/, '').replace(/^candidate:/, '');
  const f = text.trim().split(/\s+/);
  if (f.length < 8 || f[6] !== 'typ') return null;
  const component = Number(f[1]);
  const priority = Number(f[3]);
  const port = Number(f[5]);
  if (!Number.isInteger(component) || component < 1 || component > 2) return null;
  if (!Number.isInteger(priority) || priority < 0 || priority > 0xffffffff) return null;
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  if (!/^[A-Za-z0-9+/]{1,32}$/.test(f[0]) || !/^[A-Za-z]+$/.test(f[2])) return null;
  const candidate = { foundation: f[0], component, transport: f[2].toLowerCase(), priority, address: f[4], port, type: f[7], extras: [] };
  for (let i = 8; i < f.length; i++) candidate.extras.push(f[i]);
  return candidate;
}

/** The `a=candidate:` line for a candidate object produced by `parseCandidate`. */
export const formatCandidate = c =>
  `a=candidate:${c.foundation} ${c.component} ${c.transport} ${c.priority} ${c.address} ${c.port} typ ${c.type}` +
  (c.extras?.length ? ' ' + c.extras.join(' ') : '');

/** Every candidate in an SDP, in order: `{ line, index, candidate }`. */
export function listCandidates(sdp) {
  const found = [];
  splitSdp(sdp).forEach((line, index) => {
    if (!line.startsWith('a=candidate:')) return;
    const candidate = parseCandidate(line);
    if (candidate) found.push({ line, index, candidate });
  });
  return found;
}

/**
 * Splits the lines into the session part and one entry per `m=` section:
 * `{ session: string[], media: [{ kind, mid, lines }] }` (`lines` includes the `m=` line itself).
 */
export function mediaSections(lines) {
  const session = [];
  const media = [];
  for (const line of lines) {
    if (line.startsWith('m=')) {
      media.push({ kind: line.slice(2).split(' ')[0], mid: null, lines: [line] });
    } else if (media.length) {
      media[media.length - 1].lines.push(line);
      if (line.startsWith('a=mid:')) media[media.length - 1].mid = line.slice(6).trim();
    } else session.push(line);
  }
  return { session, media };
}

const OPUS_RTPMAP = /^a=rtpmap:(\d+) opus\/48000\/2$/i;

/** Sender-side Opus choices from design 5.2: music-oriented, stereo, in-band FEC, 96 kbit/s (configurable 64-160). */
export const OPUS_DEFAULTS = Object.freeze({ bitrate: 96000, minBitrate: 64000, maxBitrate: 160000 });

/** The fmtp text for Opus, exactly as measured in design 5.6. */
export function opusFmtp(bitrate = OPUS_DEFAULTS.bitrate) {
  const clamped = Math.round(Math.max(OPUS_DEFAULTS.minBitrate, Math.min(OPUS_DEFAULTS.maxBitrate, Number(bitrate) || OPUS_DEFAULTS.bitrate)));
  return `minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=${clamped}`;
}

/**
 * Sets the Opus `a=fmtp` line to `opusFmtp(bitrate)` (adds it if there is none). Everything else is untouched, so it is
 * idempotent and safe to apply to an offer and to the answer to it. An SDP without Opus is returned unchanged.
 */
export function mungeOpus(sdp, { bitrate = OPUS_DEFAULTS.bitrate } = {}) {
  const lines = splitSdp(sdp);
  const rtpmap = lines.findIndex(line => OPUS_RTPMAP.test(line));
  if (rtpmap < 0) return sdp;
  const pt = OPUS_RTPMAP.exec(lines[rtpmap])[1];
  const fmtp = `a=fmtp:${pt} ${opusFmtp(bitrate)}`;
  const existing = lines.findIndex(line => line.startsWith(`a=fmtp:${pt} `));
  if (existing >= 0) lines[existing] = fmtp;
  else {
    let at = rtpmap;
    while (at + 1 < lines.length && lines[at + 1].startsWith(`a=rtcp-fb:${pt} `)) at++;
    lines.splice(at + 1, 0, fmtp);
  }
  return joinSdp(lines);
}

/** True when the SDP offers or answers Opus in its audio section. */
export const hasOpus = sdp => splitSdp(sdp).some(line => OPUS_RTPMAP.test(line));
