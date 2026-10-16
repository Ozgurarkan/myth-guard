// The only place the server computes or compares proofs. Every formula lives in src/net/hmac.js (shared with the
// phones, frozen by WP1); this module re-exports them under the names the design uses (4.8) and adds nothing else
// that touches secrets, so there is one thing to review.
import {
  hmac, randomHex, safeEqualHex, deriveDk, joinProof, srvProof, wsProof, cookieMac, playerIdOf,
  inviteKey, randomSecret, randomCode, normalizeCode, isInviteSecret,
} from '../../src/net/hmac.js';

export {
  hmac, randomHex, deriveDk, joinProof, srvProof, wsProof, cookieMac, playerIdOf,
  inviteKey, randomSecret, randomCode, normalizeCode, isInviteSecret,
};

/** Constant-time comparison (no early exit on the first differing character). Non-strings are never equal. */
export const safeEqual = safeEqualHex;
