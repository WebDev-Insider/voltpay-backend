/**
 * node test/billsProvider.test.js
 *
 * Which provider may serve which bills rail, and which one does. No network,
 * no Redis, no Postgres - a fake app_settings table.
 *
 *   1. The allow-list: airtime on any of the three, data and TV on MySubWallet
 *      or ClubKonnect, electricity on MySubWallet only.
 *   2. Electricity never reaches ClubKonnect - not by the switch, not by a row
 *      written some other way, and not even if someone adds it to ALLOWED.
 *   3. A stored choice that is unknown, disallowed, unconfigured or unreadable
 *      resolves to MySubWallet; a refused switch says why.
 *   4. Bill Hero rewards never go to a provider that cannot be asked about our
 *      own reference (CashBuddy).
 *   5. The dashboard learns credential status by env var NAME - never a value.
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.NODE_ENV = 'test';

// Sentinel values: none of these may ever appear in what the dashboard reads.
const SECRETS = {
  MYSUBWALLET_API_KEY: 'msw_live_SENTINEL_1',
  CLUBKONNECT_USER_ID: 'CK_SENTINEL_2',
  CLUBKONNECT_API_KEY: 'ck_SENTINEL_3',
  CASHBUDDY_API_KEY: 'cb_live_SENTINEL_4',
  CASHBUDDY_USER_ID: 'uuid-SENTINEL-5',
};
Object.assign(process.env, SECRETS);
delete process.env.CASHBUDDY_USER_EMAIL;
delete process.env.CASHBUDDY_USER_PHONE;

/* ---------------------------------------------------------- fake settings */

const settings = new Map();
let readFails = false;

const fakePrisma = {
  appSetting: {
    async findUnique({ where }) {
      if (readFails) throw new Error('database unreachable');
      return settings.has(where.setting_key) ? { setting_value: settings.get(where.setting_key) } : null;
    },
    async findMany({ where }) {
      return where.setting_key.in.filter(k => settings.has(k)).map(k => ({ setting_key: k, setting_value: settings.get(k) }));
    },
    async upsert({ where, update }) {
      settings.set(where.setting_key, update.setting_value);
      return { setting_key: where.setting_key, setting_value: update.setting_value };
    },
  },
};

