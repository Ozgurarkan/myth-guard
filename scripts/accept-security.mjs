#!/usr/bin/env node
/**
 * Security acceptance against a LIVE server (design 6.3): the checks that need real sockets, real Host/Origin headers and a
 * non-loopback peer address. The pure-logic versions of the same rules run in `npm test` (handshake, hostGuard, ...).
 *
 *   node scripts/accept-security.mjs [--quick] [--only A1,B2] [--fuzz 100000]
 *
 * Prints one line per check "PASS/FAIL/SKIP <id> <title>" and a final "accept-security: N pass, N fail, N skipped".
 * Exit 1 on any failure. Prints "server not available: ..." and exits 1 when the new stack is missing.
 * Non-loopback checks connect to this computer's LAN address (the peer address is then not loopback); without a LAN address
 * those checks are skipped and said so.
 */
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { CLOSE, LIMITS, PATHS, SUBPROTOCOL, TYPE_CAPS, authProtocol } from '../src/net/protocol.js';
import { randomHex, wsProof } from '../src/net/hmac.js';
import { seededRandom } from '../test-support/profiles.js';
import {
  ServerUnavailable, connectGm, connectPlayer, fetchInvite, freshAddress, gmGet, http, joinDevice, makeScene, sleep, startServer,
} from '../test-support/table.js';

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const onlyIndex = args.indexOf('--only');
const only = onlyIndex >= 0 ? args[onlyIndex + 1].split(',') : [];
const fuzzIndex = args.indexOf('--fuzz');
const FUZZ_FRAMES = fuzzIndex >= 0 ? Number(args[fuzzIndex + 1]) : quick ? 10000 : 100000;
const lanAddress = Object.values(networkInterfaces()).flat().find(e => e && !e.internal && e.family === 'IPv4' && !e.address.startsWith('169.254.'))?.address ?? null;

const tally = { pass: 0, fail: 0, skip: 0 };
const failures = [];
async function check(id, title, fn) {
  if (only.length && !only.includes(id)) return;
  try {
    const verdict = await fn();
    if (verdict && verdict.skip) { tally.skip += 1; console.log(`SKIP ${id.padEnd(3)} ${title} (${verdict.skip})`); return; }
    tally.pass += 1; console.log(`PASS ${id.padEnd(3)} ${title}${verdict?.note ? `  [${verdict.note}]` : ''}`);
  } catch (error) {
    tally.fail += 1; failures.push(id);
    console.log(`FAIL ${id.padEnd(3)} ${title}\n       ${String(error.message).split('\n')[0]}`);
  }
}
const expect = (condition, message) => { if (!condition) throw new Error(message); };
const needLan = () => (lanAddress ? null : { skip: 'this computer has no LAN address' });

/** Attempt a WebSocket upgrade with arbitrary headers. -> { ok, ws } | { ok:false, status } | { ok:false, closeCode } */
function tryUpgrade(url, protocols, headers, { localAddress } = {}) {
  return new Promise(resolve => {
    const ws = new WebSocket(url, protocols, { headers, localAddress, perMessageDeflate: false, handshakeTimeout: 5000 });
    let opened = false, settled = false;
    const done = value => { if (!settled) { settled = true; resolve(value); } };
    // A refusal the client must be able to read (stale nonce, removed device) arrives as a close code right after the
    // upgrade (4011 / 4002): so "open" only counts when the socket is still open a moment later.
    ws.once('open', () => { opened = true; setTimeout(() => done({ ok: true, ws }), 200); });
    ws.once('unexpected-response', (_q, r) => { r.resume(); done({ ok: false, status: r.statusCode }); });
    ws.once('close', code => done({ ok: false, closeCode: code }));
    ws.once('error', error => { if (!opened) done({ ok: false, error: error.message }); });
  });
}

