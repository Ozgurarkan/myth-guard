/**
 * Character-sheet (PDF) library helpers.
 *
 * Sheets live in IndexedDB as Blobs. For viewing they are handed to an
 * <iframe> through an object URL, which is cached per sheet so flipping
 * between open sheets never re-reads the database.
 */
import { dbSaveSheet, dbListSheets, dbGetSheet } from './db';

/** Fired whenever the sheet library changes so open views can refresh. */
export const SHEET_EVENT = 'sheet-library-updated';
export const notifySheets = () => window.dispatchEvent(new CustomEvent(SHEET_EVENT));

const urlCache = new Map();   // sheet id → object URL

/** Object URL for a sheet, created once and reused for the rest of the session. */
export async function sheetUrl(id) {
  if (urlCache.has(id)) return urlCache.get(id);
  const entry = await dbGetSheet(id);
  if (!entry?.blob) return null;
  const url = URL.createObjectURL(entry.blob);
  urlCache.set(id, url);
  return url;
}

/** Drop a cached URL — call when a sheet is deleted or replaced. */
export function releaseSheetUrl(id) {
  const url = urlCache.get(id);
  if (url) { URL.revokeObjectURL(url); urlCache.delete(id); }
}

/** Store a picked PDF in the library. Re-picking the same file reuses its entry. */
export async function saveSheetFile(file) {
  if (!file || typeof file.name !== 'string' || !/\.pdf$/i.test(file.name)) {
    throw new Error('Please choose a PDF character sheet.');
  }
  if (!file.size) throw new Error(`“${file.name}” is empty.`);
  const dot  = file.name.lastIndexOf('.');
  const name = dot > 0 ? file.name.slice(0, dot) : file.name;

  const existing = await dbListSheets();
  const dupe = existing.find(s => s.name === name && s.size === file.size);
  if (dupe) return dupe;

  const order = existing.length ? Math.max(...existing.map(s => s.order ?? 0)) + 1 : 0;
  const id = await dbSaveSheet({
    name,
    // A Blob is reliably structured-cloneable across browsers, including
    // browsers that reject a File object during an IndexedDB transaction.
    blob: file.slice(0, file.size, 'application/pdf'),
    size: file.size,
    order,
    savedAt: Date.now(),
  });
  return { id, name, size: file.size, order, savedAt: Date.now() };
}

/** Save a sheet back out to disk. */
export async function downloadSheet(entry) {
  const url = await sheetUrl(entry.id);
  if (!url) return;
  const a = document.createElement('a');
  a.href = url;
  a.download = `${entry.name || 'sheet'}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Human-readable file size. */
export function fileSizeLabel(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
