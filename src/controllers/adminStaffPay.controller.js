// Admin half of StaffPay: the KYB review queue, the subscription price, and a
// read-only view of every company on the platform.
//
// Mounted under /api/admin behind adminAuth.middleware, so nothing here reads
// req.user. `reviewed_by` comes from the authenticated admin (req.admin.name).
// A body-supplied reviewed_by is still accepted for the static-key callers that
// have no identity of their own, but a real signed-in admin cannot be
// impersonated by one: their own name wins.
const prisma = require('../../database/prisma');
const { reveal } = require('../helpers/pii.helper');
const { revealCompanyFields, revealStaffFields, publicPayrollRun } = require('../helpers/staffpayPii.helper');
const { readHeartbeat } = require('../services/staffpayScheduler.service');
const { strandedAfterMs } = require('../services/staffpayPayroll.service');
const { getSubscriptionPrice, setSubscriptionPrice, findActiveSubscription } = require('../helpers/staffpayAccess.helper');
const { publicVerification } = require('./staffpayVerification.controller');
const { logStaffPayEvent } = require('../services/staffpayAudit.service');
const { notifyUser } = require('../services/notify.service');
const { sendStaffPayVerificationEmail } = require('../services/email.service');

const REVIEW_STATUSES = new Set(['approved', 'declined', 'pending']);
const RUN_STATUSES = new Set(['preparing', 'queued', 'processing', 'successful', 'partial', 'failed']);

function fail(res, message, remark = 'validation_error', code = 200) {
  return res.status(code).json({ remark, status: 'error', message: [message], data: null });
}

function ok(res, data, message = 'OK', remark = 'staffpay') {
  return res.json({ remark, status: 'success', message: [message], data });
}

/**
 * How the year was paid for.
 *
 * `raw_payload.source` is stamped by the wallet path; the reference prefix is
 * the fallback for a row whose payload was never written. Anything else came
 * through the gateway - support needs to know which one before they go looking
 * for a Paystack transaction that does not exist.
 */
function subscriptionSource(row) {
  if (row?.raw_payload?.source === 'wallet') return 'wallet';
  if (String(row?.reference || '').startsWith('SPSUBW-')) return 'wallet';
  return 'paystack';
}

/** The subscription block, identical on the company page and the KYB review. */
function adminSubscription(row) {
  if (!row) return null;
  return {
    status: row.status,
    amount: row.amount,
    expires_at: row.expires_at,
    paid_at: row.paid_at,
    reference: row.reference,
    source: subscriptionSource(row),
  };
}

