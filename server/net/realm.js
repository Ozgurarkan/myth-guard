// Everything one table needs: access control and HTTP (WP2), the WebSocket hub (this package), one clock, one metrics sink.
//
// This replaces createRealm / attachSessionSync / sessionSyncPlugin / PROTOCOL of server/sessionSync.js, with the same names:
//
//   const realm = createRealm({ dataDir });
//   server = http.createServer((req, res) => realm.middleware(req, res, notFound));
//   const stop = realm.attach(server);      // 'upgrade' handler for /__realm/ws and /__realm/audio; stop() closes the hub
//
// `access` (design 7.2) is created here from ./access.js unless the caller passes one (tests pass a fake).
import { PROTOCOL_VERSION } from '../../src/net/protocol.js';
import { createClock } from './clock.js';
import { createMetrics } from './status.js';
import { createHub, LEGACY_PATH, LEGACY_MESSAGE } from './hub.js';
import { createLan } from './lan.js';
import { createAudioSignal } from './audioSignal.js';

export const PROTOCOL = PROTOCOL_VERSION;

// ./access.js is WP2's composition module. It is loaded lazily so this file (and its tests, which pass a fake access)
// also works before it exists; createRealm reports a clear error if neither is available.
const accessModule = await import('./access.js').catch(error => (error?.code === 'ERR_MODULE_NOT_FOUND' ? null : Promise.reject(error)));

/**
 * @param {object} [options]
 * @param {object} [options.access]      a ready access object (design 7.2); otherwise createAccess(options) from ./access.js
 * @param {object} [options.clock]       defaults to the real clock
 * @param {object} [options.metrics]     defaults to createMetrics(clock) (or access.metrics when access is given)
 * @param {Array<object>} [options.extensions]  hub extensions (audio signalling, ...)
 * @param {object} [options.hub]         extra createHub options (limits, revBase)
 * @returns {{ middleware, attach, close, hub, access, metrics, clock }}
 */
export function createRealm(options = {}) {
  const clock = options.clock ?? createClock();
  let hub = null; // the pin callback below needs the hub, which needs access
  let access = options.access ?? null;
  let metrics = options.metrics ?? access?.metrics ?? null;
  if (!access) {
    if (!accessModule?.createAccess) throw new Error('createRealm: server/net/access.js is not available; pass options.access');
    metrics ??= createMetrics(clock);
    access = accessModule.createAccess({
      ...options,
      clock,
      metrics,
      projectAssetsPinned: () => hub?.pinnedHashes() ?? new Set(),
    });
  }
  metrics ??= access.metrics ?? createMetrics(clock);
  hub = createHub({ ...(options.hub ?? {}), access, metrics, clock, extensions: options.extensions ?? [] });
  // Sound: WebRTC signalling and the WebSocket fallback relay plug into the hub (pass audio: false to leave them out).
  const lan = options.lan ?? createLan();
  const audio = options.audio === false ? null
    : createAudioSignal({ hub, access, metrics, clock, lan: { lanAddresses: () => lan.addresses() }, options: options.audioOptions });

  const route = typeof access.router === 'function' ? access.router : (request, response, next) => next();
  // A phone with a cached v2 page asks for the old WebSocket path: tell it plainly to reload.
  const middleware = (request, response, next) => {
    const path = String(request.url ?? '').split('?')[0];
    if (path === LEGACY_PATH) {
      response.statusCode = 426;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.end(LEGACY_MESSAGE);
      return;
    }
    return route(request, response, next);
  };

  const realm = {
    middleware,
    attach: httpServer => hub.attach(httpServer),
    /** Closes the hub (sockets get 4010) and then whatever access owns. */
    async close() {
      try { audio?.close?.(); } catch { /* ignore */ }
      await hub.close();
      try { await access.close?.(); } catch { /* ignore */ }
    },
    hub,
    audio,
    access,
    metrics,
    clock,
    /** Where the player-facing asset store lives (the Vite plugin and serve.js read it). */
    get assets() { return access.assets; },
  };
  return realm;
}

/** WebSocket half only, for callers that bring their own HTTP handling. Returns the function that stops it. */
export function attachSessionSync(httpServer, options = {}) {
  return createRealm(options).attach(httpServer);
}

/** Vite plugin: the same realm inside the dev / preview server (server/net/vitePlugin.js may wrap this). */
export function sessionSyncPlugin(options = {}) {
  const realm = createRealm(options);
  const configure = server => {
    realm.attach(server.httpServer);
    server.middlewares.use(realm.middleware);
  };
  return {
    name: 'realm-forge-session-sync',
    configureServer: configure,
    configurePreviewServer: configure,
  };
}
