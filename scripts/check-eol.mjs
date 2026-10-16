#!/usr/bin/env node
/**
 * Line-ending guard (design 7.10).
 *
 * The tree is mixed on purpose: 30 files are CRLF, 2 are mixed, everything else is LF (new files are LF).
 * Editors and tools silently normalise line endings, so every engineer runs this before and after editing.
 *
 *   node scripts/check-eol.mjs                   scan the whole tree; exit 1 on any violation
 *   node scripts/check-eol.mjs <file> [<file>]   print the style of these files and whether it is the expected one
 *   node scripts/check-eol.mjs --list            list every file with its style
 *
 * Rules (expected style):
 *   - files in CRLF_FILES must be CRLF            (a file that no longer exists is only noted: it may have been replaced)
 *   - files in MIXED_FILES must stay mixed        (convert nothing, edit carefully)
 *   - every other text file must be LF
 * Lone CR characters (old Mac style) are a violation, except the one known stray CR in src/styles/dialogs.css.
 * Files without any line break are fine in any style.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slashes = text => text.split(path.sep).join('/');

// Measured on 2026-10-13 by reading the bytes (design 7.10). Do not "fix" this list to match a changed file.
export const CRLF_FILES = new Set([
  'scripts/check-audio-browser.mjs', 'scripts/dev.mjs', 'server/assetStore.js', 'src/App.jsx', 'src/assetPublisher.js',
  'src/audio/receiveAudio.js', 'src/canvas/MapStage.jsx',
  'src/gm/CanvasOverlays.jsx', 'src/gm/ContextMenu.jsx', 'src/gm/Keyboard.jsx', 'src/gm/Sidebar.jsx', 'src/gm/StatusBar.jsx',
  'src/gm/Toolbar.jsx', 'src/gm/ToolOptions.jsx', 'src/gm/workspace.jsx', 'src/gm/panels/SpellsPanel.jsx', 'src/gm/sceneActions.js',
  'src/modals/AddTokenModal.jsx', 'src/modals/ImageCropper.jsx', 'src/modals/ImagePicker.jsx', 'src/modals/ImageViewer.jsx',
  'src/player/InitiativeBar.jsx', 'src/player/JoinGate.jsx', 'src/player/PlayerMap.jsx', 'src/PlayerApp.jsx',
  'src/styles/dialogs.css', 'src/ui.jsx', 'test/assetStore.test.js', 'test/audio.test.js', 'vite.config.js',
]);
export const MIXED_FILES = new Set(['src/gm/Header.jsx', 'test/sessionSync.test.js']);
// One file already had a stray CR (a CR CR LF sequence) in the original; it is tolerated exactly once and no more.
export const KNOWN_LONE_CR = new Map([['src/styles/dialogs.css', 1]]);

const TEXT = /\.(js|jsx|mjs|cjs|css|html|md|bat|ps1|json)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.npm-cache', '.tools', 'artifacts', '.claude', '.git', '.realm-data']);

/** Classify a file's bytes: 'crlf' | 'lf' | 'mixed' | 'none' (no line break), plus the count of lone CR characters. */
export function styleOf(buffer) {
  let crlf = 0, lf = 0, cr = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const b = buffer[i];
    if (b === 0x0d) {
      if (buffer[i + 1] === 0x0a) { crlf += 1; i += 1; } else cr += 1;
    } else if (b === 0x0a) lf += 1;
  }
  const style = crlf && lf ? 'mixed' : crlf ? 'crlf' : lf ? 'lf' : 'none';
  return { style, crlf, lf, cr };
}

export function expectedStyle(rel) {
  if (CRLF_FILES.has(rel)) return 'crlf';
  if (MIXED_FILES.has(rel)) return 'mixed';
  return 'lf';
}

/** -> { rel, style, expected, ok, note } */
export function checkFile(rel, root = ROOT) {
  const full = path.join(root, rel);
  const expected = expectedStyle(rel);
  if (!fs.existsSync(full)) {
    // Replaced or deleted files are fine (7.11); a listed CRLF file that is gone is only noted.
    return { rel, style: 'missing', expected, ok: true, note: 'does not exist' };
  }
  const { style, cr } = styleOf(fs.readFileSync(full));
  let ok = style === 'none' || style === expected;
  let note = '';
  if (cr > (KNOWN_LONE_CR.get(rel) || 0)) { ok = false; note = `${cr} lone CR character(s)`; }
  else if (!ok) note = `expected ${expected.toUpperCase()}`;
  return { rel, style, expected, ok, note };
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.backup')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (TEXT.test(entry.name)) yield full;
  }
}

export function scan(root = ROOT) {
  const results = [];
  const seen = new Set();
  for (const full of walk(root)) {
    const rel = slashes(path.relative(root, full));
    seen.add(rel);
    results.push(checkFile(rel, root));
  }
  for (const rel of [...CRLF_FILES, ...MIXED_FILES]) if (!seen.has(rel)) results.push(checkFile(rel, root));
  return results.sort((a, b) => a.rel.localeCompare(b.rel));
}

function main(argv) {
  const list = argv.includes('--list');
  const files = argv.filter(a => !a.startsWith('--'));
  const explicit = files.length > 0;
  // Paths on the command line are relative to the current directory (or absolute).
  const results = explicit
    ? files.map(f => {
      const abs = path.resolve(process.cwd(), f);
      const rel = slashes(path.relative(ROOT, abs));
      // A file outside the project is checked against the default rule (LF) by its absolute path.
      return rel.startsWith('..') || path.isAbsolute(rel) ? { ...checkFile(path.basename(abs), path.dirname(abs)), rel: abs } : checkFile(rel);
    })
    : scan();
  let bad = 0;
  for (const r of results) {
    if (!r.ok) bad += 1;
    if (explicit || list || !r.ok) {
      console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.style.toUpperCase().padEnd(7)} ${r.rel}${r.note ? `  (${r.note})` : ''}`);
    }
  }
  if (!explicit) {
    const count = s => results.filter(r => r.style === s).length;
    console.log(`check-eol: ${results.length} files: CRLF ${count('crlf')}, mixed ${count('mixed')}, LF ${count('lf')}, no line break ${count('none')}, missing ${count('missing')}; violations ${bad}`);
  }
  if (bad) {
    console.error(`check-eol: ${bad} file(s) have a line-ending style that differs from design 7.10. Restore the original style (do not convert).`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
