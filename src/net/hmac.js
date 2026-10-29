/**
 * Pure-JS HMAC-SHA256 and the exact proof formulas of design 4.3.
 *
 * Works in Node and in a NON-secure browser origin (http://192.168.x.x), where crypto.subtle does not exist: the hash is
 * @noble/hashes, the only randomness is crypto.getRandomValues (which exists on non-secure origins).
 * Every formula lives in this file and nowhere else. See "Appendix A - frozen protocol decisions (WP1)" in
 * docs/network-design.md for every encoding decision.
 *
 * Conventions (frozen):
 *  - Everything that crosses the wire is a lowercase hex string (device, nonce, srv, proofs, dk) except the invite secret
 *    S (22 base64url characters) and the typed table code (8 characters of CODE_ALPHABET).
 *  - A key given as a string is used as the UTF-8 bytes of that string. So the key dk is the 64-character hex STRING,
 *    and S is the 22-character base64url STRING, not their decoded bytes.
 *  - hmac(key, ...parts) authenticates the parts joined with a single \0 byte; string parts may not contain \0.
 */
import { hmac as nobleHmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { CODE_ALPHABET, CODE_LENGTH, ROLES, isHex } from './protocol.js';

const encoder = new TextEncoder();
const HEX = '0123456789abcdef';

const toHex = bytes => {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  return out;
};

const toBytes = (value, what) => {
  if (typeof value === 'string') return encoder.encode(value);
  if (value instanceof Uint8Array) return value;
  throw new TypeError(`hmac: ${what} must be a string or a Uint8Array`);
};

/** HMAC-SHA256 as 64 lowercase hex characters. Parts are joined with \0 (strings containing \0 are refused). */
export const hmac = (key, ...parts) => {
  const keyBytes = toBytes(key, 'key');
  const chunks = parts.map((part, index) => {
    if (typeof part === 'string' && part.includes('\0')) throw new TypeError(`hmac: part ${index} contains a NUL character`);
    return toBytes(part, `part ${index}`);
  });
  let length = Math.max(0, chunks.length - 1);
  for (const chunk of chunks) length += chunk.length;
  const message = new Uint8Array(length);
  let at = 0;
  chunks.forEach((chunk, index) => {
    if (index > 0) message[at++] = 0;
    message.set(chunk, at);
    at += chunk.length;
  });
  return toHex(nobleHmac(sha256, keyBytes, message));
};

/** `bytes` random bytes as lowercase hex (2 * bytes characters). */
export const randomHex = bytes => {
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > 65536) throw new RangeError('randomHex: bytes must be an integer from 1 to 65536');
  const out = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(out);
  return toHex(out);
};

/** Constant-time comparison of two strings (no early exit on the first difference). Non-strings are never equal. */
export const safeEqualHex = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
};

// ---------------------------------------------------------------------------------------------------------------------
// Invite material
// ---------------------------------------------------------------------------------------------------------------------

const base64url = bytes => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** A new invite secret S: 16 random bytes as 22 base64url characters (the text after `#join=`). */
export const randomSecret = () => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return base64url(bytes);
};

export const isInviteSecret = value => typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value);

/** A new table code C: 8 characters of CODE_ALPHABET, drawn without modulo bias. */
export const randomCode = () => {
  let out = '';
  const limit = 256 - (256 % CODE_ALPHABET.length); // 248: bytes at or above this are rejected
  const buffer = new Uint8Array(32);
  while (out.length < CODE_LENGTH) {
    globalThis.crypto.getRandomValues(buffer);
    for (const byte of buffer) {
      if (byte < limit && out.length < CODE_LENGTH) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }
  }
  return out;
};

/**
 * Canonical form of a typed table code: ASCII letters upper-cased, whitespace and dashes removed. Returns the 8
 * canonical characters, or null when the result is not exactly 8 characters of CODE_ALPHABET (that includes I, L, O,
 * 0 and 1: ambiguous letters are NOT mapped, they are simply invalid). Never throws.
 */
