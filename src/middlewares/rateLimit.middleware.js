// Fixed-window limiter for the unauthenticated auth endpoints: OTP requests,
// signup availability lookups (an enumeration oracle if left open) and the
// recovery-phrase login.
//
// Counters live in Redis so the window is shared across instances and survives
// a deploy. When Redis is not configured, or is down, it falls back to the
// in-process Map below - a weaker limit is still far better than none, and an
// Upstash outage must not lock everyone out of login.
const redis = require('../services/redis.service');
const { blindIndex, canonicalMobile } = require('../helpers/pii.helper');

const buckets = new Map();

// Fields naming a phone number, which need collapsing before they are counted.
// Listed rather than sniffed, so adding a route with a new field name is a
// deliberate decision and not a silent hole.
const MOBILE_FIELDS = new Set(['mobile_number', 'mobile', 'phone', 'phone_number']);

/**
 * The bucket has to be the same for every way one identity can be typed.
 *
 * The digest below runs under the 'ratelimit' domain, which is normalize's
 * default case - no digit stripping at all - so `0803 123 4567` and
 * `08031234567` were separate buckets, and so were the 803/234803 forms that
 * resolve to the same account at login. Punctuation is free to vary, which made
 * the window unbounded: re-type the number, get another `max` requests.
 */
function bucketField(field, req) {
  if (!field) return '';
  const raw = req.body?.[field] ?? req.query?.[field];
  if (MOBILE_FIELDS.has(field)) {
    return canonicalMobile(req.body?.country ?? req.query?.country, raw);
  }
  return String(raw ?? '').trim().toLowerCase();
}

function clientKey(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : String(forwarded || '')).split(',')[0].trim();
  return ip || req.ip || req.socket?.remoteAddress || 'unknown';
}

function prune(now) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

// Returns { count, retryAfter } using the in-process Map.
function hitLocal(key, windowMs) {
  const now = Date.now();
  if (buckets.size > 5000) prune(now);

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { count: 1, retryAfter: Math.ceil(windowMs / 1000) };
  }

  bucket.count += 1;
  return { count: bucket.count, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
}

/**
 * @param {object} options
 * @param {number} options.windowMs  window length
 * @param {number} options.max       requests allowed per window
 * @param {string} options.name      bucket namespace, so two routes never share a counter
 * @param {string} [options.field]   extra body field to key on (e.g. 'email'), narrows the bucket
 * @param {boolean} [options.byUser] key on the authenticated user instead of the IP. For
 *                                   routes behind userAuth that take a PIN: rotating IPs
 *                                   must not buy an attacker more guesses against one account.
 */
function rateLimit({ windowMs, max, name, field, byUser = false }) {
  const windowSeconds = Math.ceil(windowMs / 1000);

  return async function rateLimitMiddleware(req, res, next) {
    // Key on the identifier too, so one user retrying does not exhaust the
    // window for everyone else behind the same carrier NAT.
    //
    // The identifier is an email or a phone number and the IP identifies a
    // person just as well, so neither is used raw: the bucket is a keyed
    // digest, the same primitive as the mobile_idx column. A Redis dump - or a
    // heap dump of the fallback Map - must not be a contact list.
    const extra = bucketField(field, req);
    const subject = byUser && req.user?.id ? `user:${req.user.id}` : clientKey(req);
    const bucketId = blindIndex(`${subject}|${extra}`, 'ratelimit');

    let hit = null;
    if (redis.isEnabled()) {
      const remote = await redis.incrWithTtl(redis.key('rl', name, bucketId), windowSeconds);
      if (remote) hit = { count: remote.count, retryAfter: remote.ttlSeconds || windowSeconds };
    }
    if (!hit) hit = hitLocal(`${name}:${bucketId}`, windowMs);

    if (hit.count > max) {
      const retryAfter = Math.max(hit.retryAfter, 1);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        remark: 'rate_limited',
        status: 'error',
        message: [`Too many attempts. Please try again in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`],
        data: null,
      });
    }
    return next();
  };
}

module.exports = rateLimit;
