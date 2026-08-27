// Two-tier catalogue cache, shared by every bills provider.
//
// A "catalogue" is a provider's price list - data plans, TV bouquets, DISCO
// lists. Three properties make caching it different from caching a database
// read, and all three are why this is a module rather than a `redis.cached()`
// call at each site:
//
//   1. **A catalogue price is what the customer is charged.** Quote a stale one
//      and we collect the old amount while the provider bills us the new one, so
//      staleness here is a money bug rather than a freshness annoyance.
//   2. **The origin is rate-limited and bursty.** One network's data plans is a
//      categories call plus one call per plan family, and the app asks for
//      several networks at once. Uncoordinated, that is a self-inflicted 429.
//   3. **Nobody may wait on it.** The bills screen has to render. A refresh that
//      blocks the first customer through the door after a TTL expiry is a
//      several-second stall for one unlucky person.
//
// So: L1 in-process (no network), L2 Redis (shared, survives restarts), L3 the
// provider. Reads are single-flighted, stale entries are served immediately and
// refreshed behind the request, and refreshes take a fleet-wide lock so one
// instance pays rather than all of them.
//
// Each provider instantiates its own cache with its own timings - see the
// comments at those call sites for why each number is what it is. Cache keys are
// fully qualified by the caller (`pairgate:providers:data`), which is what keeps
// two providers' catalogues from ever colliding. That matters more than it
// sounds: a ClubKonnect data plan id is a price-like string scoped to one
// network and a PairGate plan id is an opaque token, so serving one provider's
// list under the other's key would vend the wrong bundle.
const redis = require('../services/redis.service');

// Three outcomes, not two, because "nobody else is refreshing" and "there is no
// way to find out" are different facts and callers want opposite things from the
// second one. A demand-driven refresh of a single stale key should go ahead
// unlocked - it is one call, someone is waiting on the value, and refusing
// leaves the stale copy standing until its grace expires. A timed warm pass
// should not.
//
// Returned as a boolean this was indistinguishable, and defaulted to the wrong
// answer for the warm: redis.command() reports an error as null, which read as
// "held elsewhere", so a Redis outage silently stopped warming and logged
// nothing.
const REFRESH_CLAIMED = 'claimed';
const REFRESH_HELD = 'held';
const REFRESH_NO_LOCK = 'no_lock';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Build an isolated catalogue cache.
 *
 * @param {object}  opts
 * @param {string}  opts.label        provider name, for log lines only
 * @param {number}  opts.ttlMs        how long a value stays *fresh*
 * @param {number}  opts.localTtlMs   L1 lifetime; must be well under ttlMs
 * @param {number}  opts.staleGraceMs how long past ttlMs a value stays servable
 * @param {number}  opts.gapMs        minimum spacing between catalogue calls
 * @param {number} [opts.lockMs]      refresh lock lifetime
 */
