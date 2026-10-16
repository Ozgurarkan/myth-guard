#!/usr/bin/env node
/**
 * Does the player page load, join the table and render, without a console error? (headless Edge, design 6.4 "Static checks")
 *
 *   node scripts/check-player-browser.mjs                  starts its own private server on a free port (never port 5173), joins by invite link
 *   node scripts/check-player-browser.mjs --block-app      the app bundle is blocked: the page must show its "could not load / Reload player view" screen
 *   node scripts/check-player-browser.mjs <url> [--invite <S>]   check an already running server, e.g. http://192.168.1.20:5173/player.html;
 *                                                          without --invite the page is opened as a device that has not joined (the join gate)
 *   --name <text>  name typed into the join gate (default "Check")
 *
 * New join flow (design 4.3 / 3.9): the page is opened at player.html#join=<invite secret>, asks for a name, and joins.
 * Exit code 0 = no page error, no console error, no HTTP error >= 400, and the player screen is on display.
 */
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { launch, sleep } from '../test-support/cdp.js';
import { ServerUnavailable, ensureBuilt, fetchInvite, startSiteServer } from '../test-support/table.js';

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const explicitUrl = args.find((a, i) => !a.startsWith('--') && !['--invite', '--name'].includes(args[i - 1]));
const blockApp = flag('block-app');
const name = option('name', 'Check');

let site = null;
let browser = null;
try {
  let url = explicitUrl;
  let secret = option('invite', null);
  if (!url) {
    await ensureBuilt();
    site = await startSiteServer({ host: '127.0.0.1' });
    url = `http://localhost:${site.port}/player.html`;
    if (!blockApp) secret = (await fetchInvite(site)).secret ?? secret;
  }
  browser = await launch();
  const hash = secret && !blockApp ? `#join=${secret}` : '';
  const page = await browser.page(url + hash);
  if (blockApp) {
    await browser.cmd('Network.setBlockedURLs', { urls: ['*/src/playerMain.jsx*', '*/assets/playerMain-*.js'] }, page);
    await browser.cmd('Page.reload', {}, page);
  }
  await browser.waitFor(page, `Boolean(document.querySelector('.player-page, .gate')) || document.body.innerText.includes('could not load')`, 20000, 'the player page to render').catch(() => {});

  // the join gate: type a name and take a seat
  if (!blockApp && await browser.eval(page, `Boolean(document.querySelector('input[placeholder*="name" i]'))`)) {
    await browser.eval(page, `(() => {
      const input = document.querySelector('input[placeholder*="name" i]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(name)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(100);
    await browser.click(page, /take your seat|join|enter|save/i);
    if (secret) await browser.waitFor(page, `Boolean(document.querySelector('.player-page'))`, 20000, 'the player screen after joining').catch(() => {});
    await sleep(800);
  }
  const details = JSON.parse(await browser.eval(page, `JSON.stringify({ title: document.title, text: document.body.innerText.slice(0, 400), playerPage: Boolean(document.querySelector('.player-page')), gate: Boolean(document.querySelector('.gate')), canvases: document.querySelectorAll('canvas').length, rootChildren: document.getElementById('root')?.children.length ?? 0 })`));
  const raw = browser.problems(page);
  const counts = new Map(raw.map(item => [item, raw.filter(x => x === item).length]));
  const problems = [...counts].map(([item, n]) => (n > 1 ? `${item} (x${n})` : item));
  console.log('URL:', url + hash.replace(/#join=.+/, '#join=<invite>'));
  console.log('PAGE:', JSON.stringify(details));
  console.log('ERRORS:', JSON.stringify(problems));
  const shot = await browser.cmd('Page.captureScreenshot', { format: 'png' }, page);
  const shotPath = join(tmpdir(), 'realm-forge-player-check.png');
  await writeFile(shotPath, Buffer.from(shot.data, 'base64'));
  console.log('SCREENSHOT:', shotPath);

  let ok;
  if (blockApp) ok = details.text.includes('could not load') && details.text.includes('Reload player view');
  else if (!secret) ok = problems.length === 0 && details.rootChildren > 0 && (details.gate || details.playerPage);
  else ok = problems.length === 0 && details.playerPage && details.rootChildren > 0;
  console.log(ok ? 'check-player-browser: PASS' : 'check-player-browser: FAIL');
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  if (error instanceof ServerUnavailable) console.error(error.message);
  else console.error('check-player-browser:', error.message);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await site?.close();
}
process.exit(process.exitCode ?? 0);
