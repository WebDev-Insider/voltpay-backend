// Admin half of Bill Hero: what the promotion is doing, and the switch to shut it.
//
// Mounted under /api/admin behind adminAuth.middleware, so nothing here reads
// req.user. Writes are picked up by adminAudit.middleware automatically.
//
// Every number on this screen comes out of `tallyWeek` in billHero.controller -
// the same function the app's own progress bar reads. That is deliberate: a
// dashboard with its own copy of the counting rules is a dashboard that
// eventually tells support a user completed a challenge the app says they did
// not. The lock is applied to the tally too, so a recharge made while Bill Hero
// was shut is missing from both.
const prisma = require('../../database/prisma');
const { blindIndex, revealUserFields, decryptValue } = require('../helpers/pii.helper');
const { lagosDateParts, lagosMidnightUtc } = require('../helpers/lagosTime.helper');
const {
  getConfig,
  setConfig,
  evaluate,
  publicAvailability,
} = require('../helpers/billHeroAvailability.helper');
const {
  listChallenges,
  invalidateChallenges,
  isRunning,
  lifecycle,
  rewardLabel,
  publicChallenge,
  validateChallengeInput,
} = require('../helpers/billHeroChallenge.helper');
// Through the registry: the reward catalogue must come from whichever provider
// the data rail is switched to, not from a fixed one.
const bills = require('../funding/billsProvider');
const redis = require('../services/redis.service');
const {
  tallyWeek,
  startOfWeekLagosUtc,
  isoWeekKey,
  // The reward picker, shared rather than reimplemented - see listDataPlanOptions.
  parseSizeMb,
  pickBestDataPlan,
} = require('./billHero.controller');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function fail(res, message, remark = 'validation_error', code = 400) {
  return res.status(code).json({ remark, status: 'error', message: [message], data: null });
}

function ok(res, data, message = 'OK', remark = 'bill_hero') {
  return res.json({ remark, status: 'success', message: [message], data });
}

/**
 * What an admin sees against a challenge row, once the global lock is folded in.
 *
 * Two independent things can stop a challenge: its own dates and the Bill Hero
 * lock. The lock wins in the display, because "active but nobody can reach it"
 * is the state that generates support tickets. `scheduled` and `locked` stay
 * distinct for the same reason - the first reopens on its own at the next slot,
 * the second stays shut until somebody clicks unlock.
 */
function challengeStatus(challenge, state, now) {
  const own = lifecycle(challenge, now);
  if (own !== 'active') return own;

  if (state.open) return 'active';

  return state.reason === 'outside_schedule' ? 'scheduled' : 'locked';
}

/** Lagos midnight today, and the starts of the Lagos week and month. */
function periodStarts(now) {
  const p = lagosDateParts(now);

  return {
    today: lagosMidnightUtc(p.year, p.month, p.day),
    week: startOfWeekLagosUtc(now),
    month: lagosMidnightUtc(p.year, p.month, 1),
  };
}

/**
 * Reward counts and their naira / megabyte value over a window.
 *
 * Only `claimed` rows count. A `processing` claim has not been delivered and a
 * `failed` one never will be, and reporting either as money given away is how a
 * promotion budget quietly stops matching the provider statement.
 *
 * The value is summed off `reward_value` on the claim rather than multiplied
 * out from the challenge. Challenges are editable now, so the challenge says
 * what a reward is worth today and the claim says what it was worth when it was
 * paid - only the second one reconciles against a provider statement.
 */
async function rewardTotals(where) {
  const rows = await prisma.billHeroClaim.groupBy({
    by: ['reward_type'],
    where: { ...where, status: 'claimed' },
    _count: { _all: true },
    _sum: { reward_value: true },
  });

  const byType = new Map(
    rows.map(r => [String(r.reward_type || '').toLowerCase(), { count: r._count._all, value: Number(r._sum.reward_value) || 0 }]),
  );

  const airtime = byType.get('airtime') || { count: 0, value: 0 };
  const data = byType.get('data') || { count: 0, value: 0 };

  return {
    total: airtime.count + data.count,
    airtime_count: airtime.count,
    data_count: data.count,
    airtime_value_ngn: airtime.value,
    data_value_mb: data.value,
  };
}

