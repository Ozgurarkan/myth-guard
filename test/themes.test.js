// The colour themes: every theme overrides the whole token set, its colour channels match its hex colours, and its text is readable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { THEMES, DEFAULT_THEME, themeId } from '../src/theme.js';

const css = file => readFileSync(new URL(`../src/styles/${file}`, import.meta.url), 'utf8');
const tokens = css('tokens.css');
const themesCss = css('themes.css');

/** The custom properties declared in the first block that starts with `header`. */
function block(source, header) {
  const open = source.indexOf('{', source.indexOf(header));
  const close = source.indexOf('\n}', open);
  return Object.fromEntries([...source.slice(open, close).matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}
const themeTokens = id => (id === DEFAULT_THEME ? block(tokens, ':root {') : block(themesCss, `:root[data-theme='${id}']`));

const luminance = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const channels = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(' ');

// What a theme must define. Moonlit has them all in tokens.css; the others must repeat every one that gives the theme its look.
const HEX = ['surface-0', 'surface-1', 'surface-2', 'surface-3', 'surface-4', 'surface-sunken', 'border-subtle', 'border', 'border-strong', 'border-control',
  'text', 'text-2', 'text-3', 'text-4', 'text-on-accent', 'accent', 'accent-hi', 'accent-lo', 'accent-2', 'accent-2-hi', 'accent-2-lo', 'arcane',
  'surface-light', 'surface-light-2', 'on-light', 'on-light-2', 'border-light'];
const CHANNELS = ['surface-0-rgb', 'surface-1-rgb', 'surface-2-rgb', 'surface-3-rgb', 'surface-sunken-rgb', 'scrim-rgb', 'glass-rgb', 'text-rgb', 'edge-rgb', 'hi-rgb', 'shadow-rgb',
  'accent-rgb', 'accent-lo-rgb', 'accent-2-rgb', 'accent-2-lo-rgb', 'arcane-rgb', 'fill-hi-rgb', 'fill-rgb', 'fill-lo-rgb', 'fill-deep-rgb'];

test('there are seven themes, each with an id, a label and a three-colour swatch, and the default is the first', () => {
  assert.equal(THEMES.length, 7);
  assert.equal(new Set(THEMES.map(theme => theme.id)).size, 7);
  assert.equal(THEMES[0].id, DEFAULT_THEME);
  for (const theme of THEMES) {
    assert.ok(theme.label.length > 0);
    assert.equal(theme.swatch.length, 3);
    for (const color of theme.swatch) assert.match(color, /^#[0-9a-f]{6}$/);
  }
});

test('an unknown or missing saved theme is the default one', () => {
  for (const theme of THEMES) assert.equal(themeId(theme.id), theme.id);
  for (const bad of [undefined, null, '', 'neon', 42, '__proto__']) assert.equal(themeId(bad), DEFAULT_THEME);
});

for (const { id, swatch } of THEMES) {
  test(`${id}: defines every colour token and channel, and the channels are its hex colours`, () => {
    const t = themeTokens(id);
    for (const name of [...HEX, ...CHANNELS]) assert.ok(t[`--${name}`], `--${name} is missing`);
    for (const name of ['surface-0', 'surface-1', 'surface-2', 'surface-3', 'surface-sunken', 'accent', 'accent-lo', 'accent-2', 'accent-2-lo', 'arcane']) {
      assert.equal(t[`--${name}-rgb`], channels(t[`--${name}`]), `--${name}-rgb does not match --${name}`);
    }
    assert.equal(t['--text-rgb'], channels(t['--text']));
    assert.equal(t['--fill-rgb'].split(' ').length, 3);
    // the picker's swatch is drawn from the same colours
    assert.equal(swatch[0].toLowerCase(), t['--surface-1'].toLowerCase());
    assert.equal(swatch[1].toLowerCase(), t['--accent'].toLowerCase());
    assert.equal(swatch[2].toLowerCase(), t['--accent-2'].toLowerCase());
  });

  test(`${id}: text is readable (4.5:1) on the surfaces, controls have a visible edge (3:1), and accent-filled buttons keep their label legible`, () => {
    const t = themeTokens(id);
    for (const text of ['text', 'text-2', 'text-3']) {
      for (const surface of ['surface-0', 'surface-1', 'surface-2', 'surface-3', 'surface-4']) {
        assert.ok(contrast(t[`--${text}`], t[`--${surface}`]) >= 4.5, `--${text} on --${surface}: ${contrast(t[`--${text}`], t[`--${surface}`]).toFixed(2)}`);
      }
    }
    for (const surface of ['surface-1', 'surface-2', 'surface-3']) assert.ok(contrast(t['--text-4'], t[`--${surface}`]) >= 4.5, `--text-4 on --${surface}`);
    for (const surface of ['surface-1', 'surface-2']) assert.ok(contrast(t['--border-control'], t[`--${surface}`]) >= 3, `--border-control on --${surface}`);
    for (const surface of ['surface-2', 'surface-3']) {
      assert.ok(contrast(t['--accent-hi'], t[`--${surface}`]) >= 4.5, `--accent-hi on --${surface}`);
      assert.ok(contrast(t['--accent-2-hi'], t[`--${surface}`]) >= 4.5, `--accent-2-hi on --${surface}`);
    }
    assert.ok(contrast(t['--text-on-accent'], t['--accent']) >= 4.5, 'the label on an accent fill');
    // the label on a primary button: --text-on-fill, or --text-on-accent when the theme has no separate one, against the middle of the pane
    const fill = `#${t['--fill-rgb'].split(' ').map(n => Number(n).toString(16).padStart(2, '0')).join('')}`;
    const onFill = t['--text-on-fill']?.startsWith('#') ? t['--text-on-fill'] : t['--text-on-accent'];   // the default is var(--text-on-accent)
    assert.ok(contrast(onFill, fill) >= 4.5, 'the label on a primary button');
    // a theme that redefines the status colours (Daylight does) must keep them readable as text too
    for (const status of ['success', 'warning', 'danger', 'info']) {
      if (t[`--${status}`]) for (const surface of ['surface-1', 'surface-2', 'surface-3']) assert.ok(contrast(t[`--${status}`], t[`--${surface}`]) >= 4.5, `--${status} on --${surface}`);
    }
  });
}

test('the two fantasy themes carry their own serif display face', () => {
  for (const id of ['parchment', 'castle']) assert.match(themeTokens(id)['--font-display'], /Cormorant/, id);
  for (const id of ['moonlit', 'ember', 'verdant', 'tide', 'daylight']) assert.match(themeTokens(id)['--font-display'] ?? 'Outfit', /Outfit/, id);
});

test('the stylesheets name no theme outside themes.css, and no old violet literal is left behind', () => {
  for (const file of ['components.css', 'gm.css', 'panels.css', 'dialogs.css', 'player.css', 'planner.css', 'skin.css', 'skin-gm.css', 'skin-player.css']) {
    const source = css(file);
    const named = source.match(/data-theme='([a-z]+)'/g) ?? [];
    assert.equal(named.length, 0, `${file} names a theme: ${named}`);
    for (const literal of ['rgb(106 79 214', 'rgb(165 139 255', 'rgb(79 216 238', 'rgb(2 4 16', 'rgb(26 36 71', 'rgb(14 20 44']) {
      assert.equal(source.includes(literal), false, `${file} still has ${literal}`);
    }
  }
});
