/**
 * node test/cache.service.test.js
 *
 * Runs with no UPSTASH_* env, which is the important case: the whole point of
 * this layer is that a missing or dead Redis degrades the API to "as slow as
 * before" and never to "down". Everything below therefore asserts behaviour on
 * the fallback path, where the cache is doing nothing at all.
 *
 * Four properties are worth pinning, because each one fails silently:
 *
 * 1. Fail-open. No Redis must still return the loader's value.
 * 2. Single-flight. Concurrent misses on one key must run the loader once. This
 *    is the difference between a cold cache costing one query and costing one
 *    query per waiting request, and it only shows up under load.
 * 3. Shape stability. Hit, miss and cache-disabled must hand back the same
 *    shape, or a bug appears only once the cache warms.
 * 4. No plaintext PII in keys. A Redis key is as readable as a value.
 */
const assert = require('assert');

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const cache = require('../src/services/cache.service');
const redis = require('../src/services/redis.service');

// remember() reaches inflight.set() a few microtasks in - it awaits redis.get
// first, even when Redis is off. setImmediate is a macrotask, so awaiting it
// drains everything queued ahead of it and lets us observe the in-flight table.
const drain = () => new Promise(r => setImmediate(r));

async function main() {
  assert.strictEqual(redis.isEnabled(), false, 'these tests assume Redis is off');

  // --- 1. fail open ------------------------------------------------------
  const value = await cache.remember(cache.keys.txList(7), 30, async () => [{ id: 1 }]);
  assert.deepStrictEqual(value, [{ id: 1 }], 'no Redis must still return the loader value');

  // A loader that throws must propagate, not be swallowed into a null the
  // caller would render as an empty transaction list.
  await assert.rejects(
    () => cache.remember(cache.keys.txList(8), 30, async () => { throw new Error('db down'); }),
    /db down/,
    'loader errors must reach the caller'
  );

  // ...and must not leave the key wedged. The next caller gets a fresh attempt.
  const after = await cache.remember(cache.keys.txList(8), 30, async () => ['recovered']);
  assert.deepStrictEqual(after, ['recovered'], 'a failed loader must not poison the key');
  assert.strictEqual(cache.__test.inflight.size, 0, 'no in-flight entries may leak');

  // --- 2. single flight --------------------------------------------------
  let calls = 0;
  const slowLoader = async () => {
    calls += 1;
    await new Promise(r => setTimeout(r, 20));
    return { served: calls };
  };

  const key = cache.keys.txRecent(42);
  const [a, b, c] = await Promise.all([
    cache.remember(key, 30, slowLoader),
    cache.remember(key, 30, slowLoader),
    cache.remember(key, 30, slowLoader),
  ]);

  assert.strictEqual(calls, 1, 'three concurrent misses on one key must load once');
  assert.deepStrictEqual(a, b, 'all waiters get the same value');
  assert.deepStrictEqual(b, c);
  assert.strictEqual(cache.__test.inflight.size, 0, 'in-flight entry must be cleared');

  // Different keys must NOT be coalesced - that would serve one user another
  // user's transactions, which is the worst possible bug in this file.
  calls = 0;
  await Promise.all([
    cache.remember(cache.keys.txRecent(1), 30, slowLoader),
    cache.remember(cache.keys.txRecent(2), 30, slowLoader),
  ]);
  assert.strictEqual(calls, 2, 'distinct keys must never share a loader');

  // --- 3. shape stability ------------------------------------------------
  const when = new Date('2026-08-20T09:15:00.000Z');
  const decimalLike = { toJSON: () => '2500.00' }; // how Prisma Decimal serializes

  const shaped = await cache.remember(cache.keys.txList(9), 30, async () => ([
    { created_at: when, amount: decimalLike, details: 'v1:abc' },
  ]));
  assert.ok(shaped[0].created_at instanceof Date, 'ISO strings must revive as Dates');
  assert.strictEqual(shaped[0].amount, '2500.00', 'Decimal must normalize to a string');

  // TTL 0 means "do not cache", NOT "return a different shape". Someone setting
  // CACHE_TTL_TX_LIST=0 to chase a staleness report must not introduce a new bug.
  const uncached = await cache.remember(cache.keys.txList(10), 0, async () => ([
    { created_at: when, amount: decimalLike },
  ]));
  assert.ok(uncached[0].created_at instanceof Date, 'disabled cache must keep the shape');
  assert.strictEqual(uncached[0].amount, '2500.00');

  // --- 4. keys -----------------------------------------------------------
  assert.notStrictEqual(cache.keys.txRecent(1), cache.keys.txRecent(2), 'keys are per user');
  assert.notStrictEqual(cache.keys.txRecent(1), cache.keys.txList(1), 'recent and list are distinct');
  assert.ok(cache.keys.txRecent(5).endsWith(':tx:recent:5'));
  assert.ok(cache.keys.txList(5).endsWith(':tx:list:5'));

  // Beneficiary keys are directional: A having paid B says nothing about B
  // having paid A.
  assert.notStrictEqual(
    cache.keys.beneficiaryKnown(1, 2),
    cache.keys.beneficiaryKnown(2, 1),
    'beneficiary keys must not be symmetric'
  );

  // No key builder takes a raw identifier. otpCooldown is handed a blind index
  // by its callers; assert here that an address passed by mistake is at least
  // never what the other builders produce.
  for (const k of [cache.keys.txRecent(1), cache.keys.txList(1), cache.keys.beneficiaryKnown(1, 2)]) {
    assert.ok(!/@/.test(k), 'no key may contain an email address');
    assert.ok(!/\+?234\d{7,}/.test(k), 'no key may contain a phone number');
  }

  // --- 5. flags ----------------------------------------------------------
  // With Redis off, a one-way flag always reads false: "ask the database".
  // Anything else would let a cache outage suppress a confirmation prompt.
  const flagKey = cache.keys.beneficiaryKnown(11, 22);
  assert.strictEqual(await cache.getFlag(flagKey), false, 'absent flag reads false');
  await cache.setFlag(flagKey, 60);
  assert.strictEqual(await cache.getFlag(flagKey), false, 'no Redis means still false, never a stale true');
  assert.strictEqual(await cache.setFlag(flagKey, 0), null, 'a zero TTL writes nothing');

  // --- 6. OTP slot -------------------------------------------------------
  // Fails OPEN. Suppressing a genuine reset code because Redis is unreachable
  // would lock people out of their own accounts.
  assert.strictEqual(await cache.claimOtpSlot('some-blind-index'), true, 'no Redis must allow the send');
  assert.strictEqual(await cache.claimOtpSlot(''), true, 'an empty subject must not block a send');

  // --- 7. invalidation ---------------------------------------------------
  // dropUserActivity must not throw on junk - it is called from inside money
  // transactions, where an exception would roll back a real transfer.
  await cache.dropUserActivity(0);
  await cache.dropUserActivity(null);
  await cache.dropUserActivity(undefined);
  await cache.dropUserActivity('not-a-number');
  await cache.drop();
  await cache.dropUserActivity(123);

  // drop() must also clear an in-flight loader. A loader that started before a
  // write committed is about to cache a pre-write value; letting a later reader
  // join that promise would serve exactly the stale row drop() is removing.
  let resolveLoader;
  const gate = new Promise(r => { resolveLoader = r; });
  const dropKey = cache.keys.txList(99);
  const inflightRead = cache.remember(dropKey, 30, async () => { await gate; return ['stale']; });
  await drain();
  assert.strictEqual(cache.__test.inflight.size, 1, 'loader should be in flight');
  await cache.drop(dropKey);
  assert.strictEqual(cache.__test.inflight.size, 0, 'drop() must evict the in-flight entry');
  resolveLoader();
  await inflightRead;

  console.log('✅ cache.service tests passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
