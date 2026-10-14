/**
 * node test/mysubwallet.service.test.js
 *
 * The MySubWallet adapter, with `fetch` stubbed - no network, no Redis, no
 * database. The catalogue fixtures below are excerpts of the live API's own
 * answers (read 2026-10-06), quirks included: "COOPERATE GIFTING", "Joss
 * Electricity", "STARTIME", prices inside plan names, and one plan whose
 * validity is misspelt.
 *
 * What it pins, roughly in order of what a mistake would cost:
 *
 *   - a vend whose answer we could not read is asked about before anyone
 *     refunds it, and is never sent twice;
 *   - "our float is empty" and "our key is wrong" never reach a customer as a
 *     reason they could fix, and always reach whoever can;
 *   - a sandbox answer can never mark a production purchase delivered;
 *   - every purchase is addressed with their ids, in the shapes their API
 *     takes, and every catalogue comes back in the shapes the app reads.
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);
process.env.MYSUBWALLET_API_KEY = 'msw_live_key';
process.env.MYSUBWALLET_RECOVERY_DELAY_MS = '0';
process.env.MYSUBWALLET_CATALOGUE_GAP_MS = '0';
// One retry, fast, so "reads retry and vends do not" is observable.
process.env.PROVIDER_MAX_RETRIES = '1';
process.env.PROVIDER_RETRY_BASE_MS = '1';
process.env.PROVIDER_RETRY_MAX_MS = '5';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.NODE_ENV = 'test';

/* ----------------------------------------------------------- the fake API */

let calls = [];
const routes = new Map();

function route(method, path, reply) {
  routes.set(`${method} ${path}`, typeof reply === 'function' ? reply : () => reply);
}

function networkError() {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  });
}

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const call = {
    method: String(opts.method || 'GET').toUpperCase(),
    path: u.pathname,
    query: Object.fromEntries(u.searchParams),
    headers: opts.headers || {},
    body: opts.body ? JSON.parse(opts.body) : null,
  };
  calls.push(call);

  const handler = routes.get(`${call.method} ${call.path}`);
  if (!handler) throw new Error(`unrouted ${call.method} ${call.path}`);
  const out = await handler(call);
  const text = typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
  const headers = out.headers || {};
  return {
    status: out.status || 200,
    headers: { get: k => headers[String(k).toLowerCase()] ?? null },
    text: async () => text,
  };
};

const ok = body => ({ status: 200, body });
const callsTo = (method, path) => calls.filter(c => c.method === method && c.path === path);

/* --------------------------------------------------------------- fixtures */

const DATA_PLANS = {
  status: 'success',
  plan: [
    { network: 'MTN', network_type: 'GIFTING', name: '1.2GB GIFTING = ₦720.00 7 Days(XtraSpecial)', plan_id: '47', amount: '720' },
    { network: 'MTN', network_type: 'SME', name: '1.0GB SME = ₦400.00 7 Days', plan_id: '31', amount: '400.00' },
    { network: 'MTN', network_type: 'COOPERATE GIFTING', name: '1.0GB COOPERATE GIFTING = ₦600.00 30 days', plan_id: '188', amount: '600' },
    { network: 'GLO', network_type: 'GIFTING', name: '750MB GIFTING = ₦194.00 1 Day Special', plan_id: '19', amount: '194' },
    { network: 'GLO', network_type: 'SME', name: '5GB SME = ₦1,480.00 incl. 3GB Night Data 30 Days', plan_id: '109', amount: '1480' },
    { network: 'GLO', network_type: 'GIFTING', name: '16.5GB GIFTING = ₦4,850.00 30 daysb(14GB + 2.5GB Night)', plan_id: '213', amount: '4850' },
    { network: 'AIRTEL', network_type: 'SME', name: '0.5GB SME = ₦339.50 1 Day', plan_id: '95', amount: '339.5' },
    { network: '9MOBILE', network_type: 'COOPERATE GIFTING', name: '1GB COOPERATE GIFTING = ₦500.00 30 Days', plan_id: '121', amount: '500' },
    // Rows that must never go on sale.
    { network: 'MTN', network_type: 'SME', name: 'broken id', plan_id: 'abc', amount: '100' },
    { network: 'MTN', network_type: 'SME', name: 'free bundle', plan_id: '900', amount: '0' },
    { network: 'SMILE', network_type: 'SME', name: '1GB SME = ₦300.00 30 Days', plan_id: '901', amount: '300' },
  ],
};

