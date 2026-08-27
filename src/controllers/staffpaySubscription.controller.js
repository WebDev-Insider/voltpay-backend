/**
 * StaffPay yearly subscription.
 *
 * Two ways to pay:
 *
 *   1. VoltPay wallet (payWithWallet) - the default. The money is already
 *      ours, so the debit, the ledger row and the year of access are a single
 *      transaction. No gateway, no webhook, no pending state.
 *   2. Paystack (initiate -> pay -> webhook or verify) - kept for app builds
 *      already in the field. Both confirmations funnel through activate(),
 *      which is idempotent on `status`, so a webhook redelivery cannot hand
 *      out a second year.
 *
 * The price is not a constant here - admin sets it in AppSetting and the amount
 * actually charged is frozen onto the subscription row when it is paid.
 */
const prisma = require('../../database/prisma');
const { Prisma } = require('@prisma/client');
const crypto = require('crypto');

const { initializeTransaction, verifyTransaction, verifyWebhookSignature } = require('../funding/paystack.service');
const { revealUserFields, reveal, verifySecret, protectText } = require('../helpers/pii.helper');
const { applyBalanceDelta } = require('../helpers/balance.helper');
const { revealCompanyFields } = require('../helpers/staffpayPii.helper');
const { generateTrx } = require('../services/airtime.service');
const {
  getSubscriptionPrice,
  findActiveSubscription,
  getAccessState,
} = require('../helpers/staffpayAccess.helper');
const { logStaffPayEvent } = require('../services/staffpayAudit.service');
const { notifyUser } = require('../services/notify.service');
const { ownedCompany } = require('./staffpayVerification.controller');

const SUBSCRIPTION_YEARS = 1;

// A second tap on the pay button arrives within a couple of seconds. Anything
// this side of the window is the same intent, not a deliberate second year.
const DUPLICATE_TAP_WINDOW_MS = 60 * 1000;

function fail(res, status, message, remark = 'validation_error') {
  return res.status(status).json({ remark, status: 'error', message: [message], data: null });
}

function requireModel(res) {
  if (prisma.staffPaySubscription) return true;
  res.status(500).json({
    remark: 'server_error',
    status: 'error',
    message: ['Missing Prisma model StaffPaySubscription. Run prisma generate + db push and restart.'],
    data: null,
  });
  return false;
}

function addYears(from, years) {
  const d = new Date(from);
  d.setFullYear(d.getFullYear() + years);
  return d;
}

/**
 * When the new year of access starts and ends.
 *
 * Renewing before the current year runs out extends from the existing expiry,
 * not from today - otherwise paying early would silently burn the remainder.
 * An expired (or absent) previous subscription starts from the payment.
 */
function computeSubscriptionWindow(paidAt, currentExpiry) {
  const startsAt = currentExpiry && currentExpiry > paidAt ? new Date(currentExpiry) : new Date(paidAt);
  return { startsAt, expiresAt: addYears(startsAt, SUBSCRIPTION_YEARS) };
}

function publicSubscription(row) {
  if (!row) return null;
  return {
    id: row.id,
    company_id: row.company_id,
    reference: row.reference,
    amount: row.amount,
    status: row.status,
    starts_at: row.starts_at,
    expires_at: row.expires_at,
    paid_at: row.paid_at,
  };
}

/** GET /staffpay/subscription/price */
async function getPrice(req, res) {
  try {
    const amount = await getSubscriptionPrice();
    return res.json({
      remark: 'staffpay_subscription_price',
      status: 'success',
      message: ['OK'],
      data: { amount, currency: 'NGN', interval: 'yearly' },
    });
  } catch (e) {
    console.error('staffpay getPrice error:', e?.message || e);
    return fail(res, 500, 'Failed to load subscription price', 'error');
  }
}

/**
 * POST /staffpay/companies/:companyId/subscription/initiate
 * Approved businesses only - paying before approval would have to be refunded.
 */
