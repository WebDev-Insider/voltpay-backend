const prisma = require('../../database/prisma');
const { verifySecret, revealUserFields, encryptValue, decryptValue } = require('../helpers/pii.helper');
const { lagosDateParts, lagosMidnightUtc } = require('../helpers/lagosTime.helper');
const { getConfig, evaluate, openAt, publicAvailability } = require('../helpers/billHeroAvailability.helper');
const {
  listChallenges,
  isRunning,
  progressFor,
  isCompleted,
  publicChallenge,
  rewardLabel,
} = require('../helpers/billHeroChallenge.helper');

// Rewards vend down the same rail as a paid recharge, through the same switch.
// One provider for both means one float to watch and one place a network outage
// shows up, rather than a reward path that quietly rots because nobody buys
// airtime through it - and it means an admin moving airtime away from a failing
// provider moves the rewards with it, instead of leaving every claim failing on
// a rail that was declared broken an hour ago.
//
// Safe to follow the switch because a reward plan is picked from the LIVE
// catalogue at claim time (see autoPickRewardPlanId) rather than from a stored
// id. Plan ids are not portable between providers, so a persisted one would
// have to be pinned the way bills.controller pins a quote; a freshly read one
// belongs to whichever provider just answered.
const bills = require('../funding/billsProvider');

const MIN_QUALIFYING_AMOUNT = 100;
const AIRTIME_TARGET = 10;
const DATA_TARGET = 7;

const AIRTIME_REWARD_AMOUNT = 200;
const DATA_REWARD_MB = 500;
const DATA_REWARD_LABEL = '500MB';

const POINTS_PER_AIRTIME = 10;
const POINTS_PER_DATA = 10;

const CLAIM_START_DAY = 6; // Saturday
const CLAIM_START_HOUR = 0; // 00:00
const CLAIM_WINDOW_HOURS = 24;

/**
 * The delivery number off a claim row.
 *
 * Returns '' rather than throwing when the ciphertext will not open. A reward
 * history that renders with one blank number beats a 500 that hides the whole
 * list, and the number is not what the screen is for.
 */
function revealClaimPhone(value) {
  if (!value) return '';
  try {
    return decryptValue(value);
  } catch (e) {
    console.error('❌ Failed to decrypt bill hero claim phone:', e?.message || e);

    return '';
  }
}

