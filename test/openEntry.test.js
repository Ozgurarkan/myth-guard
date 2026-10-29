// Entering the table with nothing but the address: no QR link, no typed code. The GM can switch the requirement back on,
// and the table's lock and ask-first modes still apply.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhone, makeAccess } from '../test-support/wp2-fixtures.js';

test('by default a phone joins with only the address, keeps its key, and connects', async t => {
  const { access, cleanup } = makeAccess();
  t.after(cleanup);
  const phone = createPhone(access, { name: 'Thorin' });
  const res = await phone.join({ how: 'open' });
  assert.equal(res.status, 200);
  assert.equal(phone.status, 'admitted');
  assert.equal(phone.srvProofOk, true);
  assert.equal(access.table.list().length, 1);
  const auth = await phone.connect();
  assert.equal(auth.ok, true, JSON.stringify(auth));
  assert.equal(auth.name, 'Thorin');
});

test('when the GM asks for the code, an open join is refused and nothing is created', async t => {
  const { access, cleanup } = makeAccess();
  t.after(cleanup);
  access.table.setCodeRequired(true);
  assert.equal(access.table.view().codeRequired, true);
  const phone = createPhone(access);
  const res = await phone.join({ how: 'open' });
  assert.equal(res.status, 403);
  assert.deepEqual(res.json(), { error: 'code-required' });
  assert.equal(access.table.list().length, 0);
  assert.equal((await phone.join({ how: 'link' })).status, 200, 'the QR link still works');
  access.table.setCodeRequired(false);
  assert.equal((await createPhone(access, { ip: '192.168.1.51' }).join({ how: 'open' })).status, 200);
});

test('a locked table refuses new open joins, and ask-first holds them as pending', async t => {
  const { access, cleanup } = makeAccess();
  t.after(cleanup);
  access.table.setMode('ask');
  const asking = createPhone(access, { ip: '192.168.1.60' });
  assert.equal((await asking.join({ how: 'open' })).status, 200);
  assert.equal(asking.status, 'pending');
  access.table.lock();
  const late = createPhone(access, { ip: '192.168.1.61' });
  const res = await late.join({ how: 'open' });
  assert.equal(res.status, 403);
  assert.deepEqual(res.json(), { error: 'locked' });
});

test('the setting is part of the TABLE view the GM receives', async t => {
  const { access, cleanup } = makeAccess();
  t.after(cleanup);
  assert.equal(access.table.view().codeRequired, false);
});
