/**
 * Scheduled top-ups: the worker that buys a customer's standing airtime and
 * data orders without anybody pressing a button.
 *
 * A tick, once a minute (wired in server.js):
 *   1. claims every active schedule whose next run has passed - one cycle each
 *   2. picks up runs whose retry time has come round
 *   3. mirrors runs the provider accepted as pending once the ledger settles
 *   4. finishes runs whose process died mid-attempt
 *   5. sends the "in one hour" reminders
 *
 * Money rules that must not be relaxed:
 *
 *   - **A cycle is bought once.** Claiming a cycle moves the schedule's
 *     `next_run_at` (guarded on the value read) and inserts the run row in one
 *     transaction, and (schedule_id, cycle_key) is unique. However many
 *     instances tick, one of them owns the cycle.
 *   - **Only the owner moves money.** Every attempt bumps `attempts`, and the
 *     reserve transaction re-proves the claim (`withinReserve`) and stamps the
 *     trx in the same commit as the ledger row. A worker that lost the run -
 *     to a stranded-run sweep, say - rolls its own debit back.
 *   - **The purchase is the pay button's.** Reserve, vend, refund and ledger
 *     all go through bills.controller's executePurchase. There is no second
 *     money path to keep correct.
 *   - **A vend is never repeated on an unknown outcome.** A retry is a fresh
 *     purchase on a fresh trx, and only after the previous attempt provably
 *     moved nothing or was refunded - see classifyVendFailure.
 */
const prisma = require('../../database/prisma');
const { Prisma } = require('@prisma/client');

const bills = require('../funding/billsProvider');
const billsController = require('../controllers/bills.controller');
const { reconcile } = require('../helpers/billReconcile.helper');
const { checkSpendKyc } = require('../helpers/kycGate.helper');
const { checkVelocity } = require('../helpers/velocity.helper');
const { isFeatureEnabled } = require('../helpers/featureFlag.helper');
const { reveal, revealText } = require('../helpers/pii.helper');
const { normalizeNgPhone } = require('../helpers/phone.helper');
const { withDirectFallback } = require('../helpers/prismaDirect.helper');
const { lagosDateParts } = require('../helpers/lagosTime.helper');
const sched = require('../helpers/topupSchedule.helper');
const { notifyUser } = require('./notify.service');
const alerts = require('./alerts.service');

const ACTIVE_USER = 1;

function envNumber(name, fallback) {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envFlag(name) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  return raw === 'true' || raw === '1';
}

// Schedules or runs handled per step per tick. A run is one vend, so 25 is a
// handful of seconds of provider time; anything left over is next minute's.
const batchSize = () => envNumber('SCHEDULED_TOPUPS_BATCH', 25);

// A run still `running` after this long belongs to a process that died. A
// vend answers (or times out) in well under a minute, so ten is not a race
// with a live worker.
const strandedAfterMs = () => envNumber('SCHEDULED_TOPUPS_STRANDED_AFTER_MS', 10 * 60_000);

// A slot more than this far in the past - the worker was off for a day - is
// recorded as missed rather than bought late. A Monday top-up arriving on
// Thursday is not what anybody scheduled.
const maxLatenessMs = () => envNumber('SCHEDULED_TOPUPS_MAX_LATENESS_MS', 24 * 60 * 60_000);

// "Notify 1 hour prior to debit".
const reminderLeadMs = () => envNumber('SCHEDULED_TOPUPS_REMINDER_LEAD_MS', 60 * 60_000);

/* ------------------------------------------------------------------ wording */

// Customer-safe reasons. Stored on the run and shown on the details screen, so
// they say what happened and what to do - never a provider's raw text.
const MESSAGES = {
  insufficient_balance: 'Your wallet balance was too low.',
  service_unavailable: 'Top-ups were briefly unavailable.',
  velocity_limit: 'Your spending limit for the period was reached.',
  provider_error: 'The network could not deliver this top-up. Your wallet was refunded.',
  provider_rejected: 'The network refused this number or amount. Your wallet was refunded.',
  plan_unavailable: 'This data plan is no longer sold.',
  price_changed: 'The price of this data plan went up.',
  amount_below_minimum: 'This amount is below the current minimum.',
  invalid_number: 'The recipient number on this schedule is not valid.',
  kyc_required: 'Your account verification is incomplete.',
  account_inactive: 'Your account is not active.',
  paused: 'The schedule was paused before this run.',
  deleted: 'The schedule was deleted before this run.',
  missed: 'This run was missed during a service interruption.',
  interrupted: 'This run was interrupted before any money moved.',
  refund_pending: 'The network could not deliver this top-up. Your refund is being processed.',
  error: 'We could not complete this top-up.',
};

