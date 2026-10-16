const KEY = 'myth-guard-player-server';

export function playerServerUrl() {
  try { return globalThis.localStorage?.getItem(KEY) || ''; } catch { return ''; }
}

export function setPlayerServerUrl(value) {
  const url = new URL(String(value).trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('Use an http:// or https:// table address.');
  url.pathname = '/player.html';
  try { globalThis.localStorage?.setItem(KEY, url.href); } catch { /* current visit still works */ }
  return url.href;
}

export function tableUrl(path, base = playerServerUrl()) {
  return base ? new URL(path, base).href : path;
}

export function tableAssets(value, base = playerServerUrl()) {
  if (!base || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => tableAssets(item, base));
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    next[key] = typeof item === 'string' && key.endsWith('Src') && item.startsWith('/') ? tableUrl(item, base) : tableAssets(item, base);
  }
  return next;
}
