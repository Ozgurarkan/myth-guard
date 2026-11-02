// The brand SVGs (the mark, the seal, the favicon) are drawn with a handful of flat colours. Here each one is swapped for a CSS variable,
// so the logo is painted in whatever theme is on: the violet tones become --logo-a..d (taken from the theme's solid fill colours in
// tokens.css), the cyan spark --logo-spark, the crescent --logo-moon, the seal's rings --accent / --accent-hi. Moonlit's values are the
// original artwork's colours, so nothing changes there. Pure text in, text out, so it can be tested and used for the favicon too.
const PAINT = [
  ['rgb(170,150,250)', 'var(--logo-a)'], ['rgb(156,129,251)', 'var(--logo-b)'], ['rgb(139,114,239)', 'var(--logo-c)'], ['rgb(99,77,217)', 'var(--logo-d)'],
  ['rgb(82,210,236)', 'var(--logo-spark)'], ['rgb(237,239,253)', 'var(--logo-moon)'],
  ['#cbbcff', 'var(--accent-hi)'], ['#a58bff', 'var(--accent)'], ['#6a4fd6', 'var(--accent-lo)'], ['#0b1024', 'var(--surface-1)'],
];

/** Every colour in the artwork that this module knows how to theme. */
export const ARTWORK_COLORS = PAINT.map(([colour]) => colour);

/**
 * The SVG with its colours as variables and its ids made unique with `uid` (two copies on one page must not borrow each other's
 * gradient or blur), sized to fill whatever box it is put in.
 */
export function themedSvg(raw, uid) {
  let svg = raw;
  for (const [colour, variable] of PAINT) svg = svg.split(`"${colour}"`).join(`"${variable}"`);
  svg = svg.replace(/\bid="([^"]+)"/g, (_, id) => `id="${id}-${uid}"`).replace(/url\(#([^)]+)\)/g, (_, id) => `url(#${id}-${uid})`);
  return svg.replace(/^(<svg[^>]*?) width="[^"]*" height="[^"]*"/, '$1 width="100%" height="100%"');
}

/** The same SVG with each `var(--name)` replaced by `colourOf(name)`: for places that cannot read the page's variables (the favicon). */
export const resolvedSvg = (svg, colourOf) => svg.replace(/var\((--[a-z0-9-]+)\)/g, (_, name) => colourOf(name));