function stub(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
stub('../database/prisma', fakePrisma);

const bills = require('../src/funding/billsProvider');
const clubkonnect = require('../src/funding/clubkonnect.service');
const cashbuddy = require('../src/funding/cashbuddy.service');

async function rejects(promise, code, pattern) {
  try {
    await promise;
  } catch (e) {
    assert.strictEqual(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    if (pattern) assert.ok(pattern.test(e.message), `message "${e.message}" should match ${pattern}`);
    return e;
  }
  throw new Error(`expected a ${code} rejection`);
}

(async () => {
  /* ======================================================== the allow-list */

  const matrix = {
    airtime: { mysubwallet: true, cashbuddy: true, clubkonnect: true },
    data: { mysubwallet: true, cashbuddy: false, clubkonnect: true },
    tv: { mysubwallet: true, cashbuddy: false, clubkonnect: true },
    electricity: { mysubwallet: true, cashbuddy: false, clubkonnect: false },
  };
  for (const [service, row] of Object.entries(matrix)) {
    for (const [provider, allowed] of Object.entries(row)) {
      assert.strictEqual(bills.isAllowed(service, provider), allowed, `${provider} on ${service}`);
    }
  }
  assert.strictEqual(bills.isAllowed('betting', 'mysubwallet'), false, 'not a bills rail');
  assert.strictEqual(bills.isAllowed('airtime', 'pairgate'), false, 'not a registered provider');

  // Every allowed pair is one the adapter actually implements.
  for (const [service, providers] of Object.entries(bills.ALLOWED)) {
    for (const name of providers) {
      assert.ok(bills.ADAPTERS[name].SERVICES.includes(service), `${name} must implement ${service}`);
    }
  }

  /* ======================================== electricity never on ClubKonnect */

  // The adapter has no electricity code to call, whatever any table says.
  assert.ok(!clubkonnect.SERVICES.includes('electricity'));
  for (const fn of ['payElectricity', 'validateElectricityMeter', 'listElectricityDiscosCached', 'normalizeMeterType']) {
    assert.strictEqual(clubkonnect[fn], undefined, `clubkonnect must not export ${fn}`);
  }

  // The policy holds even if someone adds it to the allow-list by mistake.
  bills.ALLOWED.electricity.push('clubkonnect');
  assert.strictEqual(bills.isAllowed('electricity', 'clubkonnect'), false, 'BARRED outranks ALLOWED');
  bills.ALLOWED.electricity.pop();

  // The switch refuses it, with the reason.
  await rejects(bills.setProvider('electricity', 'clubkonnect'), 'PROVIDER_NOT_ALLOWED', /barred/i);
  assert.strictEqual(settings.has('bills_provider_electricity'), false, 'nothing written');

  // A row written some other way is ignored, not obeyed.
  settings.set('bills_provider_electricity', 'clubkonnect');
  assert.strictEqual(await bills.getProviderName('electricity'), 'mysubwallet');
  const resolvedElectricity = await bills.resolve('electricity');
  assert.strictEqual(resolvedElectricity.name, 'mysubwallet');
  assert.strictEqual(resolvedElectricity.provider, bills.ADAPTERS.mysubwallet);
  settings.delete('bills_provider_electricity');

  /* ============================================================ CashBuddy */

  assert.deepStrictEqual(cashbuddy.SERVICES, ['airtime']);
  for (const fn of ['buyData', 'payTv', 'payElectricity', 'listDataPlansCached', 'validateElectricityMeter']) {
    assert.strictEqual(cashbuddy[fn], undefined, `cashbuddy must not export ${fn}`);
  }
  await rejects(bills.setProvider('data', 'cashbuddy'), 'PROVIDER_NOT_ALLOWED', /data-plan list/i);
  await rejects(bills.setProvider('tv', 'cashbuddy'), 'PROVIDER_NOT_ALLOWED', /bouquet/i);
  await rejects(bills.setProvider('electricity', 'cashbuddy'), 'PROVIDER_NOT_ALLOWED', /meter lookup/i);

  /* ======================================================== the switch */

  await rejects(bills.setProvider('betting', 'mysubwallet'), 'UNKNOWN_SERVICE');
  await rejects(bills.setProvider('airtime', 'pairgate'), 'UNKNOWN_PROVIDER');

  // Default before anything is chosen.
  for (const service of Object.keys(bills.SERVICES)) {
    assert.strictEqual(await bills.getProviderName(service), 'mysubwallet', `${service} defaults to MySubWallet`);
  }

  // Per service: moving airtime does not move data.
  assert.deepStrictEqual(await bills.setProvider('airtime', 'cashbuddy'), { service: 'airtime', provider: 'cashbuddy' });
  assert.deepStrictEqual(await bills.setProvider('data', 'ClubKonnect'), { service: 'data', provider: 'clubkonnect' });
  assert.strictEqual(await bills.getProviderName('airtime'), 'cashbuddy');
  assert.strictEqual(await bills.getProviderName('data'), 'clubkonnect');
  assert.strictEqual(await bills.getProviderName('tv'), 'mysubwallet');
  assert.strictEqual((await bills.resolveBillProvider('airtime')).provider, cashbuddy, 'the brief\'s name for resolve');

  // A provider whose credentials are removed after the switch: the rail keeps
  // selling on the default instead of refunding every order.
  delete process.env.CLUBKONNECT_API_KEY;
  assert.strictEqual(await bills.getProviderName('data'), 'mysubwallet');
  const unconfigured = await rejects(bills.setProvider('tv', 'clubkonnect'), 'PROVIDER_NOT_CONFIGURED', /CLUBKONNECT_API_KEY/);
  assert.ok(!unconfigured.message.includes(SECRETS.CLUBKONNECT_USER_ID), 'names the variable, never a value');
  process.env.CLUBKONNECT_API_KEY = SECRETS.CLUBKONNECT_API_KEY;
  assert.strictEqual(await bills.getProviderName('data'), 'clubkonnect');

  // CashBuddy needs to know which account pays, not just a key.
  delete process.env.CASHBUDDY_USER_ID;
  assert.strictEqual(bills.isProviderConfigured('cashbuddy'), false);
  assert.deepStrictEqual(bills.configStatus('cashbuddy').missing, ['CASHBUDDY_USER_ID']);
  process.env.CASHBUDDY_USER_EMAIL = 'float@voltpay.example';
  assert.strictEqual(bills.isProviderConfigured('cashbuddy'), true, 'the account email works too');
  delete process.env.CASHBUDDY_USER_EMAIL;
  process.env.CASHBUDDY_USER_ID = SECRETS.CASHBUDDY_USER_ID;

  // An unreadable setting is the incumbent, never a guess.
  readFails = true;
  assert.strictEqual(await bills.getProviderName('airtime'), 'mysubwallet');
  readFails = false;

  // A name no longer registered (old rows still say "pairgate").
  settings.set('bills_provider_tv', 'pairgate');
  assert.strictEqual(await bills.getProviderName('tv'), 'mysubwallet');
  settings.delete('bills_provider_tv');

  /* ============================================================ settlement */

  // A bill already sold is settled by the provider that sold it - adapterFor is
  // not filtered by the switch or the allow-list.
  assert.strictEqual(bills.adapterFor('clubkonnect'), clubkonnect);
  assert.strictEqual(bills.adapterFor('cashbuddy'), cashbuddy);
  assert.strictEqual(bills.adapterFor('pairgate'), bills.ADAPTERS.mysubwallet);
  for (const name of ['mysubwallet', 'clubkonnect', 'cashbuddy']) assert.ok(bills.isKnownProvider(name));

  /* =========================================================== Bill Hero */

  // Airtime is on CashBuddy: a reward goes through the default, because a
  // cut-off reward is asked about by a reference CashBuddy never receives.
  const reward = await bills.resolveForRewards('airtime');
  assert.strictEqual(reward.name, 'mysubwallet');
  assert.strictEqual(reward.provider, bills.ADAPTERS.mysubwallet);
  // Data is on ClubKonnect, which does take our reference: it follows the switch.
  assert.strictEqual((await bills.resolveForRewards('data')).name, 'clubkonnect');
  await bills.setProvider('airtime', 'clubkonnect');
  assert.strictEqual((await bills.resolveForRewards('airtime')).name, 'clubkonnect');

  /* ========================================================= the dashboard */

  settings.set('bills_provider_electricity', 'clubkonnect'); // hand-written, disallowed
  const listed = await bills.listProviders();
  const rail = service => listed.services.find(s => s.service === service);

  assert.strictEqual(rail('airtime').provider, 'clubkonnect');
  assert.strictEqual(rail('data').provider, 'clubkonnect');
  assert.strictEqual(rail('electricity').provider, 'mysubwallet');
  assert.strictEqual(rail('electricity').fallback, true, 'shows that a stored choice is not in effect');

  const option = (service, name) => rail(service).options.find(o => o.name === name);
  assert.strictEqual(option('electricity', 'clubkonnect').allowed, false);
  assert.ok(/barred/i.test(option('electricity', 'clubkonnect').reason));
  assert.strictEqual(option('data', 'cashbuddy').allowed, false);
  assert.strictEqual(option('airtime', 'cashbuddy').allowed, true);
  assert.strictEqual(option('airtime', 'cashbuddy').reason, '');

  const provider = name => listed.available.find(p => p.name === name);
  assert.deepStrictEqual(provider('cashbuddy').services, ['airtime']);
  assert.deepStrictEqual(provider('clubkonnect').services, ['airtime', 'data', 'tv']);
  assert.deepStrictEqual(provider('mysubwallet').services, ['airtime', 'data', 'tv', 'electricity']);
  assert.strictEqual(provider('cashbuddy').float_readable, false);
  assert.strictEqual(provider('clubkonnect').float_readable, true);

  delete process.env.CASHBUDDY_API_KEY;
  const withMissing = await bills.listProviders();
  assert.deepStrictEqual(withMissing.available.find(p => p.name === 'cashbuddy').missing, ['CASHBUDDY_API_KEY']);
  process.env.CASHBUDDY_API_KEY = SECRETS.CASHBUDDY_API_KEY;

  const shown = JSON.stringify([listed, withMissing]);
  for (const [name, value] of Object.entries(SECRETS)) {
    assert.ok(!shown.includes(value), `${name}'s value must never reach the dashboard`);
  }

  console.log('✅ bills provider routing tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
