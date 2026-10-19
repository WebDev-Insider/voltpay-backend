/**
 * node test/cashbuddy.service.test.js
 *
 * The CashBuddy adapter against a scripted copy of their partner API - no
 * network. Response shapes are the ones their live API actually sends where
 * they differ from the docs (a 401 is `{ error: "Unauthorized. ..." }`; a
 * missing field is HTTP 500).
 *
 *   1. Airtime only, paid from VoltPay's own CashBuddy account - never a
 *      customer's.
 *   2. Refusals become customer-safe errors with the right flags.
 *   3. An answer we could not read is NOT a refund: it comes back
 *      `unconfirmed`, and the purchase is never sent twice.
 *   4. The history read that finds a lost purchase says honestly whether it
 *      covered the whole window, whichever way their list is sorted.
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);
process.env.CASHBUDDY_API_KEY = 'cb_live_test';
process.env.CASHBUDDY_USER_ID = 'f7a1c3b2-0001-4e8d-bcf1-aabbccddeeff';
delete process.env.CASHBUDDY_USER_EMAIL;
delete process.env.CASHBUDDY_USER_PHONE;
process.env.PROVIDER_MAX_RETRIES = '0';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.NODE_ENV = 'test';

/* ----------------------------------------------------------- fake API */

let routes = {};
let calls = [];

function route(method, path, reply) {
  routes[`${method} ${path}`] = typeof reply === 'function' ? reply : () => reply;
}

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = String(opts.method || 'GET').toUpperCase();
  const path = u.pathname.replace('/functions/v1/partner-api', '');
  const query = Object.fromEntries(u.searchParams.entries());
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ method, path, query, body, headers: opts.headers || {} });
  const handler = routes[`${method} ${path}`];
  if (!handler) return { status: 404, headers: { get: () => null }, text: async () => JSON.stringify({ error: `Endpoint not found: ${method} ${path}` }) };
  const out = await handler({ query, body });
  const text = typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
  return { status: out.status || 200, headers: { get: () => null }, text: async () => text };
};

function reset() {
  routes = {};
  calls = [];
}

const cb = require('../src/funding/cashbuddy.service');

