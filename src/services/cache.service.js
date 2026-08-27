/**
 * Derived-read cache: the layer above redis.service for values that are
 * *computed* from Postgres rather than read back as a single row.
 *
 * redis.service already gives fail-open transport and `cached()`. This adds the
 * two things a read-heavy screen needs on top of it:
 *
 * 1. **Single-flight.** `cached()` alone does not stop a stampede: fifty apps
 *    opening the transaction screen the second a key expires produce fifty
 *    identical full-history queries against Neon. Here the first caller runs
 *    the loader and the other forty-nine await the same promise. This is the
 *    same pattern pairgate.service uses for provider catalogues, and it is the
 *    reason a cold cache costs one query rather than a thundering herd.
 *    It works even with Redis switched off, which is what makes the fallback
 *    path survivable.
 * 2. **One place that owns the key names and TTLs.** Invalidation is only ever
 *    correct if the writer and the reader agree on the key, so both come from
 *    here.
 *
 * Everything inherits redis.service's contract: a Redis outage is a cache miss,
 * never an error. `remember()` returns the loader's value no matter what Redis
 * is doing.
 *
 * ---------------------------------------------------------------------------
 * Key map. Some of these predate this module; they are listed so the whole
 * cache surface is readable in one place, and they are NOT renamed - renaming a
 * live key is a guaranteed cache-miss storm on deploy for no gain.
 *
 *   auth:rate:{phone}       -> rl:{route}:{blindIndex}      rateLimit.middleware
 *   app:version_rules       -> app_update:settings          appUpdate.helper
 *   user:profile:{userId}   -> user:{id}                    userCache.service
 *   wallet:balance:{userId} -> user:{id}.balance            userCache.service
 *   tx:recent:{userId}      -> tx:recent:{id}               here (new)
 *   tx:list:{userId}        -> tx:list:{id}                 here (new)
 *   beneficiary:known:..    -> beneficiary:known:{a}:{b}    here (new)
 *   catalogue:{name}        -> catalogue:{name}             here (new)
 *
 * Two of those deserve a note, because they look like omissions and are not:
 *
 * - **`auth:rate:{phone}` is keyed by blind index, not by the phone number.**
 *   CLAUDE.md forbids a plaintext mobile in a Redis key, and a key is as
 *   readable as a value - a `KEYS auth:rate:*` dump would otherwise be a
 *   customer phone book. `blindIndex(mobile, 'ratelimit')` buckets the same
 *   number to the same counter without storing it.
 * - **`wallet:balance:{userId}` is not a separate key.** The balance is already
 *   in the cached user row, on a 15s TTL, dropped by balance.helper on every
 *   movement. A second copy under its own key would be the same number with a
 *   second TTL and a second invalidation path, so the two would disagree
 *   somewhere - and "somewhere" is a wallet screen. `walletBalance()` below
 *   reads the one cached row instead.
 * ---------------------------------------------------------------------------
 */

const redis = require('./redis.service');

/**
 * TTLs, in seconds. All of them are env-tunable, and 0 switches that cache off
 * entirely - useful for isolating a staleness complaint without a deploy.
 *
 * They are short on purpose. These are activity reads: a transaction list that
 * is thirty seconds stale is invisible to the user because a *new* transaction
 * drops the key anyway (see dropUserActivity). The TTL is only the backstop for
 * the paths nothing explicitly invalidates.
 */
const TTL = {
  // Dashboard's five most recent rows and the full history list. Both are
  // dropped by balance.helper the moment money moves, so this bound only
  // matters for changes that move no money (a status flipping to settled).
  txRecent: Number(process.env.CACHE_TTL_TX_RECENT ?? 30),
  txList: Number(process.env.CACHE_TTL_TX_LIST ?? 30),

  // "Has this sender paid this recipient before?" Long, because the answer only
  // ever travels one way - see the note in beneficiary.helper.
  beneficiaryKnown: Number(process.env.CACHE_TTL_BENEFICIARY ?? 6 * 60 * 60),

  // Provider catalogues: data plans, TV bouquets, DISCO lists. Priced by the
  // provider and changed at their pace, not ours.
  catalogue: Number(process.env.CACHE_TTL_CATALOGUE ?? 30 * 60),

  // How long a freshly mailed OTP suppresses another send for the same address.
  otpCooldown: Number(process.env.CACHE_TTL_OTP_COOLDOWN ?? 60),
};

const keys = {
  /** Dashboard: the five most recent rows. */
  txRecent: userId => redis.key('tx', 'recent', Number(userId) || 0),
  /** Transaction screen: the unfiltered, merged, newest-first history. */
  txList: userId => redis.key('tx', 'list', Number(userId) || 0),
  /** Positive-only: this sender has completed a transfer to this recipient. */
  beneficiaryKnown: (senderId, receiverId) =>
    redis.key('beneficiary', 'known', Number(senderId) || 0, Number(receiverId) || 0),
  /** Provider catalogue, `name` already namespaced by its caller. */
  catalogue: name => redis.key('catalogue', String(name)),
  /** OTP resend suppression. `subject` must already be a blind index. */
  otpCooldown: subject => redis.key('auth', 'otp', String(subject)),
};

// Single-flight table. Keyed by cache key, holding the in-progress promise.
const inflight = new Map();

