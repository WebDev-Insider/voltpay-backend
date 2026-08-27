/**
 * Upstash Redis, spoken over its REST API.
 *
 * No client library: Upstash's REST endpoint takes a JSON array of command
 * parts and answers `{ result }` or `{ error }`, which is a `fetch` call and a
 * dozen lines. Node 18+ has fetch built in, so this adds no dependency and no
 * TCP connection pool to babysit on a serverless-ish host.
 *
 * Two rules everything here obeys:
 *
 * 1. **Fail open.** Redis is a cache and a counter store, never the source of
 *    truth. Every call returns `null` on error instead of throwing, so a
 *    dead cache degrades the API to "as slow as before" and never to "down".
 *    The one place that must NOT silently fail open is the login lockout -
 *    see loginLockout.helper.js, which falls back to an in-process counter.
 * 2. **No plaintext PII.** Values here are the same ciphertext/blind-index
 *    columns the database holds (see pii.helper.js), never a decrypted name,
 *    email or phone, and never a secret hash - userCache.service.js strips
 *    pin/password/recovery_hash before anything is written.
 *
 * When UPSTASH_REDIS_REST_URL / _TOKEN are unset the module reports
 * `isEnabled() === false` and every call is a no-op, so local development and
 * the test suite work with no Redis at all.
 */

const REST_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const REST_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();

// Namespaced so a staging deploy pointed at the same Upstash database cannot
// serve production a cached user row.
const PREFIX = `${process.env.REDIS_KEY_PREFIX || 'voltpay'}:${process.env.NODE_ENV || 'development'}:`;

// A cache lookup that takes longer than the query it replaces is worse than no
// cache, so the budget is tight - but not arbitrarily tight, because the two
// directions do not cost the same. Waiting an extra 100ms on a slow-but-healthy
// call costs 100ms. Aborting it costs the whole budget *and then* the Postgres
// query it was meant to replace, so a budget set below the real round trip is
// strictly slower than having no cache at all.
//
// And it does not stop at latency. Five aborts in a row open the breaker below,
// which takes far more than the cache with it: the shared rate-limit counters
// and the login lockout fall back to per-process memory, and pending
// confirmation payloads fall back to a Map that a second instance cannot read.
// So size this against the round trip to the Upstash region actually in use,
// not against an aspiration.
const TIMEOUT_MS = Number(process.env.REDIS_TIMEOUT_MS || 1200);

// ponytail: naive breaker - N consecutive failures and we stop calling for a
// cooldown, so an Upstash outage costs one timeout per 30s instead of one per
// request. Swap for a real half-open breaker if this ever needs metrics.
const FAILURE_LIMIT = 5;
const COOLDOWN_MS = 30_000;

const enabled = Boolean(REST_URL && REST_TOKEN);

let consecutiveFailures = 0;
let openUntil = 0;
let lastLoggedAt = 0;

function isEnabled() {
  return enabled;
}

/**
 * Configured *and* not currently in a breaker cooldown - i.e. the last thing we
 * know is that Redis was answering. Synchronous and free: it reads the breaker
 * state rather than making a call.
 *
 * `isEnabled()` answers "is a cache configured", which is a deploy-time fact.
 * This answers "is it working right now", which is what a caller needs when the
 * *absence* of Redis should change its behaviour rather than just slow it down.
 * Lagging by design - the breaker only opens after FAILURE_LIMIT consecutive
 * failures - so use it to decide whether to skip optional work, never to decide
 * whether a value is trustworthy.
 */
function isHealthy() {
  return enabled && Date.now() >= openUntil;
}

/** Build a namespaced key: key('user', 42) -> 'voltpay:production:user:42' */
function key(...parts) {
  return PREFIX + parts.map(p => String(p)).join(':');
}

function noteFailure(command, err) {
  consecutiveFailures += 1;
  if (consecutiveFailures >= FAILURE_LIMIT) openUntil = Date.now() + COOLDOWN_MS;

  // Rate-limited logging: an outage must not turn into a million log lines.
  // Command name only - arguments can carry a blind index or a user id.
  const now = Date.now();
  if (now - lastLoggedAt > 10_000) {
    lastLoggedAt = now;
    console.warn(`⚠️ Redis ${command} failed (${consecutiveFailures}x):`, err?.message || err);
  }
}