async function initiateSubscription(req, res) {
  try {
    if (!requireModel(res)) return;

    const user = req.user;
    if (!user) return fail(res, 401, 'Please login first', 'unauthorized');

    const company = await ownedCompany(user.id, req.params?.companyId);
    if (!company) return fail(res, 404, 'Company not found', 'not_found');

    const access = await getAccessState(company.id);
    if (access.verification_status !== 'approved') {
      return fail(res, 403, 'Complete business verification before subscribing', 'staffpay_not_verified');
    }

    const amount = await getSubscriptionPrice();
    const amountKobo = Math.round(amount * 100);

    const email =
      revealUserFields(user).email ||
      (await prisma.staffPayVerification
        .findUnique({ where: { company_id: company.id }, select: { support_email_enc: true } })
        .then(row => (row ? reveal(row.support_email_enc) : ''))
        .catch(() => ''));

    if (!email) return fail(res, 400, 'No email on file to bill. Update your profile and try again.');

    const reference = `SPSUB-${company.id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    const created = await prisma.staffPaySubscription.create({
      data: {
        company_id: company.id,
        user_id: Number(user.id),
        reference,
        amount: new Prisma.Decimal(amount.toFixed(2)),
        status: 'pending',
      },
    });

    const callbackUrl = process.env.STAFFPAY_SUBSCRIPTION_CALLBACK_URL || process.env.PAYSTACK_CALLBACK_URL || undefined;

    const { authorization_url } = await initializeTransaction({
      email,
      amountKobo,
      reference,
      callback_url: callbackUrl,
      metadata: {
        purpose: 'staffpay_subscription',
        company_id: company.id,
        subscription_id: created.id,
        user_id: Number(user.id),
      },
    });

    await logStaffPayEvent({
      userId: user.id,
      event: 'staffpay_subscription_initiated',
      metadata: { company_id: company.id, subscription_id: created.id, amount },
    });

    return res.json({
      remark: 'staffpay_subscription_initiated',
      status: 'success',
      message: ['OK'],
      data: { authorization_url, reference, amount, subscription: publicSubscription(created) },
    });
  } catch (e) {
    console.error('staffpay initiateSubscription error:', e?.message || e);
    return fail(res, Number(e?.statusCode) || 500, e?.message || 'Failed to start subscription payment', 'error');
  }
}

/**
 * POST /staffpay/companies/:companyId/subscription/pay-wallet  { pin }
 *
 * Charge the yearly fee to the owner's VoltPay wallet.
 *
 * Unlike the Paystack path there is nothing to confirm afterwards: the balance
 * guard, the debit, the ledger row and the subscription row are one
 * transaction, so a failure anywhere leaves the wallet untouched and no year of
 * access handed out. The price is read at charge time and frozen onto the row.
 */
async function payWithWallet(req, res) {
  try {
    if (!requireModel(res)) return;

    const user = req.user;
    if (!user) return fail(res, 401, 'Please login first', 'unauthorized');

    const company = await ownedCompany(user.id, req.params?.companyId);
    if (!company) return fail(res, 404, 'Company not found', 'not_found');

    const access = await getAccessState(company.id);
    if (access.verification_status !== 'approved') {
      return fail(res, 403, 'Complete business verification before subscribing', 'staffpay_not_verified');
    }

    const pin = String(req.body?.pin || '').trim();
    if (!pin) return fail(res, 400, 'PIN is required');

    // req.user can be a cached row and a PIN check never runs against one.
    const freshUser = await prisma.user.findUnique({ where: { id: Number(user.id) } });
    if (!freshUser) return fail(res, 401, 'Please login again', 'unauthorized');
    if (!(await verifySecret(pin, freshUser.pin, 'pin')).ok) {
      return fail(res, 401, 'Invalid PIN', 'invalid_pin');
    }

    const amount = await getSubscriptionPrice();
    const debit = new Prisma.Decimal(amount.toFixed(2));
    const zero = new Prisma.Decimal('0.00');
    const trx = generateTrx('spsub');
    const reference = `SPSUBW-${company.id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const companyName = revealCompanyFields(company).name || `company ${company.id}`;
    const details = `StaffPay subscription - ${companyName}`;

    let subscription = null;
    let updatedUser = null;
    let duplicate = false;

    try {
      await prisma.$transaction(async tx => {
        // ponytail: a time window, not a lock. It stops the double tap, which
        // is the case that actually happens. Take a row lock on the company if
        // two devices ever pay for the same business at the same second.
        const recent = await tx.staffPaySubscription.findFirst({
          where: {
            company_id: company.id,
            status: 'active',
            created_at: { gt: new Date(Date.now() - DUPLICATE_TAP_WINDOW_MS) },
          },
          orderBy: { created_at: 'desc' },
        });
        if (recent) {
          subscription = recent;
          duplicate = true;
          return;
        }

        const row = await tx.user.findUnique({ where: { id: Number(user.id) } });
        const balance = Number(row?.balance?.toString?.() ?? row?.balance ?? 0);
        if (!Number.isFinite(balance) || balance < amount) {
          const err = new Error('Insufficient balance');
          err.code = 'INSUFFICIENT';
          throw err;
        }

        updatedUser = await applyBalanceDelta(tx, 'user', user.id, debit.negated());

        const paidAt = new Date();
        const current = await tx.staffPaySubscription.findFirst({
          where: { company_id: company.id, status: 'active', expires_at: { gt: paidAt } },
          orderBy: { expires_at: 'desc' },
        });
        const { startsAt, expiresAt } = computeSubscriptionWindow(paidAt, current?.expires_at || null);

        subscription = await tx.staffPaySubscription.create({
          data: {
            company_id: company.id,
            user_id: Number(user.id),
            reference,
            amount: debit,
            status: 'active',
            paid_at: paidAt,
            starts_at: startsAt,
            expires_at: expiresAt,
            raw_payload: { source: 'wallet', trx },
          },
        });

        await tx.walletTransaction.create({
          data: {
            user_id: Number(user.id),
            trx,
            trx_type: '-',
            amount: debit,
            charge: zero,
            total_amount: debit,
            remark: 'staffpay_subscription',
            details: protectText(details),
            other_data: {
              title: 'StaffPay subscription',
              subtitle: protectText(details),
              feedback: 'Successful',
              note: 'Wallet',
              image_src: '',
            },
            // The company name is PII and `meta` is not encrypted, so only ids
            // and our own references go here.
            meta: {
              source: 'wallet',
              company_id: company.id,
              subscription_id: subscription.id,
              reference,
            },
          },
        });
      });
    } catch (e) {
      if (e?.code === 'INSUFFICIENT') {
        return fail(
          res,
          400,
          'Insufficient wallet balance. Fund your VoltPay wallet and try again.',
          'insufficient_balance'
        );
      }
      throw e;
    }

    if (duplicate) {
      return res.json({
        remark: 'staffpay_subscription_active',
        status: 'success',
        message: ['Subscription is already active'],
        data: { subscription: publicSubscription(subscription) },
      });
    }

    await logStaffPayEvent({
      userId: user.id,
      event: 'staffpay_subscription_activated',
      metadata: {
        company_id: company.id,
        subscription_id: subscription.id,
        amount,
        source: 'wallet',
        expires_at: subscription.expires_at,
      },
    });

    notifyUser({
      userId: Number(user.id),
      subject: 'StaffPay subscription active',
      message: 'Your StaffPay subscription is active. You can now run payroll for your staff.',
      type: 'staffpay',
      data: { company_id: company.id, subscription_id: subscription.id, status: 'active' },
    }).catch(() => {});

    return res.json({
      remark: 'staffpay_subscription_active',
      status: 'success',
      message: ['Subscription activated'],
      data: {
        subscription: publicSubscription(subscription),
        trx,
        post_balance: updatedUser?.balance?.toString?.() ?? null,
      },
    });
  } catch (e) {
    console.error('staffpay payWithWallet error:', e?.message || e);
    return fail(res, Number(e?.statusCode) || 500, e?.message || 'Failed to pay for subscription', 'error');
  }
}

/**
 * Mark a pending subscription paid. Idempotent: a row that is already active is
 * returned untouched, so webhook + client verify racing each other is fine.
 *
 * A renewal bought before the current year runs out extends from the existing
 * expiry, not from today - otherwise paying early would burn the remainder.
 */
async function activate(row, paystackData) {
  if (!row) return null;
  if (row.status === 'active') return row;

  const paidAt = paystackData?.paid_at ? new Date(paystackData.paid_at) : new Date();
  const current = await findActiveSubscription(row.company_id);
  const { startsAt, expiresAt } = computeSubscriptionWindow(paidAt, current?.expires_at || null);

  const updated = await prisma.staffPaySubscription.update({
    where: { id: row.id },
    data: {
      status: 'active',
      paid_at: paidAt,
      starts_at: startsAt,
      expires_at: expiresAt,
      raw_payload: paystackData || undefined,
    },
  });

  await logStaffPayEvent({
    userId: row.user_id,
    event: 'staffpay_subscription_activated',
    metadata: { company_id: row.company_id, subscription_id: row.id, expires_at: updated.expires_at },
  });

  notifyUser({
    userId: row.user_id,
    subject: 'StaffPay subscription active',
    message: 'Your StaffPay subscription is active. You can now run payroll for your staff.',
    type: 'staffpay',
    data: { company_id: row.company_id, subscription_id: row.id, status: 'active' },
  }).catch(() => {});

  return updated;
}

/**
 * POST /staffpay/companies/:companyId/subscription/verify  { reference }
 * The app calls this on returning from the Paystack page. Paystack is the
 * source of truth - the client's word that it paid is never enough.
 */
async function verifySubscription(req, res) {
  try {
    if (!requireModel(res)) return;

    const user = req.user;
    if (!user) return fail(res, 401, 'Please login first', 'unauthorized');

    const company = await ownedCompany(user.id, req.params?.companyId);
    if (!company) return fail(res, 404, 'Company not found', 'not_found');

    const reference = String(req.body?.reference || req.query?.reference || '').trim();
    if (!reference) return fail(res, 400, 'reference is required');

    const row = await prisma.staffPaySubscription.findUnique({ where: { reference } });
    if (!row || row.company_id !== company.id) return fail(res, 404, 'Subscription payment not found', 'not_found');

    if (row.status === 'active') {
      return res.json({
        remark: 'staffpay_subscription_active',
        status: 'success',
        message: ['Subscription is active'],
        data: { subscription: publicSubscription(row) },
      });
    }

    const { data } = await verifyTransaction(reference);
    if (String(data?.status || '').toLowerCase() !== 'success') {
      return fail(res, 400, 'Payment has not been completed', 'payment_pending');
    }

    // Guard against a tampered checkout: the amount that actually landed must
    // cover the price we recorded on the row.
    const expectedKobo = Math.round(Number(row.amount) * 100);
    if (Number(data?.amount) < expectedKobo) {
      await prisma.staffPaySubscription.update({ where: { id: row.id }, data: { status: 'failed', raw_payload: data } });
      return fail(res, 400, 'Amount paid is less than the subscription price', 'amount_mismatch');
    }

    const updated = await activate(row, data);

    return res.json({
      remark: 'staffpay_subscription_active',
      status: 'success',
      message: ['Subscription activated'],
      data: { subscription: publicSubscription(updated) },
    });
  } catch (e) {
    console.error('staffpay verifySubscription error:', e?.message || e);
    return fail(res, Number(e?.statusCode) || 500, e?.message || 'Failed to verify subscription payment', 'error');
  }
}

/**
 * POST /staffpay/subscription/webhook
 * Unauthenticated by design - the HMAC signature is the authentication.
 * Always 200 on anything we recognise but cannot act on, so Paystack does not
 * retry forever on a reference that was never ours.
 */
async function webhook(req, res) {
  try {
    const signature = req.headers['x-paystack-signature'];
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));

    if (!verifyWebhookSignature({ rawBody, signature })) {
      console.warn('staffpay subscription webhook: bad signature');
      return res.status(401).json({ status: 'error', message: ['Invalid signature'] });
    }

    const event = String(req.body?.event || '');
    const data = req.body?.data || {};
    const reference = String(data?.reference || '').trim();

    if (event !== 'charge.success' || !reference.startsWith('SPSUB-')) {
      return res.json({ status: 'success', message: ['Ignored'] });
    }

    const row = await prisma.staffPaySubscription.findUnique({ where: { reference } });
    if (!row) {
      console.warn('staffpay subscription webhook: unknown reference');
      return res.json({ status: 'success', message: ['Unknown reference'] });
    }

    const expectedKobo = Math.round(Number(row.amount) * 100);
    if (Number(data?.amount) < expectedKobo) {
      await prisma.staffPaySubscription.update({ where: { id: row.id }, data: { status: 'failed', raw_payload: data } });
      return res.json({ status: 'success', message: ['Underpaid'] });
    }

    await activate(row, data);
    return res.json({ status: 'success', message: ['OK'] });
  } catch (e) {
    console.error('staffpay subscription webhook error:', e?.message || e);
    return res.status(500).json({ status: 'error', message: ['Webhook failed'] });
  }
}

/** GET /staffpay/companies/:companyId/subscription */
async function getSubscription(req, res) {
  try {
    if (!requireModel(res)) return;

    const user = req.user;
    if (!user) return fail(res, 401, 'Please login first', 'unauthorized');

    const company = await ownedCompany(user.id, req.params?.companyId);
    if (!company) return fail(res, 404, 'Company not found', 'not_found');

    const [active, price, access] = await Promise.all([
      findActiveSubscription(company.id),
      getSubscriptionPrice(),
      getAccessState(company.id),
    ]);

    return res.json({
      remark: 'staffpay_subscription',
      status: 'success',
      message: ['OK'],
      data: { subscription: publicSubscription(active), price, access },
    });
  } catch (e) {
    console.error('staffpay getSubscription error:', e?.message || e);
    return fail(res, 500, 'Failed to load subscription', 'error');
  }
}

module.exports = {
  getPrice,
  getSubscription,
  payWithWallet,
  initiateSubscription,
  verifySubscription,
  webhook,
  computeSubscriptionWindow,
  SUBSCRIPTION_YEARS,
};
