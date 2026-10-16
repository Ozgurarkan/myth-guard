/**
 * Realm Forge network protocol v3: the shared contract between the server, the GM page and the player pages.
 *
 * This file is imported by Node AND by the browser bundle. It has no imports and uses no Node API.
 * Design reference: docs/network-design.md sections 4.2, 4.3, 4.5, 4.6 and "Appendix A - frozen protocol decisions (WP1)".
 * It is frozen: change it only with the sign-off described in section 7.8 of the design.
 */

const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
};

/** A read-only Set: add/delete/clear throw, and the object itself is frozen. */
const frozenSet = items => {
  const set = new Set(items);
  const refuse = () => { throw new TypeError('This Set is frozen'); };
  Object.defineProperty(set, 'add', { value: refuse });
  Object.defineProperty(set, 'delete', { value: refuse });
  Object.defineProperty(set, 'clear', { value: refuse });
  return Object.freeze(set);
};

export const PROTOCOL_VERSION = 3; // v2 is the old code; v3 clients and servers refuse each other with close 4004

export const PATHS = deepFreeze({
  ws: '/__realm/ws',            // control + state (query: role=player|gm)
  audioWs: '/__realm/audio',    // fallback audio, binary frames only (query: role=player|gm)
  hello: '/__realm/hello',      // POST: get a one-time nonce
  join: '/__realm/join',        // POST: first-time admission
  info: '/__realm/info',        // GET (GM only): addresses, invite link, code, mode, counts
  status: '/__realm/status',    // GET (loopback): { app, version } only - used by the launcher to detect a running server
  diag: '/__realm/diag',        // GET (GM only): full metrics JSON;  /__realm/diag/log -> last 500 log lines
  assets: '/__realm/assets/',   // GET <sha256> | PUT <sha256> | POST missing
});

/** WebSocket close codes (4000-4999 are application codes). 1003 and 1009 are the standard codes 4.5/4.6 call for. */
export const CLOSE = deepFreeze({
  UNSUPPORTED_DATA: 1003, // binary frame on the control socket
  TOO_BIG: 1009,          // frame over the role's maxPayload
  REPLACED: 4001,         // another GM window took over (this window must NOT auto-reconnect)
  KICKED: 4002,           // GM removed this device (do not auto-reconnect; show "removed" screen)
  NOT_ADMITTED: 4003,     // table locked, or admission denied
  TOO_OLD: 4004,          // protocol mismatch: reload the page (do not auto-reconnect)
  ABUSE: 4008,            // rate/size limits exceeded repeatedly (client backs off 30 s)
  SLOW: 4009,             // could not drain its queue for 10 s; reconnect and resume
  SHUTDOWN: 4010,         // server stopping; reconnect with backoff
  AUTH: 4011,             // proof invalid or nonce stale (client fetches a new nonce and retries once)
});

/** Numbers every module shares. The first block is exactly design 4.2; the second block holds numbers 4.x states in prose. */
export const LIMITS = deepFreeze({
  maxSocketsTotal: 48, maxSocketsPerIp: 8, maxAdmittedDevices: 16, maxPendingDevices: 4,
  playerMaxPayload: 16 * 1024, gmMaxPayload: 8 * 1024 * 1024, audioMaxPayload: 16 * 1024,
  helloPerIpPerMin: 60, joinPerIpPerMin: 12, failedProofsBeforeBan: 5, banMs: 5 * 60 * 1000,
  heartbeatMs: 4000, silenceMs: 12000, serverPingMs: 15000, serverDeadMs: 30000,
  patchHistory: 64, backlogStopBytes: 256 * 1024, backlogResumeBytes: 64 * 1024, slowCloseMs: 10000,
  // --- from the prose of 3.6, 4.3, 4.4, 4.5, 4.6 (WP1 collected them here so nobody invents a second copy) ---
  httpBodyMax: 512,               // POST /hello and /join bodies
  nonceTtlMs: 15000,              // a nonce is live for 15 s and is single-use
  nonceMaxLive: 256,              // the server keeps at most this many live nonces
  socketsPerDevice: 3,            // several windows on one device
  codeFreshAfterCloseMs: 10 * 60 * 1000, // typed code accepted until 10 min after the invite dialog closes
  wrongCodePerIpPerMin: 5,        // then the IP is banned for banMs
  wrongCodeGlobalPerMin: 30,      // then the table auto-locks
  pendingTtlMs: 5 * 60 * 1000,    // 'ask' mode: auto-deny after 5 minutes
  strikesToClose: 10,             // strikes within strikeWindowMs close the socket with ABUSE
  strikeWindowMs: 10000,
  strikeBanMs: 30000,
  resumeWaitMs: 2000,             // the server waits this long for RESUME, then behaves as rev:null
  resumeMaxPatches: 16,           // more than this many patches behind -> STATE_FULL
  actionMemory: 64,               // acked action ids remembered per device
  actionRetryMs: 5000,            // the client keeps an unacked action this long
  nameMax: 40,                    // characters (code points) of a display name
});

