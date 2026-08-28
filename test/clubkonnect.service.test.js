/**
 * node test/clubkonnect.service.test.js
 *
 * No network. Every check here is a decision that, taken wrongly, costs a
 * customer money without anyone seeing an error:
 *
 *   - a non-terminal code read as a failure refunds a bill that then delivers,
 *     so we pay the provider and the customer keeps the money;
 *   - a non-terminal code read as a success marks an undelivered bill done, and
 *     nobody ever refunds it;
 *   - a wrong DISCO number pays a real bill to the wrong distributor;
 *   - a display name the app's logo resolver mis-matches ships the wrong brand
 *     the moment an admin flips the switch.
 *
 * The last one is the reason this file also asserts the two adapters agree:
 * bills.controller is written to be unable to tell them apart, and that only
 * holds while both modules export the same surface and emit the same spellings.
 *
 * All of it is pure - shape parsing and table lookups - so it runs offline.
 */
const assert = require('assert');

// The module reads credentials at call time, not at load, but isConfigured() is
// asserted below and the registry consults it.
process.env.CLUBKONNECT_USER_ID = process.env.CLUBKONNECT_USER_ID || 'ck_test_user';
process.env.CLUBKONNECT_API_KEY = process.env.CLUBKONNECT_API_KEY || 'ck_test_key';
process.env.PAIRGATE_API_KEY = process.env.PAIRGATE_API_KEY || 'pg_test';

const ck = require('../src/funding/clubkonnect.service');
const pg = require('../src/funding/pairgate.service');
const bills = require('../src/funding/billsProvider');
const { parseDelivery } = require('../src/controllers/clubkonnectWebhook.controller');

/* ------------------------------------------------------ status classification */

// The single most consequential table in the file. Their API answers HTTP 200
// for everything, so this mapping is the only thing standing between a declined
// order and a debited wallet.

// Delivered.
assert.strictEqual(ck.classifyStatus('200'), 'successful');

// ORDER_RECEIVED. This is the *normal* response to a purchase on this rail -
// it is async-first, so most bills start here. Reading it as a failure would
// refund every single successful order on the platform.
assert.strictEqual(ck.classifyStatus('100'), 'processing');

// 201 sits under ORDER_COMPLETED on their side but means the network never
// answered; they retry it every five minutes for an hour before cancelling.
// Terminal in either direction is catastrophic: refund early and we pay for a
// bill that then delivers, settle early and we mark an undelivered one done.
assert.strictEqual(ck.classifyStatus('201'), 'processing');

// 412 is an on-hold float shortage, also retried.
assert.strictEqual(ck.classifyStatus('412'), 'processing');
for (const code of ['199', '300', '399']) {
  assert.strictEqual(ck.classifyStatus(code), 'processing', `${code} must stay non-terminal`);
}

// 600-699 is ORDER_ONHOLD - non-terminal, because the retry window may still
// land it.
for (const code of ['600', '601', '603', '699']) {
  assert.strictEqual(ck.classifyStatus(code), 'processing', `${code} is on hold, not failed`);
}

// The two exceptions: the account was credited back, which is a completed
// reversal and the customer is owed their money now.
assert.strictEqual(ck.classifyStatus('602'), 'failed');
assert.strictEqual(ck.classifyStatus('509'), 'failed');

// 4xx and 5xx are cancelled or rejected. Terminal, refund.
for (const code of ['400', '401', '404', '500', '501']) {
  assert.strictEqual(ck.classifyStatus(code), 'failed', `${code} must be terminal`);
}

// No usable code: fall back to the word, which the callback sometimes carries
// on its own.
assert.strictEqual(ck.classifyStatus('', 'ORDER_COMPLETED'), 'successful');
assert.strictEqual(ck.classifyStatus('', 'ORDER_RECEIVED'), 'processing');
assert.strictEqual(ck.classifyStatus('', 'ORDER_ONHOLD'), 'processing');
assert.strictEqual(ck.classifyStatus('', 'ORDER_CANCELLED'), 'failed');
assert.strictEqual(ck.classifyStatus('', 'INVALID_METERNO'), 'failed');
assert.strictEqual(ck.classifyStatus('', 'MISSING_CREDENTIALS'), 'failed');

