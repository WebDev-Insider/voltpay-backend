/**
 * The payroll engine. One copy, called by both the HTTP controller and the
 * scheduler - they used to hold two near-identical copies of this logic, which
 * is how the two drifted apart on fee handling.
 *
 * Money rules that must not be relaxed:
 *   - Nothing is disbursed unless the wallet covers the whole run. The check is
 *     an `updateMany` with `balance: { gte }` so two concurrent runs cannot both
 *     pass it, followed by restampBalance() (see CLAUDE.md).
 *   - Every naira that leaves the wallet is either in a live transfer or has
 *     been refunded. An item that fails, reverses, or never reaches Paystack is
 *     credited back exactly once, guarded by `refunded_at`.
 *   - Each item carries its own reference, so a webhook, a poll and a retry all
 *     address exactly one row.
 */
const prisma = require('../../database/prisma');
const { Prisma } = require('@prisma/client');
const crypto = require('crypto');

const {
  createTransferRecipient,
  initiateTransfer,
  verifyTransfer,
  transferFeeNaira,
} = require('../funding/paystack.service');

const { applyBalanceDelta, restampBalance } = require('../helpers/balance.helper');
const { withDirectFallback } = require('../helpers/prismaDirect.helper');
const { revealCompanyFields, revealStaffFields } = require('../helpers/staffpayPii.helper');
const { decryptString } = require('../helpers/encryption.helper');
const { logStaffPayEvent } = require('./staffpayAudit.service');
const { paymentFailure, captureError } = require('./alerts.service');
const { isFeatureEnabled } = require('../helpers/featureFlag.helper');

const ZERO = new Prisma.Decimal('0.00');

/**
 * Provider failures split in two, and only one of them is the business's
 * problem. A wrong account number is theirs to fix, so that reason is shown as
 * the bank wrote it. Everything else here is about VoltPay's own Paystack
 * account - an empty payout float, transfers not enabled, OTP still switched
 * on - and telling a school owner "your balance is not enough" when their
 * wallet is funded and already refunded is both false and alarming.
 *
 * The raw string is never lost: it stays on `raw_payload` for support.
 */
const MERCHANT_SIDE_FAILURE = [
  /balance is not enough/i,
  /insufficient (balance|funds)/i,
  /transfer(s)? (is |are )?(not enabled|disabled|unavailable)/i,
  /cannot (initiate|start) transfer/i,
  /starter business/i,
  /otp/i,
];

const MERCHANT_SIDE_MESSAGE =
  'Payouts are temporarily unavailable. Your wallet was not debited - please try again shortly.';

// Returns null for an empty reason, so a successful item is not labelled with
// a failure it did not have.
function friendlyFailureReason(raw) {
  const message = String(raw || '').trim();
  if (!message) return null;
  return MERCHANT_SIDE_FAILURE.some(re => re.test(message)) ? MERCHANT_SIDE_MESSAGE : message;
}

/**
 * Unattended retry of failed transfers.
 *
 * Safe to repeat because a failed item is refunded before it is retried and
 * re-reserved when it is - the money is never in two places. The ceiling is what
 * stops a permanently bad account number (closed, wrong bank) from being retried
 * forever; after it, the run waits for the manual retry button.
 *
 * 5 min, then 20, then 80 - long enough that a provider outage has a chance to
 * end between attempts.
 */
