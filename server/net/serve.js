// Production server: the built app, compressed once at startup and served from memory, plus the same realm (access
// control, HTTP routes, WebSocket hub) as the dev server. Same exported signature as the old server/serve.js.
//
// The dev server sends hundreds of unbundled, uncompressed modules to every phone that joins. This one sends a handful
// of minified, Brotli-compressed files that the phone then caches, so players are in the game in a second or two even
// on a busy router.
import { createServer } from 'node:http';
import { APP_ID, hardenHttpServer, httpServerOptions, loadSite } from './http.js';
import { lanAddresses } from './lan.js';
import { createRealm } from './realm.js';

/** Is a Realm Forge already answering on this port of this computer? (Used by the launchers.) */
export async function isAppRunning(port = 5173) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/__realm/status`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    return response.ok && (await response.json()).app === APP_ID;
  } catch { return false; }
}

/** Addresses for the console. The invite itself (QR code, table code) is shown in the app: secrets are never printed. */
export function printLinks(port, { lan = true } = {}) {
  console.log(`\n  GM screen:     http://localhost:${port}`);
  if (!lan) { console.log('  Players:       not reachable (the server only listens on this computer)\n'); return; }
  const addresses = lanAddresses();
  if (!addresses.length) console.log('  Players:       connect this computer to your Wi-Fi or router first.');
  for (const [index, entry] of addresses.entries()) {
    console.log(`  ${index === 0 ? 'Players:      ' : '               '} http://${entry.address}:${port}/player.html${entry.virtual ? '   (virtual adapter)' : ''}`);
  }
  console.log('  Players join with the QR code or the table code shown in the GM screen (Table tab, "Invite players").\n');
}

/**
 * @param {object} [options]
 * @param {number} [options.port]  0 picks a free port
 * @param {string} [options.root]  the built site (dist)
 * @param {string} [options.host]  address to listen on (default: all, so the phones can join)
 * @param {string|null} [options.dataDir]  where table.json lives (default .realm-data)
 * @param {'report-only'|'enforce'|'off'} [options.cspMode]
 * @param {boolean} [options.quiet]  no console output
 * @returns {Promise<{ port: number, close: () => Promise<void>, realm: object } | null>}  null when one is already running
 */
export async function startProductionServer({ port = 5173, root = 'dist', host = '0.0.0.0', dataDir, cspMode, quiet = false } = {}) {
  const say = (...args) => { if (!quiet) console.log(...args); };
  if (port !== 0 && await isAppRunning(port)) {
    say('\nMyth Guard is already running. Reusing the existing server.');
    if (!quiet) printLinks(port);
    return null;
  }
  const site = await loadSite(root);
  if (!site.has('/index.html') || !site.has('/player.html')) throw new Error('The built app is missing. Run "npm run build" first.');
  const realm = createRealm({ site, dataDir, cspMode });

  const server = createServer(httpServerOptions(), (request, response) => {
    realm.middleware(request, response, () => { response.writeHead(404, { 'Content-Length': '0' }); response.end(); });
  });
  hardenHttpServer(server);
  realm.attach(server);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', error => reject(/EADDRINUSE/.test(error.message)
        ? new Error(`Port ${port} is occupied by another service. Close that service before starting Myth Guard.`) : error));
      server.listen(port, host, resolve);
    });
  } catch (error) {
    await realm.close();
    throw error;
  }
  const actual = server.address().port;
  if (!quiet) {
    printLinks(actual);
    say('Keep this window open. Press Ctrl+C to stop the server.');
  }
  return {
    port: actual,
    realm,
    close: async () => {
      await realm.close();
      await new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });
    },
  };
}