// Neither a code nor a word we know. Empty, so callers decide - it must not
// silently become one of the three outcomes.
assert.strictEqual(ck.classifyStatus('', ''), '');
assert.strictEqual(ck.classifyStatus(null, 'SOMETHING_NEW'), '');

// The code wins over the word where they disagree, which is the whole reason
// classification is code-first: ORDER_COMPLETED covers a real delivery and a
// network timeout, the number does not.
assert.strictEqual(ck.classifyStatus('201', 'ORDER_COMPLETED'), 'processing');

/* ------------------------------------------------------------- vend result */

{
  const vend = ck.parseVendResult({
    statuscode: '100',
    status: 'ORDER_RECEIVED',
    orderid: '1234567',
    amountcharged: '1,000.00',
    remark: 'Order received',
  });

  assert.strictEqual(vend.status, 'processing');
  assert.strictEqual(vend.reference, '1234567');
  assert.strictEqual(vend.order_no, '1234567');
  assert.strictEqual(vend.amount, 1000);
  assert.strictEqual(vend.status_code, '100');
  assert.strictEqual(vend.test_mode, false);
}

{
  // Electricity is the one rail where the token can arrive on the purchase call
  // itself rather than only on the callback.
  const vend = ck.parseVendResult({
    statuscode: '200',
    status: 'ORDER_COMPLETED',
    orderid: '999',
    metertoken: '1234-5678-9012-3456-7890',
    units: '54.7',
  });

  assert.strictEqual(vend.status, 'successful');
  assert.strictEqual(vend.token, '1234-5678-9012-3456-7890');
  assert.strictEqual(vend.units, '54.7');
}

// An unrecognised response must NOT default to success. This is the assertion
// that keeps an undelivered bill out of the "done" pile - marked successful, no
// later path ever revisits it and the customer is simply out the money.
assert.strictEqual(ck.parseVendResult({ orderid: '5' }).status, 'processing');
assert.strictEqual(ck.parseVendResult({}).status, 'processing');
assert.strictEqual(ck.parseVendResult(null).status, 'processing');

/* ----------------------------------------------------------- vend acceptance */

// A terminal rejection throws, so the caller refunds rather than stamping a
// vend that never happened.
assert.throws(
  () => ck.assertAccepted({ statuscode: '400', status: 'INVALID_RECIPIENT' }),
  /not accepted/i
);
assert.throws(() => ck.assertAccepted({ status: 'INVALID_DATAPLAN' }), /no longer available/i);
assert.throws(() => ck.assertAccepted({ status: 'MISSING_CREDENTIALS' }), /credentials/i);

// ORDER_RECEIVED is the happy path here and must pass straight through.
assert.doesNotThrow(() => ck.assertAccepted({ statuscode: '100', status: 'ORDER_RECEIVED', orderid: '77' }));
assert.doesNotThrow(() => ck.assertAccepted({ statuscode: '200', orderid: '77' }));

// No state and no order id is not an acceptance either - answering "fine" to a
// response we cannot read is how a wallet gets debited for nothing.
assert.throws(() => ck.assertAccepted({}), /unrecognised|failed/i);

/* --------------------------------------------------------------- float error */

// Our float, not the customer's wallet. Misclassifying this tells a funded
// customer their balance is too low, which is both wrong and unactionable.
assert.ok(ck.isFloatError('INSUFFICIENT_BALANCE'));
assert.ok(ck.isFloatError('INSUFFICIENT_APIBALANCE'));
assert.ok(ck.isFloatError('Insufficient balance'));
assert.ok(ck.isFloatError('low balance'));
assert.ok(!ck.isFloatError('INVALID_METERNO'));
assert.ok(!ck.isFloatError(''));

/* ------------------------------------------------------------------ amounts */

