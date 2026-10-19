// Which provider serves which bill, switchable from the admin dashboard.
//
// Three upstreams are registered: MySubWallet (the default, and the only one
// that can serve every rail), ClubKonnect and CashBuddy. Every caller - the
// controller, Bill Hero, the scheduled top-up worker, the sweep, the ops screen
// - goes through here rather than importing a provider directly, and an admin
// flips a rail between providers without a deploy, **per service**, so a broken
// data upstream does not drag airtime with it.
//
// Not every provider may serve every rail, for two different kinds of reason,
// and the dashboard says which one applies:
//
//   - **Policy.** Electricity is never routed through ClubKonnect - the owner's
//     rule (October 2026), kept in BARRED below and enforced three times over:
//     BARRED, ALLOWED, and the ClubKonnect adapter itself, which has no
//     electricity code to call.
//   - **Capability.** CashBuddy's partner API publishes no data-plan list, no
//     bouquet list and no meter or smartcard lookup (checked against the live
//     API, 2026-10-19), so it can price and verify nothing but airtime. Those
//     rails are left off ALLOWED until it does; adding them back is an adapter
//     function plus a line below.
//
//   Airtime      MySubWallet | CashBuddy | ClubKonnect
//   Data         MySubWallet | ClubKonnect
//   Cable TV     MySubWallet | ClubKonnect
//   Electricity  MySubWallet
//
// A stored setting that names a provider no longer registered (old
// `bills_provider_*` rows can still say "pairgate"), or one this rail may not
// use, reads as unknown and resolves to the default - no data migration is
// needed for a switchover.
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
//
// **The switch decides new purchases only.** A bill already sold is settled by
// the provider named in its own row (`meta.gateway`, read through adapterFor),
// whatever the switch says now - so a rail can move with bills in flight.
const prisma = require('../../database/prisma');
const redis = require('../services/redis.service');

const mysubwallet = require('./mysubwallet.service');
const clubkonnect = require('./clubkonnect.service');
const cashbuddy = require('./cashbuddy.service');

const TTL = Number(process.env.BILLS_PROVIDER_TTL_SECONDS || 30);

// The four rails that can be switched. Named rather than free-form so a typo in
// an admin call cannot invent a setting nothing reads.
const SERVICES = {
  airtime: 'Airtime',
  data: 'Data bundles',
  tv: 'Cable TV',
  electricity: 'Electricity',
};

// The adapters. Every one exports the same surface - see the header of
// mysubwallet.service.js - which is what lets bills.controller stay ignorant of
// which is answering. Each also declares the rails it implements (`SERVICES`).
//
// **A name in here is also a gateway the sweep asks about.** billReconcile
// settles only rows whose `meta.gateway` is a key of this object, so removing a
// provider while it still has bills in `processing` strands them: never
// settled, never refunded. Check for open rows before removing one.
const ADAPTERS = {
  mysubwallet,
  clubkonnect,
  cashbuddy,
};

const PROVIDER_LABELS = {
  mysubwallet: 'MySubWallet',
  clubkonnect: 'ClubKonnect',
  cashbuddy: 'CashBuddy',
};

// The answer when a setting is missing, unreadable, or names a provider that is
// no longer usable - including one that has since been removed from ADAPTERS.
const DEFAULT_PROVIDER = 'mysubwallet';

// The owner's rule, kept apart from ALLOWED on purpose: ALLOWED is a list
// someone extends when a provider gains a capability, and this must not be
// extended along with it. "Do NOT offer or route Electricity through
// ClubKonnect."
const BARRED = {
  electricity: ['clubkonnect'],
};

// Who may serve each rail, in the order the dashboard offers them.
const ALLOWED = {
  airtime: ['mysubwallet', 'cashbuddy', 'clubkonnect'],
  data: ['mysubwallet', 'clubkonnect'],
  tv: ['mysubwallet', 'clubkonnect'],
  electricity: ['mysubwallet'],
};

