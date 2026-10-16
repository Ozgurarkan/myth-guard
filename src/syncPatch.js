// Compact state patches for the player view.
//
// Players hold a full copy of the public scene. After each GM change the
// server sends only what moved: a dragged token is one small object, a fog
// brush stroke is a handful of cell keys, and a pan/zoom on the GM screen
// sends nothing at all.
//
// A patch is only valid against the exact revision it was computed from, so
// the transport pairs every patch with its base revision and falls back to a
// full snapshot whenever the two disagree.

/** Arrays of `{ id, … }` objects whose draw order matters. */
const COLLECTIONS = new Set(['tokens', 'areaEffects', 'markers']);
/** Arrays of unique strings whose order does not matter. */
const STRING_SETS = new Set(['fogCells']);

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/** Structural equality for plain JSON values. */
export function isEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!isEqual(a[i], b[i])) return false;
    return true;
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) if (!hasOwn(b, key) || !isEqual(a[key], b[key])) return false;
  return true;
}

const hasUniqueIds = items => {
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || seen.has(item.id)) return false;
    seen.add(item.id);
  }
  return true;
};

function diffCollection(before, after) {
  const old = new Map(before.map(item => [item.id, item]));
  const kept = new Set();
  const put = [];
  for (const item of after) {
    kept.add(item.id);
    const previous = old.get(item.id);
    if (!previous || !isEqual(previous, item)) put.push(item);
  }
  const rm = before.filter(item => !kept.has(item.id)).map(item => item.id);
  // Where would the survivors sit if the client simply appended new items?
  const expected = before.filter(item => kept.has(item.id)).map(item => item.id);
  for (const item of after) if (!old.has(item.id)) expected.push(item.id);
  const ids = after.map(item => item.id);
  const op = {};
  if (put.length) op.put = put;
  if (rm.length) op.rm = rm;
  if (expected.length !== ids.length || expected.some((id, i) => id !== ids[i])) op.order = ids;
  return op;
}

function diffSet(before, after) {
  const was = new Set(before);
  const now = new Set(after);
  const add = [];
  const rm = [];
  for (const key of now) if (!was.has(key)) add.push(key);
  for (const key of was) if (!now.has(key)) rm.push(key);
  const op = {};
  if (add.length) op.add = add;
  if (rm.length) op.rm = rm;
  return op;
}

/**
 * Describe how to turn `prev` into `next`. Returns `null` when nothing changed
 * (or when there is no previous state to patch, in which case send it whole).
 */
export function diffState(prev, next) {
  if (!prev || !next) return null;
  const set = {};
  const coll = {};
  const sets = {};
  const del = [];
  for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    const a = prev[key];
    const b = next[key];
    if (isEqual(a, b)) continue;
    if (b === undefined) { del.push(key); continue; }
    if (COLLECTIONS.has(key) && Array.isArray(a) && Array.isArray(b) && hasUniqueIds(a) && hasUniqueIds(b)) {
      coll[key] = diffCollection(a, b);
    } else if (STRING_SETS.has(key) && Array.isArray(a) && Array.isArray(b)) {
      sets[key] = diffSet(a, b);
    } else set[key] = b;
  }
  const patch = {};
  if (Object.keys(set).length) patch.set = set;
  if (Object.keys(coll).length) patch.coll = coll;
  if (Object.keys(sets).length) patch.sets = sets;
  if (del.length) patch.del = del;
  return Object.keys(patch).length ? patch : null;
}

function applyCollection(base, op) {
  let items = base;
  if (op.rm?.length) {
    const gone = new Set(op.rm);
    items = items.filter(item => !gone.has(item.id));
  }
  if (op.put?.length) {
    const index = new Map(items.map((item, i) => [item.id, i]));
    items = items.slice();
    for (const item of op.put) {
      const at = index.get(item.id);
      if (at === undefined) { index.set(item.id, items.length); items.push(item); } else items[at] = item;
    }
  }
  if (op.order) {
    const byId = new Map(items.map(item => [item.id, item]));
    items = op.order.map(id => byId.get(id)).filter(Boolean);
  }
  return items;
}

function applySet(base, op) {
  const cells = new Set(base);
  for (const key of op.rm ?? []) cells.delete(key);
  for (const key of op.add ?? []) cells.add(key);
  return [...cells];
}

/** Apply a patch produced by `diffState`. Untouched values keep their identity. */
export function applyPatch(state, patch) {
  const next = { ...state };
  for (const key of patch.del ?? []) delete next[key];
  for (const [key, value] of Object.entries(patch.set ?? {})) next[key] = value;
  for (const [key, op] of Object.entries(patch.coll ?? {})) next[key] = applyCollection(next[key] ?? [], op);
  for (const [key, op] of Object.entries(patch.sets ?? {})) next[key] = applySet(next[key] ?? [], op);
  return next;
}