/** Why the worker paused a schedule, as the app shows it on the card. */
const PAUSE_MESSAGES = {
  plan_unavailable: 'Paused: this data plan is no longer sold. Edit the schedule to pick another.',
  price_changed: 'Paused: this plan costs more than you approved. Edit the schedule to accept the new price.',
  amount_below_minimum: 'Paused: the amount is below the current minimum. Edit the schedule to change it.',
  invalid_number: 'Paused: the recipient number is not valid. Edit the schedule to fix it.',
  provider_rejected: 'Paused: the network refused this top-up. Check the number and network, then resume.',
  kyc_required: 'Paused: complete your account verification, then resume.',
  account_inactive: 'Paused while your account was inactive.',
  invalid_schedule: 'Paused: this schedule could not be read. Edit it to set it up again.',
};

/** "Mom" or "0803 *** 7890", and "MTN airtime" or "MTN 1GB data". */
function describe(schedule) {
  let phone = '';
  try {
    phone = reveal(schedule.phone_enc);
  } catch {
    phone = '';
  }
  const label = revealText(schedule.label || '');
  const who = label || sched.maskPhone(phone) || 'your recipient';
  const what = schedule.service === 'data'
    ? `${schedule.provider} ${schedule.plan_name || ''} data`.replace(/\s+/g, ' ')
    : `${schedule.provider} airtime`;
  return { who, what, phone };
}

/**
 * One push per event per run, whatever happens. `clientMessageId` is unique per
 * user in push_notifications, so a second instance - or a restart - that tries
 * to say the same thing again is refused by the database and sends nothing.
 *
 * `data` is persisted and follows the ledger `meta` rule: ids and a status,
 * never a name or a number. It is also the FCM payload, and notifyUser does
 * not copy `type` into it - so `type` is repeated inside, or the app's tap
 * handler cannot tell this push from any other (credit alerts do the same).
 */
async function notify(schedule, { key, subject, message, runId = null, status = '' }) {
  try {
    await notifyUser({
      userId: schedule.user_id,
      subject,
      message,
      type: 'scheduled_topup',
      data: { type: 'scheduled_topup', schedule_id: schedule.id, run_id: runId, status },
      clientMessageId: key,
    });
  } catch (e) {
    // A money path that has already committed. A failed push is logged, never
    // thrown back into it.
    console.error('scheduledTopup: notify failed', { schedule_id: schedule.id, error: e?.message });
  }
}

function nextRunSentence(schedule) {
  return schedule.status === 'active' && schedule.next_run_at
    ? ` Next run: ${sched.lagosLabel(schedule.next_run_at)}.`
    : '';
}

/* ----------------------------------------------------------------- pricing */

/**
 * The payload quote() would build for this schedule, priced now.
 *
 * Re-resolved on every run rather than pinned at creation: a run happens weeks
 * after the customer set it up, and the rail may have moved provider since -
 * the plan id is checked against whoever is serving data *today*.
 *
 * A data plan is never bought for more than the customer approved. The live
 * price is what is charged when it is the same or lower; when it has risen,
 * the schedule is paused for a fresh PIN instead of quietly charging more.
 */
