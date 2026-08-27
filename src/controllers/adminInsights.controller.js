// The three screens that answer "is the platform well", rather than "where is
// this one payment".
//
//   health - is every dependency answering, and is the scheduler still ticking
//   sla    - is support keeping up
//   growth - are new accounts turning into paying ones
//
// Read-only throughout. The health check deliberately reports configuration
// presence, never configuration values: "PAYSTACK_SECRET_KEY is set" is useful
// on a screen, and the key itself is a breach.

const prisma = require('../../database/prisma');

const redis = require('../services/redis.service');
const { readHeartbeat } = require('../services/staffpayScheduler.service');
const { isEnabled: alertsEnabled } = require('../services/alerts.service');
const { listFeatures } = require('../helpers/featureFlag.helper');
const { isEnabled: velocityEnabled } = require('../helpers/velocity.helper');

function ok(res, remark, data) {
  return res.json({ remark, status: 'success', data });
}

function fail(res, code, message) {
  return res.status(code).json({ remark: 'error', status: 'error', message: [message], data: null });
}

function daysAgo(days) {
  return new Date(Date.now() - Number(days) * 86_400_000);
}

// ---------------------------------------------------------------------------
// system health
// ---------------------------------------------------------------------------

// Every secret the platform needs to move money, by the thing it powers. The
// VALUE is never read - only whether it is a non-empty string - so this list
// can live in code without becoming a place secrets leak from.
const REQUIRED_ENV = [
  { group: 'Security', keys: ['PII_HASH_KEY', 'PII_ENC_KEY', 'JWT_SECRET'] },
  { group: 'Database', keys: ['DATABASE_URL', 'DIRECT_URL'] },
  { group: 'Payments', keys: ['PAYSTACK_SECRET_KEY', 'PAIRGATE_API_KEY', 'PAYMENTPOINT_API_KEY'] },
  { group: 'Messaging', keys: ['BREVO_API_KEY', 'FIREBASE_PROJECT_ID'] },
  { group: 'Cache', keys: ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'] },
];

function envPresence() {
  return REQUIRED_ENV.map(g => ({
    group: g.group,
    keys: g.keys.map(k => ({ key: k, set: Boolean(String(process.env[k] || '').trim()) })),
  }));
}

async function timed(label, fn) {
  const started = Date.now();
  try {
    const value = await fn();
    return { name: label, up: true, ms: Date.now() - started, detail: value ?? null };
  } catch (e) {
    return { name: label, up: false, ms: Date.now() - started, detail: String(e?.message || e).slice(0, 160) };
  }
}

/**
 * One board, every dependency.
 *
 * Redis being down is reported as degraded rather than down on purpose: every
 * call site in this codebase fails open to Postgres or to an in-process Map, so
 * a cache outage is slower, not broken. Reporting it as an outage would train
 * whoever is on call to ignore the one colour that should mean "stop".
 */
async function getHealth(req, res) {
  try {
    const [database, cache, scheduler, features] = await Promise.all([
      timed('PostgreSQL', async () => {
        await prisma.$queryRaw`SELECT 1`;
        return 'reachable';
      }),
      timed('Redis (Upstash)', async () => {
        if (!redis.isEnabled()) return 'not configured - running without cache';
        const pong = await redis.ping();
        if (!pong) throw new Error('no response');
        return 'reachable';
      }),
      timed('StaffPay scheduler', async () => {
        const beat = await readHeartbeat();
        if (!beat) return 'no heartbeat recorded yet';
        return beat;
      }),
      listFeatures().catch(() => []),
    ]);

    // A heartbeat that stopped is worse than one that never started - the first
    // means payroll silently stopped running, the second means it was never
    // switched on. Both need saying, differently.
    const beatAt = scheduler.detail?.at || scheduler.detail?.last_run_at || null;
    const beatAgeMinutes = beatAt ? Math.round((Date.now() - new Date(beatAt).getTime()) / 60_000) : null;

    const services = [
      database,
      { ...cache, degraded: !cache.up || !redis.isEnabled() },
      {
        ...scheduler,
        up: scheduler.up && (beatAgeMinutes == null || beatAgeMinutes < 90),
        stale_minutes: beatAgeMinutes,
      },
    ];

    const disabledFeatures = (features || []).filter(f => !f.enabled);

    return ok(res, 'admin_health', {
      services,
      env: envPresence(),
      // Everything that changes behaviour without a deploy, in one place.
      switches: {
        alerts_webhook: alertsEnabled(),
        velocity_limits: velocityEnabled(),
        redis: redis.isEnabled(),
        static_admin_keys: String(process.env.ADMIN_ALLOW_STATIC_KEYS ?? '1').trim() !== '0',
        timezone: process.env.APP_TIMEZONE || 'system default',
        node_env: process.env.NODE_ENV || 'development',
      },
      features,
      disabled_features: disabledFeatures.map(f => f.slug),
      checked_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('adminInsights.getHealth error', e);
    return fail(res, 500, 'Failed to read system health');
  }
}

// ---------------------------------------------------------------------------
// support SLA
// ---------------------------------------------------------------------------

const OPEN = 0;
const IN_PROGRESS = 1;
const RESOLVED = 2;

// The clock an admin is judged by. Both in hours, both policy rather than
// physics, so both come from the environment.
function slaTargets() {
  return {
    first_response_hours: Number(process.env.SUPPORT_FIRST_RESPONSE_HOURS || 4),
    resolution_hours: Number(process.env.SUPPORT_RESOLUTION_HOURS || 48),
  };
}

/**
 * Is support keeping up.
 *
 * First response is measured from the ticket to the first message on it that
 * was NOT written by the person who opened it. That distinction is the whole
 * measurement: a ticket where the user has replied four times and nobody has
 * answered would otherwise score as a four-minute first response.
 */
async function getSupportSla(req, res) {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '30', 10), 1), 365);
    const since = daysAgo(days);
    const targets = slaTargets();

    const tickets = await prisma.supportTicket.findMany({
      where: { created_at: { gte: since } },
      select: {
        id: true,
        ticket: true,
        user_id: true,
        status: true,
        priority: true,
        created_at: true,
        resolved_at: true,
        last_reply: true,
        rating: true,
        messages: {
          orderBy: { created_at: 'asc' },
          select: { created_at: true, is_admin: true, is_internal: true },
        },
      },
      orderBy: { created_at: 'desc' },
    });

    let firstResponseTotal = 0;
    let firstResponseCount = 0;
    let firstResponseBreached = 0;
    let resolutionTotal = 0;
    let resolutionCount = 0;
    let resolutionBreached = 0;
    let awaiting = 0;

    const breaching = [];

    for (const t of tickets) {
      // An internal note is not a reply. It is written by an admin, on the
      // ticket, at a time that would score beautifully - and the customer never
      // saw it. Counting one as a first response is how an SLA dashboard ends
      // up reporting green while people wait.
      const firstAdmin = (t.messages || []).find(m => m.is_admin === true && m.is_internal !== true);

      if (firstAdmin) {
        const hours = (new Date(firstAdmin.created_at) - new Date(t.created_at)) / 3_600_000;
        firstResponseTotal += hours;
        firstResponseCount += 1;
        if (hours > targets.first_response_hours) firstResponseBreached += 1;
      } else if (t.status === OPEN || t.status === IN_PROGRESS) {
        awaiting += 1;
        const waitingHours = (Date.now() - new Date(t.created_at).getTime()) / 3_600_000;
        if (waitingHours > targets.first_response_hours) {
          breaching.push({
            id: t.id,
            ticket: t.ticket,
            user_id: t.user_id,
            priority: t.priority,
            status: t.status,
            waiting_hours: Math.round(waitingHours * 10) / 10,
            created_at: t.created_at,
          });
        }
      }

      if (t.resolved_at) {
        const hours = (new Date(t.resolved_at) - new Date(t.created_at)) / 3_600_000;
        resolutionTotal += hours;
        resolutionCount += 1;
        if (hours > targets.resolution_hours) resolutionBreached += 1;
      }
    }

    breaching.sort((a, b) => b.waiting_hours - a.waiting_hours);

    const rated = tickets.filter(t => t.rating != null);
    const avgRating = rated.length ? rated.reduce((s, t) => s + Number(t.rating), 0) / rated.length : null;

    const round = n => Math.round(n * 10) / 10;
    const pct = (part, whole) => (whole ? Math.round(((whole - part) / whole) * 1000) / 10 : null);

    return ok(res, 'admin_support_sla', {
      days,
      targets,
      volume: tickets.length,
      open: tickets.filter(t => t.status === OPEN).length,
      in_progress: tickets.filter(t => t.status === IN_PROGRESS).length,
      resolved: tickets.filter(t => t.status >= RESOLVED).length,
      awaiting_first_reply: awaiting,
      first_response: {
        measured: firstResponseCount,
        avg_hours: firstResponseCount ? round(firstResponseTotal / firstResponseCount) : null,
        breached: firstResponseBreached,
        met_pct: pct(firstResponseBreached, firstResponseCount),
      },
      resolution: {
        measured: resolutionCount,
        avg_hours: resolutionCount ? round(resolutionTotal / resolutionCount) : null,
        breached: resolutionBreached,
        met_pct: pct(resolutionBreached, resolutionCount),
      },
      satisfaction: { rated: rated.length, avg_rating: avgRating ? Math.round(avgRating * 10) / 10 : null },
      breaching: breaching.slice(0, 25),
    });
  } catch (e) {
    console.error('adminInsights.getSupportSla error', e);
    return fail(res, 500, 'Failed to load support metrics');
  }
}

