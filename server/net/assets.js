// Content-addressed image store and its HTTP routes (design 4.4, 4.9, test group E).
//
// Maps, token art and handouts are uploaded once by the GM's browser and referenced by the SHA-256 of their bytes.
// Reads need an admitted device's cookie (or the GM); writes need the GM (loopback + rf-gm + Origin + X-RF).
// Quotas: 24 MiB per image, 256 MiB in total; images the live scene refers to are pinned and never evicted. If pinned
// images alone fill the quota, a new upload is refused with 507 instead of silently breaking the scene.
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createBucket } from './ipLimiter.js';

export const ASSET_PREFIX = '/__realm/assets/';
const ASSET_PATH = /^\/__realm\/assets\/([0-9a-f]{64})$/;
const HASH = /^[0-9a-f]{64}$/;

const MiB = 1024 * 1024;
export const ASSET_LIMITS = Object.freeze({
  maxBytes: 256 * MiB,          // all images together
  maxAsset: 24 * MiB,           // one image
  maxSide: 16_384,              // pixels, longer side
  maxPixels: 100_000_000,       // area (100 MP)
  uploadsPerMinute: 40,
  missingMaxHashes: 500,
  missingMaxBody: 64 * 1024,
});

const SIGNATURES = [
  ['image/png', b => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ['image/jpeg', b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/gif', b => b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8'],
  ['image/webp', b => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'],
  ['image/avif', b => b.length > 12 && b.toString('latin1', 4, 8) === 'ftyp' && /^avi[fs]$/.test(b.toString('latin1', 8, 12))],
];

/** Only raster images are served: an SVG opened directly could run script. */
export function sniffImage(buffer) {
  return SIGNATURES.find(([, test]) => test(buffer))?.[0] ?? null;
}

// ---- image dimensions from the file header (no decoding) ---------------------------------------------------------

const sizeOfJpeg = b => {
  let i = 2;
  for (let guard = 0; guard < 4096 && i + 4 <= b.length; guard++) {
    if (b[i] !== 0xff) return null;
    while (b[i] === 0xff && i < b.length) i += 1; // fill bytes
    const marker = b[i];
    i += 1;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // no length
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan before any frame header
    if (i + 2 > b.length) return null;
    const length = b.readUInt16BE(i);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 7 > b.length) return null;
      return { height: b.readUInt16BE(i + 3), width: b.readUInt16BE(i + 5) };
    }
    if (length < 2) return null;
    i += length;
  }
  return null;
};

const sizeOfWebp = b => {
  if (b.length < 30) return null;
  const kind = b.toString('latin1', 12, 16);
  if (kind === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  if (kind === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    return { width: (b[21] | ((b[22] & 0x3f) << 8)) + 1, height: ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)) + 1 };
  }
  if (kind === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  return null;
};

const sizeOfAvif = b => {
  // Every 'ispe' (image spatial extents) property in the first 512 KB; the largest one counts.
  const end = Math.min(b.length, 512 * 1024);
  let best = null;
  for (let at = b.indexOf('ispe', 0, 'latin1'); at >= 0 && at + 16 <= end; at = b.indexOf('ispe', at + 4, 'latin1')) {
    const width = b.readUInt32BE(at + 8);
    const height = b.readUInt32BE(at + 12);
    if (!best || width * height > best.width * best.height) best = { width, height };
  }
  return best;
};

/** `{ width, height }` read from the header of a PNG, JPEG, GIF, WebP or AVIF, or null when it cannot be read. */
export function imageSize(buffer, type = sniffImage(buffer)) {
  try {
    if (type === 'image/png') return buffer.length >= 24 && buffer.toString('latin1', 12, 16) === 'IHDR' ? { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) } : null;
    if (type === 'image/gif') return buffer.length >= 10 ? { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) } : null;
    if (type === 'image/jpeg') return sizeOfJpeg(buffer);
    if (type === 'image/webp') return sizeOfWebp(buffer);
    if (type === 'image/avif') return sizeOfAvif(buffer);
  } catch { /* a truncated header is simply unreadable */ }
  return null;
}

// ---- the store -----------------------------------------------------------------------------------------------------

/**
 * @param {object} [options]
 * @param {() => Set<string>} [options.pin]  hashes the current scene refers to (never evicted)
 * @param {boolean} [options.requireDimensions]  refuse an image whose size cannot be read (default true)
 * @param {(hash: string) => void} [options.onEvict]
 */
