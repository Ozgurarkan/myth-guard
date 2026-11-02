// The browser tab's icon in the current theme's colours. The favicon is drawn from the same artwork as the logo (src/logoSvg.js),
// with the theme's colours written into it, and swapped in whenever the theme changes. (The home-screen icons in public/brand are
// pictures made once, so they stay as they are.)
import faviconSvg from './assets/brand/favicon.svg?raw';
import { themedSvg, resolvedSvg } from './logoSvg';
import { cssColor, onThemeChange } from './theme';

/** Any CSS colour (a hex, an rgb(), a colour-mix()) as a plain #rrggbb, by painting it on a one-pixel canvas. */
function plainColour(value) {
  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  context.canvas.width = context.canvas.height = 1;
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}

function update() {
  let link = document.querySelector('link[rel="icon"]');
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; link.type = 'image/svg+xml'; document.head.append(link); }
  const svg = resolvedSvg(themedSvg(faviconSvg, 'fav'), name => plainColour(cssColor(name, '#a58bff')));
  link.type = 'image/svg+xml';
  link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

if (typeof document !== 'undefined') {
  onThemeChange(update);
  if (document.readyState === 'complete') update(); else window.addEventListener('load', update, { once: true });
}