export const ROLES = frozenSet(['player', 'gm']);
export const ADMISSION_MODES = frozenSet(['open', 'ask', 'locked']);
export const TABLE_OPS = frozenSet(['kick', 'admit', 'deny', 'lock', 'unlock', 'rotate', 'mode', 'rename']);
export const ACK_REASONS = frozenSet(['blocked', 'paused', 'away', 'not-your-turn', 'rate', 'invalid']);

/** Table code: 8 characters from a 31-symbol alphabet with no I, L, O, 0 or 1 (about 39.6 bits). */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;

// ---------------------------------------------------------------------------------------------------------------------
// Message catalogue (design 4.6). Direction is in the name of the Set. A type may appear in several Sets.
// ---------------------------------------------------------------------------------------------------------------------

/** Player -> server. Anything else from a player is a protocol violation (strike). */
export const PLAYER_TYPES = frozenSet([
  'PING', 'RESUME', 'RESYNC', 'REQUEST_FULL_STATE', 'PLAYER_NAME', 'PLAYER_TOKEN_MOVE', 'PLAYER_PING',
  'PLAYER_END_TURN', 'AUDIO_LISTEN', 'AUDIO_ANSWER', 'AUDIO_STATS',
]);

/** GM -> server. */
export const GM_TYPES = frozenSet([
  'PING', 'RESUME', 'SCENE', 'AUDIO_OFFER', 'AUDIO_CONTROLS', 'AUDIO_STATUS', 'AUDIO_SELECT', 'AUDIO_FALLBACK',
  'AUDIO_STOP', 'TABLE_CMD',
]);

/** Server -> player. MOVE_REJECTED / TURN_REJECTED / PLAYER_ID are the v2 names the app still uses (ACK is the v3 form). */
export const SERVER_TO_PLAYER = frozenSet([
  'HELLO', 'STATE_FULL', 'STATE_PATCH', 'GM_STATUS', 'MAP_PING', 'ACK', 'PONG', 'AUDIO_OFFER', 'AUDIO_CONTROLS',
  'AUDIO_STATUS', 'AUDIO_FALLBACK', 'AUDIO_STOP', 'KICKED', 'TABLE_LOCKED', 'WAIT', 'ADMITTED', 'DENIED',
  'PLAYER_ID', 'MOVE_REJECTED', 'TURN_REJECTED',
]);

/** Server -> GM. */
export const SERVER_TO_GM = frozenSet([
  'HELLO', 'PONG', 'REQUEST_FULL_STATE', 'PLAYER_ROSTER', 'JOIN_REQUEST', 'TABLE', 'PLAYER_TOKEN_MOVE',
  'PLAYER_END_TURN', 'MAP_PING', 'AUDIO_LISTENER', 'AUDIO_ANSWER', 'AUDIO_STATS',
]);

const KiB = 1024;
const MiB = 1024 * 1024;
const cap = (max, burst, perSec) => ({ max, burst, perSec });
// Receive-side budget for a type that only ever travels server -> client: nobody rate-limits the server.
const fromServer = max => ({ max, burst: null, perSec: null });

/**
 * Per-type limits. `max` = largest frame in bytes (after decompression); `burst` = token-bucket capacity;
 * `perSec` = sustained refill. `burst: null` means "not rate limited" and only occurs for types that no client may send.
 * Exactly one entry for every type in the four Sets above, and nothing else.
 */
export const TYPE_CAPS = deepFreeze({
  // client -> server (both roles)
  PING: cap(96, 5, 1),
  RESUME: cap(512, 1, 0),                        // once per socket
  // player -> server
  RESYNC: cap(64, 3, 0.5),
  REQUEST_FULL_STATE: cap(64, 3, 0.5),           // also server -> GM (the same 64-byte message)
  PLAYER_NAME: cap(256, 1, 0.5),
  PLAYER_TOKEN_MOVE: cap(192, 40, 30),           // also server -> GM
  PLAYER_PING: cap(128, 2, 1.5),                 // the 700 ms cooldown itself is a rule in actions.js; this is the flood bucket
  PLAYER_END_TURN: cap(160, 3, 1),               // duplicates within 1.5 s are ignored by actions.js; also server -> GM
  AUDIO_LISTEN: cap(256, 2, 1),
  AUDIO_ANSWER: cap(12 * KiB, 3, 3),             // also server -> GM
  AUDIO_STATS: cap(512, 2, 0.25),                // also server -> GM
  // GM -> server
  SCENE: cap(8 * MiB, 60, 60),
  AUDIO_OFFER: cap(12 * KiB, 20, 10),            // burst 20: one offer per admitted device (16) arrives together; also server -> player
  AUDIO_CONTROLS: cap(512, 20, 20),              // also server -> player
  AUDIO_STATUS: cap(512, 20, 20),                // also server -> player
  AUDIO_SELECT: cap(64 * KiB, 20, 20),
  AUDIO_FALLBACK: cap(512, 20, 20),              // also server -> player
  AUDIO_STOP: cap(512, 20, 20),                  // also server -> player
  TABLE_CMD: cap(512, 10, 10),
  // server -> client only (max = largest frame a client or the GM must be prepared to accept)
  HELLO: fromServer(2 * KiB),
  STATE_FULL: fromServer(8 * MiB),               // bounded by the GM's SCENE cap
  STATE_PATCH: fromServer(8 * MiB),
  GM_STATUS: fromServer(128),
  MAP_PING: fromServer(256),
  ACK: fromServer(256),
  PONG: fromServer(128),
  KICKED: fromServer(256),
  TABLE_LOCKED: fromServer(256),
  WAIT: fromServer(256),
  ADMITTED: fromServer(256),
  DENIED: fromServer(256),
  PLAYER_ID: fromServer(128),
  MOVE_REJECTED: fromServer(256),
  TURN_REJECTED: fromServer(256),
  PLAYER_ROSTER: fromServer(64 * KiB),
  JOIN_REQUEST: fromServer(1 * KiB),
  TABLE: fromServer(64 * KiB),
  AUDIO_LISTENER: fromServer(512),
});

