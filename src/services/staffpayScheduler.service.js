/**
 * Automatic payroll: the thing that makes payday happen without anybody
 * pressing a button.
 *
 * A tick, once a minute:
 *   1. every company with auto_pay_enabled, paged by id cursor
 *   2. whose payout_time has been reached in its own timezone
 *   3. with no run already in flight
 *   4. whose staff are due (helpers/staffpayDue.helper.js - paged, no cap)
 *   5. and which is verified + subscribed; if it is not, the owner is told
 *      once a day rather than silently skipped
 * then syncs in-flight runs and retries the ones whose backoff has elapsed.
 *
 * Money rules that must not be relaxed:
 *   - Every item this creates carries a cycle key, so the database refuses a
 *     second payment for the same staff member on the same payday no matter
 *     how many instances are running. This is the only safe way to run more
 *     than one copy of the API.
 *   - This is a timer in a long-running process. On a serverless host it will
 *     not fire reliably and payday would pass in silence, so it refuses to
 *     start there instead of pretending to work.
 */
const os = require('os');
const prisma = require('../../database/prisma');

const {
  createPayrollRunForCompany,
  syncPayrollRunById,
  retryDueFailedRuns,
  recoverStrandedRuns,
} = require('./staffpayPayroll.service');
const {
  nextDueAtUtc,
  companyPayoutTimeReached,
  listDueStaff,
  chunk,
} = require('../helpers/staffpayDue.helper');
const { withDirectFallback } = require('../helpers/prismaDirect.helper');
const { getAccessState } = require('../helpers/staffpayAccess.helper');
const { notifyUser } = require('./notify.service');
const { captureError } = require('./alerts.service');

const HEARTBEAT_KEY = 'staffpay_scheduler_heartbeat';

// A `setInterval` needs a process that stays alive between requests. These
// hosts freeze or discard one after the response, so the timer is a lie there:
// no tick, no payroll, no error either - which is the failure nobody notices
// until a business calls to ask where the salaries are.
const SERVERLESS_ENV_KEYS = [
  'VERCEL',
  'AWS_LAMBDA_FUNCTION_NAME',
  'LAMBDA_TASK_ROOT',
  'FUNCTIONS_WORKER_RUNTIME',
  'NETLIFY',
  'K_SERVICE',
];

function serverlessHost() {
  return SERVERLESS_ENV_KEYS.find(key => String(process.env[key] || '').trim()) || null;
}

function instanceId() {
  const host = process.env.RENDER_INSTANCE_ID || process.env.FLY_MACHINE_ID || process.env.HOSTNAME || os.hostname();
  return `${host}:${process.pid}`;
}

function envFlag(name) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  return raw === 'true' || raw === '1';
}

/**
 * Last tick, readable by the admin dashboard.
 *
 * In AppSetting rather than memory because the dashboard may well be answered
 * by a different instance than the one running the timer - and because "the
 * scheduler stopped an hour ago" has to survive the restart that hid it.
 */
async function writeHeartbeat(payload) {
  const value = JSON.stringify({ at: new Date().toISOString(), instance: instanceId(), ...payload });
  try {
    await prisma.appSetting.upsert({
      where: { setting_key: HEARTBEAT_KEY },
      update: { setting_value: value },
      create: {
        setting_key: HEARTBEAT_KEY,
        setting_value: value,
        description: 'Last StaffPay scheduler tick (written by the scheduler, read by admin)',
      },
    });
  } catch (e) {
    // A heartbeat that cannot be written must never stop a payroll.
    console.error('StaffPay scheduler: heartbeat write failed:', e?.message || e);
  }
}

async function readHeartbeat() {
  try {
    const row = await prisma.appSetting.findUnique({
      where: { setting_key: HEARTBEAT_KEY },
      select: { setting_value: true, updated_at: true },
    });
    if (!row?.setting_value) return null;
    return JSON.parse(row.setting_value);
  } catch (_) {
    return null;
  }
}

/**
 * Why a company that had staff due was not paid, in words its owner can act
 * on. One message per company per reason per day: the tick repeats every
 * minute, and a push a minute is how a real warning gets muted.
 */
const SKIP_NOTICES = {
  not_verified: count =>
    `Automatic payroll did not run: your business verification is not approved yet, and ${count} staff member(s) are due to be paid. Complete verification to release the payment.`,
  subscription_expired: count =>
    `Automatic payroll did not run: your StaffPay subscription is not active, and ${count} staff member(s) are due to be paid. Renew to release the payment.`,
};

