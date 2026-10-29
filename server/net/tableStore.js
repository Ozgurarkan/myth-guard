// table.json: everything that must survive a server restart (design 4.3, 4.13, test A16).
//   serverSecret  never sent anywhere; signs the image cookie and derives playerIds
//   invite        the QR secret S and the typed code C
//   mode          open | ask | locked
//   devices       the registry, with each device's key `dk`
//
// The file is written atomically (temp file + rename). A missing file starts a new table. A damaged file is moved
// aside, a new table is started and a line is logged: it never crashes the server and it never half-loads.
// If the disk cannot be written the table keeps running in memory (`persisted` is false, shown in /diag).
import fs from 'node:fs';
import path from 'node:path';
import { ADMISSION_MODES, LIMITS, isHex } from '../../src/net/protocol.js';
import { randomCode, randomHex, randomSecret, isInviteSecret, normalizeCode } from './crypto.js';

export const TABLE_VERSION = 1;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const STATUSES = new Set(['pending', 'admitted', 'revoked']);

const isNumber = value => Number.isFinite(value);
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

/** A fresh table. */
export function freshTable(clock) {
  return {
    version: TABLE_VERSION,
    serverSecret: randomHex(32),
    mode: 'open',
    modeBeforeLock: 'open',
    codeRequired: false,
    invite: { secret: randomSecret(), code: randomCode(), rotatedAt: clock.now() },
    limits: { maxAdmittedDevices: LIMITS.maxAdmittedDevices, maxPendingDevices: LIMITS.maxPendingDevices },
    devices: Object.create(null),
  };
}

/**
 * Checks a parsed file and returns a clean table (unknown fields dropped, bad devices skipped) or null when the file
 * is not usable as a whole. Returns `{ table, dropped }`.
 */
export function sanitizeTable(raw, clock) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== TABLE_VERSION) return null;
  if (!isHex(raw.serverSecret, 32)) return null;
  if (!ADMISSION_MODES.has(raw.mode)) return null;
  if (!raw.invite || !isInviteSecret(raw.invite.secret) || normalizeCode(raw.invite.code) !== raw.invite.code) return null;
  if (!raw.devices || typeof raw.devices !== 'object' || Array.isArray(raw.devices)) return null;
  const table = {
    version: TABLE_VERSION,
    serverSecret: raw.serverSecret,
    mode: raw.mode,
    modeBeforeLock: ADMISSION_MODES.has(raw.modeBeforeLock) && raw.modeBeforeLock !== 'locked' ? raw.modeBeforeLock : 'open',
    codeRequired: raw.codeRequired === true,
    invite: { secret: raw.invite.secret, code: raw.invite.code, rotatedAt: isNumber(raw.invite.rotatedAt) ? raw.invite.rotatedAt : clock.now() },
    limits: {
      maxAdmittedDevices: clampInt(raw.limits?.maxAdmittedDevices, 1, 64, LIMITS.maxAdmittedDevices),
      maxPendingDevices: clampInt(raw.limits?.maxPendingDevices, 1, 16, LIMITS.maxPendingDevices),
    },
    devices: Object.create(null),
  };
  let dropped = 0;
  for (const [device, entry] of Object.entries(raw.devices)) {
    const ok = isHex(device, 16) && entry && typeof entry === 'object' && STATUSES.has(entry.status)
      && (entry.status === 'revoked' ? entry.dk == null : isHex(entry.dk, 32));
    if (!ok) { dropped += 1; continue; }
    table.devices[device] = {
      dk: entry.status === 'revoked' ? null : entry.dk,
      name: text(entry.name, 200),
      label: text(entry.label, 80),
      ip: text(entry.ip, 64),
      how: entry.how === 'code' ? 'code' : 'link',
      status: entry.status,
      createdAt: isNumber(entry.createdAt) ? entry.createdAt : clock.now(),
      lastSeen: isNumber(entry.lastSeen) ? entry.lastSeen : 0,
      joinNonce: isHex(entry.joinNonce, 16) ? entry.joinNonce : null,
      srv: isHex(entry.srv, 16) ? entry.srv : null,
    };
  }
  return { table, dropped };
}

const clampInt = (value, min, max, fallback) => (Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback);

const sleepSync = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* not allowed here: just retry */ } };

/**
 * @param {object} options
 * @param {string|null} options.file  absolute path of table.json; null keeps everything in memory
 * @param {{now(): number}} options.clock
 * @param {(line: string) => void} [options.log]
 */
export function createTableStore({ file, clock, log = () => {} }) {
  let data = null;
  let persisted = Boolean(file);
  let loadResult = null;

  const writeAtomic = json => {
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, json, { mode: 0o600 });
    let lastError;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { fs.renameSync(temp, file); return; } catch (error) { lastError = error; sleepSync(15 * (attempt + 1)); }
    }
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw lastError;
  };

  const store = {
    /** Loads (once) and returns `{ fresh, corrupt, dropped }`. Safe to call again: it returns the first result. */
    load() {
      if (loadResult) return loadResult;
      let corrupt = false;
      let dropped = 0;
      let table = null;
      if (file && fs.existsSync(file)) {
        try {
          const stat = fs.statSync(file);
          if (stat.size > MAX_FILE_BYTES) throw new Error('file is too large');
          const checked = sanitizeTable(JSON.parse(fs.readFileSync(file, 'utf8')), clock);
          if (!checked) throw new Error('not a table file');
          ({ table, dropped } = checked);
        } catch (error) {
          corrupt = true;
          const aside = `${file}.corrupt-${clock.now()}`;
          try { fs.renameSync(file, aside); } catch { /* the new file will overwrite it */ }
          log(`table.json could not be read (${error.message}); started a new table. The old file was kept as ${path.basename(aside)}. Players must join again.`);
        }
      }
      if (dropped) log(`table.json: ${dropped} unusable device entr${dropped === 1 ? 'y was' : 'ies were'} ignored`);
      const fresh = !table;
      data = table ?? freshTable(clock);
      loadResult = { fresh, corrupt, dropped };
      if (fresh) store.save();
      return loadResult;
    },
    /** Writes the table now (atomic). Returns false and flips `persisted` when the disk refuses. */
    save() {
      if (!file || !data) return false;
      try {
        writeAtomic(JSON.stringify(data));
        persisted = true;
        return true;
      } catch (error) {
        if (persisted) log(`table.json cannot be written (${error.code || error.message}); the table continues in memory only`);
        persisted = false;
        return false;
      }
    },
    get data() {
      if (!data) store.load();
      return data;
    },
    get persisted() { return persisted; },
    file,
  };
  return store;
}
