// Scheduled top-ups: the customer's side - list, preview, create, edit,
// pause, resume, delete, and the run history. The worker that actually buys
// them is services/scheduledTopup.service.js.
//
//   GET    /scheduled-topups               list + summary
//   POST   /scheduled-topups/preview       validate and price; nothing saved
//   POST   /scheduled-topups               create   (PIN)
//   GET    /scheduled-topups/:id           details + recent runs + stats
//   GET    /scheduled-topups/:id/runs      full run history, paged
//   PUT    /scheduled-topups/:id           edit     (PIN)
//   POST   /scheduled-topups/:id/pause
//   POST   /scheduled-topups/:id/resume
//   DELETE /scheduled-topups/:id
//
// Creating or editing one needs the PIN even though no money moves at that
// moment: it authorises every future debit, so a stolen session must not be
// enough to point a weekly top-up at somebody else's number. Pausing and
// deleting only ever reduce what can be spent, so they do not.
//
// Prices follow the bills rule: for data the client sends a plan id and the
// price is read from the live catalogue here - a client-supplied price would
// let anyone schedule a 20,000 naira bundle for 100.
const prisma = require('../../database/prisma');
const { Prisma } = require('@prisma/client');
const bills = require('../funding/billsProvider');
const billsController = require('./bills.controller');
const { verifySecret, encryptValue, reveal, protectText, revealText } = require('../helpers/pii.helper');
const sched = require('../helpers/topupSchedule.helper');
const { priceRun, PAUSE_MESSAGES, MESSAGES } = require('../services/scheduledTopup.service');
const { logUserEvent } = require('../services/userAudit.service');

const HISTORY_PAGE_SIZE = 20;

function ok(res, remark, message, data = null) {
  return res.json({ remark, status: 'success', message: [message], data });
}

function fail(res, status, remark, message, data = null) {
  return res.status(status).json({ remark, status: 'error', message: [message], data });
}

function moneyStr(n) {
  const num = Number(n?.toString?.() ?? n);
  return Number.isFinite(num) ? num.toFixed(2) : '0.00';
}

function scheduleIdOf(req) {
  const id = Number(req.params?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function walletBalance(userId) {
  const row = await prisma.user.findUnique({ where: { id: Number(userId) }, select: { balance: true } });
  return Number(row?.balance?.toString?.() ?? row?.balance ?? 0);
}

function phoneOf(row) {
  try {
    return reveal(row.phone_enc);
  } catch {
    return '';
  }
}

/* ---------------------------------------------------------------- shapes */

function publicRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    cycle_key: run.cycle_key,
    status: run.status,
    amount: moneyStr(run.amount),
    attempts: run.attempts,
    scheduled_for: run.scheduled_for,
    scheduled_label: sched.lagosLabel(run.scheduled_for),
    completed_at: run.completed_at,
    completed_label: run.completed_at ? sched.lagosLabel(run.completed_at) : '',
    next_retry_at: run.status === 'retrying' ? run.next_retry_at : null,
    next_retry_label: run.status === 'retrying' && run.next_retry_at ? sched.lagosLabel(run.next_retry_at) : '',
    failure_code: run.failure_code,
    failure_message: run.failure_message,
    trx: run.trx,
  };
}

/**
 * A schedule as the app shows it. The recipient's number and nickname are the
 * owner's own data, so they come back decrypted - to the owner only; every
 * route below scopes by `user_id` before it reads a row.
 */