/** GET /admin/bill-hero/overview */
async function getOverview(req, res) {
  try {
    const now = new Date();
    const weekStart = startOfWeekLagosUtc(now);
    const weekEnd = new Date(weekStart.getTime() + WEEK_MS);
    const week_key = isoWeekKey(now);

    const config = await getConfig();
    const state = evaluate(config, now);

    const starts = periodStarts(now);

    const [tally, definitions, today, week, month, allTime, pendingCount, failedCount] = await Promise.all([
      tallyWeek({ weekStart, weekEnd, availability: config }),
      listChallenges(),
      rewardTotals({ claimed_at: { gte: starts.today } }),
      rewardTotals({ claimed_at: { gte: starts.week } }),
      rewardTotals({ claimed_at: { gte: starts.month } }),
      rewardTotals({}),
      prisma.billHeroClaim.count({ where: { status: 'processing' } }),
      prisma.billHeroClaim.count({ where: { status: 'failed' } }),
    ]);

    const entries = Array.from(tally.values());
    const participants = entries.length;

    const claimCounts = await prisma.billHeroClaim.groupBy({
      by: ['challenge_id'],
      where: { week_key, status: 'claimed' },
      _count: { _all: true },
    });

    const claimedByChallenge = new Map(claimCounts.map(r => [Number(r.challenge_id), r._count._all]));

    const challenges = definitions.map(def => {
      const key = def.action_type === 'airtime' ? 'airtime_count' : 'data_count';

      const entered = entries.filter(e => e[key] > 0).length;
      const completions = entries.filter(e => e[key] >= def.target).length;

      return {
        ...publicChallenge(def, now),
        // The run window an admin set, not the week - a challenge can outlive
        // the week whose numbers are being shown beside it.
        week_key,
        week_start: weekStart.toISOString(),
        week_end: weekEnd.toISOString(),
        start_date: def.starts_at ? def.starts_at.toISOString() : null,
        end_date: def.ends_at ? def.ends_at.toISOString() : null,
        status: challengeStatus(def, state, now),
        participants: entered,
        completions,
        completion_rate: entered ? Math.round((completions / entered) * 1000) / 10 : 0,
        rewards_claimed: claimedByChallenge.get(Number(def.id)) || 0,
      };
    });

    // Only challenges that were actually claimable this week can be completed,
    // so a deactivated one must not drag the rate down.
    const liveChallenges = challenges.filter(c => isRunning(definitions.find(d => Number(d.id) === c.id), now));
    const totalCompletions = liveChallenges.reduce((sum, c) => sum + c.completions, 0);

    // Denominator is every challenge a participant could have finished this
    // week, not the head count - otherwise a user who completes both scores
    // 200%.
    const opportunities = participants * liveChallenges.length;

    return ok(
      res,
      {
        week_key,
        week: { start: weekStart.toISOString(), end: weekEnd.toISOString() },
        availability: publicAvailability(config, state),
        metrics: {
          active_users: participants,
          challenges_running: challenges.filter(c => c.status === 'active').length,
          completions: totalCompletions,
          completion_rate: opportunities ? Math.round((totalCompletions / opportunities) * 1000) / 10 : 0,
          rewards_today: today,
          rewards_week: week,
          rewards_month: month,
          rewards_all_time: allTime,
          pending_claims: pendingCount,
          failed_claims: failedCount,
        },
        challenges,
      },
      'OK',
      'bill_hero_overview',
    );
  } catch (e) {
    console.error('adminBillHero.getOverview error', e);

    return fail(res, 'Failed to load Bill Hero overview', 'error', 500);
  }
}

/**
 * GET /admin/bill-hero/participants?week=current&page=1&perPage=20
 *
 * Progress per user per challenge for one week, with what they have claimed
 * against it. Paginated in memory: the tally is already a full in-process map
 * (it has to be, to exclude refunds), so slicing it costs nothing and a second
 * database round trip would buy nothing.
 */