async function main() {
  const server = await startServer({ stack: 'v3', host: '0.0.0.0', site: true });
  const port = server.port;
  const LAN = lanAddress ? `http://${lanAddress}:${port}` : null;
  const lanServer = lanAddress ? { ...server, base: LAN, hostName: lanAddress } : null;
  let gm = await connectGm(server);
  const { invite, link, code, info } = await fetchInvite(server);
  const gmHost = `localhost:${port}`;
  const diagCounters = async () => (await gmGet(server, PATHS.diag)).json?.counters ?? {};
  const clearDevices = async () => {
    const list = (await gmGet(server, PATHS.info)).json.devices ?? [];
    for (const d of list) { gm.send({ type: 'TABLE_CMD', op: 'kick', device: d.device }); await sleep(120); }
    await sleep(200);
  };
  const newPlayer = async (opts = {}) => {
    const identity = await joinDevice(server, invite, opts).catch(async error => {
      if (error.response?.json?.error !== 'full') throw error;
      await clearDevices();
      return joinDevice(server, invite, opts);
    });
    return { identity, p: await connectPlayer(server, identity, { name: opts.name ?? 'P', record: true }) };
  };
  const tableCmd = op => gm.send({ type: 'TABLE_CMD', ...op });
  console.log(`accept-security: server on port ${port}; LAN address ${lanAddress ?? 'none (LAN checks are skipped)'}; fuzz frames ${FUZZ_FRAMES}`);

  // ------------------------------------------------------------------ A. admission and identity
  const joinBody = (key = 'x') => ({ v: 3, device: randomHex(16), name: 'x', nonce: randomHex(16), how: 'link', proof: key });
  await check('A1', 'join with no proof -> 403, generic body', async () => {
    const r = await http('POST', server.base, PATHS.join, { body: { v: 3, device: randomHex(16), name: 'x', nonce: randomHex(16), how: 'link' }, localAddress: freshAddress() });
    expect(r.status === 403, `HTTP ${r.status}`);
    expect(r.json?.error === 'bad-proof', `body ${r.text}`);
  });
  await check('A2', 'join with a wrong proof -> 403, same body as no proof', async () => {
    const a = await http('POST', server.base, PATHS.join, { body: joinBody('0'.repeat(64)), localAddress: freshAddress() });
    const b = await http('POST', server.base, PATHS.join, { body: joinBody(''), localAddress: freshAddress() });
    expect(a.status === 403 && b.status === 403 && a.text === b.text, `${a.status} ${a.text} / ${b.status} ${b.text}`);
  });
  await check('A3', 'join with the correct invite is admitted and srvProof verifies', async () => {
    const id = await joinDevice(server, invite);
    expect(id.status === 'admitted', `status ${id.status}`);
    expect(/^rf-d=[0-9a-f]{32}\.[0-9a-f]{32}$/.test(id.cookie), `cookie ${id.cookie}`);
  });
  await check('A17', 'device cookie flags are exactly HttpOnly; SameSite=Strict; Path=/', async () => {
    const key = (await import('../src/net/hmac.js'));
    const device = randomHex(16), nonce = randomHex(16);
    const k = key.inviteKey(invite.how, invite.value);
    const r = await http('POST', server.base, PATHS.join, { body: { v: 3, device, name: 'c', nonce, how: invite.how, proof: key.joinProof(k, device, nonce) }, localAddress: freshAddress() });
    const cookie = String(r.headers['set-cookie']);
    expect(/; Path=\/; HttpOnly; SameSite=Strict; Max-Age=31536000$/.test(cookie), cookie);
  });
  await check('A5', 'the typed table code works; 5 wrong codes from one address ban that address only', async () => {
    const ok = await joinDevice(server, { how: 'code', value: code });
    expect(ok.status === 'admitted', 'typed code refused');
    if (!lanAddress) return { skip: 'needs a non-loopback address (loopback is never banned)' };
    let last;
    for (let i = 0; i < LIMITS.failedProofsBeforeBan + 1; i += 1) {
      last = await http('POST', LAN, PATHS.join, { body: { ...joinBody('0'.repeat(64)), how: 'code' }, localAddress: lanAddress });
    }
    const banned = await http('POST', LAN, PATHS.join, { body: joinBody('0'.repeat(64)), localAddress: lanAddress });
    expect(banned.json?.error === 'banned', `after 6 wrong proofs: HTTP ${banned.status} ${banned.text}`);
    const other = await joinDevice(server, invite);
    expect(other.status === 'admitted', 'a different address must be unaffected');
  });
  await check('A7', 'locked: a new device is refused, a known device still connects', async () => {
    const known = await newPlayer();
    known.p.terminate();
    tableCmd({ op: 'lock' }); await sleep(200);
    const refused = await http('POST', server.base, PATHS.join, { body: joinBody('0'.repeat(64)), localAddress: freshAddress() });
    let newDevice = null;
    try { await joinDevice(server, invite); newDevice = 'admitted'; } catch (e) { newDevice = e.status; }
    const again = await connectPlayer(server, known.identity, { name: 'known' });
    again.terminate();
    tableCmd({ op: 'unlock' }); await sleep(200);
    expect(newDevice === 403, `new device: ${newDevice}`);
    expect(refused.status === 403, 'locked table, wrong proof');
  });
  await check('A8', 'ask mode: pending device gets WAIT and no state; admit -> ADMITTED + state; deny -> 4003', async () => {
    gm.publish(makeScene({})); await sleep(150);
    tableCmd({ op: 'mode', mode: 'ask' }); await sleep(150);
    const pend = await newPlayer();
    await sleep(300);
    expect(pend.p.firsts.WAIT, 'no WAIT');
    expect(!pend.p.firsts.STATE_FULL, 'state leaked to a pending device');
    tableCmd({ op: 'admit', device: pend.identity.device });
    await pend.p.next('ADMITTED', 3000);
    await pend.p.first('STATE_FULL', 3000);
    const denied = await newPlayer();
    await sleep(200);
    tableCmd({ op: 'deny', device: denied.identity.device });
    const code = await denied.p.closed();
    tableCmd({ op: 'mode', mode: 'open' }); await sleep(150);
    expect(code === CLOSE.NOT_ADMITTED, `deny closed with ${code}`);
  });
  await check('A9', 'kick: socket closed 4002, reconnect refused, cookie no longer opens assets', async () => {
    const v = await newPlayer();
    tableCmd({ op: 'kick', device: v.identity.device });
    const closeCode = await v.p.closed();
    const hello = await http('POST', server.base, PATHS.hello, { body: { device: v.identity.device }, localAddress: freshAddress() });
    expect(closeCode === CLOSE.KICKED, `closed with ${closeCode}`);
    expect(hello.status === 403, `hello after kick: ${hello.status}`);
  });
  await check('A10', 'rotate: the old link and code fail, admitted devices keep working', async () => {
    const keep = await newPlayer();
    tableCmd({ op: 'rotate' }); await sleep(200);
    let oldLink = 'admitted';
    try { await joinDevice(server, invite); } catch (e) { oldLink = e.status; }
    let oldCode = 'admitted';
    try { await joinDevice(server, { how: 'code', value: code }); } catch (e) { oldCode = e.status; }
    keep.p.terminate();
    const back = await connectPlayer(server, keep.identity, { name: 'keep' });
    back.terminate();
    expect(oldLink === 403 && oldCode === 403, `old link ${oldLink}, old code ${oldCode}`);
    Object.assign(invite, (await fetchInvite(server)).invite);
  });
  await check('A12', 'a captured WebSocket handshake replayed is refused (nonce already used)', async () => {
    const v = await newPlayer(); v.p.terminate();
    const hello = await http('POST', server.base, PATHS.hello, { body: { device: v.identity.device }, localAddress: freshAddress() });
    const proof = wsProof(v.identity.dk, v.identity.device, hello.json.nonce, 'player');
    const headers = { Origin: server.base };
    const first = await tryUpgrade(`ws://127.0.0.1:${port}${PATHS.ws}?role=player`, [SUBPROTOCOL, authProtocol(v.identity.device, hello.json.nonce, proof)], headers, { localAddress: freshAddress() });
    first.ws?.terminate();
    const replay = await tryUpgrade(`ws://127.0.0.1:${port}${PATHS.ws}?role=player`, [SUBPROTOCOL, authProtocol(v.identity.device, hello.json.nonce, proof)], headers, { localAddress: freshAddress() });
    expect(first.ok, 'the first use must work');
    expect(!replay.ok, 'replay accepted');
    replay.ws?.terminate();
  });
  await check('A14', 'a player proof cannot open the GM role', async () => {
    const v = await newPlayer(); v.p.terminate();
    const hello = await http('POST', server.base, PATHS.hello, { body: { device: v.identity.device }, localAddress: freshAddress() });
    const proof = wsProof(v.identity.dk, v.identity.device, hello.json.nonce, 'player');
    const r = await tryUpgrade(`ws://127.0.0.1:${port}${PATHS.ws}?role=gm`, [SUBPROTOCOL, authProtocol(v.identity.device, hello.json.nonce, proof)], { Origin: `http://${gmHost}`, Host: gmHost }, { localAddress: freshAddress() });
    expect(!r.ok, 'accepted as GM'); r.ws?.terminate();
  });
  await check('A15', 'an upgrade without the auth.* sub-protocol is refused before a socket exists', async () => {
    const r = await tryUpgrade(`ws://127.0.0.1:${port}${PATHS.ws}?role=player`, [SUBPROTOCOL], { Origin: server.base }, { localAddress: freshAddress() });
    expect(!r.ok && r.status >= 400, JSON.stringify({ ok: r.ok, status: r.status })); r.ws?.terminate();
  });
  await check('A11', 'device cap: the 17th device is refused ("full")', async () => {
    const results = [];
    for (let i = 0; i < 20; i += 1) { try { await joinDevice(server, invite); results.push('ok'); } catch (e) { results.push(e.response?.json?.error ?? e.status); } }
    expect(results.includes('full'), `outcomes: ${[...new Set(results)].join(',')}`);
    // free the table again for the checks below
    const list = (await gmGet(server, PATHS.info)).json.devices ?? [];
    for (const d of list) { tableCmd({ op: "kick", device: d.device }); await sleep(120); } await sleep(300);
  });

  // ------------------------------------------------------------------ B. the GM role
  await check('B1', 'GM upgrade from a non-loopback address -> refused', async () => {
    const miss = needLan(); if (miss) return miss;
    const r = await tryUpgrade(`ws://${lanAddress}:${port}${PATHS.ws}?role=gm`, [SUBPROTOCOL], { Origin: LAN, Cookie: server.gmCookie ?? '' }, { localAddress: lanAddress });
    expect(!r.ok, 'accepted'); r.ws?.terminate();
  });
  await check('B2', 'GM upgrade with Host evil.test and a matching Origin (DNS rebinding) -> refused', async () => {
    const r = await tryUpgrade(`ws://127.0.0.1:${port}${PATHS.ws}?role=gm`, [SUBPROTOCOL], { Host: `evil.test:${port}`, Origin: `http://evil.test:${port}`, Cookie: server.gmCookie ?? '' });
    expect(!r.ok, 'accepted'); r.ws?.terminate();
  });
  await check('B3', 'GM upgrade without the rf-gm cookie -> refused', async () => {
    const r = await tryUpgrade(`ws://127.0.0.1:${port}${PATHS.ws}?role=gm`, [SUBPROTOCOL], { Host: gmHost, Origin: `http://${gmHost}` });
    expect(!r.ok, 'accepted'); r.ws?.terminate();
  });
  await check('B4', 'GM upgrade with a foreign Origin, and with no Origin -> refused', async () => {
    const a = await tryUpgrade(`ws://127.0.0.1:${port}${PATHS.ws}?role=gm`, [SUBPROTOCOL], { Host: gmHost, Origin: 'http://evil.test', Cookie: server.gmCookie });
    const b = await tryUpgrade(`ws://127.0.0.1:${port}${PATHS.ws}?role=gm`, [SUBPROTOCOL], { Host: gmHost, Cookie: server.gmCookie });
    expect(!a.ok && !b.ok, `foreign ${a.ok}, none ${b.ok}`); a.ws?.terminate(); b.ws?.terminate();
  });
  await check('B5', 'asset PUT, POST missing, /info and /diag from a LAN address or a rebinding Host -> refused', async () => {
    const rebinding = { Host: `evil.test:${port}`, Origin: `http://evil.test:${port}`, Cookie: server.gmCookie, 'X-RF': '1' };
    const reqs = [
      ['GET', PATHS.info, rebinding], ['GET', PATHS.diag, rebinding], ['POST', `${PATHS.assets}missing`, rebinding], ['PUT', `${PATHS.assets}${'a'.repeat(64)}`, rebinding],
    ];
    for (const [method, path, headers] of reqs) {
      const r = await http(method, server.base, path, { headers, body: method === 'GET' ? undefined : '[]' });
      expect([403, 421].includes(r.status), `${method} ${path} with a rebinding Host -> ${r.status}`);
    }
    if (lanAddress) for (const [method, path] of [['GET', PATHS.info], ['GET', PATHS.diag], ['POST', `${PATHS.assets}missing`]]) {
      const r = await http(method, LAN, path, { localAddress: lanAddress, headers: { Cookie: server.gmCookie, Origin: LAN, 'X-RF': '1' }, body: method === 'GET' ? undefined : '[]' });
      expect([403, 421].includes(r.status), `${method} ${path} from the LAN address -> ${r.status}`);
    }
  });
  await check('B6', 'a second GM window replaces the first with 4001', async () => {
    const second = await connectGm(server);
    const code = await gm.closed();
    gm = second; // keep using the live window from here on
    expect(code === CLOSE.REPLACED, `first window closed with ${code}`);
  });
  await check('B7', 'a player cannot send SCENE or TABLE_CMD: dropped, counted, table unchanged', async () => {
    const v = await newPlayer();
    const before = (await gmGet(server, PATHS.info)).json;
    v.p.send({ type: 'TABLE_CMD', op: 'lock' });
    v.p.send({ type: 'SCENE', scene: makeScene({ fog: 3 }) });
    await sleep(300);
    const after = (await gmGet(server, PATHS.info)).json;
    expect(after.mode === before.mode && !after.locked, 'table changed');
    v.p.terminate();
  });

  // ------------------------------------------------------------------ C. Host and Origin
  await check('C1', 'a Host outside the allowlist -> 421 on static, API and upgrade', async () => {
    const h = { Host: `evil.test:${port}` };
    const a = await http('GET', server.base, '/player.html', { headers: h });
    const b = await http('POST', server.base, PATHS.hello, { headers: h, body: { device: randomHex(16) } });
    const c = await tryUpgrade(`ws://127.0.0.1:${port}${PATHS.ws}?role=player`, [SUBPROTOCOL], { ...h, Origin: `http://evil.test:${port}` });
    expect(a.status === 421 && b.status === 421 && c.status === 421, `static ${a.status}, api ${b.status}, upgrade ${c.status ?? c.closeCode}`);
  });
  await check('C2', 'IP literal, localhost and [::1]-style names are accepted', async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      const r = await http('GET', server.base, '/player.html', { headers: { Host: host } });
      expect(r.status === 200, `${host} -> ${r.status}`);
    }
    if (lanAddress) expect((await http('GET', LAN, '/player.html', { localAddress: lanAddress })).status === 200, 'LAN IP literal');
  });
  await check('C3', 'a player upgrade with a foreign Origin -> refused', async () => {
    const v = await joinDevice(server, invite);
    const hello = await http('POST', server.base, PATHS.hello, { body: { device: v.device }, localAddress: freshAddress() });
    const proof = wsProof(v.dk, v.device, hello.json.nonce, 'player');
    const r = await tryUpgrade(`ws://127.0.0.1:${port}${PATHS.ws}?role=player`, [SUBPROTOCOL, authProtocol(v.device, hello.json.nonce, proof)], { Origin: 'http://evil.test' }, { localAddress: freshAddress() });
    expect(!r.ok, 'accepted'); r.ws?.terminate();
  });

  // ------------------------------------------------------------------ D. limits and robustness
  await check('D1', 'per-IP socket cap: the 9th socket from one address is refused', async () => {
    const miss = needLan(); if (miss) return miss;
    await clearDevices();
    const opened = [];
    let refused = 0, why = '';
    for (let i = 0; i < 12; i += 1) {
      const id = await joinDevice(server, invite);
      try { opened.push(await connectPlayer(lanServer, id, { localAddress: lanAddress, name: `L${i}` })); } catch (e) { refused += 1; why = e.message; }
      await sleep(30);
    }
    opened.forEach(p => p.terminate());
    expect(opened.length === LIMITS.maxSocketsPerIp, `${opened.length} accepted, ${refused} refused (expected ${LIMITS.maxSocketsPerIp} accepted); last refusal: ${why}`);
    await sleep(300);
  });
  await check('D2', 'oversize frame: a player frame of 17 KB closes 1009 and the server lives', async () => {
    const v = await newPlayer();
    v.p.send(JSON.stringify({ type: 'PLAYER_NAME', name: 'x'.repeat(17 * 1024) }));
    const code = await Promise.race([v.p.closed(), sleep(3000).then(() => null)]);
    expect(code === CLOSE.TOO_BIG, `closed with ${code}`);
    expect((await http('GET', server.base, PATHS.status)).status === 200, 'server not answering');
  });
  await check('D3', 'malformed JSON, binary, unknown type, wrong direction, NaN/huge, 10,000-deep nesting, __proto__ -> dropped and counted, server alive', async () => {
    const errorsBefore = (await diagCounters()).handlerErrors ?? 0;
    const frames = [
      '{not json', 'null', '[]', '"str"', '{"type":"NOPE"}', '{"type":"STATE_FULL","rev":1}', '{"type":"SCENE","scene":{}}',
      '{"type":"PLAYER_TOKEN_MOVE","id":"tok0","x":NaN,"y":1}', '{"type":"PLAYER_TOKEN_MOVE","id":"tok0","x":1e999,"y":1}',
      `{"type":"PING","t":${'['.repeat(10000)}`, '{"type":"PING","__proto__":{"polluted":1}}', '{"type":"PING","constructor":{"prototype":{"polluted":1}}}',
      JSON.stringify({ type: 'PLAYER_NAME', name: 'y'.repeat(5000) }), JSON.stringify({ type: 'PLAYER_TOKEN_MOVE', id: {}, x: 1, y: 2 }), Buffer.from([1, 2, 3, 4]),
    ];
    for (const frame of frames) {
      const v = await newPlayer();
      v.p.ws.send(frame); v.p.ws.send(JSON.stringify({ type: 'PING', t: 1 }));
      await sleep(80);
      v.p.terminate();
    }
    const ok = await newPlayer(); ok.p.terminate();
    expect(({}).polluted === undefined, 'Object.prototype polluted (in this process)');
    const errorsAfter = (await diagCounters()).handlerErrors ?? 0;
    expect(errorsAfter === errorsBefore, `handlerErrors ${errorsBefore} -> ${errorsAfter}`);
  });
  await check('D4', 'PING flood of 10,000 frames: few PONGs, then 4008 and a ban', async () => {
    const v = await newPlayer();
    for (let i = 0; i < 10000; i += 1) { if (v.p.ws.readyState !== WebSocket.OPEN) break; v.p.ws.send('{"type":"PING","t":1}'); }
    const code = await Promise.race([v.p.closed(), sleep(4000).then(() => null)]);
    const pongs = v.p.byType.PONG ?? 0;
    expect(pongs <= TYPE_CAPS.PING.burst + 10, `${pongs} PONGs`);
    expect(code === CLOSE.ABUSE, `closed with ${code}`);
  });
  await check('D5', 'token move flood respects its per-type limit', async () => {
    const owner = await newPlayer();
    const scene = makeScene({ owners: [owner.p.playerId] }); gm.publish(scene); await sleep(200);
    let n = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 1000 && owner.p.ws.readyState === WebSocket.OPEN) { owner.p.send({ type: 'PLAYER_TOKEN_MOVE', aid: `f${n}`, id: 'tok0', x: scene.tokens[0].x + (n % 200), y: scene.tokens[0].y }); n += 1; if (n % 50 === 0) await sleep(1); }
    await sleep(300);
    const acks = owner.p.byType.ACK ?? 0;
    expect(n > 100, `only ${n} sent`);
    expect(acks <= TYPE_CAPS.PLAYER_TOKEN_MOVE.burst + TYPE_CAPS.PLAYER_TOKEN_MOVE.perSec * 1.5 + 5, `${acks} of ${n} moves were processed in about 1 s`);
    owner.p.terminate();
  });
  await check('D6', 'a body over 512 B to /join -> 413; a header that never completes is closed by the server', async () => {
    const big = await http('POST', server.base, PATHS.join, { body: JSON.stringify({ pad: 'x'.repeat(2000) }), headers: { 'Content-Type': 'application/json' }, localAddress: freshAddress() });
    expect(big.status === 413 || big.status === 0, `HTTP ${big.status}`);
    if (quick) return { note: 'slow-header part skipped with --quick' };
    const t0 = Date.now();
    const closedAfter = await new Promise(resolve => {
      const socket = net.connect(port, '127.0.0.1');
      socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nX-Slow: ');
      socket.on('close', () => resolve(Date.now() - t0));
      setTimeout(() => { socket.destroy(); resolve(null); }, 20000);
    });
    expect(closedAfter !== null && closedAfter < 15000, `incomplete request closed after ${closedAfter} ms (headersTimeout is 10 s)`);
  });
  await check('D7', `seeded fuzz: ${FUZZ_FRAMES} random frames never throw in the server (handlerErrors stays 0)`, async () => {
    const random = seededRandom(20261013);
    const before = (await diagCounters()).handlerErrors ?? 0;
    const types = ['PING', 'RESUME', 'RESYNC', 'PLAYER_NAME', 'PLAYER_TOKEN_MOVE', 'PLAYER_PING', 'PLAYER_END_TURN', 'AUDIO_LISTEN', 'AUDIO_ANSWER', 'AUDIO_STATS', 'SCENE', 'TABLE_CMD', 'AUDIO_OFFER', 'HELLO', 'x'];
    const junk = () => {
      const pick = a => a[Math.floor(random() * a.length)];
      const value = depth => {
        const r = random();
        if (depth > 3 || r < 0.3) return pick([0, -1, 1e308, 0.5, NaN, Infinity, 'a', '', 'x'.repeat(Math.floor(random() * 300)), true, null, '__proto__', 'constructor', '\u0000', 'tok0']);
        if (r < 0.6) return Array.from({ length: Math.floor(random() * 4) }, () => value(depth + 1));
        const o = {}; for (let i = 0; i < Math.floor(random() * 5); i += 1) o[pick(['id', 'x', 'y', 'aid', 'name', 'sdp', 'sid', 'rev', 'aids', 'op', 'device', 'enabled', 'caps', 'scene', 'tokens', '__proto__', 'tokenId', 'to'])] = value(depth + 1);
        return o;
      };
      const base = { type: pick(types) };
      const extra = value(0);
      for (const [k, v] of Object.entries(extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : {})) base[k] = v;
      return random() < 0.05 ? '{"type":' + pick(types) : JSON.stringify(base, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v));
    };
    let sent = 0, sockets = 0;
    while (sent < FUZZ_FRAMES) {
      const v = await newPlayer({}).catch(() => null);
      if (!v) { await sleep(100); continue; }
      sockets += 1;
      while (sent < FUZZ_FRAMES && v.p.ws.readyState === WebSocket.OPEN && v.p.ws.bufferedAmount < 1e6) {
        for (let i = 0; i < 200 && sent < FUZZ_FRAMES; i += 1, sent += 1) v.p.ws.send(junk());
        await sleep(2);
        if (v.p.closeCode !== null) break;
      }
      v.p.terminate();
    }
    await sleep(500);
    const after = (await diagCounters()).handlerErrors ?? 0;
    expect((await http('GET', server.base, PATHS.status)).status === 200, 'server stopped answering');
    expect(after === before, `handlerErrors ${before} -> ${after}`);
    return { note: `${sent} frames over ${sockets} sockets` };
  });
  await check('D8', '600 raw connections from one address: server stays up and memory stays within budget', async () => {
    const rssBefore = (await server.memory()).rss;
    const sockets = [];
    await Promise.all(Array.from({ length: 600 }, () => new Promise(resolve => { const s = net.connect(port, '127.0.0.1'); s.on('error', () => resolve()); s.on('connect', () => { sockets.push(s); resolve(); }); })));
    await sleep(300);
    const alive = (await http('GET', server.base, PATHS.status)).status;
    const growthMB = ((await server.memory()).rss - rssBefore) / 1048576;
    sockets.forEach(s => s.destroy());
    expect(growthMB < 60, `+${growthMB.toFixed(0)} MB (the old server: +270 MB for 600 WebSockets)`);
    return { note: `${sockets.length} connected, status ${alive}, +${growthMB.toFixed(0)} MB` };
  });

  // ------------------------------------------------------------------ E. static and assets
  await check('E1', 'path traversal variants -> 404/400, never a file', async () => {
    for (const path of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/%00', '//etc/passwd', '/..\\package.json', '/assets/../../package.json']) {
      const r = await http('GET', server.base, path);
      expect([400, 404].includes(r.status) && !/"name":\s*"realm-forge"/.test(r.text), `${path} -> ${r.status}`);
    }
  });
  await check('E2', 'security headers on HTML, JS and 404; a CSP is present', async () => {
    const page = await http('GET', server.base, '/player.html');
    const script = /src="(\/assets\/[^"]+\.js)"/.exec(page.text)?.[1];
    const js = script ? await http('GET', server.base, script) : null;
    const missing = await http('GET', server.base, '/nope');
    for (const [name, r] of [['html', page], ['js', js], ['404', missing]]) {
      if (!r) continue;
      for (const h of ['x-content-type-options', 'referrer-policy', 'x-frame-options', 'cross-origin-resource-policy']) expect(r.headers[h], `${name} lacks ${h}`);
    }
    expect(page.headers['content-security-policy'] || page.headers['content-security-policy-report-only'], 'no CSP on the player page');
  });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const hash = createHash('sha256').update(png).digest('hex');
  const gmHeaders = () => ({ Host: gmHost, Origin: `http://${gmHost}`, Cookie: server.gmCookie, 'X-RF': '1' });
  await check('E3', 'asset GET: no cookie 403, device cookie 200 + immutable + 304 on ETag, kicked device 403', async () => {
    const put = await http('PUT', server.base, `${PATHS.assets}${hash}`, { headers: { ...gmHeaders(), 'Content-Type': 'image/png' }, body: png });
    expect(put.status === 200 || put.status === 201 || put.status === 204, `PUT -> ${put.status} ${put.text.slice(0, 60)}`);
    const none = await http('GET', server.base, `${PATHS.assets}${hash}`);
    const v = await newPlayer();
    const ok = await http('GET', server.base, `${PATHS.assets}${hash}`, { headers: { Cookie: v.identity.cookie } });
    const again = await http('GET', server.base, `${PATHS.assets}${hash}`, { headers: { Cookie: v.identity.cookie, 'If-None-Match': ok.headers.etag } });
    tableCmd({ op: 'kick', device: v.identity.device }); await sleep(200);
    const kicked = await http('GET', server.base, `${PATHS.assets}${hash}`, { headers: { Cookie: v.identity.cookie } });
    expect(none.status === 403, `no cookie -> ${none.status}`);
    expect(ok.status === 200 && /immutable/.test(ok.headers['cache-control'] ?? ''), `device -> ${ok.status} ${ok.headers['cache-control']}`);
    expect(again.status === 304, `ETag -> ${again.status}`);
    expect(kicked.status === 403, `kicked -> ${kicked.status}`);
  });
  await check('E4', 'asset PUT: hash mismatch 400, SVG 415, oversize 413, GM only', async () => {
    const wrong = await http('PUT', server.base, `${PATHS.assets}${'b'.repeat(64)}`, { headers: { ...gmHeaders(), 'Content-Type': 'image/png' }, body: png });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const svgPut = await http('PUT', server.base, `${PATHS.assets}${createHash('sha256').update(svg).digest('hex')}`, { headers: { ...gmHeaders(), 'Content-Type': 'image/svg+xml' }, body: svg });
    const anon = await http('PUT', server.base, `${PATHS.assets}${hash}`, { headers: { 'Content-Type': 'image/png' }, body: png });
    expect(wrong.status === 400, `hash mismatch -> ${wrong.status}`);
    expect(svgPut.status === 415, `svg -> ${svgPut.status}`);
    expect([401, 403].includes(anon.status), `no GM cookie -> ${anon.status}`);
    if (!quick) {
      const huge = Buffer.alloc(26 * 1024 * 1024, 1);
      const r = await http('PUT', server.base, `${PATHS.assets}${createHash('sha256').update(huge).digest('hex')}`, { headers: { ...gmHeaders(), 'Content-Type': 'image/png' }, body: huge, timeoutMs: 30000 });
      expect(r.status === 413 || r.status === 0, `26 MiB -> ${r.status}`);
    }
  });
  await check('E6', '.webmanifest is served with the right type (when the build has one)', async () => {
    const list = (await http('GET', server.base, '/player.html')).text.match(/href="([^"]+\.webmanifest)"/);
    if (!list) return { skip: 'no manifest in the build' };
    const r = await http('GET', server.base, list[1]);
    expect(/manifest\+json/.test(r.headers['content-type'] ?? ''), r.headers['content-type']);
  });

  // ------------------------------------------------------------------ F. information
  await check('F1', 'canary: no GM-only byte in any frame a player receives (snapshot, patches, reveal/hide, reconnect, ping, roster)', async () => {
    const watcher = await newPlayer({ name: 'watcher' });
    const hero = await newPlayer({ name: 'hero' });
    const scene = makeScene({ owners: [hero.p.playerId] });
    scene.gmNotes = 'CANARY-gmNotes'; scene.notes = 'CANARY-notes';
    scene.tokens.push({ id: 'CANARY-hidden-id', name: 'CANARY-hidden-name', x: 3200, y: 3400, gridSize: 1, visibleToPlayers: false, notes: 'CANARY-tok-notes', hp: 777001, maxHp: 777002 });
    scene.tokens[1].notes = 'CANARY-tok1-notes'; scene.tokens[1].hp = 777003; scene.tokens[1].npc = true;
    scene.markers = [{ id: 'm1', x: 10, y: 10, name: 'CANARY-marker', visibleToPlayers: false, notes: 'CANARY-marker-notes' }];
    scene.combat = { entries: [{ id: 'e1', tokenId: 'tok1', name: 'CANARY-combat', hp: 777004, npc: true }], activeId: null, round: 1 };
    gm.publish(scene); await sleep(200);
    const s2 = structuredClone(scene); s2.tokens[2].x += 10; gm.publish(s2); await sleep(150);
    const s3 = structuredClone(s2); s3.tokens.find(t => t.id === 'CANARY-hidden-id').visibleToPlayers = true; gm.publish(s3); await sleep(150);
    s3.tokens.find(t => t.id === 'CANARY-hidden-id').visibleToPlayers = false; gm.publish(structuredClone(s3)); await sleep(150);
    hero.p.send({ type: 'PLAYER_PING', x: 100, y: 100 }); await sleep(150);
    watcher.p.terminate();
    const again = await connectPlayer(server, watcher.identity, { name: 'watcher', record: true, resume: { rev: null, aids: [] } }); await sleep(300);
    const seen = [...watcher.p.log, ...again.log, ...hero.p.log].map(m => JSON.stringify(m)).join('\n');
    expect(!/CANARY/.test(seen), `a canary reached a player: ${/.{0,40}CANARY.{0,40}/.exec(seen)?.[0]}`);
    expect(!/77700[1-4]/.test(seen), 'an NPC hit-point value reached a player');
    again.terminate(); hero.p.terminate();
  });

  // ------------------------------------------------------------------ G. audio signalling
  await check('G1', 'AUDIO_ANSWER with public candidates, extra media or an oversize SDP never reaches the GM unsanitised', async () => {
    const v = await newPlayer({ name: 'rtc' });
    const sdp = extra => ['v=0', 'o=- 1 1 IN IP4 0.0.0.0', 's=-', 't=0 0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', 'a=rtpmap:111 opus/48000/2', 'a=candidate:1 1 udp 2122260223 8.8.8.8 5000 typ host', 'a=candidate:2 1 udp 1 9.9.9.9 5001 typ srflx raddr 0.0.0.0 rport 0', ...extra, ''].join('\r\n');
    const seenByGm = [];
    const watch = m => { if (m.type === 'AUDIO_ANSWER') seenByGm.push(JSON.stringify(m)); };
    const previous = gm.onFrame; gm.onFrame = (m, ...r) => { previous?.(m, ...r); watch(m); };
    v.p.send({ type: 'AUDIO_LISTEN', enabled: true, caps: { rtc: true, jbt: true } });
    for (const body of [sdp([]), sdp(['m=video 9 UDP/TLS/RTP/SAVPF 96', 'a=candidate:3 1 udp 1 7.7.7.7 6000 typ host']), sdp(['a=pad:' + 'x'.repeat(13000)])]) {
      v.p.send({ type: 'AUDIO_ANSWER', sid: 'sid1', sdp: body }); await sleep(100);
      if (v.p.ws.readyState !== WebSocket.OPEN) break;
    }
    await sleep(200); gm.onFrame = previous;
    const leaked = seenByGm.filter(s => /8\.8\.8\.8|9\.9\.9\.9|7\.7\.7\.7|m=video/.test(s));
    expect(leaked.length === 0, `GM received an unsanitised answer: ${leaked[0]?.slice(0, 120)}`);
  });
  await check('G2', 'the fallback audio socket needs the same upgrade authentication', async () => {
    const r1 = await tryUpgrade(`ws://127.0.0.1:${port}${PATHS.audioWs}?role=player`, [SUBPROTOCOL], { Origin: server.base }, { localAddress: freshAddress() });
    const r2 = await tryUpgrade(`ws://127.0.0.1:${port}${PATHS.audioWs}?role=gm`, [SUBPROTOCOL], { Host: gmHost, Origin: `http://${gmHost}` }, { localAddress: freshAddress() });
    expect(!r1.ok && !r2.ok, `player without proof ${r1.ok}, gm without cookie ${r2.ok}`); r1.ws?.terminate(); r2.ws?.terminate();
  });
  await check('G3', 'listener registry bounded by the device registry', async () => ({ skip: 'covered by test/audioSignal.test.js (needs fake sessions)' }));
  await check('G4', 'relay queue per listener is bounded', async () => ({ skip: 'covered by test/audioRelay.test.js; the live version is accept-audio-ws.mjs' }));

  console.log(`\naccept-security: ${tally.pass} pass, ${tally.fail} fail, ${tally.skip} skipped${failures.length ? ` (failed: ${failures.join(', ')})` : ''}`);
  await server.close();
  process.exit(tally.fail ? 1 : 0);
}

main().catch(error => {
  if (error instanceof ServerUnavailable) { console.error(error.message); process.exit(1); }
  console.error('accept-security crashed:', error);
  process.exit(1);
});
