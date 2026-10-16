/**
 * IndexedDB persistence for maps, token presets, token categories,
 * net architectures, the handout image library and the character-sheet PDFs.
 */

const DB_NAME      = 'nightcity-grid-v1';
const DB_VER       = 8;
const STORE        = 'maps';
const PRESET_STORE = 'token_presets';
const CAT_STORE    = 'token_categories';
const NET_STORE    = 'nets';
const IMG_STORE    = 'handouts';
const SHEET_STORE  = 'sheets';

// ── Open / upgrade ────────────────────────────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('savedAt', 'savedAt');
      }
      if (!db.objectStoreNames.contains(PRESET_STORE)) {
        const ps = db.createObjectStore(PRESET_STORE, { keyPath: 'id', autoIncrement: true });
        ps.createIndex('savedAt', 'savedAt');
      }
      if (!db.objectStoreNames.contains(CAT_STORE)) {
        const cs = db.createObjectStore(CAT_STORE, { keyPath: 'id', autoIncrement: true });
        cs.createIndex('name', 'name', { unique: true });
        cs.add({ name: 'PC',  savedAt: Date.now() });
        cs.add({ name: 'NPC', savedAt: Date.now() });
      }
      if (!db.objectStoreNames.contains(NET_STORE)) {
        const ns = db.createObjectStore(NET_STORE, { keyPath: 'id', autoIncrement: true });
        ns.createIndex('savedAt', 'savedAt');
      }
      if (!db.objectStoreNames.contains(IMG_STORE)) {
        const is = db.createObjectStore(IMG_STORE, { keyPath: 'id', autoIncrement: true });
        is.createIndex('savedAt', 'savedAt');
      }
      if (!db.objectStoreNames.contains(SHEET_STORE)) {
        const ss = db.createObjectStore(SHEET_STORE, { keyPath: 'id', autoIncrement: true });
        ss.createIndex('savedAt', 'savedAt');
      }
      for (const name of ['quests', 'npcs', 'plans']) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = (e) => { const db = e.target.result; db.onversionchange = () => db.close(); resolve(db); };
    req.onerror   = (e) => reject(e.target.error);
  });
}

function libraryStore(kind) {
  if (!['quests', 'npcs', 'plans'].includes(kind)) throw new Error('Unknown library');
  return kind;
}
export async function dbListLibrary(kind) {
  const db = await openDB();
  try { return (await run(db.transaction(libraryStore(kind)).objectStore(kind).getAll())).sort((a, b) => b.updatedAt - a.updatedAt); }
  finally { db.close(); }
}
export async function dbSaveLibrary(kind, record) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(libraryStore(kind), 'readwrite');
      const request = tx.objectStore(kind).put({ ...record, updatedAt: Date.now() });
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Could not save record'));
    });
  } finally { db.close(); }
}
export async function dbDeleteLibrary(kind, id) {
  const db = await openDB();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(kind === 'npcs' ? ['npcs', 'quests'] : [libraryStore(kind)], 'readwrite');
      tx.objectStore(kind).delete(id);
      if (kind === 'npcs') {
        const quests = tx.objectStore('quests');
        const request = quests.getAll();
        request.onsuccess = () => { for (const quest of request.result) {
          if (quest.npcIds?.includes(id)) quests.put({ ...quest, npcIds: quest.npcIds.filter(n => n !== id) });
        } };
      }
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Could not delete record'));
    });
  } finally { db.close(); }
}

function run(req) {
  return new Promise((res, rej) => {
    req.onsuccess = (e) => res(e.target.result);
    req.onerror   = (e) => rej(e.target.error);
  });
}

// ── Maps ──────────────────────────────────────────────────────────────────────

export async function dbSaveMap(data) {
  const db    = await openDB();
  const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
  return run(data.id ? store.put(data) : store.add(data));
}

export async function dbListMaps() {
  const db    = await openDB();
  const store = db.transaction(STORE, 'readonly').objectStore(STORE);
  const all   = await run(store.getAll());
  return all.sort((a, b) => b.savedAt - a.savedAt);
}

export async function dbGetMap(id) {
  const db    = await openDB();
  const store = db.transaction(STORE, 'readonly').objectStore(STORE);
  return run(store.get(id));
}

export async function dbDeleteMap(id) {
  const db    = await openDB();
  const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
  return run(store.delete(id));
}

// ── Token Presets ─────────────────────────────────────────────────────────────

export async function dbSavePreset(data) {
  const db    = await openDB();
  const store = db.transaction(PRESET_STORE, 'readwrite').objectStore(PRESET_STORE);
  return run(data.id ? store.put(data) : store.add(data));
}

export async function dbListPresets() {
  const db    = await openDB();
  const store = db.transaction(PRESET_STORE, 'readonly').objectStore(PRESET_STORE);
  const all   = await run(store.getAll());
  return all.sort((a, b) => b.savedAt - a.savedAt);
}

