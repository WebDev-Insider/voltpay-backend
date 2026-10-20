/**
 * node test/clubkonnect.service.test.js
 *
 * The ClubKonnect adapter against a scripted copy of their API - no network.
 *
 *   1. Status codes read from their dispute table, code first: 200 is the only
 *      delivery, 201/299 are not, 4xx/5xx-coded orders are refused/cancelled.
 *   2. Refusals become customer-safe errors with the right flags - our key and
 *      our float are outages, a bad number is the customer's.
 *   3. A purchase is sent once, never retried. An answer we could not read is
 *      asked about by our RequestID before anyone refunds it.
 *   4. Catalogues come out in the shape MySubWallet's do, Showmax left out.
 *   5. No electricity: nothing to call.
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);
process.env.CLUBKONNECT_USER_ID = 'CK123';
process.env.CLUBKONNECT_API_KEY = 'ck_secret';
process.env.CLUBKONNECT_RECOVERY_DELAY_MS = '0';
process.env.CLUBKONNECT_CATALOGUE_GAP_MS = '0';
process.env.PROVIDER_MAX_RETRIES = '0';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.NODE_ENV = 'test';

/* ----------------------------------------------------------- fake API */

let routes = {};
let calls = [];

function route(path, reply) {
  routes[path] = typeof reply === 'function' ? reply : () => reply;
}

function networkError() {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  });
}

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const params = Object.fromEntries(u.searchParams.entries());
  calls.push({ path: u.pathname, params, method: opts.method || 'GET' });
  const handler = routes[u.pathname];
  if (!handler) throw new Error(`unrouted ${u.pathname}`);
  const out = await handler(params);
  const text = typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
  return { status: out.status || 200, headers: { get: () => null }, text: async () => text };
};

function reset() {
  routes = {};
  calls = [];
}

const ck = require('../src/funding/clubkonnect.service');
const { classifyStatus, declined, shapePlanName, shapeTvName, isErrorWord } = ck.__test;