function publicSchedule(row, lastRun = null) {
  const phone = phoneOf(row);
  const labels = sched.cadenceLabels(row);
  const active = row.status === 'active';
  return {
    id: row.id,
    reference: `STU-${String(row.id).padStart(6, '0')}`,
    service: row.service,
    service_label: sched.SERVICES[row.service] || row.service,
    provider: row.provider,
    phone,
    phone_display: sched.displayPhone(phone),
    label: revealText(row.label || '') || null,
    amount: moneyStr(row.amount),
    plan_id: row.plan_id,
    plan_name: row.plan_name,
    plan_validity: row.plan_validity,
    frequency: row.frequency,
    day_of_week: row.day_of_week,
    day_of_month: row.day_of_month,
    run_time: row.run_time,
    timezone: row.timezone,
    cadence_short: labels.short,
    cadence_label: labels.long,
    frequency_label: labels.frequency,
    time_label: labels.time,
    status: row.status,
    pause_reason: row.pause_reason,
    pause_message: row.status === 'paused' && row.pause_reason ? PAUSE_MESSAGES[row.pause_reason] || null : null,
    notify_before: row.notify_before,
    next_run_at: active ? row.next_run_at : null,
    next_run_label: active && row.next_run_at ? sched.lagosLabel(row.next_run_at) : '',
    last_run_at: row.last_run_at,
    last_run: publicRun(lastRun),
    created_at: row.created_at,
    created_label: sched.lagosLabel(row.created_at),
  };
}

/* ------------------------------------------------------------- the input */

/**
 * Validate and price a schedule request. Shared by preview, create and edit,
 * so the confirm screen shows exactly what create will save.
 *
 * Returns `{ value }` or `{ error: { status, remark, message } }`.
 */
async function buildSchedule(body) {
  const airtimeRail = await bills.resolve('airtime');
  const minAirtime = billsController.minAmountFor(
    { key: 'airtime', ...billsController.SERVICES.airtime },
    airtimeRail.provider,
  );

  const checked = sched.validateScheduleInput(body, { minAirtime });
  if (!checked.ok) return { error: { status: 400, remark: 'validation_error', message: checked.message } };
  const value = checked.value;

  const { name: gateway, provider: upstream } = await bills.resolve(value.service);

  // The network has to be one this rail sells. A typo saved here would be
  // refused on every run, so it is refused once, now.
  let networks;
  try {
    networks = value.service === 'airtime'
      ? await upstream.listAirtimeProvidersCached()
      : await upstream.listDataProvidersCached();
  } catch (e) {
    return { error: { status: 503, remark: 'provider_unavailable', message: 'This service is briefly unavailable. Please try again shortly.' } };
  }
  if (!(networks || []).some(n => String(n?.name || '').trim().toUpperCase() === value.provider)) {
    return { error: { status: 400, remark: 'validation_error', message: 'Please select a network' } };
  }

  if (value.service === 'data') {
    let plans;
    try {
      plans = await upstream.listDataPlansCached(value.provider);
    } catch (e) {
      return { error: { status: 503, remark: 'provider_unavailable', message: 'Data plans are briefly unavailable. Please try again shortly.' } };
    }
    const plan = (plans || []).find(p => String(p.id) === value.plan_id);
    const price = Number(plan?.amount);
    if (!plan || !Number.isFinite(price) || price <= 0) {
      return { error: { status: 400, remark: 'validation_error', message: 'That data plan is no longer available' } };
    }
    if (price > sched.maxRunAmount()) {
      return {
        error: {
          status: 400,
          remark: 'validation_error',
          message: `A scheduled top-up can be at most NGN ${sched.maxRunAmount().toLocaleString('en-NG')}`,
        },
      };
    }
    // Worded by the same function as the picker and the bills confirmation
    // sheet, so the plan reads identically on every screen.
    const shown = billsController.displayPlan(plan);
    value.amount = price;
    value.plan_name = shown.name;
    value.plan_validity = shown.validity || null;
    // Whose plan id this is. The worker refuses to spend it anywhere else.
    value.plan_gateway = gateway;
  } else {
    value.plan_id = null;
    value.plan_name = null;
    value.plan_validity = null;
    value.plan_gateway = null;
  }

  return { value };
}

