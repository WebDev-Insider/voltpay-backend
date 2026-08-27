/**
 * node test/adminBillHeroDataPlans.test.js
 *
 * The reward-size picker that replaced the free-text megabytes box.
 *
 * No network, no Redis, no database. All three are stubbed here because the
 * failures this guards against were observed against the live providers:
 *
 *   - Both upstreams throttle on a per-minute budget shared with customer
 *     vending, so a rebuild can come back with two of four networks missing.
 *     Serving that partial list silently drops sizes an admin has already used,
 *     for a reason that has nothing to do with what can be vended. It must fall
 *     back to the last complete answer instead.
 *
 *   - The catalogue contains 5.2GB, 8.4GB and 11.4GB "anytime" bundles and a
 *     480GB plan costing NGN 90,000. Offered as rewards those are noise at
 *     best and an expensive mis-click at worst, so a size has to be namable,
 *     sold in its own right by more than one network, and under the cost
 *     ceiling before it reaches the dropdown.
 *
 *   - The data rail is switchable between PairGate and ClubKonnect, and they do
 *     not sell the same bundles. The cached ladder is therefore per rail: a
 *     switch must rebuild rather than keep serving the sizes of the provider
 *     that is no longer vending.
 */

const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);
process.env.BILL_HERO_MAX_REWARD_COST_NGN = '6000';

// The stubs must be installed before the controller is required. It reaches the
// catalogue through the registry, and `ADAPTERS.pairgate` is the module object
// itself, so assigning onto the module here is what the resolved adapter will
// carry.
const pairgate = require('../src/funding/pairgate.service');
const clubkonnect = require('../src/funding/clubkonnect.service');
const bills = require('../src/funding/billsProvider');
const redis = require('../src/services/redis.service');

// Two catalogues, because the point of half these assertions is that the screen
// shows the one belonging to whichever rail is live.
let catalogues = { pairgate: {}, clubkonnect: {} };
let failNetworks = new Set();
let networkCalls = { pairgate: 0, clubkonnect: 0 };

const stubCatalogue = gateway => async network => {
  networkCalls[gateway] += 1;
  if (failNetworks.has(network)) throw new Error('Too Many Attempts.');

  return catalogues[gateway][network] || [];
};

pairgate.listDataPlansCached = stubCatalogue('pairgate');
clubkonnect.listDataPlansCached = stubCatalogue('clubkonnect');

// The rail switch, stubbed at `resolve` rather than at the settings row: this
// suite is about the screen, and `billsProvider` has its own coverage. Patching
// the export is enough because the controller calls `bills.resolve(...)`.
let activeGateway = 'pairgate';

bills.resolve = async () => ({ name: activeGateway, provider: bills.ADAPTERS[activeGateway] });

const store = new Map();

redis.get = async k => (store.has(k) ? JSON.parse(store.get(k)) : null);
redis.set = async (k, v) => store.set(k, JSON.stringify(v));
redis.del = async (...keys) => keys.forEach(k => store.delete(k));

const controller = require('../src/controllers/adminBillHero.controller');
const { isNamableSize, sellsSize, isCompleteResult } = controller.__test;

/** The two cache keys for a rail, as the controller builds them. */
const servingKey = gateway => redis.key('billhero', 'dataplans', gateway, 'v1');
const lastGoodKey = gateway => redis.key('billhero', 'dataplans', 'last_good', gateway, 'v1');

/** Drive the handler and hand back the `data` envelope. */
function call() {
  return new Promise(resolve => {
    controller.listDataPlanOptions(
      {},
      {
        json(body) {
          resolve(body.data);
        },
        status() {
          return this;
        },
      },
    );
  });
}

const plan = (id, name, amount) => ({ id, name, amount });

// --- namable sizes --------------------------------------------------------
// Whole gigabytes above 1GB, round megabytes below it. 5325 is 5.2GB and 8602
// is 8.4GB - real plans, but not sizes anybody writes on a promotion.

