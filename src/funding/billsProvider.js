// Which provider serves which bill, switchable from the admin dashboard.
//
// VoltPay buys airtime, data, cable TV and electricity from two interchangeable
// upstreams - PairGate and ClubKonnect. When one goes down, starts declining,
// or simply prices a rail worse than the other, an admin flips that rail over
// without a deploy. The switch is **per service**, so a broken data upstream
// does not drag airtime with it.
//
// Four settings rows, one per rail:
//   bills_provider_airtime | bills_provider_data
//   bills_provider_tv      | bills_provider_electricity
//
// Stored in app_settings exactly like the kill switch, for the same reasons -
// already backed up, already in the dashboard, survives a restart - and cached
// for the same 30 seconds, because a switch that takes ten minutes to land is
// not a switch you can respond to an incident with.
//
// **This does not fail open, and the difference from featureFlag.helper is the
// point.** A flag that cannot be read leaves the feature on, which is harmless.
// A provider that cannot be read has no harmless answer: picking arbitrarily
// would let a quote priced against one upstream be confirmed against the other,
// and a plan id is not portable between them. So a failed read resolves to one
// deterministic provider - the incumbent - which is also what every historical
// ledger row already says.
//
// Switchover is deliberately manual. There is no automatic cross-provider retry
// on a failed vend: a purchase that timed out may already have been delivered,
// so re-sending it to the other upstream risks paying for two. A failure
// refunds the customer and raises the ops alert, as it always has, and an admin
// decides whether the rail moves.
const prisma = require('../../database/prisma');
const redis = require('../services/redis.service');

const pairgate = require('./pairgate.service');
const clubkonnect = require('./clubkonnect.service');

const TTL = Number(process.env.BILLS_PROVIDER_TTL_SECONDS || 30);

// The four rails that can be switched. Named rather than free-form so a typo in
// an admin call cannot invent a setting nothing reads.
const SERVICES = {
  airtime: 'Airtime',
  data: 'Data bundles',
  tv: 'Cable TV',
  electricity: 'Electricity',
};

// The adapters. Every one of these exports the same surface - see the module
// header of either - which is what lets bills.controller stay ignorant of which
// is answering.
const ADAPTERS = {
  pairgate,
  clubkonnect,
};

const PROVIDER_LABELS = {
  pairgate: 'PairGate',
  clubkonnect: 'ClubKonnect',
};

// The answer when a setting is missing, unreadable, or names a provider that is
// no longer usable. PairGate because it is the incumbent: every bill written
// before this module existed carries `meta.gateway = 'pairgate'`, and the
// settlement sweep keys off that.
const DEFAULT_PROVIDER = 'pairgate';

function settingKey(service) {
  return `bills_provider_${service}`;
}

function isKnownService(service) {
  return Object.prototype.hasOwnProperty.call(SERVICES, String(service));
}

function isKnownProvider(name) {
  return Object.prototype.hasOwnProperty.call(ADAPTERS, String(name));
}

/**
 * Is this provider usable at all right now?
 *
 * Credentials only - it does not call anyone. A provider whose keys are absent
 * cannot serve a single vend, so routing to it would turn every purchase on
 * that rail into a refund.
 */
function isProviderConfigured(name) {
  const adapter = ADAPTERS[name];
  if (!adapter) return false;
  // Both adapters answer this. An adapter added later without one is assumed
  // usable rather than assumed broken - its own request path still throws on a
  // missing key, so the failure surfaces either way.
  return typeof adapter.isConfigured === 'function' ? adapter.isConfigured() : true;
}

function normalizeProvider(value) {
  const name = String(value ?? '').trim().toLowerCase();
  return isKnownProvider(name) ? name : '';
}

/**
 * The provider name for one rail.
 *
 * Cached, and every failure path lands on DEFAULT_PROVIDER: an unreadable
 * setting, an unknown name left behind by an older deploy, or a provider whose
 * credentials have since been removed. The last one is the important one - an
 * admin can switch to ClubKonnect and someone can later rotate the key out of
 * the environment, and this keeps the rail selling rather than refunding every
 * order until somebody notices.
 */
