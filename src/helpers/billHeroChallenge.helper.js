// Bill Hero challenges: the rules an admin writes, and how progress is judged
// against them.
//
// Challenges used to be two constants in billHero.controller. They are rows
// now, so a third one is a form submission rather than a deploy. What did not
// change is where progress comes from: `tallyWeek` still counts qualifying
// airtime and data purchases per user per week, and a challenge is only ever a
// target laid over one of those two counts. That keeps the counting rules in
// exactly one place - a challenge cannot invent a new way to earn.
//
// Everything here is pure except `listChallenges`, so the interesting logic is
// testable without a database. See test/billHeroChallenge.test.js.
const prisma = require('../../database/prisma');
const redis = require('../services/redis.service');

const ACTION_TYPES = ['airtime', 'data'];
const REWARD_TYPES = ['airtime', 'data'];

/** A target nobody can reach is a bug report; a target of zero pays everyone. */
const MIN_TARGET = 1;
const MAX_TARGET = 500;

/** ₦100,000 of airtime, or 500GB of data, is far past a plausible typo. */
const MAX_REWARD_VALUE = 512_000;

const MAX_TITLE = 60;
const MAX_DESCRIPTION = 200;

/** Challenges change a few times a year and are read on every app open. */
const TTL = Number(process.env.BILL_HERO_CHALLENGE_TTL_SECONDS || 60);

const cacheKey = () => redis.key('bill_hero', 'challenges');

/**
 * Every challenge, newest rules first, cached briefly.
 *
 * Fails open the same way the rest of the Redis layer does: a cache miss or a
 * cache outage is a database read, never an empty challenge list. An empty list
 * would render Bill Hero as "nothing to do" - indistinguishable, to the user,
 * from the promotion being cancelled.
 */
async function listChallenges() {
  const rows = await redis.cached(cacheKey(), TTL, async () =>
    prisma.billHeroChallenge.findMany({ orderBy: [{ sort_order: 'asc' }, { id: 'asc' }] }),
  );

  // A Redis hit comes back through JSON, so the dates are strings. normalize()
  // revives them, but only for values that went through the cache - a loader
  // result is handed back untouched.
  return (rows || []).map(r => ({
    ...r,
    starts_at: toDateOrNull(r.starts_at),
    ends_at: toDateOrNull(r.ends_at),
  }));
}

async function invalidateChallenges() {
  await redis.del(cacheKey());
}

function toDateOrNull(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);

  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Is this challenge live at `when`?
 *
 * Half-open on purpose: `starts_at` counts, `ends_at` does not. Two challenges
 * handed over back to back - one ending at midnight, the next starting there -
 * must not both be running for that instant, or a user completes one week's
 * target and claims two rewards for it.
 */
function isRunning(challenge, when = new Date()) {
  if (!challenge || challenge.active !== true) return false;

  const start = toDateOrNull(challenge.starts_at);
  const end = toDateOrNull(challenge.ends_at);

  if (start && when < start) return false;
  if (end && when >= end) return false;

  return true;
}

/** active | scheduled | ended | inactive - what an admin sees in the list. */
function lifecycle(challenge, when = new Date()) {
  if (!challenge) return 'ended';
  if (challenge.active !== true) return 'inactive';

  const start = toDateOrNull(challenge.starts_at);
  const end = toDateOrNull(challenge.ends_at);

  if (start && when < start) return 'scheduled';
  if (end && when >= end) return 'ended';

  return 'active';
}

