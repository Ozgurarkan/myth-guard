// Frame validation: bytes -> a clean message object, or a reason to drop the frame (design 4.6).
//
//   1. size of the whole frame against the role's maximum, THEN JSON.parse
//   2. the message must be a plain object with a string `type`
//   3. the type must be in the role's catalogue (anything else: wrong-direction or unknown-type)
//   4. the frame must fit that type's cap
//   5. the fields are checked and COPIED into a fresh object: handlers never see the sender's object, so
//      `__proto__`, `constructor`, extra fields and giant values cannot travel any further
//
// Nothing here throws. Rate limiting is the session's job (it needs the type, which this returns).
import {
  PLAYER_TYPES, GM_TYPES, SERVER_TO_PLAYER, SERVER_TO_GM, TYPE_CAPS, LIMITS, TABLE_OPS, ADMISSION_MODES,
  isId, isHex, cleanName,
} from '../../src/net/protocol.js';

const MAX_COORD = 1e7;
const MAX_AIDS = 64;
const DEFAULT_CAP = Object.freeze({ max: 4096, burst: 10, perSec: 10 });
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const finite = value => typeof value === 'number' && Number.isFinite(value);
const coord = value => finite(value) && Math.abs(value) <= MAX_COORD;
const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.length <= max;
const deviceRef = value => isHex(value, 16) || isHex(value, 12); // a device id, or a playerId (the GM may use either)
const BAD = Symbol('bad');

/** An action id is a client counter (non-negative integer) or an id-shaped string. */
const aidOf = value => {
  if (value === undefined) return undefined;
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (isId(value)) return value;
  return BAD;
};

/** Copy the primitive fields of `source` that are not already in `out` (bounded; no nesting, no forbidden keys). */
function loose(source, out, skip = []) {
  let kept = 0;
  for (const key of Object.keys(source)) {
    if (kept >= 16) break;
    if (key === 'type' || FORBIDDEN_KEYS.has(key) || skip.includes(key) || key in out) continue;
    const value = source[key];
    if (typeof value === 'boolean' || coord(value) || text(value, 256)) { out[key] = value; kept += 1; }
  }
  return out;
}

const VALIDATORS = {
  PING(m) {
    const out = { type: 'PING' };
    if (m.t !== undefined) {
      if (!(finite(m.t) || text(m.t, 32))) return null;
      out.t = m.t;
    }
    for (const key of ['rtt', 'loss', 'rec']) {
      if (m[key] === undefined) continue;
      if (!finite(m[key])) return null;
      out[key] = Math.max(-1, Math.min(m[key], 1e6));
    }
    return out;
  },
  RESUME(m) {
    let rev = null;
    if (m.rev !== undefined && m.rev !== null) {
      if (!Number.isSafeInteger(m.rev) || m.rev < 0) return null;
      rev = m.rev;
    }
    const aids = [];
    if (m.aids !== undefined) {
      if (!Array.isArray(m.aids) || m.aids.length > MAX_AIDS) return null;
      for (const aid of m.aids) {
        const clean = aidOf(aid);
        if (clean === BAD || clean === undefined) return null;
        aids.push(clean);
      }
    }
    return { type: 'RESUME', rev, aids };
  },
  RESYNC: () => ({ type: 'RESYNC' }),
  REQUEST_FULL_STATE: () => ({ type: 'REQUEST_FULL_STATE' }),
  PLAYER_NAME(m) {
    if (typeof m.name !== 'string') return null;
    return { type: 'PLAYER_NAME', name: cleanName(m.name, LIMITS.nameMax) };
  },
  PLAYER_TOKEN_MOVE(m) {
    const aid = aidOf(m.aid);
    if (aid === BAD || !isId(m.id) || !coord(m.x) || !coord(m.y)) return null;
    const out = { type: 'PLAYER_TOKEN_MOVE', id: m.id, x: m.x, y: m.y };
    if (aid !== undefined) out.aid = aid;
    return out;
  },
  PLAYER_PING(m) {
    const aid = aidOf(m.aid);
    if (aid === BAD || !coord(m.x) || !coord(m.y)) return null;
    const out = { type: 'PLAYER_PING', x: m.x, y: m.y };
    if (aid !== undefined) out.aid = aid;
    return out;
  },
  PLAYER_END_TURN(m) {
    const aid = aidOf(m.aid);
    if (aid === BAD || !isId(m.tokenId)) return null;
    const out = { type: 'PLAYER_END_TURN', tokenId: m.tokenId };
    if (aid !== undefined) out.aid = aid;
    return out;
  },
  AUDIO_LISTEN(m) {
    if (typeof m.enabled !== 'boolean') return null;
    const out = { type: 'AUDIO_LISTEN', enabled: m.enabled, caps: { rtc: false, jbt: false } };
    if (m.caps !== undefined) {
      if (!isPlain(m.caps)) return null;
      out.caps = { rtc: m.caps.rtc === true, jbt: m.caps.jbt === true };
    }
    return out;
  },
  AUDIO_ANSWER(m) {
    if (!isId(m.sid) || !text(m.sdp, 12288)) return null;
    return { type: 'AUDIO_ANSWER', sid: m.sid, sdp: m.sdp };
  },
  AUDIO_STATS(m) {
    if (!isId(m.sid)) return null;
    return loose(m, { type: 'AUDIO_STATS', sid: m.sid });
  },
  // ── GM -> server ──────────────────────────────────────────────────────────
  SCENE(m) {
    const scene = m.scene;
    if (!isPlain(scene)) return null;
    for (const key of ['tokens', 'markers', 'areaEffects']) {
      const list = scene[key];
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.some(item => !isPlain(item))) return null;
    }
    if (scene.fogCells !== undefined && (!Array.isArray(scene.fogCells) || scene.fogCells.some(cell => typeof cell !== 'string'))) return null;
    if (scene.combat !== undefined && scene.combat !== null) {
      if (!isPlain(scene.combat)) return null;
      const entries = scene.combat.entries;
      if (entries !== undefined && (!Array.isArray(entries) || entries.some(entry => !isPlain(entry)))) return null;
    }
    return { type: 'SCENE', scene };
  },
  TABLE_CMD(m) {
    if (!TABLE_OPS.has(m.op)) return null;
    const out = { type: 'TABLE_CMD', op: m.op };
    if (m.device !== undefined) {
      if (!deviceRef(m.device)) return null;
      out.device = m.device;
    }
    if (m.op === 'mode') {
      if (!ADMISSION_MODES.has(m.mode)) return null;
      out.mode = m.mode;
    }
    if (m.op === 'rename') {
      if (typeof m.name !== 'string') return null;
      out.name = cleanName(m.name, LIMITS.nameMax);
    }
    if ((m.op === 'kick' || m.op === 'admit' || m.op === 'deny' || m.op === 'rename') && out.device === undefined) return null;
    return out;
  },
  AUDIO_OFFER(m) {
    if (!(isHex(m.to, 16) || isId(m.to)) || !isId(m.sid) || !text(m.sdp, 12288)) return null;
    return { type: 'AUDIO_OFFER', to: m.to, sid: m.sid, sdp: m.sdp };
  },
  AUDIO_CONTROLS(m) {
    const out = { type: 'AUDIO_CONTROLS' };
    if (m.volume !== undefined) { if (!finite(m.volume)) return null; out.volume = Math.max(0, Math.min(m.volume, 1000)); }
    if (m.muted !== undefined) { if (typeof m.muted !== 'boolean') return null; out.muted = m.muted; }
    return loose(m, out);
  },
  AUDIO_STATUS(m) {
    if (typeof m.active !== 'boolean') return null;
    return loose(m, { type: 'AUDIO_STATUS', active: m.active });
  },
  AUDIO_SELECT(m) {
    if (!Array.isArray(m.settings) || m.settings.length > 64) return null;
    const settings = [];
    for (const item of m.settings) {
      if (!isPlain(item)) return null;
      settings.push(loose(item, {}));
    }
    return { type: 'AUDIO_SELECT', settings };
  },
  AUDIO_FALLBACK(m) {
    if (!(isHex(m.to, 16) || isId(m.to)) || !isId(m.sid)) return null;
    return { type: 'AUDIO_FALLBACK', to: m.to, sid: m.sid, reason: text(m.reason, 64) ? m.reason : '' };
  },
  AUDIO_STOP(m) {
    const out = { type: 'AUDIO_STOP' };
    if (m.to !== undefined) { if (!(isHex(m.to, 16) || isId(m.to))) return null; out.to = m.to; }
    if (m.sid !== undefined) { if (!isId(m.sid)) return null; out.sid = m.sid; }
    return out;
  },
};