export function createAssetStore({
  maxBytes = ASSET_LIMITS.maxBytes, maxAsset = ASSET_LIMITS.maxAsset, maxSide = ASSET_LIMITS.maxSide,
  maxPixels = ASSET_LIMITS.maxPixels, pin = () => new Set(), requireDimensions = true, onEvict = () => {},
} = {}) {
  const entries = new Map(); // hash -> { buffer, type }, least recently used first
  let total = 0;
  let evicted = 0;
  let pinFn = pin;
  const touch = (hash, entry) => { entries.delete(hash); entries.set(hash, entry); };
  const pinnedSet = () => {
    try { const set = pinFn(); return set instanceof Set ? set : new Set(set ?? []); } catch { return new Set(); }
  };

  const store = {
    maxAsset,
    has: hash => entries.has(hash),
    get(hash) {
      const entry = entries.get(hash);
      if (entry) touch(hash, entry);
      return entry ?? null;
    },
    setPin(fn) { pinFn = typeof fn === 'function' ? fn : () => new Set(); },
    /** Returns `{ ok: true, existed }` or `{ ok: false, status, reason }`. */
    put(hash, buffer) {
      if (typeof hash !== 'string' || !HASH.test(hash)) return { ok: false, status: 400, reason: 'Bad asset id' };
      if (!Buffer.isBuffer(buffer)) return { ok: false, status: 400, reason: 'Bad image' };
      if (buffer.length > maxAsset) return { ok: false, status: 413, reason: 'Image is too large' };
      if (createHash('sha256').update(buffer).digest('hex') !== hash) return { ok: false, status: 400, reason: 'Hash mismatch' };
      const type = sniffImage(buffer);
      if (!type) return { ok: false, status: 415, reason: 'Unsupported image type' };
      const size = imageSize(buffer, type);
      if (size) {
        if (!(size.width > 0 && size.height > 0) || Math.max(size.width, size.height) > maxSide || size.width * size.height > maxPixels) {
          return { ok: false, status: 415, reason: 'Image dimensions are too large' };
        }
      } else if (requireDimensions) {
        return { ok: false, status: 415, reason: 'Image size could not be read' };
      }
      if (entries.has(hash)) { touch(hash, entries.get(hash)); return { ok: true, existed: true }; }

      if (total + buffer.length > maxBytes) {
        // Plan the eviction first so that a refused upload changes nothing.
        const pinned = pinnedSet();
        let freed = 0;
        const victims = [];
        for (const [candidate, entry] of entries) {
          if (total - freed + buffer.length <= maxBytes) break;
          if (pinned.has(candidate)) continue;
          victims.push(candidate);
          freed += entry.buffer.length;
        }
        if (total - freed + buffer.length > maxBytes) {
          return { ok: false, status: 507, reason: 'Table image memory is full - remove old scenes or restart the table' };
        }
        for (const victim of victims) {
          total -= entries.get(victim).buffer.length;
          entries.delete(victim);
          evicted += 1;
          onEvict(victim);
        }
      }
      entries.set(hash, { buffer, type });
      total += buffer.length;
      return { ok: true, existed: false };
    },
    get size() { return entries.size; },
    get bytes() { return total; },
    stats() {
      const pinned = pinnedSet();
      let pinnedCount = 0;
      for (const hash of entries.keys()) if (pinned.has(hash)) pinnedCount += 1;
      return { count: entries.size, bytes: total, pinned: pinnedCount, evicted };
    },
  };
  return store;
}

// ---- HTTP ------------------------------------------------------------------------------------------------------------

/** Reads a request body of at most `limit` bytes. Rejects with { status: 413 } when it is larger (nothing more is buffered). */
export function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers?.['content-length']);
    if (Number.isFinite(declared) && declared > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); return; }
    const chunks = [];
    let length = 0;
    let done = false;
    const finish = (fn, value) => { if (done) return; done = true; request.removeListener('data', onData); fn(value); };
    const onData = chunk => {
      length += chunk.length;
      if (length > limit) { finish(reject, Object.assign(new Error('too large'), { status: 413 })); return; }
      chunks.push(chunk);
    };
    request.on('data', onData);
    request.once('end', () => finish(resolve, Buffer.concat(chunks)));
    request.once('error', error => finish(reject, error));
    request.once('close', () => finish(reject, Object.assign(new Error('aborted'), { status: 400 })));
  });
}

/** Paces large image responses so a map reveal cannot saturate the router while sound is playing (off unless kBps > 0). */
export function createEgressPacer({ kBps, clock, chunk = 64 * 1024 }) {
  const perSec = kBps * 1024;
  const bucket = createBucket({ capacity: chunk * 2, perSec }, clock);
  return {
    async send(response, buffer) {
      for (let at = 0; at < buffer.length; at += chunk) {
        const part = buffer.subarray(at, at + chunk);
        while (!bucket.take(part.length)) {
          if (response.destroyed || response.writableEnded) return;
          await new Promise(resolve => clock.setTimeout(resolve, Math.max(10, Math.ceil((part.length / perSec) * 250))));
        }
        if (response.destroyed || response.writableEnded) return;
        if (!response.write(part)) await Promise.race([once(response, 'drain'), once(response, 'close')]).catch(() => {});
      }
      response.end();
    },
  };
}

const textReply = (response, status, text, extra = {}) => {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  response.end(text);
};

