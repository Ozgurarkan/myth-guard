// Colour themes. Which one is on is kept per device (localStorage) and applied as data-theme on <html>; the CSS in
// styles/tokens.css (Moonlit) and styles/themes.css (the rest) does the colouring. The map canvas cannot read CSS, so
// canvas/shared.jsx re-reads the same tokens through cssColor() whenever the theme changes.
import { useSyncExternalStore } from 'react';

/** `swatch` is [surface, accent, second accent], only used to draw the picker. Keep it in step with themes.css. */
export const THEMES = [
  { id: 'moonlit', label: 'Moonlit', swatch: ['#0b1024', '#a58bff', '#4fd8ee'] },
  { id: 'ember', label: 'Ember', swatch: ['#17110e', '#ffa94d', '#5fd3c0'] },
  { id: 'verdant', label: 'Verdant', swatch: ['#0a1612', '#3ddc97', '#f2c94c'] },
  { id: 'tide', label: 'Tide', swatch: ['#081c28', '#4fb3ff', '#3de8c4'] },
  { id: 'daylight', label: 'Daylight', swatch: ['#eef1f8', '#6a4fd6', '#0a8f9f'] },
  { id: 'parchment', label: 'Parchment', swatch: ['#eee2c3', '#8a5a00', '#8e2f3a'] },
  { id: 'castle', label: 'Castle', swatch: ['#1a1b1e', '#8fb3d9', '#ff9f43'] },
];
export const DEFAULT_THEME = 'moonlit';
const STORAGE_KEY = 'myth-guard-theme';

/** Anything that is not a known theme is the default one. */
export const themeId = value => (THEMES.some(theme => theme.id === value) ? value : DEFAULT_THEME);

const storage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };
const listeners = new Set();
let current = DEFAULT_THEME;
let version = 0;

/** A colour token from the page as written in the stylesheet ("#a58bff"), or the fallback outside a browser. */
export function cssColor(name, fallback) {
  if (typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}
/** A channel token ("--accent-2-rgb": 79 216 238) as an rgba() string, for canvas fills with some transparency. */
export function cssRgba(channelName, alpha, fallback) {
  const parts = cssColor(channelName, '').split(/\s+/).filter(Boolean);
  return parts.length === 3 ? `rgba(${parts.join(', ')}, ${alpha})` : fallback;
}

// The browser's own chrome (phone address bar, title bar) follows the page.
const syncChrome = () => document.querySelector('meta[name="theme-color"]')?.setAttribute('content', cssColor('--surface-1', '#0b1024'));

function apply(id) {
  current = id;
  version += 1;
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = id;
    syncChrome();
  }
  listeners.forEach(listener => listener());
}

export const getTheme = () => current;
export function setTheme(id) {
  const next = themeId(id);
  try { storage()?.setItem(STORAGE_KEY, next); } catch { /* private mode: the choice lasts until the page closes */ }
  if (next !== current) apply(next);
}
/** Runs after every change (and once now). Used by the canvas palette; returns the unsubscribe. */
export function onThemeChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }
const subscribe = listener => onThemeChange(listener);

/** [theme id, setTheme]: re-renders when the theme changes here or in another window of this browser. */
export function useTheme() {
  const id = useSyncExternalStore(subscribe, getTheme, () => DEFAULT_THEME);
  return [id, setTheme];
}
/** A number that changes with every theme change: pass it to memoised canvas layers so they repaint in the new colours. */
export function useThemeVersion() {
  return useSyncExternalStore(subscribe, () => version, () => 0);
}

// Applied the moment this module loads, before the first render, so the page never flashes the wrong colours.
try { apply(themeId(storage()?.getItem(STORAGE_KEY))); } catch { apply(DEFAULT_THEME); }
if (typeof window !== 'undefined') window.addEventListener('load', syncChrome);
// The TV window, the player view and the GM screen share a browser: changing it in one changes it in all.
if (typeof window !== 'undefined') window.addEventListener('storage', event => { if (event.key === STORAGE_KEY) { const next = themeId(event.newValue); if (next !== current) apply(next); } });