async function request(path, body, commandName) {
  if (!enabled) return null;
  if (Date.now() < openUntil) return null;

  try {
    const res = await fetch(`${REST_URL}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      noteFailure(commandName, new Error(`HTTP ${res.status}`));
      return null;
    }

    const json = await res.json();
    consecutiveFailures = 0;
    openUntil = 0;
    return json;
  } catch (err) {
    noteFailure(commandName, err);
    return null;
  }
}

/**
 * Run one command. `command(['SET', k, v, 'EX', '60'])` -> 'OK', or null when
 * Redis is unavailable. Redis's own errors (wrong type, bad syntax) also come
 * back as null, after being logged.
 */
async function command(args) {
  const json = await request('', args.map(String), args[0]);
  if (!json) return null;
  if (json.error) {
    noteFailure(args[0], new Error(json.error));
    return null;
  }
  return json.result;
}

/** Run several commands in one round trip. Returns an array of results. */
async function pipeline(commands) {
  const json = await request('/pipeline', commands.map(c => c.map(String)), 'PIPELINE');
  if (!Array.isArray(json)) return null;
  return json.map(entry => (entry && entry.error ? null : entry?.result ?? null));
}

// Dates survive JSON as ISO strings; without this a cached `created_at` comes
// back as a string and `row.created_at.toISOString()` throws on a cache hit but
// not on a miss - the nastiest kind of intermittent bug.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function reviveDates(_k, value) {
  return typeof value === 'string' && ISO_DATE.test(value) ? new Date(value) : value;
}

/**
 * Put an object through the same JSON round trip a cached value takes.
 * Callers use this on a cache MISS so the shape they hand back is identical
 * either way - notably Prisma Decimal, which becomes a string in the cache.
 */
function normalize(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value), reviveDates);
}

async function get(k) {
  const raw = await command(['GET', k]);
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw, reviveDates);
  } catch (_) {
    return null;
  }
}

async function set(k, value, ttlSeconds) {
  const payload = JSON.stringify(value);
  const args = ['SET', k, payload];
  if (ttlSeconds > 0) args.push('EX', Math.ceil(ttlSeconds));
  return command(args);
}

async function del(...keys) {
  if (!keys.length) return null;
  return command(['DEL', ...keys]);
}

/**
 * Read-through cache. On a hit returns the cached value, on a miss runs
 * `loader`, stores the result and returns it. A Redis outage just means every
 * call is a miss.
 */
async function cached(k, ttlSeconds, loader) {
  const hit = await get(k);
  if (hit !== null) return hit;

  const value = await loader();
  if (value !== null && value !== undefined) await set(k, value, ttlSeconds);
  return normalize(value);
}

/**
 * Increment a counter and make sure it expires. Returns
 * `{ count, ttlSeconds }`, or null when Redis is unavailable so the caller can
 * fall back.
 */
async function incrWithTtl(k, windowSeconds) {
  const results = await pipeline([['INCR', k], ['TTL', k]]);
  if (!results) return null;

  const count = Number(results[0]);
  let ttl = Number(results[1]);

  // A key that exists without a TTL would count forever. Happens on the first
  // increment of a window, and after a crash between INCR and EXPIRE.
  if (!Number.isFinite(ttl) || ttl < 0) {
    await command(['EXPIRE', k, Math.ceil(windowSeconds)]);
    ttl = Math.ceil(windowSeconds);
  }

  return { count, ttlSeconds: ttl };
}

/** Milliseconds left on a key, 0 if it is gone or has no expiry. */
async function ttlMs(k) {
  const value = await command(['PTTL', k]);
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Add to a set, report whether it was new. Used for "has this user already
 * logged in today" so a repeat login skips the database write entirely.
 * Returns null when Redis is unavailable - caller decides what that means.
 */
async function sAddIsNew(k, member, ttlSeconds) {
  const results = await pipeline([['SADD', k, member], ['EXPIRE', k, Math.ceil(ttlSeconds)]]);
  if (!results) return null;
  return Number(results[0]) === 1;
}

/** Cheap liveness probe for /health. */
async function ping() {
  if (!enabled) return 'disabled';
  const res = await command(['PING']);
  return res === 'PONG' ? 'connected' : 'unreachable';
}

module.exports = {
  isEnabled,
  isHealthy,
  key,
  command,
  pipeline,
  normalize,
  get,
  set,
  del,
  cached,
  incrWithTtl,
  ttlMs,
  sAddIsNew,
  ping,
};