function startStaffPayScheduler(options = {}) {
  if (!envFlag('STAFFPAY_SCHEDULER_ENABLED')) return null;

  const host = serverlessHost();
  if (host) {
    console.error(
      `❌ StaffPay scheduler refused to start: this looks like a serverless runtime (${host}). ` +
      'Automatic payroll needs an always-on Node process (a worker/web service that is not frozen between requests). ' +
      'Deploy the scheduler on one and leave STAFFPAY_SCHEDULER_ENABLED unset here.',
    );
    captureError('staffpay.scheduler_serverless', new Error(`Scheduler blocked on serverless host: ${host}`), { host });
    return null;
  }

  const debug = envFlag('STAFFPAY_SCHEDULER_DEBUG');

  if (!prisma.staffPayPayrollRun || !prisma.staffPayPayrollItem) {
    console.log('ℹ️  StaffPay scheduler enabled but Prisma StaffPay models are unavailable. Run prisma generate + migrate/db push and restart the server.');
    return null;
  }

  const intervalMs = Number(options.intervalMs || process.env.STAFFPAY_SYNC_INTERVAL_MS || 60_000);
  const limit = Number(options.limit || process.env.STAFFPAY_SYNC_BATCH_LIMIT || 10);
  // Staff per run. A run's transfers are submitted one after another, so an
  // unbounded batch would hold the tick for as long as the whole company takes
  // to pay. Everyone still gets paid - the remainder is picked up next tick.
  const batchSize = Math.max(1, Number(options.batchSize || process.env.STAFFPAY_PAYROLL_BATCH_SIZE || 200));

  const autoPayEnabled = envFlag('STAFFPAY_AUTOPAY_ENABLED');
  const autoPayIntervalMs = Number(options.autoPayIntervalMs || process.env.STAFFPAY_AUTOPAY_INTERVAL_MS || intervalMs);
  let lastAutoPayAt = 0;
  let autoPayCursor = 0;
  // `${company_id}:${reason}` -> yyyy-mm-dd of the last notice. In-process
  // only, so a restart sends one more - cheaper than a Redis key for a
  // once-a-day message.
  const noticeSentOn = new Map();

  async function noticeOnceToday({ companyId, ownerUserId, reason, subject, message }) {
    const key = `${Number(companyId)}:${reason}`;
    const today = new Date().toISOString().slice(0, 10);
    if (noticeSentOn.get(key) === today) return;
    noticeSentOn.set(key, today);
    await notifyUser({
      userId: Number(ownerUserId),
      subject,
      message,
      type: 'staffpay',
      data: { company_id: Number(companyId), reason },
    }).catch(() => null);
  }

  console.log('⏱️  StaffPay scheduler started', {
    enabled: true,
    debug,
    instance: instanceId(),
    tick_interval_ms: intervalMs,
    sync_batch_limit: limit,
    payroll_batch_size: batchSize,
    autopay_enabled: autoPayEnabled,
    autopay_interval_ms: autoPayIntervalMs,
  });

  let running = false;

  /** One company's payday. Returns the number of runs it created. */
  async function payCompany(company) {
    if (!companyPayoutTimeReached(company)) {
      if (debug) console.log('StaffPay scheduler: payout_time not reached', { company_id: company?.id });
      return 0;
    }

    const hasActiveRun = await withDirectFallback(p => p.staffPayPayrollRun.findFirst({
      where: {
        company_id: Number(company.id),
        status: { in: ['preparing', 'queued', 'processing'] },
      },
      select: { id: true },
    }));
    if (hasActiveRun) return 0;

    // Due staff are read before the access gate so a lapsed subscription only
    // notifies a company that actually had somebody to pay today.
    const due = await listDueStaff({ companyId: company.id });
    if (!due.length) return 0;

    // Automatic payroll obeys the same gate as the button: verified business,
    // live subscription. Silence here was the old behaviour and it left owners
    // guessing why payday passed.
    const access = await getAccessState(Number(company.id));
    if (!access.can_use_staffpay) {
      const reason = access.verification_status === 'approved' ? 'subscription_expired' : 'not_verified';
      await noticeOnceToday({
        companyId: company.id,
        ownerUserId: company.owner_user_id,
        reason,
        subject: 'Automatic payroll was not run',
        message: SKIP_NOTICES[reason](due.length),
      });
      if (debug) console.log('StaffPay scheduler: company not eligible', { company_id: company?.id, reason });
      return 0;
    }

    const batches = chunk(due, batchSize);
    const today = new Date().toISOString().slice(0, 10);
    let created = 0;

    for (let i = 0; i < batches.length; i += 1) {
      const batch = batches[i];
      const title = batches.length > 1
        ? `Auto staff salary payout (${today}) ${i + 1}/${batches.length}`
        : `Auto staff salary payout (${today})`;

      try {
        await createPayrollRunForCompany({
          company,
          staffIds: batch.map(d => d.id),
          cycleKeys: new Map(batch.map(d => [d.id, d.cycle_key])),
          title,
          mode: 'auto',
        });
        created += 1;
      } catch (e) {
        // A shortfall is the business's problem to fix, not an outage - tell
        // the owner instead of retrying into the same wall, and stop here:
        // later batches cannot pass a balance check this one just failed.
        if (e?.remark === 'insufficient_balance') {
          await noticeOnceToday({
            companyId: company.id,
            ownerUserId: company.owner_user_id,
            reason: 'insufficient_balance',
            subject: 'Automatic payroll could not run',
            message: e.message,
          });
          break;
        }

        // Another instance is already paying this cycle. Nothing was debited.
        if (e?.remark === 'payroll_cycle_already_run') {
          if (debug) console.log('StaffPay scheduler: cycle already claimed elsewhere', { company_id: company?.id });
          continue;
        }

        console.error('StaffPay scheduler: auto payroll batch error:', company?.id, e?.message || e);
      }
    }

    return created;
  }

  const tick = async () => {
    if (running) return;
    running = true;
    let companiesSeen = 0;
    let runsCreated = 0;
    try {
      const now = Date.now();
      if (autoPayEnabled && now - lastAutoPayAt >= autoPayIntervalMs) {
        lastAutoPayAt = now;
        try {
          // A flat `take: 50` meant company 51 was never paid and nothing said
          // so. The cursor rolls across ticks instead: a payday window is hours
          // wide and a tick is a minute, so every company still gets reached.
          const companies = await withDirectFallback(p => p.staffPayCompany.findMany({
            where: { auto_pay_enabled: true, id: { gt: autoPayCursor } },
            select: { id: true, owner_user_id: true, name_enc: true, payout_time: true, payout_timezone: true },
            take: 50,
            orderBy: { id: 'asc' },
          }));

          autoPayCursor = companies.length === 50 ? Number(companies[companies.length - 1].id) : 0;
          companiesSeen = companies.length;

          for (const company of companies || []) {
            try {
              runsCreated += await payCompany(company);
            } catch (e) {
              console.error('StaffPay scheduler: auto payroll company tick error:', company?.id, e?.message || e);
            }
          }
        } catch (e) {
          console.error('StaffPay scheduler: auto payroll tick error:', e?.message || e);
        }
      }

      const runs = await withDirectFallback(p => p.staffPayPayrollRun.findMany({
        where: {
          status: { in: ['preparing', 'queued', 'processing'] },
        },
        orderBy: { id: 'asc' },
        take: limit,
        select: { id: true },
      }));

      for (const r of runs || []) {
        try {
          await syncPayrollRunById(r.id);
        } catch (e) {
          console.error('StaffPay scheduler: sync run failed', r?.id, e?.message || e);
        }
      }

      // Failed transfers get their own backoff, so this only picks up runs whose
      // timer has actually elapsed - most ticks find nothing.
      try {
        const retried = await retryDueFailedRuns({ limit });
        if (debug && retried.attempted) console.log('StaffPay scheduler: auto-retried runs', retried);
      } catch (e) {
        console.error('StaffPay scheduler: auto-retry tick error:', e?.message || e);
      }

      // A run whose process died keeps its company's money reserved and blocks
      // the next payday, so every instance sweeps for abandoned runs.
      try {
        const rescued = await recoverStrandedRuns({ limit });
        if (rescued.recovered) console.warn('StaffPay scheduler: recovered stranded runs', rescued);
      } catch (e) {
        console.error('StaffPay scheduler: stranded-run sweep error:', e?.message || e);
      }
    } catch (e) {
      console.error('StaffPay scheduler tick error:', e?.message || e);
    } finally {
      running = false;
      await writeHeartbeat({
        autopay_enabled: autoPayEnabled,
        companies_scanned: companiesSeen,
        runs_created: runsCreated,
        tick_interval_ms: intervalMs,
      });
    }
  };

  tick().catch(() => null);
  const timer = setInterval(() => tick().catch(() => null), intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();

  return {
    stop: () => clearInterval(timer),
  };
}

module.exports = {
  startStaffPayScheduler,
  syncPayrollRunById,
  // Re-exported: the dashboard controller and the payday tests have always
  // imported it from here.
  nextDueAtUtc,
  serverlessHost,
  readHeartbeat,
  HEARTBEAT_KEY,
};