export const normalizeCode = input => {
  if (typeof input !== 'string' || input.length > 64) return null;
  const text = input.replace(/[\s\-‐-―−]+/g, '').replace(/[a-z]/g, letter => letter.toUpperCase());
  if (text.length !== CODE_LENGTH) return null;
  for (const char of text) if (!CODE_ALPHABET.includes(char)) return null;
  return text;
};

/**
 * The HMAC key for an invite: how 'link' -> S itself (22 base64url characters); how 'code' -> 'code:' + normalized C.
 * Returns null when the value is malformed (never throws on user input).
 */
export const inviteKey = (how, value) => {
  if (how === 'link') return isInviteSecret(value) ? value : null;
  if (how === 'code') {
    const code = normalizeCode(value);
    return code ? `code:${code}` : null;
  }
  // Entry without a code (the table does not ask for one): the key is public, so it proves nothing, but every later step is unchanged.
  if (how === 'open') return 'open:table';
  return null;
};

// ---------------------------------------------------------------------------------------------------------------------
// The formulas of design 4.3. Inputs are validated (TypeError): validate attacker-supplied values with isHex() first.
// ---------------------------------------------------------------------------------------------------------------------

const need = (ok, message) => { if (!ok) throw new TypeError(message); };
const needKey = key => need((typeof key === 'string' && key.length > 0) || (key instanceof Uint8Array && key.length > 0), 'key must be a non-empty string or Uint8Array');
const needIds = (device, nonce) => {
  need(isHex(device, 16), 'device must be 32 lowercase hex characters');
  need(isHex(nonce, 16), 'nonce must be 32 lowercase hex characters');
};

/** First join, client -> server: HMAC(key, "rf3-join" \0 device \0 nonce). */
export const joinProof = (key, device, nonce) => {
  needKey(key); needIds(device, nonce);
  return hmac(key, 'rf3-join', device, nonce);
};

/** First join, server -> client: HMAC(key, "rf3-srv" \0 device \0 nonce \0 srv). Proves the table knows S (or the code). */
export const srvProof = (key, device, nonce, srv) => {
  needKey(key); needIds(device, nonce);
  need(isHex(srv, 16), 'srv must be 32 lowercase hex characters');
  return hmac(key, 'rf3-srv', device, nonce, srv);
};

/** Per-device key, 64 lowercase hex characters: HMAC(key, "rf3-dk" \0 device \0 nonce \0 srv). Used afterwards as a STRING key. */
export const deriveDk = (key, device, nonce, srv) => {
  needKey(key); needIds(device, nonce);
  need(isHex(srv, 16), 'srv must be 32 lowercase hex characters');
  return hmac(key, 'rf3-dk', device, nonce, srv);
};

/** Every WebSocket connection: HMAC(dk, "rf3-ws" \0 device \0 nonce \0 role); role is 'player' or 'gm'. */
export const wsProof = (dk, device, nonce, role) => {
  need(isHex(dk, 32), 'dk must be 64 lowercase hex characters');
  needIds(device, nonce);
  need(ROLES.has(role), "role must be 'player' or 'gm'");
  return hmac(dk, 'rf3-ws', device, nonce, role);
};

/** Cookie value for image requests: `<device>.<first 16 bytes of HMAC(serverSecret, "cookie" \0 device) as 32 hex>`. */
export const cookieMac = (serverSecret, device) => {
  needKey(serverSecret);
  need(isHex(device, 16), 'device must be 32 lowercase hex characters');
  return hmac(serverSecret, 'cookie', device).slice(0, 32);
};

/** playerId shown to other players: first 12 bytes (24 hex) of HMAC(serverSecret, "pid" \0 device). */
export const playerIdOf = (serverSecret, device) => {
  needKey(serverSecret);
  need(isHex(device, 16), 'device must be 32 lowercase hex characters');
  return hmac(serverSecret, 'pid', device).slice(0, 24);
};