async function throws(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

const buy = (over = {}) => cb.buyAirtime({ provider: 'MTN', number: '+2348031234567', amount: 500, reference: 'air_1', ...over });

(async () => {
  /* ======================================================== the purchase */

  reset();
  route('POST', '/bills', { body: { success: true, reference: 'vtpass_tx_12345', status: 'delivered' } });
  let json = await buy();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].headers['X-API-Key'], 'cb_live_test');
  assert.deepStrictEqual(calls[0].body, {
    service_type: 'airtime',
    provider: 'mtn',
    amount: 500,
    phone_number: '08031234567',
    // VoltPay's own account pays - the customer's details are not CashBuddy's.
    user_id: 'f7a1c3b2-0001-4e8d-bcf1-aabbccddeeff',
  });
  let vend = cb.parseVendResult(json);
  assert.strictEqual(vend.status, 'successful');
  assert.strictEqual(vend.reference, 'vtpass_tx_12345');
  assert.strictEqual(vend.unconfirmed, false);

  reset();
  route('POST', '/bills', { body: { success: true, reference: 'vt_2', status: 'pending' } });
  vend = cb.parseVendResult(await buy({ provider: '9mobile' }));
  assert.strictEqual(vend.status, 'processing');
  assert.strictEqual(calls[0].body.provider, '9mobile');

  // The account can be named by email when no profile id is set.
  delete process.env.CASHBUDDY_USER_ID;
  process.env.CASHBUDDY_USER_EMAIL = 'float@voltpay.example';
  reset();
  route('POST', '/bills', { body: { success: true, reference: 'vt_3', status: 'delivered' } });
  await buy();
  assert.strictEqual(calls[0].body.email, 'float@voltpay.example');
  assert.strictEqual(calls[0].body.user_id, undefined);
  delete process.env.CASHBUDDY_USER_EMAIL;
  // ...and with neither, nothing is sent at all.
  reset();
  let err = await throws(buy());
  assert.ok(err.misconfigured);
  assert.strictEqual(calls.length, 0);
  assert.deepStrictEqual(cb.configStatus().missing, ['CASHBUDDY_USER_ID']);
  process.env.CASHBUDDY_USER_ID = 'f7a1c3b2-0001-4e8d-bcf1-aabbccddeeff';

  /* ============================================================== refusals */

  // Their documented float error: ours to fix, never shown as the customer's.
  reset();
  route('POST', '/bills', { status: 400, body: { success: false, error: 'INSUFFICIENT_BALANCE', message: 'User does not have enough NGN/USD wallet balance.' } });
  err = await throws(buy());
  assert.ok(err.floatExhausted);
  assert.ok(!/balance/i.test(err.message));

  // A bad key, in the shape the live API sends.
  reset();
  route('POST', '/bills', { status: 401, body: { error: 'Unauthorized. Missing API key.' } });
  err = await throws(buy());
  assert.ok(err.misconfigured && !err.ambiguous);

  // A missing field came back HTTP 500 on the live API. It bought nothing, so
  // it is a refusal - not an unknown that would sit unconfirmed for 30 minutes.
  reset();
  route('POST', '/bills', { status: 500, body: { success: false, error: 'User identifier (user_id, email, or phone) is required' } });
  err = await throws(buy());
  assert.ok(err.misconfigured && !err.ambiguous);

  reset();
  route('POST', '/bills', { status: 400, body: { success: false, error: 'INVALID_REQUEST', message: 'Invalid phone number' } });
  err = await throws(buy());
  assert.strictEqual(err.kind, 'input');
  assert.ok(/phone number/i.test(err.message));

  reset();
  route('POST', '/bills', { status: 400, body: { success: false, error: 'INVALID_REQUEST', message: 'Minimum airtime amount is ₦50' } });
  err = await throws(buy());
  assert.strictEqual(err.kind, 'limit');

  // Accepted in shape, failed in substance.
  reset();
  route('POST', '/bills', { body: { success: true, reference: 'vt_4', status: 'failed', message: 'Transaction failed' } });
  err = await throws(buy());
  assert.ok(!err.ambiguous);
  assert.strictEqual(err.message, 'Airtime purchase failed. Please try again.');

  // Their limiter refuses before anything runs.
  reset();
  route('POST', '/bills', { status: 429, body: { success: false, error: 'RATE_LIMITED' } });
  err = await throws(buy());
  assert.strictEqual(err.statusCode, 429);
  assert.ok(!err.ambiguous);

  /* =============================================== unknown is not refunded */

  // A dropped connection: no throw, no second purchase - unconfirmed.
  reset();
  route('POST', '/bills', () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
  });
  vend = cb.parseVendResult(await buy());
  assert.strictEqual(vend.unconfirmed, true);
  assert.strictEqual(vend.status, 'processing');
  assert.strictEqual(vend.reference, '');
  assert.strictEqual(calls.length, 1, 'never sent twice - a second POST is a second purchase');

  // Their server failed partway: may have reached VTPass.
  reset();
  route('POST', '/bills', { status: 500, body: { success: false, error: 'INTERNAL_ERROR', message: 'Unexpected server error.' } });
  assert.strictEqual(cb.parseVendResult(await buy()).unconfirmed, true);

  reset();
  route('POST', '/bills', { status: 502, body: '<html>Bad Gateway</html>' });
  assert.strictEqual(cb.parseVendResult(await buy()).unconfirmed, true);

  // Accepted with a word we do not know: with their reference it is an order
  // that can be asked about; without one it is as lost as a timeout.
  reset();
  route('POST', '/bills', { body: { success: true, reference: 'vt_5', status: 'queued_for_vtpass' } });
  vend = cb.parseVendResult(await buy());
  assert.strictEqual(vend.status, 'processing');
  assert.strictEqual(vend.reference, 'vt_5');
  assert.strictEqual(vend.unconfirmed, false);
  reset();
  route('POST', '/bills', { body: { success: true } });
  assert.strictEqual(cb.parseVendResult(await buy()).unconfirmed, true);

  /* ========================================================= the lookup */

  reset();
  route('GET', '/bills/vt_6', {
    body: { success: true, transaction: { id: 'uuid1', service_type: 'airtime', amount: 500, status: 'completed', vtpass_reference: 'vt_6', phone_number: '08031234567', created_at: '2026-10-19T10:15:00Z' } },
  });
  let remote = await cb.getTransactionStatus('vt_6');
  assert.strictEqual(remote.status, 'successful', 'their records say "completed"');
  assert.strictEqual(remote.reference_code, 'vt_6');
  assert.ok(!JSON.stringify(remote).includes('8031234567'), 'the recipient is not carried out of the adapter');

  reset();
  route('GET', '/bills/nope', { status: 404, body: { error: 'Bill transaction not found.' } });
  remote = await cb.getTransactionStatus('nope');
  assert.strictEqual(remote.status, 'not_found');

  /* ================================================ the history read */

  const T = Date.parse('2026-10-19T12:00:00Z');
  const bill = (minutes, extra = {}) => ({
    id: `id_${minutes}`,
    service_type: 'airtime',
    amount: 500,
    status: 'completed',
    vtpass_reference: `vt_${minutes}`,
    phone_number: '08031234567',
    created_at: new Date(T + minutes * 60_000).toISOString(),
    ...extra,
  });

  // Newest first, fits on one page: complete.
  reset();
  route('GET', '/bills', ({ query }) => {
    assert.strictEqual(query.user_id, 'f7a1c3b2-0001-4e8d-bcf1-aabbccddeeff', 'reads OUR account\'s history');
    return { body: { success: true, transactions: [bill(5), bill(1)], pagination: { page: 1, limit: 50, total: 2 } } };
  });
  let listing = await cb.listRecentOrders({ since: new Date(T) });
  assert.strictEqual(listing.complete, true);
  assert.deepStrictEqual(listing.orders.map(o => o.reference), ['vt_5', 'vt_1']);
  assert.deepStrictEqual(
    { service: listing.orders[0].service, amount: listing.orders[0].amount, status: listing.orders[0].status },
    { service: 'airtime', amount: 500, status: 'successful' }
  );

  // Newest first across pages: read forward until it passes `since`.
  reset();
  const newest = Array.from({ length: 6 }, (_, i) => bill(60 - i * 10)); // 60,50,...,10 minutes
  route('GET', '/bills', ({ query }) => {
    const page = Number(query.page);
    const size = Number(query.limit);
    return { body: { success: true, transactions: newest.slice((page - 1) * size, page * size), pagination: { page, limit: size, total: 6 } } };
  });
  listing = await cb.listRecentOrders({ since: new Date(T + 35 * 60_000), pageSize: 2 });
  assert.strictEqual(listing.complete, true, 'stopped once a page went older than since');
  assert.strictEqual(calls.length, 2, 'pages 1 and 2 only');

  // Too much traffic to reach `since` within the page budget: not complete -
  // an empty result from a partial read must not count towards a refund.
  calls = [];
  listing = await cb.listRecentOrders({ since: new Date(T), pageSize: 2, maxPages: 2 });
  assert.strictEqual(listing.complete, false);

  // Oldest first: the recent bills are on the last pages.
  reset();
  const oldest = Array.from({ length: 6 }, (_, i) => bill(10 + i * 10)); // 10,20,...,60
  route('GET', '/bills', ({ query }) => {
    const page = Number(query.page);
    const size = Number(query.limit);
    return { body: { success: true, transactions: oldest.slice((page - 1) * size, page * size), pagination: { page, limit: size, total: 6 } } };
  });
  listing = await cb.listRecentOrders({ since: new Date(T + 35 * 60_000), pageSize: 2 });
  assert.strictEqual(listing.complete, true);
  assert.ok(listing.orders.some(o => o.reference === 'vt_60'), 'the newest bill was read');
  assert.deepStrictEqual(calls.map(c => c.query.page), ['1', '3', '2']);

  /* ================================================================ shape */

  assert.deepStrictEqual(cb.SERVICES, ['airtime']);
  assert.strictEqual(cb.SUPPORTS_REQUEST_ID_LOOKUP, false);
  assert.strictEqual(cb.FLOAT_READABLE, false);
  assert.deepStrictEqual((await cb.listAirtimeProvidersCached()).map(n => n.name), ['MTN', 'AIRTEL', 'GLO', '9MOBILE']);
  assert.deepStrictEqual(await cb.warmCatalogues(), { loaded: 0, failed: 0, calls: 0, skipped: 'no_catalogue' });

  console.log('✅ cashbuddy adapter tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