async function priceRun(schedule) {
  const key = schedule.service;
  if (!billsController.SERVICES[key] || !sched.SERVICES[key]) {
    return { ok: false, code: 'invalid_schedule', action: 'pause' };
  }
  const service = { key, ...billsController.SERVICES[key] };

  let phone = null;
  try {
    phone = normalizeNgPhone(reveal(schedule.phone_enc));
  } catch {
    phone = null;
  }
  if (!phone) return { ok: false, code: 'invalid_number', action: 'pause' };

  const { name: gateway, provider: upstream } = await bills.resolve(key);
  const pending = {
    gateway,
    service: key,
    provider: schedule.provider,
    phone_local: phone.local,
    phone_msisdn: phone.msisdn,
  };

  if (key === 'airtime') {
    const amount = Number(schedule.amount);
    const floor = billsController.minAmountFor(service, upstream);
    if (!Number.isInteger(amount) || amount < floor) {
      return { ok: false, code: 'amount_below_minimum', action: 'pause' };
    }
    pending.amount = amount;
    pending.item_name = 'Airtime';
  } else {
    let plans;
    try {
      plans = await upstream.listDataPlansCached(schedule.provider);
    } catch (e) {
      // The catalogue is down, not the plan gone. Nothing was attempted.
      return { ok: false, code: 'service_unavailable', action: 'retry' };
    }
    const plan = (plans || []).find(p => String(p.id) === String(schedule.plan_id));
    const price = Number(plan?.amount);
    if (!plan || !Number.isFinite(price) || price <= 0) {
      return { ok: false, code: 'plan_unavailable', action: 'pause' };
    }
    const approved = Number(schedule.amount);
    if (price - approved >= 0.01) {
      return {
        ok: false,
        code: 'price_changed',
        action: 'pause',
        message: `The price of this data plan went up from ${sched.nairaLabel(approved)} to ${sched.nairaLabel(price)}.`,
      };
    }
    const shown = billsController.displayPlan(plan);
    pending.plan_id = String(plan.id);
    pending.item_name = shown.name;
    pending.validity = shown.validity;
    pending.amount = price;
  }

  pending.charge = 0;
  pending.total = pending.amount;
  return { ok: true, service, gateway, upstream, pending };
}

/* ------------------------------------------------------------ transitions */

/** Every write to a run the worker owns is guarded on that ownership. */
async function moveRun(guard, data) {
  const moved = await prisma.scheduledTopupRun.updateMany({
    where: guard,
    data: { ...data, updated_at: new Date() },
  });
  return moved.count > 0;
}

async function pauseSchedule(schedule, reason) {
  await prisma.scheduledTopup.updateMany({
    where: { id: schedule.id, status: 'active' },
    data: { status: 'paused', pause_reason: reason },
  });
}

/**
 * Give this cycle another go later, or close it as failed when that was the
 * last attempt. A low balance is said straight away - the customer can fix it
 * before the retry - and every cycle that ends in failure is said once.
 */
async function retryOrFail({ guard, schedule, run, attempt, code, message, now }) {
  const text = message || MESSAGES[code] || MESSAGES.error;
  const { who, what } = describe(schedule);
  const amount = sched.nairaLabel(run.amount);
  const retryAt = sched.nextRetryAt(attempt, now);

  if (retryAt) {
    const moved = await moveRun(guard, {
      status: 'retrying',
      next_retry_at: retryAt,
      failure_code: code,
      failure_message: text,
    });
    if (moved && attempt === 1 && code === 'insufficient_balance') {
      await notify(schedule, {
        key: `stu:${run.id}:low_balance`,
        runId: run.id,
        status: 'retrying',
        subject: 'Scheduled top-up delayed',
        message:
          `Your wallet balance is too low for ${amount} ${what} for ${who}. ` +
          `Fund your wallet and we will try again at ${sched.lagosLabel(retryAt)}.`,
      });
    }
    return { outcome: 'retrying', retry_at: retryAt };
  }

  const moved = await moveRun(guard, {
    status: 'failed',
    next_retry_at: null,
    failure_code: code,
    failure_message: text,
    completed_at: now,
  });
  if (moved) {
    await notify(schedule, {
      key: `stu:${run.id}:failed`,
      runId: run.id,
      status: 'failed',
      subject: 'Scheduled top-up missed',
      message:
        `We could not buy ${amount} ${what} for ${who} after ${attempt} attempt${attempt === 1 ? '' : 's'}. ` +
        `${text}${nextRunSentence(schedule)}`,
    });
  }
  return { outcome: 'failed', code };
}

