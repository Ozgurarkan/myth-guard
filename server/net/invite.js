// The invite: the secret S in the QR link and the typed table code C (design 3.6, 4.3).
//   S has no expiry; it dies when the GM rotates.
//   C is accepted only after the GM looked at the invite dialog and for 10 minutes after the last look
//   (`markShown`), and it changes on every lock/unlock and rotate. That bounds online guessing of a 40-bit code.
import { LIMITS } from '../../src/net/protocol.js';
import { inviteKey, joinProof, normalizeCode, randomCode, randomSecret, safeEqual } from './crypto.js';

/** @param options.store  tableStore;  @param options.clock  { now() } */
export function createInvite({ store, clock, limits = LIMITS }) {
  let freshUntil = 0; // ms; the code is not accepted before the GM has looked at it
  const invite = () => store.data.invite;

  const api = {
    /** What the GM dialog shows. */
    current: () => ({ secret: invite().secret, code: invite().code, codeFresh: clock.now() < freshUntil, freshUntil }),
    codeFresh: () => clock.now() < freshUntil,
    /** The GM looked at the invite (opened the dialog or fetched /__realm/info): the code is valid for 10 more minutes. */
    markShown() { freshUntil = clock.now() + limits.codeFreshAfterCloseMs; },
    /** New secret AND new code: every old QR code and every old typed code stops working. */
    rotate() {
      invite().secret = randomSecret();
      invite().code = randomCode();
      invite().rotatedAt = clock.now();
      freshUntil = clock.now() + limits.codeFreshAfterCloseMs;
      store.save();
    },
    /** New code only (lock/unlock): the QR link keeps working. */
    rotateCode() {
      invite().code = randomCode();
      freshUntil = 0;
      store.save();
    },
    /**
     * Checks the join proof of design 4.3. Returns `{ ok: true, key }` (the HMAC key that srvProof and dk use) or
     * `{ ok: false, reason: 'bad-proof' | 'stale-code' }`. A malformed secret or code is just a bad proof.
     */
    verify(how, device, nonce, proof) {
      let key;
      if (how === 'open') key = inviteKey('open');
      else if (how === 'link') key = inviteKey('link', invite().secret);
      else if (how === 'code') {
        if (!api.codeFresh()) {
          // Still do the work, so a stale code cannot be told apart from a wrong one by timing.
          joinProof(`code:${invite().code}`, device, nonce);
          return { ok: false, reason: 'stale-code' };
        }
        key = inviteKey('code', invite().code);
      }
      if (!key) return { ok: false, reason: 'bad-proof' };
      return safeEqual(joinProof(key, device, nonce), proof) ? { ok: true, key } : { ok: false, reason: 'bad-proof' };
    },
    /** `http://<address>:<port>/player.html#join=<S>` */
    urlFor: (address, port) => `http://${address}${port ? `:${port}` : ''}/player.html#join=${invite().secret}`,
    normalizeCode,
  };
  return api;
}
