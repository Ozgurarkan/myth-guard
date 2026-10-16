import { startDevServer } from '../server/devLauncher.js';

try {
  const server = await startDevServer();
  if (server) {
    const stop = async () => { await server.close(); process.exit(0); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
} catch (error) {
  console.error(`\nCould not start Myth Guard: ${error.message}`);
  process.exitCode = 1;
}
