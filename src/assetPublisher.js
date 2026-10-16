// GM side of the image store.
//
// Turns an image held in this browser (a data: URL from the map importer, a
// token portrait, a handout) into a short, permanent URL on the server, and
// uploads the bytes if the server does not have them yet. Everything players
// receive refers to images by that URL, never by the pixels.
//
// Big images are shrunk first: a phone screen never needs the 8000-pixel
// original of a battle map, and a 76-pixel initiative portrait certainly does
// not need a 4 MB photo.

/** Longest side, in pixels, sent to players for each kind of image. */
export const MAX_SIDE = { map: 4096, handout: 3072, token: 384 };

const hex = buffer => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');

async function sha256(blob) {
  return hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
}

/** Re-encode `blob` smaller when it is larger than `maxSide`; otherwise keep the original bytes. */
async function shrink(blob, maxSide, recompress) {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return blob;
  let bitmap;
  try { bitmap = await createImageBitmap(blob); } catch { return blob; }
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    // Maps and handouts keep their original pixels unless they must shrink.
    // Token art is also re-encoded when heavy: portraits are often multi-megabyte photos.
    if (scale === 1 && !(recompress && blob.size > 150 * 1024)) return blob;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const encoded = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.9));
    return encoded && encoded.size < blob.size ? encoded : blob;
  } finally { bitmap.close?.(); }
}

/**
 * A short cache key for an image source. The old key was `kind|<whole data URL>`: building and hashing a 6 MB string cost
 * about 3.6 ms on every flush while dragging. This one reads about 512 characters whatever the size. It is only a
 * bucket: the cache entry keeps the source string and a hit must match it exactly (a pointer comparison when it is the
 * same string, which is the normal case), so two different images can never be mixed up.
 */
export function fingerprint(src, kind) {
  const length = src.length;
  if (length <= 256) return `${kind}|${src}`;
  let hash = 2166136261;
  const step = Math.max(1, Math.floor(length / 512));
  for (let i = 0; i < length; i += step) hash = Math.imul(hash ^ src.charCodeAt(i), 16777619);
  return `${kind}|${length}|${(hash >>> 0).toString(36)}|${src.slice(-24)}`;
}

/** An upload refusal in words a person can act on (also carries `status` and `userMessage`). */
function uploadError(status) {
  const message = status === 507 ? 'Table image memory is full - remove old scenes or restart the table'
    : status === 413 ? 'This image is too large to share with the players'
      : `Image upload failed (${status})`;
  return Object.assign(new Error(message), { status, userMessage: message });
}

export function createAssetPublisher({ fetchImpl = (...args) => fetch(...args), base = '', onError } = {}) {
  // fingerprint → { src, job: Promise<{ hash, blob }> }. A few entries are enough: scenes reuse the same handful of images.
  const known = new Map();
  const uploaded = new Set();
  const LIMIT = 48;
  // The GM-only endpoints want this header on top of the loopback address, Origin and cookie checks.
  const GM_HEADERS = { 'X-RF': '1' };

  const urlFor = hash => `${base}/__realm/assets/${hash}`;

  function prepare(src, kind) {
    const key = fingerprint(src, kind);
    const entry = known.get(key);
    if (entry && entry.src === src) { known.delete(key); known.set(key, entry); return entry.job; }
    const job = (async () => {
      const response = await fetchImpl(src);
      if (!response.ok) throw new Error('Image could not be read');
      const blob = await shrink(await response.blob(), MAX_SIDE[kind] ?? MAX_SIDE.token, kind === 'token');
      return { hash: await sha256(blob), blob };
    })();
    const fresh = { src, job };
    job.catch(() => { if (known.get(key) === fresh) known.delete(key); });
    known.set(key, fresh);
    if (known.size > LIMIT) known.delete(known.keys().next().value);
    return job;
  }

  async function ensureUploaded(hash, blob) {
    if (uploaded.has(hash)) return;
    const asked = await fetchImpl(`${base}/__realm/assets/missing`, { method: 'POST', body: JSON.stringify([hash]), headers: GM_HEADERS });
    if (!asked.ok) throw asked.status === 507 || asked.status === 413 ? uploadError(asked.status) : new Error(`Image check failed (${asked.status})`);
    if ((await asked.json()).includes(hash)) {
      const put = await fetchImpl(urlFor(hash), { method: 'PUT', body: blob, headers: { ...GM_HEADERS, 'Content-Type': blob.type || 'application/octet-stream' } });
      if (!put.ok) throw uploadError(put.status);
    }
    uploaded.add(hash);
  }

  return {
    /** Resolve an image to its shareable URL, or `null` if it cannot be read or uploaded. */
    async resolve(src, kind = 'token') {
      if (!src) return null;
      // Already a shared image (for example after a scene was re-saved).
      if (src.startsWith(`${base}/__realm/assets/`)) return src;
      try {
        const { hash, blob } = await prepare(src, kind);
        await ensureUploaded(hash, blob);
        return urlFor(hash);
      } catch (error) {
        console.warn('Could not share an image with the players:', error);
        try { onError?.(error); } catch { /* a faulty listener must not break publishing */ }
        return null;
      }
    },
    /** The server may have restarted: confirm every image again before the next publish. */
    forgetUploads() { uploaded.clear(); },
  };
}
