// The logos and illustrations follow the theme: the SVG artwork is painted with theme variables, and every theme has its own set of
// empty-state illustrations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { themedSvg, resolvedSvg, ARTWORK_COLORS } from '../src/logoSvg.js';
import { THEMES, DEFAULT_THEME } from '../src/theme.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const ARTWORK = { mark: read('src/assets/brand/mark.svg'), seal: read('src/assets/brand/seal.svg'), favicon: read('src/assets/brand/favicon.svg') };

test('the inline copies of the artwork are the files in public/', () => {
  assert.equal(ARTWORK.mark, read('public/brand/mark.svg'));
  assert.equal(ARTWORK.seal, read('public/brand/seal.svg'));
  assert.equal(ARTWORK.favicon, read('public/favicon.svg'));
});

for (const [name, svg] of Object.entries(ARTWORK)) {
  test(`${name}: every themeable colour in the artwork becomes a variable, and nothing is left in the old violet`, () => {
    const themed = themedSvg(svg, 'u1');
    for (const colour of ARTWORK_COLORS) assert.equal(themed.includes(`"${colour}"`), false, `${colour} is still in the ${name}`);
    assert.equal(/fill="rgb\(/.test(themed), false, 'no literal rgb() fills are left');
    assert.match(themed, /var\(--logo-a\)/);
    assert.match(themed, /var\(--logo-spark\)/);
    assert.equal((themed.match(/<path/g) ?? []).length, (svg.match(/<path/g) ?? []).length, 'no shape was lost');
  });
}

test('the seal\'s rings and glow, and the favicon\'s tile, take the theme\'s accent and surface', () => {
  const seal = themedSvg(ARTWORK.seal, 'u1');
  assert.match(seal, /stroke="var\(--accent\)"/);
  assert.match(seal, /stroke="var\(--accent-hi\)"/);
  assert.match(seal, /stop-color="var\(--accent-lo\)"/);
  assert.match(themedSvg(ARTWORK.favicon, 'u1'), /<rect[^>]*fill="var\(--surface-1\)"/);
});

test('two copies on one page do not share ids, and every reference points at its own', () => {
  const a = themedSvg(ARTWORK.seal, 'a1'), b = themedSvg(ARTWORK.seal, 'b2');
  const idsOf = svg => [...svg.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.ok(idsOf(a).length >= 2);
  assert.equal(idsOf(a).some(id => idsOf(b).includes(id)), false);
  for (const id of [...a.matchAll(/url\(#([^)]+)\)/g)].map(match => match[1])) assert.ok(idsOf(a).includes(id), `${id} has no target`);
  assert.match(a, /^<svg[^>]* width="100%" height="100%"/, 'the root fills its box');
});

test('resolving the variables leaves a plain SVG the favicon can use', () => {
  const plain = resolvedSvg(themedSvg(ARTWORK.favicon, 'fav'), name => ({ '--surface-1': '#17110e' }[name] ?? '#ffa94d'));
  assert.equal(/var\(/.test(plain), false);
  assert.match(plain, /fill="#17110e"/);
});

test('the logo tones come from the theme\'s fill colours, so every theme (which sets those) repaints the mark', () => {
  const tokens = read('src/styles/tokens.css');
  for (const name of ['logo-a', 'logo-b', 'logo-c', 'logo-d', 'logo-spark', 'logo-moon']) assert.match(tokens, new RegExp(`--${name}:`), name);
  const themes = read('src/styles/themes.css');
  for (const theme of THEMES.filter(item => item.id !== DEFAULT_THEME)) {
    const block = themes.slice(themes.indexOf(`:root[data-theme='${theme.id}']`));
    for (const name of ['--fill-rgb', '--fill-lo-rgb', '--fill-deep-rgb', '--accent-2']) assert.ok(block.slice(0, 2400).includes(name), `${theme.id} sets ${name}`);
  }
});

test('every theme has its own empty-state illustrations (scripts/build-themed-art.py makes them)', () => {
  for (const theme of THEMES.filter(item => item.id !== DEFAULT_THEME)) {
    for (const art of ['door', 'lantern', 'scroll', 'token']) {
      assert.ok(existsSync(new URL(`../public/brand/themed/empty-${art}.${theme.id}.png`, import.meta.url)), `empty-${art}.${theme.id}.png`);
    }
  }
  for (const art of ['door', 'lantern', 'scroll', 'token']) assert.ok(existsSync(new URL(`../public/brand/empty-${art}.png`, import.meta.url)), `the original ${art}`);
});

test('the grey Castle theme is the one with the stone texture', () => {
  const themes = read('src/styles/themes.css');
  const castle = themes.slice(themes.indexOf('/* Castle: cut stone'));
  assert.match(castle, /--stone: url\("data:image\/svg\+xml/);
  assert.match(castle, /feTurbulence/);
  assert.match(castle, /mix-blend-mode: overlay/);
  assert.equal(themes.slice(0, themes.indexOf('/* Castle: cut stone')).includes('--stone'), false, 'no other theme has it');
});


test('Parchment is the theme with the paper texture, and the stone and the paper stay apart', () => {
  const themes = read('src/styles/themes.css');
  const paperAt = themes.indexOf('/* Parchment: paper.'), stoneAt = themes.indexOf('/* Castle: cut stone');
  assert.ok(paperAt > 0 && stoneAt > 0);
  const paper = themes.slice(paperAt, themes.indexOf('/* Light themes:'));
  assert.match(paper, /--paper: url\("data:image\/svg\+xml/);
  assert.match(paper, /feTurbulence/);
  assert.match(paper, /mix-blend-mode: multiply/);
  assert.match(paper, /\.header, \.tab-rail, \.panel/, 'the panes get it');
  assert.equal(themes.slice(stoneAt).includes('--paper'), false, 'Castle has no paper');
  assert.equal(themes.slice(0, paperAt).includes('--paper'), false, 'no other theme has paper');
  assert.equal(paper.includes('--stone'), false);
});