// Their plan list carries prices like Airtel's "484.912717854786". Rounded to
// kobo so a price never renders with twelve decimals or drifts against what is
// actually charged.
assert.strictEqual(ck.toAmount('484.912717854786'), 484.91);
assert.strictEqual(ck.toAmount('1,000.00'), 1000);
assert.strictEqual(ck.toAmount(' 250 '), 250);
assert.strictEqual(ck.toAmount('not a number'), 0);
assert.strictEqual(ck.toAmount(null), 0);
assert.strictEqual(ck.toAmount(undefined), 0);

// Electricity's floor here is ten times the other rail's. bills.controller
// takes the max of ours and the provider's per request, so this number has to
// stay readable from the module rather than being duplicated in the controller.
assert.strictEqual(ck.MIN_AMOUNTS.electricity, 1000);
assert.strictEqual(ck.MIN_AMOUNTS.airtime, 50);
assert.strictEqual(ck.MAX_AMOUNT, 200000);

/* --------------------------------------------------------------- group shape */

// Every list endpoint nests the same way: a root key, then one key per
// provider, then a SINGLE-ELEMENT ARRAY wrapping the object that holds the
// products. The array is the part that catches people out - it looks like a
// list of providers and is not. Reading it wrong yields an empty plan list,
// which the app renders as "this network has no data plans".
{
  const groups = ck.unwrapGroups({
    MTN: [{ ID: '01', PRODUCT: [{ PRODUCT_CODE: '500', PRODUCT_NAME: '500 MB - Monthly (SME)' }] }],
    AIRTEL: { ID: '04', PRODUCT: [{ PRODUCT_CODE: '100', PRODUCT_NAME: '100 MB (GIFTING)' }] },
  });

  assert.strictEqual(groups.length, 2);

  const mtn = groups.find(g => g.key === 'MTN');
  assert.strictEqual(mtn.id, '01');
  assert.strictEqual(mtn.products.length, 1);

  // The un-wrapped object form has to work too - not every endpoint wraps.
  const airtel = groups.find(g => g.key === 'AIRTEL');
  assert.strictEqual(airtel.id, '04');
  assert.strictEqual(airtel.products.length, 1);
}

// Junk in, empty out - never a throw. A malformed catalogue must degrade to an
// empty picker, not a 500 on the bills screen.
assert.deepStrictEqual(ck.unwrapGroups(null), []);
assert.deepStrictEqual(ck.unwrapGroups('nope'), []);
assert.deepStrictEqual(ck.unwrapGroups({ MTN: null }), []);
assert.deepStrictEqual(ck.unwrapGroups({ MTN: [] }), []);

/* -------------------------------------------------------------- plan family */

// The picker's tabs group on this, and the same bundle is priced differently
// across families - losing it merges two different products into one
// indistinguishable list where the customer cannot tell which they are buying.
assert.strictEqual(ck.planFamily('500 MB - Monthly (SME)'), 'SME');
assert.strictEqual(ck.planFamily('1 GB - Weekly (CG)'), 'CG');
assert.strictEqual(ck.planFamily('2 GB (GIFTING)'), 'GIFTING');

// "Awoof Data" and "Direct Data" are a family plus a noun; the noun adds
// nothing to a tab label and would split one family into two.
assert.strictEqual(ck.planFamily('750 MB (Awoof Data)'), 'AWOOF');
assert.strictEqual(ck.planFamily('1 GB (Direct Data)'), 'DIRECT');

assert.strictEqual(ck.planFamily('1 GB - 30 Days'), '');
assert.strictEqual(ck.planFamily(''), '');
assert.strictEqual(ck.planFamily(null), '');

/* ------------------------------------------------------------ network codes */

assert.strictEqual(ck.networkCode('MTN'), '01');
assert.strictEqual(ck.networkCode('mtn'), '01');
assert.strictEqual(ck.networkCode('Glo'), '02');
assert.strictEqual(ck.networkCode('GLOBACOM'), '02');
assert.strictEqual(ck.networkCode('9mobile'), '03');
assert.strictEqual(ck.networkCode('9MOBILE'), '03');
assert.strictEqual(ck.networkCode('Etisalat'), '03');
assert.strictEqual(ck.networkCode('Airtel'), '04');

// A client that read `code` rather than `name` sends the number back.
assert.strictEqual(ck.networkCode('01'), '01');

