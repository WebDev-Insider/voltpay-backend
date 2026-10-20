// Bills payment: airtime, data, TV subscription, electricity.
//
// The flow is two calls, matching the two dialogs in the app:
//
//   POST /bills/quote    price it, stash it, return the summary the
//                        confirmation sheet renders. Nothing is charged.
//   POST /bills/confirm  verify the PIN, reserve the money, dispatch to the
//                        provider, write the ledger. Refunds itself if the
//                        provider rejects.
//
// Pricing rule: for data and TV the client sends an identifier only. The
// amount comes from the provider catalogue on this side. A client-supplied
// price would let anyone buy a 20,000 naira bundle for 100.
//
// **The four rails are served through the provider registry** - see
// funding/billsProvider.js. MySubWallet is the only upstream registered today,
// but nothing below knows which one answered: every provider module exports the
// same surface, and this file goes through `bills.resolve(service)` rather than
// importing one directly. Three rules keep that honest, and they matter the day
// a second provider is registered again:
//
//   1. **Resolve once per request, then carry it.** A quote and its confirm can
//      straddle an admin switch, so re-resolving mid-flow would price against
//      one upstream and vend against the other.
//   2. **The resolved name is stamped into `meta.gateway`.** The webhook and
//      the settlement sweep read that to know who to ask about this row later.
//      A row stamped with the wrong upstream never settles and never refunds.
//   3. **Floors come from the resolved provider, not from a constant.**
//      Providers do not agree on them - past ones started electricity at 100
//      and at 1,000 - and quoting under the live floor reserves a customer's
//      money for a vend that is rejected on arrival.
//
// An electricity token normally comes back on the purchase call, but a vend the
// provider accepts as `pending` has none yet. So a prepaid receipt can
// legitimately settle as "processing" and fill its token in later - from the
// webhook, the receipt poll or the sweep - and the app already polls
// /bills/status for exactly that. A prepaid bill the provider calls delivered
// is still not closed until its token arrives: billSettlement parks it as
// `awaiting_token`, which this file reports as "processing".
const prisma = require('../../database/prisma');
const { Prisma } = require('@prisma/client');
const bills = require('../funding/billsProvider');
const { setPending, getPending, clearPending } = require('../services/pending.service');
const { restampBalance } = require('../helpers/balance.helper');
const { verifySecret, protectText } = require('../helpers/pii.helper');
const { generateTrx } = require('../services/airtime.service');
const { logMoneyEvent } = require('../services/userAudit.service');
const { checkVelocity } = require('../helpers/velocity.helper');
const alerts = require('../services/alerts.service');
const settlement = require('../helpers/billSettlement.helper');
const { reconcile } = require('../helpers/billReconcile.helper');
const { durationBucket, stripDuration, BUCKET_ORDER, BUCKET_LABELS } = require('../funding/planDuration');

// VoltPay's own floors. They sit above the provider's where we want them to and
// are raised to the provider's where the provider is stricter - see minAmountFor.
//
// The 500 on electricity is ours: a meter top-up much under it buys so few
// units that the DISCO's fixed charges eat most of it, and the refund traffic
// from "my token gave me nothing" costs more than the sale. Raise these to
// change what customers see.
const SERVICES = {
  airtime: { remark: 'air_time', dbRemark: 'mobile_recharge', trxPrefix: 'air', title: 'Airtime', minAmount: 100 },
  data: { remark: 'data_bundle', dbRemark: 'mobile_recharge', trxPrefix: 'data', title: 'Data' },
  tv: { remark: 'cable_tv', dbRemark: 'cable_tv', trxPrefix: 'tv', title: 'TV Subscription' },
  electricity: {
    remark: 'electricity',
    dbRemark: 'utility_bill',
    trxPrefix: 'ele',
    title: 'Electricity',
    minAmount: 500,
  },
};

/**
 * The floor a customer actually hits on this rail, right now.
 *
 * Not a constant computed once at module load, because providers disagree -
 * by an order of magnitude on electricity, 100 against 1,000, between two past
 * ones. Pinning the lower would let a customer on the stricter rail be quoted
 * 500, have their wallet debited, and then watch the vend bounce and refund.
 * Pinning the higher would refuse perfectly good 500 naira top-ups on a rail
 * that accepts them.
 */
function minAmountFor(service, provider) {
  const ours = Number(service.minAmount) || 0;
  const theirs = Number(provider?.MIN_AMOUNTS?.[service.key]) || 0;
  return Math.max(ours, theirs);
}

const PENDING_TTL_MS = 5 * 60_000;

function ok(res, remark, message, data = null) {
  return res.json({ remark, status: 'success', message: [message], data });
}

function fail(res, status, remark, message, data = null) {
  return res.status(status).json({ remark, status: 'error', message: [message], data });
}

function moneyStr(n) {
  const num = Number(n);
  return Number.isFinite(num) ? num.toFixed(2) : '0.00';
}

const { normalizeNgPhone } = require('../helpers/phone.helper');

function serviceOf(req) {
  const key = String(req.body?.service || req.params?.service || '').trim().toLowerCase();
  return SERVICES[key] ? { key, ...SERVICES[key] } : null;
}

/* ----------------------------------------------------------- catalogue reads */