/** Close the run and pause the schedule: nothing will work until it is edited. */
async function failAndPause({ guard, schedule, run, code, message, now }) {
  const text = message || MESSAGES[code] || MESSAGES.error;
  const moved = await moveRun(guard, {
    status: 'failed',
    next_retry_at: null,
    failure_code: code,
    failure_message: text,
    completed_at: now,
  });
  await pauseSchedule(schedule, code);
  if (moved) {
    const { who, what } = describe(schedule);
    await notify(schedule, {
      key: `stu:${run.id}:paused`,
      runId: run.id,
      status: 'paused',
      subject: 'Scheduled top-up paused',
      message: `Your ${what} top-up for ${who} is paused. ${text} Open Scheduled Top-ups to update it.`,
    });
  }
  return { outcome: 'paused', code };
}

async function announceSuccess(schedule, run) {
  const { who, what } = describe(schedule);
  await notify(schedule, {
    key: `stu:${run.id}:success`,
    runId: run.id,
    status: 'success',
    subject: 'Scheduled top-up successful',
    message: `${sched.nairaLabel(run.amount)} ${what} sent to ${who}.${nextRunSentence(schedule)}`,
  });
}

async function announceRefunded(schedule, run) {
  const { who, what } = describe(schedule);
  await notify(schedule, {
    key: `stu:${run.id}:failed`,
    runId: run.id,
    status: 'failed',
    subject: 'Scheduled top-up failed',
    message:
      `${sched.nairaLabel(run.amount)} ${what} for ${who} could not be delivered, ` +
      `and your wallet has been refunded.${nextRunSentence(schedule)}`,
  });
}

/* --------------------------------------------------------------- attempts */

/**
 * One attempt at one run. The caller has moved the run to `running`.
 *
 * The attempt counter is the ownership token: this function bumps it before
 * doing anything, and every later write is guarded on the bumped value - so if
 * a stranded-run sweep took the run away and another worker picked it up, this
 * worker's writes simply stop matching.
 */
