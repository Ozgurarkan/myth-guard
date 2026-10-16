// Adaptor that lets the WP4 client tests (test/gmLink, playerLink, facade) run against the REAL server instead of the fake hub:
//
//   WP4_HUB=real node --test test/gmLink.test.js test/playerLink.test.js
//
// It starts server/net/realm.js (real access control + real hub) on a loopback HTTP server, and hands the tests what a browser
// would have: a WebSocket class that sends the Origin header (and the rf-gm cookie for the GM role), and a fetch that sends
// Origin (and the rf-gm cookie on the GM-only asset requests). It returns the raw shape documented in wp4-table.js.
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createRealm } from '../server/net/realm.js';

export async function startRealHub(t, options = {}) {
  const assetLimits = options.assetQuota === undefined ? undefined : { maxBytes: options.assetQuota, maxAsset: options.assetQuota };
  const realm = createRealm({ dataDir: null, ...(assetLimits ? { assetLimits } : {}), ...options.realm });
  const server = createServer((request, response) => realm.middleware(request, response, () => { response.statusCode = 404; response.end(); }));
  realm.attach(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;

  // The GM page gets its credential from the first GET / (loopback + allowed Host).
  const first = await fetch(`${url}/`, { redirect: 'manual' });
  const gmCookie = first.headers.getSetCookie().map(line => line.split(';')[0]).find(pair => pair.startsWith('rf-gm='));
  if (!gmCookie) throw new Error('the real hub did not set the rf-gm cookie on GET /');

  const table = realm.access.table;
  if (options.mode) table.setMode(options.mode);

  t.after(async () => {
    await realm.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  });

  class RealSocket extends WebSocket {
    constructor(address, protocols) {
      const role = new URL(address).searchParams.get('role');
      super(address, protocols, { origin: url, headers: role === 'gm' ? { Cookie: gmCookie } : {} });
    }
  }

  const fetchImpl = (input, init = {}) => {
    const address = String(input?.url ?? input);
    if (address.startsWith('data:') || address.startsWith('blob:')) return fetch(input, init);
    const target = new URL(address, url);
    const headers = new Headers(init.headers ?? {});
    headers.set('Origin', url);
    if (target.pathname.startsWith('/__realm/assets/') && (init.method ?? 'GET') !== 'GET') headers.set('Cookie', gmCookie);
    return fetch(target, { ...init, headers });
  };

  return {
    fake: false,
    realm,
    url,
    WebSocketClass: RealSocket,
    fetchImpl,
    invite: () => {
      table.inviteShown(); // a typed code is only accepted while the GM is looking at the invite dialog
      const current = realm.access.internals.invite.current();
      return { secret: current.secret, code: current.code };
    },
    setMode: mode => table.setMode(mode),
    admit: device => table.admit(device),
    deny: device => table.deny(device),
    kick: device => table.kick(device),
    rotate: () => table.rotate(),
    closeAll: (code, role) => {
      for (const session of realm.hub.sessions.all()) if (!role || session.role === role) session.close(code);
    },
  };
}
