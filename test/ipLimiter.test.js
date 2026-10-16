import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS } from '../src/net/protocol.js';
import { createFakeClock } from '../server/net/clock.js';
import { createBucket, createIpLimiter } from '../server/net/ipLimiter.js';

test('a bucket allows its burst, then the sustained rate, using the injected clock', () => {
  const clock = createFakeClock();
  const bucket = createBucket({ capacity: 3, perSec: 2 }, clock);
  assert.deepEqual([1, 2, 3, 4].map(() => bucket.take()), [true, true, true, false]);
  clock.advance(500);
  assert.equal(bucket.take(), true, 'half a second refills one token');
  assert.equal(bucket.take(), false);
  clock.advance(60_000);
  assert.equal(bucket.tokens, 3, 'never above capacity');
});

test('D1 the 9th socket from one address is refused, the global cap holds, and closing frees a slot', () => {
  const limiter = createIpLimiter(createFakeClock());
  for (let i = 0; i < LIMITS.maxSocketsPerIp; i++) assert.equal(limiter.openSocket('10.0.0.1'), true);
  assert.equal(limiter.openSocket('10.0.0.1'), false, '9th');
  assert.equal(limiter.openSocket('10.0.0.2'), true, 'another address is unaffected');
  limiter.closeSocket('10.0.0.1');
  assert.equal(limiter.openSocket('10.0.0.1'), true);

  const crowded = createIpLimiter(createFakeClock());
  let admitted = 0;
  for (let i = 0; i < 600; i++) if (crowded.openSocket(`10.1.${i >> 8}.${i & 255}`)) admitted += 1;
  assert.equal(admitted, LIMITS.maxSocketsTotal, 'only the global cap is admitted out of 600');
  assert.equal(crowded.totalSockets, LIMITS.maxSocketsTotal);
});

test('D8 600 sockets from one address: only the per-address cap is admitted', () => {
  const limiter = createIpLimiter(createFakeClock());
  let admitted = 0;
  for (let i = 0; i < 600; i++) if (limiter.openSocket('192.168.1.99')) admitted += 1;
  assert.equal(admitted, LIMITS.maxSocketsPerIp);
  assert.equal(limiter.stats().sockets, LIMITS.maxSocketsPerIp);
});

test('closing more sockets than were opened never goes negative', () => {
  const limiter = createIpLimiter(createFakeClock());
  limiter.closeSocket('10.0.0.9');
  limiter.openSocket('10.0.0.8');
  limiter.closeSocket('10.0.0.8');
  limiter.closeSocket('10.0.0.8');
  assert.equal(limiter.totalSockets, 0);
});

test('A5 five failed proofs within a minute ban that address for five minutes; others are unaffected; the ban ends on time', () => {
  const clock = createFakeClock();
  const limiter = createIpLimiter(clock);
  for (let i = 1; i < LIMITS.failedProofsBeforeBan; i++) assert.equal(limiter.strike('10.0.0.1'), false, `strike ${i}`);
  assert.equal(limiter.banned('10.0.0.1'), false);
  assert.equal(limiter.strike('10.0.0.1'), true, 'the fifth bans');
  assert.equal(limiter.banned('10.0.0.1'), true);
  assert.equal(limiter.banned('10.0.0.2'), false);
  assert.equal(limiter.openSocket('10.0.0.1'), false, 'a banned address cannot open sockets');
  clock.advance(LIMITS.banMs - 1);
  assert.equal(limiter.banned('10.0.0.1'), true);
  clock.advance(2);
  assert.equal(limiter.banned('10.0.0.1'), false);
  assert.equal(limiter.openSocket('10.0.0.1'), true);
});

test('strikes older than a minute are forgotten', () => {
  const clock = createFakeClock();
  const limiter = createIpLimiter(clock);
  for (let i = 0; i < 4; i++) limiter.strike('10.0.0.1');
  clock.advance(61_000);
  limiter.strike('10.0.0.1');
  assert.equal(limiter.banned('10.0.0.1'), false);
  assert.equal(limiter.strikesOf('10.0.0.1'), 1);
});

test('ban() sets an explicit length and the GM computer (exempt) is never banned or struck', () => {
  const clock = createFakeClock();
  const limiter = createIpLimiter(clock, { exempt: ip => ip === '127.0.0.1' });
  assert.equal(limiter.ban('10.0.0.1', 30_000), true);
  clock.advance(29_000);
  assert.equal(limiter.banned('10.0.0.1'), true);
  clock.advance(2_000);
  assert.equal(limiter.banned('10.0.0.1'), false);
  assert.equal(limiter.ban('127.0.0.1', 30_000), false);
  for (let i = 0; i < 20; i++) limiter.strike('127.0.0.1');
  assert.equal(limiter.banned('127.0.0.1'), false);
});

test('named per-address rate limits: hello 60 a minute, join 12 a minute, each address on its own', () => {
  const clock = createFakeClock();
  const limiter = createIpLimiter(clock);
  let allowed = 0;
  for (let i = 0; i < 100; i++) if (limiter.hit('10.0.0.1', 'hello')) allowed += 1;
  assert.equal(allowed, LIMITS.helloPerIpPerMin);
  assert.equal(limiter.hit('10.0.0.2', 'hello'), true);
  allowed = 0;
  for (let i = 0; i < 30; i++) if (limiter.hit('10.0.0.3', 'join')) allowed += 1;
  assert.equal(allowed, LIMITS.joinPerIpPerMin);
  clock.advance(5_000);
  assert.equal(limiter.hit('10.0.0.3', 'join'), true, 'a token comes back every 5 s');
  assert.throws(() => limiter.hit('10.0.0.1', 'nope'), /unknown bucket/);
});

test('peek does not consume and reports a drained bucket', () => {
  const limiter = createIpLimiter(createFakeClock(), { buckets: { tiny: { capacity: 1, perSec: 0 } } });
  assert.equal(limiter.peek('10.0.0.1', 'tiny'), true);
  assert.equal(limiter.peek('10.0.0.1', 'tiny'), true);
  assert.equal(limiter.hit('10.0.0.1', 'tiny'), true);
  assert.equal(limiter.peek('10.0.0.1', 'tiny'), false);
});

test('memory stays bounded when many addresses show up', () => {
  const clock = createFakeClock();
  const limiter = createIpLimiter(clock, { maxTracked: 50 });
  for (let i = 0; i < 1000; i++) { limiter.hit(`10.2.${i >> 8}.${i & 255}`, 'hello'); limiter.strike(`10.3.${i >> 8}.${i & 255}`); }
  assert.ok(limiter.stats().addresses <= 50);
  limiter.ban('10.9.9.9', 1000);
  for (let i = 0; i < 1000; i++) limiter.ban(`10.4.${i >> 8}.${i & 255}`, 1000);
  assert.ok(limiter.stats().bans <= 50);
});