export async function dbDeletePreset(id) {
  const db    = await openDB();
  const store = db.transaction(PRESET_STORE, 'readwrite').objectStore(PRESET_STORE);
  return run(store.delete(id));
}

// ── Token Categories ──────────────────────────────────────────────────────────

export async function dbSaveCategory(data) {
  const db    = await openDB();
  const store = db.transaction(CAT_STORE, 'readwrite').objectStore(CAT_STORE);
  return run(data.id ? store.put(data) : store.add(data));
}

export async function dbListCategories() {
  const db    = await openDB();
  const store = db.transaction(CAT_STORE, 'readonly').objectStore(CAT_STORE);
  const all   = await run(store.getAll());
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

export async function dbDeleteCategory(id) {
  const db    = await openDB();
  const store = db.transaction(CAT_STORE, 'readwrite').objectStore(CAT_STORE);
  return run(store.delete(id));
}

// ── Net Architectures ─────────────────────────────────────────────────────────

export async function dbSaveNet(data) {
  const db    = await openDB();
  const store = db.transaction(NET_STORE, 'readwrite').objectStore(NET_STORE);
  return run(data.id ? store.put(data) : store.add(data));
}

export async function dbListNets() {
  const db    = await openDB();
  const store = db.transaction(NET_STORE, 'readonly').objectStore(NET_STORE);
  const all   = await run(store.getAll());
  return all.sort((a, b) => b.savedAt - a.savedAt);
}

export async function dbDeleteNet(id) {
  const db    = await openDB();
  const store = db.transaction(NET_STORE, 'readwrite').objectStore(NET_STORE);
  return run(store.delete(id));
}

// ── Handout images (image library) ────────────────────────────────────────────

export async function dbSaveHandout(data) {
  const db    = await openDB();
  const store = db.transaction(IMG_STORE, 'readwrite').objectStore(IMG_STORE);
  return run(data.id ? store.put(data) : store.add(data));
}

/** List without the full-size `src` payload — keeps the gallery light. */
export async function dbListHandouts() {
  const db    = await openDB();
  const store = db.transaction(IMG_STORE, 'readonly').objectStore(IMG_STORE);
  const all   = await run(store.getAll());
  return all
    .map(({ src, ...meta }) => meta)
    .sort((a, b) => b.savedAt - a.savedAt);
}

export async function dbGetHandout(id) {
  const db    = await openDB();
  const store = db.transaction(IMG_STORE, 'readonly').objectStore(IMG_STORE);
  return run(store.get(id));
}

export async function dbDeleteHandout(id) {
  const db    = await openDB();
  const store = db.transaction(IMG_STORE, 'readwrite').objectStore(IMG_STORE);
  return run(store.delete(id));
}

// ── Thumbnail helper ──────────────────────────────────────────────────────────

const THUMB_W = 160;
const THUMB_H = 100;

export function makeThumbnail(imageSrc) {
  return new Promise((resolve) => {
    if (!imageSrc) { resolve(null); return; }
    const img = new Image();
    img.onload = () => {
      const c   = document.createElement('canvas');
      c.width   = THUMB_W;
      c.height  = THUMB_H;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#0d0e18';
      ctx.fillRect(0, 0, THUMB_W, THUMB_H);
      const s = Math.min(THUMB_W / img.width, THUMB_H / img.height);
      const w = img.width * s, h = img.height * s;
      ctx.drawImage(img, (THUMB_W - w) / 2, (THUMB_H - h) / 2, w, h);
      resolve(c.toDataURL('image/jpeg', 0.55));
    };
    img.onerror = () => resolve(null);
    img.src = imageSrc;
  });
}

// ── Character sheets (PDF library) ────────────────────────────────────────────
// PDFs are kept as Blobs — far smaller than base64 and readable straight into
// an <iframe> through URL.createObjectURL().

export async function dbSaveSheet(data) {
  const db    = await openDB();
  const store = db.transaction(SHEET_STORE, 'readwrite').objectStore(SHEET_STORE);
  return run(data.id ? store.put(data) : store.add(data));
}

/** List without the `blob` payload — keeps the panel light. */
export async function dbListSheets() {
  const db    = await openDB();
  const store = db.transaction(SHEET_STORE, 'readonly').objectStore(SHEET_STORE);
  const all   = await run(store.getAll());
  return all
    .map(({ blob, ...meta }) => meta)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || b.savedAt - a.savedAt);
}

export async function dbGetSheet(id) {
  const db    = await openDB();
  const store = db.transaction(SHEET_STORE, 'readonly').objectStore(SHEET_STORE);
  return run(store.get(id));
}

export async function dbDeleteSheet(id) {
  const db    = await openDB();
  const store = db.transaction(SHEET_STORE, 'readwrite').objectStore(SHEET_STORE);
  return run(store.delete(id));
}