async function attemptRun(run, now = new Date()) {
  const attempt = Number(run.attempts) + 1;
  const claimed = await moveRun(
    { id: run.id, status: 'running', attempts: run.attempts },
    { attempts: attempt, trx: null, next_retry_at: null },
  );
  if (!claimed) return { outcome: 'lost_claim' };

  const guard = { id: run.id, status: 'running', attempts: attempt };
  const mine = { ...run, attempts: attempt, trx: null };

  // The schedule as it is *now*: a retry fires hours after the claim, and the
  // customer may have paused, deleted or edited it in between.
  const schedule = await prisma.scheduledTopup.findUnique({ where: { id: run.schedule_id } });
  if (!schedule || schedule.status !== 'active') {
    const code = schedule?.status === 'paused' ? 'paused' : 'deleted';
    await moveRun(guard, { status: 'skipped', failure_code: code, failure_message: MESSAGES[code], completed_at: now });
    return { outcome: 'skipped', code };
  }

  const user = await prisma.user.findUnique({
    where: { id: Number(schedule.user_id) },
    select: { id: true, status: true },
  });
  if (!user || Number(user.status) !== ACTIVE_USER) {
    await moveRun(guard, {
      status: 'skipped',
      failure_code: 'account_inactive',
      failure_message: MESSAGES.account_inactive,
      completed_at: now,
    });
    await pauseSchedule(schedule, 'account_inactive');
    return { outcome: 'skipped', code: 'account_inactive' };
  }

  const ctx = { guard, schedule, run: mine, attempt, now };

  // The bills kill switch. An outage on our side, so the cycle waits for it.
  if (!(await isFeatureEnabled('bills'))) {
    return retryOrFail({ ...ctx, code: 'service_unavailable' });
  }

  // The same lock the pay button is behind: a frozen wallet cannot spend, and
  // a standing order is not a way round it. Fails closed - a check that could
  // not be read is retried, never waved through.
  let kyc;
  try {
    kyc = await checkSpendKyc({ userId: user.id });
  } catch (e) {
    return retryOrFail({ ...ctx, code: 'service_unavailable' });
  }
  if (!kyc.ok) {
    return failAndPause({ ...ctx, code: 'kyc_required', message: kyc.message || MESSAGES.kyc_required });
  }

  let priced;
  try {
    priced = await priceRun(schedule);
  } catch (e) {
    return retryOrFail({ ...ctx, code: 'service_unavailable' });
  }
  if (!priced.ok) {
    if (priced.action === 'retry') return retryOrFail({ ...ctx, code: priced.code, message: priced.message });
    return failAndPause({ ...ctx, code: priced.code, message: priced.message });
  }

  mine.amount = priced.pending.total;

  const velocity = await checkVelocity({ userId: user.id, amount: priced.pending.total });
  if (!velocity.ok) {
    return retryOrFail({ ...ctx, code: 'velocity_limit', message: velocity.message });
  }

  let result;
  try {
    result = await billsController.executePurchase({
      userId: user.id,
      service: priced.service,
      pending: priced.pending,
      gateway: priced.gateway,
      upstream: priced.upstream,
      // Ids only - `meta` is plain JSON. This is what ties a ledger row back
      // to the standing order that bought it.
      meta: { source: 'scheduled_topup', schedule_id: schedule.id, run_id: run.id },
      auditExtra: { source: 'scheduled_topup', schedule_id: schedule.id },
      withinReserve: async (tx, { trx }) => {
        const owned = await tx.scheduledTopupRun.updateMany({
          where: { ...guard, trx: null },
          data: { trx, amount: new Prisma.Decimal(Number(priced.pending.total).toFixed(2)), updated_at: new Date() },
        });
        if (!owned.count) throw Object.assign(new Error('Scheduled top-up run claim lost'), { code: 'LOST_CLAIM' });
      },
    });
  } catch (e) {
    if (e?.code === 'LOST_CLAIM') return { outcome: 'lost_claim' };
    // The reserve itself failed - a database error, rolled back whole. Nothing
    // moved, so the cycle may try again.
    console.error('scheduledTopup: reserve failed', { run_id: run.id, schedule_id: schedule.id, error: e?.message });
    return retryOrFail({ ...ctx, code: 'error' });
  }

  if (result.outcome === 'insufficient') {
    return retryOrFail({ ...ctx, code: 'insufficient_balance' });
  }

  if (result.outcome === 'provider_failed') {
    const refunded = result.refund?.applied || result.refund?.reason === 'already_refunded';
    if (!refunded) {
      // The money is out and its refund did not land - settleFailure has
      // already logged it for a person. Never retry on top of that: a second
      // purchase would charge the customer twice for one cycle.
      alerts.paymentFailure({
        provider: priced.gateway,
        action: 'scheduled_topup_refund',
        reference: result.trx,
        userId: user.id,
        amount: priced.pending.total,
        message: 'Scheduled top-up refund did not apply - manual settlement required',
      });
      await moveRun(guard, {
        status: 'failed',
        failure_code: 'refund_pending',
        failure_message: MESSAGES.refund_pending,
        completed_at: now,
      });
      return { outcome: 'failed', code: 'refund_pending' };
    }

    const action = sched.classifyVendFailure(result.error);
    if (action === 'retry') return retryOrFail({ ...ctx, code: 'provider_error' });
    if (action === 'pause') return failAndPause({ ...ctx, code: 'provider_rejected' });

    const moved = await moveRun(guard, {
      status: 'failed',
      failure_code: 'provider_error',
      failure_message: MESSAGES.provider_error,
      completed_at: now,
    });
    if (moved) await announceRefunded(schedule, mine);
    return { outcome: 'failed', code: 'provider_error' };
  }

  // Accepted but not yet delivered: the bills sweep (or the sync below)
  // settles the ledger row, and the run follows it. No push until then.
  if (result.processing) {
    await moveRun(guard, { status: 'processing' });
    return { outcome: 'processing', trx: result.trx };
  }

  const moved = await moveRun(guard, { status: 'success', failure_code: null, failure_message: null, completed_at: now });
  if (moved) await announceSuccess(schedule, mine);
  return { outcome: 'success', trx: result.trx };
}

/* ------------------------------------------------------------------ claims */

/**
 * Claim this schedule's due slot and run it.
 *
 * Moving `next_run_at` is the claim: only the instance whose update matched the
 * value it read owns the slot, and a customer who paused or edited the schedule
 * in between has changed the row, so nobody runs the stale slot. The next slot
 * is computed from *now*, never from the old slot - a schedule that was due
 * three weeks ago catches up once, not three times in three minutes.
 */