assert.strictEqual(isNamableSize(500), true);
assert.strictEqual(isNamableSize(200), true);
assert.strictEqual(isNamableSize(1024), true);
assert.strictEqual(isNamableSize(10240), true);
assert.strictEqual(isNamableSize(5325), false);
assert.strictEqual(isNamableSize(8602), false);
assert.strictEqual(isNamableSize(1843), false, '1.8GB is a real MTN plan but not a reward size');
assert.strictEqual(isNamableSize(1536), false, 'half gigabytes are dropped above 1GB');

// --- sold in its own right ------------------------------------------------
// The 5% tolerance absorbs a 512MB bundle advertised as "500MB" and nothing
// wider. This is what stops MTN's 1.8GB counting as somebody selling 2GB.

const mtnish = [plan('a', '1.8gb Xtra Bundle (GIFTING) - 7 Days', 1500), plan('b', '512MB (SME) - 7 Days', 500)];

assert.strictEqual(sellsSize(mtnish, 500), true, '512MB counts as 500MB being sold');
assert.strictEqual(sellsSize(mtnish, 1843), true);
assert.strictEqual(sellsSize(mtnish, 2048), false, '1.8GB is not 2GB');
assert.strictEqual(sellsSize([], 1024), false);

// --- complete-result test -------------------------------------------------
// Tested against the sentinel, not against a provider name: `source` now
// carries whichever rail answered, so a second provider must not start
// silently failing this check and discarding every rebuild it makes.

assert.strictEqual(isCompleteResult({ source: 'pairgate', unavailable_networks: [], options: [{}] }), true);
assert.strictEqual(isCompleteResult({ source: 'clubkonnect', unavailable_networks: [], options: [{}] }), true);
assert.strictEqual(isCompleteResult({ source: 'pairgate', unavailable_networks: ['GLO'], options: [{}] }), false);
assert.strictEqual(isCompleteResult({ source: 'pairgate', unavailable_networks: [], options: [] }), false);
assert.strictEqual(isCompleteResult({ source: 'unavailable', unavailable_networks: [], options: [{}] }), false);
assert.strictEqual(isCompleteResult(null), false);

// --- the assembled ladder -------------------------------------------------

