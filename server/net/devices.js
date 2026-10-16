// The device registry (design 3.6, 4.3): who has joined, with which key, and in which state.
//   pending   asked to join in `ask` mode, waiting for the GM (no state, no images)
//   admitted  a member of the table
//   revoked   kicked: its key is deleted and the same device id can never come back (a tombstone is kept)
// The records live in tableStore.data.devices. Nothing here returns a key to a caller outside the server:
// `list()` is the only view that leaves this module and it has no `dk`.
import { LIMITS, cleanName } from '../../src/net/protocol.js';
import { cookieMac, playerIdOf, safeEqual } from './crypto.js';

const MAX_TOMBSTONES = 256;
const DENY_COOLDOWN_MS = 60_000;

/**
 * @param {object} options
 * @param options.store  tableStore (already loaded or loadable)
 * @param options.clock  { now, setTimeout, clearTimeout }
 * @param {(event: {kind: string, device?: string}) => void} [options.emit]  told about every change
 * @param {object} [options.limits]
 */
export function createDevices({ store, clock, emit = () => {}, limits = LIMITS }) {
  const table = () => store.data;
  const registry = () => table().devices;
  const timers = new Map();      // device -> pending-expiry timer
  const cooldown = new Map();    // device -> end of the "recently denied" pause

  const maxAdmitted = () => table().limits.maxAdmittedDevices;
  const maxPending = () => table().limits.maxPendingDevices;
  const count = status => {
    let n = 0;
    for (const record of Object.values(registry())) if (record.status === status) n += 1;
    return n;
  };
  const save = () => store.save();

  const disarm = device => {
    const timer = timers.get(device);
    if (timer !== undefined) clock.clearTimeout(timer);
    timers.delete(device);
  };
  const arm = (device, record) => {
    disarm(device);
    const wait = Math.max(0, record.createdAt + limits.pendingTtlMs - clock.now());
    timers.set(device, clock.setTimeout(() => {
      timers.delete(device);
      if (registry()[device]?.status !== 'pending') return;
      delete registry()[device];
      save();
      emit({ kind: 'deny', device, reason: 'timeout' });
    }, wait));
  };

  const pruneTombstones = () => {
    const dead = Object.entries(registry()).filter(([, record]) => record.status === 'revoked');
    if (dead.length <= MAX_TOMBSTONES) return;
    dead.sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [device] of dead.slice(0, dead.length - MAX_TOMBSTONES)) delete registry()[device];
  };

  const api = {
    /** The live record (do not mutate it from outside) or null. */
    find(device) {
      return typeof device === 'string' ? registry()[device] ?? null : null;
    },
    count,
    get maxAdmitted() { return maxAdmitted(); },
    get maxPending() { return maxPending(); },

    /**
     * Adds a new device. `status` is 'pending' or 'admitted'.
     * Returns `{ ok: true, status }` or `{ ok: false, reason: 'full' | 'revoked' | 'exists' | 'cooldown' }`.
     */
    register({ device, dk, name, label, ip, how, nonce, srv, status }) {
      const existing = registry()[device];
      if (existing) return { ok: false, reason: existing.status === 'revoked' ? 'revoked' : 'exists' };
      if ((cooldown.get(device) ?? 0) > clock.now()) return { ok: false, reason: 'cooldown' };
      const full = status === 'pending'
        ? count('pending') >= maxPending() || count('admitted') >= maxAdmitted()
        : count('admitted') >= maxAdmitted();
      if (full) return { ok: false, reason: 'full' };
      const record = {
        dk, name: cleanName(name, limits.nameMax), label: String(label || '').slice(0, 80), ip: String(ip || '').slice(0, 64),
        how: how === 'code' ? 'code' : 'link', status, createdAt: clock.now(), lastSeen: clock.now(), joinNonce: nonce, srv,
      };
      registry()[device] = record;
      save();
      if (status === 'pending') arm(device, record);
      emit({ kind: 'join', device, status });
      return { ok: true, status };
    },

    /** Pending -> admitted. False when the device is not pending or the table is full. */
    admit(device) {
      const record = registry()[device];
      if (!record || record.status !== 'pending' || count('admitted') >= maxAdmitted()) return false;
      disarm(device);
      record.status = 'admitted';
      save();
      emit({ kind: 'admit', device });
      return true;
    },
    /** Pending -> gone (it may ask again after a short pause). False when the device is not pending. */
    deny(device) {
      const record = registry()[device];
      if (!record || record.status !== 'pending') return false;
      disarm(device);
      delete registry()[device];
      if (cooldown.size >= MAX_TOMBSTONES) cooldown.delete(cooldown.keys().next().value);
      cooldown.set(device, clock.now() + DENY_COOLDOWN_MS);
      save();
      emit({ kind: 'deny', device });
      return true;
    },
    /** Kick: the key is deleted and the device id is refused for good. False when unknown or already revoked. */
    revoke(device) {
      const record = registry()[device];
      if (!record || record.status === 'revoked') return false;
      disarm(device);
      record.status = 'revoked';
      record.dk = null;
      record.srv = null;
      record.joinNonce = null;
      pruneTombstones();
      save();
      emit({ kind: 'kick', device });
      return true;
    },
    rename(device, name) {
      const record = registry()[device];
      if (!record || record.status === 'revoked') return false;
      record.name = cleanName(name, limits.nameMax);
      save();
      emit({ kind: 'rename', device });
      return true;
    },
    /** Remembers when and from where a device was last seen (kept in memory; written with the next save). */
    touch(device, { ip, label } = {}) {
      const record = registry()[device];
      if (!record) return;
      record.lastSeen = clock.now();
      if (ip) record.ip = String(ip).slice(0, 64);
      if (label) record.label = String(label).slice(0, 80);
    },

    playerIdOf: device => playerIdOf(table().serverSecret, device),
    /** `rf-d` cookie value for a device. */
    cookieValue: device => `${device}.${cookieMac(table().serverSecret, device)}`,
    /** The device id inside a valid `rf-d` cookie value, or null (bad shape, bad MAC). Does not check the status. */
    deviceFromCookie(value) {
      const match = /^([0-9a-f]{32})\.([0-9a-f]{32})$/.exec(typeof value === 'string' ? value : '');
      if (!match) return null;
      return safeEqual(match[2], cookieMac(table().serverSecret, match[1])) ? match[1] : null;
    },

    /** Everything the GM may see about the devices, without keys. Newest first. */
    list() {
      return Object.entries(registry())
        .filter(([, record]) => record.status !== 'revoked')
        .map(([device, record]) => ({
          device, playerId: api.playerIdOf(device), name: record.name, label: record.label, ip: record.ip,
          status: record.status, how: record.how, createdAt: record.createdAt, lastSeen: record.lastSeen,
        }))
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    /** Starts the expiry timers of devices loaded as pending (call once after load). */
    start() {
      for (const [device, record] of Object.entries(registry())) if (record.status === 'pending') arm(device, record);
    },
    close() { for (const device of [...timers.keys()]) disarm(device); },
  };
  return api;
}