// A provider's "Insufficient balance" is about *our* prepaid float, not the
// customer's wallet. Telling a customer with a funded wallet that their balance
// is too low is both wrong and unactionable, so it is swapped for a neutral
// outage message and the incident is pushed at whoever tops the float up.
//
// A misconfiguration - a missing or rejected key, a sandbox key on production,
// one of our own ids refused by their validator - gets the same treatment for
// the same reason: nothing the customer does can fix it, and every purchase on
// the rail is failing until somebody on our side does.
//
// `gateway` names which upstream failed. It is the actionable half of the alert:
// the responder has to know whose float to top up or whose keys to check.
function providerFail(res, e, fallbackMessage, gateway = bills.DEFAULT_PROVIDER) {
  const label = bills.PROVIDER_LABELS[gateway] || gateway;
  if (e?.floatExhausted || e?.misconfigured) {
    alerts.paymentFailure({
      provider: gateway,
      action: e?.floatExhausted ? 'float' : 'config',
      message: e?.floatExhausted
        ? `${label} float exhausted - bill vending is failing`
        : `${label} rejected our configuration - bill vending is failing`,
      // The provider's own words, for the responder. Never the customer's
      // message - it is ours and says nothing - and never a raw body.
      context: { provider_message: String(e?.providerMessage || e?.message || '').slice(0, 200) },
    });
    return fail(res, 503, 'provider_unavailable', 'This service is briefly unavailable. Please try again shortly.');
  }
  // The adapter names its payload after itself so a log line says which
  // provider spoke. It is trimmed to status and message in the adapter: the
  // raw body can carry our float balance, which no customer needs to see.
  const payload = e?.mysubwallet ?? null;
  return fail(res, e?.statusCode || 502, 'provider_error', e?.message || fallbackMessage, payload);
}

// Thin pass-throughs. They are cached inside the provider module, so hammering
// the screen does not hammer the provider, whose rate budget is shared by every
// catalogue read and every vend on the key.
//
// `service` is which rail's switch decides who answers. The client never says -
// it asks for "data providers" and gets whichever upstream is serving data.
function catalogue(service, loader, remark) {
  return async (req, res) => {
    const { name, provider } = await bills.resolve(service);
    try {
      const data = await loader(provider, req);
      return ok(res, remark, 'OK', data);
    } catch (e) {
      return providerFail(res, e, 'Failed to load', name);
    }
  };
}

const airtimeProviders = catalogue('airtime', p => p.listAirtimeProvidersCached(), 'airtime_providers');
const dataProviders = catalogue('data', p => p.listDataProvidersCached(), 'data_providers');
const tvProviders = catalogue('tv', p => p.listTvProvidersCached(), 'tv_providers');
const electricityProviders = catalogue('electricity', p => p.listElectricityDiscosCached(), 'electricity_providers');

// Tabs are by how long the bundle lasts: Daily / Weekly / Monthly / Yearly.
//
// They used to be by plan family (SME, CG, Gifting, Awoof), and the comment here
// used to say a validity split was unbuildable - which was true when it was
// written. A /data-plans row was exactly three fields, plan_id, name and price,
// with no duration anywhere in it, so a Daily/Weekly/Monthly split guessed from
// the name put 97% of MTN's 75 plans in "other": all three tabs were empty on
// every network and the UI hid them.
//
// That is no longer the shape of the data. MySubWallet states the validity in
// every plan name ("750MB GIFTING = ₦194.00 1 Day Special"), and the provider
// module reads it out into `duration_days` and `validity` - so the validity is
// *read* rather than guessed. See funding/planDuration.js, which also holds the
// rule that an unreadable one produces no claim at all. It is the axis the
// customer is actually shopping on, too: "I want a monthly plan" is a sentence
// people say, "I want a CG plan" is not.
//
// The family is not lost, it is demoted. It stays on `plan_type`, it stays
// inside the plan name the tile renders ("1GB (CG)"), and because the catalogue
// arrives price-ascending the cheapest 1GB of the month now sits at the top of
// one list instead of being hidden one tab over.
//
// It also comes back as a filter, from `family_labels` below. Losing it entirely
// was not a fair trade: 30 days is the dominant validity in this market, so
// Monthly inherits most of a 75-plan catalogue and is a longer scroll than any
// family tab was. A filter narrows that without spending the tab bar - which can
// only carry one axis, and validity is the one customers shop on.
const FAMILY_LABELS = {
  SME: 'SME',
  CG: 'CG',
  GIFTING: 'Gifting',
  AWOOF: 'Awoof',
  CORPORATE: 'Corporate',
  DATASHARE: 'Data Share',
};

// Cheapest and highest-traffic families first. This is a display preference, not
// a whitelist - a family a provider adds later is appended rather than dropped,
// so a new tier is on sale the day it appears instead of the day we notice. It
// is also what lets providers name their families however they like without
// losing plans: anything unrecognised sorts to the end and gets a title-cased
// tab rather than disappearing.
const FAMILY_ORDER = ['SME', 'CG', 'GIFTING', 'AWOOF', 'CORPORATE', 'DATASHARE', 'DIRECT'];

// How many of the cheap end lead the picker.
const HOT_PLAN_COUNT = 8;

// How much of a network's catalogue has to carry a readable validity before the
// tabs are built on validity at all.
//
// This guard is the whole reason the first attempt at this screen shipped
// broken. With no duration in the data a validity split produces four tabs the
// UI hides and one "All" nobody can navigate - so the axis is chosen from the
// data rather than assumed. If a rail stops stating duration (a provider
// renaming its plans) or simply has not caught up yet - a Redis catalogue entry
// lives 30 minutes and survives a deploy, so right after a release the cached
// plans may not carry it - the family tabs come back on their own, and the
// validity tabs return on the next catalogue warm.
const VALIDITY_COVERAGE_MIN = 0.6;

function familyKey(planType) {
  return String(planType || '').trim().toUpperCase();
}

