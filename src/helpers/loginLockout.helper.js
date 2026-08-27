// Per-account lockout for wrong login credentials.
//
// Three wrong passwords (or PINs) and the account cannot log in for 10 minutes.
// This is deliberately separate from rateLimit.middleware: that one counts
// requests per IP so nobody can spray the endpoint, this one counts *failures*
// per account so a password guesser gets three tries no matter how many IPs
// they come from.
//
// Resetting the password does NOT lift the lock - a stolen phone that can read
// the reset email would otherwise turn the lockout into a no-op.
//
// State lives in Redis so the count is shared across instances and survives a
// deploy - an attacker used to get a fresh three tries every time the process
// restarted. Redis being unavailable falls back to the in-process Map, which is
// the old behaviour: weaker, but it still stops a guesser inside one instance,
// and it never fails *open* (a failure is always counted somewhere).
const { blindIndex, canonicalMobile } = require('./pii.helper');
const redis = require('../services/redis.service');

const MAX_FAILURES = 3;
const LOCK_MS = 10 * 60 * 1000;
// Failures older than this stop counting, so three typos spread over a week
// never lock a legitimate user out.
const FAILURE_WINDOW_MS = 10 * 60 * 1000;

const failures = new Map(); // key -> { count, firstAt, lockedUntil }

function prune(now) {
  for (const [key, entry] of failures) {
    if (entry.lockedUntil <= now && entry.firstAt + FAILURE_WINDOW_MS <= now) {
      failures.delete(key);
    }
  }
}

/**
 * Never keys on the raw phone number: this key reaches both a long-lived Map
 * and Redis, and neither should be a phone book. blindIndex is the same keyed
 * digest used for the mobile_idx column.
 *
 * Keyed on the *canonical* number, not the typed one. The login lookup accepts
 * 0803xxxxxxx, 803xxxxxxx and 234803xxxxxxx as one account, so a lock keyed on
 * what was typed gave that one account three separate budgets - nine guesses
 * instead of three, without an attacker needing a second IP or a second route.
 * canonicalMobile collapses them, so the lock counts the account the same way
 * the lookup resolves it.
 *
 * The key shape changes with this, so any lock live at deploy time is dropped.
 * That releases a few people early and costs nothing; it cannot lock anyone out.
 */
function lockKey(country, mobileNumber) {
  const mobile = canonicalMobile(country, mobileNumber);
  if (!mobile) return '';
  return `${String(country || '').trim().toUpperCase()}:${blindIndex(mobile, 'mobile')}`;
}

const lockRedisKey = key => redis.key('lockout', 'lock', key);
const failRedisKey = key => redis.key('lockout', 'fail', key);

/** @returns {Promise<number>} seconds left on the lock, 0 if not locked */
async function getLockRemainingSeconds(key) {
  if (!key) return 0;

  if (redis.isEnabled()) {
    const ms = await redis.ttlMs(lockRedisKey(key));
    if (ms > 0) return Math.ceil(ms / 1000);
  }

  const entry = failures.get(key);
  if (!entry) return 0;
  const remaining = entry.lockedUntil - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

function registerFailureLocal(key) {
  const now = Date.now();
  if (failures.size > 5000) prune(now);

  let entry = failures.get(key);
  if (!entry || entry.firstAt + FAILURE_WINDOW_MS <= now) {
    entry = { count: 0, firstAt: now, lockedUntil: 0 };
  }

  entry.count += 1;
  if (entry.count >= MAX_FAILURES) {
    entry.lockedUntil = now + LOCK_MS;
  }
  failures.set(key, entry);

  return {
    locked: entry.lockedUntil > now,
    remainingSeconds: entry.lockedUntil > now ? Math.ceil((entry.lockedUntil - now) / 1000) : 0,
    attemptsLeft: Math.max(MAX_FAILURES - entry.count, 0),
  };
}

/**
 * @returns {Promise<{locked: boolean, remainingSeconds: number, attemptsLeft: number}>}
 */
async function registerFailure(key) {
  if (!key) return { locked: false, remainingSeconds: 0, attemptsLeft: MAX_FAILURES };

  if (redis.isEnabled()) {
    const hit = await redis.incrWithTtl(failRedisKey(key), FAILURE_WINDOW_MS / 1000);
    if (hit) {
      const count = hit.count;
      if (count >= MAX_FAILURES) {
        await redis.set(lockRedisKey(key), 1, LOCK_MS / 1000);
        return {
          locked: true,
          remainingSeconds: Math.ceil(LOCK_MS / 1000),
          attemptsLeft: 0,
        };
      }
      return { locked: false, remainingSeconds: 0, attemptsLeft: Math.max(MAX_FAILURES - count, 0) };
    }
  }

  return registerFailureLocal(key);
}

// Only a successful login clears the counter. Password reset must not.
async function clearFailures(key) {
  if (!key) return;
  failures.delete(key);
  if (redis.isEnabled()) await redis.del(failRedisKey(key), lockRedisKey(key));
}

module.exports = {
  MAX_FAILURES,
  LOCK_MS,
  lockKey,
  getLockRemainingSeconds,
  registerFailure,
  clearFailures,
};