/** 500 -> `500MB`, 1024 -> `1GB`, 1536 -> `1.5GB`. */
function formatData(mb) {
  const value = Number(mb) || 0;
  if (value < 1024) return `${value}MB`;

  const gb = value / 1024;

  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)}GB`;
}

function rewardLabel(challenge) {
  const value = Number(challenge?.reward_value) || 0;

  return challenge?.reward_type === 'airtime' ? `₦${value} airtime` : `${formatData(value)} data`;
}

function rewardUnit(challenge) {
  return challenge?.reward_type === 'airtime' ? 'NGN' : 'MB';
}

/**
 * Progress towards a challenge, out of a week's tally.
 *
 * `counts` is `{ airtime, data }` - the two things tallyWeek knows how to
 * count. A challenge that asked for anything else would need the tally to learn
 * a new rule, which is exactly the coupling this signature keeps visible.
 */
function progressFor(challenge, counts) {
  const key = String(challenge?.action_type || '').toLowerCase();

  return Math.max(0, Number(counts?.[key]) || 0);
}

function isCompleted(challenge, counts) {
  const target = Number(challenge?.target) || 0;

  return target > 0 && progressFor(challenge, counts) >= target;
}

/** The shape the app and the dashboard both read. Never spreads the raw row. */
function publicChallenge(challenge, when = new Date()) {
  return {
    id: Number(challenge.id),
    title: String(challenge.title || ''),
    description: String(challenge.description || ''),
    action_type: String(challenge.action_type || ''),
    target: Number(challenge.target) || 0,
    reward_type: String(challenge.reward_type || ''),
    reward_value: Number(challenge.reward_value) || 0,
    reward_label: rewardLabel(challenge),
    reward_unit: rewardUnit(challenge),
    active: challenge.active === true,
    status: lifecycle(challenge, when),
    running: isRunning(challenge, when),
    starts_at: toDateOrNull(challenge.starts_at)?.toISOString() || null,
    ends_at: toDateOrNull(challenge.ends_at)?.toISOString() || null,
    sort_order: Number(challenge.sort_order) || 0,
  };
}

/**
 * Validate an admin's challenge form.
 *
 * Returns `{ error }` or `{ data }` - never throws, because both callers
 * (create and update) want to turn a bad field into a 400 with a message that
 * names it. `partial` lets update send only what changed.
 */
function validateChallengeInput(body, { partial = false } = {}) {
  const data = {};
  const has = field => body != null && Object.prototype.hasOwnProperty.call(body, field);
  const need = field => !partial || has(field);

  if (need('title')) {
    const title = String(body?.title ?? '').trim();
    if (!title) return { error: 'Title is required' };
    if (title.length > MAX_TITLE) return { error: `Title must be ${MAX_TITLE} characters or fewer` };
    data.title = title;
  }

  if (has('description')) {
    const description = String(body?.description ?? '').trim();
    if (description.length > MAX_DESCRIPTION) return { error: `Description must be ${MAX_DESCRIPTION} characters or fewer` };
    data.description = description || null;
  }

  if (need('action_type')) {
    const action = String(body?.action_type ?? '').trim().toLowerCase();
    if (!ACTION_TYPES.includes(action)) return { error: 'Action type must be airtime or data' };
    data.action_type = action;
  }

  if (need('reward_type')) {
    const reward = String(body?.reward_type ?? '').trim().toLowerCase();
    if (!REWARD_TYPES.includes(reward)) return { error: 'Reward type must be airtime or data' };
    data.reward_type = reward;
  }

  if (need('target')) {
    const target = Number(body?.target);
    if (!Number.isInteger(target) || target < MIN_TARGET || target > MAX_TARGET) {
      return { error: `Target must be a whole number between ${MIN_TARGET} and ${MAX_TARGET}` };
    }
    data.target = target;
  }

  if (need('reward_value')) {
    const value = Number(body?.reward_value);
    if (!Number.isInteger(value) || value < 1 || value > MAX_REWARD_VALUE) {
      return { error: `Reward must be a whole number between 1 and ${MAX_REWARD_VALUE}` };
    }
    data.reward_value = value;
  }

  if (has('active')) data.active = body.active === true || body.active === 'true';
  if (has('sort_order')) {
    const order = Number(body?.sort_order);
    if (!Number.isFinite(order)) return { error: 'Sort order must be a number' };
    data.sort_order = Math.trunc(order);
  }

  for (const field of ['starts_at', 'ends_at']) {
    if (!has(field)) continue;
    const raw = body[field];
    if (raw === null || raw === '') {
      data[field] = null;
      continue;
    }
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return { error: `${field === 'starts_at' ? 'Start' : 'End'} date is not a valid date` };
    data[field] = parsed;
  }

  // Only checkable once both sides are known, so it lives after the loop and
  // reads whichever value the patch did not supply off the existing row.
  const start = data.starts_at !== undefined ? data.starts_at : toDateOrNull(body?._current_starts_at);
  const end = data.ends_at !== undefined ? data.ends_at : toDateOrNull(body?._current_ends_at);
  if (start && end && end <= start) return { error: 'End date must be after the start date' };

  return { data };
}

module.exports = {
  listChallenges,
  invalidateChallenges,
  isRunning,
  lifecycle,
  rewardLabel,
  rewardUnit,
  formatData,
  progressFor,
  isCompleted,
  publicChallenge,
  validateChallengeInput,
  ACTION_TYPES,
  REWARD_TYPES,
  MAX_REWARD_VALUE,
  MAX_TARGET,
};