// Unknown resolves to empty, never to a default. Defaulting would send an MTN
// order to whichever network happened to be first in the table.
assert.strictEqual(ck.networkCode('Vodafone'), '');
assert.strictEqual(ck.networkCode(''), '');

/* --------------------------------------------------------------- disco codes */

// A wrong number here pays a real customer's real bill to the wrong
// distributor, which is not recoverable by us - it has to be chased with two
// utilities. Every legacy spelling the app has ever sent is covered.
const discoCases = {
  EKEDC: '01', eko: '01',
  IKEDC: '02', Ikeja: '02',
  AEDC: '03', Abuja: '03',
  KEDCO: '04', kano: '04',
  PHED: '05', portharcourt: '05',
  JED: '06', jos: '06',
  IBEDC: '07', ibadan: '07',
  KAEDCO: '08', kaduna: '08',
  EEDC: '09', enugu: '09',
  BEDC: '10', benin: '10',
  YEDC: '11', yola: '11',
  ABA: '12', APL: '12',
};

for (const [name, code] of Object.entries(discoCases)) {
  assert.strictEqual(ck.discoCode(name), code, `${name} must map to ${code}`);
}

// Already a code, from a client echoing what the picker gave it.
assert.strictEqual(ck.discoCode('07'), '07');
assert.strictEqual(ck.discoCode('12'), '12');

// Unmapped is a payment addressed to nobody, so it must be empty rather than a
// guess.
assert.strictEqual(ck.discoCode('SOMEDISCO'), '');
assert.strictEqual(ck.discoCode(''), '');

// The reverse map is what the app renders and ships logo assets for. Their own
// names are sentences ("Eko Electric - EKEDC (PHCN)"), and "Kaduna Electric -
// KAEDC" contains "aedc", which would make the logo resolver render Abuja's
// mark on Kaduna's row.
assert.strictEqual(ck.DISCO_DISPLAY['03'], 'AEDC');
assert.strictEqual(ck.DISCO_DISPLAY['08'], 'KAEDCO');

// Every code the forward map produces must have a display name, or the picker
// renders a blank row.
for (const code of new Set(Object.values(ck.DISCO_CODES))) {
  assert.ok(ck.DISCO_DISPLAY[code], `disco code ${code} has no display name`);
}

/* ------------------------------------------------------------------ TV codes */

assert.strictEqual(ck.tvCode('DSTV'), 'dstv');
assert.strictEqual(ck.tvCode('dstv'), 'dstv');
assert.strictEqual(ck.tvCode('GOtv'), 'gotv');
assert.strictEqual(ck.tvCode('Startimes'), 'startimes');
assert.strictEqual(ck.tvCode('StarTime'), 'startimes');
assert.strictEqual(ck.tvCode('Showmax'), 'showmax');
assert.strictEqual(ck.tvCode(''), '');

/* --------------------------------------------------------------- meter types */

// The app and the ledger speak "prepaid"/"postpaid"; this API wants 01/02. The
// string stays canonical so nothing downstream learns a magic number.
assert.strictEqual(ck.normalizeMeterType('prepaid'), 'prepaid');
assert.strictEqual(ck.normalizeMeterType('POSTPAID'), 'postpaid');
assert.strictEqual(ck.normalizeMeterType('post-paid'), 'postpaid');
assert.strictEqual(ck.normalizeMeterType('02'), 'postpaid');
assert.strictEqual(ck.normalizeMeterType(''), 'prepaid');
assert.strictEqual(ck.meterTypeCode('prepaid'), '01');
assert.strictEqual(ck.meterTypeCode('postpaid'), '02');
assert.strictEqual(ck.meterTypeCode(undefined), '01');

/* ----------------------------------------------------------- customer lookup */