// Why a registered provider is missing from a rail. Shown beside the switch so
// a gap reads as a decision with a reason, not as a bug.
const NOT_OFFERED = {
  data: { cashbuddy: 'CashBuddy publishes no data-plan list, so a bundle cannot be priced' },
  tv: { cashbuddy: 'CashBuddy publishes no bouquet list or smartcard lookup' },
  electricity: {
    clubkonnect: 'Barred: electricity is never routed through ClubKonnect',
    cashbuddy: 'CashBuddy publishes no meter lookup, so the meter owner cannot be confirmed',
  },
};

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
 * May this provider serve this rail at all?
 *
 * Three locks, all of which must open: not barred by policy, on the rail's
 * allow-list, and actually implemented by the adapter. Credentials are a
 * separate question - see isProviderConfigured.
 */
function isAllowed(service, name) {
  const provider = String(name ?? '');
  if (!isKnownService(service) || !isKnownProvider(provider)) return false;
  if ((BARRED[service] || []).includes(provider)) return false;
  if (!(ALLOWED[service] || []).includes(provider)) return false;
  const implemented = ADAPTERS[provider].SERVICES;
  return Array.isArray(implemented) && implemented.includes(service);
}

/** The reason a provider is not offered on a rail, or '' when it is. */
function notOfferedReason(service, name) {
  if (isAllowed(service, name)) return '';
  const label = PROVIDER_LABELS[name] || name;
  return NOT_OFFERED[service]?.[name] || `${label} does not serve ${SERVICES[service] || service}`;
}

/**
 * Which credentials a provider has, by env var NAME - never a value.
 *
 * `missing` is what a superadmin has to set; `problems` is anything set but
 * unusable, such as a sandbox key on production.
 */
function configStatus(name) {
  const adapter = ADAPTERS[name];
  if (!adapter) return { configured: false, missing: [], problems: ['Not a registered provider'] };
  if (typeof adapter.configStatus === 'function') {
    const status = adapter.configStatus();
    return {
      configured: Boolean(status?.configured),
      missing: Array.isArray(status?.missing) ? status.missing : [],
      problems: Array.isArray(status?.problems) ? status.problems : [],
    };
  }
  const configured = typeof adapter.isConfigured === 'function' ? adapter.isConfigured() : true;
  return { configured, missing: [], problems: [] };
}

/**
 * Is this provider usable at all right now?
 *
 * Credentials only - it does not call anyone. A provider whose keys are absent
 * cannot serve a single vend, so routing to it would turn every purchase on
 * that rail into a refund.
 */
function isProviderConfigured(name) {
  return configStatus(name).configured;
}

function normalizeProvider(value) {
  const name = String(value ?? '').trim().toLowerCase();
  return isKnownProvider(name) ? name : '';
}

/**
 * The provider name for one rail.
 *
 * Cached, and every failure path lands on DEFAULT_PROVIDER: an unreadable
 * setting, an unknown name left behind by an older deploy, a provider this rail
 * may not use, or a provider whose credentials have since been removed. The
 * last one is the important one - an admin can switch to a provider and someone
 * can later rotate the key out of the environment, and this keeps the rail
 * selling rather than refunding every order until somebody notices.
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

  // A row written before an allow-list existed, or by hand. setProvider would
  // never write it, so it is ignored rather than obeyed.
  if (!isAllowed(service, chosen)) {
    console.warn('billsProvider: selected provider may not serve this rail, using default', { service, chosen });
    return DEFAULT_PROVIDER;
  }

  if (!isProviderConfigured(chosen)) {
    console.warn('billsProvider: selected provider is not configured, using default', { service, chosen });
    return DEFAULT_PROVIDER;
  }

  return chosen;
}

/**
 * The adapter for a provider name. Falls back rather than returning undefined.
 *
 * Deliberately not filtered by the allow-list: this is also how a bill already
 * sold is settled, and that must ask the provider that sold it - even one an
 * admin has since moved the rail away from.
 */
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
 * Resolve a rail for a Bill Hero reward.
 *
 * A reward is sent under a reference we mint, and a send that is cut off is
 * later asked about by that reference - "not found" there means it never
 * arrived, and the reward is sent again. That reasoning only holds on an
 * upstream that receives our reference. CashBuddy does not (it has no field for
 * one), so "not found" from it proves nothing and a re-send could deliver a
 * reward twice. A rail switched to such a provider sends rewards through the
 * default instead.
 */
