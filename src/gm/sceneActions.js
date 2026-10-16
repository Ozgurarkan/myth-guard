// Saving, loading and importing scenes. Shared by the header, the Scenes panel
// and Ctrl+S so they always behave the same.
import { dbSaveMap, dbGetMap, makeThumbnail } from '../db';
import { SAVED_KEYS } from '../store';
import { readFileAsDataURL, getImageSize } from '../utils';

/** Store the scene on the table. With `asCopy`, it becomes a new entry instead of updating the open one. */
export async function saveScene(state, dispatch, { name, asCopy = false } = {}) {
  const title = (name ?? state.currentMapName).trim() || 'Untitled scene';
  const finalName = asCopy ? `${title} (copy)` : title;
  const record = {
    ...(!asCopy && state.currentMapId ? { id: state.currentMapId } : {}),
    name: finalName,
    savedAt: Date.now(),
    thumbnail: await makeThumbnail(state.mapImageSrc),
    ...Object.fromEntries(SAVED_KEYS.map(key => [key, state[key]])),
  };
  const id = await dbSaveMap(record);
  dispatch({ type: 'MAP_SET_META', name: finalName, id: record.id ?? id });
  window.dispatchEvent(new CustomEvent('scenes-updated'));
  return finalName;
}

export async function loadScene(id, dispatch) {
  const full = await dbGetMap(id);
  if (!full) throw new Error('That scene could not be found.');
  dispatch({ type: 'MAP_LOAD_FULL', payload: full });
  return full.name;
}

/** Read a picked image file and put it on the table as the battle map. */
export async function importMapFile(file, state, dispatch) {
  const src = await readFileAsDataURL(file);
  const { width, height } = await getImageSize(src);
  dispatch({ type: 'MAP_LOAD', src, width, height });
  // A fresh, unnamed scene takes its name from the map file ("Whispering Woods.png" → "Whispering Woods").
  if (!state.currentMapId && state.currentMapName === 'Untitled Map') {
    const title = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
    if (title) dispatch({ type: 'SCENE_RENAME', name: title });
  }
  return { width, height };
}
