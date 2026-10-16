/** Generate a compact unique ID */
export function nanoid() {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

/** Snap a value to the nearest multiple of `step` */
export function snapTo(value, step) {
  return Math.round(value / step) * step;
}

/** Convert hex color + alpha (0–1) to rgba string */
export function hexAlpha(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Clamp value between min and max */
export function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

// ─── Real-world scale ────────────────────────────────────────────────────────
// One grid square is FEET_PER_CELL feet on the battle map, so every pixel
// measurement can be expressed in feet and back again.

export const DEFAULT_FEET_PER_CELL = 5;

/** How many pixels make up one foot at the current grid scale */
export function pxPerFoot(gridSize, feetPerCell = DEFAULT_FEET_PER_CELL) {
  return gridSize / (feetPerCell || DEFAULT_FEET_PER_CELL);
}

/** Feet → pixels */
export function ftToPx(feet, gridSize, feetPerCell) {
  return feet * pxPerFoot(gridSize, feetPerCell);
}

/** Pixels → feet */
export function pxToFt(px, gridSize, feetPerCell) {
  return px / pxPerFoot(gridSize, feetPerCell);
}

/** Pixels → feet, rounded to one decimal (drops a trailing ".0") */
export function roundFt(px, gridSize, feetPerCell) {
  return Math.round(pxToFt(px, gridSize, feetPerCell) * 10) / 10;
}

/** Feet → grid squares, rounded to one decimal */
export function ftToCells(feet, feetPerCell = DEFAULT_FEET_PER_CELL) {
  return Math.round((feet / (feetPerCell || DEFAULT_FEET_PER_CELL)) * 10) / 10;
}

/** Human-readable size of an area effect, in feet */
export function areaSizeLabel(effect, gridSize, feetPerCell) {
  const ft = (px) => roundFt(px, gridSize, feetPerCell);
  if (effect.type === 'circle') return `R ${ft(effect.radius)} ft`;
  if (effect.type === 'rect')   return `${ft(effect.width)} × ${ft(effect.height)} ft`;
  if (effect.type === 'cone')   return `${ft(effect.radius)} ft · ${Math.round(effect.angle ?? 60)}°`;
  return '';
}

/** Read a File object as a data URL */
export function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Get natural image dimensions from a src URL */
export function getImageSize(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 1920, height: 1080 });
    img.src = src;
  });
}

/** Shrink a data-URL image whose longest side exceeds `maxSide`; smaller images are returned untouched. */
export async function downscaleDataUrl(src, maxSide = 1600) {
  const img = await new Promise(resolve => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => resolve(null);
    el.src = src;
  });
  if (!img || Math.max(img.naturalWidth, img.naturalHeight) <= maxSide) return src;
  const scale = maxSide / Math.max(img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  // Keep transparency for PNG art; photographs compress far better as JPEG.
  return canvas.toDataURL(src.startsWith('data:image/png') ? 'image/png' : 'image/jpeg', 0.9);
}
