/**
 * Shared helpers for the handout image library.
 * Used by the GM panel, the header and the image picker modal.
 */
import { readFileAsDataURL, getImageSize } from './utils';
import { dbSaveHandout, dbListHandouts, makeThumbnail } from './db';

/** Fired whenever the library changes so open views can refresh themselves. */
export const LIBRARY_EVENT = 'handout-library-updated';
export const notifyLibrary = () => window.dispatchEvent(new CustomEvent(LIBRARY_EVENT));

/** Read a picked file, thumbnail it, and store it in the image library.
 *  Re-picking a file that is already in the library reuses that entry. */
export async function saveHandoutFile(file) {
  const src  = await readFileAsDataURL(file);
  const dot  = file.name.lastIndexOf('.');
  const name = dot > 0 ? file.name.slice(0, dot) : file.name;
  const ext  = dot > 0 ? file.name.slice(dot + 1) : 'png';

  const dupe = (await dbListHandouts()).find(i => i.name === name && i.size === src.length);
  if (dupe) return { id: dupe.id, name: dupe.name, src };

  const { width, height } = await getImageSize(src);
  const thumbnail = await makeThumbnail(src);
  const id = await dbSaveHandout({ name, ext, src, thumbnail, width, height, size: src.length, savedAt: Date.now() });
  return { id, name, src };
}

/** Save an image out of the browser and onto disk. */
export function downloadImage(entry) {
  const a = document.createElement('a');
  a.href = entry.src;
  a.download = `${entry.name || 'handout'}.${entry.ext || 'png'}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
