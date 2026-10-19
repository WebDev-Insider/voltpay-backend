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
const { notifyUser } = require('../services/notify.service');
const alerts = require('../services/alerts.service');

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

// Reward delivery - see "reward delivery" below for the whole state machine.
//
// One reward is sent at most this many times - the claim plus three re-sends -
// before it is handed back for the customer to claim with another number.
const REWARD_MAX_ATTEMPTS = 4;
// The wait before each re-send, by the send that just failed. Spaced out
// because "accepted, then failed" almost always means the network was down,
// and re-sending into the same outage a minute later changes nothing.
const REWARD_RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
// A send quiet this long was cut off - a crash, or an outage mid-request - and
// is asked about by its reference. Far longer than any request takes.
const REWARD_SEND_STALE_MS = 10 * 60_000;
// An accepted reward is not asked about again within this long of being sent.
const REWARD_PENDING_MIN_AGE_MS = 60_000;
// Unconfirmed past this, the sweep says so out loud.
const REWARD_STUCK_ALERT_MS = 60 * 60_000;
// Unconfirmed past this, it is handed back rather than left in limbo: a day is
// far beyond any real network delay, and the customer can claim it again.
const REWARD_UNRESOLVED_HANDBACK_MS = 24 * 60 * 60_000;
// How long a handed-back reward stays claimable, whatever the calendar says.
// Its failure can be confirmed after the Saturday window has shut.
const REWARD_RECLAIM_GRACE_MS = 72 * 60 * 60_000;

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

