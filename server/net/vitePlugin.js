// The realm inside the Vite dev / preview server: access control, HTTP routes and the WebSocket hub, in front of Vite's
// own middleware. Same role as `sessionSyncPlugin` of the old server/sessionSync.js.
//
//   import { realmVitePlugin } from './server/net/vitePlugin.js'
//   plugins: [react(), realmVitePlugin()]
//
// The dev server serves the whole project folder (src, server, package.json...), so it listens on 127.0.0.1 only,
// unless it is started with `--lan` (or REALM_LAN=1). `--lan` is for testing phones against the dev server; the router
// then still refuses the sensitive paths (see http.js) and every request still passes the Host allowlist.
import { hardenHttpServer } from './http.js';

/** True when the dev server was asked to listen on the network. */
export const lanRequested = (argv = process.argv, env = process.env) => argv.includes('--lan') || env.REALM_LAN === '1';

/** Vite's own `server.fs.deny` replaces its default list when set, so the defaults are repeated here. */
const fsDeny = root => [
  '.env', '.env.*', '*.{crt,pem}', '**/.git/**',
  '**/.realm-data/**', '**/.backup*/**', `${root}/server/**`, `${root}/test/**`, `${root}/test-support/**`, `${root}/scripts/**`, `${root}/docs/**`,
];

/**
 * @param {object} [options]
 * @param {boolean} [options.lan]  listen on all interfaces (default: only when --lan / REALM_LAN=1)
 * @param {object} [options.realm]  options for createRealm (dataDir, ...)
 * @param {(options: object) => object} [options.createRealm]  injected for tests; default is ./realm.js
 */
export function realmVitePlugin(options = {}) {
  const lan = options.lan ?? lanRequested();
  let realm = null;

  const configure = async server => {
    const make = options.createRealm ?? (await import('./realm.js')).createRealm;
    realm = make({ cspMode: 'off', ...(options.realm ?? {}) });
    const http = server.httpServer;
    if (http) {
      hardenHttpServer(http);
      realm.attach(http);
      http.once('close', () => { realm?.close?.(); });
    }
    // First in the stack: Host allowlist, GM cookie, realm routes and the path guard run before Vite sees the request.
    server.middlewares.use(realm.middleware);
  };

  return {
    name: 'realm-forge-net',
    config(userConfig) {
      const root = String(userConfig?.root ?? process.cwd()).replace(/\\/g, '/').replace(/\/$/, '');
      const host = lan ? '0.0.0.0' : '127.0.0.1';
      return { server: { host, fs: { deny: fsDeny(root) } }, preview: { host } };
    },
    configureServer: configure,
    configurePreviewServer: configure,
    get realm() { return realm; },
  };
}