/** Same recipient, same thing, same cadence: a double tap, not a second order. */
function sameSchedule(row, value) {
  if (row.service !== value.service || row.provider !== value.provider) return false;
  if (row.frequency !== value.frequency || row.run_time !== value.run_time) return false;
  if ((row.day_of_week ?? null) !== (value.day_of_week ?? null)) return false;
  if ((row.day_of_month ?? null) !== (value.day_of_month ?? null)) return false;
  if (value.service === 'data' ? row.plan_id !== value.plan_id : Number(row.amount) !== Number(value.amount)) return false;
  return phoneOf(row) === value.phone;
}

function columnsFor(value) {
  return {
    service: value.service,
    provider: value.provider,
    phone_enc: encryptValue(value.phone),
    label: value.label ? protectText(value.label) : null,
    amount: new Prisma.Decimal(Number(value.amount).toFixed(2)),
    plan_id: value.plan_id,
    plan_name: value.plan_name,
    plan_validity: value.plan_validity,
    plan_gateway: value.plan_gateway ?? null,
    frequency: value.frequency,
    day_of_week: value.day_of_week,
    day_of_month: value.day_of_month,
    run_time: value.run_time,
    notify_before: value.notify_before,
  };
}

/**
 * The PIN, checked against a fresh row: req.user can come from the user cache,
 * which nulls the hash before caching it.
 */
async function pinIsValid(userId, pin) {
  if (!pin) return false;
  const row = await prisma.user.findUnique({ where: { id: Number(userId) }, select: { pin: true } });
  if (!row) return false;
  return (await verifySecret(pin, row.pin, 'pin')).ok;
}

/**
 * Everything shared by create and edit up to the write: validated, priced,
 * PIN-checked, under the per-customer cap, and not a duplicate. Returns the
 * value to save, or sends the refusal and returns null.
 */
async function prepareWrite(req, res, { exceptId = null } = {}) {
  const userId = Number(req.user.id);

  const pin = String(req.body?.pin || '').trim();
  if (!pin) {
    fail(res, 400, 'validation_error', 'PIN is required');
    return null;
  }

  const built = await buildSchedule(req.body);
  if (built.error) {
    fail(res, built.error.status, built.error.remark, built.error.message);
    return null;
  }

  if (!(await pinIsValid(userId, pin))) {
    fail(res, 401, 'invalid_pin', 'Invalid PIN');
    return null;
  }

  const live = await prisma.scheduledTopup.findMany({
    where: { user_id: userId, status: { not: 'deleted' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
  });
  if (!exceptId && live.length >= sched.maxSchedulesPerUser()) {
    fail(res, 400, 'schedule_limit', `You can have up to ${sched.maxSchedulesPerUser()} scheduled top-ups. Delete one to add another.`);
    return null;
  }
  // A second identical order would buy the same top-up twice every cycle.
  if (live.some(row => sameSchedule(row, built.value))) {
    fail(res, 409, 'duplicate_schedule', 'You already have this exact scheduled top-up.');
    return null;
  }

  return built.value;
}

async function findOwned(req) {
  const id = scheduleIdOf(req);
  if (!id) return null;
  return prisma.scheduledTopup.findFirst({
    where: { id, user_id: Number(req.user.id), status: { not: 'deleted' } },
  });
}

/* --------------------------------------------------------------- handlers */

async function list(req, res) {
  try {
    const userId = Number(req.user.id);
    const rows = await prisma.scheduledTopup.findMany({
      where: { user_id: userId, status: { not: 'deleted' } },
    });

    // Active first, soonest first; then paused, most recently touched first.
    rows.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
      if (a.status === 'active') return new Date(a.next_run_at) - new Date(b.next_run_at);
      return new Date(b.updated_at) - new Date(a.updated_at);
    });

    const ids = rows.map(r => r.id);
    const lastRuns = ids.length
      ? await prisma.scheduledTopupRun.findMany({
          where: { schedule_id: { in: ids } },
          orderBy: [{ schedule_id: 'asc' }, { created_at: 'desc' }],
          distinct: ['schedule_id'],
        })
      : [];
    const lastBySchedule = new Map(lastRuns.map(r => [r.schedule_id, r]));

    const active = rows.filter(r => r.status === 'active');
    const next = active.find(r => r.next_run_at) || null;

    return ok(res, 'scheduled_topups', 'OK', {
      schedules: rows.map(r => publicSchedule(r, lastBySchedule.get(r.id))),
      summary: {
        total: rows.length,
        active: active.length,
        paused: rows.length - active.length,
        next_run_at: next?.next_run_at || null,
        next_run_label: next ? sched.lagosLabel(next.next_run_at) : '',
      },
      wallet_balance: moneyStr(await walletBalance(userId)),
      limits: {
        max_schedules: sched.maxSchedulesPerUser(),
        max_amount: sched.maxRunAmount(),
        retries: sched.maxAttempts() - 1,
      },
    });
  } catch (e) {
    console.error('scheduledTopup.list error:', { user_id: req.user?.id, message: e?.message });
    return fail(res, 500, 'error', 'Could not load your scheduled top-ups');
  }
}