async function throws(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

(async () => {
  /* ===================================================== status classifying */

  assert.strictEqual(classifyStatus('200', 'ORDER_COMPLETED'), 'successful');
  // ORDER_COMPLETED is also 201 (network unresponsive, retried for an hour)
  // and 299 (unspecified error): neither is a delivery.
  assert.strictEqual(classifyStatus('201', 'ORDER_COMPLETED'), 'processing');
  assert.strictEqual(classifyStatus('299', 'ORDER_COMPLETED'), 'processing');
  for (const code of ['100', '199', '300', '399', '600', '601', '603', '699', '799']) {
    assert.strictEqual(classifyStatus(code), 'processing', `${code} is still open`);
  }
  // 412: a float shortfall put on hold and retried, not a refusal.
  assert.strictEqual(classifyStatus('412', 'ORDER_ERROR'), 'processing');
  for (const code of ['400', '409', '417', '418', '499', '500', '509', '516', '599', '602', '899']) {
    assert.strictEqual(classifyStatus(code), 'failed', `${code} is final`);
  }
  // Without a code, ORDER_COMPLETED proves nothing.
  assert.strictEqual(classifyStatus('', 'ORDER_COMPLETED'), 'processing');
  assert.strictEqual(classifyStatus('', 'ORDER_RECEIVED'), 'processing');
  assert.strictEqual(classifyStatus('', 'ORDER_CANCELLED'), 'failed');
  assert.strictEqual(classifyStatus('', 'INVALID_CREDENTIALS'), 'failed');
  assert.strictEqual(classifyStatus('', 'SOMETHING_NEW'), '', 'unknown is unknown, never success');
  assert.strictEqual(classifyStatus('', ''), '');

  /* ============================================================== refusals */

  const credentials = declined({ word: 'INVALID_CREDENTIALS' });
  assert.ok(credentials.misconfigured && credentials.kind === 'outage');
  assert.strictEqual(credentials.message, ck.__test.UNAVAILABLE, 'never tells a customer about our key');

  // The enum can sit in the remark under the generic ORDER_ERROR status.
  const phone = declined({ word: 'ORDER_ERROR', remark: 'INVALID_RECIPIENT', code: '409' });
  assert.strictEqual(phone.kind, 'input');
  assert.ok(/phone number/i.test(phone.message));

  const float = declined({ word: 'ORDER_ERROR', remark: 'INSUFFICIENT_BALANCE', code: '417' });
  assert.ok(float.floatExhausted, 'our float, not the customer\'s wallet');
  assert.ok(!/insufficient/i.test(float.message));
  assert.ok(declined({ word: 'INSUFFICIENT_APISTOREAMOUNT' }).floatExhausted);

  const minimum = declined({ word: 'MINIMUM_100' });
  assert.strictEqual(minimum.kind, 'limit');
  assert.strictEqual(minimum.message, 'The minimum amount is NGN 100.');

  assert.ok(declined({ word: 'INVALID_MOBILENETWORK' }).misconfigured, 'one of OUR ids');
  assert.ok(/plan/i.test(declined({ word: 'PACKAGE_NOT_AVAILABLE' }).message));
  assert.strictEqual(declined({ word: 'ORDER_CANCELLED', remark: 'Not a valid subscriber', code: '516' }).kind, 'input');
  const unknown = declined({ word: 'ORDER_CANCELLED', remark: 'Unspecified Error', code: '599' });
  assert.strictEqual(unknown.kind, 'unknown');
  assert.ok(!/unspecified/i.test(unknown.message), 'their wording stays on providerMessage');
  assert.ok(isErrorWord('INVALID_SMARTCARDNO') && !isErrorWord('BALOGUN SUNDAY'));

  /* ============================================================== airtime */

  reset();
  route('/APIAirtimeV1.asp', { body: { orderid: '6501205781', statuscode: '100', status: 'ORDER_RECEIVED' } });
  let json = await ck.buyAirtime({ provider: 'MTN', number: '+2348031234567', amount: 500, reference: 'air_1_abc' });
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].params, {
    UserID: 'CK123',
    APIKey: 'ck_secret',
    MobileNetwork: '01',
    Amount: '500',
    MobileNumber: '08031234567',
    RequestID: 'air_1_abc',
  });
  let vend = ck.parseVendResult(json);
  assert.strictEqual(vend.status, 'processing', 'ORDER_RECEIVED is accepted, not delivered');
  assert.strictEqual(vend.reference, '6501205781', 'their order id is what the query takes');

  reset();
  route('/APIAirtimeV1.asp', { body: { orderid: '7', statuscode: '200', status: 'ORDER_COMPLETED' } });
  vend = ck.parseVendResult(await ck.buyAirtime({ provider: 'airtel', number: '08031234567', amount: 100, reference: 'air_2' }));
  assert.strictEqual(vend.status, 'successful');
  assert.strictEqual(calls[0].params.MobileNetwork, '04', 'Airtel is 04 - their order, nobody else\'s');

  // A refusal on HTTP 200: thrown, sent once, never asked about.
  reset();
  route('/APIAirtimeV1.asp', { body: { status: 'INVALID_RECIPIENT' } });
  let err = await throws(ck.buyAirtime({ provider: 'MTN', number: '08031234567', amount: 100, reference: 'air_3' }));
  assert.strictEqual(err.kind, 'input');
  assert.ok(!err.ambiguous);
  assert.deepStrictEqual(calls.map(c => c.path), ['/APIAirtimeV1.asp']);

  // A bare status word on the wire (not JSON) is still read.
  reset();
  route('/APIAirtimeV1.asp', { body: 'INVALID_CREDENTIALS' });
  err = await throws(ck.buyAirtime({ provider: 'MTN', number: '08031234567', amount: 100, reference: 'air_4' }));
  assert.ok(err.misconfigured);

  // Fractions and unknown networks never reach them.
  reset();
  err = await throws(ck.buyAirtime({ provider: 'MTN', number: '08031234567', amount: 100.5, reference: 'air_5' }));
  assert.strictEqual(err.statusCode, 400);
  err = await throws(ck.buyAirtime({ provider: 'VODAFONE', number: '08031234567', amount: 100, reference: 'air_5' }));
  assert.strictEqual(err.statusCode, 400);
  assert.strictEqual(calls.length, 0);

  /* ================================================ lost answers: recovery */

  // Timed out, then found delivered under our RequestID: kept, not refunded.
  reset();
  route('/APIAirtimeV1.asp', () => {
    throw networkError();
  });
  route('/APIQueryV1.asp', { body: { orderid: '88', statuscode: '200', status: 'ORDER_COMPLETED', requestid: 'air_6' } });
  vend = ck.parseVendResult(await ck.buyAirtime({ provider: 'MTN', number: '08031234567', amount: 100, reference: 'air_6' }));
  assert.strictEqual(vend.status, 'successful');
  assert.strictEqual(vend.reference, '88');
  assert.deepStrictEqual(calls.map(c => c.path), ['/APIAirtimeV1.asp', '/APIQueryV1.asp'], 'the vend itself is never repeated');
  assert.strictEqual(calls[1].params.RequestID, 'air_6', 'asked about by OUR reference');

  // Their 5xx, then found still in flight: kept as processing.
  reset();
  route('/APIAirtimeV1.asp', { status: 502, body: '<html>Bad Gateway</html>' });
  route('/APIQueryV1.asp', { body: { orderid: '89', statuscode: '201', status: 'ORDER_COMPLETED' } });
  vend = ck.parseVendResult(await ck.buyAirtime({ provider: 'MTN', number: '08031234567', amount: 100, reference: 'air_7' }));
  assert.strictEqual(vend.status, 'processing');

  // Found failed: a refusal the caller refunds.
  reset();
  route('/APIAirtimeV1.asp', () => {
    throw networkError();
  });
  route('/APIQueryV1.asp', { body: { orderid: '90', statuscode: '516', status: 'ORDER_CANCELLED', remark: 'Not a valid subscriber' } });
  err = await throws(ck.buyAirtime({ provider: 'MTN', number: '08031234567', amount: 100, reference: 'air_8' }));
  assert.ok(!err.ambiguous);
  assert.strictEqual(err.kind, 'input');

  // Not found: it never landed, so the original (ambiguous) error goes up and
  // the caller refunds - the rule every rail follows inside vend().
  reset();
  route('/APIAirtimeV1.asp', () => {
    throw networkError();
  });
  route('/APIQueryV1.asp', { body: { status: 'ORDER_NOT_FOUND' } });
  err = await throws(ck.buyAirtime({ provider: 'MTN', number: '08031234567', amount: 100, reference: 'air_9' }));
  assert.ok(err.ambiguous);

  // An answer we do not recognise is an unknown, asked about like a timeout.
  reset();
  route('/APIAirtimeV1.asp', { body: { status: 'DUPLICATE_REQUESTID' } });
  route('/APIQueryV1.asp', { body: { orderid: '91', statuscode: '100', status: 'ORDER_RECEIVED' } });
  vend = ck.parseVendResult(await ck.buyAirtime({ provider: 'MTN', number: '08031234567', amount: 100, reference: 'air_10' }));
  assert.strictEqual(vend.reference, '91', 'the original order, found by our RequestID');

  /* ========================================================= the query */

  reset();
  route('/APIQueryV1.asp', params => ({ body: { orderid: params.OrderID || '55', statuscode: '200', status: 'ORDER_COMPLETED' } }));
  let remote = await ck.getTransactionStatus('6501205781');
  assert.strictEqual(calls[0].params.OrderID, '6501205781', 'their id goes in as OrderID');
  assert.strictEqual(remote.status, 'successful');
  // Our own references always carry letters - a reward cut off mid-send, or a
  // bill whose answer was lost - and go in as RequestID, never misread.
  remote = await ck.getTransactionStatus('bh_airtime_1792449445690_123');
  assert.strictEqual(calls[1].params.RequestID, 'bh_airtime_1792449445690_123');
  assert.strictEqual(calls[1].params.OrderID, undefined);

  reset();
  route('/APIQueryV1.asp', { body: { status: 'INVALID_ORDERID' } });
  assert.strictEqual((await ck.getTransactionStatus('123')).status, 'not_found');
  reset();
  route('/APIQueryV1.asp', { body: { status: 'INVALID_CREDENTIALS' } });
  err = await throws(ck.getTransactionStatus('123'));
  assert.ok(err.misconfigured, 'a refused query is an outage, never an answer about the order');

  /* =========================================================== data plans */

  assert.deepStrictEqual(shapePlanName('500 MB - 30 days (SME)'), {
    name: '500 MB (SME)',
    family: 'SME',
    duration: { days: 30, label: '30 days' },
  });
  assert.strictEqual(shapePlanName('1 GB - Monthly (Corporate Gifting)').name, '1 GB (CG)');
  assert.strictEqual(shapePlanName('1.5GB - 2 Days (Awoof Data)').name, '1.5GB (AWOOF)');
  const noValidity = shapePlanName('100 MB (GIFTING)');
  assert.strictEqual(noValidity.name, '100 MB (GIFTING)');
  assert.strictEqual(noValidity.duration, null, 'a validity nobody stated is never invented');

  reset();
  route('/APIDatabundlePlansV2.asp', {
    body: {
      MOBILE_NETWORK: {
        MTN: [{ ID: '01', PRODUCT: [
          { PRODUCT_ID: '1000.0', PRODUCT_NAME: '1 GB - 30 days (SME)', PRODUCT_AMOUNT: '650' },
          { PRODUCT_ID: '500.0', PRODUCT_NAME: '500 MB - 30 days (SME)', PRODUCT_AMOUNT: '330' },
          { PRODUCT_NAME: 'no id', PRODUCT_AMOUNT: '10' },
        ] }],
        m_9mobile: [{ PRODUCT: [{ PRODUCT_ID: '9M1', PRODUCT_NAME: '1 GB - 7 days (Gifting)', PRODUCT_AMOUNT: '484.912717854786' }] }],
      },
    },
  });
  const mtnPlans = await ck.listDataPlansCached('MTN');
  assert.deepStrictEqual(mtnPlans.map(p => p.id), ['500.0', '1000.0'], 'cheapest first, unsendable plans dropped');
  assert.deepStrictEqual(mtnPlans[0], { id: '500.0', name: '500 MB (SME)', amount: 330, plan_type: 'SME', duration_days: 30, validity: '30 days' });
  const nineMobile = await ck.listDataPlansCached('9mobile');
  assert.strictEqual(nineMobile[0].amount, 484.91, 'rounded to kobo');
  assert.strictEqual(calls.length, 1, 'every network from one call');

  reset();
  route('/APIDatabundleV1.asp', { body: { orderid: '92', statuscode: '100', status: 'ORDER_RECEIVED' } });
  await ck.buyData({ provider: 'MTN', planId: '500.0', number: '08031234567', reference: 'data_1' });
  assert.strictEqual(calls[0].params.DataPlan, '500.0');
  assert.strictEqual(calls[0].params.MobileNetwork, '01');

  /* =================================================================== tv */

  assert.strictEqual(shapeTvName('DStv Padi N3,600'), 'DStv Padi');
  assert.strictEqual(shapeTvName('GOtv Max - ₦7,200'), 'GOtv Max');
  assert.strictEqual(shapeTvName('Nova - 1 Month'), 'Nova - 1 Month', 'a name with no price keeps its words');

  reset();
  route('/APICableTVPackagesV2.asp', {
    body: {
      TV_ID: {
        DStv: [{ ID: 'dstv', PRODUCT: [{ PACKAGE_ID: 'dstv-padi', PACKAGE_NAME: 'DStv Padi N3,600', PACKAGE_AMOUNT: '3600' }] }],
        Showmax: [{ ID: 'showmax', PRODUCT: [{ PACKAGE_ID: 'showmax-mobile', PACKAGE_NAME: 'Showmax Mobile', PACKAGE_AMOUNT: '1600' }] }],
      },
    },
  });
  const tvProviders = await ck.listTvProvidersCached();
  assert.deepStrictEqual(tvProviders.map(p => p.name), ['DSTV'], 'Showmax has no smartcard flow in the app');
  assert.deepStrictEqual(await ck.listTvPackagesCached('DSTV'), [{ id: 'dstv-padi', code: 'dstv-padi', name: 'DStv Padi', amount: 3600 }]);

  reset();
  route('/APIVerifyCableTVV1.asp', { body: { customer_name: 'BALOGUN SUNDAY' } });
  assert.deepStrictEqual(await ck.validateTvSmartcard({ provider: 'DSTV', number: '1234567890' }), { customer_name: 'BALOGUN SUNDAY', address: '' });
  reset();
  route('/APIVerifyCableTVV1.asp', { body: { customer_name: 'INVALID_SMARTCARDNO' } });
  err = await throws(ck.validateTvSmartcard({ provider: 'DSTV', number: '1234567890' }));
  assert.strictEqual(err.kind, 'input', 'an error word in the name field is never somebody\'s name');
  assert.ok(/smartcard/i.test(err.message));

  reset();
  route('/APICableTVV1.asp', { body: { orderid: '93', statuscode: '100', status: 'ORDER_RECEIVED' } });
  await ck.payTv({ provider: 'DSTV', number: '1234567890', code: 'dstv-padi', phone: '2348031234567', reference: 'tv_1', customerName: 'X' });
  assert.deepStrictEqual(calls[0].params, {
    UserID: 'CK123',
    APIKey: 'ck_secret',
    CableTV: 'dstv',
    Package: 'dstv-padi',
    SmartCardNo: '1234567890',
    PhoneNo: '08031234567',
    RequestID: 'tv_1',
  });

  /* ===================================== a refused catalogue is not "no plans" */

  // The bug a live switch hit (2026-10-20): with a key they do not accept - or
  // from an IP they have not whitelisted - the plan list answers HTTP 200
  // {"status":"INVALID_CREDENTIALS"}. It was read as a catalogue with nothing
  // in it, cached, and every network showed "no data". It is an outage now,
  // flagged for ops, and nothing is cached.
  await ck.dropCatalogue('clubkonnect:data:plans');
  reset();
  route('/APIDatabundlePlansV2.asp', { body: { status: 'INVALID_CREDENTIALS' } });
  err = await throws(ck.listDataPlansCached('MTN'));
  assert.ok(err.misconfigured, 'our key or our IP, not an empty catalogue');
  assert.strictEqual(err.providerMessage, 'INVALID_CREDENTIALS', 'their word reaches the alert');

  route('/APIDatabundlePlansV2.asp', {
    body: { MOBILE_NETWORK: { MTN: [{ ID: '01', PRODUCT: [{ PRODUCT_ID: '500', PRODUCT_NAME: '500 MB - Weekly (SME)', PRODUCT_AMOUNT: '297' }] }] } },
  });
  assert.strictEqual((await ck.listDataPlansCached('MTN')).length, 1, 'the refusal was not cached');

  // A catalogue we cannot sell anything from is refused too, not cached.
  await ck.dropCatalogue('clubkonnect:data:plans');
  route('/APIDatabundlePlansV2.asp', { body: { MOBILE_NETWORK: { MTN: [{ ID: '01', PRODUCT: [] }] } } });
  err = await throws(ck.listDataPlansCached('MTN'));
  assert.strictEqual(err.kind, 'outage');

  // An HTML page or a shape we do not know: an outage, never an empty list.
  route('/APIDatabundlePlansV2.asp', { body: { something: 'else' } });
  err = await throws(ck.listDataPlansCached('MTN'));
  assert.strictEqual(err.kind, 'outage');

  // The bouquets fail the same way.
  await ck.dropCatalogue('clubkonnect:tv:bouquets');
  reset();
  route('/APICableTVPackagesV2.asp', { body: 'INVALID_CREDENTIALS' });
  err = await throws(ck.listTvProvidersCached());
  assert.ok(err.misconfigured);

  // The switch-time check: one authenticated read, refused the same way.
  reset();
  route('/APIWalletBalanceV1.asp', { body: { status: 'INVALID_CREDENTIALS' } });
  err = await throws(ck.verifyCredentials());
  assert.ok(err.misconfigured);
  route('/APIWalletBalanceV1.asp', { body: { balance: '1000' } });
  assert.deepStrictEqual(await ck.verifyCredentials(), { ok: true });
  assert.ok(/whitelisted/.test(ck.CREDENTIAL_HINT));

  /* ============================================================== account */

  reset();
  route('/APIWalletBalanceV1.asp', { body: { date: 'x', phone: '08000000000', email: 'ops@example.com', balance: '45000.5' } });
  const wallet = await ck.getWalletBalance();
  assert.strictEqual(wallet.balance, 45000.5);
  assert.ok(!JSON.stringify(wallet).includes('ops@example.com'), 'only the balance is kept');
  assert.strictEqual(ck.floatVerdict(null), 'unknown', 'unreadable is not empty');

  // Missing credentials: refused before anything is sent.
  delete process.env.CLUBKONNECT_API_KEY;
  reset();
  assert.strictEqual(ck.isConfigured(), false);
  assert.deepStrictEqual(ck.configStatus().missing, ['CLUBKONNECT_API_KEY']);
  err = await throws(ck.buyAirtime({ provider: 'MTN', number: '08031234567', amount: 100, reference: 'air_11' }));
  assert.ok(err.misconfigured);
  assert.strictEqual(calls.length, 0);
  assert.deepStrictEqual(await ck.warmCatalogues(), { loaded: 0, failed: 0, calls: 0, skipped: 'not_configured' });
  process.env.CLUBKONNECT_API_KEY = 'ck_secret';

  console.log('✅ clubkonnect adapter tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