const DISCOS = {
  status: 'success',
  bill: [
    ['1', 'Ikeja Electricity'], ['2', 'Eko Electricity'], ['3', 'Kano Electricity'],
    ['4', 'Port Harcourt Electricity'], ['5', 'Joss Electricity'], ['6', 'Ibadan Electricity'],
    ['7', 'Kaduna Electric'], ['8', 'Abuja Electricity'], ['9', 'Benin Electricity'],
    ['10', 'Enugu Electricity'], ['11', 'Aba Electricity'], ['12', 'Yola Electricity'],
  ].map(([plan_id, disco_name]) => ({ plan_id, disco_name, logo: 'https://api.mysubwallet.ng/storage/logos/x.jpeg' })),
};

const CABLE_PROVIDERS = {
  status: 'success',
  provider: [
    { id: 1, plan_id: '1', cable_name: 'GOTV' },
    { id: 2, plan_id: '2', cable_name: 'DSTV' },
    { id: 3, plan_id: '3', cable_name: 'STARTIME' },
  ],
};

const CABLE_PLANS = {
  status: 'success',
  plan: [
    { cable_name: 'DSTV', plan_name: 'DStv Yanga', plan_price: '6000.00', plan_id: '43' },
    { cable_name: 'DSTV', plan_name: 'DStv Padi', plan_price: '4400.00', plan_id: '42' },
    { cable_name: 'GOTV', plan_name: 'GOtv Smallie - monthly', plan_price: '1900.00', plan_id: '95' },
    { cable_name: 'STARTIME', plan_name: 'Nova (Dish) - 2100 Naira - 1 Month', plan_price: '2100.00', plan_id: '106' },
    { cable_name: 'STARTIME', plan_name: 'Basic (Antenna) - 4,000 Naira - 1 Month', plan_price: '4000.00', plan_id: '107' },
  ],
};

route('GET', '/api/data-plan', ok(DATA_PLANS));
route('GET', '/api/discos', ok(DISCOS));
route('GET', '/api/cable-plans', ok(CABLE_PLANS));

// The cable-provider list fails once, then answers - a read that must retry.
let cableProviderAttempts = 0;
route('GET', '/api/cable-providers', () => {
  cableProviderAttempts += 1;
  return cableProviderAttempts === 1 ? { status: 500, body: { status: 'fail', message: 'Server Error' } } : ok(CABLE_PROVIDERS);
});

const msw = require('../src/funding/mysubwallet.service');
const t = msw.__test;
const { buildPlanTabs } = require('../src/controllers/bills.controller');