async function getProviderName(service) {
  if (!isKnownService(service)) return DEFAULT_PROVIDER;

  let chosen = '';
  try {
    const value = await redis.cached(redis.key('billsprovider', service), TTL, async () => {
      const row = await prisma.appSetting.findUnique({
        where: { setting_key: settingKey(service) },
        select: { setting_value: true },
      });
      // Store the string, not the adapter - a module cannot survive a JSON
      // round trip through the cache.
      return String(row?.setting_value ?? DEFAULT_PROVIDER);
    });
    chosen = normalizeProvider(value);
  } catch (e) {
    console.warn('billsProvider: read failed, using default', {
      service,
      reason: String(e?.message || e).slice(0, 120),
    });
    return DEFAULT_PROVIDER;
  }

  if (!chosen) return DEFAULT_PROVIDER;

  if (!isProviderConfigured(chosen)) {
    console.warn('billsProvider: selected provider is not configured, using default', { service, chosen });
    return DEFAULT_PROVIDER;
  }

  return chosen;
}

/** The adapter for a provider name. Falls back rather than returning undefined. */
function adapterFor(name) {
  return ADAPTERS[normalizeProvider(name) || DEFAULT_PROVIDER] || ADAPTERS[DEFAULT_PROVIDER];
}

/**
 * Resolve one rail to a live adapter.
 *
 * Returns the name alongside the module because the caller needs both: the
 * module to vend with, and the name to stamp into `meta.gateway` so the webhook
 * and the settlement sweep know which upstream to ask about this row later.
 * Reading those apart - vending with one and stamping the other - is the bug
 * this shape exists to make impossible.
 */
async function resolve(service) {
  const name = await getProviderName(service);
  return { name, provider: adapterFor(name) };
}

/**
 * Point a rail at a provider.
 *
 * Refuses an unconfigured provider outright. The read path silently falls back
 * for the same case, but that is a safety net for a key rotated out from under
 * a working switch - at the moment an admin is actually choosing, a rejection
 * with a reason is far more useful than a switch that appears to work and
 * quietly does nothing.
 */
async function setProvider(service, name) {
  if (!isKnownService(service)) {
    const err = new Error(`Unknown bills service "${service}"`);
    err.code = 'UNKNOWN_SERVICE';
    throw err;
  }

  const chosen = normalizeProvider(name);
  if (!chosen) {
    const err = new Error(`Unknown bills provider "${name}"`);
    err.code = 'UNKNOWN_PROVIDER';
    throw err;
  }

  if (!isProviderConfigured(chosen)) {
    const err = new Error(`${PROVIDER_LABELS[chosen]} has no API credentials configured`);
    err.code = 'PROVIDER_NOT_CONFIGURED';
    throw err;
  }

  await prisma.appSetting.upsert({
    where: { setting_key: settingKey(service) },
    update: { setting_value: chosen },
    create: {
      setting_key: settingKey(service),
      setting_value: chosen,
      description: `Bills provider for ${SERVICES[service]}`,
    },
  });
  await redis.del(redis.key('billsprovider', service));

  return { service, provider: chosen };
}

/**
 * Every rail and its current provider, for the dashboard.
 *
 * `configured` rides along so the UI can grey out a provider that cannot be
 * selected instead of letting an admin pick it and read an error afterwards.
 */
async function listProviders() {
  const services = Object.keys(SERVICES);
  const rows = await prisma.appSetting.findMany({
    where: { setting_key: { in: services.map(settingKey) } },
    select: { setting_key: true, setting_value: true },
  });
  const byKey = new Map(rows.map(r => [r.setting_key, r.setting_value]));

  const available = Object.keys(ADAPTERS).map(name => ({
    name,
    label: PROVIDER_LABELS[name] || name,
    configured: isProviderConfigured(name),
  }));

  return {
    services: services.map(service => {
      const stored = normalizeProvider(byKey.get(settingKey(service)));
      const effective = stored && isProviderConfigured(stored) ? stored : DEFAULT_PROVIDER;
      return {
        service,
        label: SERVICES[service],
        provider: effective,
        // Surfaced so the dashboard can say *why* a rail is not on the provider
        // it was set to, rather than silently showing the fallback as if it had
        // been chosen.
        fallback: Boolean(stored) && stored !== effective,
      };
    }),
    available,
    default: DEFAULT_PROVIDER,
  };
}

module.exports = {
  resolve,
  getProviderName,
  adapterFor,
  setProvider,
  listProviders,
  isProviderConfigured,
  isKnownService,
  isKnownProvider,
  SERVICES,
  ADAPTERS,
  PROVIDER_LABELS,
  DEFAULT_PROVIDER,
  __test: { settingKey, normalizeProvider },
};