// A biller that cannot place the number says so with the error token IN THE
// NAME FIELD rather than as an error. Letting it through shows a confirmation
// sheet reading "meter owned by INVALID_METERNO" and takes the money anyway.
assert.deepStrictEqual(ck.parseCustomer({ customer_name: 'ADEOLA JOHNSON' }), {
  customer_name: 'ADEOLA JOHNSON',
  address: '',
});
assert.strictEqual(ck.parseCustomer({ customer_name: 'INVALID_METERNO' }).customer_name, '');
assert.strictEqual(ck.parseCustomer({ customer_name: 'INVALID_SMARTCARDNO' }).customer_name, '');
assert.strictEqual(ck.parseCustomer({}).customer_name, '');
assert.strictEqual(ck.parseCustomer(null).customer_name, '');

/* ------------------------------------------------------------ error wording */

// The customer reads these. A raw INVALID_SMARTCARDNO on a confirmation sheet
// is not an error message.
assert.strictEqual(ck.messageFor('INVALID_METERNO'), 'Could not verify that meter number');
assert.strictEqual(ck.messageFor('INSUFFICIENT_BALANCE'), 'Insufficient balance');
assert.strictEqual(ck.messageFor(''), 'ClubKonnect request failed');
assert.strictEqual(ck.messageFor('', 'custom fallback'), 'custom fallback');

// An unmapped token still has to produce something rather than an empty alert.
assert.strictEqual(ck.messageFor('SOMETHING_ELSE'), 'SOMETHING_ELSE');

/* --------------------------------------------------------------- no signature */

// This provider has no signature scheme at all, and the webhook controller is
// built around that fact - `configured: false` is what tells it there is no
// signature branch to fall out of, so every delivery is re-read over the
// authenticated API before a naira moves. If this ever starts returning
// `verified: true` without a real HMAC, an anonymous POST can flip a bill to
// failed and collect the refund.
{
  const check = ck.verifyWebhookSignature({ rawBody: '{}', signature: 'anything' });
  assert.strictEqual(check.verified, false);
  assert.strictEqual(check.configured, false);
  assert.strictEqual(check.reason, 'no_signature_scheme');
}

/* ------------------------------------------------------------ float verdict */

assert.strictEqual(ck.floatVerdict(100000), 'healthy');
assert.strictEqual(ck.floatVerdict(20000), 'low');
assert.strictEqual(ck.floatVerdict(1000), 'critical');

// A genuine zero float IS critical - vending is about to fail.
assert.strictEqual(ck.floatVerdict(0), 'critical');

// But an absent one is not a zero one. `Number(null)` and `Number('')` are both
// 0, so without an explicit guard a float we simply could not read renders as
// the loudest verdict on the screen, off a missing field. Both rails guard it,
// and both must keep guarding it - a `critical` that really means `unknown`
// trains people to ignore critical.
for (const absent of [null, undefined, '']) {
  assert.strictEqual(ck.floatVerdict(absent), 'unknown', `${JSON.stringify(absent)} must read as unknown`);
  assert.strictEqual(pg.floatVerdict(absent), 'unknown', `${JSON.stringify(absent)} must read as unknown`);
}

assert.strictEqual(ck.floatVerdict('nonsense'), 'unknown');

/* ------------------------------------------------------- callback parsing */

// Their documentation shows a JSON body, but the callback has also been seen
// form-encoded and as a bare query string on a GET. Reading all three costs
// nothing; guessing wrong strands an electricity token, and the token is the
// only thing the customer can actually type into their meter.
{
  const d = parseDelivery({
    body: { orderid: '123', statuscode: '200', orderstatus: 'ORDER_COMPLETED', metertoken: 'TOK-1', units: '20.5' },
    query: {},
  });

  assert.strictEqual(d.reference, '123');
  assert.strictEqual(d.statusCode, '200');
  assert.strictEqual(d.token, 'TOK-1');
  assert.strictEqual(d.units, '20.5');
}

{
  // GET, bare query string, mixed casing.
  const d = parseDelivery({ query: { OrderID: '456', StatusCode: '200', MeterToken: 'TOK-2' }, body: {} });

  assert.strictEqual(d.reference, '456');
  assert.strictEqual(d.statusCode, '200');
  assert.strictEqual(d.token, 'TOK-2');
}

