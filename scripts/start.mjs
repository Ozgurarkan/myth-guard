// START.bat entry point: build when the source changed, then serve the build.
// Falls back to the development server if the build cannot be made.
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startProductionServer } from '../server/net/serve.js';
import { startDevServer, isAppRunning, printLinks } from '../server/devLauncher.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT) || 5173;

async function newestSourceTime() {
  let newest = 0;
  const visit = async path => {
    let info;
    try { info = await stat(path); } catch { return; }
    if (info.isDirectory()) {
      for (const name of await readdir(path)) await visit(join(path, name));
    } else newest = Math.max(newest, info.mtimeMs);
  };
  for (const name of ['src', 'index.html', 'player.html', 'vite.config.js', 'package.json']) await visit(join(root, name));
  return newest;
}

async function buildIsFresh() {
  try {
    const built = Math.min((await stat(join(root, 'dist', 'index.html'))).mtimeMs, (await stat(join(root, 'dist', 'player.html'))).mtimeMs);
    return built >= await newestSourceTime();
  } catch { return false; }
}

async function main() {
  if (await isAppRunning(port)) {
    console.log('\nMyth Guard is already running. Reusing the existing server.');
    printLinks(port);
    return;
  }
  let server = null;
  try {
    if (!(await buildIsFresh())) {
      console.log('\nPreparing Myth Guard (this takes a few seconds after an update)...');
      const { build } = await import('vite');
      await build({ root, logLevel: 'warn' });
      console.log('Ready.');
    }
    server = await startProductionServer({ port, root: join(root, 'dist') });
  } catch (error) {
    if (/occupied/.test(error.message)) throw error;
    console.error(`\nThe fast build could not be used (${error.message}). Starting the development server instead.`);
    server = await startDevServer();
  }
  if (server) {
    const stop = async () => { await server.close(); process.exit(0); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
}

main().catch(error => {
  console.error(`\nCould not start Myth Guard: ${error.message}`);
  process.exitCode = 1;
});