function maxAutoRetries() {
  // `Number('')` is 0, so the unset case has to be caught before the parse or
  // an unconfigured deployment silently gets no retries at all.
  const raw = String(process.env.STAFFPAY_MAX_AUTO_RETRIES || '').trim();
  if (!raw) return 3;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

function retryBackoffMs(attemptsSoFar) {
  const base = Number(process.env.STAFFPAY_RETRY_BASE_MS) || 5 * 60_000;
  const cap = Number(process.env.STAFFPAY_RETRY_MAX_MS) || 6 * 60 * 60_000;
  return Math.min(cap, base * 4 ** Math.max(0, Number(attemptsSoFar) || 0));
}

function vatRate() {
  // `Number('')` is 0, so an unset variable has to be caught before the parse
  // or the run reserves no VAT at all.
  const raw = String(process.env.STAFFPAY_VAT_RATE || '').trim();
  if (!raw) return 0.075;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0.075;
}

function money(value) {
  try {
    return new Prisma.Decimal(new Prisma.Decimal(value || 0).toFixed(2));
  } catch {
    return ZERO;
  }
}

// VoltPay's own margin: 1% of salary, floored at ₦20 and capped at ₦200.
function voltpayFee(amount) {
  const fee = money(new Prisma.Decimal(amount || 0).mul('0.01'));
  const min = new Prisma.Decimal('20.00');
  const cap = new Prisma.Decimal('200.00');
  if (fee.lt(min)) return min;
  if (fee.gt(cap)) return cap;
  return fee;
}

function feesFor(amount) {
  const salary = money(amount);
  const provider = money(transferFeeNaira(Number(salary.toString())));
  const volt = voltpayFee(salary);
  const vat = money(new Prisma.Decimal(vatRate().toString()).mul(provider.plus(volt)));
  return { salary, provider, volt, vat, total: salary.plus(provider).plus(volt).plus(vat) };
}

function itemCost(item) {
  return money(item.amount)
    .plus(money(item.provider_fee))
    .plus(money(item.voltpay_fee))
    .plus(money(item.vat));
}

/**
 * May this submit failure refund the wallet?
 *
 * Only a rejection may. A timeout or a Paystack 5xx leaves it unknown whether
 * the transfer exists, and refunding an unknown is how a salary gets paid and
 * credited back at the same time.
 */
function isDefiniteRejection(err) {
  const status = Number(err?.statusCode);
  return Number.isFinite(status) && status >= 400 && status < 500;
}

/**
 * Paystack says it has never seen this reference. Only trustworthy once the row
 * has sat untouched for the whole stranded window - a 404 seconds after submit
 * is just Paystack catching up.
 */
function isNeverSent(err, updatedAt, now = Date.now()) {
  if (Number(err?.statusCode) !== 404) return false;
  const at = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
  if (!Number.isFinite(at)) return false;
  return now - at > strandedAfterMs();
}

function newReference(runId, staffId) {
  return `SPPAY-${runId}-${staffId}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function payoutTimeOrDefault(company) {
  const configured = String(company?.payout_time || '').trim();
  if (/^\d{1,2}:\d{2}$/.test(configured)) return configured;
  const fallback = String(process.env.STAFFPAY_DEFAULT_PAYOUT_TIME || '09:00').trim();
  return /^\d{1,2}:\d{2}$/.test(fallback) ? fallback : '09:00';
}

/**
 * A Paystack transfer goes to a recipient_code, not to an account number, so
 * every staff row needs one. Created lazily here as well as on write, because
 * a staff row added before this migration has none.
 */
async function ensureRecipient(staff) {
  const existing = String(staff?.paystack_recipient_code || '').trim();
  if (existing) return existing;

  const accountNumber = decryptString(staff.account_number_enc);
  if (!accountNumber) throw new Error('Staff bank account is unreadable');

  // Plaintext exists only for this call - Paystack needs the name the bank
  // holds, and it goes straight back out of scope.
  const staffPii = revealStaffFields(staff);

  const { recipient_code } = await createTransferRecipient({
    name: staffPii.account_name || staffPii.full_name,
    account_number: accountNumber,
    bank_code: staff.bank_code,
  });

  await withDirectFallback(p => p.staffPayStaff.update({
    where: { id: Number(staff.id) },
    data: { paystack_recipient_code: recipient_code },
  }));

  return recipient_code;
}

/** Credit a failed item's full cost back to the wallet, at most once. */
async function refundItem(item, reason) {
  const cost = itemCost(item);
  if (cost.lte(0)) return false;

  return withDirectFallback(p => p.$transaction(async tx => {
    const claimed = await tx.staffPayPayrollItem.updateMany({
      where: { id: Number(item.id), refunded_at: null },
      data: { refunded_at: new Date(), complete_message: friendlyFailureReason(reason) || 'Transfer failed' },
    });
    if (!claimed?.count) return false;

    const run = await tx.staffPayPayrollRun.findUnique({
      where: { id: Number(item.payroll_run_id) },
      select: { company_id: true },
    });
    if (!run) return false;

    await applyBalanceDelta(tx, 'staffPayWallet', run.company_id, cost);
    return true;
  }, { timeout: 15000 }));
}

/**
 * Submit one item to Paystack. Never throws: a submit failure is recorded on
 * the item and refunded, so one bad account cannot abort the rest of payroll.
 */
async function submitItem({ item, staff, companyName }) {
  const reference = newReference(item.payroll_run_id, staff.id);

  // Claim the item before talking to Paystack. Two retries pressed at once - or
  // a retry racing the scheduler's own execute - would otherwise both read the
  // row as NEW and send two transfers for one salary. The updateMany is the
  // claim: exactly one caller sees count 1.
  //
  // The reference is written by the same statement, before the money moves, so
  // a process that dies mid-submit still leaves behind the one string needed to
  // ask Paystack what happened. Recovery depends on it.
  const claimed = await withDirectFallback(p => p.staffPayPayrollItem.updateMany({
    where: { id: Number(item.id), status: 'NEW' },
    data: { status: 'PENDING', reference },
  }));
  if (!claimed?.count) return { ok: false, skipped: true, message: 'Already submitted' };

  try {
    const recipient = await ensureRecipient(staff);
    const amountKobo = Math.round(Number(money(item.amount).toString()) * 100);

    const { data } = await initiateTransfer({
      amountKobo,
      recipient,
      reference,
      reason: `Salary - ${companyName || 'StaffPay'}`.slice(0, 100),
    });

    const status = String(data?.status || '').toLowerCase();
    // `otp` means the business still has transfer OTP switched on; the money has
    // not moved and never will without manual approval, so it is a failure here.
    if (status === 'otp') {
      const message = 'Paystack transfer OTP is enabled on this account. Disable it to run payroll.';
      await withDirectFallback(p => p.staffPayPayrollItem.update({
        where: { id: item.id },
        data: { status: 'FAILED', reference, provider_transfer_id: data?.transfer_code || null, raw_payload: data },
      }));
      await refundItem(item, message);
      return { ok: false, message };
    }

    const settled = status === 'success';
    await withDirectFallback(p => p.staffPayPayrollItem.update({
      where: { id: item.id },
      data: {
        status: settled ? 'SUCCESSFUL' : 'PENDING',
        reference,
        provider_transfer_id: data?.transfer_code ? String(data.transfer_code) : null,
        complete_message: null,
        // Stamped only on the way into SUCCESSFUL. Reporting reads this, never
        // updated_at, which moves on every later touch of the row.
        paid_at: settled ? (item.paid_at || new Date()) : null,
        raw_payload: data,
      },
    }));

    return { ok: true, status };
  } catch (e) {
    const message = e?.message || 'Transfer request failed';

    // Anything but a rejection stays PENDING with its reference, and
    // recoverStrandedRuns asks Paystack what really happened.
    if (!isDefiniteRejection(e)) {
      await withDirectFallback(p => p.staffPayPayrollItem.update({
        where: { id: item.id },
        data: { reference, raw_payload: { provider_error: message, indeterminate: true } },
      }));
      captureError('staffpay.transfer_indeterminate', e, {
        payroll_run_id: Number(item.payroll_run_id),
        staff_id: Number(item.staff_id),
        reference,
      });
      return { ok: false, pending: true, message };
    }

    await withDirectFallback(p => p.staffPayPayrollItem.update({
      where: { id: item.id },
      data: {
        status: 'FAILED',
        reference,
        complete_message: friendlyFailureReason(message),
        // The submit path has no provider payload to keep, so the raw error is
        // stashed here - support still needs the exact string.
        raw_payload: { provider_error: message },
      },
    }));
    await refundItem(item, message);
    paymentFailure({
      provider: 'paystack',
      action: 'transfer',
      reference,
      amount: money(item.amount).toString(),
      message,
      context: { payroll_run_id: Number(item.payroll_run_id), staff_id: Number(item.staff_id) },
    });
    return { ok: false, message };
  }
}

function rollUpStatus(items) {
  const statuses = (items || []).map(i => String(i.status || '').toUpperCase());
  if (!statuses.length) return 'failed';
  if (statuses.every(s => s === 'SUCCESSFUL')) return 'successful';
  if (statuses.some(s => s === 'NEW' || s === 'PENDING')) return 'processing';
  if (statuses.every(s => s === 'FAILED')) return 'failed';
  return 'partial';
}

async function finaliseRun(runId) {
  const run = await withDirectFallback(p => p.staffPayPayrollRun.findUnique({
    where: { id: Number(runId) },
    include: { items: true },
  }));
  if (!run) return null;

  const status = rollUpStatus(run.items);

  const failedCount = (run.items || []).filter(i => String(i.status).toUpperCase() === 'FAILED').length;
  const attempts = Number(run.auto_retry_count || 0);
  const settled = status !== 'processing';
  const ceilingReached = attempts >= maxAutoRetries();

  // Only a settled run with failures is worth another attempt. A run still
  // processing gets no timer - the poller is already watching it.
  const nextRetryAt = settled && failedCount && !ceilingReached
    ? new Date(Date.now() + retryBackoffMs(attempts))
    : null;

  await withDirectFallback(p => p.staffPayPayrollRun.update({
    where: { id: run.id },
    data: { status, next_retry_at: nextRetryAt },
  }));

  if (settled && failedCount && ceilingReached) {
    paymentFailure({
      provider: 'paystack',
      action: 'payroll',
      reference: `run:${run.id}`,
      message: `Payroll run gave up after ${attempts} automatic retries with ${failedCount} failed transfer(s)`,
      context: { company_id: Number(run.company_id), payroll_run_id: run.id },
    });
  }

  const paidStaffIds = (run.items || [])
    .filter(i => String(i.status).toUpperCase() === 'SUCCESSFUL')
    .map(i => Number(i.staff_id))
    .filter(Boolean);

  if (paidStaffIds.length) {
    await withDirectFallback(p => p.staffPayStaff.updateMany({
      where: { id: { in: paidStaffIds } },
      data: { last_paid_at: new Date() },
    }));
  }

  return status;
}

/**
 * Price a run without touching money. Used by the dashboard so a business can
 * see the shortfall before it presses Pay All Staff.
 */
async function quotePayroll({ companyId, staffIds }) {
  const staff = await withDirectFallback(p => p.staffPayStaff.findMany({
    where: {
      company_id: Number(companyId),
      is_active: true,
      ...(Array.isArray(staffIds) && staffIds.length ? { id: { in: staffIds.map(Number).filter(Boolean) } } : {}),
    },
    orderBy: { id: 'asc' },
  }));

  const perStaff = new Map();
  let salary = ZERO;
  let provider = ZERO;
  let volt = ZERO;
  let vat = ZERO;

  for (const s of staff) {
    const f = feesFor(s.salary_amount);
    perStaff.set(Number(s.id), f);
    salary = salary.plus(f.salary);
    provider = provider.plus(f.provider);
    volt = volt.plus(f.volt);
    vat = vat.plus(f.vat);
  }

  const wallet = await withDirectFallback(p => p.staffPayWallet.findUnique({ where: { company_id: Number(companyId) } }));
  const balance = money(wallet?.balance || 0);
  const total = salary.plus(provider).plus(volt).plus(vat);
  const shortfall = total.gt(balance) ? total.minus(balance) : ZERO;

  return {
    staff,
    perStaff,
    totals: { salary, provider, volt, vat, total },
    balance,
    shortfall,
    is_sufficient: shortfall.eq(0),
  };
}

/**
 * The one transaction that moves money: reserve, then write the run and its
 * items. Split out of createPayrollRunForCompany only so the unique-violation
 * case has somewhere to be caught.
 *
 * A P2002 here is the (staff_id, cycle_key) index refusing a second item for a
 * payday somebody else is already paying. Throwing out of the interactive
 * transaction rolls the reserve back with it, so the loser leaves the wallet
 * exactly as it found it.
 */
async function createRunTransaction({ company, quote, totals, title, mode, actorUserId, cycleKeys }) {
  try {
    return await withDirectFallback(p => p.$transaction(async tx => {
      const reserved = await tx.staffPayWallet.updateMany({
        where: { company_id: Number(company.id), balance: { gte: totals.total } },
        data: { balance: { decrement: totals.total } },
      });

      // Lost the race against another run between the quote and here.
      if (!reserved?.count) {
        throw Object.assign(new Error('Insufficient StaffPay wallet balance'), { statusCode: 400, remark: 'insufficient_balance' });
      }

      // The `gte` guard has to stay in SQL, so the debit is not expressible as a
      // plain delta - re-stamp the MAC instead.
      await restampBalance(tx, 'staffPayWallet', company.id);

      return tx.staffPayPayrollRun.create({
        data: {
          company_id: Number(company.id),
          title,
          status: 'preparing',
          mode: mode === 'auto' ? 'auto' : 'manual',
          triggered_by_user_id: actorUserId ? Number(actorUserId) : null,
          total_salary: totals.salary,
          provider_fee_total: totals.provider,
          voltpay_fee_total: totals.volt,
          vat_total: totals.vat,
          total_debit: totals.total,
          items: {
            // Deliberately not `skipDuplicates`: a skipped item is a staff
            // member whose salary was reserved out of the wallet and never
            // sent. Losing the whole transaction is the only outcome that
            // leaves the money where it started.
            createMany: {
              data: quote.staff.map(s => {
                const f = quote.perStaff.get(Number(s.id));
                return {
                  staff_id: s.id,
                  amount: f.salary,
                  provider_fee: f.provider,
                  voltpay_fee: f.volt,
                  vat: f.vat,
                  status: 'NEW',
                  cycle_key: cycleKeys ? cycleKeys.get(Number(s.id)) || null : null,
                };
              }),
            },
          },
        },
      });
    }, { timeout: 15000, maxWait: 15000 }));
  } catch (e) {
    if (e?.code === 'P2002') {
      throw Object.assign(
        new Error('This salary cycle is already being paid. No money was moved.'),
        { statusCode: 409, remark: 'payroll_cycle_already_run' },
      );
    }
    throw e;
  }
}

/**
 * Reserve the money and create the run. Throws (statusCode 400) rather than
 * disbursing anything when the wallet cannot cover the full run - a half-paid
 * payroll is worse than a refused one.
 *
 * `cycleKeys` is a Map of staff id -> `due:YYYY-MM-DD` for a run that pays a
 * salary cycle (the scheduler, and Run Payroll Now). Those keys are unique per
 * staff member in the database, so a second instance racing this one loses the
 * insert and the whole transaction - reserve included - rolls back. Leave it
 * unset for an off-cycle run, where a repeat is the caller's intent.
 */
async function createPayrollRunForCompany({ company, staffIds, title, actorUserId, mode = 'manual', cycleKeys = null }) {
  // Checked in the service rather than on a route: payroll starts from the
  // scheduler as often as from a button, and the scheduler has no middleware.
  if (!(await isFeatureEnabled('staffpay_payroll'))) {
    throw Object.assign(
      new Error('Payroll is temporarily unavailable. Please try again shortly.'),
      { statusCode: 503, remark: 'feature_disabled' },
    );
  }

  const quote = await quotePayroll({ companyId: company.id, staffIds });

  if (!quote.staff.length) {
    throw Object.assign(new Error('No active staff to pay'), { statusCode: 400, remark: 'no_staff' });
  }

  if (!quote.is_sufficient) {
    throw Object.assign(
      new Error(`Insufficient StaffPay wallet balance. Fund ₦${quote.shortfall.toFixed(2)} more to run this payroll.`),
      { statusCode: 400, remark: 'insufficient_balance', shortfall: quote.shortfall },
    );
  }

  const { totals } = quote;

  const run = await createRunTransaction({ company, quote, totals, title, mode, actorUserId, cycleKeys });

  await logStaffPayEvent({
    userId: Number(actorUserId || company.owner_user_id),
    event: 'staffpay_payroll_run_initiated',
    metadata: { company_id: Number(company.id), payroll_run_id: run.id, total_debit: Number(totals.total.toString()), mode },
  });

  await executeRun({ runId: run.id, companyName: revealCompanyFields(company).name });

  return withDirectFallback(p => p.staffPayPayrollRun.findUnique({
    where: { id: run.id },
    include: { items: { include: { staff: true } } },
  }));
}

/** Submit every not-yet-submitted item of a run. */
async function executeRun({ runId, companyName }) {
  const items = await withDirectFallback(p => p.staffPayPayrollItem.findMany({
    where: { payroll_run_id: Number(runId), status: 'NEW' },
    include: { staff: true },
    orderBy: { id: 'asc' },
  }));

  // ponytail: sequential. Paystack rate-limits bursts and payroll sizes here are
  // tens, not thousands - add concurrency when a run actually gets slow.
  for (const item of items) {
    await submitItem({ item, staff: item.staff, companyName });
  }

  return finaliseRun(runId);
}

/**
 * Re-run only the failed items. Their money was refunded when they failed, so
 * it has to be reserved again - and refused if the wallet has since been spent.
 */
async function retryFailedItems({ runId, actorUserId }) {
  const run = await withDirectFallback(p => p.staffPayPayrollRun.findUnique({
    where: { id: Number(runId) },
    include: { company: true, items: { include: { staff: true } } },
  }));
  if (!run) throw Object.assign(new Error('Payroll run not found'), { statusCode: 404, remark: 'not_found' });

  const failed = (run.items || []).filter(i => String(i.status).toUpperCase() === 'FAILED');
  if (!failed.length) {
    throw Object.assign(new Error('This payroll run has no failed transfers'), { statusCode: 400, remark: 'no_failed_transfers' });
  }

  const total = failed.reduce((acc, i) => acc.plus(itemCost(i)), ZERO);

  await withDirectFallback(p => p.$transaction(async tx => {
    const reserved = await tx.staffPayWallet.updateMany({
      where: { company_id: Number(run.company_id), balance: { gte: total } },
      data: { balance: { decrement: total } },
    });

    if (!reserved?.count) {
      throw Object.assign(
        new Error(`Insufficient StaffPay wallet balance to retry. Fund ₦${total.toFixed(2)} to continue.`),
        { statusCode: 400, remark: 'insufficient_balance' },
      );
    }

    await restampBalance(tx, 'staffPayWallet', run.company_id);

    await tx.staffPayPayrollItem.updateMany({
      where: { id: { in: failed.map(i => Number(i.id)) } },
      // paid_at goes back to null with the rest: this item is unpaid again, and
      // leaving a stale date would show a salary on the trend that was refunded.
      data: { status: 'NEW', refunded_at: null, complete_message: null, provider_transfer_id: null, reference: null, paid_at: null },
    });

    await tx.staffPayPayrollRun.update({ where: { id: run.id }, data: { status: 'preparing' } });
  }, { timeout: 15000, maxWait: 15000 }));

  await logStaffPayEvent({
    userId: Number(actorUserId || run.company?.owner_user_id),
    event: 'staffpay_payroll_retry',
    metadata: { company_id: Number(run.company_id), payroll_run_id: run.id, retried: failed.length },
  });

  await executeRun({ runId: run.id, companyName: revealCompanyFields(run.company).name });

  return withDirectFallback(p => p.staffPayPayrollRun.findUnique({
    where: { id: run.id },
    include: { items: { include: { staff: true } } },
  }));
}

/**
 * Retry the runs whose backoff has elapsed. Called by the scheduler.
 *
 * The attempt is counted and the timer cleared *before* the transfers go out, so
 * a crash mid-retry costs one attempt rather than looping on it. finaliseRun
 * sets the next timer, and stops setting one once the ceiling is hit.
 */
async function retryDueFailedRuns({ limit = 5 } = {}) {
  if (!prisma.staffPayPayrollRun) return { attempted: 0 };

  const runs = await withDirectFallback(p => p.staffPayPayrollRun.findMany({
    where: {
      status: { in: ['failed', 'partial'] },
      next_retry_at: { not: null, lte: new Date() },
      auto_retry_count: { lt: maxAutoRetries() },
    },
    orderBy: { next_retry_at: 'asc' },
    take: Math.max(1, Number(limit) || 5),
    select: { id: true, company_id: true, auto_retry_count: true },
  }));

  let attempted = 0;

  for (const run of runs || []) {
    try {
      const claimed = await withDirectFallback(p => p.staffPayPayrollRun.updateMany({
        where: { id: run.id, next_retry_at: { not: null } },
        data: { auto_retry_count: { increment: 1 }, next_retry_at: null },
      }));
      if (!claimed?.count) continue;

      attempted += 1;
      await retryFailedItems({ runId: run.id });
    } catch (e) {
      // A shortfall is not an outage: the wallet has to be funded before there
      // is anything to retry, so leave the timer off and let the owner act.
      if (e?.remark === 'insufficient_balance' || e?.remark === 'no_failed_transfers') {
        console.warn('StaffPay auto-retry skipped', { payroll_run_id: run.id, remark: e.remark });
        continue;
      }
      captureError('staffpay.auto_retry', e, { payroll_run_id: run.id, company_id: Number(run.company_id) });
    }
  }

  return { attempted };
}

/**
 * How long a run may sit with unsent work before it is treated as abandoned by
 * a dead process. Long enough that a slow but living run is never disturbed.
 */
function strandedAfterMs() {
  return Math.max(60_000, Number(process.env.STAFFPAY_STRANDED_AFTER_MS) || 10 * 60_000);
}

/**
 * Pick up runs whose process died mid-flight, so a company is not blocked
 * forever by a run that can never finish on its own.
 *
 * Two kinds of stranded work, both settled without risking a second payment:
 *   - item still NEW - never claimed, so it never reached Paystack. Submitting
 *     it now is safe because submitItem claims the row first.
 *   - item PENDING with a reference - may or may not have reached Paystack.
 *     Never resubmitted; the poll asks Paystack and lets the answer decide.
 *
 * The claim is the run's own updated_at: bumping it hands this run to one
 * instance for the length of the stranded window.
 */
async function recoverStrandedRuns({ limit = 5 } = {}) {
  if (!prisma.staffPayPayrollRun) return { recovered: 0 };

  const cutoff = new Date(Date.now() - strandedAfterMs());

  const runs = await withDirectFallback(p => p.staffPayPayrollRun.findMany({
    where: {
      status: { in: ['preparing', 'processing'] },
      updated_at: { lt: cutoff },
      items: { some: { status: { in: ['NEW', 'PENDING'] } } },
    },
    orderBy: { updated_at: 'asc' },
    take: Math.max(1, Number(limit) || 5),
    select: { id: true, company_id: true, status: true },
  }));

  let recovered = 0;

  for (const run of runs || []) {
    try {
      // Re-writing the same status is a no-op except for updated_at, which is
      // exactly the point: the next instance sees a fresh row and skips it.
      const claimed = await withDirectFallback(p => p.staffPayPayrollRun.updateMany({
        where: { id: run.id, status: run.status, updated_at: { lt: cutoff } },
        data: { status: run.status },
      }));
      if (!claimed?.count) continue;

      recovered += 1;
      console.warn('StaffPay recovering stranded payroll run', { payroll_run_id: run.id, company_id: Number(run.company_id) });

      // Anything already at Paystack settles itself first, so the wallet is
      // refunded for whatever never left before more transfers go out.
      await syncPayrollRunById(run.id);

      const withItems = await withDirectFallback(p => p.staffPayPayrollRun.findUnique({
        where: { id: run.id },
        include: { company: true, items: { select: { id: true, status: true } } },
      }));
      const unsent = (withItems?.items || []).filter(i => String(i.status).toUpperCase() === 'NEW');
      if (unsent.length) {
        await executeRun({ runId: run.id, companyName: revealCompanyFields(withItems.company).name });
      }
    } catch (e) {
      captureError('staffpay.recover_stranded', e, { payroll_run_id: run.id, company_id: Number(run.company_id) });
    }
  }

  return { recovered };
}

function mapTransferStatus(paystackStatus) {
  const s = String(paystackStatus || '').toLowerCase();
  if (s === 'success') return 'SUCCESSFUL';
  if (s === 'failed' || s === 'reversed' || s === 'abandoned') return 'FAILED';
  return 'PENDING';
}

/** Poll Paystack for every item still in flight. Also the webhook's backstop. */
async function syncPayrollRunById(runId) {
  const run = await withDirectFallback(p => p.staffPayPayrollRun.findUnique({
    where: { id: Number(runId) },
    include: { items: true },
  }));
  if (!run) return null;

  const inFlight = (run.items || []).filter(i => {
    const s = String(i.status).toUpperCase();
    return (s === 'PENDING' || s === 'NEW') && i.reference;
  });

  for (const item of inFlight) {
    let data;
    try {
      ({ data } = await verifyTransfer(item.reference));
    } catch (e) {
      // A 404 straight after submit only means Paystack has not registered the
      // reference yet. A 404 on a row nobody has touched for the whole stranded
      // window means the submit died before Paystack ever saw it, so the salary
      // is sitting reserved in the wallet and has to be released.
      if (isNeverSent(e, item.updated_at)) {
        await withDirectFallback(p => p.staffPayPayrollItem.update({
          where: { id: item.id },
          data: { status: 'FAILED', complete_message: 'Transfer was never received by our bank partner. Retry to send it again.' },
        }));
        await refundItem(item, 'Transfer was never sent');
        continue;
      }
      // Any other Paystack error is transient: a live transfer must not be
      // marked failed on the strength of one bad response.
      continue;
    }

    const status = mapTransferStatus(data?.status);
    if (status === 'PENDING') continue;

    await withDirectFallback(p => p.staffPayPayrollItem.update({
      where: { id: item.id },
      data: {
        status,
        provider_transfer_id: data?.transfer_code ? String(data.transfer_code) : item.provider_transfer_id,
        complete_message: friendlyFailureReason(data?.reason || data?.message),
        // Keep the first stamp if one is already there - the poll and the
        // webhook can both settle the same item, and the earlier of the two is
        // the honest payment time.
        paid_at: status === 'SUCCESSFUL' ? (item.paid_at || new Date()) : null,
        raw_payload: data,
      },
    }));

    if (status === 'FAILED') {
      await refundItem(item, data?.reason || `Transfer ${data?.status || 'failed'}`);
    }
  }

  const status = await finaliseRun(run.id);
  return { payroll_run_id: run.id, status };
}

/**
 * Paystack transfer.* webhook. Same state machine as the poll, keyed on our own
 * per-item reference.
 */
async function handleTransferEvent({ event, data }) {
  const reference = String(data?.reference || '').trim();
  if (!reference.startsWith('SPPAY-')) return false;

  const item = await withDirectFallback(p => p.staffPayPayrollItem.findUnique({ where: { reference } }));
  if (!item) return false;

  const status = mapTransferStatus(event === 'transfer.success' ? 'success' : data?.status || event.split('.')[1]);
  if (String(item.status).toUpperCase() === status) return true;

  await withDirectFallback(p => p.staffPayPayrollItem.update({
    where: { id: item.id },
    data: {
      status,
      provider_transfer_id: data?.transfer_code ? String(data.transfer_code) : item.provider_transfer_id,
      complete_message: friendlyFailureReason(data?.reason || data?.message),
      // See syncPayrollRunById: first stamp wins, and a non-successful status
      // must not leave a payment date behind.
      paid_at: status === 'SUCCESSFUL' ? (item.paid_at || new Date()) : null,
      raw_payload: data,
    },
  }));

  if (status === 'FAILED') {
    await refundItem(item, data?.reason || `Transfer ${data?.status || 'failed'}`);
  }

  await finaliseRun(item.payroll_run_id);
  return true;
}

module.exports = {
  createPayrollRunForCompany,
  executeRun,
  retryFailedItems,
  retryDueFailedRuns,
  recoverStrandedRuns,
  strandedAfterMs,
  isDefiniteRejection,
  isNeverSent,
  retryBackoffMs,
  maxAutoRetries,
  syncPayrollRunById,
  handleTransferEvent,
  quotePayroll,
  feesFor,
  voltpayFee,
  rollUpStatus,
  itemCost,
  payoutTimeOrDefault,
  friendlyFailureReason,
};