/**
 * Read-through with single-flight.
 *
 * `loader` runs at most once per key at a time in this process. Its value is
 * normalized through the same JSON round trip a cache hit takes, so a hit and a
 * miss hand back an identical shape - a Prisma Decimal is a string either way,
 * and a Date is a Date either way. Without that, a bug appears only once the
 * cache warms up, which is the worst kind to reproduce.
 *
 * `null` and `undefined` are never cached: a loader that failed soft and
 * returned nothing must not pin an empty answer in front of a working database
 * for a whole TTL.
 *
 * @param {string} key   from `keys` above
 * @param {number} ttlSeconds  0 disables caching for this call
 * @param {() => Promise<any>} loader
 */
async function remember(key, ttlSeconds, loader) {
  // Still normalized when caching is switched off. Setting a TTL to 0 to chase
  // a staleness report must change *when* the loader runs, never the shape of
  // what it hands back - otherwise the debugging switch introduces its own bug.
  if (!(ttlSeconds > 0)) return redis.normalize(await loader());

  const hit = await redis.get(key);
  if (hit !== null) return hit;

  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    const value = await loader();
    if (value !== null && value !== undefined) {
      // Not awaited for correctness - the caller's answer does not depend on
      // the write landing, and a slow SET should not slow the response down.
      redis.set(key, value, ttlSeconds).catch(() => null);
    }
    return redis.normalize(value);
  })();

  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    // `finally`, so a rejected loader does not poison the key: the next caller
    // gets a fresh attempt rather than the cached rejection.
    inflight.delete(key);
  }
}

/** Drop keys. Never throws, so write paths can call it without a try/catch. */
function drop(...cacheKeys) {
  const list = cacheKeys.filter(Boolean);
  if (!list.length) return Promise.resolve(null);
  // Drop the in-flight entries too. A loader that started before the write
  // committed is about to cache a pre-write value under this key; letting a
  // later reader join that promise would serve exactly the stale row this call
  // is trying to remove.
  for (const k of list) inflight.delete(k);
  return redis.del(...list).catch(() => null);
}

/**
 * Everything derived from a user's ledger.
 *
 * Called from balance.helper's dropUserCache, which is the single choke point
 * every money movement already passes through - all eleven ledger writers call
 * applyBalanceDelta/upsertBalanceDelta, so hooking here covers them without
 * eleven separate invalidation calls that a twelfth writer would forget.
 */
function dropUserActivity(userId) {
  const id = Number(userId);
  if (!id || Number.isNaN(id)) return Promise.resolve(null);
  return drop(keys.txRecent(id), keys.txList(id));
}

/**
 * The balance as the wallet screen should render it.
 *
 * Deliberately a read of the cached user row rather than a key of its own - see
 * the header note. Display only: never decide a debit from this. Every money
 * path re-reads the balance inside its transaction (`freshUser`, or `updateMany`
 * with `balance: { gte }`), which is what makes a cached figure safe to show.
 */
async function walletBalance(userId) {
  // Required lazily: userCache.service -> ... -> balance.helper requires this
  // module back, and a top-level require would hand one of them an empty
  // exports object depending on which loaded first.
  const { getUserById } = require('./userCache.service');
  const user = await getUserById(userId);
  if (!user) return null;
  return {
    balance: user.balance,
    currency_symbol: user.currency_symbol || '₦',
  };
}

/**
 * Boolean flag cache: "this fact is settled, stop asking Postgres".
 *
 * Only for facts that travel one way and can never be revoked - the flag has no
 * invalidation path beyond its own TTL. `beneficiary:known` is the case it
 * exists for: a completed transfer cannot un-complete. Do not use it for
 * anything a write can reverse.
 *
 * Absent, false and unreachable are all the same answer here: `false`, meaning
 * "ask the database". That is what keeps a Redis outage harmless.
 */
async function getFlag(key) {
  return (await redis.get(key)) === true;
}

/** Set a one-way flag. Fire-and-forget: the caller already has its answer. */
function setFlag(key, ttlSeconds) {
  if (!(ttlSeconds > 0)) return Promise.resolve(null);
  return redis.set(key, true, ttlSeconds).catch(() => null);
}

/**
 * Claim an OTP send slot for `subject` (a blind index, never an address).
 *
 * True means "you may send". False means one was mailed within the cooldown and
 * this request should report success without sending another - it saves an
 * email, a Postgres insert, and stops a resend button from being a mail bomb.
 *
 * Fails OPEN: Redis down returns true and the mail goes out. Suppressing a
 * genuine reset code because a cache is unreachable would lock people out of
 * their own accounts.
 */
async function claimOtpSlot(subject, ttlSeconds = TTL.otpCooldown) {
  if (!subject || !(ttlSeconds > 0) || !redis.isEnabled()) return true;
  // SET NX: atomic claim, so two concurrent resends cannot both win.
  const res = await redis.command(['SET', keys.otpCooldown(subject), '1', 'EX', Math.ceil(ttlSeconds), 'NX']);
  if (res === null) return true; // unreachable Redis -> allow
  return res === 'OK';
}

/** Let the next OTP send through immediately (a code was consumed or invalidated). */
function releaseOtpSlot(subject) {
  if (!subject) return Promise.resolve(null);
  return drop(keys.otpCooldown(subject));
}

module.exports = {
  TTL,
  keys,
  remember,
  drop,
  dropUserActivity,
  walletBalance,
  getFlag,
  setFlag,
  claimOtpSlot,
  releaseOtpSlot,
  // Exposed for test/cache.service.test.js only.
  __test: { inflight },
};
