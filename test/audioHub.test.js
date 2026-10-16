// The audio server modules against the REAL hub and the REAL access control over loopback sockets (no fakes):
// frame validation and caps, the upgrade authentication of /__realm/audio, and an RFA3 packet travelling GM -> relay -> phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { createRealm } from '../server/net/realm.js';
import { createAudioSignal } from '../server/net/audioSignal.js';
import { createDeviceStore } from '../src/net/deviceStore.js';
import { createJoinClient } from '../src/net/joinClient.js';
import { PATHS, SUBPROTOCOL, authProtocol } from '../src/net/protocol.js';
import { wsProof } from '../src/net/hmac.js';
import { createAdpcmEncoder, peekRfa3 } from '../src/audio/pcm.js';
import { candidateAddresses } from '../server/net/candidates.js';
import { EDGE_OFFER, EDGE_ANSWER } from '../test-support/wp5-sdp-edge.js';

const until = async (predicate, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (predicate()) return; await new Promise(r => setTimeout(r, 15)); }
  assert.fail('timed out waiting');
};

async function table(t) {
  const realm = createRealm({ dataDir: null });
  const server = createServer((req, res) => realm.middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  realm.attach(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const signal = createAudioSignal({ hub: realm.hub, access: realm.access, metrics: realm.metrics, clock: realm.clock,
    lan: { lanAddresses: () => [{ address: '127.0.0.1' }] }, options: { allowLoopback: true } });
  const first = await fetch(`${url}/`, { redirect: 'manual' });
  const gmCookie = first.headers.getSetCookie().map(l => l.split(';')[0]).find(p => p.startsWith('rf-gm='));
  t.after(async () => { signal.close(); await realm.close(); server.closeAllConnections?.(); await new Promise(r => server.close(r)); });
  const post = (path, body) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', Origin: url }, body: JSON.stringify(body) });

  async function joinPlayer(name) {
    const store = createDeviceStore({ local: null, session: null });
    const join = createJoinClient({ store, fetchImpl: (input, init = {}) => fetch(new URL(String(input), url), { ...init, headers: { ...(init.headers ?? {}), Origin: url } }), url });
    realm.access.table.inviteShown();
    const secret = realm.access.internals.invite.current().secret;
    store.ensureDevice();
    const result = await join.joinWithLink(secret);
    assert.equal(result.status, 'admitted');
    return store;
  }
  async function protocolsFor(store, role) {
    if (role === 'gm') return [SUBPROTOCOL];
    const device = store.device(), dk = store.dk();
    const { nonce } = await (await post(PATHS.hello, { device })).json();
    return [SUBPROTOCOL, authProtocol(device, nonce, wsProof(dk, device, nonce, 'player'))];
  }
  async function open(path, role, store) {
    const ws = new WebSocket(`${url.replace('http', 'ws')}${path}?role=${role}`, await protocolsFor(store, role), { origin: url, headers: role === 'gm' ? { Cookie: gmCookie } : {} });
    const inbox = [], frames = [];
    ws.on('message', (data, binary) => { if (binary) frames.push(data); else inbox.push(JSON.parse(data.toString())); });
    await once(ws, 'open');
    return { ws, inbox, frames, send: obj => ws.send(JSON.stringify(obj)), last: type => inbox.filter(m => m.type === type).at(-1) };
  }
  return { realm, signal, url, joinPlayer, open };
}

test('end to end on the real hub: listen -> select -> offer -> answer -> fallback -> an RFA3 packet reaches only the selected phone', async t => {
  const { signal, joinPlayer, open } = await table(t);
  const store = await joinPlayer();
  const device = store.device();
  const gm = await open(PATHS.ws, 'gm', null);
  const phone = await open(PATHS.ws, 'player', store);
  t.after(() => { gm.ws.close(); phone.ws.close(); });

  gm.send({ type: 'AUDIO_STATUS', active: true });
  await until(() => phone.last('AUDIO_STATUS')?.active === true);
  phone.send({ type: 'AUDIO_LISTEN', enabled: true, caps: { rtc: true, jbt: true } });
  await until(() => gm.last('AUDIO_LISTENER')?.ready === true);
  assert.equal(gm.last('AUDIO_LISTENER').device, device);
  assert.equal(gm.last('AUDIO_LISTENER').selected, false);

  gm.send({ type: 'AUDIO_SELECT', settings: [{ id: device, selected: true }] });
  await until(() => phone.last('AUDIO_CONTROLS')?.selected === true);
  gm.send({ type: 'AUDIO_OFFER', to: device, sid: 'o1', sdp: EDGE_OFFER });
  await until(() => phone.last('AUDIO_OFFER'));
  assert.deepEqual(candidateAddresses(phone.last('AUDIO_OFFER').sdp), ['127.0.0.1']);
  phone.send({ type: 'AUDIO_ANSWER', sid: 'o1', sdp: EDGE_ANSWER });
  await until(() => gm.last('AUDIO_ANSWER'));
  assert.deepEqual(candidateAddresses(gm.last('AUDIO_ANSWER').sdp), ['127.0.0.1']);
  phone.send({ type: 'AUDIO_STATS', sid: 'o1', mode: 'rtc', lossPct: 0.5, jitterBufferMs: 800 });
  await until(() => gm.last('AUDIO_STATS'));
  assert.equal(gm.last('AUDIO_STATS').jitterBufferMs, 800);

  // the GM falls back; both open their audio sockets (authenticated exactly like the control socket) and sound flows
  gm.send({ type: 'AUDIO_FALLBACK', to: device, sid: 'o1', reason: 'timeout' });
  await until(() => phone.last('AUDIO_FALLBACK'));
  assert.equal(phone.last('AUDIO_FALLBACK').reason, 'timeout');
  const gmAudio = await open(PATHS.audioWs, 'gm', null);
  const phoneAudio = await open(PATHS.audioWs, 'player', store);
  t.after(() => { gmAudio.ws.close(); phoneAudio.ws.close(); });
  const silence = [new Float32Array(4096), new Float32Array(4096)];
  const encoder = createAdpcmEncoder();
  const packet = seq => Buffer.from(encoder.encode(silence, 48000, { seq, ts: seq * 4096 }));
  for (let i = 0; i < 5; i++) gmAudio.ws.send(packet(i));
  await until(() => phoneAudio.frames.length === 5);
  assert.deepEqual(phoneAudio.frames.map(f => peekRfa3(f).seq), [0, 1, 2, 3, 4]);
  assert.deepEqual(phoneAudio.frames[0], packet(0));

  // unselect: the phone is told to stop and the relay stops feeding it
  gm.send({ type: 'AUDIO_SELECT', settings: [{ id: device, selected: false }] });
  await until(() => phone.last('AUDIO_STOP'));
  gmAudio.ws.send(packet(5));
  await new Promise(r => setTimeout(r, 120));
  assert.equal(phoneAudio.frames.length, 5, 'an unselected phone gets nothing');
  assert.equal(signal.listeners()[0].mode, 'idle');
});

test('G2 on the real hub: the audio socket needs the same authentication as the control socket', async t => {
  const { url, joinPlayer } = await table(t);
  const store = await joinPlayer();
  // resolves with how the attempt ended: an HTTP status (refused before a socket existed), or the close code of a socket the
  // hub accepted only to tell the client why (4011 = proof or nonce invalid)
  const attempt = (protocols, headers = {}) => new Promise(resolve => {
    const ws = new WebSocket(`${url.replace('http', 'ws')}${PATHS.audioWs}?role=player`, protocols, { origin: url, headers });
    let frames = 0;
    ws.on('message', () => frames++);
    ws.on('close', code => resolve({ code, frames }));
    ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode, frames }));
    ws.on('error', () => {});
  });
  const refused = result => result.status >= 400 || (result.code >= 4000 && result.code <= 4999);
  assert.ok(refused(await attempt([SUBPROTOCOL])), 'no proof');
  assert.ok(refused(await attempt([SUBPROTOCOL, authProtocol(store.device(), '0'.repeat(32), 'f'.repeat(64))])), 'a forged proof');
  assert.ok(refused(await attempt([SUBPROTOCOL], { Origin: 'http://evil.test' })), 'a foreign origin');
  assert.ok(refused(await attempt(['other'])), 'no rf3 sub-protocol');
});