(async () => {
  // Every network sells 1GB and 2GB. Only MTN sells 1.8GB, so it must not
  // appear even though 2GB sits inside the runtime's 20% match band. The 480GB
  // plan is over the cost ceiling and must not appear either.
  const common = [
    plan('1', '1GB - 30 Days', 300),
    plan('2', '2GB - 30 Days', 800),
  ];

  const everyNetwork = plans => ({ MTN: plans, GLO: plans, AIRTEL: plans, '9MOBILE': plans });

  catalogues.pairgate = {
    ...everyNetwork(common),
    MTN: [...common, plan('x', '1.8gb Xtra Bundle - 7 Days', 1500), plan('y', '480gb - 90 Days', 90000)],
  };
  failNetworks = new Set();
  store.clear();
  networkCalls = { pairgate: 0, clubkonnect: 0 };
  activeGateway = 'pairgate';

  const first = await call();

  assert.strictEqual(first.source, 'pairgate');
  assert.strictEqual(first.cached, false);
  assert.deepStrictEqual(first.unavailable_networks, []);
  assert.deepStrictEqual(
    first.options.map(o => o.label),
    ['1GB', '2GB'],
    'only sizes several networks sell in their own right, under the cost ceiling',
  );

  const twoGb = first.options.find(o => o.label === '2GB');
  assert.strictEqual(twoGb.available_on, 4);
  assert.strictEqual(twoGb.min_cost, 800);
  assert.strictEqual(twoGb.networks.MTN.plan_name, '2GB - 30 Days');
  // The signature is an internal dedupe key and must never reach the client.
  assert.strictEqual('signature' in twoGb, false);

  // --- the cache ----------------------------------------------------------
  // A second open of the dialog must cost the provider nothing. This is the
  // whole reason the endpoint caches: four calls per dialog open is enough to
  // throttle a rail customers are buying on.

  const callsAfterBuild = networkCalls.pairgate;
  const second = await call();

  assert.strictEqual(second.cached, true);
  assert.strictEqual(networkCalls.pairgate, callsAfterBuild, 'a warm read must not touch the provider at all');
  assert.deepStrictEqual(second.options.map(o => o.label), ['1GB', '2GB']);

  // --- the rail moves -----------------------------------------------------
  // An admin points data at ClubKonnect, which sells a different ladder. The
  // warm PairGate copy must not answer: the sizes on this screen are the sizes
  // a claim will try to vend, so serving the old rail's list is how an admin
  // promises a bundle the live provider does not sell. One shared key held that
  // wrong list for six hours.

  catalogues.clubkonnect = everyNetwork([
    plan('c1', '2GB - 30 Days', 750),
    plan('c2', '5GB - 30 Days', 1800),
  ]);
  activeGateway = 'clubkonnect';

  const afterSwitch = await call();

  assert.strictEqual(afterSwitch.source, 'clubkonnect', 'the screen names the rail it read');
  assert.strictEqual(afterSwitch.cached, false, 'a switched rail rebuilds instead of serving the old copy');
  assert.ok(networkCalls.clubkonnect > 0, 'and it rebuilds from the new provider');
  assert.deepStrictEqual(
    afterSwitch.options.map(o => o.label),
    ['2GB', '5GB'],
    'ClubKonnect sells 5GB and not 1GB, and that is what the admin must see',
  );

  // Switching back finds PairGate's own copy still warm. That is correct rather
  // than stale - it is that rail's catalogue, cached under that rail's key.
  activeGateway = 'pairgate';
  const callsBeforeReturn = networkCalls.pairgate;
  const back = await call();

  assert.strictEqual(back.source, 'pairgate');
  assert.strictEqual(back.cached, true);
  assert.strictEqual(networkCalls.pairgate, callsBeforeReturn, 'the incumbent rail is still warm');
  assert.deepStrictEqual(back.options.map(o => o.label), ['1GB', '2GB']);

  // --- degraded rebuild ---------------------------------------------------
  // Serving cache expired, and this time the provider throttles three of four
  // networks. The last complete answer is served instead of a shrunken one,
  // flagged stale so the screen can say so.

  store.delete(servingKey('pairgate'));
  failNetworks = new Set(['GLO', 'AIRTEL', '9MOBILE']);

  const degraded = await call();

  assert.strictEqual(degraded.stale, true);
  assert.strictEqual(degraded.cached, true);
  assert.deepStrictEqual(
    degraded.options.map(o => o.label),
    ['1GB', '2GB'],
    'a throttled rebuild must not shrink the list an admin sees',
  );
  assert.deepStrictEqual(degraded.unavailable_networks, ['GLO', 'AIRTEL', '9MOBILE'], 'but it must say what failed');

  // --- last-good is per rail too ------------------------------------------
  // A rail switched to for the first time, throttled on its very first build,
  // must not fall back to the other provider's last-good ladder. PairGate's
  // last-good is deliberately left in the store here: empty is honest, the
  // other rail's sizes are a lie the admin cannot see through.

  activeGateway = 'clubkonnect';
  store.delete(servingKey('clubkonnect'));
  store.delete(lastGoodKey('clubkonnect'));
  assert.ok(store.has(lastGoodKey('pairgate')), 'the other rail still has a last-good to wrongly borrow');
  failNetworks = new Set(['MTN', 'GLO', 'AIRTEL', '9MOBILE']);

  const crossRail = await call();

  assert.strictEqual(crossRail.source, 'unavailable', 'not the other rail\'s last-good list');
  assert.strictEqual(crossRail.options.length, 0);

  // --- no last-good to fall back on ---------------------------------------
  // First ever call, and the provider is down. The editor reads `source` and
  // puts the plain number box back, so authoring a challenge is still possible.

  activeGateway = 'pairgate';
  store.clear();
  failNetworks = new Set(['MTN', 'GLO', 'AIRTEL', '9MOBILE']);

  const cold = await call();

  assert.strictEqual(cold.source, 'unavailable');
  assert.strictEqual(cold.options.length, 0);
  assert.strictEqual(!!cold.stale, false);

  console.log('adminBillHero data plan tests passed');
})();