function createCatalogueCache({ label, ttlMs, localTtlMs, staleGraceMs, gapMs, lockMs = 60_000 }) {
  const cacheStore = new Map();
  const inflight = new Map();
  const refreshing = new Set();

  let queue = Promise.resolve();
  let lastCallAt = 0;

  // Every catalogue call for this provider passes through pace(), so counting
  // here is the one place that gets the number the provider's limiter actually
  // sees. Worth having because the cost of a warm pass is not something you can
  // read off the step list: `data plans MTN` is one step but one call per plan
  // family, and how many families a network carries is a property of the
  // provider's data, not of this code.
  let calls = 0;

  /** Run `fn` no sooner than `gapMs` after the previous catalogue call. */
  function pace(fn) {
    const run = queue.then(async () => {
      const wait = lastCallAt + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      // Stamped before the call rather than after it: a per-second limiter
      // measures when a request arrives, not how long it took to answer.
      lastCallAt = Date.now();
      calls += 1;
      return fn();
    });
    // The queue has to swallow rejections. Chaining the raw promise would make
    // one failed catalogue read reject every read queued behind it.
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  function localGet(key) {
    const hit = cacheStore.get(key);
    if (!hit) return null;
    if (hit.expires > Date.now()) return hit;
    cacheStore.delete(key);
    return null;
  }

  function localSet(key, value, { stale = false, ms = localTtlMs } = {}) {
    cacheStore.set(key, { value, stale, expires: Date.now() + Math.max(1_000, ms) });
  }

  function redisKeyFor(key) {
    return redis.key('catalogue', key);
  }

  function lockKeyFor(key) {
    return redis.key('catalogue', 'refresh', key);
  }

  // One refresh per cycle across the whole fleet, not one per instance. Without
  // this every running process notices the same entry go stale inside the same
  // second and they all re-read the same catalogue - the thundering herd the
  // two-tier cache exists to prevent, arriving one TTL late instead of on a
  // cold start.
  async function claimRefresh(key, ms = lockMs) {
    // Not configured, or configured and currently failing. Either way there is
    // no shared lock to be had, and no L2 behind it.
    if (!redis.isEnabled() || !redis.isHealthy()) return REFRESH_NO_LOCK;

    const held = await redis.command(['SET', lockKeyFor(key), '1', 'NX', 'EX', Math.ceil(ms / 1000)]);
    if (held === 'OK') return REFRESH_CLAIMED;

    // A failed NX and a transport error both surface as null and cannot be told
    // apart here, so this reads as HELD. That is the safe direction - it skips
    // work rather than duplicating it - and it self-corrects: the breaker opens
    // after a run of failures and the branch above then reports NO_LOCK.
    return REFRESH_HELD;
  }

  async function loadInto(key, loader, freshMs) {
    const value = await loader();
    // normalize() so a value that arrived from L1/L2 and one that came straight
    // from the provider are the same shape. Without it a field would be a Date
    // on a cold start and a string once the cache warmed.
    const shaped = redis.normalize(value);

    localSet(key, shaped, { ms: Math.min(localTtlMs, freshMs) });
    // Redis holds the key for fresh + grace, so it outlives its own freshness
    // and there is always something to answer with while a refresh runs. `f` is
    // when it stops being fresh; the key itself disappears at the end of grace.
    redis
      .set(redisKeyFor(key), { v: shaped, f: Date.now() + freshMs }, Math.ceil((freshMs + staleGraceMs) / 1000))
      .catch(() => null);
    return shaped;
  }

  // Fire-and-forget. The caller has already been answered from the stale copy,
  // so anything thrown here is logged and dropped - a failed refresh must not
  // become an unhandled rejection, and the stale value simply stands until its
  // grace runs out.
  //
  // `refreshing` is its own set rather than a reuse of `inflight`, for two
  // reasons. A read must never end up awaiting this promise, because a lock we
  // did not win resolves to nothing and the caller would get an empty
  // catalogue. And the request that *discovers* the staleness is itself sitting
  // in `inflight` by the time the L2 read resolves - guarding on that map would
  // reject the one caller whose job it is to kick the refresh, so the value
  // would go stale and never be replaced.
  function refreshInBackground(key, loader, freshMs) {
    if (refreshing.has(key)) return;
    refreshing.add(key);

    (async () => {
      // Anything but a lock somebody else holds. One stale key, one reader
      // already waiting on it: with no lock available, refreshing unlocked is
      // better than letting the stale copy stand.
      if ((await claimRefresh(key)) !== REFRESH_HELD) await loadInto(key, loader, freshMs);
    })()
      .catch(e => console.warn(`↻ ${label} catalogue refresh failed ${key}:`, String(e?.message || e).slice(0, 120)))
      .finally(() => refreshing.delete(key));
  }

  /**
   * Read-through with single-flight and stale-while-revalidate.
   *
   * A stale entry is returned immediately and refreshed behind the request, so
   * after the first ever load nobody waits on the provider again. The in-flight
   * promise is dropped in a `finally` so a failed load does not poison the next
   * attempt.
   *
   * `force` skips both tiers and re-reads the provider - what a warm pass uses
   * to replace a value *before* it can be quoted stale.
   *
   * Catalogues carry provider names, plan names and prices - no customer data -
   * so they are safe to put in Redis as-is.
   */
  async function cached(key, loader, freshMs = ttlMs, { force = false } = {}) {
    if (!force) {
      const local = localGet(key);
      if (local) {
        // L1 is deliberately narrow, so a stale entry kicks at most one refresh
        // per L1 lifetime per instance, and the Redis lock collapses those
        // across instances.
        if (local.stale) refreshInBackground(key, loader, freshMs);
        return local.value;
      }

      const pending = inflight.get(key);
      if (pending) return pending;
    }

    const promise = (async () => {
      if (!force) {
        const entry = await redis.get(redisKeyFor(key));
        if (entry && entry.v !== undefined) {
          const fresh = Number(entry.f) > Date.now();
          // Another instance - or this one before its last restart - already
          // paid for this. Promote into L1 so the next reads cost nothing at
          // all, stale flag included so the refresh is not re-kicked on every
          // request.
          localSet(key, entry.v, { stale: !fresh, ms: Math.min(localTtlMs, freshMs) });
          if (!fresh) refreshInBackground(key, loader, freshMs);
          return entry.v;
        }
      }

      return loadInto(key, loader, freshMs);
    })();

    inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      inflight.delete(key);
    }
  }

  /**
   * Forget a catalogue everywhere - both tiers, every instance.
   *
   * The reason this has to exist: L2 outlives the process, so a bad or stale
   * catalogue can no longer be cleared by restarting the service. Without a way
   * to drop it, a wrong price would be pinned for the full TTL with no lever.
   */
  async function drop(key) {
    cacheStore.delete(key);
    inflight.delete(key);
    refreshing.delete(key);
    await redis.del(redisKeyFor(key), lockKeyFor(key)).catch(() => null);
  }

  return {
    cached,
    drop,
    pace,
    claimRefresh,
    /** Calls this provider's limiter has seen since boot. */
    callCount: () => calls,
  };
}

module.exports = {
  createCatalogueCache,
  REFRESH_CLAIMED,
  REFRESH_HELD,
  REFRESH_NO_LOCK,
};