async function startCycle(schedule, now = new Date()) {
  const slot = new Date(schedule.next_run_at);
  const following = sched.nextRunAt(schedule, now);

  if (!following) {
    await prisma.scheduledTopup.updateMany({
      where: { id: schedule.id, status: 'active', next_run_at: schedule.next_run_at },
      data: { status: 'paused', pause_reason: 'invalid_schedule' },
    });
    return null;
  }

  const cycle = sched.cycleKeyFor(schedule.frequency, slot);
  const missed = now.getTime() - slot.getTime() > maxLatenessMs();

  const run = await prisma.$transaction(async tx => {
    const moved = await tx.scheduledTopup.updateMany({
      where: { id: schedule.id, status: 'active', next_run_at: schedule.next_run_at },
      data: { next_run_at: following, last_run_at: now },
    });
    if (!moved.count) return null;

    // ON CONFLICT DO NOTHING rather than create-and-catch: in Postgres a failed
    // INSERT aborts the transaction, and the slot move above must still commit
    // when this cycle turns out to have been bought already.
    const inserted = await tx.scheduledTopupRun.createMany({
      data: [
        {
          schedule_id: schedule.id,
          user_id: schedule.user_id,
          cycle_key: cycle,
          scheduled_for: slot,
          status: missed ? 'skipped' : 'running',
          amount: schedule.amount,
          failure_code: missed ? 'missed' : null,
          failure_message: missed ? MESSAGES.missed : null,
          completed_at: missed ? now : null,
        },
      ],
      skipDuplicates: true,
    });
    if (!inserted.count) return null;

    return tx.scheduledTopupRun.findUnique({
      where: { schedule_id_cycle_key: { schedule_id: schedule.id, cycle_key: cycle } },
    });
  });

  if (!run) return null;

  if (missed) {
    const { what, who } = describe(schedule);
    await notify(
      { ...schedule, next_run_at: following },
      {
        key: `stu:${run.id}:missed`,
        runId: run.id,
        status: 'skipped',
        subject: 'Scheduled top-up missed',
        message:
          `We could not run your ${what} top-up for ${who} on ${sched.lagosLabel(slot)}, and nothing was charged.` +
          ` Next run: ${sched.lagosLabel(following)}.`,
      },
    );
    return { outcome: 'missed' };
  }

  return attemptRun(run, now);
}

async function runDueSchedules(now = new Date()) {
  const due = await withDirectFallback(p => p.scheduledTopup.findMany({
    where: { status: 'active', next_run_at: { lte: now } },
    orderBy: { next_run_at: 'asc' },
    take: batchSize(),
  }));

  let started = 0;
  for (const schedule of due || []) {
    try {
      if (await startCycle(schedule, now)) started += 1;
    } catch (e) {
      console.error('scheduledTopup: cycle failed', { schedule_id: schedule.id, error: e?.message });
    }
  }
  return started;
}

async function runDueRetries(now = new Date()) {
  const due = await withDirectFallback(p => p.scheduledTopupRun.findMany({
    where: { status: 'retrying', next_retry_at: { lte: now } },
    orderBy: { next_retry_at: 'asc' },
    take: batchSize(),
  }));

  let retried = 0;
  for (const run of due || []) {
    try {
      const claimed = await moveRun({ id: run.id, status: 'retrying', attempts: run.attempts }, { status: 'running' });
      if (!claimed) continue;
      retried += 1;
      await attemptRun({ ...run, status: 'running' }, now);
    } catch (e) {
      console.error('scheduledTopup: retry failed', { run_id: run.id, error: e?.message });
    }
  }
  return retried;
}

/* ------------------------------------------------------------------- sync */

/** What the ledger says about an attempt: success, failed (refunded) or open. */
function ledgerState(row) {
  const status = String(row?.meta?.bill_status || '').toLowerCase();
  if (status === 'successful') return 'success';
  if (status === 'failed' || status === 'refunded') return 'failed';
  return 'open';
}

async function closeFromLedger(guard, run, row, now) {
  const state = ledgerState(row);
  if (state === 'open') return null;

  const schedule = await prisma.scheduledTopup.findUnique({ where: { id: run.schedule_id } });
  if (state === 'success') {
    const moved = await moveRun(guard, { status: 'success', completed_at: now });
    if (moved && schedule) await announceSuccess(schedule, run);
    return 'success';
  }
  const moved = await moveRun(guard, {
    status: 'failed',
    failure_code: 'provider_error',
    failure_message: MESSAGES.provider_error,
    completed_at: now,
  });
  if (moved && schedule) await announceRefunded(schedule, run);
  return 'failed';
}

