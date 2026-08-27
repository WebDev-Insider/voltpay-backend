// Bill Hero's opening hours, and the switch that closes it.
//
// Bill Hero is a promotion, not a rail: it is deliberately *not* open every
// day, and an admin has to be able to shut it in seconds when a reward is
// mispriced or a provider starts failing. Both of those are the same question -
// "was Bill Hero open at instant T?" - so there is one predicate, `openAt()`,
// and everything else reads it.
//
// That matters more than it looks. Progress is not a stored counter: it is
// derived by re-counting wallet transactions every time the challenge is read
// (billHero.controller `tallyWeek`). So "no progress is counted while locked"
// cannot be a write-time guard - there is no write. It has to be a rule that
// can be evaluated against a *past* timestamp, which is why availability is
// stored as days/times/windows rather than as a bare on-off boolean, and why
// lifting a manual lock records the spell it covered instead of forgetting it.
//
// Config lives in app_settings, like the kill switch in featureFlag.helper -
// already backed up, already visible to the dashboard, survives a restart.
// Cached for the same short TTL: a lock that takes ten minutes to bite is not
// a lock.
//
// Reads fail OPEN. Bill Hero handing out a ₦200 airtime reward it should have
// withheld for one TTL is a smaller incident than a cache blip silently
// freezing a live promotion, and the claim path has its own guards (completion,
// once-per-week uniqueness, PIN) underneath this one.

const prisma = require('../../database/prisma');
const redis = require('../services/redis.service');
const { LAGOS_OFFSET_MS } = require('./lagosTime.helper');

const SETTING_KEY = 'bill_hero_availability';
const TTL = Number(process.env.FEATURE_FLAG_TTL_SECONDS || 30);

const MODES = new Set(['always_on', 'scheduled_days', 'manual_lock']);

const DEFAULT_MESSAGE = 'Bill Hero is taking a short break. Check back soon!';

// Manual lock spells are kept so a recharge made during one still does not
// count after the unlock. Only the recent ones matter - the tally never looks
// further back than the current week - so the list is capped rather than grown
// forever inside a settings row.
const MAX_LOCK_PERIODS = 20;

const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7]; // ISO weekday, Monday = 1

const DEFAULT_CONFIG = {
  mode: 'always_on',
  days: ALL_DAYS,
  start_time: '00:00',
  end_time: '23:59',
  lock_message: DEFAULT_MESSAGE,
  /** Scheduled lock window. Either bound may stand alone. */
  locked_from: null,
  locked_until: null,
  /** When the current manual lock was thrown. Null unless mode is manual_lock. */
  locked_at: null,
  /** What to go back to when the manual lock is lifted. */
  mode_before_lock: null,
  lock_periods: [],
};

class AvailabilityError extends Error {
  constructor(message) {
    super(message);
    this.code = 'INVALID_AVAILABILITY';
  }
}

/** Nigerian wall clock: ISO weekday and minutes past midnight. */
function lagosClock(date) {
  const shifted = new Date(date.getTime() + LAGOS_OFFSET_MS);
  const dow = shifted.getUTCDay(); // 0 = Sunday

  return {
    day: dow === 0 ? 7 : dow,
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return null;

  const hours = Number(m[1]);
  const mins = Number(m[2]);
  if (hours > 23 || mins > 59) return null;

  return hours * 60 + mins;
}

function toDateOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value);

  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Is `date` inside [from, to)? Half-open so a lock that ends at 09:00 and one
 * that starts at 09:00 do not both claim that instant.
 *
 * An unbounded pair is not a window - it means "no window set" - so it returns
 * false rather than swallowing all of time.
 */
function inWindow(from, to, date) {
  const start = toDateOrNull(from);
  const end = toDateOrNull(to);
  if (!start && !end) return false;

  const t = date.getTime();
  if (start && t < start.getTime()) return false;
  if (end && t >= end.getTime()) return false;

  return true;
}

/**
 * The weekly opening rule. End time is inclusive: an admin who types 09:00 to
 * 17:00 means five o'clock is still open, and losing the last minute of the day
 * to a half-open comparison is the kind of thing nobody notices until a user
 * claims at 23:59.
 *
 * A window whose start is after its end wraps midnight (20:00 to 02:00), which
 * is what a Friday-night promotion actually looks like. The day is matched on
 * the *start* side of a wrapped window, so a Friday 20:00-02:00 slot stays open
 * into Saturday morning.
 */