async function listParticipants(req, res) {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
    const perPage = Math.min(Math.max(parseInt(req.query.perPage || '20', 10) || 20, 1), 100);

    // `weeks_ago=1` is last week. Anything else is the current one.
    const weeksAgo = Math.min(Math.max(parseInt(req.query.weeks_ago || '0', 10) || 0, 0), 52);

    const now = new Date();
    const weekStart = new Date(startOfWeekLagosUtc(now).getTime() - weeksAgo * WEEK_MS);
    const weekEnd = new Date(weekStart.getTime() + WEEK_MS);
    const week_key = isoWeekKey(new Date(weekStart.getTime() + 24 * 60 * 60 * 1000));

    const config = await getConfig();
    const tally = await tallyWeek({ weekStart, weekEnd, availability: config });

    const sorted = Array.from(tally.values()).sort(
      (a, b) => b.points - a.points || a.user_id - b.user_id,
    );

    const total = sorted.length;
    const slice = sorted.slice((page - 1) * perPage, page * perPage);
    const ids = slice.map(r => Number(r.user_id));

    const [users, claims] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          firstname_enc: true,
          lastname_enc: true,
          username_enc: true,
          email_enc: true,
          mobile_enc: true,
          image: true,
          status: true,
        },
      }),
      prisma.billHeroClaim.findMany({
        where: { user_id: { in: ids }, week_key },
        select: { user_id: true, challenge_id: true, status: true, claimed_at: true, provider_ref: true },
      }),
    ]);

    const userById = new Map(users.map(u => [Number(u.id), { id: Number(u.id), image: u.image || '', status: u.status, ...revealUserFields(u) }]));

    const claimsByUser = new Map();
    for (const c of claims) {
      const list = claimsByUser.get(Number(c.user_id)) || [];
      list.push(c);
      claimsByUser.set(Number(c.user_id), list);
    }

    // Every challenge, not only the running ones: a table whose columns changed
    // between last week and this one cannot be read side by side, and a
    // challenge that ended on Wednesday still has that week's progress under it.
    const definitions = await listChallenges();

    const items = slice.map(row => {
      const uid = Number(row.user_id);
      const userClaims = claimsByUser.get(uid) || [];

      return {
        user: userById.get(uid) || { id: uid },
        points: row.points,
        challenges: definitions.map(def => {
          const count = def.action_type === 'airtime' ? row.airtime_count : row.data_count;
          const claim = userClaims.find(c => Number(c.challenge_id) === Number(def.id));

          return {
            id: Number(def.id),
            type: def.action_type,
            title: def.title,
            progress: count,
            target: def.target,
            completed: count >= def.target,
            // No row at all is not the same as a row that failed: the first is
            // a reward still to be asked for, the second is one owed.
            claim_status: claim ? String(claim.status || '') : 'unclaimed',
            claimed_at: claim?.claimed_at || null,
            provider_ref: claim?.provider_ref || '',
          };
        }),
      };
    });

    return ok(
      res,
      {
        week_key,
        week: { start: weekStart.toISOString(), end: weekEnd.toISOString() },
        items,
        pagination: { page, perPage, total, totalPages: Math.max(1, Math.ceil(total / perPage)) },
      },
      'OK',
      'bill_hero_participants',
    );
  } catch (e) {
    console.error('adminBillHero.listParticipants error', e);

    return fail(res, 'Failed to load Bill Hero participants', 'error', 500);
  }
}

/**
 * GET /admin/bill-hero/rewards?from=&to=&type=&status=&q=&page=
 *
 * Every reward the promotion has handed out, and every one it failed to.
 *
 * `q` is exact-match only, by blind index over email / mobile / username. The
 * identity columns are ciphertext, so a substring search over a name is not
 * possible by design - same rule as the user list.
 */