/**
 * Runs the provider accepted as pending follow their ledger row. The bills
 * sweep settles the row on its own five-minute timer; asking here as well
 * (reconcile throttles itself) means the customer's push is minutes late
 * rather than a sweep late.
 */
async function syncProcessingRuns(now = new Date()) {
  const runs = await withDirectFallback(p => p.scheduledTopupRun.findMany({
    where: { status: 'processing' },
    orderBy: { updated_at: 'asc' },
    take: batchSize(),
  }));

  let closed = 0;
  for (const run of runs || []) {
    try {
      if (!run.trx) continue;
      let row = await prisma.walletTransaction.findUnique({ where: { trx: run.trx } });
      if (!row) continue;
      if (ledgerState(row) === 'open') {
        try {
          const outcome = await reconcile(row);
          if (outcome.applied) row = (await prisma.walletTransaction.findUnique({ where: { trx: run.trx } })) || row;
        } catch {
          /* the sweep will ask again */
        }
      }
      if (await closeFromLedger({ id: run.id, status: 'processing' }, run, row, now)) closed += 1;
    } catch (e) {
      console.error('scheduledTopup: sync failed', { run_id: run.id, error: e?.message });
    }
  }
  return closed;
}

/**
 * Runs whose process died mid-attempt. The trx is stamped on the run in the
 * same commit as the ledger row, so the run itself says whether money moved:
 * a trx means look at the ledger, no trx means the attempt never reserved and
 * the cycle can simply go again.
 */
async function recoverStrandedRuns(now = new Date()) {
  const cutoff = new Date(now.getTime() - strandedAfterMs());
  const runs = await withDirectFallback(p => p.scheduledTopupRun.findMany({
    where: { status: 'running', updated_at: { lt: cutoff } },
    orderBy: { updated_at: 'asc' },
    take: batchSize(),
  }));

  let recovered = 0;
  for (const run of runs || []) {
    try {
      // Guarded on the row as read: a worker that is in fact alive bumps
      // updated_at in its reserve, and then this matches nothing.
      const guard = { id: run.id, status: 'running', updated_at: run.updated_at };
      const row = run.trx ? await prisma.walletTransaction.findUnique({ where: { trx: run.trx } }) : null;

      if (row) {
        if (ledgerState(row) === 'open') {
          if (await moveRun(guard, { status: 'processing' })) recovered += 1;
        } else if (await closeFromLedger(guard, run, row, now)) {
          recovered += 1;
        }
        continue;
      }

      const again = Number(run.attempts) < sched.maxAttempts();
      const moved = await moveRun(
        guard,
        again
          ? { status: 'retrying', next_retry_at: now }
          : { status: 'failed', failure_code: 'interrupted', failure_message: MESSAGES.interrupted, completed_at: now },
      );
      if (moved) recovered += 1;
    } catch (e) {
      console.error('scheduledTopup: recovery failed', { run_id: run.id, error: e?.message });
    }
  }
  return recovered;
}

/* --------------------------------------------------------------- reminders */

/**
 * "Notify 1 hour prior to debit". Stamped per cycle before it is sent, guarded
 * on the stamp, so two instances cannot both send it - and with the balance in
 * it, because the whole point is the hour to fund the wallet.
 */
