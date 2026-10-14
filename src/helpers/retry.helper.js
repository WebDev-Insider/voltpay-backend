// Exponential backoff with a ceiling, for calls that leave this process.
//
// Read-only calls retry themselves. A write - a vend, a transfer, a charge -
// does not: a POST that timed out may well have been processed at the far end,
// and sending it again buys a second one. What recovers a write is the
// reconciliation poll that already exists (syncPayrollRunById, funding verify),
// not a retry. So `isTransient` deliberately only describes "the request never
// landed, or the provider is telling us to slow down", and each call site
// decides whether it is safe to repeat.
//
// Delays are jittered. Twenty clients retrying a provider that just came back up
// on the same 1s/2s/4s schedule is a second outage.

const MAX_ALLOWED_RETRIES = 5;

// `Number('')` is 0, so an unset variable has to be caught before the parse -
// otherwise an unconfigured deployment quietly gets zero retries.
function envInt(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Undici surfaces connection problems as a cause chain, so walk it.
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

// 429 and 5xx only. A 400 or a 401 repeats identically however long we wait,
// and a 404 on a lookup is an answer, not a failure.
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function isTransient(err) {
  if (!err) return false;

  const status = Number(err.statusCode || err.status || 0);
  if (TRANSIENT_STATUS.has(status)) return true;
  // A statusCode we recognise as permanent settles it - do not fall through to
  // the message match and retry a declined purchase because it said "failed".
  if (status >= 400 && status < 500) return false;

  for (let e = err, depth = 0; e && depth < 4; e = e.cause, depth += 1) {
    if (e.name === 'AbortError') return true;
    if (e.code && TRANSIENT_CODES.has(String(e.code))) return true;
    const msg = String(e.message || '').toLowerCase();
    if (msg.includes('timed out') || msg.includes('timeout')) return true;
    if (msg.includes('fetch failed') || msg.includes('socket hang up') || msg.includes('network')) return true;
  }

  return false;
}

/**
 * The first real error code in undici's cause chain, e.g. ECONNRESET.
 *
 * `fetch` reports every connection-level failure with the same useless message,
 * the literal string "fetch failed", and puts the reason one or more levels down
 * in `cause`. A log line carrying only the message collapses DNS failure,
 * connection refused, a reset mid-flight and a rejected certificate into one
 * indistinguishable string - and those have different owners and different
 * fixes, so the difference is the whole diagnostic value of the line.
 *
 * Returns '' when there is no code, which is the normal case for an error we
 * threw ourselves rather than one the socket handed us.
 */
function causeCode(err) {
  for (let e = err, depth = 0; e && depth < 4; e = e.cause, depth += 1) {
    if (e.code) return String(e.code);
  }

  return '';
}

function delayFor(attempt, baseMs, maxMs) {
  const window = Math.min(maxMs, baseMs * 2 ** attempt);
  // Full-jitter would allow ~0ms, which retries into a provider that has not
  // recovered. Half the window is fixed, half is random.
  return Math.round(window / 2 + Math.random() * (window / 2));
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying transient failures with exponential backoff.
 *
 * @param {Function} fn            called as fn(attemptNumber), 0-based
 * @param {object}   opts
 * @param {number}   opts.retries  extra attempts after the first (hard cap 5)
 * @param {Function} opts.shouldRetry  (err, attempt) => boolean
 * @param {string}   opts.label    for the log line; never put PII in it
 */
async function withRetry(fn, opts = {}) {
  const retries = Math.max(0, Math.min(MAX_ALLOWED_RETRIES,
    opts.retries != null ? Number(opts.retries) : envInt('PROVIDER_MAX_RETRIES', 2)));
  const baseMs = opts.baseMs != null ? Number(opts.baseMs) : envInt('PROVIDER_RETRY_BASE_MS', 300);
  const maxMs = opts.maxMs != null ? Number(opts.maxMs) : envInt('PROVIDER_RETRY_MAX_MS', 4_000);
  const shouldRetry = typeof opts.shouldRetry === 'function' ? opts.shouldRetry : isTransient;
  const label = String(opts.label || 'provider');

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastError = e;
      if (attempt >= retries || !shouldRetry(e, attempt)) throw e;

      // A provider that states its own cooling-off period has told us something
      // our backoff curve cannot know. Retrying sooner than it asked is a retry
      // that cannot succeed - it just spends an attempt and, on a per-second
      // limiter, extends the block.
      //
      // Longer than our ceiling means we stop instead: sleeping the request
      // thread for that long and then failing anyway helps nobody, and the
      // caller's own fallback is the better answer.
      const hinted = Number(e?.retryAfterMs);
      const hasHint = Number.isFinite(hinted) && hinted > 0;
      if (hasHint && hinted > maxMs) throw e;

      const wait = hasHint ? hinted : delayFor(attempt, baseMs, maxMs);
      console.warn(`↻ retry ${label}`, {
        attempt: attempt + 1,
        of: retries,
        in_ms: wait,
        // A provider module that words its errors for the customer keeps the
        // diagnostic - "fetch failed (ECONNRESET)" - on providerMessage, and
        // that is what an operator reading this line needs.
        reason: String(e?.providerMessage || e?.message || e).slice(0, 120),
      });
      if (typeof opts.onRetry === 'function') {
        try { opts.onRetry(e, attempt, wait); } catch (_) {}
      }
      await sleep(wait);
    }
  }

  throw lastError;
}

module.exports = {
  withRetry,
  isTransient,
  causeCode,
  // exported for tests
  delayFor,
  MAX_ALLOWED_RETRIES,
};