{
  // Only our own RequestID came back. The reconciler can still resolve this,
  // because their query endpoint accepts it - which is what the
  // SUPPORTS_REQUEST_ID_LOOKUP flag exists to announce.
  const d = parseDelivery({ query: {}, body: { requestid: 'VP-TRX-9', statuscode: '200' } });

  assert.strictEqual(d.reference, '');
  assert.strictEqual(d.requestId, 'VP-TRX-9');
}

// The body wins where both carry a field - a POST body is the documented form.
assert.strictEqual(parseDelivery({ query: { orderid: 'q' }, body: { orderid: 'b' } }).reference, 'b');

// Nothing usable must not throw; the controller answers "ignored".
assert.strictEqual(parseDelivery({}).reference, '');
assert.strictEqual(parseDelivery(null).reference, '');

/* -------------------------------------------------- adapter contract parity */

// bills.controller is written so it cannot tell the two providers apart. That
// only holds while both modules export the same surface - a name present on one
// and missing on the other is a TypeError on a live purchase the moment an
// admin flips the switch, which is the worst possible time to find out.
{
  const required = [
    'getWalletBalance', 'getFundingAccount', 'floatThresholds', 'floatVerdict', 'getTransactionStatus',
    'listAirtimeProvidersCached', 'buyAirtime',
    'listDataProvidersCached', 'listDataPlansCached', 'buyData',
    'listTvProvidersCached', 'listTvPackagesCached', 'validateTvSmartcard', 'payTv',
    'listElectricityDiscosCached', 'validateElectricityMeter', 'payElectricity',
    'normalizeMeterType', 'meterTypeCode',
    'parseVendResult', 'verifyWebhookSignature', 'isFloatError',
    'dropCatalogue', 'warmCatalogues', 'isConfigured',
  ];

  for (const name of required) {
    assert.strictEqual(typeof ck[name], 'function', `clubkonnect is missing ${name}()`);
    assert.strictEqual(typeof pg[name], 'function', `pairgate is missing ${name}()`);
  }

  // Read by billReconcile before it tries a requery by our own reference. A
  // missing flag is falsy, so the reconciler would simply give up - but an
  // accidental `true` on PairGate would send it a reference it has never heard
  // of on every sweep.
  assert.strictEqual(ck.SUPPORTS_REQUEST_ID_LOOKUP, true);
  assert.strictEqual(pg.SUPPORTS_REQUEST_ID_LOOKUP, false);

  // Both must expose a floor table for minAmountFor() to take the max of.
  assert.strictEqual(typeof ck.MIN_AMOUNTS, 'object');
  assert.strictEqual(typeof pg.MIN_AMOUNTS, 'object');
}

// The app ships logo assets keyed on these exact spellings. A switch that
// changes the string changes the icon, so the two rails have to agree.
for (const [code, name] of Object.entries(ck.NETWORK_DISPLAY)) {
  assert.ok(/^(MTN|GLO|9MOBILE|AIRTEL)$/.test(name), `network display ${code} -> ${name} is off-contract`);
}

/* ------------------------------------------------------------ the registry */

// Four rails and two providers, both closed sets. This is what makes the admin
// switch unable to express an invalid state rather than merely discouraged from
// one.
assert.deepStrictEqual(Object.keys(bills.SERVICES).sort(), ['airtime', 'data', 'electricity', 'tv']);
assert.deepStrictEqual(Object.keys(bills.ADAPTERS).sort(), ['clubkonnect', 'pairgate']);