async function listRewards(req, res) {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
    const perPage = Math.min(Math.max(parseInt(req.query.perPage || '25', 10) || 25, 1), 100);

    const where = {};

    const type = String(req.query.type || '').trim().toLowerCase();
    if (type === 'airtime' || type === 'data') where.reward_type = type;

    const status = String(req.query.status || '').trim().toLowerCase();
    if (['claimed', 'processing', 'failed'].includes(status)) where.status = status;

    const from = req.query.from ? new Date(String(req.query.from)) : null;
    const to = req.query.to ? new Date(String(req.query.to)) : null;
    if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
      return fail(res, 'from and to must be dates');
    }
    if (from || to) {
      where.claimed_at = {};
      if (from) where.claimed_at.gte = from;
      // Inclusive of the whole `to` day: an admin filtering to today means up
      // to now, not up to midnight this morning.
      if (to) where.claimed_at.lte = new Date(to.getTime() + (String(req.query.to).length <= 10 ? 24 * 60 * 60 * 1000 - 1 : 0));
    }

    const q = String(req.query.q || '').trim();
    if (q) {
      const match = await prisma.user.findFirst({
        where: {
          OR: [
            { email_idx: blindIndex(q, 'email') },
            { mobile_idx: blindIndex(q, 'mobile') },
            { username_idx: blindIndex(q, 'username') },
          ],
        },
        select: { id: true },
      });

      // No match is an empty result, not an unfiltered one - silently listing
      // every reward because a search missed is worse than showing nothing.
      where.user_id = match ? Number(match.id) : -1;
    }

    const [rows, total] = await Promise.all([
      prisma.billHeroClaim.findMany({
        where,
        orderBy: [{ claimed_at: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * perPage,
        take: perPage,
        select: {
          id: true,
          user_id: true,
          challenge_id: true,
          week_key: true,
          reward_type: true,
          reward_value: true,
          phone_enc: true,
          network: true,
          status: true,
          provider: true,
          provider_ref: true,
          claimed_at: true,
          created_at: true,
          challenge: { select: { id: true, title: true } },
          user: {
            select: {
              id: true,
              firstname_enc: true,
              lastname_enc: true,
              username_enc: true,
              email_enc: true,
              mobile_enc: true,
              image: true,
            },
          },
        },
      }),
      prisma.billHeroClaim.count({ where }),
    ]);

    const items = rows.map(r => ({
      id: Number(r.id),
      user: r.user ? { id: Number(r.user.id), image: r.user.image || '', ...revealUserFields(r.user) } : { id: Number(r.user_id) },
      week_key: r.week_key,
      challenge_id: Number(r.challenge_id),
      challenge: String(r.challenge?.title || 'Challenge'),
      reward_type: r.reward_type,
      reward_label: rewardLabel(r),
      reward_value: Number(r.reward_value) || 0,
      reward_unit: r.reward_type === 'airtime' ? 'NGN' : 'MB',
      // Last four only. Support needs to confirm which line was topped up, not
      // to read a full number out of a reporting screen. The column itself is
      // ciphertext, so this is the only place it is ever opened for an admin.
      destination: maskPhone(revealPhone(r.phone_enc)),
      network: r.network,
      delivery_status: r.status,
      provider: r.provider,
      provider_ref: r.provider_ref || '',
      claimed_at: r.claimed_at,
      created_at: r.created_at,
    }));

    return ok(
      res,
      {
        items,
        pagination: { page, perPage, total, totalPages: Math.max(1, Math.ceil(total / perPage)) },
      },
      'OK',
      'bill_hero_rewards',
    );
  } catch (e) {
    console.error('adminBillHero.listRewards error', e);

    return fail(res, 'Failed to load Bill Hero rewards', 'error', 500);
  }
}

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 4) return '';

  return `•••• ${digits.slice(-4)}`;
}

/** One unreadable row must not take the whole rewards page down with it. */
function revealPhone(value) {
  if (!value) return '';
  try {
    return decryptValue(value);
  } catch {
    return '';
  }
}

/** GET /admin/bill-hero/availability */
async function getAvailability(req, res) {
  try {
    const config = await getConfig();

    return ok(res, { availability: publicAvailability(config) }, 'OK', 'bill_hero_availability');
  } catch (e) {
    console.error('adminBillHero.getAvailability error', e);

    return fail(res, 'Failed to load Bill Hero availability', 'error', 500);
  }
}

/**
 * PATCH /admin/bill-hero/availability
 *
 * Any signed-in admin, not superadmin only. Locking is the safe direction -
 * it stops rewards going out - and a promotion that only one person on the team
 * can shut is a promotion that stays open through the incident.
 */
async function updateAvailability(req, res) {
  try {
    const body = req.body || {};

    const patch = {};
    for (const field of ['mode', 'locked', 'days', 'start_time', 'end_time', 'lock_message', 'locked_from', 'locked_until']) {
      if (body[field] !== undefined) patch[field] = body[field];
    }

    if (!Object.keys(patch).length) return fail(res, 'Nothing to update');

    const config = await setConfig(patch);
    const state = evaluate(config);

    return ok(
      res,
      { availability: publicAvailability(config, state) },
      state.open ? 'Bill Hero is open' : 'Bill Hero is closed',
      'bill_hero_availability_updated',
    );
  } catch (e) {
    if (e?.code === 'INVALID_AVAILABILITY') return fail(res, e.message);

    console.error('adminBillHero.updateAvailability error', e);

    return fail(res, 'Failed to update Bill Hero availability', 'error', 500);
  }
}