async function preview(req, res) {
  try {
    const built = await buildSchedule(req.body);
    if (built.error) return fail(res, built.error.status, built.error.remark, built.error.message);

    const v = built.value;
    const firstRun = sched.nextRunAt(v, new Date());
    const balance = await walletBalance(req.user.id);
    const labels = sched.cadenceLabels(v);
    const retries = sched.maxAttempts() - 1;

    return ok(res, 'scheduled_topup_preview', 'Review your schedule', {
      service: v.service,
      service_label: sched.SERVICES[v.service],
      provider: v.provider,
      phone: v.phone,
      phone_display: sched.displayPhone(v.phone),
      label: v.label,
      amount: moneyStr(v.amount),
      plan_id: v.plan_id,
      plan_name: v.plan_name,
      plan_validity: v.plan_validity,
      frequency: v.frequency,
      day_of_week: v.day_of_week,
      day_of_month: v.day_of_month,
      run_time: v.run_time,
      notify_before: v.notify_before,
      cadence_short: labels.short,
      cadence_label: labels.long,
      frequency_label: labels.frequency,
      time_label: labels.time,
      first_run_at: firstRun,
      first_run_label: sched.lagosLabel(firstRun),
      first_run_date_label: sched.lagosDateLabel(firstRun),
      fee: '0.00',
      wallet_balance: moneyStr(balance),
      sufficient_balance: balance >= Number(v.amount),
      failure_rule: retries > 0
        ? `Retry ${retries}x if balance is low, then notify you instantly`
        : 'Notify you instantly if a run fails',
    });
  } catch (e) {
    console.error('scheduledTopup.preview error:', { user_id: req.user?.id, message: e?.message });
    return fail(res, 500, 'error', 'Could not check this schedule');
  }
}

async function create(req, res) {
  try {
    const value = await prepareWrite(req, res);
    if (!value) return undefined;

    const userId = Number(req.user.id);
    const row = await prisma.scheduledTopup.create({
      data: {
        user_id: userId,
        ...columnsFor(value),
        status: 'active',
        next_run_at: sched.nextRunAt(value, new Date()),
      },
    });

    // Ids and amounts only - the recipient's number never goes in the trail.
    await logUserEvent({
      req,
      userId,
      event: 'scheduled_topup.created',
      metadata: {
        schedule_id: row.id,
        service: row.service,
        provider: row.provider,
        amount: Number(value.amount),
        frequency: row.frequency,
      },
    });

    return ok(res, 'scheduled_topup_created', 'Schedule created', {
      schedule: publicSchedule(row),
      wallet_balance: moneyStr(await walletBalance(userId)),
    });
  } catch (e) {
    console.error('scheduledTopup.create error:', { user_id: req.user?.id, message: e?.message });
    return fail(res, 500, 'error', 'Could not create this schedule');
  }
}

