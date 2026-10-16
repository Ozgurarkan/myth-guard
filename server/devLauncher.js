import { createServer } from 'vite';
import { lanAddresses } from './net/lan.js';
import { APP_ID } from './net/http.js';

export async function isAppRunning(port = 5173) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/__realm/status`, {
      signal: AbortSignal.timeout(1500),
      redirect: 'error',
    });
    return response.ok && (await response.json()).app === APP_ID;
  } catch { return false; }
}

export function printLinks(port) {
  console.log(`\n  GM screen:     http://localhost:${port}`);
  const addresses = lanAddresses();
  if (!addresses.length) console.log('  Players:       connect this computer to your Wi-Fi or router first.');
  for (const [index, entry] of addresses.entries()) {
    console.log(`  ${index === 0 ? 'Players:      ' : '               '} http://${entry.address}:${port}/player.html${entry.virtual ? '   (virtual adapter)' : ''}`);
  }
  console.log('');
}

function printExisting(port) {
  console.log('\nMyth Guard is already running. Reusing the existing server.');
  printLinks(port);
  console.log('You can close this launcher; the existing server will keep running.\n');
}

export async function startDevServer(config = {}) {
  const port = config.server?.port ?? 5173;
  if (await isAppRunning(port)) { printExisting(port); return null; }
  const server = await createServer({ ...config,
    // Separate servers must not overwrite the live server's optimized dependencies.
    cacheDir: config.cacheDir ?? `node_modules/.vite/realm-forge-${port}`,
    server: { ...config.server, port, strictPort: true },
  });
  try {
    await server.listen();
  } catch (error) {
    await server.close();
    // Two launchers can race; the first may have finished starting meanwhile.
    if (await isAppRunning(port)) { printExisting(port); return null; }
    if (/already in use|EADDRINUSE/.test(error.message)) {
      throw new Error(`Port ${port} is occupied by another service. Close that service before starting Myth Guard.`);
    }
    throw error;
  }
  printLinks(port);
  console.log('Keep this window open. Press Ctrl+C to stop the server.');
  return server;
}