/** GET /admin/bill-hero/challenges */
async function listChallengeRows(req, res) {
  try {
    const now = new Date();
    const rows = await listChallenges();

    return ok(
      res,
      { items: rows.map(r => publicChallenge(r, now)) },
      'OK',
      'bill_hero_challenges',
    );
  } catch (e) {
    console.error('adminBillHero.listChallengeRows error', e);

    return fail(res, 'Failed to load challenges', 'error', 500);
  }
}

/** POST /admin/bill-hero/challenges */
async function createChallenge(req, res) {
  try {
    const { error, data } = validateChallengeInput(req.body || {});
    if (error) return fail(res, error);

    const row = await prisma.billHeroChallenge.create({ data });
    await invalidateChallenges();

    return ok(res, { challenge: publicChallenge(row) }, 'Challenge created', 'bill_hero_challenge_created');
  } catch (e) {
    console.error('adminBillHero.createChallenge error', e);

    return fail(res, 'Failed to create challenge', 'error', 500);
  }
}

/** PATCH /admin/bill-hero/challenges/:id */
async function updateChallenge(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return fail(res, 'Invalid challenge id');

    const existing = await prisma.billHeroChallenge.findUnique({ where: { id } });
    if (!existing) return fail(res, 'Challenge not found', 'not_found', 404);

    // The date pair has to be judged against whichever side the patch left
    // alone, so the current values ride along for the cross-field check.
    const { error, data } = validateChallengeInput(
      { ...req.body, _current_starts_at: existing.starts_at, _current_ends_at: existing.ends_at },
      { partial: true },
    );

    if (error) return fail(res, error);
    if (!Object.keys(data).length) return fail(res, 'Nothing to update');

    const row = await prisma.billHeroChallenge.update({ where: { id }, data });
    await invalidateChallenges();

    return ok(res, { challenge: publicChallenge(row) }, 'Challenge updated', 'bill_hero_challenge_updated');
  } catch (e) {
    console.error('adminBillHero.updateChallenge error', e);

    return fail(res, 'Failed to update challenge', 'error', 500);
  }
}

/**
 * DELETE /admin/bill-hero/challenges/:id
 *
 * Deactivates rather than deletes once anything has been claimed against it.
 * A claim row names the challenge it paid out for; removing the challenge would
 * either orphan that reference or take the payout record with it, and the
 * payout record is the one thing here that has to survive.
 */
async function deleteChallenge(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return fail(res, 'Invalid challenge id');

    const claims = await prisma.billHeroClaim.count({ where: { challenge_id: id } });

    if (claims > 0) {
      const row = await prisma.billHeroChallenge.update({ where: { id }, data: { active: false } });
      await invalidateChallenges();

      return ok(
        res,
        { challenge: publicChallenge(row), deactivated: true },
        `Challenge deactivated - ${claims} reward${claims === 1 ? '' : 's'} were claimed against it, so the record is kept`,
        'bill_hero_challenge_deactivated',
      );
    }

    await prisma.billHeroChallenge.delete({ where: { id } });
    await invalidateChallenges();

    return ok(res, { deleted: true }, 'Challenge deleted', 'bill_hero_challenge_deleted');
  } catch (e) {
    if (e?.code === 'P2025') return fail(res, 'Challenge not found', 'not_found', 404);

    console.error('adminBillHero.deleteChallenge error', e);

    return fail(res, 'Failed to delete challenge', 'error', 500);
  }
}

// ---------------------------------------------------------------------------
// Data reward sizes, from the live catalogue of whichever provider vends data
// ---------------------------------------------------------------------------

// Bill Hero rewards land on the claimer's own line, so the network is not known
// until they claim. These are the four the reward path can vend to; a catalogue
// entry outside this set cannot be rewarded and is not offered.
const REWARD_NETWORKS = ['MTN', 'GLO', 'AIRTEL', '9MOBILE'];

// A size is only worth offering if enough networks actually sell something near
// it. One network having a 750MB bundle is not a reward you can promise the
// whole user base.
const MIN_NETWORKS_FOR_SIZE = 2;

// Anything slower than this came off the wire rather than out of the cache.
const CACHE_HIT_MS = 150;

