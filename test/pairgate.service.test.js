/**
 * node test/pairgate.service.test.js
 *
 * No network. Every check here is a decision that, taken wrongly, costs a
 * customer money without anyone seeing an error:
 *
 *   - a declined vend read as accepted debits the wallet and delivers nothing;
 *   - a wrong DISCO slug pays a real bill to the wrong distributor;
 *   - a forged webhook accepted as genuine hands out refunds;
 *   - a display name the app's logo resolver mis-matches ships the wrong brand.
 *
 * All of it is pure - shape parsing and table lookups - so it runs offline.
 */
const assert = require('assert');
const crypto = require('crypto');

process.env.PAIRGATE_API_KEY = process.env.PAIRGATE_API_KEY || 'pg_test';
process.env.PAIRGATE_WEBHOOK_SECRET = 'whsec_test_only';

const pg = require('../src/funding/pairgate.service');
const { parseDelivery } = require('../src/controllers/pairgateWebhook.controller');

/* --------------------------------------------------------- vend acceptance */

// The one that matters most. A rejected vend still answers HTTP 200 with an
// envelope of `status: "success"`; the decline is `data.status: false`.
assert.strictEqual(
  pg.vendFailure({ status: 'success', data: { status: false, message: 'Network unavailable' } }),
  'Network unavailable'
);

// Strictly `false`, not falsy. A sandbox purchase carries no `data.status` at
// all, and reading `undefined` as a decline would refund every test vend.
assert.strictEqual(pg.vendFailure({ status: 'success', data: { reference_code: 'PG1' } }), null);
assert.strictEqual(pg.vendFailure({ status: 'success', data: { status: true } }), null);
assert.strictEqual(pg.vendFailure({ status: 'success', data: null }), null);
assert.strictEqual(pg.vendFailure(null), null);

// A decline with no message still has to produce one - an empty error surfaces
// to the customer as a blank alert.
assert.strictEqual(
  pg.vendFailure({ status: 'error', message: 'Vend rejected', data: { status: false } }),
  'Vend rejected'
);

/* ------------------------------------------------------------ error wording */

// The vend-level message is more specific than the envelope's, so it wins.
assert.strictEqual(
  pg.firstErrorMessage({ message: 'Request failed', data: { message: 'Invalid meter number' } }),
  'Invalid meter number'
);
assert.strictEqual(pg.firstErrorMessage({ message: 'Request failed' }), 'Request failed');
assert.strictEqual(pg.firstErrorMessage({}), 'PairGate request failed');

// Our float, not the customer's wallet. Misclassifying this tells a funded
// customer their balance is too low, which is both wrong and unactionable.
assert.ok(pg.isFloatError('Insufficient balance'));
assert.ok(pg.isFloatError('insufficient wallet balance'));
assert.ok(pg.isFloatError('Low balance, please fund your account'));
assert.ok(!pg.isFloatError('Invalid meter number'));
assert.ok(!pg.isFloatError(''));

/* -------------------------------------------------------------- vend result */

{
  const vend = pg.parseVendResult({
    status: 'success',
    data: { reference_code: 'PG-abc123', status: true, amount: '1000', plan: '1GB (CG) - 7 Days' },
  });
  assert.strictEqual(vend.reference, 'PG-abc123');
  assert.strictEqual(vend.status, 'successful');
  assert.strictEqual(vend.amount, 1000);
  assert.strictEqual(vend.plan, '1GB (CG) - 7 Days');
  // Never present on this rail. The receipt renders "processing" until the
  // webhook fills it in, and a test asserting otherwise would hide that.
  assert.strictEqual(vend.token, '');
}

// Accepted but not yet delivered: no boolean true, so it stays in flight rather
// than being marked successful on a promise.
assert.strictEqual(pg.parseVendResult({ data: { reference_code: 'PG-x' } }).status, 'processing');
assert.strictEqual(pg.parseVendResult({}).reference, '');

/* ----------------------------------------------------------- customer lookup */

// A biller that cannot place the number answers with a blank name rather than
// an error. Letting that through shows a meter with no owner on the sheet.
assert.strictEqual(pg.parseCustomer({ data: { customer_name: '  ADAMU BELLO ' } }).customer_name, 'ADAMU BELLO');
assert.strictEqual(pg.parseCustomer({ data: { customer_name: '' } }).customer_name, '');
assert.strictEqual(pg.parseCustomer(null).customer_name, '');
// Kept so the app's BillCustomer model does not have to special-case its absence.
assert.strictEqual(pg.parseCustomer({ data: {} }).address, '');

/* ------------------------------------------------------------------- slugs */

assert.strictEqual(pg.networkSlug('MTN'), 'mtn');
assert.strictEqual(pg.networkSlug('9 Mobile'), '9mobile');
assert.strictEqual(pg.networkSlug('Etisalat'), '9mobile');
assert.strictEqual(pg.networkSlug('Globacom'), 'glo');
assert.strictEqual(pg.networkSlug(''), '');

assert.strictEqual(pg.tvSlug('DStv'), 'dstv');
assert.strictEqual(pg.tvSlug('StarTimes'), 'startimes');
assert.strictEqual(pg.tvSlug('GOtv'), 'gotv');