async function resolveForRewards(service) {
  const resolved = await resolve(service);
  if (resolved.provider.SUPPORTS_REQUEST_ID_LOOKUP) return resolved;
  return { name: DEFAULT_PROVIDER, provider: adapterFor(DEFAULT_PROVIDER) };
}

/**
 * Point a rail at a provider.
 *
 * Refuses a provider the rail may not use, and an unconfigured one. The read
 * path silently falls back for both, but that is a safety net for a row written
 * some other way or a key rotated out from under a working switch - at the
 * moment an admin is actually choosing, a rejection with a reason is far more
 * useful than a switch that appears to work and quietly does nothing.
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

  if (!isAllowed(service, chosen)) {
    const err = new Error(`${PROVIDER_LABELS[chosen]} cannot serve ${SERVICES[service]}: ${notOfferedReason(service, chosen)}`);
    err.code = 'PROVIDER_NOT_ALLOWED';
    throw err;
  }

  const status = configStatus(chosen);
  if (!status.configured) {
    const detail = [...status.missing.map(v => `${v} is not set`), ...status.problems].join('; ');
    const err = new Error(`${PROVIDER_LABELS[chosen]} is not configured${detail ? ` (${detail})` : ''}`);
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

/** One provider as the dashboard shows it: label, credentials, rails, float. */
function providerSummary(name) {
  const status = configStatus(name);
  return {
    name,
    label: PROVIDER_LABELS[name] || name,
    configured: status.configured,
    missing: status.missing,
    problems: status.problems,
    services: Object.keys(SERVICES).filter(service => isAllowed(service, name)),
    float_readable: ADAPTERS[name].FLOAT_READABLE !== false,
  };
}

/**
 * Every rail and its current provider, for the dashboard.
 *
 * Each rail lists every registered provider as an option, with whether it is
 * allowed there and, when it is not, why - so the dashboard can show a barred
 * or incapable provider as unavailable rather than hiding it. `available`
 * carries each provider's credential status by env var name.
 */
async function listProviders() {
  const services = Object.keys(SERVICES);
  const rows = await prisma.appSetting.findMany({
    where: { setting_key: { in: services.map(settingKey) } },
    select: { setting_key: true, setting_value: true },
  });
  const byKey = new Map(rows.map(r => [r.setting_key, r.setting_value]));

  const available = Object.keys(ADAPTERS).map(providerSummary);
  const byName = new Map(available.map(p => [p.name, p]));

  return {
    services: services.map(service => {
      const stored = normalizeProvider(byKey.get(settingKey(service)));
      const effective =
        stored && isAllowed(service, stored) && isProviderConfigured(stored) ? stored : DEFAULT_PROVIDER;
      return {
        service,
        label: SERVICES[service],
        provider: effective,
        // Surfaced so the dashboard can say *why* a rail is not on the provider
        // it was set to, rather than silently showing the fallback as if it had
        // been chosen.
        fallback: Boolean(stored) && stored !== effective,
        stored: stored || null,
        options: Object.keys(ADAPTERS).map(name => ({
          name,
          label: PROVIDER_LABELS[name] || name,
          allowed: isAllowed(service, name),
          configured: byName.get(name).configured,
          reason: notOfferedReason(service, name),
        })),
      };
    }),
    available,
    default: DEFAULT_PROVIDER,
  };
}

module.exports = {
  resolve,
  // The name the multi-provider brief uses for the same thing.
  resolveBillProvider: resolve,
  resolveForRewards,
  getProviderName,
  adapterFor,
  setProvider,
  listProviders,
  isProviderConfigured,
  configStatus,
  isAllowed,
  notOfferedReason,
  isKnownService,
  isKnownProvider,
  SERVICES,
  ADAPTERS,
  PROVIDER_LABELS,
  DEFAULT_PROVIDER,
  ALLOWED,
  BARRED,
  __test: { settingKey, normalizeProvider },
};