/** GET /admin/staffpay/verifications?status=pending&page=1 */
async function listVerifications(req, res) {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
    const perPage = Math.min(Math.max(parseInt(req.query.perPage || '20', 10) || 20, 1), 100);

    const status = String(req.query.status || '').trim().toLowerCase();
    const where = REVIEW_STATUSES.has(status) ? { status } : {};

    const [total, rows, counts] = await Promise.all([
      prisma.staffPayVerification.count({ where }),
      prisma.staffPayVerification.findMany({
        where,
        orderBy: { submitted_at: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
        include: { company: { select: { id: true, owner_user_id: true, created_at: true } } },
      }),
      prisma.staffPayVerification.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);

    const byStatus = { pending: 0, approved: 0, declined: 0 };
    for (const row of counts) byStatus[row.status] = row._count._all;

    return ok(
      res,
      {
        items: rows.map(row => ({
          ...publicVerification(row, { forAdmin: true }),
          owner_user_id: row.company?.owner_user_id ?? null,
        })),
        counts: byStatus,
        pagination: { page, perPage, total, totalPages: Math.max(Math.ceil(total / perPage), 1) },
      },
      'StaffPay verifications',
      'staffpay_verifications',
    );
  } catch (error) {
    console.error('adminStaffPay.listVerifications failed:', error?.message || error);
    return fail(res, 'Failed to load verifications', 'error', 500);
  }
}

/** GET /admin/staffpay/verifications/:id */
async function getVerification(req, res) {
  try {
    const id = Number(req.params.id);
    if (!id) return fail(res, 'Invalid verification id');

    const row = await prisma.staffPayVerification.findUnique({
      where: { id },
      include: { company: { include: { wallet: true, _count: { select: { staff: true } } } } },
    });
    if (!row) return fail(res, 'Verification not found', 'not_found', 404);

    const subscription = await findActiveSubscription(row.company_id);

    return ok(
      res,
      {
        verification: publicVerification(row, { forAdmin: true }),
        company: {
          id: row.company.id,
          owner_user_id: row.company.owner_user_id,
          staff_count: row.company._count?.staff ?? 0,
          wallet_balance: row.company.wallet?.balance ?? '0.00',
          created_at: row.company.created_at,
        },
        subscription: adminSubscription(subscription),
      },
      'StaffPay verification',
      'staffpay_verification',
    );
  } catch (error) {
    console.error('adminStaffPay.getVerification failed:', error?.message || error);
    return fail(res, 'Failed to load the verification', 'error', 500);
  }
}

/**
 * PATCH /admin/staffpay/verifications/:id
 * { status, decline_reason?, admin_notes?, reviewed_by? }
 *
 * A decline must carry a reason - the email quotes it back verbatim and
 * "declined, no reason" is what generates a support ticket.
 */
async function reviewVerification(req, res) {
  try {
    const id = Number(req.params.id);
    if (!id) return fail(res, 'Invalid verification id');

    const status = String(req.body?.status || '').trim().toLowerCase();
    if (!REVIEW_STATUSES.has(status)) {
      return fail(res, `status must be one of: ${[...REVIEW_STATUSES].join(', ')}`);
    }

    const declineReason = String(req.body?.decline_reason || '').trim();
    if (status === 'declined' && !declineReason) return fail(res, 'A decline reason is required');

    const row = await prisma.staffPayVerification.findUnique({
      where: { id },
      include: { company: { select: { id: true, owner_user_id: true } } },
    });
    if (!row) return fail(res, 'Verification not found', 'not_found', 404);

    // A signed-in admin names themselves; only an anonymous static key falls
    // back to whatever the caller claims.
    const reviewedBy = String(
      (req.admin?.source === 'session' && req.admin.name) || req.body?.reviewed_by || req.headers['x-admin-user'] || 'admin'
    ).trim();
    const adminNotes = req.body?.admin_notes !== undefined ? String(req.body.admin_notes).trim() : row.admin_notes;

    const updated = await prisma.staffPayVerification.update({
      where: { id },
      data: {
        status,
        decline_reason: status === 'declined' ? declineReason : null,
        admin_notes: adminNotes || null,
        reviewed_by: reviewedBy,
        reviewed_at: new Date(),
      },
    });

    await logStaffPayEvent({
      userId: row.company.owner_user_id,
      event: `staffpay_verification_${status}`,
      metadata: { company_id: row.company_id, verification_id: id, reviewed_by: reviewedBy },
    });

    // Only a decision is worth an email. Moving a row back to pending is an
    // internal correction and must not tell the business anything.
    if (status !== 'pending') {
      const supportEmail = reveal(row.support_email_enc);
      const tradingName = reveal(row.trading_name_enc);

      if (supportEmail) {
        sendStaffPayVerificationEmail({
          to: supportEmail,
          status,
          companyName: tradingName,
          reason: declineReason,
        }).catch(e => console.error('staffpay review email failed', { verification_id: id, error: e?.message || e }));
      }

      notifyUser({
        userId: row.company.owner_user_id,
        subject: status === 'approved' ? 'StaffPay verification approved' : 'StaffPay verification declined',
        message:
          status === 'approved'
            ? 'Your business is verified. Activate your StaffPay subscription to start running payroll.'
            : `Your StaffPay verification was declined. ${declineReason}`,
        type: 'staffpay',
        data: { company_id: row.company_id, verification_id: id, status },
      }).catch(() => {});
    }

    return ok(res, { verification: publicVerification(updated, { forAdmin: true }) }, `Verification ${status}`, 'staffpay_verification');
  } catch (error) {
    console.error('adminStaffPay.reviewVerification failed:', error?.message || error);
    return fail(res, 'Failed to update the verification', 'error', 500);
  }
}

/** GET /admin/staffpay/price */
async function getPrice(req, res) {
  try {
    return ok(res, { amount: await getSubscriptionPrice(), currency: 'NGN', interval: 'yearly' }, 'OK', 'staffpay_price');
  } catch (error) {
    console.error('adminStaffPay.getPrice failed:', error?.message || error);
    return fail(res, 'Failed to load the price', 'error', 500);
  }
}

/** PATCH /admin/staffpay/price  { amount } - applies to every new subscription. */
async function updatePrice(req, res) {
  try {
    const amount = await setSubscriptionPrice(req.body?.amount);
    return ok(res, { amount, currency: 'NGN', interval: 'yearly' }, 'Price updated', 'staffpay_price');
  } catch (error) {
    console.error('adminStaffPay.updatePrice failed:', error?.message || error);
    return fail(res, error?.message || 'Failed to update the price');
  }
}

/**
 * GET /admin/staffpay/companies
 * Platform-wide list: balance, staff count, payday, and how the last payroll
 * went. Staff details are deliberately not included here - they are one more
 * request away, on the company page.
 */
async function listCompanies(req, res) {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
    const perPage = Math.min(Math.max(parseInt(req.query.perPage || '20', 10) || 20, 1), 100);

    const [total, rows] = await Promise.all([
      prisma.staffPayCompany.count(),
      prisma.staffPayCompany.findMany({
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
        include: {
          wallet: true,
          verification: { select: { status: true } },
          _count: { select: { staff: true } },
          payrollRuns: { orderBy: { created_at: 'desc' }, take: 1 },
        },
      }),
    ]);

    return ok(
      res,
      {
        items: rows.map(row => ({
          id: row.id,
          owner_user_id: row.owner_user_id,
          name: revealCompanyFields(row).name,
          verification_status: row.verification?.status || 'not_submitted',
          wallet_balance: row.wallet?.balance ?? '0.00',
          staff_count: row._count?.staff ?? 0,
          payout_time: row.payout_time,
          low_balance_threshold: row.low_balance_threshold,
          last_payroll_at: row.payrollRuns[0]?.created_at || null,
          last_payroll_status: row.payrollRuns[0]?.status || null,
        })),
        pagination: { page, perPage, total, totalPages: Math.max(Math.ceil(total / perPage), 1) },
      },
      'StaffPay companies',
      'staffpay_companies',
    );
  } catch (error) {
    console.error('adminStaffPay.listCompanies failed:', error?.message || error);
    return fail(res, 'Failed to load companies', 'error', 500);
  }
}