(async () => {
  /* ------------------------------------------------------- data catalogue */

  const mtn = await msw.listDataPlansCached('MTN');
  assert.deepStrictEqual(mtn.map(p => p.id), ['31', '188', '47'], 'cheapest first; broken and free rows dropped');
  assert.deepStrictEqual(mtn.map(p => p.name), ['1.0GB (SME)', '1.0GB (CG)', '1.2GB (XtraSpecial) (GIFTING)']);
  assert.deepStrictEqual(mtn.map(p => p.plan_type), ['SME', 'CG', 'GIFTING'], '"COOPERATE GIFTING" is the CG family');
  assert.deepStrictEqual(mtn.map(p => p.validity), ['7 days', '30 days', '7 days']);
  assert.deepStrictEqual(mtn.map(p => p.duration_days), [7, 30, 7]);
  assert.strictEqual(mtn[0].amount, 400);

  // No price in a name: the tile prints ours beside it, and theirs is a second
  // number that can disagree with what is charged.
  for (const plan of mtn) assert.ok(!/₦|=/.test(plan.name), `no price left in "${plan.name}"`);

  const glo = await msw.listDataPlansCached('Globacom');
  assert.deepStrictEqual(glo.map(p => p.name), [
    '750MB Special (GIFTING)',
    '5GB incl. 3GB Night Data (SME)',
    '16.5GB 30 daysb(14GB + 2.5GB Night) (GIFTING)',
  ]);
  // Their typo keeps its words and earns no validity - never a guessed one.
  assert.strictEqual(glo[2].validity, '');
  assert.strictEqual(glo[2].duration_days, 0);

  assert.strictEqual((await msw.listDataPlansCached('AIRTEL'))[0].amount, 339.5);
  assert.deepStrictEqual((await msw.listDataPlansCached('9 mobile')).map(p => p.id), ['121']);
  assert.deepStrictEqual((await msw.listDataPlansCached('T2')).map(p => p.id), ['121'], '9mobile\'s new name');
  await assert.rejects(() => msw.listDataPlansCached('SMILE'), e => e.statusCode === 400);
  assert.strictEqual(callsTo('GET', '/api/data-plan').length, 1, 'every network is one cached call');

  // End to end into the picker: real names have to produce validity tabs, or
  // the screen falls back to the family split the redesign replaced.
  const tabs = buildPlanTabs(mtn.map(p => ({ ...p, amount: p.amount.toFixed(2) })));
  assert.strictEqual(tabs.axis, 'validity');
  assert.deepStrictEqual(tabs.tab_order, ['hot', 'weekly', 'monthly', 'all']);

  /* --------------------------------------------------------- electricity */

  const discos = await msw.listElectricityDiscosCached();
  assert.deepStrictEqual(
    discos.map(d => d.name),
    ['IKEDC', 'EKEDC', 'KEDCO', 'PHED', 'JED', 'IBEDC', 'KAEDCO', 'AEDC', 'BEDC', 'EEDC', 'ABA', 'YEDC'],
    'every DISCO renders as the short code the app has a logo for'
  );
  assert.strictEqual(discos.find(d => d.name === 'JED').full_name, 'Joss Electricity');

  assert.strictEqual(await t.discoId('IKEDC'), '1');
  assert.strictEqual(await t.discoId('Ikeja'), '1');
  assert.strictEqual(await t.discoId('KAEDC'), '7', 'a legacy spelling still reaches Kaduna, not Abuja');
  assert.strictEqual(await t.discoId('AEDC'), '8');
  assert.strictEqual(await t.discoId('jos'), '5');
  assert.strictEqual(await t.discoId('Port Harcourt Electricity'), '4');
  assert.strictEqual(await t.discoId('12'), '12', 'an id from a client that reads `code`');
  assert.strictEqual(await t.discoId('99'), '', 'an id the catalogue does not carry is nobody');
  assert.strictEqual(await t.discoId('Atlantis'), '');

  /* ------------------------------------------------------------------ tv */

  const tv = await msw.listTvProvidersCached();
  assert.deepStrictEqual(tv.map(p => [p.name, p.code, p.id]), [
    ['GOTV', 'gotv', '1'],
    ['DSTV', 'dstv', '2'],
    ['STARTIMES', 'startimes', '3'],
  ]);
  assert.strictEqual(cableProviderAttempts, 2, 'a catalogue read retries a 500');

  const startimes = await msw.listTvPackagesCached('STARTIMES');
  assert.deepStrictEqual(startimes.map(p => p.name), ['Nova (Dish) - 1 Month', 'Basic (Antenna) - 1 Month']);
  assert.deepStrictEqual(startimes.map(p => [p.id, p.code, p.amount]), [['106', '106', 2100], ['107', '107', 4000]]);
  assert.deepStrictEqual((await msw.listTvPackagesCached('dstv')).map(p => p.id), ['42', '43'], 'cheapest first');
  await assert.rejects(() => msw.listTvPackagesCached('SHOWMAX'), e => e.statusCode === 400);

  /* ------------------------------------------------------------- lookups */

  calls = [];
  route('GET', '/api/bill/bill-validation', ok({ status: 'success', customer_name: 'JOHN DOE', customer_address: '12 Example Street', meter_number: '45012345678' }));
  const meter = await msw.validateElectricityMeter({ provider: 'EKEDC', number: '45012345678', meterType: 'postpaid' });
  assert.deepStrictEqual(meter, { customer_name: 'JOHN DOE', address: '12 Example Street' });
  assert.deepStrictEqual(calls[0].query, { disco: '2', meter_number: '45012345678', meter_type: 'postpaid' });

  route('GET', '/api/bill/bill-validation', ok({ status: 'fail', message: 'Meter number not found' }));
  await assert.rejects(
    () => msw.validateElectricityMeter({ provider: 'EKEDC', number: '1', meterType: 'prepaid' }),
    e => e.statusCode === 400 && e.message === 'We could not verify that meter number. Check it and try again.'
  );

  route('GET', '/api/cable/cable-validation', ok({ status: 'success', name: 'JANE DOE' }));
  calls = [];
  assert.deepStrictEqual(await msw.validateTvSmartcard({ provider: 'DSTV', number: '1234567890' }), {
    customer_name: 'JANE DOE',
    address: '',
  });
  assert.deepStrictEqual(calls[0].query, { cable: '2', iuc: '1234567890' });

  // A lookup refused for a reason we cannot map still says what it was doing.
  route('GET', '/api/cable/cable-validation', ok({ status: 'fail', message: 'Oops' }));
  await assert.rejects(
    () => msw.validateTvSmartcard({ provider: 'GOTV', number: '1' }),
    e => e.message === 'We could not verify that smartcard / IUC number. Check it and try again.'
  );

  // Their validator rejecting one of OUR ids - read from their own catalogue -
  // is our misconfiguration: an outage to the customer, an alert to us. Never
  // "check your meter number".
  route('GET', '/api/bill/bill-validation', { status: 400, body: { status: false, message: 'The selected disco is invalid.' } });
  await assert.rejects(
    () => msw.validateElectricityMeter({ provider: 'IKEDC', number: '45012345678', meterType: 'prepaid' }),
    e => e.misconfigured === true && e.statusCode === 503 && e.message === t.UNAVAILABLE
  );

  // "Invalid number" reads like a phone problem to the transport. The meter
  // lookup knows better.
  route('GET', '/api/bill/bill-validation', ok({ status: 'fail', message: 'Invalid number' }));
  await assert.rejects(
    () => msw.validateElectricityMeter({ provider: 'IKEDC', number: '1', meterType: 'prepaid' }),
    e => e.message === 'We could not verify that meter number. Check it and try again.'
  );

  /* ------------------------------------------------- what a vend sends */

  calls = [];
  route('POST', '/api/topup', ok({ network: 'MTN', amount: '100', status: 'success', message: 'Airtime delivered to 2348031234567.', newbal: 110225, system: 'API' }));
  const airtime = await msw.buyAirtime({ provider: 'MTN', number: '08031234567', amount: 100, reference: 'air_1' });
  assert.deepStrictEqual(calls[0].body, {
    network: 1,
    // Local 11-digit form: the live validator refuses 234... ("The phone must
    // be 11 digits."), whatever their docs show.
    phone: '08031234567',
    plan_type: 'VTU',
    amount: 100,
    bypass: false,
    'request-id': 'air_1',
  });
  assert.strictEqual(calls[0].headers.Authorization, 'Token msw_live_key');
  // Their airtime answer does not echo the request-id; every later lookup joins
  // on it, so the module stamps it.
  assert.strictEqual(airtime['request-id'], 'air_1');
  const parsed = msw.parseVendResult(airtime);
  assert.strictEqual(parsed.reference, 'air_1');
  assert.strictEqual(parsed.status, 'successful');
  assert.strictEqual(parsed.amount, 100);

  // A fraction is refused before it costs a refund, and before any call.
  calls = [];
  await assert.rejects(() => msw.buyAirtime({ provider: 'MTN', number: '08031234567', amount: 150.5, reference: 'air_x' }), e => e.statusCode === 400);
  await assert.rejects(() => msw.buyAirtime({ provider: 'SMILE', number: '08031234567', amount: 100, reference: 'air_y' }), e => e.statusCode === 400);
  await assert.rejects(() => msw.buyAirtime({ provider: 'MTN', number: '123', amount: 100, reference: 'air_z' }), e => e.statusCode === 400);
  assert.strictEqual(calls.length, 0, 'nothing invalid reaches the provider');

  calls = [];
  route('POST', '/api/data', ok({ status: 'success', network: 'GLO', dataplan: '750MB', 'request-id': 'data_1' }));
  await msw.buyData({ provider: 'GLO', planId: '19', number: '08051234567', reference: 'data_1' });
  assert.deepStrictEqual(calls[0].body, { network: 3, phone: '08051234567', data_plan: 19, bypass: false, 'request-id': 'data_1' });

  calls = [];
  route('POST', '/api/cable', ok({ status: 'success', message: 'DStv Padi renewed on 1234567890.' }));
  await msw.payTv({ provider: 'DSTV', number: '1234567890', code: '42', reference: 'tv_1', customerName: 'JANE DOE' });
  assert.deepStrictEqual(calls[0].body, { cable: 2, cable_plan: 42, iuc: '1234567890', bypass: 1, 'request-id': 'tv_1' });

  calls = [];
  route('POST', '/api/bill', ok({ status: 'success', message: 'Recharge successful.', token: '1234-5678-9012-3456-7890', newbal: 1 }));
  const power = msw.parseVendResult(
    await msw.payElectricity({ provider: 'IKEDC', number: '45012345678', meterType: 'prepaid', amount: 1000, reference: 'ele_1' })
  );
  assert.deepStrictEqual(calls[0].body, { disco: 1, meter_type: 'prepaid', meter_number: '45012345678', amount: 1000, 'request-id': 'ele_1' });
  assert.strictEqual(power.token, '1234-5678-9012-3456-7890', 'the token comes back on the purchase call');

  route('POST', '/api/bill', ok({ status: 'pending', message: 'Processing' }));
  const pendingPower = msw.parseVendResult(
    await msw.payElectricity({ provider: 'IKEDC', number: '45012345678', meterType: 'prepaid', amount: 1000, reference: 'ele_2' })
  );
  assert.strictEqual(pendingPower.status, 'processing', 'pending is accepted, not delivered');
  assert.strictEqual(pendingPower.token, '', 'and its token arrives later');

  /* -------------------------------------------- refusals, in our words */

  const refusal = async (body, status = 200) => {
    route('POST', '/api/topup', { status, body });
    calls = [];
    try {
      await msw.buyAirtime({ provider: 'MTN', number: '08031234567', amount: 100, reference: 'air_r' });
    } catch (e) {
      return e;
    }
    throw new Error('expected a refusal');
  };

  let e = await refusal({ status: 'fail', message: 'Insufficient wallet balance.' });
  assert.strictEqual(e.floatExhausted, true, 'our float, flagged for the alert');
  assert.strictEqual(e.statusCode, 503);
  assert.strictEqual(e.message, t.UNAVAILABLE, 'never "insufficient balance" to a customer with money');
  assert.strictEqual(e.providerMessage, 'Insufficient wallet balance.', 'their words kept for the operator');
  assert.strictEqual(callsTo('GET', '/api/requery/air_r').length, 0, 'a clear refusal is not requeried');

  // Both bad-key answers, verbatim from the live API: no header, and a wrong key.
  e = await refusal({ status: 'fail', message: 'Unauthorized/Token Not Found' }, 403);
  assert.strictEqual(e.misconfigured, true);
  assert.strictEqual(e.message, t.UNAVAILABLE);
  e = await refusal({ message: 'Invalid API KEY or user account not active', status: 'fail' }, 403);
  assert.strictEqual(e.misconfigured, true);
  assert.strictEqual(e.message, t.UNAVAILABLE);
  e = await refusal({ status: 'fail' }, 403);
  assert.strictEqual(e.misconfigured, true, 'a 403 that says nothing is still read as our key');

  // **A 403 is not a bad key.** They answer every refusal 403, a validation
  // error included - this is the live answer to a 234... number, and reading it
  // as "misconfigured" told a customer "briefly unavailable" and paged us.
  e = await refusal({ status: 'fail', message: 'The phone must be 11 digits.' }, 403);
  assert.strictEqual(!!e.misconfigured, false, 'the customer\'s input, not our configuration');
  assert.strictEqual(!!e.ambiguous, false);
  assert.strictEqual(e.statusCode, 400);
  assert.strictEqual(e.message, 'That phone number was not accepted for this network. Check the number and the network.');
  assert.strictEqual(callsTo('GET', '/api/requery/air_r').length, 0, 'a clear refusal is not requeried');

  // Laravel's validation body has no `status` at all. A 4xx is still a refusal,
  // not an unknown outcome to requery.
  e = await refusal({ message: 'The given data was invalid.', errors: { phone: ['The phone must be 11 digits.'] } }, 422);
  assert.strictEqual(!!e.ambiguous, false);
  assert.strictEqual(e.message, 'That phone number was not accepted for this network. Check the number and the network.');

  e = await refusal({ status: 'fail', message: 'The amount must be at least 100.' });
  assert.strictEqual(e.message, 'The amount must be at least 100.', 'a limit the customer can act on is passed through');

  e = await refusal({ status: 'fail', message: 'MTN VTU is currently disabled' });
  assert.strictEqual(e.message, 'This service is temporarily unavailable. Please try again later.');

  e = await refusal({ status: 'fail', message: 'Something odd happened' });
  assert.strictEqual(e.message, 'Airtime purchase failed. Please try again.', 'an unmapped refusal gets the call site\'s words');

  route('POST', '/api/data', ok({ status: 'fail', message: 'The selected data plan is invalid.' }));
  await assert.rejects(
    () => msw.buyData({ provider: 'MTN', planId: '31', number: '08031234567', reference: 'data_r' }),
    err => err.message === 'That plan is no longer available. Please pick another one.' && !err.misconfigured,
    'a vanished plan is the customer\'s to re-pick, not our misconfiguration'
  );

  // A DISCO that calls the meter a "customer ID" must not be answered with
  // wording about some other product - an unmapped refusal gets the call
  // site's own words.
  route('POST', '/api/bill', ok({ status: 'fail', message: 'Invalid customer ID' }));
  await assert.rejects(
    () => msw.payElectricity({ provider: 'IKEDC', number: '45012345678', meterType: 'prepaid', amount: 1000, reference: 'ele_r' }),
    err => err.message === 'Electricity purchase failed. Please try again.'
  );

  /* ---------------------------------------- an answer nobody could read */

  // The purchase reached them and the answer did not reach us. Found
  // delivered on requery: reported as delivered, never refunded.
  calls = [];
  route('POST', '/api/topup', () => { throw networkError(); });
  route('GET', '/api/requery/air_2', ok({ status: 'success', data: { 'request-id': 'air_2', transaction_status: 'success', amount: 100, message: 'Airtime delivered' } }));
  const recovered = await msw.buyAirtime({ provider: 'MTN', number: '08031234567', amount: 100, reference: 'air_2' });
  assert.strictEqual(recovered.status, 'success');
  assert.strictEqual(recovered.recovered, true);
  assert.strictEqual(msw.parseVendResult(recovered).reference, 'air_2');
  assert.strictEqual(callsTo('POST', '/api/topup').length, 1, 'a vend is never sent twice');
  assert.strictEqual(callsTo('GET', '/api/requery/air_2').length, 1);

  // A 5xx: still pending on their side, so it stays processing here.
  calls = [];
  route('POST', '/api/topup', { status: 502, body: '<html>Bad Gateway</html>' });
  route('GET', '/api/requery/air_3', ok({ status: 'success', data: { transaction_status: 'pending' } }));
  const pendingVend = await msw.buyAirtime({ provider: 'MTN', number: '08031234567', amount: 100, reference: 'air_3' });
  assert.strictEqual(msw.parseVendResult(pendingVend).status, 'processing');
  assert.strictEqual(callsTo('POST', '/api/topup').length, 1, 'not even a 5xx retries a purchase');

  // Their own 404 for an unknown route answers 200 with an HTML page. That is
  // not a success, and not proof of failure either.
  calls = [];
  route('POST', '/api/topup', { status: 200, body: '<!DOCTYPE html><title>Page Not Found</title>' });
  route('GET', '/api/requery/air_4', { status: 404, body: { status: 'fail', message: 'Transaction not found.' } });
  await assert.rejects(
    () => msw.buyAirtime({ provider: 'MTN', number: '08031234567', amount: 100, reference: 'air_4' }),
    err => err.ambiguous === true && err.message === t.UNAVAILABLE,
    'never landed as far as anyone can tell: the original error goes back up, and the caller refunds'
  );

  // Found failed on requery: a refusal, in our words.
  route('POST', '/api/topup', () => { throw networkError(); });
  route('GET', '/api/requery/air_5', ok({ status: 'success', data: { transaction_status: 'failed', message: 'Invalid Number' } }));
  await assert.rejects(
    () => msw.buyAirtime({ provider: 'MTN', number: '08031234567', amount: 100, reference: 'air_5' }),
    err => !err.ambiguous && err.message.startsWith('That phone number was not accepted')
  );

  // The requery itself is down too: nothing more can be known, original error.
  route('GET', '/api/requery/air_6', () => { throw networkError(); });
  await assert.rejects(
    () => msw.buyAirtime({ provider: 'MTN', number: '08031234567', amount: 100, reference: 'air_6' }),
    err => err.ambiguous === true && err.statusCode === 504
  );

  /* ---------------------------------------------------------- requery */

  route('GET', '/api/requery/ele_9', ok({ status: 'success', data: { 'request-id': 'ele_9', transaction_status: 'success', token: '1111 2222 3333 4444 5555', amount: 1000 } }));
  const settled = await msw.getTransactionStatus('ele_9');
  assert.strictEqual(settled.status, 'successful');
  assert.strictEqual(settled.token, '1111 2222 3333 4444 5555');

  route('GET', '/api/requery/ele_10', ok({ status: 'success', data: { transaction_status: 'success', message: 'Token: 1234-5678-9012-3456-7890 Units: 20kWh' } }));
  assert.strictEqual((await msw.getTransactionStatus('ele_10')).token, '1234-5678-9012-3456-7890', 'a token only named in the text is still found');

  route('GET', '/api/requery/x1', ok({ status: 'success', data: { transaction_status: 'failed' } }));
  assert.strictEqual((await msw.getTransactionStatus('x1')).status, 'failed');
  route('GET', '/api/requery/x2', ok({ status: 'success', data: { transaction_status: 'pending' } }));
  assert.strictEqual((await msw.getTransactionStatus('x2')).status, 'processing');
  route('GET', '/api/requery/x3', { status: 404, body: { status: 'fail', message: 'Transaction not found.' } });
  assert.strictEqual((await msw.getTransactionStatus('x3')).status, 'not_found', 'an answer, not an outage - and not a refund');
  route('GET', '/api/requery/x4', ok({ status: 'success', data: { transaction_status: 'mystery' } }));
  assert.strictEqual((await msw.getTransactionStatus('x4')).status, '', 'an unknown state is never read as either outcome');

  /* ------------------------------------------------------------ tokens */

  assert.strictEqual(msw.extractToken({ token: 'ABC' }), 'ABC');
  assert.strictEqual(msw.extractToken({ message: 'Token: 12345678901234567890' }), '12345678901234567890');
  assert.strictEqual(msw.extractToken({ message: 'Airtime delivered to 2348031234567.' }), '', 'a phone number is not a token');
  assert.strictEqual(msw.extractToken({ message: 'Ref 12345678901234567890' }), '', 'twenty digits without the word is not handed to a meter');
  assert.strictEqual(msw.extractToken(null), '');

  /* ----------------------------------------------------- sandbox guard */

  // A sandbox key on production: every vend would answer success and deliver
  // nothing. Refused before any call, and the rail reads as unconfigured.
  process.env.NODE_ENV = 'production';
  process.env.MYSUBWALLET_API_KEY = 'sk_test_abc';
  assert.strictEqual(msw.isConfigured(), false);
  calls = [];
  await assert.rejects(
    () => msw.buyAirtime({ provider: 'MTN', number: '08031234567', amount: 100, reference: 'air_s1' }),
    err => err.misconfigured === true && err.statusCode === 503
  );
  assert.strictEqual(calls.length, 0, 'not one purchase call');

  // A live key on production that somehow gets a simulated answer.
  process.env.MYSUBWALLET_API_KEY = 'msw_live_key';
  assert.strictEqual(msw.isConfigured(), true);
  route('POST', '/api/topup', ok({ status: 'success', message: '[SANDBOX] Test transaction successful.', sandbox: true }));
  await assert.rejects(
    () => msw.buyAirtime({ provider: 'MTN', number: '08031234567', amount: 100, reference: 'air_s2' }),
    err => err.misconfigured === true,
    'a simulated success is never a delivered bill in production'
  );

  // Outside production the sandbox is what it is for.
  process.env.NODE_ENV = 'test';
  process.env.MYSUBWALLET_API_KEY = 'sk_test_abc';
  assert.strictEqual(msw.isConfigured(), true);
  assert.strictEqual(msw.isSandbox(), true);
  process.env.MYSUBWALLET_API_KEY = 'msw_live_key';

  /* --------------------------------------------------- float and warm */

  route('GET', '/api/balance', ok({ status: 'success', username: 'x', balance: 15000.5, currency: 'NGN' }));
  assert.strictEqual((await msw.getWalletBalance()).balance, 15000.5);
  route('GET', '/api/balance', ok({ status: 'success', currency: 'NGN' }));
  assert.strictEqual((await msw.getWalletBalance()).balance, null, 'absent is not zero');
  assert.strictEqual((await msw.getWalletBalance()).airtime_to_cash_balance, null, 'absent is not zero');

  // Airtime to Cash conversions land in their own balance, apart from the float.
  route('GET', '/api/balance', ok({ status: 'success', username: 'x', balance: 322, airtime_to_cash_balance: '1,400.50', currency: 'NGN' }));
  const balances = await msw.getWalletBalance();
  assert.deepStrictEqual([balances.balance, balances.airtime_to_cash_balance], [322, 1400.5]);
  assert.ok(!('username' in balances), 'figures only - nothing else of the account leaves the adapter');
  route('GET', '/api/balance', ok({ status: 'success', balance: 322, airtime_to_cash_balance: 0 }));
  assert.strictEqual((await msw.getWalletBalance()).airtime_to_cash_balance, 0, 'a real zero stays zero');
  route('GET', '/api/balance', ok({ status: 'success', balance: 322, airtime_to_cash_balance: 'n/a' }));
  assert.strictEqual((await msw.getWalletBalance()).airtime_to_cash_balance, null, 'unreadable is not zero');

  assert.strictEqual(msw.floatVerdict(null), 'unknown');
  assert.strictEqual(msw.floatVerdict(0), 'critical');
  assert.strictEqual(msw.floatVerdict(10_000), 'low');
  assert.strictEqual(msw.floatVerdict(100_000), 'healthy');

  const warm = await msw.warmCatalogues();
  assert.deepStrictEqual([warm.loaded, warm.failed, warm.skipped], [4, 0, null]);
  assert.strictEqual((await msw.warmCatalogues({ force: true })).skipped, 'no_shared_cache', 'a forced pass needs Redis');
  delete process.env.MYSUBWALLET_API_KEY;
  assert.strictEqual((await msw.warmCatalogues()).skipped, 'not_configured');
  process.env.MYSUBWALLET_API_KEY = 'msw_live_key';

  /* ----------------------------------------------------- identifiers */

  assert.deepStrictEqual(['MTN', 'Airtel', 'glo', '9mobile', 'T2', 'etisalat', '1', '5', 'xyz'].map(t.networkId), [1, 2, 3, 4, 4, 4, 1, 0, 0]);
  assert.deepStrictEqual(['+234 803 123 4567', '2348031234567', '08031234567', '8031234567'].map(t.providerPhone), [
    '08031234567', '08031234567', '08031234567', '08031234567',
  ]);
  assert.deepStrictEqual([true, false, 'success', 'pending', 'process', 'fail', 'failed', 'weird', null].map(t.outcomeOf), [
    'success', 'fail', 'success', 'pending', 'pending', 'fail', 'fail', '', '',
  ]);

  console.log('✅ mysubwallet.service tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