/**
 * `handle(request, response, ctx)` serves everything under /__realm/assets/ and always returns true for that prefix
 * (false for any other path). `ctx` is handshake.describe(request).
 */
export function createAssetRoutes({ store, handshake, limiter, metrics, clock, pacer = null, audioLive = () => false, limits = ASSET_LIMITS }) {
  const uploads = createBucket({ capacity: limits.uploadsPerMinute, perSec: limits.uploadsPerMinute / 60 }, clock);
  const gmWrite = (request, ctx) => handshake.isGm(ctx, { originRequired: true }).ok && request.headers['x-rf'] === '1';

  /** A request that is refused or finds nothing costs a token; with none left the answer becomes 429. */
  const miss = (response, ctx, status, text) => {
    if (!limiter.hit(ctx.ip, 'assetMiss')) { metrics.inc('reject.ratelimit'); textReply(response, 429, 'Too many requests'); return; }
    metrics.inc(status === 403 ? 'assets.forbidden' : 'assets.miss');
    textReply(response, status, text);
  };

  return {
    handle(request, response, ctx) {
      const path = ctx.url.split('?')[0];
      if (!path.startsWith(ASSET_PREFIX)) return false;

      if (path === `${ASSET_PREFIX}missing`) {
        if (request.method !== 'POST') { textReply(response, 405, 'Method not allowed', { Allow: 'POST' }); return true; }
        if (!gmWrite(request, ctx)) { metrics.inc('reject.gm'); textReply(response, 403, 'Forbidden'); return true; }
        // The GM asks which of these images the server still needs, so nothing is uploaded twice.
        readBody(request, limits.missingMaxBody).then(body => {
          const hashes = JSON.parse(body.toString() || '[]');
          if (!Array.isArray(hashes) || hashes.length > limits.missingMaxHashes) throw new Error('bad request');
          const missing = hashes.filter(hash => typeof hash === 'string' && HASH.test(hash) && !store.has(hash));
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          response.end(JSON.stringify(missing));
        }).catch(error => {
          if (error?.status === 413) tooLarge(request, response); else textReply(response, 400, 'Bad request');
        });
        return true;
      }

      const match = ASSET_PATH.exec(path);
      if (!match) { textReply(response, 404, 'Not found'); return true; }
      const hash = match[1];

      if (request.method === 'GET' || request.method === 'HEAD') {
        const who = handshake.identify(ctx);
        if (!who) { miss(response, ctx, 403, 'Forbidden'); return true; }
        const asset = store.get(hash);
        if (!asset) { miss(response, ctx, 404, 'Not found'); return true; }
        const etag = `"${hash}"`;
        const headers = {
          'Content-Type': asset.type,
          'Content-Length': asset.buffer.length,
          // The URL is the hash of the bytes, so it never changes; but only admitted devices may keep it (private).
          'Cache-Control': 'private, max-age=31536000, immutable',
          ETag: etag,
          'X-Content-Type-Options': 'nosniff',
          'Cross-Origin-Resource-Policy': 'same-origin',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        };
        const sent = String(request.headers['if-none-match'] ?? '');
        if (sent === '*' || sent.split(',').some(tag => tag.trim().replace(/^W\//, '') === etag)) {
          delete headers['Content-Length'];
          response.writeHead(304, headers);
          response.end();
          return true;
        }
        metrics.inc('assets.served');
        response.writeHead(200, headers);
        if (request.method === 'HEAD') response.end();
        else if (pacer && asset.buffer.length > 256 * 1024 && audioLive()) pacer.send(response, asset.buffer);
        else response.end(asset.buffer);
        return true;
      }

      if (request.method === 'PUT') {
        if (!gmWrite(request, ctx)) { metrics.inc('reject.gm'); textReply(response, 403, 'Forbidden'); return true; }
        if (!uploads.take()) { metrics.inc('reject.ratelimit'); textReply(response, 429, 'Too many uploads'); return true; }
        readBody(request, store.maxAsset).then(body => {
          const result = store.put(hash, body);
          if (!result.ok) {
            metrics.inc(`assets.refused.${result.status}`);
            if (result.status === 507) metrics.log('assets: upload refused, image memory is full');
            textReply(response, result.status, result.reason);
            return;
          }
          metrics.inc('assets.uploaded');
          response.writeHead(result.existed ? 200 : 201, { 'Cache-Control': 'no-store' });
          response.end();
        }, error => {
          if (error?.status === 413) tooLarge(request, response); else textReply(response, 400, 'Upload failed');
        });
        return true;
      }

      textReply(response, 405, 'Method not allowed', { Allow: 'GET, HEAD, PUT' });
      return true;
    },
  };
}

/** 413 and hang up: the rest of an oversized body is never read. */
export function tooLarge(request, response) {
  response.once('finish', () => request.destroy());
  textReply(response, 413, 'Payload too large', { Connection: 'close' });
}