/** GET /admin/staffpay/companies/:id - staff roster and payday settings. */
async function getCompany(req, res) {
  try {
    const id = Number(req.params.id);
    if (!id) return fail(res, 'Invalid company id');

    const company = await prisma.staffPayCompany.findUnique({
      where: { id },
      include: {
        wallet: true,
        verification: true,
        staff: { orderBy: { id: 'desc' } },
        payrollRuns: { orderBy: { created_at: 'desc' }, take: 5 },
      },
    });
    if (!company) return fail(res, 'Company not found', 'not_found', 404);

    const subscription = await findActiveSubscription(id);
    const companyPii = revealCompanyFields(company);

    return ok(
      res,
      {
        company: {
          id: company.id,
          owner_user_id: company.owner_user_id,
          // Opened for this admin view only; the columns themselves stay
          // encrypted and nothing here is logged.
          name: companyPii.name,
          email: companyPii.email,
          phone: companyPii.phone,
          address: companyPii.address,
          payout_time: company.payout_time,
          payout_timezone: company.payout_timezone,
          low_balance_threshold: company.low_balance_threshold,
          wallet_balance: company.wallet?.balance ?? '0.00',
          created_at: company.created_at,
        },
        verification: publicVerification(company.verification, { forAdmin: true }),
        subscription: adminSubscription(subscription),
        // account_number_enc is not decrypted here: an admin list has no reason
        // to show a full bank account number, and last4 identifies the row.
        staff: company.staff.map(s => {
          const pii = revealStaffFields(s);

          return {
            id: s.id,
            full_name: pii.full_name,
            // The app collects a job title now. `phone` is only still here for
            // rows captured before that change.
            role: s.role,
            phone: pii.phone,
            account_name: pii.account_name,
            bank_name: s.bank_name,
            account_number_last4: s.account_number_last4,
            salary_amount: s.salary_amount,
            payment_day: s.payment_day,
            is_active: s.is_active,
            last_paid_at: s.last_paid_at,
          };
        }),
        recent_payrolls: company.payrollRuns.map(r => ({
          id: r.id,
          title: r.title,
          status: r.status,
          total_debit: r.total_debit,
          created_at: r.created_at,
        })),
      },
      'StaffPay company',
      'staffpay_company',
    );
  } catch (error) {
    console.error('adminStaffPay.getCompany failed:', error?.message || error);
    return fail(res, 'Failed to load the company', 'error', 500);
  }
}