function titleCase(key) {
  const s = String(key || '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
}

// Title-case an unrecognised family rather than showing a raw enum to a customer.
function familyLabel(key) {
  return FAMILY_LABELS[key] || titleCase(key);
}

function planDays(plan) {
  const n = Number(plan?.duration_days);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

// Split a shaped plan list into its tabs, and stamp each plan with the tab it is
// in. Pure, and exported for tests: this is the code that decides whether a
// bundle is reachable in the picker at all, and the first version of it failed
// that silently rather than loudly.
function buildPlanTabs(shaped) {
  const plans = Array.isArray(shaped) ? shaped : [];
  const readable = plans.filter(p => planDays(p) > 0).length;
  const byValidity = plans.length > 0 && readable / plans.length >= VALIDITY_COVERAGE_MIN;

  const axis = byValidity
    ? {
        slugOf: p => durationBucket(planDays(p)),
        labelOf: slug => BUCKET_LABELS[slug] || titleCase(slug),
        order: BUCKET_ORDER,
      }
    : {
        slugOf: p => familyKey(p.plan_type).toLowerCase(),
        labelOf: slug => familyLabel(slug.toUpperCase()),
        order: FAMILY_ORDER.map(f => f.toLowerCase()),
      };

  // `category` is assigned here and nowhere else, so it names the tab the plan
  // is actually in by construction. Deciding the two separately is how a plan
  // ends up labelled for a tab it does not appear under.
  const categorised = plans.map(p => ({ ...p, category: axis.slugOf(p) || 'other' }));

  // "Hot" is the cheap, high-traffic end of the catalogue rather than a provider
  // concept - the plans people actually buy on a top-up run. It is a view over
  // the same plans, so each one keeps the category of its real tab.
  const hot = [...categorised].sort((a, b) => Number(a.amount) - Number(b.amount)).slice(0, HOT_PLAN_COUNT);

  // Only the tabs this network actually fills. Neither split is uniform - MTN
  // sells daily, weekly and monthly bundles where a smaller network sells only
  // monthly ones - and a tab with nothing behind it is the thing this whole
  // design exists to remove.
  const present = new Set(categorised.map(p => p.category).filter(slug => slug !== 'other'));
  const keys = [
    ...axis.order.filter(slug => present.has(slug)),
    ...[...present].filter(slug => !axis.order.includes(slug)).sort(),
  ];

  const tabs = { hot };
  const tab_labels = { hot: 'Hot' };
  for (const slug of keys) {
    tabs[slug] = categorised.filter(p => p.category === slug);
    tab_labels[slug] = axis.labelOf(slug);
  }

  // Every family in this catalogue, with a label a customer can read. The app
  // offers these as a secondary filter *inside* a tab, which is what pays back
  // the family tabs the validity axis took away: 30 days is the dominant
  // validity in this market, so Monthly absorbs most of MTN's 75 plans and
  // becomes a longer scroll than any family tab ever was.
  //
  // Sent only when the tabs are validity. When they are already the families,
  // this filter would be the tab bar a second time.
  //
  // No order is sent with it. The filter offers only the families the open tab
  // actually holds - which the app reads off the plans in that tab, so it cannot
  // list a family that would come back empty - and those arrive price-ascending,
  // so first-seen order puts the family with the cheapest plan first.
  const family_labels = {};
  if (byValidity) {
    for (const plan of categorised) {
      const key = familyKey(plan.plan_type);
      if (key && !family_labels[key]) family_labels[key] = familyLabel(key);
    }
  }
  // Last, and always present: a plan whose validity we could not read is still
  // reachable here rather than being silently off sale.
  tabs.all = categorised;
  tab_labels.all = 'All';

  return {
    plans: categorised,
    tabs,
    tab_labels,
    tab_order: ['hot', ...keys, 'all'],
    family_labels,
    // Which axis the tabs were built on. Display-only - the app renders whatever
    // labels it is given - but it is what makes a fallback visible in a log or a
    // bug report instead of looking like the tabs simply changed.
    axis: byValidity ? 'validity' : 'family',
  };
}

// The plan as the customer reads it: the bundle on one line, how long it lasts
// on another. Shared by the picker and the confirmation sheet so the plan a
// customer taps is worded identically to the plan they are asked to pay for.
function displayPlan(plan) {
  return {
    // The validity is shown on its own line, so it must not also be in the
    // name. The provider module already takes it out of the names it hands
    // over; this catches any that still carry it delimited, rather than letting
    // a tile read "Monthly" twice.
    name: stripDuration(plan?.name),
    validity: String(plan?.validity || ''),
    duration_days: planDays(plan),
  };
}

async function dataPlans(req, res) {
  const { name: gateway, provider: upstream } = await bills.resolve('data');
  try {
    const provider = String(req.params?.provider || '').trim().toUpperCase();
    const plans = await upstream.listDataPlansCached(provider);

    // Every plan family a network carries is listed, not just one. The same
    // bundle is priced differently across families - 1GB is cheaper on CG than
    // on SME - so they are not deduplicated, and the family stays in the name
    // ("1GB (CG)") so two same-size bundles are distinguishable in the picker.
    // `plan_type` is the machine-readable form of that; older builds ignore it.
    //
    // `validity` and `duration_days` are the same fact twice: the wording to
    // print, and the number to sort or filter on. Sent separately rather than
    // baked into the name because where a provider writes it is theirs to
    // change - parsed out client-side, the duration would vanish from the tile
    // the day a provider changed their format.
    // `plan_type` is normalised here rather than passed through, because it is
    // a filter key the app matches against `family_labels`, and a filter that
    // matches on case is one provider rename away from returning nothing.
    const shaped = plans.map(p => ({
      id: p.id,
      amount: moneyStr(p.amount),
      plan_type: familyKey(p.plan_type),
      ...displayPlan(p),
    }));

    // The tab set is per network and comes from the catalogue, so the app
    // renders what it is given instead of holding its own list. `category` is
    // stamped in there too, which is why the plans returned here are the ones
    // buildPlanTabs handed back rather than the ones going in.
    const { plans: withCategory, tabs, tab_labels, tab_order, family_labels, axis } = buildPlanTabs(shaped);
    return ok(res, 'data_plans', 'OK', {
      provider,
      plans: withCategory,
      tabs,
      tab_labels,
      tab_order,
      family_labels,
      axis,
    });
  } catch (e) {
    return providerFail(res, e, 'Failed to load plans', gateway);
  }
}

async function tvPackages(req, res) {
  const { name: gateway, provider: upstream } = await bills.resolve('tv');
  try {
    const provider = String(req.params?.provider || '').trim().toUpperCase();
    const packages = await upstream.listTvPackagesCached(provider);
    const shaped = packages.map(p => ({
      id: p.id,
      name: p.name,
      code: p.code,
      amount: moneyStr(p.amount),
    }));
    return ok(res, 'tv_packages', 'OK', { provider, packages: shaped });
  } catch (e) {
    return providerFail(res, e, 'Failed to load packages', gateway);
  }
}

/* -------------------------------------------------------------- validations */

// Smartcard and meter lookups return the customer's name. It goes back to the
// user who asked for it and into the encrypted ledger text, never into a log
// line and never into `meta`.
async function tvValidate(req, res) {
  try {
    const { provider: upstream } = await bills.resolve('tv');
    const provider = String(req.body?.provider || '').trim().toUpperCase();
    const number = String(req.body?.number || '').trim().replace(/\s+/g, '');
    if (!provider || !number) return fail(res, 400, 'validation_error', 'Provider and smartcard number are required');

    const result = await upstream.validateTvSmartcard({ provider, number });
    // Unlike the meter lookup, a TV bouquet lookup can legitimately answer
    // without a name, so a blank one is not treated as a failed verification.
    return ok(res, 'tv_validated', 'Smartcard verified', {
      provider,
      number,
      customer_name: result.customer_name,
    });
  } catch (e) {
    return fail(res, e?.statusCode || 400, 'validation_failed', e?.message || 'Could not verify that smartcard number');
  }
}

async function electricityValidate(req, res) {
  try {
    const { provider: upstream } = await bills.resolve('electricity');
    const provider = String(req.body?.provider || '').trim().toUpperCase();
    const number = String(req.body?.number || '').trim().replace(/\s+/g, '');
    const meterType = upstream.normalizeMeterType(req.body?.meter_type || req.body?.type);
    if (!provider || !number) return fail(res, 400, 'validation_error', 'Provider and meter number are required');

    const result = await upstream.validateElectricityMeter({ provider, number, meterType });
    // A blank name means the biller did not recognise the meter on this type.
    // Passing it through would let the app show a verified meter with no owner.
    if (!result.customer_name) {
      return fail(res, 400, 'validation_failed', `Could not verify that ${meterType} meter number`);
    }
    // `address` is filled for a postpaid meter and usually empty for prepaid.
    // The key is always present because the app's BillCustomer model reads it,
    // and an absent key would break older builds' parsing. Display only - it
    // goes back to the customer who looked their own meter up and nowhere else.
    return ok(res, 'electricity_validated', 'Meter verified', {
      provider,
      number,
      meter_type: meterType,
      customer_name: result.customer_name,
      address: result.address,
    });
  } catch (e) {
    return fail(res, e?.statusCode || 400, 'validation_failed', e?.message || 'Could not verify that meter number');
  }
}

/* -------------------------------------------------------------------- quote */

// Builds the priced payload and parks it in the pending store. Returns exactly
// what the confirmation sheet shows, so the sheet never has to recompute a
// price the server did not agree to.
async function quote(req, res) {
  try {
    const user = req.user;
    if (!user) return fail(res, 401, 'unauthorized', 'Please login first');

    const service = serviceOf(req);
    if (!service) return fail(res, 400, 'validation_error', 'Unknown service');

    const provider = String(req.body?.provider || '').trim().toUpperCase();
    if (!provider) return fail(res, 400, 'validation_error', 'Please select a provider');

    const phone = normalizeNgPhone(req.body?.phone ?? req.body?.number ?? req.body?.mobile_number);
    if (!phone) return fail(res, 400, 'validation_error', 'Enter a valid Nigerian phone number');

    // Resolved once, here, and pinned into the payload. Everything below prices
    // against this upstream, and confirm() dispatches to the same one - a plan
    // id, a package code and a price are all specific to whoever issued them,
    // so re-resolving at confirm time would vend a different product than the
    // one on the sheet the customer approved.
    const { name: gateway, provider: upstream } = await bills.resolve(service.key);
    const minAmount = minAmountFor(service, upstream);

    const payload = {
      gateway,
      service: service.key,
      provider,
      phone_local: phone.local,
      phone_msisdn: phone.msisdn,
    };
    const summary = [];

    if (service.key === 'airtime') {
      const amount = Number(req.body?.amount);
      if (!Number.isFinite(amount) || amount < minAmount) {
        return fail(res, 400, 'validation_error', `Minimum airtime amount is NGN ${minAmount}`);
      }
      // Whole naira only: the provider's validator takes an integer, so 150.50
      // would be reserved from the wallet and then refused on arrival. Said
      // here, before the PIN sheet, rather than as a refund after it.
      if (!Number.isInteger(amount)) {
        return fail(res, 400, 'validation_error', 'Enter a whole naira amount');
      }
      payload.amount = amount;
      payload.item_name = 'Airtime';
      summary.push({ label: 'Network', value: provider });
      summary.push({ label: 'Phone number', value: phone.msisdn });
    }

    if (service.key === 'data') {
      const planId = String(req.body?.plan_id || '').trim();
      if (!planId) return fail(res, 400, 'validation_error', 'Please select a data plan');

      const plans = await upstream.listDataPlansCached(provider);
      const plan = plans.find(p => String(p.id) === planId);
      if (!plan) return fail(res, 400, 'validation_error', 'That data plan is no longer available');

      // Worded exactly as the picker worded it, from the same function. A sheet
      // that renames the plan between tapping it and paying for it is how a
      // customer decides they picked the wrong one.
      const shown = displayPlan(plan);

      payload.plan_id = String(plan.id);
      payload.item_name = shown.name;
      payload.validity = shown.validity;
      payload.amount = Number(plan.amount);
      summary.push({ label: 'Network', value: provider });
      summary.push({ label: 'Phone number', value: phone.msisdn });
      summary.push({ label: 'Plan', value: shown.name });
      // The thing bundle buyers most often get wrong, on the last screen before
      // the money moves. Only when the provider actually stated it: an empty
      // row here would read as "no expiry", which is a promise we cannot keep.
      if (shown.validity) summary.push({ label: 'Valid for', value: shown.validity });
    }

    if (service.key === 'tv') {
      const code = String(req.body?.code || '').trim();
      const smartcard = String(req.body?.smartcard || req.body?.number || '').trim().replace(/\s+/g, '');
      if (!code) return fail(res, 400, 'validation_error', 'Please select a package');
      if (!smartcard) return fail(res, 400, 'validation_error', 'Smartcard / IUC number is required');

      const packages = await upstream.listTvPackagesCached(provider);
      const pkg = packages.find(p => String(p.code) === code);
      if (!pkg) return fail(res, 400, 'validation_error', 'That package is no longer available');

      // Re-verify rather than trust the name the app is holding: the sheet is
      // about to show a customer name, and a stale one is how somebody pays
      // for the wrong decoder.
      let customerName = '';
      try {
        const verified = await upstream.validateTvSmartcard({ provider, number: smartcard });
        customerName = verified.customer_name;
      } catch (e) {
        return fail(res, e?.statusCode || 400, 'validation_failed', e?.message || 'Could not verify that smartcard number');
      }

      payload.code = String(pkg.code);
      payload.item_name = String(pkg.name);
      payload.amount = Number(pkg.amount);
      payload.smartcard = smartcard;
      payload.customer_name = customerName;
      summary.push({ label: 'Provider', value: provider });
      summary.push({ label: 'Smartcard number', value: smartcard });
      if (customerName) summary.push({ label: 'Customer name', value: customerName });
      summary.push({ label: 'Package', value: pkg.name });
      summary.push({ label: 'Phone number', value: phone.msisdn });
    }

    if (service.key === 'electricity') {
      const meterNumber = String(req.body?.meter_number || req.body?.number || '').trim().replace(/\s+/g, '');
      const meterType = upstream.normalizeMeterType(req.body?.meter_type);
      const amount = Number(req.body?.amount);
      if (!meterNumber) return fail(res, 400, 'validation_error', 'Meter number is required');
      if (!Number.isFinite(amount) || amount < minAmount) {
        return fail(res, 400, 'validation_error', `Minimum electricity amount is NGN ${minAmount}`);
      }
      // Whole naira only on this rail. Quoting 1000.50 would debit the wallet
      // for more than the meter is ever credited with.
      if (!Number.isInteger(amount)) {
        return fail(res, 400, 'validation_error', 'Enter a whole naira amount');
      }

      // The lookup's address (postpaid meters have one) is deliberately not
      // kept: nothing after this reads it, and the pending payload sits in
      // Redis, which is held to the same no-plaintext-PII rule as a column.
      let customerName = '';
      try {
        const verified = await upstream.validateElectricityMeter({ provider, number: meterNumber, meterType });
        customerName = verified.customer_name;
      } catch (e) {
        return fail(res, e?.statusCode || 400, 'validation_failed', e?.message || 'Could not verify that meter number');
      }
      if (!customerName) {
        return fail(res, 400, 'validation_failed', `Could not verify that ${meterType} meter number`);
      }

      payload.meter_number = meterNumber;
      payload.meter_type = meterType;
      payload.amount = amount;
      payload.item_name = `${meterType.toUpperCase()} meter`;
      payload.customer_name = customerName;
      summary.push({ label: 'Disco', value: provider });
      summary.push({ label: 'Meter number', value: meterNumber });
      summary.push({ label: 'Meter type', value: meterType === 'postpaid' ? 'Postpaid' : 'Prepaid' });
      if (customerName) summary.push({ label: 'Customer name', value: customerName });
      summary.push({ label: 'Phone number', value: phone.msisdn });
    }

    payload.charge = 0;
    payload.total = payload.amount;

    await setPending(user.id, service.remark, payload, { ttlMs: PENDING_TTL_MS });

    const balance = Number(user.balance?.toString?.() ?? user.balance ?? 0);
    return ok(res, 'bill_quote', 'Confirm your payment', {
      service: service.key,
      title: service.title,
      provider,
      summary,
      amount: moneyStr(payload.amount),
      charge: moneyStr(payload.charge),
      total: moneyStr(payload.total),
      balance: moneyStr(balance),
      sufficient_balance: balance >= payload.total,
      expires_in_seconds: PENDING_TTL_MS / 1000,
    });
  } catch (e) {
    return fail(res, e?.statusCode || 500, 'error', e?.message || 'Could not price this transaction');
  }
}

/* ------------------------------------------------------------------ confirm */

// One dispatcher per rail. Returns whatever the provider gave back so the
// caller can pull a reference or a meter token out of it.
//
// `upstream` is the module the quote was priced against, never a freshly
// resolved one - confirm() takes it from the pending payload's pinned gateway.
// `customerName` is the name the biller's own lookup returned at quote time. It
// is sent back so it appears on the provider's reconciliation against the same
// decoder or meter; it is never written to a log on this side.
async function dispatch(upstream, pending, reference) {
  if (pending.service === 'airtime') {
    return await upstream.buyAirtime({
      provider: pending.provider,
      number: pending.phone_local,
      amount: pending.amount,
      reference,
    });
  }
  if (pending.service === 'data') {
    return await upstream.buyData({
      provider: pending.provider,
      planId: pending.plan_id,
      number: pending.phone_local,
      reference,
    });
  }
  if (pending.service === 'tv') {
    return await upstream.payTv({
      provider: pending.provider,
      number: pending.smartcard,
      code: pending.code,
      customerName: pending.customer_name,
      reference,
    });
  }
  return await upstream.payElectricity({
    provider: pending.provider,
    number: pending.meter_number,
    meterType: pending.meter_type,
    amount: pending.amount,
    customerName: pending.customer_name,
    reference,
  });
}

// The counterparty line. It names a phone number, a meter or a decoder, so it
// is ledger free text and goes through protectText on the way in.
function detailsFor(pending) {
  if (pending.service === 'airtime') return `${pending.provider} Airtime - ${pending.phone_msisdn}`;
  if (pending.service === 'data') {
    // The validity is carried into the ledger line rather than left on the
    // confirmation sheet. It is the answer to "when does this expire", asked a
    // fortnight later against the transaction history, and it is not in the
    // plan name any more - the provider module took it out for the tile.
    const validity = pending.validity ? `, ${pending.validity}` : '';
    return `${pending.provider} Data - ${pending.item_name}${validity} - ${pending.phone_msisdn}`;
  }
  if (pending.service === 'tv') return `${pending.provider} - ${pending.item_name} - ${pending.smartcard}`;
  return `${pending.provider} ${pending.meter_type} - ${pending.meter_number}`;
}

/**
 * Reserve, vend, record - the half of a bill purchase that moves money.
 *
 * Shared by confirm() and the scheduled top-up worker
 * (services/scheduledTopup.service.js), so a standing order is bought exactly
 * the way a tap on the pay button is: the same guarded reserve, the same
 * dispatch, the same refund, the same ledger row. A second copy for the worker
 * would be a second thing to keep correct, and the two would drift the first
 * time either one changed.
 *
 * The caller has already priced it (`pending`, in the shape quote() builds),
 * resolved the upstream it was priced against, and run the checks that belong
 * to it - PIN and expiry for a tap, ownership and KYC for the worker, velocity
 * for both.
 *
 * Returns the outcome instead of throwing it, because each caller handles each
 * one differently:
 *
 *   { outcome: 'insufficient' }                    nothing was reserved
 *   { outcome: 'provider_failed', error, refund }  reserved, refused, refunded
 *   { outcome: 'delivered', processing, ... }      reserved and accepted
 *
 * Anything else - a database failure inside the reserve - propagates.
 *
 * `withinReserve(tx, { trx })` runs inside the reserve transaction, before the
 * debit. The worker uses it to prove it still owns the run it is paying for and
 * to stamp the trx onto that run in the same commit as the ledger row: a throw
 * there rolls the debit back, so a worker that has lost its claim can never
 * move money. `meta` is merged into both ledger writes - ids only, never a
 * name or a number, because `meta` is not encrypted.
 */
async function executePurchase({
  userId,
  service,
  pending,
  gateway,
  upstream,
  req = null,
  meta: extraMeta = null,
  auditExtra = null,
  withinReserve = null,
}) {
  const amount = Number(pending.amount);
  const total = Number(pending.total ?? amount);
  const trx = generateTrx(service.trxPrefix);
  const debit = new Prisma.Decimal(total.toFixed(2));
  const details = detailsFor(pending);
  const extra = extraMeta && typeof extraMeta === 'object' ? extraMeta : {};

  // Step 1 - reserve. The guard is in the SQL (`balance: { gte }`), so two
  // concurrent reserves cannot both pass it - two taps on the pay button, or
  // two of one customer's schedules falling due on two instances in the same
  // minute. A read-then-decrement would let both through. The MAC is restamped
  // after, as for every conditional reserve (CLAUDE.md), and the ledger row is
  // written in the same transaction.
  let reserved;
  try {
    await prisma.$transaction(async tx => {
      if (withinReserve) await withinReserve(tx, { trx });

      const taken = await tx.user.updateMany({
        where: { id: Number(userId), balance: { gte: debit } },
        data: { balance: { decrement: debit } },
      });
      if (!taken?.count) {
        throw Object.assign(new Error('Insufficient balance'), { code: 'INSUFFICIENT' });
      }
      reserved = await restampBalance(tx, 'user', userId);

      await tx.walletTransaction.create({
        data: {
          user_id: Number(userId),
          trx,
          trx_type: '-',
          amount: debit,
          charge: new Prisma.Decimal('0.00'),
          total_amount: debit,
          remark: service.dbRemark,
          details: protectText(details),
          other_data: {
            title: service.title,
            subtitle: protectText(details),
            feedback: 'Processing',
            note: pending.item_name || service.title,
            image_src: '',
          },
          // No name, phone, meter or smartcard here - `meta` is not
          // encrypted. Only provider and reference, which identify the
          // transaction without describing the person.
          //
          // `gateway` is the pinned upstream, never a constant: the webhook
          // and the settlement sweep filter on it to decide who to ask about
          // this row. Stamp the wrong one and this bill never settles and
          // never refunds.
          meta: {
            gateway,
            service: pending.service,
            provider: pending.provider,
            reference: trx,
            bill_status: 'processing',
            // From the first write, not only after the vend: settlement
            // will not close a prepaid bill without its token, and this is
            // how it knows the bill is prepaid - even on a row whose request
            // died before the post-vend update below.
            meter_type: pending.service === 'electricity' ? pending.meter_type : undefined,
            ...extra,
          },
        },
      });
    });
  } catch (e) {
    if (e?.code === 'INSUFFICIENT') return { outcome: 'insufficient', trx };
    throw e;
  }

  // Step 2 - dispatch. Anything that fails from here is refunded, because
  // the money has already left the wallet.
  let providerResponse;
  try {
    providerResponse = await dispatch(upstream, pending, trx);
  } catch (e) {
    const refunded = await refund({ trx, reason: e?.message || '' });
    return { outcome: 'provider_failed', trx, error: e, refund: refunded };
  }

  // One shape for every rail, built in the provider module so the
  // differences between purchase responses stay there.
  const vend = upstream.parseVendResult(providerResponse);
  const providerRef = vend.reference || vend.order_no;
  // Normally here for prepaid electricity, but not on a vend the provider
  // accepted as pending - that one fills in later. Either way the receipt
  // shape is the same before and after.
  const token = vend.token;
  const units = vend.units;

  // A biller that accepted the order but has not delivered it answers
  // "pending". A prepaid meter with no token yet is the same situation said
  // differently, so it stays processing until a token arrives.
  const processing =
    vend.status === 'pending' ||
    vend.status === 'processing' ||
    vend.status === 'initiated' ||
    (pending.service === 'electricity' && pending.meter_type === 'prepaid' && !token);

  // What we debited, against what the upstream actually billed the float. Every
  // rail - MTN, Airtel, Glo and 9mobile, every TV brand, every DISCO - when the
  // field comes back. What differs is what a difference *means*, so the two
  // shapes are read differently:
  //
  //   data / tv   - priced from the catalogue, and the purchase call sends no
  //                 amount at all: the upstream prices it from the plan or
  //                 package id. Our debit and their charge are the same number
  //                 by definition, so any difference is the cached catalogue
  //                 having moved under us.
  //   airtime /   - the customer typed the amount and we send it. The float is
  //   electricity   charged that amount less our reseller commission, so a
  //                 *lower* provider figure is the margin working, not a fault.
  //                 Only an overcharge is worth reporting on these two.
  //
  // Recorded, not acted on. The vend has already succeeded and the customer has
  // already been quoted, so there is nothing to correct on this request, and the
  // 25-minute warm replaces a stale catalogue on its own. Deliberately no alert
  // and no dropCatalogue: if a provider's `amount` is the face value rather than
  // the reseller price, both would fire on every purchase - paging on noise, and
  // dumping a catalogue we just warmed back onto a cold load. Watch
  // `meta.price_drift` on real traffic before turning either on - and watch it
  // per gateway, since providers discount differently.
  let priceDrift = null;
  if (vend.amount > 0) {
    const drift = Number((vend.amount - amount).toFixed(2));
    const cataloguePriced = pending.service === 'data' || pending.service === 'tv';
    // Being billed more than we collected is a loss on any rail. Being billed
    // less only means something where we did not pick the amount ourselves.
    if (drift >= 0.01 || (cataloguePriced && drift <= -0.01)) {
      priceDrift = drift;
      // Provider and service only - no phone, smartcard, meter or name in a log.
      console.warn(
        `⚠️  ${pending.provider} ${pending.service} price drift: quoted ${amount}, billed ${vend.amount}`,
        { trx }
      );
    }
  }

  await prisma.walletTransaction.update({
    where: { trx },
    data: {
      other_data: {
        title: service.title,
        subtitle: protectText(details),
        feedback: processing ? 'Processing' : 'Successful',
        note: pending.item_name || service.title,
        image_src: '',
      },
      meta: {
        gateway,
        service: pending.service,
        // Bill Hero counts weekly purchases on meta.type. Stamped only here,
        // after the provider accepted - a refunded attempt must not earn
        // progress towards a reward.
        type: pending.service,
        provider: pending.provider,
        reference: trx,
        // A webhook only knows the upstream's own reference, so this is the
        // key it joins back on. Losing it strands the electricity token.
        provider_reference: providerRef,
        bill_status: processing ? 'processing' : 'successful',
        meter_type: pending.service === 'electricity' ? pending.meter_type : undefined,
        // Stamped only when the provider billed something other than what we
        // quoted, so the rows carrying these are exactly the ones worth reading.
        provider_amount: priceDrift === null ? undefined : vend.amount,
        price_drift: priceDrift ?? undefined,
        token,
        units,
        ...extra,
      },
    },
  });

  // No meter, smartcard or phone number here - `details` names the customer.
  // The trx is enough to join back to the ledger row that does hold it.
  await logMoneyEvent({
    req,
    userId,
    event: `bill.${service.key}`,
    trx,
    amount: total,
    extra: {
      provider: pending.provider || null,
      provider_reference: providerRef || null,
      status: processing ? 'processing' : 'successful',
      ...(auditExtra && typeof auditExtra === 'object' ? auditExtra : {}),
    },
  });

  return {
    outcome: 'delivered',
    trx,
    processing,
    providerRef,
    token,
    units,
    details,
    postBalance: Number(reserved?.balance?.toString?.() ?? reserved?.balance ?? 0),
  };
}

async function confirm(req, res) {
  try {
    const user = req.user;
    if (!user) return fail(res, 401, 'unauthorized', 'Please login first');

    const service = serviceOf(req);
    if (!service) return fail(res, 400, 'validation_error', 'Unknown service');

    const pin = String(req.body?.pin || '').trim();
    if (!pin) return fail(res, 400, 'validation_error', 'PIN is required');

    // Re-read the user inside the request: req.user can be a cached row and a
    // PIN check must never run against one.
    const freshUser = await prisma.user.findUnique({ where: { id: Number(user.id) } });
    if (!freshUser) return fail(res, 401, 'unauthorized', 'Please login again');

    if (!(await verifySecret(pin, freshUser.pin, 'pin')).ok) {
      return fail(res, 401, 'invalid_pin', 'Invalid PIN');
    }

    const pending = await getPending(user.id, service.remark);
    if (!pending) return fail(res, 400, 'no_pending', 'This payment expired. Please start again.');

    // The quote was priced against one upstream and pinned to it. If an admin
    // has switched this rail in the five minutes since, the quote is dead and
    // the customer re-prices - it is not dispatched to either provider.
    //
    // Sending it to the *new* upstream is the obvious-looking bug: a plan id, a
    // package code and a price all belong to whoever issued them, so one
    // provider's plan id posted to another either bounces or - far worse -
    // matches something else and delivers a bundle nobody agreed to buy. This
    // is also what makes a provider *removal* safe to deploy: a quote stamped
    // with a gateway that no longer exists fails this check and is re-priced.
    //
    // Honouring the *old* pin is the subtler one. It is defensible on price,
    // but the reason an admin flips this switch is that an upstream is
    // misbehaving, and a switch that keeps feeding the broken rail for another
    // five minutes is not a switch you can respond to an incident with.
    //
    // So: reject. The cost is one extra tap on a re-quote, during an incident,
    // for the handful of customers mid-flow. The remark is the same `no_pending`
    // the app has always handled, so no client change is needed.
    const active = await bills.getProviderName(service.key);
    if (pending.gateway !== active) {
      console.warn('bills.confirm: provider switched under a pending quote', {
        user_id: user.id,
        service: service.key,
        quoted: pending.gateway,
        active,
      });
      await clearPending(user.id, service.remark);
      return fail(res, 400, 'no_pending', 'This payment expired. Please start again.');
    }

    const gateway = pending.gateway;
    const upstream = bills.adapterFor(gateway);

    const amount = Number(pending.amount);
    const total = Number(pending.total ?? amount);
    if (!Number.isFinite(total) || total <= 0) {
      return fail(res, 400, 'invalid_amount', 'Invalid amount');
    }

    // Before the reserve, so a rejected payment never touches the balance.
    const velocity = await checkVelocity({ userId: user.id, amount: total });
    if (!velocity.ok) {
      return res.status(429).json({
        remark: 'velocity_limit',
        status: 'error',
        message: [velocity.message],
        data: { reason: velocity.reason, retry_after_minutes: velocity.retryAfterMinutes },
      });
    }

    const result = await executePurchase({ userId: user.id, service, pending, gateway, upstream, req });

    // Nothing was reserved. The quote is left in place so a customer who tops
    // up can pay it inside its five minutes without pricing it again.
    if (result.outcome === 'insufficient') {
      return fail(res, 400, 'insufficient_balance', 'Insufficient balance');
    }

    // Reserved, refused and already refunded inside executePurchase.
    if (result.outcome === 'provider_failed') {
      await clearPending(user.id, service.remark);
      return providerFail(res, result.error, `${service.title} purchase failed`, gateway);
    }

    await clearPending(user.id, service.remark);

    return ok(
      res,
      `${service.key}_success`,
      result.processing
        ? 'Payment is processing. Your token will appear shortly.'
        : `${service.title} purchase successful`,
      {
        service: service.key,
        trx: result.trx,
        provider_reference: result.providerRef,
        amount: moneyStr(amount),
        charge: '0.00',
        total: moneyStr(total),
        post_balance: moneyStr(result.postBalance),
        details: result.details,
        token: result.token,
        units: result.units,
        status: result.processing ? 'processing' : 'successful',
        created_at: new Date().toISOString(),
      }
    );
  } catch (e) {
    console.error('bills.confirm error:', { user_id: req.user?.id, message: e?.message });
    return fail(res, 500, 'error', 'Could not complete this payment');
  }
}

// Give the money back and leave a matching credit row, so the statement shows
// the debit and its reversal rather than a balance that silently healed.
//
// The work itself lives in billSettlement.helper, shared with the webhook. A
// second implementation here would be a second thing to keep correct, and the
// two can fire on the same row - a decline on the confirm call while a "failed"
// webhook is already in flight - so they have to agree on the guard.
async function refund({ trx, reason = 'Provider declined' }) {
  return settlement.settleFailure({ trx, reason });
}

/* ------------------------------------------------------------------- status */

// Receipt refresh. A vend the provider accepted as pending - prepaid electricity
// included, whose token then arrives later - leaves the receipt processing, so
// the receipt screen polls this.
//
// Mostly it just reads the ledger row, which the webhook settles. But a webhook
// that never arrives would leave the row processing forever, so a row that has
// been open long enough is also requeried against the provider that sold it.
// `reconcile` throttles itself; a client polling every second still costs at
// most one provider call per window.
//
// The requery can carry the token as well as the outcome, so a receipt can be
// completed from here even when the webhook is lost.
async function status(req, res) {
  try {
    const user = req.user;
    if (!user) return fail(res, 401, 'unauthorized', 'Please login first');

    const trx = String(req.params?.trx || req.query?.trx || '').trim();
    if (!trx) return fail(res, 400, 'validation_error', 'trx is required');

    let row = await prisma.walletTransaction.findUnique({ where: { trx } });
    // Same 404 for "no such transaction" and "not yours" - the distinction
    // would turn this into a lookup oracle for other people's references.
    if (!row || Number(row.user_id) !== Number(user.id)) {
      return fail(res, 404, 'not_found', 'Transaction not found');
    }

    // Never let a provider hiccup break the receipt: the row on hand is already
    // a valid answer, and the sweep will settle it either way.
    try {
      const outcome = await reconcile(row);
      if (outcome.applied) row = (await prisma.walletTransaction.findUnique({ where: { trx } })) || row;
    } catch {
      /* the ledger row below is still the truth we have */
    }

    const meta = row.meta && typeof row.meta === 'object' ? row.meta : {};
    const otherData = row.other_data && typeof row.other_data === 'object' ? row.other_data : {};

    const reversal = await prisma.walletTransaction.findUnique({ where: { trx: `${trx}_r` } });

    return ok(res, 'bill_status', 'OK', {
      trx,
      service: String(meta.service || ''),
      // Delivered without its token is, to the customer, still processing - and
      // "processing" is the word every installed app keeps polling on. Any other
      // word would end the poll on a receipt with no token.
      bill_status:
        meta.bill_status === settlement.AWAITING_TOKEN ? 'processing' : String(meta.bill_status || ''),
      feedback: String(otherData.feedback || ''),
      token: String(meta.token || ''),
      units: String(meta.units || ''),
      refunded: Boolean(reversal),
    });
  } catch (e) {
    return fail(res, 500, 'error', e?.message || 'Failed to read status');
  }
}

module.exports = {
  airtimeProviders,
  dataProviders,
  dataPlans,
  tvProviders,
  tvPackages,
  tvValidate,
  electricityProviders,
  electricityValidate,
  quote,
  confirm,
  status,
  // The scheduled top-up worker buys through these, so a standing order is
  // priced, floored and paid exactly like a tap on the pay button.
  executePurchase,
  displayPlan,
  minAmountFor,
  SERVICES,
  // exported for tests
  normalizeNgPhone,
  buildPlanTabs,
};