test('real validation: a player cannot send GM audio commands; junk is dropped; an oversize frame closes only that socket', async t => {
  const { signal, joinPlayer, open, realm } = await table(t);
  const store = await joinPlayer();
  const phone = await open(PATHS.ws, 'player', store);
  t.after(() => phone.ws.close());
  phone.send({ type: 'AUDIO_STATUS', active: true });
  phone.send({ type: 'AUDIO_OFFER', to: store.device(), sid: 'x', sdp: EDGE_OFFER });
  phone.send({ type: 'AUDIO_LISTEN', enabled: 'yes', caps: 5 });
  await new Promise(r => setTimeout(r, 150));
  assert.equal(signal.onGmAudioState().active, false);
  assert.equal(phone.inbox.some(m => m.type === 'AUDIO_OFFER'), false);
  assert.equal(realm.hub.sessions.players().length, 1, 'still connected after the junk');
  const closed = once(phone.ws, 'close');
  phone.ws.send(JSON.stringify({ type: 'AUDIO_ANSWER', sid: 'x', sdp: 'A'.repeat(20000) }));
  const [code] = await closed;
  assert.equal(code, 1009);
  const again = await open(PATHS.ws, 'player', store);
  again.ws.close();
  assert.equal(realm.metrics.get?.('handlerErrors') ?? 0, 0);
});
