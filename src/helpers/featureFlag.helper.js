// Kill switch. One admin call takes a rail offline without a deploy.
//
// The case this exists for: a provider starts double-vending, or a bug is
// draining wallets, and the fix is minutes away but the damage is now. Turning
// the route off is faster than shipping anything, and far less blunt than
// taking the whole API down - airtime can keep selling while transfers are shut.
//
// Flags live in app_settings, so they are already backed up, already visible in
// the admin dashboard, and survive a restart. Cached for FEATURE_FLAG_TTL
// seconds only: a switch that takes ten minutes to take effect is not a kill
// switch. Reference data uses 600s; this deliberately does not.
//
// Reads fail OPEN - if the flag cannot be read, the feature stays on. A cache
// or database blip must not silently close the whole platform, and everything
// downstream of here has its own guards.

const prisma = require('../../database/prisma');
const redis = require('../services/redis.service');

const TTL = Number(process.env.FEATURE_FLAG_TTL_SECONDS || 30);

// Named rather than free-form so a typo in an admin call cannot invent a flag
// that nothing reads, and so the dashboard has a list to render.
const FEATURES = {
  send_money: 'Wallet-to-wallet transfers',
  bills: 'Airtime, data, TV and electricity',
  betting: 'Betting wallet top-ups',
  request_money: 'Request money',
  funding: 'Wallet funding / virtual accounts',
  staffpay_payroll: 'StaffPay payroll runs',
  withdrawals: 'Withdrawals to bank',
  // Conversions only. Paying out cash already converted is `withdrawals`, so a
  // MySubWallet incident can stop new conversions without stranding the money
  // customers are already owed.
  airtime_cash: 'Airtime to Cash conversions',
  // New applications and payments only. Customers already paid can still
  // answer a request for more information and download their certificate.
  cac_registration: 'CAC business name registration',
  // New cards and top-ups only. Freeze, unfreeze, reveal and history never sit
  // behind it - a customer must always be able to stop a card they lost.
  virtual_card: 'USD virtual card - new cards and top-ups',
};

const OFF_VALUES = new Set(['0', 'false', 'off', 'no', 'disabled']);

function settingKey(slug) {
  return `feature_${slug}_enabled`;
}

function isKnownFeature(slug) {
  return Object.prototype.hasOwnProperty.call(FEATURES, String(slug));
}

async function isFeatureEnabled(slug) {
  if (!isKnownFeature(slug)) return true;
  try {
    const value = await redis.cached(redis.key('flag', slug), TTL, async () => {
      const row = await prisma.appSetting.findUnique({
        where: { setting_key: settingKey(slug) },
        select: { setting_value: true },
      });
      // Absent means never switched off. Store the string, not the boolean, so
      // a JSON round-trip through the cache cannot turn it into something else.
      return String(row?.setting_value ?? 'on');
    });
    return !OFF_VALUES.has(String(value ?? 'on').trim().toLowerCase());
  } catch (e) {
    console.warn('featureFlag: read failed, leaving feature enabled', { slug, reason: String(e?.message || e).slice(0, 120) });
    return true;
  }
}

async function setFeature(slug, enabled) {
  if (!isKnownFeature(slug)) {
    const err = new Error(`Unknown feature "${slug}"`);
    err.code = 'UNKNOWN_FEATURE';
    throw err;
  }
  const value = enabled ? 'on' : 'off';
  await prisma.appSetting.upsert({
    where: { setting_key: settingKey(slug) },
    update: { setting_value: value },
    create: { setting_key: settingKey(slug), setting_value: value, description: FEATURES[slug] },
  });
  await redis.del(redis.key('flag', slug));
  return { slug, enabled: Boolean(enabled) };
}

async function listFeatures() {
  const slugs = Object.keys(FEATURES);
  const rows = await prisma.appSetting.findMany({
    where: { setting_key: { in: slugs.map(settingKey) } },
    select: { setting_key: true, setting_value: true },
  });
  const byKey = new Map(rows.map(r => [r.setting_key, r.setting_value]));
  return slugs.map(slug => ({
    slug,
    label: FEATURES[slug],
    enabled: !OFF_VALUES.has(String(byKey.get(settingKey(slug)) ?? 'on').trim().toLowerCase()),
  }));
}

/**
 * Route guard. 503 rather than 403: the feature is not forbidden to this user,
 * it is temporarily unavailable, and the app should say so and let them retry.
 */
function requireFeature(slug) {
  return async function featureGate(req, res, next) {
    if (await isFeatureEnabled(slug)) return next();
    return res.status(503).json({
      remark: 'feature_disabled',
      status: 'error',
      message: ['This service is temporarily unavailable. Please try again shortly.'],
      data: null,
    });
  };
}

module.exports = { isFeatureEnabled, setFeature, listFeatures, requireFeature, FEATURES, __test: { settingKey, OFF_VALUES } };