function withinSchedule(config, date) {
  const { day, minutes } = lagosClock(date);

  const days = Array.isArray(config.days) && config.days.length ? config.days : ALL_DAYS;

  const start = toMinutes(config.start_time) ?? 0;
  const end = toMinutes(config.end_time) ?? 1439;

  if (start <= end) return days.includes(day) && minutes >= start && minutes <= end;

  // Wrapped: before midnight belongs to today's slot, after midnight to
  // yesterday's.
  if (minutes >= start) return days.includes(day);

  return minutes <= end && days.includes(day === 1 ? 7 : day - 1);
}

/**
 * Was Bill Hero open at `date`? The one predicate.
 *
 * Used live to gate the screen and the claim, and used historically by the
 * tally to decide whether a recharge earned anything. Pure - no clock of its
 * own, no I/O - so a past instant answers as reliably as `now`.
 */
function openAt(config, date) {
  const cfg = config || DEFAULT_CONFIG;

  // A manual lock still in force, from the moment it was thrown. Anything
  // before that is untouched by it.
  if (cfg.mode === 'manual_lock') {
    const since = toDateOrNull(cfg.locked_at);
    if (!since || date >= since) return false;
  }

  // Manual locks already lifted. Without these, unlocking would retroactively
  // hand back every point earned while the promotion was shut.
  for (const period of cfg.lock_periods || []) {
    if (inWindow(period?.from, period?.to, date)) return false;
  }

  if (inWindow(cfg.locked_from, cfg.locked_until, date)) return false;

  if (cfg.mode === 'scheduled_days' && !withinSchedule(cfg, date)) return false;

  return true;
}

/** Why it is shut, so the dashboard and the app can say something specific. */
function reasonAt(config, date) {
  if (config.mode === 'manual_lock') return 'manual_lock';
  if (inWindow(config.locked_from, config.locked_until, date)) return 'scheduled_lock';
  for (const period of config.lock_periods || []) {
    if (inWindow(period?.from, period?.to, date)) return 'manual_lock';
  }

  return 'outside_schedule';
}

function evaluate(config, now = new Date()) {
  const open = openAt(config, now);

  return {
    open,
    mode: config.mode,
    reason: open ? null : reasonAt(config, now),
    message: open ? '' : String(config.lock_message || DEFAULT_MESSAGE),
  };
}

/** Forgiving on read: a hand-edited settings row must not take the screen down. */
function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};

  const days = Array.isArray(src.days)
    ? [...new Set(src.days.map(Number).filter(d => Number.isInteger(d) && d >= 1 && d <= 7))].sort()
    : ALL_DAYS;

  const periods = Array.isArray(src.lock_periods)
    ? src.lock_periods
        .filter(p => p && (p.from || p.to))
        .map(p => ({ from: p.from || null, to: p.to || null }))
        .slice(-MAX_LOCK_PERIODS)
    : [];

  return {
    mode: MODES.has(src.mode) ? src.mode : DEFAULT_CONFIG.mode,
    days: days.length ? days : ALL_DAYS,
    start_time: toMinutes(src.start_time) === null ? DEFAULT_CONFIG.start_time : String(src.start_time),
    end_time: toMinutes(src.end_time) === null ? DEFAULT_CONFIG.end_time : String(src.end_time),
    lock_message: String(src.lock_message || DEFAULT_MESSAGE).slice(0, 300),
    locked_from: toDateOrNull(src.locked_from)?.toISOString() || null,
    locked_until: toDateOrNull(src.locked_until)?.toISOString() || null,
    locked_at: toDateOrNull(src.locked_at)?.toISOString() || null,
    mode_before_lock: MODES.has(src.mode_before_lock) ? src.mode_before_lock : null,
    lock_periods: periods,
  };
}

const cacheKey = () => redis.key('bill_hero', 'availability');