// Above the per-second floor both rails enforce, not just near it. PairGate
// answers a burst with "Please wait 1 seconds before retrying" and ClubKonnect
// paces its own catalogue calls, so a sub-second gap guarantees the throttle on
// every cold load and spends retries that cannot succeed.
const CATALOGUE_CALL_SPACING_MS = 1_500;

// How close a plan has to be to count as that size actually being sold. Loose
// enough for a 512MB bundle advertised as "500MB", tight enough that MTN's
// 1.8GB does not count as somebody selling 2GB.
const EXACT_SIZE_TOLERANCE = 0.05;

// A reward is a giveaway, not a purchase. The catalogue runs to 480GB bundles
// at NGN 90,000, and those are not rows anyone should be able to click by
// accident on a promotion screen - the reward this replaces defaults to 500MB.
// Measured against the DEAREST network, because that is what a claim can
// actually cost us, not the one we hope they are on.
function maxRewardCost() {
  const raw = Number(String(process.env.BILL_HERO_MAX_REWARD_COST_NGN || '').trim());

  return Number.isFinite(raw) && raw > 0 ? raw : 6_000;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Building this list costs four catalogue calls to the provider, out of a
// per-minute budget shared with live customer vending. The catalogue barely
// moves from week to week, so paying that on every dialog open is the wrong
// trade - and observably so: opening it twice in a minute is enough to have the
// provider answer "Too Many Attempts" and hand back an empty list.
//
// Two keys rather than one. The serving copy expires so a genuine catalogue
// change lands within the day; the last-good copy is kept far longer and is
// only ever read when a rebuild came back incomplete. Without it, one throttled
// rebuild turns a working screen into an empty one for the whole TTL.
//
// Keyed by rail, because the two providers do not sell the same bundles. One
// shared key would keep serving the old provider's sizes for six hours after an
// admin moved the data rail - the exact mismatch this screen exists to prevent -
// and the last-good copy would hold it for a week. Per rail, a switch reads a
// cold key and rebuilds, and switching back finds that rail's own copy still
// warm, which is correct rather than stale.
const plansCacheKey = gateway => redis.key('billhero', 'dataplans', gateway, 'v1');
const plansLastGoodKey = gateway => redis.key('billhero', 'dataplans', 'last_good', gateway, 'v1');
const PLANS_TTL_SECONDS = 6 * 60 * 60;
const PLANS_LAST_GOOD_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * A size a promotion would actually name.
 *
 * Carriers sell 5.2GB, 8.4GB and 11.4GB "anytime" bundles. They are real plans
 * and the runtime can vend them, but nobody writes "8602MB" on a reward, and
 * every one of them adds a row an admin has to read past to reach the size they
 * meant. Whole gigabytes above 1GB, round megabytes below it.
 */
function isNamableSize(mb) {
  return mb >= 1024 ? mb % 1024 === 0 : mb % 100 === 0;
}

/** Does this catalogue sell a bundle at (near enough) this exact size? */
function sellsSize(plans, sizeMb) {
  const lower = sizeMb * (1 - EXACT_SIZE_TOLERANCE);
  const upper = sizeMb * (1 + EXACT_SIZE_TOLERANCE);

  return (Array.isArray(plans) ? plans : []).some(p => {
    const mb = parseSizeMb(p?.name);

    return mb != null && mb >= lower && mb <= upper;
  });
}

// Prefer the size an admin would actually write down. Several parsed sizes can
// resolve to the same underlying plans - a catalogue with a "2.5GB" and a
// "2560MB" entry produces both - and offering the same reward twice under two
// spellings makes the list longer without making it more useful.
function sizeTidiness(sizeMb) {
  if (sizeMb % 1024 === 0) return 0; // whole GB
  if (sizeMb % 512 === 0) return 1; // half GB
  if (sizeMb % 100 === 0) return 2; // round MB
  return 3;
}

/**
 * The sizes an admin can pick from, priced per network.
 *
 * `reward_value` stays an integer of megabytes - the same column, no migration,
 * and the same runtime path. What changes is that the number now comes from a
 * list built out of the live provider catalogue instead of being typed, so an
 * admin can no longer promise a 750MB reward that no network sells and which
 * only fails at 2am when somebody claims it.
 *
 * The per-network resolution is computed with `pickBestDataPlan` - the exact
 * function the claim path calls. Reimplementing the match here would create the
 * same class of bug this file already warns about with `tallyWeek`: a dashboard
 * that confidently shows a plan and a price the runtime would not choose.
 *
 * `upstream` is the resolved data-rail adapter and `gateway` its name; the
 * caller resolves them because the cache key it reads first is per rail.
 */
async function buildDataPlanOptions({ gateway, upstream }) {
  const byNetwork = {};
  const failed = [];

  // Sequential rather than Promise.all: both rails throttle per second as well
  // as per minute, and the budget is shared with live vending. Four parallel
  // catalogue reads would throttle themselves and could throttle a customer's
  // purchase alongside them.
  //
  // The pause is only taken when the previous call actually left the process.
  // A cache hit returns in about a millisecond, and sleeping between four map
  // reads would add three seconds to every warm load for no reason.
  for (const network of REWARD_NETWORKS) {
    const startedAt = Date.now();

    try {
      const plans = await upstream.listDataPlansCached(network);
      byNetwork[network] = (Array.isArray(plans) ? plans : [])
        .filter(p => String(p?.id ?? '').trim() && Number(p?.amount || 0) > 0);
    } catch (e) {
      byNetwork[network] = [];
      failed.push(network);
      console.error('adminBillHero.listDataPlanOptions network failed', {
        network,
        reason: String(e?.message || e).slice(0, 160),
      });
    }

    const wasNetworkCall = Date.now() - startedAt > CACHE_HIT_MS;
    if (wasNetworkCall) await sleep(CATALOGUE_CALL_SPACING_MS);
  }

  // Candidate sizes come from the catalogue itself, so nothing is offered that
  // no network sells - and no curated ladder has to be maintained here when
  // a provider adds a plan.
  const seen = new Set();

  for (const plans of Object.values(byNetwork)) {
    for (const plan of plans) {
      const mb = parseSizeMb(plan?.name);
      if (mb != null && mb > 0) seen.add(mb);
    }
  }

  // A size only makes the list if several networks sell that size themselves.
  //
  // Without this the band below does the deciding, and a band is too generous
  // to decide with: MTN sells 1.8GB, no other network does, but 2GB is inside
  // 20% of 1.8GB, so "1843MB" would appear as a reward available on two
  // networks - and half the people claiming it would get 2GB instead. The
  // catalogue is full of those (2.7GB, 3.2GB, 5.5GB, 11GB), and every one of
  // them is a row an admin has to think about for no gain. Requiring the size
  // to exist in its own right leaves the sizes a promotion would actually
  // name.
  const sizes = [...seen]
    .filter(isNamableSize)
    .filter(mb => REWARD_NETWORKS.filter(n => sellsSize(byNetwork[n], mb)).length >= MIN_NETWORKS_FOR_SIZE)
    .sort((a, b) => a - b);

  const costCeiling = maxRewardCost();

  const options = [];

  for (const sizeMb of sizes) {
    const networks = {};
    let availableOn = 0;
    let minCost = null;
    let maxCost = null;

    for (const network of REWARD_NETWORKS) {
      const picked = pickBestDataPlan(byNetwork[network], sizeMb);

      // pickBestDataPlan falls back to the whole catalogue when nothing sits
      // near the target, so a returned plan is not the same as a match. Hold
      // it to the same 20% band the runtime treats as a real hit, otherwise
      // this screen would price every size on every network as available.
      const resolvedMb = picked ? parseSizeMb(picked.name) : null;
      const onTarget =
        picked && resolvedMb != null && resolvedMb >= sizeMb * 0.8 && resolvedMb <= sizeMb * 1.2;

      if (!onTarget) {
        networks[network] = { available: false, plan_name: null, cost: null };
        continue;
      }

      const cost = Number(picked.amount);
      networks[network] = { available: true, plan_name: picked.name, cost };
      availableOn += 1;
      minCost = minCost == null ? cost : Math.min(minCost, cost);
      maxCost = maxCost == null ? cost : Math.max(maxCost, cost);
    }

    if (availableOn < MIN_NETWORKS_FOR_SIZE) continue;
    if (maxCost != null && maxCost > costCeiling) continue;

    options.push({
      size_mb: sizeMb,
      label: sizeMb >= 1024 && sizeMb % 1024 === 0 ? `${sizeMb / 1024}GB` : `${sizeMb}MB`,
      networks,
      available_on: availableOn,
      total_networks: REWARD_NETWORKS.length,
      min_cost: minCost,
      max_cost: maxCost,
      // What the runtime would actually buy. Two candidate sizes landing on
      // this same signature are the same reward under two names.
      signature: REWARD_NETWORKS.map(n => (networks[n].available ? `${n}:${networks[n].plan_name}` : '')).join('|'),
    });
  }

  // Keep one row per distinct reward. Tidiest size wins, then the one whose
  // number is smallest, so a plan sold as both "2GB" and "2048MB" is offered
  // as 2GB and the admin never has to guess which of two identical rows to
  // pick.
  const bySignature = new Map();

  for (const option of options) {
    const held = bySignature.get(option.signature);
    if (!held) {
      bySignature.set(option.signature, option);
      continue;
    }

    const better =
      sizeTidiness(option.size_mb) - sizeTidiness(held.size_mb) ||
      option.size_mb - held.size_mb;

    if (better < 0) bySignature.set(option.signature, option);
  }

  const deduped = [...bySignature.values()]
    .sort((a, b) => a.size_mb - b.size_mb)
    .map(({ signature, ...rest }) => rest);

  return {
    options: deduped,
    networks: REWARD_NETWORKS,
    unavailable_networks: failed,
    // The editor falls back to a plain number box when this is empty, so a
    // provider outage cannot lock an admin out of authoring a challenge. Names
    // the provider it came from rather than a fixed string - which catalogue
    // the admin was looking at is now a real question.
    source: deduped.length ? gateway : 'unavailable',
  };
}

/**
 * A rebuild worth keeping: every network answered and it produced something.
 *
 * Tested against the sentinel rather than a provider name - `source` now
 * carries whichever rail answered, and a new provider must not silently start
 * failing this check.
 */
function isCompleteResult(result) {
  return Boolean(
    result && result.source && result.source !== 'unavailable' && !result.unavailable_networks.length && result.options.length
  );
}

/** GET /admin/bill-hero/data-plans */
async function listDataPlanOptions(req, res) {
  try {
    // Resolved here rather than inside the build because the cache is read
    // first and its key is per rail. The claim path reads this same switch, so
    // the sizes an admin picks from are the sizes that will be vendable -
    // showing one provider's catalogue while the other does the vending is how
    // an admin promises a bundle nobody sells.
    const { name: gateway, provider: upstream } = await bills.resolve('data');
    const cacheKey = plansCacheKey(gateway);
    const lastGoodKey = plansLastGoodKey(gateway);

    const hit = await redis.get(cacheKey);
    if (hit) return ok(res, { ...hit, cached: true }, 'OK', 'bill_hero_data_plans');

    const built = await buildDataPlanOptions({ gateway, upstream });

    if (isCompleteResult(built)) {
      await redis.set(cacheKey, built, PLANS_TTL_SECONDS);
      await redis.set(lastGoodKey, built, PLANS_LAST_GOOD_TTL_SECONDS);

      return ok(res, { ...built, cached: false }, 'OK', 'bill_hero_data_plans');
    }

    // Incomplete. A partial list is worse than a slightly old complete one: it
    // silently drops sizes an admin has used before, and the reason - a throttle
    // on a shared budget - has nothing to do with what the provider can vend.
    //
    // The last-good copy is this rail's own, so a fresh switch that throttles on
    // its first build falls back to an empty list rather than to the other
    // provider's sizes. Empty is honest: the editor drops to a plain number box.
    const lastGood = await redis.get(lastGoodKey);

    if (lastGood) {
      return ok(
        res,
        { ...lastGood, cached: true, stale: true, unavailable_networks: built.unavailable_networks },
        'OK',
        'bill_hero_data_plans',
      );
    }

    return ok(res, { ...built, cached: false }, 'OK', 'bill_hero_data_plans');
  } catch (e) {
    console.error('adminBillHero.listDataPlanOptions error', e);

    return fail(res, 'Failed to read the data plan catalogue', 'error', 500);
  }
}

module.exports = {
  getOverview,
  listParticipants,
  listRewards,
  getAvailability,
  updateAvailability,
  listChallengeRows,
  createChallenge,
  updateChallenge,
  deleteChallenge,
  listDataPlanOptions,
  __test: { challengeStatus, maskPhone, isNamableSize, sellsSize, sizeTidiness, isCompleteResult },
};
