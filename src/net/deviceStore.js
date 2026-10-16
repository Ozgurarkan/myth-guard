// This browser's identity at the table (design 4.3, 4.5).
//
//   device   16 random bytes (32 hex), generated here, kept in localStorage      (who this phone is)
//   dk       64 hex, derived while joining, kept in localStorage                 (the key that proves it)
//   name     the display name, kept under the key the app has always used        ('realm-player-name')
//   aid      action ids for moves / end-turn, kept in sessionStorage             (monotonic, unique per tab)
//   invite   the invite secret S from the QR link, kept in sessionStorage        (never in localStorage)
//
// Storage can be missing or can throw (private mode, blocked cookies, quota, Node): every read and write is wrapped, and
// an in-memory copy keeps this visit working. Nothing here needs crypto.subtle.
import { isHex, isId, cleanName } from './protocol.js';
import { randomHex, isInviteSecret } from './hmac.js';

export const STORAGE_KEYS = Object.freeze({
  device: 'rf3-device',
  dk: 'rf3-dk',
  name: 'realm-player-name',   // unchanged from broadcast.js
  aid: 'rf3-aid',
  invite: 'rf3-invite',
});

/** `globalThis[name]`, or null when it does not exist or merely touching it throws (Node warns, privacy modes throw). */
function globalStorage(name) {
  try {
    // Node (26) has an experimental localStorage getter that prints a warning when merely touched; a browser always has a window.
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    if (descriptor && !('value' in descriptor) && typeof globalThis.window === 'undefined') return null;
    const storage = globalThis[name];
    return storage && typeof storage.getItem === 'function' ? storage : null;
  } catch { return null; }
}

/** A storage with an in-memory shadow: writes always land in memory, and in the real storage when it works. */
function resilient(getStorage) {
  const memory = new Map();
  return {
    get(key) {
      try {
        const storage = getStorage();
        const value = storage ? storage.getItem(key) : null;
        if (value !== null && value !== undefined) return value;
      } catch { /* fall back to memory */ }
      return memory.has(key) ? memory.get(key) : null;
    },
    set(key, value) {
      memory.set(key, value);
      try { getStorage()?.setItem(key, value); } catch { /* memory still has it */ }
    },
    remove(key) {
      memory.delete(key);
      try { getStorage()?.removeItem(key); } catch { /* ignore */ }
    },
  };
}

/**
 * @param {{ local?: Storage|null, session?: Storage|null, random?: (bytes:number)=>string }} [options]
 *   `local` / `session` default to the globals (looked up lazily on every use); pass `null` to force memory only.
 */
export function createDeviceStore({ local, session, random = randomHex } = {}) {
  const pick = (given, name) => (given === undefined ? () => globalStorage(name) : () => given);
  const persistent = resilient(pick(local, 'localStorage'));
  const tab = resilient(pick(session, 'sessionStorage'));

  const store = {
    /** The device id, or null if this browser has never joined. */
    device() {
      const value = persistent.get(STORAGE_KEYS.device);
      return isHex(value, 16) ? value : null;
    },
    /** The device id, created and saved on first use. */
    ensureDevice() {
      const existing = store.device();
      if (existing) return existing;
      const created = random(16);
      persistent.set(STORAGE_KEYS.device, created);
      return created;
    },
    /** The per-device key, or null (never joined, or forgotten). */
    dk() {
      const value = persistent.get(STORAGE_KEYS.dk);
      return isHex(value, 32) ? value : null;
    },
    setDk(dk) {
      if (!isHex(dk, 32)) throw new TypeError('dk must be 64 lowercase hex characters');
      persistent.set(STORAGE_KEYS.dk, dk);
    },
    /** True when this browser holds everything a reconnect needs. */
    isMember() { return !!(store.device() && store.dk()); },
    /** Throw away the identity (kicked, denied, table reset). The name stays: it is the person's, not the table's. */
    forget() {
      persistent.remove(STORAGE_KEYS.device);
      persistent.remove(STORAGE_KEYS.dk);
      tab.remove(STORAGE_KEYS.aid);
      tab.remove(STORAGE_KEYS.invite);
    },
    /** Drop only the key (the server no longer knows it) but keep the device id. */
    forgetKey() { persistent.remove(STORAGE_KEYS.dk); },

    name() { return persistent.get(STORAGE_KEYS.name) || ''; },
    setName(name) { persistent.set(STORAGE_KEYS.name, cleanName(String(name ?? ''))); },

    invite() {
      const value = tab.get(STORAGE_KEYS.invite);
      return isInviteSecret(value) ? value : null;
    },
    setInvite(secret) {
      if (!isInviteSecret(secret)) throw new TypeError('not an invite secret');
      tab.set(STORAGE_KEYS.invite, secret);
    },
    clearInvite() { tab.remove(STORAGE_KEYS.invite); },

    /**
     * A fresh action id: `<tab prefix>-<counter>`. The prefix is random per tab and the counter is kept in
     * sessionStorage, so a reload continues the sequence and a second tab can never repeat an id the server remembers.
     * Always passes `isId` (letters, digits, '-'; at most 64 characters).
     */
    nextAid() {
      let prefix = null;
      let counter = 0;
      const saved = /^([0-9a-f]{6}):(\d{1,12})$/.exec(tab.get(STORAGE_KEYS.aid) ?? '');
      if (saved) { prefix = saved[1]; counter = Number(saved[2]); }
      else prefix = random(3);
      counter += 1;
      tab.set(STORAGE_KEYS.aid, `${prefix}:${counter}`);
      const aid = `${prefix}-${counter.toString(36)}`;
      if (!isId(aid)) throw new Error('unreachable: malformed action id');
      return aid;
    },
  };
  return store;
}

/** The store the app uses. Created lazily so importing this file never touches storage. */
let shared = null;
export const deviceStore = new Proxy({}, {
  get(_target, property) {
    shared ??= createDeviceStore();
    const value = shared[property];
    return typeof value === 'function' ? value.bind(shared) : value;
  },
});

/** The device id of this browser (created on first use). Audio code reads this instead of its own id. */
export const device = () => deviceStore.ensureDevice();