async function history(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const rows = await prisma.billHeroClaim.findMany({
      where: {
        user_id: Number(user.id),
      },
      orderBy: [{ claimed_at: 'desc' }, { id: 'desc' }],
      take: 50,
      select: {
        id: true,
        challenge_id: true,
        week_key: true,
        reward_type: true,
        reward_value: true,
        phone_enc: true,
        network: true,
        status: true,
        provider_ref: true,
        claimed_at: true,
        challenge: { select: { title: true } },
      },
    });

    return res.json({
      remark: 'bill_hero_history',
      status: 'success',
      message: ['OK'],
      data: {
        history: rows.map((r) => ({
          id: Number(r.id),
          challenge_id: Number(r.challenge_id),
          challenge_title: String(r.challenge?.title || ''),
          week_key: String(r.week_key || ''),
          reward_type: String(r.reward_type || ''),
          reward_value: Number(r.reward_value) || 0,
          reward_label: rewardLabel(r),
          // This is the user reading back their own delivery number, so it is
          // shown in full. Every other reader of this column gets it masked.
          phone: revealClaimPhone(r.phone_enc),
          network: String(r.network || ''),
          status: String(r.status || ''),
          provider_ref: r.provider_ref ? String(r.provider_ref) : '',
          claimed_at: r.claimed_at instanceof Date ? r.claimed_at.toISOString() : new Date(r.claimed_at).toISOString(),
        })),
      },
    });
  } catch (e) {
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

/**
 * Monday 00:00 Lagos, as the real UTC instant - 23:00Z the Sunday before.
 *
 * This is compared against `created_at`, which is a real timestamp, so it has to
 * be one too. The previous version read the Lagos wall clock and rebuilt it with
 * Date.UTC, which produced an instant an hour ahead of the actual one: a recharge
 * at 00:30 WAT on Monday (23:30Z Sunday) fell outside the week it belongs to and
 * was counted towards the week that had already closed.
 */
function startOfWeekLagosUtc(now = new Date()) {
  const p = lagosDateParts(now);
  // lagosMidnightUtc normalises an underflowing day, so no month/year branch.
  return lagosMidnightUtc(p.year, p.month, p.day - ((p.weekday + 6) % 7));
}

/**
 * The claim window, Saturday 00:00 WAT for 24 hours.
 *
 * Plain hour arithmetic off weekStart: Lagos is UTC+1 with no DST, so no day
 * is ever 23 or 25 hours long. Not setUTCHours() - weekStart sits at 23:00Z, and
 * snapping it to a UTC hour would drag the window back into Friday.
 */
function claimWindowForWeek(weekStart) {
  const hours = (CLAIM_START_DAY - 1) * 24 + CLAIM_START_HOUR; // Monday = day 1
  const start = new Date(weekStart.getTime() + hours * 60 * 60 * 1000);
  const end = new Date(start.getTime() + CLAIM_WINDOW_HOURS * 60 * 60 * 1000);
  return { start, end };
}

/**
 * ISO week label for the Lagos calendar date, e.g. `2026-W32`.
 *
 * A label, not an instant - it only ever meets other labels (the `week_key`
 * column), never a timestamp. So the Lagos y/m/d is deliberately packed into a
 * UTC date here purely to reuse the ISO week arithmetic below.
 */
function isoWeekKey(now) {
  const p = lagosDateParts(now);
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day));
  date.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
  const week1 = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const weekNo =
    1 +
    Math.round(
      ((date - week1) / 86400000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7
    );
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// Normalise the app's network label. The provider module maps this to its own
// slug, so what is returned here only has to be a name `networkSlug` knows -
// the aliases are what the app has actually been seen to send.
function networkFromName(network) {
  const n = String(network || '').trim().toUpperCase();
  if (n === 'MTN' || n === 'GLO' || n === 'AIRTEL' || n === '9MOBILE') return n;
  if (n === '9 MOBILE' || n === 'ETISALAT' || n === 'GLOBACOM') return n === 'GLOBACOM' ? 'GLO' : '9MOBILE';
  return '';
}

// PairGate wants the local form (0803...), same as the bills rail.
function normalizeNgLocal(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  let local = '';
  if (digits.length === 11 && digits.startsWith('0')) local = digits;
  else if (digits.length === 13 && digits.startsWith('234')) local = `0${digits.slice(3)}`;
  else if (digits.length === 10) local = `0${digits}`;
  return /^0[789][01]\d{8}$/.test(local) ? local : '';
}

function parseSizeMb(name) {
  const s = String(name || '');
  const gb = /([0-9]+(?:\.[0-9]+)?)\s*gb/i.exec(s);
  if (gb) {
    const v = Number(gb[1]);
    if (Number.isFinite(v)) return Math.round(v * 1024);
  }
  const mb = /\b([0-9]{2,5})\s*mb\b/i.exec(s);
  if (mb) {
    const v = Number(mb[1]);
    if (Number.isFinite(v)) return Math.round(v);
  }
  return null;
}

// The reward is a fixed bundle size, but the catalogue rarely names a plan
// exactly that. Take the closest bundle by size, cheapest on a tie, and fall
// back to the whole list if no name parses - a reward that picks something is
// better than a claim window that expires.
function pickBestDataPlan(plans, targetMb = DATA_REWARD_MB) {
  const enriched = (Array.isArray(plans) ? plans : [])
    .filter(p => String(p?.id ?? '').trim() && Number(p?.amount || 0) > 0)
    .map(p => ({
      id: String(p.id),
      name: String(p.name || 'Data Bundle').trim(),
      amount: Number(p.amount),
      sizeMb: parseSizeMb(p.name),
    }));

  // A 20% band around the target: wide enough to catch a 512MB plan sold as
  // "500MB", narrow enough that a 1GB bundle never counts as a 500MB reward.
  const lower = targetMb * 0.8;
  const upper = targetMb * 1.2;

  const candidates = enriched.filter(p =>
    p.sizeMb != null && p.sizeMb >= lower && p.sizeMb <= upper,
  );

  const pool = candidates.length ? candidates : enriched;
  if (!pool.length) return null;

  pool.sort((a, b) => {
    const aDiff = a.sizeMb != null ? Math.abs(a.sizeMb - targetMb) : Number.MAX_SAFE_INTEGER;
    const bDiff = b.sizeMb != null ? Math.abs(b.sizeMb - targetMb) : Number.MAX_SAFE_INTEGER;
    if (aDiff !== bDiff) return aDiff - bDiff;
    if (a.amount !== b.amount) return a.amount - b.amount;
    return a.name.localeCompare(b.name);
  });

  return pool[0];
}

// `upstream` is the resolved provider module, not a name - the plan id it
// returns is only meaningful to the module that produced it, so the two must
// never be read apart.
async function autoPickRewardPlanId({ upstream, provider, targetMb = DATA_REWARD_MB }) {
  const best = pickBestDataPlan(await upstream.listDataPlansCached(provider), targetMb);
  return best ? { planId: best.id, planName: best.name } : null;
}

async function validateUserPin({ userId, pinInput }) {
  const freshUser = await prisma.user.findUnique({ where: { id: Number(userId) } });
  if (!freshUser) {
    const err = new Error('Please login again');
    err.statusCode = 401;
    throw err;
  }

  const valid = (await verifySecret(String(pinInput), freshUser.pin, 'pin')).ok;
  if (!valid) {
    const err = new Error('Invalid PIN');
    err.statusCode = 401;
    throw err;
  }
  return true;
}

/**
 * Count the recharges that actually earned progress, per user.
 *
 * `meta.type` is stamped only once PairGate accepts (bills.controller), so a
 * purchase still in flight does not count. That is deliberate - the challenge is
 * about recharges that landed.
 *
 * A purchase the provider then declined is refunded, and the credit leg carries
 * `meta.reversal_of` holding the original `trx` (billSettlement.helper). On this
 * rail a decline can also arrive minutes later on the webhook rather than on the
 * purchase call, so progress can legitimately go down as well as up.
 * Those come back off the count: without it a user reaches the target on ten
 * recharges that never landed and claims a reward against money still in their
 * own wallet. Same rule the statement and the spending insight apply.
 *
 * `availability` is the admin lock. Progress is derived here rather than stored,
 * so "no progress while locked" is enforced at this line and nowhere else - a
 * recharge made while Bill Hero was shut is simply not counted, before and
 * after the lock is lifted alike. Omit it and everything counts, which is what
 * the unit test and any caller with no config loaded want.
 */
function tallyRows(rows, reversals, availability = null) {
  const refunded = new Set();
  for (const r of reversals || []) {
    const ref = r?.meta && typeof r.meta === 'object' ? r.meta.reversal_of : null;
    if (ref) refunded.add(String(ref));
  }

  const byUser = new Map();
  for (const r of rows || []) {
    if (refunded.has(String(r?.trx))) continue;

    if (availability && r?.created_at && !openAt(availability, new Date(r.created_at))) continue;

    const kind = String(r?.meta?.type || '').toLowerCase();
    if (kind !== 'airtime' && kind !== 'data') continue;

    const uid = Number(r.user_id);
    const entry = byUser.get(uid) || { user_id: uid, airtime_count: 0, data_count: 0, points: 0 };
    if (kind === 'airtime') entry.airtime_count += 1;
    else entry.data_count += 1;
    entry.points = entry.airtime_count * POINTS_PER_AIRTIME + entry.data_count * POINTS_PER_DATA;
    byUser.set(uid, entry);
  }

  return byUser;
}

/** tallyRows over one week. Omit userId for the whole leaderboard. */
async function tallyWeek({ weekStart, weekEnd, userId = null, availability = null }) {
  const scope = userId ? { user_id: Number(userId) } : {};

  const [rows, reversals] = await Promise.all([
    // ponytail: rows rather than a groupBy, because excluding a refund needs
    // each row's trx. One week of recharges; batch by user_id if that stops
    // fitting in memory.
    prisma.walletTransaction.findMany({
      where: {
        ...scope,
        remark: 'mobile_recharge',
        trx_type: '-',
        created_at: { gte: weekStart, lt: weekEnd },
        amount: { gte: MIN_QUALIFYING_AMOUNT },
      },
      // created_at is selected for the lock check, not for display - a recharge
      // made while Bill Hero was shut earns nothing.
      select: { user_id: true, trx: true, meta: true, created_at: true },
    }),
    // No upper bound: a refund for Sunday's purchase lands on Monday, after the
    // week it cancels has closed. One that lands after the reward is already
    // claimed does not claw it back - the claim row is the record of that.
    prisma.walletTransaction.findMany({
      where: { ...scope, remark: 'mobile_recharge', trx_type: '+', created_at: { gte: weekStart } },
      select: { meta: true },
    }),
  ]);

  return tallyRows(rows, reversals, availability);
}

async function weeklyCounts({ userId, weekStart, weekEnd, availability = null }) {
  const entry = (await tallyWeek({ weekStart, weekEnd, userId, availability })).get(Number(userId));
  return { airtimeCount: entry?.airtime_count || 0, dataCount: entry?.data_count || 0 };
}

/**
 * GET /bill-hero/status - the gate the app calls before it shows anything.
 *
 * Deliberately cheap: config read (Redis, 30s) and no tally at all, so the home
 * screen can ask on every load. Always 200, even when shut - the app needs the
 * lock message to render, and an error response would just produce a toast.
 */
async function status(req, res) {
  try {
    const config = await getConfig();
    const state = evaluate(config);

    return res.json({
      remark: 'bill_hero_status',
      status: 'success',
      message: ['OK'],
      data: { availability: publicAvailability(config, state) },
    });
  } catch (e) {
    const code = Number(e?.statusCode) || 500;
    return res.status(code).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function me(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const now = new Date();
    const weekStart = startOfWeekLagosUtc(now);
    const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    const week_key = isoWeekKey(now);

    // Carried in the response rather than returned as an error: the screen
    // needs the counts and the lock message together to render the shut state
    // without a second round trip.
    const availability = await getConfig();
    const availabilityState = evaluate(availability, now);

    const { airtimeCount, dataCount } = await weeklyCounts({ userId: user.id, weekStart, weekEnd, availability });
    const counts = { airtime: airtimeCount, data: dataCount };

    const { start: claimStart, end: claimEnd } = claimWindowForWeek(weekStart);
    const inClaimWindow = now >= claimStart && now < claimEnd && availabilityState.open;

    const running = (await listChallenges()).filter((c) => isRunning(c, now));

    // Processing is read alongside claimed on purpose: a claim that is mid
    // flight has already spent the entitlement, so offering the button again
    // would buy the reward twice.
    const claims = await prisma.billHeroClaim.findMany({
      where: {
        user_id: Number(user.id),
        week_key,
        status: { in: ['claimed', 'processing'] },
      },
      select: { challenge_id: true, status: true },
    });

    const claimStateByChallenge = new Map(
      claims.map((c) => [Number(c.challenge_id), String(c.status || '').toLowerCase()]),
    );

    const challenges = running.map((c) => {
      const state = claimStateByChallenge.get(Number(c.id)) || '';
      const completed = isCompleted(c, counts);
      const claimed = state === 'claimed';
      const processing = state === 'processing';

      return {
        ...publicChallenge(c, now),
        progress: progressFor(c, counts),
        completed,
        claimed,
        processing,
        claimable: completed && inClaimWindow && !claimed && !processing,
      };
    });

    // The airtime/data pair the app showed before challenges were rows. Kept
    // because a copy of the old build is still on somebody's phone and would
    // otherwise render an empty screen; new builds read `challenges`.
    const legacyAirtime = challenges.find((c) => c.action_type === 'airtime') || null;
    const legacyData = challenges.find((c) => c.action_type === 'data') || null;

    const airtime_completed = legacyAirtime?.completed === true;
    const data_completed = legacyData?.completed === true;
    const airtime_claimed = legacyAirtime?.claimed === true;
    const data_claimed = legacyData?.claimed === true;
    const airtime_claimable = legacyAirtime?.claimable === true;
    const data_claimable = legacyData?.claimable === true;

    const claim_seconds_remaining = inClaimWindow ? Math.max(0, Math.floor((claimEnd.getTime() - now.getTime()) / 1000)) : 0;
    const week_seconds_remaining = Math.max(0, Math.floor((weekEnd.getTime() - now.getTime()) / 1000));

    const points = airtimeCount * POINTS_PER_AIRTIME + dataCount * POINTS_PER_DATA;

    return res.json({
      remark: 'bill_hero_me',
      status: 'success',
      message: ['OK'],
      data: {
        week_key,
        availability: publicAvailability(availability, availabilityState),
        challenges,
        points,
        airtime_count: airtimeCount,
        data_count: dataCount,
        airtime_completed,
        data_completed,
        airtime_claimed,
        data_claimed,
        airtime_claimable,
        data_claimable,
        claim_seconds_remaining,
        week_seconds_remaining,
        claim_window: {
          start: claimStart.toISOString(),
          end: claimEnd.toISOString(),
        },
        rules: {
          min_amount: MIN_QUALIFYING_AMOUNT,
          points_per_airtime: POINTS_PER_AIRTIME,
          points_per_data: POINTS_PER_DATA,
          // Read off whichever challenge is actually running, so an admin
          // raising a target moves the old app's progress bar too.
          airtime_target: legacyAirtime?.target ?? AIRTIME_TARGET,
          data_target: legacyData?.target ?? DATA_TARGET,
          airtime_reward_amount: legacyAirtime?.reward_value ?? AIRTIME_REWARD_AMOUNT,
          data_reward: legacyData?.reward_label ?? DATA_REWARD_LABEL,
          data_reward_mb: legacyData?.reward_value ?? DATA_REWARD_MB,
        },
      },
    });
  } catch (e) {
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function leaderboard(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const now = new Date();
    const weekStart = startOfWeekLagosUtc(now);
    const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    const week_key = isoWeekKey(now);

    // Same tally the challenge uses, so the board cannot show a user a count
    // their own progress screen disagrees with - including the lock, which
    // would otherwise credit the board for recharges the challenge ignores.
    const map = await tallyWeek({ weekStart, weekEnd, availability: await getConfig() });

    const rows = Array.from(map.values())
      .sort((a, b) => (b.points - a.points) || (b.airtime_count - a.airtime_count) || (b.data_count - a.data_count) || (a.user_id - b.user_id))
      .slice(0, 30);

    const ids = rows.map((r) => Number(r.user_id));
    const users = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, firstname_enc: true, lastname_enc: true, username_enc: true, image: true },
    });

    const nameMap = new Map();
    const imageMap = new Map();
    for (const u of users) {
      const uPii = revealUserFields(u);
      const fn = String(uPii.firstname || '').trim();
      const ln = String(uPii.lastname || '').trim();
      const masked = fn ? `${fn} ${ln ? `${ln.substring(0, 1).toUpperCase()}.` : ''}`.trim() : (String(uPii.username || 'User').trim() || 'User');
      nameMap.set(Number(u.id), masked);
      imageMap.set(Number(u.id), u.image ? String(u.image) : '');
    }

    const leaderboard = rows.map((r) => ({
      user_id: r.user_id,
      name: nameMap.get(Number(r.user_id)) || 'User',
      image: imageMap.get(Number(r.user_id)) || '',
      points: r.points,
      airtime_count: r.airtime_count,
      data_count: r.data_count,
    }));

    const my = map.get(Number(user.id)) || { user_id: Number(user.id), airtime_count: 0, data_count: 0, points: 0 };
    const myRank = leaderboard.findIndex((x) => Number(x.user_id) === Number(user.id));

    return res.json({
      remark: 'bill_hero_leaderboard',
      status: 'success',
      message: ['OK'],
      data: {
        week_key,
        leaderboard,
        me: {
          user_id: Number(user.id),
          points: my.points,
          airtime_count: my.airtime_count,
          data_count: my.data_count,
          rank: myRank >= 0 ? myRank + 1 : null,
        },
      },
    });
  } catch (e) {
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function claim(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const challengeId = Number(req.body?.challenge_id);
    const legacyType = String(req.body?.reward_type || '').trim().toLowerCase();
    const phoneRaw = String(req.body?.phone || '').trim();
    const network = String(req.body?.network || '').trim().toUpperCase();
    const pin = String(req.body?.pin || '').trim();

    if (!Number.isInteger(challengeId) && legacyType !== 'airtime' && legacyType !== 'data') {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid challenge'], data: null });
    }

    const digitsPhone = phoneRaw.replace(/\D/g, '');
    if (!digitsPhone || digitsPhone.length < 10 || digitsPhone.length > 15) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid phone number'], data: null });
    }

    if (!network) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Network is required'], data: null });
    }

    if (!pin) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['PIN is required'], data: null });
    }

    await validateUserPin({ userId: user.id, pinInput: pin });

    const now = new Date();
    const weekStart = startOfWeekLagosUtc(now);
    const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    const week_key = isoWeekKey(now);

    // The route guard already refused a locked claim, but this is the leg that
    // spends real money on airtime, so the lock is re-read here rather than
    // trusted from a middleware that a future route change could drop.
    const availability = req.billHero?.config || (await getConfig());
    const availabilityState = evaluate(availability, now);
    if (!availabilityState.open) {
      return res.status(423).json({
        remark: 'bill_hero_locked',
        status: 'error',
        message: [availabilityState.message],
        data: { availability: publicAvailability(availability, availabilityState) },
      });
    }

    // Only a challenge that is running right now can be claimed. Resolved from
    // the live list rather than from whatever id the app was holding, so a
    // challenge deactivated an hour ago cannot still be cashed in by a screen
    // that has not been refreshed.
    const running = (await listChallenges()).filter((c) => isRunning(c, now));

    const challenge = Number.isInteger(challengeId)
      ? running.find((c) => Number(c.id) === challengeId)
      : running.find((c) => c.action_type === legacyType && c.reward_type === legacyType) ||
        running.find((c) => c.action_type === legacyType);

    if (!challenge) {
      return res.status(400).json({ remark: 'challenge_unavailable', status: 'error', message: ['This challenge is no longer running'], data: null });
    }

    const reward_type = String(challenge.reward_type);

    const { airtimeCount, dataCount } = await weeklyCounts({ userId: user.id, weekStart, weekEnd, availability });

    const { start: claimStart, end: claimEnd } = claimWindowForWeek(weekStart);
    const inClaimWindow = now >= claimStart && now < claimEnd;
    if (!inClaimWindow) {
      return res.status(400).json({ remark: 'not_claim_time', status: 'error', message: ['Rewards can only be claimed on Saturday (24 hours)'], data: { claim_start: claimStart.toISOString(), claim_end: claimEnd.toISOString() } });
    }

    if (!isCompleted(challenge, { airtime: airtimeCount, data: dataCount })) {
      return res.status(400).json({ remark: 'not_completed', status: 'error', message: ['Challenge not completed yet'], data: null });
    }

    const existing = await prisma.billHeroClaim.findFirst({
      where: {
        user_id: Number(user.id),
        week_key,
        challenge_id: Number(challenge.id),
      },
    });

    if (existing && String(existing.status || '').toLowerCase() === 'claimed') {
      return res.status(400).json({ remark: 'already_claimed', status: 'error', message: ['Reward already claimed'], data: null });
    }

    if (existing && String(existing.status || '').toLowerCase() === 'processing') {
      return res.status(400).json({ remark: 'processing', status: 'error', message: ['Claim is processing. Please try again shortly.'], data: null });
    }

    const provider = networkFromName(network);
    if (!provider) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid network'], data: null });
    }

    const localPhone = normalizeNgLocal(digitsPhone);
    if (!localPhone) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid phone number'], data: null });
    }

    // Resolved once, before the row is written, and used for both the vend and
    // the `provider` column. Reading them apart - vending with one and recording
    // the other - is what would leave a webhook unable to tell whose reference
    // this is. `provider` above is the customer's NETWORK; `gateway` is the
    // upstream we buy from.
    const { name: gateway, provider: upstream } = await bills.resolve(reward_type === 'airtime' ? 'airtime' : 'data');

    let claimRow = existing;
    if (!claimRow) {
      try {
        claimRow = await prisma.billHeroClaim.create({
          data: {
            user_id: Number(user.id),
            challenge_id: Number(challenge.id),
            week_key,
            reward_type,
            // Snapshotted, not looked up later: an admin editing the challenge
            // must not restate what was already paid out.
            reward_value: Number(challenge.reward_value),
            phone_enc: encryptValue(digitsPhone),
            network,
            status: 'processing',
            provider: gateway,
          },
        });
      } catch (e) {
        if (e?.code === 'P2002') {
          claimRow = await prisma.billHeroClaim.findFirst({ where: { user_id: Number(user.id), week_key, challenge_id: Number(challenge.id) } });
        } else {
          throw e;
        }
      }
    } else {
      claimRow = await prisma.billHeroClaim.update({
        where: { id: Number(claimRow.id) },
        data: {
          reward_type,
          reward_value: Number(challenge.reward_value),
          phone_enc: encryptValue(digitsPhone),
          network,
          status: 'processing',
          // Re-stamped, not left alone. A reward being re-claimed after a
          // failure is exactly the case where an admin has since moved the
          // rail, and the row has to name the provider this attempt actually
          // used or its callback cannot be matched to it.
          provider: gateway,
        },
      });
    }

    const requestId = `bh_${reward_type}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

    try {
      let providerResp;
      if (reward_type === 'airtime') {
        providerResp = await upstream.buyAirtime({
          provider,
          number: localPhone,
          amount: Number(challenge.reward_value),
          reference: requestId,
        });
      } else {
        const picked = await autoPickRewardPlanId({ upstream, provider, targetMb: Number(challenge.reward_value) });
        if (!picked || !picked.planId) {
          return res.status(502).json({
            remark: 'provider_error',
            status: 'error',
            message: [`Unable to find a ${rewardLabel(challenge)} plan for the selected network. Please try again later.`],
            data: { network },
          });
        }
        providerResp = await upstream.buyData({
          provider,
          planId: picked.planId,
          number: localPhone,
          reference: requestId,
        });

        try {
          providerResp._bill_hero_selected_plan = {
            id: picked.planId,
            name: picked.planName,
          };
        } catch (_) {}
      }

      // Through the provider module, not by reaching into the raw body: PairGate
      // calls this `data.reference_code` and ClubKonnect calls it `orderid`, and
      // reading the wrong key silently stores our own request id as the provider
      // reference - which still looks fine here, and then never matches a
      // delivery notification. The module that vended is the one that parses.
      const providerRef = upstream.parseVendResult(providerResp).reference;

      await prisma.billHeroClaim.update({
        where: { id: Number(claimRow.id) },
        data: {
          status: 'claimed',
          provider_ref: providerRef || requestId,
          provider_payload: providerResp,
          claimed_at: new Date(),
        },
      });

      return res.json({
        remark: 'bill_hero_claimed',
        status: 'success',
        message: ['Reward claimed successfully'],
        data: {
          challenge_id: Number(challenge.id),
          reward_type,
          reward_value: Number(challenge.reward_value),
          reward_label: rewardLabel(challenge),
          phone: digitsPhone,
          network,
          provider_ref: providerRef || requestId,
        },
      });
    } catch (err) {
      try {
        await prisma.billHeroClaim.update({
          where: { id: Number(claimRow.id) },
          data: {
            status: 'failed',
            // Whichever rail raised it. Each provider module attaches its own
            // response under its own name, so both are read rather than
            // defaulting to the message and losing the upstream detail.
            provider_payload: err?.pairgate || err?.clubkonnect || err?.message || null,
          },
        });
      } catch (_) {}

      const status = Number(err?.statusCode) || 400;
      return res.status(status).json({
        remark: 'provider_error',
        status: 'error',
        message: [err?.message || 'Failed to claim reward'],
        data: err?.pairgate || err?.clubkonnect || null,
      });
    }
  } catch (e) {
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

module.exports = {
  me,
  leaderboard,
  claim,
  history,
  status,
  // shared with the admin controller, which reports on the same numbers the
  // app shows - two tallies would eventually disagree.
  tallyWeek,
  weeklyCounts,
  RULES: {
    MIN_QUALIFYING_AMOUNT,
    AIRTIME_TARGET,
    DATA_TARGET,
    AIRTIME_REWARD_AMOUNT,
    DATA_REWARD_MB,
    DATA_REWARD_LABEL,
    POINTS_PER_AIRTIME,
    POINTS_PER_DATA,
  },
  // exported for tests
  startOfWeekLagosUtc,
  claimWindowForWeek,
  isoWeekKey,
  tallyRows,
  parseSizeMb,
  pickBestDataPlan,
  networkFromName,
  normalizeNgLocal,
};