async function sendReminders(now = new Date()) {
  const horizon = new Date(now.getTime() + reminderLeadMs());
  const due = await withDirectFallback(p => p.scheduledTopup.findMany({
    where: { status: 'active', notify_before: true, next_run_at: { gt: now, lte: horizon } },
    orderBy: { next_run_at: 'asc' },
    take: batchSize(),
  }));

  let sent = 0;
  for (const schedule of due || []) {
    try {
      const cycle = sched.cycleKeyFor(schedule.frequency, schedule.next_run_at);
      if (schedule.reminder_cycle === cycle) continue;

      const stamped = await prisma.scheduledTopup.updateMany({
        where: {
          id: schedule.id,
          status: 'active',
          next_run_at: schedule.next_run_at,
          OR: [{ reminder_cycle: null }, { reminder_cycle: { not: cycle } }],
        },
        data: { reminder_cycle: cycle },
      });
      if (!stamped.count) continue;

      const user = await prisma.user.findUnique({ where: { id: Number(schedule.user_id) }, select: { balance: true } });
      const balance = Number(user?.balance?.toString?.() ?? user?.balance ?? 0);
      const { who, what } = describe(schedule);
      const at = lagosDateParts(new Date(schedule.next_run_at));
      const clock = sched.clockLabel(at.hour, at.minute);
      const short = balance < Number(schedule.amount)
        ? ` Your balance is ${sched.nairaLabel(balance)} - fund your wallet before then.`
        : '';

      await notify(schedule, {
        key: `stu:${schedule.id}:${cycle}:reminder`,
        status: 'reminder',
        subject: `Scheduled top-up at ${clock}`,
        message: `${sched.nairaLabel(schedule.amount)} ${what} for ${who} will be bought from your VoltPay wallet at ${clock}.${short}`,
      });
      sent += 1;
    } catch (e) {
      console.error('scheduledTopup: reminder failed', { schedule_id: schedule.id, error: e?.message });
    }
  }
  return sent;
}

/* -------------------------------------------------------------------- tick */

/** One pass. Exported so tests - and anything that wants a manual nudge - can drive it. */
async function tick(now = new Date()) {
  const summary = { started: 0, retried: 0, synced: 0, recovered: 0, reminded: 0 };
  const steps = [
    ['started', runDueSchedules],
    ['retried', runDueRetries],
    ['synced', syncProcessingRuns],
    ['recovered', recoverStrandedRuns],
    ['reminded', sendReminders],
  ];
  // Each step stands alone: a failed reminder scan must not stop a top-up.
  for (const [key, step] of steps) {
    try {
      summary[key] = await step(now);
    } catch (e) {
      console.error(`scheduledTopup: ${key} step failed`, e?.message || e);
    }
  }
  return summary;
}

/**
 * Start the timer. Null when it refused to: disabled by config, the models are
 * missing, or a serverless runtime, where a timer does not survive the response
 * and standing orders would pass in silence.
 *
 * Safe on several instances at once - the claims above are what make it so.
 */
function startScheduledTopupWorker(options = {}) {
  if (!envFlag('SCHEDULED_TOPUPS_ENABLED')) return null;

  const { serverlessHost } = require('./staffpayScheduler.service');
  const host = serverlessHost();
  if (host) {
    console.error(
      `❌ Scheduled top-ups worker refused to start: this looks like a serverless runtime (${host}). ` +
      'It needs an always-on Node process. Leave SCHEDULED_TOPUPS_ENABLED unset here.',
    );
    alerts.captureError('scheduled_topups.serverless', new Error(`Worker blocked on serverless host: ${host}`), { host });
    return null;
  }

  if (!prisma.scheduledTopup || !prisma.scheduledTopupRun) {
    console.log('ℹ️  Scheduled top-ups enabled but the Prisma models are unavailable. Run `npm run ddl:scheduled-topups` and `prisma generate`, then restart.');
    return null;
  }

  const intervalMs = Number(options.intervalMs || process.env.SCHEDULED_TOPUPS_INTERVAL_MS || 60_000);
  let running = false;
  const loop = async () => {
    if (running) return;
    running = true;
    try {
      await tick(new Date());
    } catch (e) {
      alerts.captureError('scheduled_topups.tick', e instanceof Error ? e : new Error(String(e)));
    } finally {
      running = false;
    }
  };

  // Staggered so N instances booting together do not all scan on the same
  // second; the claims would keep them correct, this just keeps them quiet.
  setTimeout(() => loop().catch(() => null), 5_000 + Math.random() * 5_000).unref();
  const timer = setInterval(() => loop().catch(() => null), intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();

  console.log('⏱️  Scheduled top-ups worker started', { tick_interval_ms: intervalMs, batch: batchSize() });
  return { stop: () => clearInterval(timer) };
}

module.exports = {
  startScheduledTopupWorker,
  tick,
  runDueSchedules,
  runDueRetries,
  syncProcessingRuns,
  recoverStrandedRuns,
  sendReminders,
  priceRun,
  PAUSE_MESSAGES,
  MESSAGES,
};