async function getConfig() {
  try {
    const raw = await redis.cached(cacheKey(), TTL, async () => {
      const row = await prisma.appSetting.findUnique({
        where: { setting_key: SETTING_KEY },
        select: { setting_value: true },
      });

      // Store the string, not the parsed object, so a JSON round-trip through
      // the cache cannot reshape it.
      return String(row?.setting_value ?? '');
    });

    return normalizeConfig(raw ? JSON.parse(raw) : null);
  } catch (e) {
    console.warn('billHeroAvailability: read failed, leaving Bill Hero open', {
      reason: String(e?.message || e).slice(0, 120),
    });

    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Apply an admin change. Only the keys present are touched, so the dashboard
 * can flip the lock without resending the whole schedule.
 *
 * `locked: true/false` is the shorthand the lock button uses - it moves the
 * mode in and out of manual_lock and remembers what to go back to, which is the
 * bit that is easy to get wrong by hand (unlocking a weekend-only promotion
 * into always_on quietly opens it on a Tuesday).
 */
async function setConfig(patch = {}) {
  const current = await getConfig();
  const next = { ...current };
  const nowIso = new Date().toISOString();

  let mode = patch.mode === undefined ? undefined : String(patch.mode);

  if (patch.locked !== undefined) {
    const locked = patch.locked === true || patch.locked === 1 || String(patch.locked).toLowerCase() === 'true' || String(patch.locked) === '1';

    mode = locked ? 'manual_lock' : (mode ?? current.mode_before_lock ?? 'always_on');
  }

  if (mode !== undefined) {
    if (!MODES.has(mode)) throw new AvailabilityError(`mode must be one of ${[...MODES].join(', ')}`);

    if (mode === 'manual_lock' && current.mode !== 'manual_lock') {
      next.locked_at = nowIso;
      next.mode_before_lock = current.mode;
    } else if (mode !== 'manual_lock' && current.mode === 'manual_lock') {
      // Close the spell before forgetting when it started, otherwise every
      // recharge made during the lock counts the moment it is lifted.
      next.lock_periods = [...(current.lock_periods || []), { from: current.locked_at || nowIso, to: nowIso }].slice(-MAX_LOCK_PERIODS);
      next.locked_at = null;
      next.mode_before_lock = null;
    }

    next.mode = mode;
  }

  if (patch.days !== undefined) {
    const days = Array.isArray(patch.days) ? patch.days.map(Number) : [];
    if (!days.length || days.some(d => !Number.isInteger(d) || d < 1 || d > 7)) {
      throw new AvailabilityError('days must be a non-empty list of ISO weekdays (1 = Monday, 7 = Sunday)');
    }
    next.days = [...new Set(days)].sort();
  }

  for (const field of ['start_time', 'end_time']) {
    if (patch[field] === undefined) continue;
    if (toMinutes(patch[field]) === null) throw new AvailabilityError(`${field} must be HH:MM`);
    next[field] = String(patch[field]).trim();
  }

  if (patch.lock_message !== undefined) {
    const message = String(patch.lock_message).trim();
    if (message.length > 300) throw new AvailabilityError('lock_message must be 300 characters or fewer');
    next.lock_message = message || DEFAULT_MESSAGE;
  }

  for (const field of ['locked_from', 'locked_until']) {
    if (patch[field] === undefined) continue;
    if (patch[field] === null || patch[field] === '') {
      next[field] = null;
      continue;
    }
    const parsed = toDateOrNull(patch[field]);
    if (!parsed) throw new AvailabilityError(`${field} must be a date`);
    next[field] = parsed.toISOString();
  }

  if (next.locked_from && next.locked_until && new Date(next.locked_from) >= new Date(next.locked_until)) {
    throw new AvailabilityError('locked_until must be after locked_from');
  }

  const value = JSON.stringify(next);

  await prisma.appSetting.upsert({
    where: { setting_key: SETTING_KEY },
    update: { setting_value: value },
    create: { setting_key: SETTING_KEY, setting_value: value, description: 'Bill Hero availability and lock' },
  });

  await redis.del(cacheKey());

  return next;
}

/** The shape the app and the dashboard both read. Never leaks lock_periods. */
function publicAvailability(config, state = null) {
  const s = state || evaluate(config);

  return {
    open: s.open,
    mode: config.mode,
    reason: s.reason,
    message: s.message,
    days: config.days,
    start_time: config.start_time,
    end_time: config.end_time,
    locked_from: config.locked_from,
    locked_until: config.locked_until,
  };
}

/**
 * Route guard for anything that hands out a reward.
 *
 * 423 rather than 503: the app retries 502/503/504 with backoff, and a locked
 * promotion would turn every open screen into four requests. 423 is also the
 * honest code - the resource exists and is deliberately shut.
 */
function requireBillHeroOpen() {
  return async function billHeroGate(req, res, next) {
    const config = await getConfig();
    const state = evaluate(config);

    if (state.open) {
      req.billHero = { config, state };

      return next();
    }

    return res.status(423).json({
      remark: 'bill_hero_locked',
      status: 'error',
      message: [state.message],
      data: { availability: publicAvailability(config, state) },
    });
  };
}

module.exports = {
  getConfig,
  setConfig,
  evaluate,
  openAt,
  publicAvailability,
  requireBillHeroOpen,
  MODES,
  DEFAULT_CONFIG,
  DEFAULT_MESSAGE,
  SETTING_KEY,
  __test: { lagosClock, toMinutes, withinSchedule, inWindow, normalizeConfig },
};