// ---------------------------------------------------------------------------------------------------------------------
// Sub-protocol authentication token (design 4.3 step 2)
// ---------------------------------------------------------------------------------------------------------------------

export const SUBPROTOCOL = 'rf3';

/** True when `value` is a string of exactly `bytes` bytes written as lowercase hex (so 2 * bytes characters). */
export const isHex = (value, bytes) => typeof value === 'string' && value.length === bytes * 2 && /^[0-9a-f]+$/.test(value);

/** `auth.<device>.<nonce>.<proof>` - device and nonce are 16 bytes, proof is 32 bytes, all lowercase hex. */
export const authProtocol = (device, nonce, proof) => {
  if (!isHex(device, 16) || !isHex(nonce, 16) || !isHex(proof, 32)) throw new TypeError('authProtocol: device, nonce and proof must be 32, 32 and 64 lowercase hex characters');
  return `auth.${device}.${nonce}.${proof}`;
};

const AUTH_TOKEN = /^auth\.([0-9a-f]{32})\.([0-9a-f]{32})\.([0-9a-f]{64})$/;
const AUTH_HEADER_MAX = 512; // the whole Sec-WebSocket-Protocol header: 'rf3, ' + a 135-character token fits many times over

/**
 * Accepts the raw Sec-WebSocket-Protocol header (comma separated), an array of offered protocols, or a Set of them
 * (what `ws` passes to handleProtocols). Returns { device, nonce, proof } when exactly one well-formed auth token is
 * offered, otherwise null. Never throws.
 */
export const parseAuthProtocol = header => {
  let offered;
  if (typeof header === 'string') {
    if (header.length > AUTH_HEADER_MAX) return null;
    offered = header.split(',');
  } else if (Array.isArray(header) || header instanceof Set) {
    if (header.size > 8 || header.length > 8) return null;
    offered = [...header];
  } else return null;
  let found = null;
  for (const raw of offered) {
    if (typeof raw !== 'string' || raw.length > AUTH_HEADER_MAX) return null;
    const token = raw.replace(/^[ \t]+|[ \t]+$/g, ''); // optional whitespace only: a stray newline is not OWS
    if (!token.startsWith('auth.')) continue;
    if (found) return null; // two auth tokens: ambiguous, refuse
    const match = AUTH_TOKEN.exec(token);
    if (!match) return null;
    found = { device: match[1], nonce: match[2], proof: match[3] };
  }
  return found;
};

// ---------------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------------

/** Ids in messages (token ids, aids, session ids): 1-64 of letters, digits, underscore, hyphen. Strings only. */
export const isId = value => typeof value === 'string' && /^[\w-]{1,64}$/.test(value);

// Control (Cc), surrogates (Cs, i.e. lone ones), private use (Co) and format characters (Cf: bidi overrides, zero-width
// space, word joiner, BOM...) except ZWNJ/ZWJ, which real names and emoji sequences need.
const NAME_STRIP = /[\p{Cc}\p{Cs}\p{Co}]|(?![‌‍])\p{Cf}/gu;

/**
 * A display label: never identity, never trusted. Non-strings give ''. Removes control/format characters, collapses
 * runs of whitespace, trims, and cuts to `limit` code points (never splits a surrogate pair).
 */
export const cleanName = (value, limit = LIMITS.nameMax) => {
  if (typeof value !== 'string') return '';
  const bound = Math.max(0, Math.floor(Number.isFinite(limit) ? limit : LIMITS.nameMax));
  let text = value.length > 4096 ? value.slice(0, 4096) : value;
  text = text.replace(NAME_STRIP, '').replace(/[\p{Z}\s]+/gu, ' ').trim();
  const points = Array.from(text);
  if (points.length > bound) text = points.slice(0, bound).join('').trim();
  return text;
};

const encoder = new TextEncoder();

/** 32-bit FNV-1a over the UTF-8 bytes of `text`, as an unsigned integer (for the optional STATE_PATCH `sum`). */
export const fnv1a = text => {
  const bytes = encoder.encode(String(text));
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};
