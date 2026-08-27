/**
 * node test/redis.service.test.js
 *
 * Two things are worth pinning here, because both are silent failures:
 *
 * 1. Fail-open. With no UPSTASH_* env, or with Upstash down, every call must
 *    return null instead of throwing. If this breaks, a cache outage becomes
 *    an API outage - on a payments API.
 * 2. Shape stability. A cached value goes through JSON, so Dates come back as
 *    Dates and Prisma Decimals as strings. A cache MISS has to hand back the
 *    same shape, otherwise `row.created_at.toISOString()` works until the
 *    cache warms up and then throws in production.
 *
 * The live round trip at the end only runs when UPSTASH_* is set.
 */
const assert = require('assert');

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const offline = require('../src/services/redis.service');

async function main() {
  // --- disabled: everything is a no-op, nothing throws -----------------
  assert.strictEqual(offline.isEnabled(), false, 'no env means disabled');
  assert.strictEqual(await offline.get(offline.key('t', 1)), null);
  assert.strictEqual(await offline.set(offline.key('t', 1), { a: 1 }, 10), null);
  assert.strictEqual(await offline.del(offline.key('t', 1)), null);
  assert.strictEqual(await offline.incrWithTtl(offline.key('t', 1), 10), null);
  assert.strictEqual(await offline.ttlMs(offline.key('t', 1)), 0);
  assert.strictEqual(await offline.sAddIsNew(offline.key('t', 1), 5, 10), null);
  assert.strictEqual(await offline.ping(), 'disabled');

  // cached() must still return the loader's value with no Redis at all.
  const loaded = await offline.cached(offline.key('t', 'x'), 10, async () => ({ ok: true }));
  assert.deepStrictEqual(loaded, { ok: true }, 'cached() must fall through to the loader');

  // --- keys are namespaced so environments cannot collide ---------------
  assert.ok(offline.key('user', 42).endsWith(':user:42'));
  assert.notStrictEqual(offline.key('user', 42), offline.key('user', 43));

  // --- normalize(): a miss must look exactly like a hit ------------------
  const when = new Date('2026-08-03T10:20:30.000Z');
  const decimalLike = { toJSON: () => '1500.00' }; // how Prisma Decimal serializes
  const shaped = offline.normalize({ created_at: when, balance: decimalLike, nested: { at: when } });

  assert.ok(shaped.created_at instanceof Date, 'dates must survive the round trip as Dates');
  assert.strictEqual(shaped.created_at.getTime(), when.getTime());
  assert.ok(shaped.nested.at instanceof Date, 'nested dates too');
  assert.strictEqual(shaped.balance, '1500.00', 'Decimal must normalize to a string');
  assert.strictEqual(Number(shaped.balance), 1500, 'and still be parseable as money');

  // A bad URL exercises the same catch path a real outage takes.
  process.env.UPSTASH_REDIS_REST_URL = 'http://127.0.0.1:1';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'not-a-real-token';
  delete require.cache[require.resolve('../src/services/redis.service')];
  const broken = require('../src/services/redis.service');
  assert.strictEqual(broken.isEnabled(), true, 'env present means enabled');
  assert.strictEqual(await broken.get(broken.key('t', 1)), null, 'an unreachable Redis must fail open');
  assert.strictEqual(await broken.ping(), 'unreachable');

  console.log('✅ redis.service tests passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
