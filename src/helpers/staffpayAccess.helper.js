/**
 * The gate in front of StaffPay's money features.
 *
 * Two independent conditions, both required before a company may add staff,
 * fund its wallet or run payroll:
 *
 *   1. KYB approved      - StaffPayVerification.status === 'approved'
 *   2. Subscription live - a StaffPaySubscription row that is active and has
 *                          not passed expires_at
 *
 * Read-only endpoints (dashboard, company list, bank list) stay open: the app
 * has to be able to render "you are not verified yet" without being locked out
 * of the API that tells it so.
 */
const prisma = require('../../database/prisma');

const PRICE_SETTING_KEY = 'staffpay_subscription_price';
const DEFAULT_PRICE = 150000;

/**
 * Yearly fee in naira. Admin-settable, so it is read per call rather than
 * cached - this runs on a checkout initiate, not on a hot path, and a stale
 * price would charge the wrong amount.
 */
async function getSubscriptionPrice() {
  try {
    const row = await prisma.appSetting.findUnique({
      where: { setting_key: PRICE_SETTING_KEY },
      select: { setting_value: true },
    });
    const value = Number(row?.setting_value);
    if (Number.isFinite(value) && value > 0) return value;
  } catch (e) {
    console.error('staffpay price lookup failed:', e?.message || e);
  }
  return Number(process.env.STAFFPAY_SUBSCRIPTION_PRICE) || DEFAULT_PRICE;
}

async function setSubscriptionPrice(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw new Error('Price must be a positive number');
  await prisma.appSetting.upsert({
    where: { setting_key: PRICE_SETTING_KEY },
    update: { setting_value: String(value) },
    create: {
      setting_key: PRICE_SETTING_KEY,
      setting_value: String(value),
      description: 'StaffPay yearly subscription price (NGN)',
    },
  });
  return value;
}

/** The live subscription for a company, or null. Newest expiry wins. */
async function findActiveSubscription(companyId) {
  if (!prisma.staffPaySubscription) return null;
  return prisma.staffPaySubscription.findFirst({
    where: {
      company_id: Number(companyId),
      status: 'active',
      expires_at: { gt: new Date() },
    },
    orderBy: { expires_at: 'desc' },
  });
}

/**
 * The gate decision itself, with no database in it. Kept pure so the rule
 * "approved AND subscribed" can be tested directly - it is the one line
 * standing between an unverified business and a bulk transfer.
 */
function decideAccess({ verification, subscription }) {
  const verificationStatus = verification?.status || 'not_submitted';
  const approved = verificationStatus === 'approved';
  const subscribed = Boolean(subscription);

  return {
    verification_status: verificationStatus,
    verification_submitted_at: verification?.submitted_at || null,
    decline_reason: verificationStatus === 'declined' ? verification?.decline_reason || null : null,
    subscription_active: subscribed,
    subscription_expires_at: subscription?.expires_at || null,
    can_use_staffpay: approved && subscribed,
  };
}

/**
 * Everything the app needs to decide which StaffPay screen to show.
 * Never throws - a missing model (schema not pushed yet) reads as "not
 * verified" rather than a 500 on the dashboard.
 */
async function getAccessState(companyId) {
  const id = Number(companyId);
  let verification = null;
  try {
    if (prisma.staffPayVerification) {
      verification = await prisma.staffPayVerification.findUnique({ where: { company_id: id } });
    }
  } catch (e) {
    console.error('staffpay verification lookup failed:', e?.message || e);
  }

  const subscription = await findActiveSubscription(id).catch(() => null);

  return decideAccess({ verification, subscription });
}

/**
 * The 403 body for a state that is not allowed through, or null when it is.
 * The app routes off `remark`: telling a lapsed payer to re-apply, or a pending
 * applicant to pay, both send them to a screen that cannot help them.
 */
function denyResponse(state) {
  if (state.can_use_staffpay) return null;

  if (state.verification_status !== 'approved') {
    const message =
      state.verification_status === 'pending'
        ? ['Your StaffPay verification is still under review. Approval usually takes 5-7 working days.']
        : state.verification_status === 'declined'
          ? ['Your StaffPay verification was declined. Please update your documents and re-apply.']
          : ['Complete StaffPay business verification before using this feature.'];

    return { code: 403, body: { remark: 'staffpay_not_verified', status: 'error', message, data: state } };
  }

  return {
    code: 403,
    body: {
      remark: 'staffpay_subscription_required',
      status: 'error',
      message: ['Your StaffPay subscription is not active. Renew to continue running payroll.'],
      data: state,
    },
  };
}

/**
 * Guard for a write route. Returns true when the company may proceed, and has
 * already written the 403 when it may not.
 */
async function requireStaffPayAccess(companyId, res) {
  const denial = denyResponse(await getAccessState(companyId));
  if (!denial) return true;
  res.status(denial.code).json(denial.body);
  return false;
}

module.exports = {
  PRICE_SETTING_KEY,
  DEFAULT_PRICE,
  decideAccess,
  denyResponse,
  getSubscriptionPrice,
  setSubscriptionPrice,
  findActiveSubscription,
  getAccessState,
  requireStaffPayAccess,
};