// Electricity is where a wrong answer pays a real bill to the wrong DISCO, and
// the app's codes predate this provider. Both spellings have to land.
assert.strictEqual(pg.DISCO_SLUGS.PHED, 'ph');
assert.strictEqual(pg.DISCO_SLUGS.EKEDC, 'eko');
assert.strictEqual(pg.DISCO_SLUGS.KAEDCO, 'kaduna');
assert.strictEqual(pg.DISCO_SLUGS.KEDCO, 'kedco');
assert.strictEqual(pg.DISCO_SLUGS.JED, 'jedc');

// Kaduna and Kano are the pair that actually collide in the wild: KAEDCO/kaduna
// against KEDCO/kedco. They must never resolve to the same slug.
assert.notStrictEqual(pg.DISCO_SLUGS.KAEDCO, pg.DISCO_SLUGS.KEDCO);

// Every slug the bridge can produce must have a display name, or the picker
// shows PairGate's full sentence and the app sends back something unmappable.
for (const [code, slug] of Object.entries(pg.DISCO_SLUGS)) {
  assert.ok(pg.DISCO_DISPLAY[slug], `no display name for slug ${slug} (from ${code})`);
}

// Round trip: what the app is shown must map back to the same slug it came from.
for (const [slug, display] of Object.entries(pg.DISCO_DISPLAY)) {
  assert.strictEqual(pg.DISCO_SLUGS[display], slug, `${display} does not map back to ${slug}`);
}

/* ------------------------------------------------------------- meter typing */

assert.strictEqual(pg.normalizeMeterType('PREPAID'), 'prepaid');
assert.strictEqual(pg.normalizeMeterType('postpaid'), 'postpaid');
assert.strictEqual(pg.normalizeMeterType('2'), 'postpaid');
// Anything unrecognised is prepaid: it is the common case, and a postpaid meter
// billed as prepaid is rejected by the DISCO rather than silently mispaid.
assert.strictEqual(pg.normalizeMeterType(''), 'prepaid');
assert.strictEqual(pg.meterTypeCode('postpaid'), 2);
assert.strictEqual(pg.meterTypeCode('prepaid'), 1);

/* ---------------------------------------------------------- catalogue shapes */

{
  // Electricity: `name` is what the app displays and sends back, so it has to be
  // the legacy code, not the provider's sentence.
  const shaped = pg.shapeProviders(
    [{ id: 7, name: 'Kaduna Electricity Distribution Company - KAEDCO', slug: 'kaduna' }],
    'electricity'
  );
  assert.strictEqual(shaped[0].name, 'KAEDCO');
  assert.strictEqual(shaped[0].code, 'kaduna');
  assert.strictEqual(shaped[0].full_name, 'Kaduna Electricity Distribution Company - KAEDCO');

  const networks = pg.shapeProviders([{ id: 1, name: 'MTN' }], 'airtime');
  assert.strictEqual(networks[0].code, 'mtn');
  assert.strictEqual(networks[0].name, 'MTN');

  assert.deepStrictEqual(pg.shapeProviders(null, 'airtime'), []);
}

// Plans arrive grouped under the network's display name rather than as an array.
assert.strictEqual(pg.flattenPlans({ MTN: [{ id: 1 }, { id: 2 }] }).length, 2);
assert.strictEqual(pg.flattenPlans({ MTN: [{ id: 1 }], GLO: [{ id: 2 }] }).length, 2);
assert.strictEqual(pg.flattenPlans([{ id: 1 }]).length, 1);
assert.strictEqual(pg.flattenPlans(null).length, 0);

/* --------------------------------------------------------- webhook signature */