/**
 * GET /admin/staffpay/payroll-runs?mode=auto&status=partial&company_id=3
 *
 * Every payout the platform has made, with the one column support always asks
 * for first: was this a payday or somebody pressing a button.
 */
async function listPayrollRuns(req, res) {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
    const perPage = Math.min(Math.max(parseInt(req.query.perPage || '20', 10) || 20, 1), 100);

    const mode = String(req.query.mode || '').trim().toLowerCase();
    const status = String(req.query.status || '').trim().toLowerCase();
    const companyId = Number(req.query.company_id) || null;

    const where = {
      ...(mode === 'auto' || mode === 'manual' ? { mode } : {}),
      ...(RUN_STATUSES.has(status) ? { status } : {}),
      ...(companyId ? { company_id: companyId } : {}),
    };

    const [total, rows, byStatus] = await Promise.all([
      prisma.staffPayPayrollRun.count({ where }),
      prisma.staffPayPayrollRun.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
        include: {
          company: { select: { id: true, owner_user_id: true, name_enc: true } },
          _count: { select: { items: true } },
        },
      }),
      prisma.staffPayPayrollRun.groupBy({ by: ['status'], where, _count: { _all: true } }),
    ]);

    // One query for the failure count of the page rather than pulling every
    // item row: a 300-staff run would otherwise ship 300 rows to a list screen.
    const failedByRun = rows.length
      ? await prisma.staffPayPayrollItem.groupBy({
        by: ['payroll_run_id'],
        where: { payroll_run_id: { in: rows.map(r => r.id) }, status: 'FAILED' },
        _count: { _all: true },
      })
      : [];
    const failedCounts = new Map(failedByRun.map(r => [r.payroll_run_id, r._count._all]));

    return ok(
      res,
      {
        items: rows.map(row => ({
          id: row.id,
          company_id: row.company_id,
          company_name: revealCompanyFields(row.company).name,
          title: row.title,
          status: row.status,
          mode: row.mode,
          triggered_by_user_id: row.triggered_by_user_id,
          total_debit: row.total_debit,
          total_salary: row.total_salary,
          staff_count: row._count?.items ?? 0,
          failed_count: failedCounts.get(row.id) || 0,
          auto_retry_count: row.auto_retry_count,
          next_retry_at: row.next_retry_at,
          created_at: row.created_at,
        })),
        counts: byStatus.reduce((acc, r) => ({ ...acc, [r.status]: r._count._all }), {}),
        pagination: { page, perPage, total, totalPages: Math.max(Math.ceil(total / perPage), 1) },
      },
      'StaffPay payroll runs',
      'staffpay_payroll_runs',
    );
  } catch (error) {
    console.error('adminStaffPay.listPayrollRuns failed:', error?.message || error);
    return fail(res, 'Failed to load payroll runs', 'error', 500);
  }
}