/** The largest frame a role may send at all (ws enforces the same number as maxPayload). */
export const roleMax = (role, limits = LIMITS) => (role === 'gm' ? limits.gmMaxPayload : limits.playerMaxPayload);

const fail = code => ({ ok: false, code });

/**
 * @param {'player'|'gm'} role
 * @param {string} body    the frame as text
 * @param {number} [bytes] size of the frame in bytes (defaults to the text length)
 * @param {Set<string>} [extra]  message types an extension registered for this role (checked loosely)
 * @param {object} [options]  { limits, caps }
 * @returns {{ ok: true, type: string, msg: object } | { ok: false, code: 'oversize'|'malformed'|'unknown-type'|'wrong-direction'|'invalid' }}
 */
export function validateFrame(role, body, bytes, extra, options = {}) {
  try {
    const limits = options.limits ?? LIMITS;
    const caps = options.caps ?? TYPE_CAPS;
    if (typeof body !== 'string') return fail('malformed');
    const size = Number.isFinite(bytes) ? bytes : body.length;
    if (size > roleMax(role, limits)) return fail('oversize');
    let parsed;
    try { parsed = JSON.parse(body); } catch { return fail('malformed'); }
    if (!isPlain(parsed) || typeof parsed.type !== 'string' || parsed.type.length === 0 || parsed.type.length > 40) return fail('malformed');
    const type = parsed.type;
    const allowed = role === 'gm' ? GM_TYPES : PLAYER_TYPES;
    const isExtra = Boolean(extra?.has(type));
    if (!allowed.has(type) && !isExtra) {
      return fail(PLAYER_TYPES.has(type) || GM_TYPES.has(type) || SERVER_TO_PLAYER.has(type) || SERVER_TO_GM.has(type) ? 'wrong-direction' : 'unknown-type');
    }
    const cap = Object.hasOwn(caps, type) ? caps[type] : DEFAULT_CAP;
    if (size > cap.max) return fail('oversize');
    const check = Object.hasOwn(VALIDATORS, type) ? VALIDATORS[type] : null;
    const msg = check ? check(parsed) : isExtra ? loose(parsed, { type }) : null;
    if (!msg) return fail('invalid');
    return { ok: true, type, msg };
  } catch {
    return fail('malformed'); // a validator must never be able to take the hub down
  }
}