function sign(body, ts, secret = process.env.PAIRGATE_WEBHOOK_SECRET) {
  return crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

{
  const body = JSON.stringify({ data: { reference_code: 'PG-1', status: 'successful' } });
  const ts = String(Math.floor(Date.now() / 1000));

  const good = pg.verifyWebhookSignature({ rawBody: body, signature: sign(body, ts), timestamp: ts });
  assert.strictEqual(good.verified, true);

  // Wrong secret.
  const forged = pg.verifyWebhookSignature({
    rawBody: body,
    signature: sign(body, ts, 'whsec_wrong'),
    timestamp: ts,
  });
  assert.strictEqual(forged.verified, false);

  // Right signature, tampered body - the case a naive "signature present" check
  // would wave through.
  const tampered = JSON.stringify({ data: { reference_code: 'PG-1', status: 'failed' } });
  assert.strictEqual(
    pg.verifyWebhookSignature({ rawBody: tampered, signature: sign(body, ts), timestamp: ts }).verified,
    false
  );

  // Replayed. Without the age check a captured delivery stays valid for as long
  // as the secret does.
  const old = String(Math.floor(Date.now() / 1000) - 3600);
  const stale = pg.verifyWebhookSignature({ rawBody: body, signature: sign(body, old), timestamp: old });
  assert.strictEqual(stale.verified, false);
  assert.strictEqual(stale.reason, 'stale');

  // A signature of a different length must not throw - timingSafeEqual does.
  assert.strictEqual(
    pg.verifyWebhookSignature({ rawBody: body, signature: 'short', timestamp: ts }).verified,
    false
  );

  assert.strictEqual(pg.verifyWebhookSignature({ rawBody: body, signature: '', timestamp: ts }).verified, false);
}

// No secret configured is reported as such rather than as a failure, because the
// caller reacts differently: it falls back to requerying the provider.
{
  const saved = process.env.PAIRGATE_WEBHOOK_SECRET;
  delete process.env.PAIRGATE_WEBHOOK_SECRET;
  const unset = pg.verifyWebhookSignature({ rawBody: '{}', signature: 'x', timestamp: '1' });
  assert.strictEqual(unset.configured, false);
  assert.strictEqual(unset.verified, false);
  process.env.PAIRGATE_WEBHOOK_SECRET = saved;
}

/* ----------------------------------------------------------- webhook parsing */

{
  // Wrapped in `data`, which is the documented shape.
  const wrapped = parseDelivery({
    event: 'transaction.successful',
    data: { reference_code: 'PG-9', status: 'successful', pin: '1234-5678-9012', units: '23.4' },
  });
  assert.strictEqual(wrapped.reference, 'PG-9');
  assert.strictEqual(wrapped.status, 'successful');
  assert.strictEqual(wrapped.token, '1234-5678-9012');
  assert.strictEqual(wrapped.units, '23.4');

  // Flat, which is what a webhook tester usually sends.
  assert.strictEqual(parseDelivery({ reference_code: 'PG-9', status: 'failed' }).status, 'failed');

  // Boolean status. String(false) is "false", which settlement would treat as
  // non-final and leave the row processing forever.
  assert.strictEqual(parseDelivery({ reference_code: 'PG-9', status: false }).status, 'failed');
  assert.strictEqual(parseDelivery({ reference_code: 'PG-9', status: true }).status, 'successful');

  // Outcome carried only by the event name.
  assert.strictEqual(parseDelivery({ event: 'transaction.failed', data: { reference_code: 'PG-9' } }).status, 'failed');

  // Nothing usable: no reference means the delivery is acknowledged and dropped.
  assert.strictEqual(parseDelivery({}).reference, '');
  assert.strictEqual(parseDelivery(null).reference, '');
}

/* --------------------------------------------------------------- floor check */

// Quoting under the provider's floor reserves a customer's money for a vend that
// is rejected on arrival.
//
// These track PairGate, not VoltPay. The electricity figure was read from their
// validator rather than their docs - POST /test/electricity/purchase at 70 comes
// back `{"amount":["The amount field must be at least 100."]}` and 100 is
// accepted - so this asserts 100, not the 1000 originally assumed here. What a
// customer actually sees is the higher floor in SERVICES (bills.controller),
// which is a business decision and is free to move; this one is not.
// The customer-facing floor cannot fall below this one: bills.controller quotes
// `Math.max(500, MIN_AMOUNTS.electricity)`, so the guarantee is structural and
// needs no assertion of its own.
assert.strictEqual(pg.MIN_AMOUNTS.electricity, 100);
assert.strictEqual(pg.MIN_AMOUNTS.airtime, 50);

/* ------------------------------------------------- warm pass, without a cache */

// This suite runs with no UPSTASH_* set, so Redis is disabled - which is exactly
// the state the assertions below are about, and is why they can be offline.
//
// A forced warm exists to replace the *Redis* copy of each catalogue before it
// goes stale. loadInto caps the in-process tier at PAIRGATE_LOCAL_TTL_MS (60s),
// so with no Redis behind it the whole pass is gone a minute later while the
// next tick is 25 minutes out: 20 provider calls to cover 4% of the cycle,
// drawn from the same 60-a-minute budget the vends use. It must decline.
//
// The regression this pins down is subtler than "it skips". It skipped before
// too, but for the wrong reason and under the wrong name: claimRefresh returned
// a boolean, redis.command() reports a failure as null, and null read as
// "another instance holds the lock". A Redis outage was therefore indistinguish-
// able from normal contention, so warming stopped fleet-wide and the log said
// nothing at all. The reason has to survive, because it is what the caller logs.
(async () => {
  const skippedNoCache = await pg.warmCatalogues({ force: true });
  assert.strictEqual(skippedNoCache.skipped, 'no_shared_cache', 'no Redis is not the same fact as locked');
  assert.strictEqual(skippedNoCache.calls, 0, 'a declined pass must not call the provider');

  // The key check is read at call time, so an unconfigured checkout stays silent
  // rather than logging a dozen identical auth failures at every boot.
  const key = process.env.PAIRGATE_API_KEY;
  process.env.PAIRGATE_API_KEY = '';
  try {
    assert.strictEqual((await pg.warmCatalogues({ force: true })).skipped, 'no_api_key');
  } finally {
    process.env.PAIRGATE_API_KEY = key;
  }

  console.log('pairgate.service tests passed');
})().catch(e => {
  console.error(e);
  process.exit(1);
});
