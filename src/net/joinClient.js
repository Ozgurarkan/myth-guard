// First-time admission, the browser side (design 4.3 "First join", Appendix A.3 and A.7).
//
//   POST /__realm/join { v, device, name, nonce, how, proof }  ->  { status, srv, srvProof }
//
// The client proves it knows the invite (the secret S from the QR code, or the typed table code), checks that the
// SERVER proves the same thing back (so a rogue access point cannot harvest a device key), and only then derives and keeps
// `dk`. After this, S and dk never travel over the network again.
import { PATHS, PROTOCOL_VERSION, cleanName, isHex } from './protocol.js';
import { inviteKey, isInviteSecret, joinProof, srvProof, deriveDk, normalizeCode, randomHex, safeEqualHex } from './hmac.js';
import { deviceStore } from './deviceStore.js';

/** Why a join did not happen. `code` is machine readable; `message` is fit to show a person. */
export class JoinError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = 'JoinError';
    this.code = code;
    this.status = status;
  }
}

const MESSAGES = {
  'bad-invite': 'That invite link is not valid. Scan the QR code again.',
  'bad-code': 'The table code is not valid. It has 8 letters and digits.',
  'bad-proof': 'The invite or the code was not accepted. Ask the Dungeon Master for a new one.',
  'code-required': 'This table asks for its code or QR code.',
  locked: 'The table is locked.',
  full: 'The table is full.',
  banned: 'Too many wrong tries. Wait a few minutes.',
  rate: 'Too many tries. Wait a moment.',
  'rogue-server': 'This is not the table you were invited to. Check the address.',
  network: 'Could not reach the table.',
  server: 'The table gave an unexpected answer.',
  refused: 'The table refused this device.',
};
const fail = (code, status) => new JoinError(code, MESSAGES[code] ?? code, status);

const INVITE_IN_HASH = /(?:^|[#&?])join=([A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])/;

/** The invite secret inside `#join=<S>` (or `join=<S>`, or a bare S); null when there is none. */
export function parseJoinHash(text) {
  if (typeof text !== 'string') return null;
  if (isInviteSecret(text)) return text;
  const match = INVITE_IN_HASH.exec(text);
  return match ? match[1] : null;
}

/**
 * @param {object} [options]
 * @param {object} [options.store]      a device store (defaults to the shared one)
 * @param {Function} [options.fetchImpl] defaults to the global fetch (looked up at call time)
 * @param {string} [options.url]        any URL of the table page; /__realm/join is resolved against it
 * @param {object} [options.env]        { location, history } for captureInvite (defaults to the globals)
 */
export function createJoinClient({ store = deviceStore, fetchImpl, url, env } = {}) {
  const doFetch = (...args) => (fetchImpl ?? globalThis.fetch)(...args);
  const endpoint = () => new URL(PATHS.join, url ?? globalThis.location?.href).href;
  let inflight = null;

  async function join(how, value) {
    const key = inviteKey(how, how === 'code' ? value : how === 'open' ? undefined : parseJoinHash(value));
    if (!key) throw fail(how === 'code' ? 'bad-code' : 'bad-invite');
    const device = store.ensureDevice();
    const nonce = randomHex(16);
    const body = {
      v: PROTOCOL_VERSION, device, name: cleanName(store.name()), nonce, how,
      proof: joinProof(key, device, nonce),
    };

    let response;
    try {
      response = await doFetch(endpoint(), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin',
      });
    } catch { throw fail('network'); }

    if (!response.ok) {
      let reason = null;
      try { reason = (await response.json())?.error ?? null; } catch { /* generic body */ }
      if (response.status === 429) throw fail('rate', 429);
      if (response.status === 403) throw fail(['bad-proof', 'locked', 'full', 'banned', 'code-required'].includes(reason) ? reason : 'refused', 403);
      throw fail('server', response.status);
    }

    let answer;
    try { answer = await response.json(); } catch { throw fail('server', response.status); }
    if (!answer || !['admitted', 'pending'].includes(answer.status) || !isHex(answer.srv, 16) || !isHex(answer.srvProof, 32)) throw fail('server', response.status);
    // The table must know the secret too. Do not keep (or even derive) anything from a server that does not.
    if (!safeEqualHex(srvProof(key, device, nonce, answer.srv), answer.srvProof)) throw fail('rogue-server');

    store.setDk(deriveDk(key, device, nonce, answer.srv));
    if (how === 'link') store.clearInvite(); // spent: a reload must not join again with a stale secret
    return { status: answer.status, device };
  }

  const client = {
    /** `hash` is `location.hash`, `#join=<S>` or the bare secret. Resolves { status: 'admitted'|'pending', device }. */
    joinWithLink: hash => join('link', hash),
    /** `code` is what the person typed (case, spaces and dashes are ignored). */
    joinWithCode: code => join('code', code),
    /** No invite at all: works when the table does not ask for one. */
    joinOpen: () => join('open'),

    /**
     * Read `#join=<S>` from the address, keep S for this tab only, and remove it from the address bar. Returns S or null.
     * Safe to call on every page load.
     */
    captureInvite() {
      const location = env?.location ?? globalThis.location;
      const secret = parseJoinHash(location?.hash ?? '');
      if (!secret) return null;
      store.setInvite(secret);
      try {
        const history = env?.history ?? globalThis.history;
        history?.replaceState?.(null, '', `${location.pathname ?? ''}${location.search ?? ''}`);
      } catch { /* the secret simply stays visible; it never leaves the browser */ }
      return secret;
    },

    /**
     * Make sure this browser is a member: resolves
     *   { status: 'member' }                  it already holds device + dk (the normal case after the first visit)
     *   { status: 'admitted'|'pending' }      it just joined with the invite kept for this tab
     *   { status: 'needs-invite' }            it has neither: show "Enter the table code"
     * and throws JoinError (locked, full, banned, bad-proof, rate, rogue-server, network, server) otherwise.
     * Concurrent calls share one request.
     */
    ensureJoined() {
      if (inflight) return inflight;
      const job = (async () => {
        if (store.isMember()) return { status: 'member', device: store.device() };
        const invite = store.invite();
        if (!invite) {
          try { return await client.joinOpen(); } catch (error) {
            if (error.code === 'code-required') return { status: 'needs-invite' };
            throw error;
          }
        }
        try { return await client.joinWithLink(invite); } catch (error) {
          if (error.code === 'bad-proof') store.clearInvite(); // rotated or wrong: asking again with it is pointless
          throw error;
        }
      })();
      inflight = job;
      const done = () => { if (inflight === job) inflight = null; };
      job.then(done, done);
      return job;
    },
  };
  return client;
}

export { normalizeCode };