// Betting is Payvessel's alone. It is not a rail here and Payvessel is not an
// adapter here, so no admin action, no sweep and no reconcile can reach it.
// These four assertions are the guarantee, and they fail loudly if anybody ever
// adds either name to a map above.
assert.strictEqual(bills.isKnownService('betting'), false);
assert.strictEqual(bills.isKnownProvider('payvessel'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(bills.SERVICES, 'betting'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(bills.ADAPTERS, 'payvessel'), false);

// setProvider refuses all three ways of asking for something impossible, with a
// code the controller maps to a 400 rather than a 500.
const rejects = async (service, provider, code) => {
  await assert.rejects(() => bills.setProvider(service, provider), e => e.code === code, `${service}/${provider}`);
};

// An unconfigured provider is refused at the moment of choosing rather than
// discovered one refunded purchase at a time.
const savedUserId = process.env.CLUBKONNECT_USER_ID;

(async () => {
  await rejects('betting', 'pairgate', 'UNKNOWN_SERVICE');
  await rejects('data', 'payvessel', 'UNKNOWN_PROVIDER');
  await rejects('data', '', 'UNKNOWN_PROVIDER');

  delete process.env.CLUBKONNECT_USER_ID;
  assert.strictEqual(bills.isProviderConfigured('clubkonnect'), false);
  await rejects('data', 'clubkonnect', 'PROVIDER_NOT_CONFIGURED');
  process.env.CLUBKONNECT_USER_ID = savedUserId;

  // adapterFor never returns undefined - a lookup for something unknown lands
  // on the default rather than crashing a vend with "cannot read property of
  // undefined".
  assert.strictEqual(bills.adapterFor('clubkonnect'), ck);
  assert.strictEqual(bills.adapterFor('pairgate'), pg);
  assert.strictEqual(bills.adapterFor('payvessel'), pg);
  assert.strictEqual(bills.adapterFor(''), pg);
  assert.strictEqual(bills.adapterFor(null), pg);
  assert.strictEqual(bills.DEFAULT_PROVIDER, 'pairgate');

  // One app_settings row per rail, and the key has to stay stable - renaming it
  // silently resets every rail to the default on the next deploy.
  assert.strictEqual(bills.__test.settingKey('data'), 'bills_provider_data');
  assert.strictEqual(bills.__test.settingKey('electricity'), 'bills_provider_electricity');

  assert.strictEqual(bills.__test.normalizeProvider('  ClubKonnect '), 'clubkonnect');
  assert.strictEqual(bills.__test.normalizeProvider('payvessel'), '');
  assert.strictEqual(bills.__test.normalizeProvider(null), '');

  /* ---------------------------------------------------------------- */
  /* Connection failures name themselves                               */
  /* ---------------------------------------------------------------- */

  // Production logged `ClubKonnect request failed: fetch failed` and that was
  // the entire diagnostic. `fetch` reports DNS failure, connection refused, a
  // mid-flight reset and a rejected certificate with that one message, putting
  // the reason in `cause` - so the line named none of them and the outage had
  // to be diagnosed from scratch. These assert the code survives to the log.
  const { causeCode } = require('../src/helpers/retry.helper');

  assert.strictEqual(causeCode(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })), 'ECONNRESET');
  assert.strictEqual(causeCode({ cause: { cause: { code: 'ENOTFOUND' } } }), 'ENOTFOUND', 'walks more than one level');
  assert.strictEqual(causeCode(new Error('plain')), '', 'an error we threw ourselves has no code to report');
  assert.strictEqual(causeCode(null), '');

  const realFetch = global.fetch;
  const previousRetries = process.env.PROVIDER_MAX_RETRIES;

  process.env.PROVIDER_MAX_RETRIES = '0'; // no backoff sleep in a unit test

  for (const [service, adapter] of [['ClubKonnect', ck], ['PairGate', pg]]) {
    global.fetch = async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    };

    const failure = await adapter.getWalletBalance().then(
      () => null,
      e => e
    );

    assert.ok(failure, `${service} surfaces a connection failure rather than resolving`);
    assert.match(failure.message, /ECONNRESET/, `${service} names the socket code, not just "fetch failed"`);
    assert.strictEqual(failure.statusCode, 504, `${service} keeps the retryable status`);
    // The chain has to stay intact: retry.helper walks `cause` and would
    // otherwise be matching on the words "fetch failed" in our own string.
    assert.strictEqual(failure.cause?.cause?.code, 'ECONNRESET', `${service} preserves the original error`);
  }

  global.fetch = realFetch;

  if (previousRetries === undefined) delete process.env.PROVIDER_MAX_RETRIES;
  else process.env.PROVIDER_MAX_RETRIES = previousRetries;

  console.log('clubkonnect.service tests passed');
})().catch(e => {
  console.error(e);
  process.exit(1);
});
