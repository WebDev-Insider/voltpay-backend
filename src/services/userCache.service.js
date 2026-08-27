/**
 * The user row behind `req.user`.
 *
 * Every authenticated request used to cost one `user.findUnique` before the
 * controller ran - on Neon that is a network round trip per request, on every
 * dashboard poll, notification poll and airtime lookup. This caches that row
 * in Redis for a few seconds.
 *
 * Three things keep it honest:
 *
 * - **Secrets never leave the database.** `pin`, `password` and
 *   `recovery_hash` are nulled before caching and replaced by
 *   `has_pin` / `has_password` / `has_recovery` booleans. Nothing verifies a
 *   secret against `req.user` anyway - every PIN/password check re-reads the
 *   row itself (see verification.controller, billHero.controller,
 *   user.controller), which is what makes this safe.
 * - **The shape is identical on hit and miss.** A miss goes through the same
 *   JSON round trip, so `balance` is always a string and dates are always
 *   Date objects. Otherwise a bug only appears once the cache warms up.
 * - **Short TTL plus explicit invalidation.** Money movement
 *   (balance.helper.js), session revocation (session.service.js) and admin
 *   status changes call `invalidateUser`. Everything else - profile edits,
 *   ev/sv flags - is bounded by USER_CACHE_TTL_SECONDS.
 *
 * ponytail: 15s TTL rather than chasing all ~20 `user.update` call sites. If a
 * new write path needs to be visible instantly, call `invalidateUser(id)`
 * after it; do not raise the TTL.
 */

const prisma = require('../../database/prisma');
const redis = require('./redis.service');

const TTL_SECONDS = Number(process.env.USER_CACHE_TTL_SECONDS || 15);

const SECRET_FIELDS = ['pin', 'password', 'recovery_hash'];

function userKey(id) {
  return redis.key('user', Number(id));
}

function forCache(user) {
  const copy = { ...user };
  copy.has_pin = Boolean(user.pin);
  copy.has_password = Boolean(user.password);
  copy.has_recovery = Boolean(user.recovery_hash);
  for (const field of SECRET_FIELDS) copy[field] = null;
  return redis.normalize(copy);
}

/**
 * Cached `prisma.user.findUnique({ where: { id } })`, minus the secret columns.
 * Returns null if the user does not exist.
 */
async function getUserById(id) {
  const numericId = Number(id);
  if (!numericId || Number.isNaN(numericId)) return null;

  const k = userKey(numericId);
  // USER_CACHE_TTL_SECONDS=0 is the kill switch. It matters: this cache only
  // pays off when Redis is closer to the API than Postgres is. If the API
  // host is far from Upstash but near Neon, the lookup becomes a *longer*
  // round trip - measure both before trusting it (see the note in README).
  if (TTL_SECONDS > 0) {
    const hit = await redis.get(k);
    if (hit) return hit;
  }

  const user = await prisma.user.findUnique({ where: { id: numericId } });
  if (!user) return null;

  const shaped = forCache(user);
  if (TTL_SECONDS > 0) await redis.set(k, shaped, TTL_SECONDS);
  return shaped;
}

/**
 * Drop a user from the cache. Fire-and-forget friendly: it never throws, so
 * write paths can call it without a try/catch.
 */
function invalidateUser(id) {
  const numericId = Number(id);
  if (!numericId || Number.isNaN(numericId)) return Promise.resolve(null);
  return redis.del(userKey(numericId)).catch(() => null);
}

/**
 * Invalidate from inside a database transaction.
 *
 * Dropping the key mid-transaction is not enough on its own: a concurrent
 * request for the same user can read the pre-commit balance and cache it
 * again before COMMIT lands, leaving a stale balance on screen for a full
 * TTL - which for a wallet means "I funded my account and nothing happened".
 * So drop it again shortly after, once the commit is certainly visible.
 *
 * ponytail: a timer, not a post-commit hook. Prisma's interactive transactions
 * have no commit callback, and the alternative is threading an invalidation
 * list through every `$transaction` in the codebase.
 */
function invalidateUserAfterCommit(id) {
  const first = invalidateUser(id);
  setTimeout(() => invalidateUser(id), Number(process.env.USER_CACHE_RECHECK_MS || 1500)).unref();
  return first;
}

// __test exposes the shaper so test/pinFlag.test.js can assert that what this
// caches and what `pn` reads still agree.
module.exports = { getUserById, invalidateUser, invalidateUserAfterCommit, TTL_SECONDS, __test: { forCache } };