async function update(req, res) {
  try {
    const existing = await findOwned(req);
    if (!existing) return fail(res, 404, 'not_found', 'Schedule not found');

    const value = await prepareWrite(req, res, { exceptId: existing.id });
    if (!value) return undefined;

    // A pause the worker made (plan withdrawn, price rose, number refused) is
    // asking for exactly this edit, so the edit lifts it. A pause the customer
    // made is theirs to lift with Resume.
    const lift = existing.status === 'paused' && Boolean(existing.pause_reason);
    const status = existing.status === 'active' || lift ? 'active' : 'paused';

    const row = await prisma.scheduledTopup.update({
      where: { id: existing.id },
      data: {
        ...columnsFor(value),
        status,
        pause_reason: status === 'active' ? null : existing.pause_reason,
        next_run_at: sched.nextRunAt(value, new Date()),
        reminder_cycle: null,
      },
    });

    await logUserEvent({
      req,
      userId: req.user.id,
      event: 'scheduled_topup.updated',
      metadata: { schedule_id: row.id, service: row.service, amount: Number(value.amount), frequency: row.frequency },
    });

    return ok(res, 'scheduled_topup_updated', 'Schedule updated', { schedule: publicSchedule(row) });
  } catch (e) {
    console.error('scheduledTopup.update error:', { user_id: req.user?.id, message: e?.message });
    return fail(res, 500, 'error', 'Could not update this schedule');
  }
}

async function show(req, res) {
  try {
    const row = await findOwned(req);
    if (!row) return fail(res, 404, 'not_found', 'Schedule not found');

    const [recent, grouped, disbursed] = await Promise.all([
      prisma.scheduledTopupRun.findMany({
        where: { schedule_id: row.id },
        orderBy: { scheduled_for: 'desc' },
        take: 5,
      }),
      prisma.scheduledTopupRun.groupBy({
        by: ['status'],
        where: { schedule_id: row.id },
        _count: { _all: true },
      }),
      prisma.scheduledTopupRun.aggregate({
        where: { schedule_id: row.id, status: 'success' },
        _sum: { amount: true },
      }),
    ]);

    const count = status => grouped.find(g => g.status === status)?._count?._all || 0;
    const successful = count('success');
    const failed = count('failed');

    return ok(res, 'scheduled_topup', 'OK', {
      schedule: publicSchedule(row, recent[0] || null),
      recent_runs: recent.map(publicRun),
      stats: {
        successful_runs: successful,
        failed_runs: failed,
        total_runs: grouped.reduce((n, g) => n + (g._count?._all || 0), 0),
        // Over runs that reached an outcome. Null until one has, so the screen
        // can say "no runs yet" instead of a 0% that never happened.
        success_rate: successful + failed > 0 ? Math.round((successful / (successful + failed)) * 100) : null,
        total_disbursed: moneyStr(disbursed?._sum?.amount ?? 0),
      },
      wallet_balance: moneyStr(await walletBalance(req.user.id)),
    });
  } catch (e) {
    console.error('scheduledTopup.show error:', { user_id: req.user?.id, message: e?.message });
    return fail(res, 500, 'error', 'Could not load this schedule');
  }
}

async function runs(req, res) {
  try {
    const row = await findOwned(req);
    if (!row) return fail(res, 404, 'not_found', 'Schedule not found');

    const page = Math.max(1, Number.parseInt(req.query?.page, 10) || 1);
    const rows = await prisma.scheduledTopupRun.findMany({
      where: { schedule_id: row.id },
      orderBy: { scheduled_for: 'desc' },
      skip: (page - 1) * HISTORY_PAGE_SIZE,
      // One extra tells the app whether there is another page without a count.
      take: HISTORY_PAGE_SIZE + 1,
    });

    return ok(res, 'scheduled_topup_runs', 'OK', {
      runs: rows.slice(0, HISTORY_PAGE_SIZE).map(publicRun),
      page,
      has_more: rows.length > HISTORY_PAGE_SIZE,
    });
  } catch (e) {
    console.error('scheduledTopup.runs error:', { user_id: req.user?.id, message: e?.message });
    return fail(res, 500, 'error', 'Could not load the run history');
  }
}