/** GET /admin/staffpay/payroll-runs/:id - the run and every transfer in it. */
async function getPayrollRun(req, res) {
  try {
    const id = Number(req.params.id);
    if (!id) return fail(res, 'Invalid payroll run id');

    const run = await prisma.staffPayPayrollRun.findUnique({
      where: { id },
      include: {
        company: true,
        items: { include: { staff: true }, orderBy: { id: 'asc' } },
      },
    });
    if (!run) return fail(res, 'Payroll run not found', 'not_found', 404);

    // publicPayrollRun drops the ciphertext columns and the provider payload -
    // an admin screen has no more business holding a staff account number than
    // the app does.
    return ok(res, { payroll_run: publicPayrollRun(run) }, 'StaffPay payroll run', 'staffpay_payroll_run');
  } catch (error) {
    console.error('adminStaffPay.getPayrollRun failed:', error?.message || error);
    return fail(res, 'Failed to load the payroll run', 'error', 500);
  }
}

/**
 * GET /admin/staffpay/scheduler - is automatic payroll actually alive?
 *
 * The heartbeat is written by the scheduler on every tick. If it is missing or
 * older than a few minutes, nobody is running payday and that has to be visible
 * before a business calls to say their staff were not paid.
 */
async function schedulerStatus(req, res) {
  try {
    const heartbeat = await readHeartbeat();
    const lastTickAt = heartbeat?.at ? new Date(heartbeat.at) : null;
    const ageSeconds = lastTickAt ? Math.round((Date.now() - lastTickAt.getTime()) / 1000) : null;
    const intervalMs = Number(heartbeat?.tick_interval_ms) || 60_000;
    // Three missed ticks. One late tick is a slow payroll holding the loop, not
    // an outage - the loop is single-flight by design.
    const healthy = ageSeconds != null && ageSeconds * 1000 < intervalMs * 3;

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    // Runs left mid-flight by a dead process. The sweep picks them up on the
    // next tick, so a non-zero number that stays non-zero is the thing to look at.
    const strandedCutoff = new Date(Date.now() - strandedAfterMs());
    const [autoRuns24h, manualRuns24h, inFlight, awaitingRetry, stranded] = await Promise.all([
      prisma.staffPayPayrollRun.count({ where: { mode: 'auto', created_at: { gte: since } } }),
      prisma.staffPayPayrollRun.count({ where: { mode: 'manual', created_at: { gte: since } } }),
      prisma.staffPayPayrollRun.count({ where: { status: { in: ['preparing', 'queued', 'processing'] } } }),
      prisma.staffPayPayrollRun.count({ where: { next_retry_at: { not: null, lte: new Date() } } }),
      prisma.staffPayPayrollRun.count({
        where: {
          status: { in: ['preparing', 'processing'] },
          updated_at: { lt: strandedCutoff },
          items: { some: { status: { in: ['NEW', 'PENDING'] } } },
        },
      }),
    ]);

    return ok(
      res,
      {
        healthy,
        last_tick_at: heartbeat?.at || null,
        last_tick_age_seconds: ageSeconds,
        instance: heartbeat?.instance || null,
        autopay_enabled: heartbeat?.autopay_enabled ?? null,
        companies_scanned_last_tick: heartbeat?.companies_scanned ?? null,
        runs_created_last_tick: heartbeat?.runs_created ?? null,
        auto_runs_24h: autoRuns24h,
        manual_runs_24h: manualRuns24h,
        runs_in_flight: inFlight,
        runs_awaiting_retry: awaitingRetry,
        runs_stranded: stranded,
      },
      'StaffPay scheduler status',
      'staffpay_scheduler',
    );
  } catch (error) {
    console.error('adminStaffPay.schedulerStatus failed:', error?.message || error);
    return fail(res, 'Failed to load scheduler status', 'error', 500);
  }
}

module.exports = {
  listPayrollRuns,
  getPayrollRun,
  schedulerStatus,
  listVerifications,
  getVerification,
  reviewVerification,
  getPrice,
  updatePrice,
  listCompanies,
  getCompany,
  subscriptionSource,
};