// ---------------------------------------------------------------------------
// growth
// ---------------------------------------------------------------------------

const DELETED = 3;

/**
 * Signups, and what became of them.
 *
 * Activation is the number that matters and the one nothing currently reports:
 * an account that signed up and never transacted cost money to acquire and
 * earns nothing. Measured as "has at least one ledger row", which is the same
 * definition the ledger itself would give.
 */
async function getGrowth(req, res) {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '30', 10), 1), 365);
    const since = daysAgo(days);

    const [signups, transactors, totalUsers, kycVerified, priorSignups] = await Promise.all([
      prisma.user.findMany({
        where: { created_at: { gte: since }, status: { not: DELETED } },
        select: { id: true, created_at: true },
        orderBy: { created_at: 'asc' },
      }),
      // One row per user who has ever transacted in the window. groupBy rather
      // than distinct so the count comes back with the aggregate.
      prisma.walletTransaction.groupBy({
        by: ['user_id'],
        where: { created_at: { gte: since } },
        _count: { _all: true },
      }),
      prisma.user.count({ where: { status: { not: DELETED } } }),
      prisma.kycVerification.count({ where: { status: 'verified' } }),
      // The equivalent window immediately before this one, for a trend arrow.
      prisma.user.count({
        where: { created_at: { gte: daysAgo(days * 2), lt: since }, status: { not: DELETED } },
      }),
    ]);

    const transactorIds = new Set(transactors.map(t => t.user_id));
    const signupIds = signups.map(s => s.id);
    const activated = signupIds.filter(id => transactorIds.has(id)).length;

    const series = new Map();
    for (const row of signups) {
      const key = new Date(row.created_at).toISOString().slice(0, 10);
      series.set(key, (series.get(key) || 0) + 1);
    }

    const daily = [...series.entries()]
      .map(([date, count]) => ({ date, signups: count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const change = priorSignups ? Math.round(((signups.length - priorSignups) / priorSignups) * 1000) / 10 : null;

    return ok(res, 'admin_growth', {
      days,
      total_users: totalUsers,
      signups: signups.length,
      signups_prior_period: priorSignups,
      signups_change_pct: change,
      activated,
      activation_rate: signups.length ? Math.round((activated / signups.length) * 1000) / 10 : null,
      active_transactors: transactorIds.size,
      // Share of the whole base that moved money in the window, not of signups.
      engaged_rate: totalUsers ? Math.round((transactorIds.size / totalUsers) * 1000) / 10 : null,
      kyc_verified: kycVerified,
      kyc_rate: totalUsers ? Math.round((kycVerified / totalUsers) * 1000) / 10 : null,
      daily,
    });
  } catch (e) {
    console.error('adminInsights.getGrowth error', e);
    return fail(res, 500, 'Failed to load growth metrics');
  }
}

module.exports = {
  getHealth,
  getSupportSla,
  getGrowth,
  __test: { envPresence, slaTargets },
};