async function pause(req, res) {
  try {
    const row = await findOwned(req);
    if (!row) return fail(res, 404, 'not_found', 'Schedule not found');

    if (row.status === 'active') {
      // The customer's own pause, so no reason is recorded: Resume lifts it.
      await prisma.scheduledTopup.updateMany({
        where: { id: row.id, status: 'active' },
        data: { status: 'paused', pause_reason: null },
      });
      await logUserEvent({ req, userId: req.user.id, event: 'scheduled_topup.paused', metadata: { schedule_id: row.id } });
    }

    const fresh = await prisma.scheduledTopup.findUnique({ where: { id: row.id } });
    return ok(res, 'scheduled_topup_paused', 'Schedule paused', { schedule: publicSchedule(fresh) });
  } catch (e) {
    console.error('scheduledTopup.pause error:', { user_id: req.user?.id, message: e?.message });
    return fail(res, 500, 'error', 'Could not pause this schedule');
  }
}

async function resume(req, res) {
  try {
    const row = await findOwned(req);
    if (!row) return fail(res, 404, 'not_found', 'Schedule not found');

    if (row.status !== 'active') {
      // Resuming a schedule that cannot run would only fail again at 07:00
      // tomorrow. The same pricing the worker uses says so now - except when
      // the catalogue itself is down, which is our outage, not their schedule.
      const priced = await priceRun(row);
      if (!priced.ok && priced.code !== 'service_unavailable') {
        return fail(
          res,
          409,
          priced.code,
          PAUSE_MESSAGES[priced.code] || priced.message || MESSAGES[priced.code] || 'Edit this schedule before resuming it.',
        );
      }

      const nextRun = sched.nextRunAt(row, new Date());
      if (!nextRun) return fail(res, 409, 'invalid_schedule', PAUSE_MESSAGES.invalid_schedule);

      await prisma.scheduledTopup.updateMany({
        where: { id: row.id, status: 'paused' },
        data: { status: 'active', pause_reason: null, next_run_at: nextRun, reminder_cycle: null },
      });
      await logUserEvent({ req, userId: req.user.id, event: 'scheduled_topup.resumed', metadata: { schedule_id: row.id } });
    }

    const fresh = await prisma.scheduledTopup.findUnique({ where: { id: row.id } });
    return ok(res, 'scheduled_topup_resumed', 'Schedule resumed', { schedule: publicSchedule(fresh) });
  } catch (e) {
    console.error('scheduledTopup.resume error:', { user_id: req.user?.id, message: e?.message });
    return fail(res, 500, 'error', 'Could not resume this schedule');
  }
}

async function remove(req, res) {
  try {
    const row = await findOwned(req);
    if (!row) return fail(res, 404, 'not_found', 'Schedule not found');

    // Soft, so the run history stays joined to something - but the recipient's
    // number and nickname go now. Nothing reads them once it is deleted, and a
    // third party's phone number is not ours to keep for no reason.
    await prisma.scheduledTopup.updateMany({
      where: { id: row.id, user_id: Number(req.user.id) },
      data: { status: 'deleted', deleted_at: new Date(), next_run_at: null, phone_enc: '', label: null },
    });
    await logUserEvent({ req, userId: req.user.id, event: 'scheduled_topup.deleted', metadata: { schedule_id: row.id } });

    return ok(res, 'scheduled_topup_deleted', 'Schedule deleted', { id: row.id });
  } catch (e) {
    console.error('scheduledTopup.remove error:', { user_id: req.user?.id, message: e?.message });
    return fail(res, 500, 'error', 'Could not delete this schedule');
  }
}

module.exports = {
  list,
  preview,
  create,
  update,
  show,
  runs,
  pause,
  resume,
  remove,
  // exported for tests
  publicSchedule,
  buildSchedule,
};