// The local form (0803...), same as the bills rail carries. The provider
// module converts it to whatever form its API wants.
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
 * `meta.type` is stamped only once the provider accepts (bills.controller), so a
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

    // A reward we could not deliver after every re-send is claimable again for
    // a while, outside the Saturday window - its failure can be confirmed after
    // the window shut, and the customer did nothing wrong. See
    // listReclaimableClaims.
    const reclaimableChallenges = new Set(
      (await listReclaimableClaims({ userId: user.id, now })).map((c) => Number(c.challenge_id)),
    );

    const challenges = running.map((c) => {
      const state = claimStateByChallenge.get(Number(c.id)) || '';
      const completed = isCompleted(c, counts);
      const claimed = state === 'claimed';
      const processing = state === 'processing';
      const reclaimable = reclaimableChallenges.has(Number(c.id)) && availabilityState.open && !processing;

      return {
        ...publicChallenge(c, now),
        progress: progressFor(c, counts),
        completed,
        claimed,
        processing,
        claimable: (completed && inClaimWindow && !claimed && !processing) || reclaimable,
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

    const provider = networkFromName(network);
    if (!provider) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid network'], data: null });
    }

    const localPhone = normalizeNgLocal(digitsPhone);
    if (!localPhone) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid phone number'], data: null });
    }

    // A reward we accepted, re-sent, and still could not deliver is handed back
    // to its owner for a while whatever the calendar says - its failure can be
    // confirmed long after the Saturday window shut, and the customer did
    // nothing wrong. It was earned in its own week, so it is not re-checked
    // against this one, and it keeps the value it was earned at.
    const carried = await findReclaimableClaim({ userId: user.id, challengeId: challenge.id, now });

    let reward_type = String(challenge.reward_type);
    let reward_value = Number(challenge.reward_value);
    let target = null;

    if (carried) {
      reward_type = String(carried.reward_type);
      reward_value = Number(carried.reward_value);
      target = carried;
    } else {
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

      target = existing;
    }

    // Resolved once, before the row is written, and used for both the vend and
    // the `provider` column. Reading them apart - vending with one and recording
    // the other - is what would leave a webhook unable to tell whose reference
    // this is. `provider` above is the customer's NETWORK; `gateway` is the
    // upstream we buy from.
    //
    // resolveForRewards, not resolve: a reward cut off mid-send is asked about by
    // the reference minted below, so it may only go to an upstream that receives
    // that reference. A rail switched to one that does not (CashBuddy) sends
    // rewards through the default instead.
    const { name: gateway, provider: upstream } = await bills.resolveForRewards(reward_type === 'airtime' ? 'airtime' : 'data');

    // The reference is minted before anything is sent and written with the row.
    // A send that is cut off - a crash, a timeout the provider module could not
    // resolve - can then still be asked about by the delivery sweep. Written
    // after the purchase, as it used to be, a lost answer left nothing to look
    // the reward up by, and the row sat in `processing` for good.
    const requestId = newRewardReference(reward_type);
    const sending = {
      status: 'processing',
      reward_type,
      reward_value,
      phone_enc: encryptValue(digitsPhone),
      network,
      // Re-stamped on a re-claim, not left alone: the rail may have moved since
      // the attempt that failed, and the row has to name the provider this
      // attempt actually used or its reference cannot be matched to it.
      provider: gateway,
      provider_ref: requestId,
      provider_payload: { delivery: 'sending', attempts: 1, reference: requestId },
      claimed_at: now,
    };

    let claimRow;
    if (target) {
      // Conditional on the row still being the failed one we read, so two taps
      // on the button - or a tap racing the delivery sweep - cannot both end up
      // sending a reward.
      const taken = await prisma.billHeroClaim.updateMany({
        where: { id: Number(target.id), status: 'failed' },
        data: sending,
      });
      if (!taken.count) {
        return res.status(400).json({ remark: 'processing', status: 'error', message: ['Claim is processing. Please try again shortly.'], data: null });
      }
      claimRow = { ...target, ...sending };
    } else {
      try {
        claimRow = await prisma.billHeroClaim.create({
          data: {
            user_id: Number(user.id),
            challenge_id: Number(challenge.id),
            week_key,
            // reward_value is snapshotted, not looked up later: an admin editing
            // the challenge must not restate what was already paid out.
            ...sending,
          },
        });
      } catch (e) {
        // A second request created this claim a moment ago and is sending it
        // now. Sending again here would deliver the reward twice.
        if (e?.code === 'P2002') {
          return res.status(400).json({ remark: 'processing', status: 'error', message: ['Claim is processing. Please try again shortly.'], data: null });
        }
        throw e;
      }
    }

    const claimedData = delivery => ({
      challenge_id: Number(challenge.id),
      reward_type,
      reward_value,
      reward_label: rewardLabel({ reward_type, reward_value }),
      phone: digitsPhone,
      network,
      provider_ref: requestId,
      delivery,
    });

    try {
      const { vended, plan } = await sendReward({
        upstream,
        rewardType: reward_type,
        rewardValue: reward_value,
        network,
        phoneLocal: localPhone,
        reference: requestId,
      });

      // Through the provider module, not by reaching into the raw body: every
      // provider names its reference differently, and reading the wrong key
      // silently stores the wrong value as the provider reference - which still
      // looks fine here, and then never matches a delivery report. The module
      // that vended is the one that parses.
      const reference = vended.reference || requestId;

      // Delivered, or accepted and still on its way. Only the first reads
      // "Delivered" in the app: an accepted reward stays `processing` until the
      // sweep confirms it, because "accepted" can still fail.
      const next = nextDeliveryState(
        {
          provider_ref: reference,
          provider_payload: { ...sending.provider_payload, reference, amount: vended.amount || null, plan },
        },
        vended.status === 'successful' ? 'delivered' : 'pending'
      );
      await prisma.billHeroClaim.update({
        where: { id: Number(claimRow.id) },
        data: { ...next, provider_ref: reference },
      });

      const delivered = next.status === 'claimed';
      return res.json({
        remark: 'bill_hero_claimed',
        status: 'success',
        message: [
          delivered
            ? 'Reward claimed successfully'
            : 'Reward claimed. It is on its way and should arrive within a few minutes.',
        ],
        data: { ...claimedData(delivered ? 'delivered' : 'pending'), provider_ref: reference },
      });
    } catch (err) {
      // The provider module already asked about it and still could not say
      // whether it went. The row stays a send in flight under this reference,
      // and the delivery sweep finishes it - confirms it, re-sends it, or hands
      // it back - without anybody having to.
      if (err?.ambiguous) {
        return res.json({
          remark: 'bill_hero_claimed',
          status: 'success',
          message: ['Your reward is being processed. It should arrive within a few minutes.'],
          data: claimedData('sending'),
        });
      }

      // Refused outright - an unknown network, a number the network rejected,
      // no plan of this size. The customer sees why now and can claim again.
      try {
        await prisma.billHeroClaim.update({
          where: { id: Number(claimRow.id) },
          data: {
            status: 'failed',
            provider_payload: { delivery: 'refused', attempts: 1, reference: requestId, last_failure: failureOf(err) },
          },
        });
      } catch (_) {}

      const status = Number(err?.statusCode) || 400;
      return res.status(status).json({
        remark: 'provider_error',
        status: 'error',
        message: [err?.message || 'Failed to claim reward'],
        data: err?.kind === 'no_plan' ? { network } : null,
      });
    }
  } catch (e) {
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

/* ------------------------------------------------------------ reward delivery */

// Finishing a reward, with nobody involved.
//
// A reward the provider accepts is not a reward delivered: MySubWallet can
// answer `pending` and fail minutes later, and the webhook that would report it
// cannot be configured on their dashboard. Left alone, that reward would read
// "Delivered" in the app and never arrive - and the Saturday window may have
// shut before anyone noticed. So delivery is tracked on the claim row, in the
// app's own three words:
//
//   processing  being sent, accepted and awaiting confirmation, or due a re-send
//   claimed     confirmed delivered - the app shows "Delivered"
//   failed      refused, or undeliverable after every re-send - claimable again
//
// `provider_payload.delivery` holds the detail the sweep works from:
//
//   sending        a send is in flight. Quiet past REWARD_SEND_STALE_MS, it was
//                  cut off, and it is asked about by its reference.
//   pending        accepted, not yet confirmed. Asked about every pass.
//   retrying       the last send failed. Re-sent at `next_attempt_at`, with a
//                  fresh reference, up to REWARD_MAX_ATTEMPTS sends in all.
//   delivered      done.
//   refused        refused at claim time. The customer saw why and can retry.
//   undeliverable  every send failed. Handed back until `reclaim_until`, and
//                  the customer is told.
//
// A reward is free, so a failed one owes nobody a refund - what it owes the
// customer is the reward. Every write the sweep makes is conditional on the row
// being exactly as it was read, so two instances - or the sweep and a delivery
// report - can never both re-send one reward.

function newRewardReference(rewardType) {
  return `bh_${rewardType}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function payloadOf(claim) {
  const payload = claim?.provider_payload;
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? { ...payload } : {};
}

// What a failed send is recorded as: our wording and the failure's kind. Never
// the provider's text - a refusal can quote the number it refused, and this
// column is not encrypted.
function failureOf(err) {
  return { message: err?.message || null, kind: err?.kind || null, status_code: err?.statusCode || null };
}

function maskedNumber(local) {
  const s = String(local || '');
  return s.length >= 8 ? `${s.slice(0, 4)}***${s.slice(-4)}` : 'your number';
}

/**
 * Buy one reward. Used by the claim and by every re-send, so the two can never
 * disagree about what a reward is.
 *
 * A data reward is matched against the LIVE catalogue each time: plan ids are
 * not portable between providers, and a re-send may go out on a rail that has
 * been switched since the claim.
 */
async function sendReward({ upstream, rewardType, rewardValue, network, phoneLocal, reference }) {
  const provider = networkFromName(network);
  if (!provider) throw Object.assign(new Error('Invalid network'), { statusCode: 400, kind: 'input' });

  if (rewardType === 'airtime') {
    const response = await upstream.buyAirtime({ provider, number: phoneLocal, amount: Number(rewardValue), reference });
    return { vended: upstream.parseVendResult(response), plan: null };
  }

  const picked = await autoPickRewardPlanId({ upstream, provider, targetMb: Number(rewardValue) });
  if (!picked || !picked.planId) {
    const label = rewardLabel({ reward_type: rewardType, reward_value: rewardValue });
    throw Object.assign(new Error(`Unable to find a ${label} plan for the selected network. Please try again later.`), {
      statusCode: 502,
      kind: 'no_plan',
    });
  }

  const response = await upstream.buyData({ provider, planId: picked.planId, number: phoneLocal, reference });
  return { vended: upstream.parseVendResult(response), plan: { id: picked.planId, name: picked.planName } };
}

/**
 * The claim row's next state, given what is now known about its current send.
 *
 * `outcome` is 'delivered', 'pending', 'failed' (the provider said so) or
 * 'lost' (it never reached them). `final` hands the reward back whatever the
 * attempt count - for a reward that cannot be sent at all, or one unconfirmed
 * for so long that waiting longer helps nobody. Pure, so the whole state
 * machine is testable without a database.
 */
function nextDeliveryState(claim, outcome, { failure = null, now = new Date(), final = false } = {}) {
  const payload = payloadOf(claim);
  const attempts = Math.max(1, Number(payload.attempts) || 1);
  const at = now.toISOString();

  if (outcome === 'delivered') {
    return {
      status: 'claimed',
      provider_payload: { ...payload, delivery: 'delivered', delivered_at: at, next_attempt_at: null },
    };
  }

  if (outcome === 'pending') {
    return { status: 'processing', provider_payload: { ...payload, delivery: 'pending', next_attempt_at: null } };
  }

  const history = [
    ...(Array.isArray(payload.history) ? payload.history : []),
    { reference: payload.reference || claim?.provider_ref || null, outcome, at },
  ].slice(-REWARD_MAX_ATTEMPTS);

  if (final || attempts >= REWARD_MAX_ATTEMPTS) {
    return {
      status: 'failed',
      provider_payload: {
        ...payload,
        delivery: 'undeliverable',
        history,
        last_failure: failure,
        gave_up_at: at,
        reclaim_until: new Date(now.getTime() + REWARD_RECLAIM_GRACE_MS).toISOString(),
        next_attempt_at: null,
      },
    };
  }

  return {
    status: 'processing',
    provider_payload: {
      ...payload,
      delivery: 'retrying',
      history,
      last_failure: failure,
      next_attempt_at: new Date(now.getTime() + REWARD_RETRY_DELAYS_MS[attempts - 1]).toISOString(),
    },
  };
}

// Apply a transition only if the row is still the one that was read. True when
// this caller won the write; false when somebody else got there first.
async function writeIfUnchanged(claim, data) {
  const result = await prisma.billHeroClaim.updateMany({
    where: {
      id: Number(claim.id),
      status: claim.status,
      provider_ref: claim.provider_ref ?? null,
      updated_at: claim.updated_at,
    },
    data,
  });
  return result.count === 1;
}

/**
 * Tell the customer their reward is theirs to claim again, and tell us.
 *
 * Never throws: the claim row has already been written, and a failed push must
 * not unwind it.
 */
async function handBackReward(claim) {
  const payload = payloadOf(claim);
  const phone = normalizeNgLocal(revealClaimPhone(claim.phone_enc));
  const label = rewardLabel(claim);
  const tries = Number(payload.attempts) || 1;

  await notifyUser({
    userId: claim.user_id,
    subject: 'Your Bill Hero reward could not be delivered',
    message:
      `We could not deliver your ${label} reward to ${maskedNumber(phone)} after ${tries} ${tries === 1 ? 'try' : 'tries'}. ` +
      'Open Bill Hero to claim it again with another number - it stays claimable for 3 days.',
    type: 'bill_hero',
    data: { claim_id: Number(claim.id), week_key: String(claim.week_key || '') },
  }).catch(() => null);

  alerts.paymentFailure({
    provider: String(claim.provider || 'unknown'),
    action: 'reward_undeliverable',
    reference: String(payload.reference || claim.provider_ref || ''),
    userId: claim.user_id,
    message: `Bill Hero reward undeliverable after ${tries} send(s) - handed back to the customer`,
  });
}

async function settleReward(claim, outcome, opts = {}) {
  const next = nextDeliveryState(claim, outcome, { now: new Date(), ...opts });
  if (!(await writeIfUnchanged(claim, next))) return 'skipped';
  if (next.status === 'failed') await handBackReward({ ...claim, ...next });
  if (next.status === 'claimed') return 'delivered';
  return next.status === 'failed' ? 'handed_back' : next.provider_payload.delivery;
}

/**
 * Send a reward again, under a fresh reference.
 *
 * The row is taken first - conditionally, so it is ours alone - and the new
 * reference written before anything is sent, for the same reason the claim
 * does it: a re-send that is cut off can still be asked about.
 */
async function resendReward(claim) {
  const payload = payloadOf(claim);
  const attempts = Math.max(1, Number(payload.attempts) || 1) + 1;

  const phoneLocal = normalizeNgLocal(revealClaimPhone(claim.phone_enc));
  if (!phoneLocal) {
    return settleReward(claim, 'failed', {
      final: true,
      failure: { message: 'The delivery number could not be read', kind: 'unknown', status_code: null },
    });
  }

  // Through the switch as it stands now, as a fresh claim would go: a re-send
  // is a new purchase, and the rail the first one left on may have moved. Same
  // rule as the claim about which upstreams a reward may use.
  const { name: gateway, provider: upstream } = await bills.resolveForRewards(claim.reward_type === 'airtime' ? 'airtime' : 'data');
  const reference = newRewardReference(claim.reward_type);
  const sending = { ...payload, delivery: 'sending', attempts, reference, next_attempt_at: null };

  if (!(await writeIfUnchanged(claim, { provider: gateway, provider_ref: reference, provider_payload: sending }))) {
    return 'skipped';
  }
  const sent = { ...claim, provider: gateway, provider_ref: reference, provider_payload: sending };

  try {
    const { vended, plan } = await sendReward({
      upstream,
      rewardType: claim.reward_type,
      rewardValue: claim.reward_value,
      network: claim.network,
      phoneLocal,
      reference,
    });
    const finalRef = vended.reference || reference;
    const next = nextDeliveryState(
      { ...sent, provider_payload: { ...sending, reference: finalRef, amount: vended.amount || null, plan } },
      vended.status === 'successful' ? 'delivered' : 'pending'
    );
    await prisma.billHeroClaim.update({ where: { id: Number(claim.id) }, data: { ...next, provider_ref: finalRef } });
    return next.status === 'claimed' ? 'delivered' : 'resent';
  } catch (err) {
    // Could not tell whether it went: left as a send in flight, and asked
    // about by its reference once it has been quiet long enough.
    if (err?.ambiguous) return 'in_flight';

    const next = nextDeliveryState(sent, 'failed', { failure: failureOf(err) });
    await prisma.billHeroClaim.update({ where: { id: Number(claim.id) }, data: next });
    if (next.status === 'failed') {
      await handBackReward({ ...sent, ...next });
      return 'handed_back';
    }
    return 'retrying';
  }
}

/**
 * Move one reward along: confirm it, re-send it, or hand it back.
 *
 * Returns what happened - 'delivered', 'resent', 'handed_back' or 'stuck' are
 * the ones worth counting - and never throws for a provider that is down: the
 * reward is simply asked about again next pass.
 */
async function advanceRewardDelivery(claim, { now = new Date() } = {}) {
  const payload = payloadOf(claim);
  const delivery = String(payload.delivery || '');
  const quietFor = now.getTime() - new Date(claim.updated_at).getTime();

  if (delivery === 'retrying') {
    if (new Date(payload.next_attempt_at || 0).getTime() > now.getTime()) return 'waiting';
    return resendReward(claim);
  }

  // Still inside the request that sent it.
  if (delivery === 'sending' && quietFor < REWARD_SEND_STALE_MS) return 'in_flight';
  if (delivery === 'pending' && quietFor < REWARD_PENDING_MIN_AGE_MS) return 'too_fresh';

  // Nothing to ask about: it never got as far as a reference, so it never
  // reached the provider. Sending it cannot double it.
  if (!claim.provider_ref) {
    return settleReward(claim, 'lost', {
      failure: { message: 'The send never reached the provider', kind: 'lost', status_code: null },
    });
  }

  let remote;
  try {
    remote = await bills.adapterFor(claim.provider).getTransactionStatus(claim.provider_ref);
  } catch (e) {
    console.error('billHero.delivery requery failed:', { claim_id: claim.id, error: e?.providerMessage || e?.message });
    return 'provider_error';
  }

  const state = String(remote?.status || '');

  if (state === 'successful') return settleReward(claim, 'delivered');

  if (state === 'failed') {
    return settleReward(claim, 'failed', {
      failure: { message: 'The provider reported the reward as failed', kind: 'provider_failed', status_code: null },
    });
  }

  if (state === 'processing' && delivery !== 'pending') {
    // A send that went quiet turns out to have been accepted.
    return settleReward(claim, 'pending');
  }

  if (state === 'not_found' && delivery !== 'pending') {
    // Asked about long after it was sent, and unknown to them: it never
    // arrived, so sending again cannot double it.
    return settleReward(claim, 'lost', {
      failure: { message: 'The send never reached the provider', kind: 'lost', status_code: null },
    });
  }

  // Accepted and still unresolved. A day of that is far beyond any network
  // delay: it goes back to the customer rather than sitting in limbo.
  if (quietFor > REWARD_UNRESOLVED_HANDBACK_MS) {
    return settleReward(claim, 'failed', {
      final: true,
      failure: { message: 'Unconfirmed for a day', kind: 'unresolved', status_code: null },
    });
  }

  return quietFor > REWARD_STUCK_ALERT_MS ? 'stuck' : 'pending';
}

/**
 * The delivery sweep, on a timer from server.js.
 *
 * Looks at every reward not yet finished - sending, accepted, or due a re-send
 * - on a rail this deployment can still ask about. Small batches: each one can
 * cost a provider call, against a rate budget that live vending shares.
 */
async function settleRewardDeliveries({ limit = 25, now = new Date() } = {}) {
  const rows = await prisma.billHeroClaim.findMany({
    where: {
      status: 'processing',
      provider: { in: Object.keys(bills.ADAPTERS) },
      updated_at: { gt: new Date(now.getTime() - 3 * REWARD_UNRESOLVED_HANDBACK_MS) },
    },
    orderBy: { updated_at: 'asc' },
    take: limit,
  });

  const tally = { checked: rows.length, delivered: 0, resent: 0, handed_back: 0, stuck: 0 };

  for (const claim of rows) {
    try {
      const outcome = await advanceRewardDelivery(claim, { now });
      if (Object.prototype.hasOwnProperty.call(tally, outcome)) tally[outcome] += 1;
    } catch (e) {
      // Ids only - the claim row holds an encrypted phone number and nothing
      // here needs to name it.
      console.error('billHero.delivery sweep error:', { claim_id: claim.id, error: e?.message });
    }
  }

  if (tally.stuck) {
    alerts.paymentFailure({
      provider: 'bill_hero',
      action: 'reward_stuck',
      message: `${tally.stuck} Bill Hero reward(s) accepted but unconfirmed after an hour`,
      context: { checked: tally.checked },
    });
  }

  return tally;
}

/**
 * A provider's own report about a reward, already re-read over its
 * authenticated API by the caller (mysubwalletWebhook.controller). Applies the
 * same transition the sweep would, to the claim whose current send this is -
 * so a report and the sweep can race freely.
 */
async function settleRewardFromProvider({ reference, status, gateway }) {
  const claim = await prisma.billHeroClaim.findFirst({
    where: {
      provider_ref: String(reference),
      status: 'processing',
      ...(gateway ? { provider: String(gateway) } : {}),
    },
  });
  if (!claim) return false;

  // Already known to have failed and waiting for its re-send: a report about
  // the old send adds nothing.
  const delivery = String(payloadOf(claim).delivery || '');
  if (delivery !== 'pending' && delivery !== 'sending') return false;

  const state = String(status || '').toLowerCase();
  if (state === 'successful') return (await settleReward(claim, 'delivered')) !== 'skipped';
  if (state === 'failed') {
    const outcome = await settleReward(claim, 'failed', {
      failure: { message: 'The provider reported the reward as failed', kind: 'provider_failed', status_code: null },
    });
    return outcome !== 'skipped';
  }
  return false;
}

// Rewards handed back after every send failed, still inside their grace.
// Read for one user at a time, so a JS-side date check is cheaper than a JSON
// comparison in SQL.
async function listReclaimableClaims({ userId, now = new Date() }) {
  const rows = await prisma.billHeroClaim.findMany({
    where: {
      user_id: Number(userId),
      status: 'failed',
      provider_payload: { path: ['delivery'], equals: 'undeliverable' },
    },
    orderBy: { updated_at: 'desc' },
    take: 10,
  });
  return rows.filter(row => new Date(payloadOf(row).reclaim_until || 0).getTime() > now.getTime());
}

async function findReclaimableClaim({ userId, challengeId, now = new Date() }) {
  const rows = await listReclaimableClaims({ userId, now });
  return rows.find(row => Number(row.challenge_id) === Number(challengeId)) || null;
}

module.exports = {
  me,
  leaderboard,
  claim,
  history,
  status,
  // reward delivery: the sweep (server.js) and a provider's own report
  // (mysubwalletWebhook.controller) drive the same transitions.
  settleRewardDeliveries,
  settleRewardFromProvider,
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
  nextDeliveryState,
  REWARD_DELIVERY: {
    MAX_ATTEMPTS: REWARD_MAX_ATTEMPTS,
    RETRY_DELAYS_MS: REWARD_RETRY_DELAYS_MS,
    SEND_STALE_MS: REWARD_SEND_STALE_MS,
    UNRESOLVED_HANDBACK_MS: REWARD_UNRESOLVED_HANDBACK_MS,
    RECLAIM_GRACE_MS: REWARD_RECLAIM_GRACE_MS,
  },
};
