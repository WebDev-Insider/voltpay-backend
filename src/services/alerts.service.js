// Error tracking and payment-failure alerting.
//
// No SDK. One outbound POST to ALERT_WEBHOOK_URL (Slack and Discord both accept
// the body below) and a console line that is always written, so an unset webhook
// costs nothing and loses nothing. Like redis.service, this fails open in every
// direction: an alert must never be able to fail a payment.
//
// PII rule is the database's rule. Pass ids, references and provider names.
// Never a name, email, phone, meter number or account number - this text leaves
// the building and lands in a chat room.

const { blindIndex } = require('../helpers/pii.helper');
const { recordSecurityEvent, recordPaymentAlert } = require('./securityEvents.service');

const WINDOW_MS = Math.max(10_000, Number(process.env.ALERT_THROTTLE_MS) || 5 * 60_000);
const TIMEOUT_MS = Math.max(1_000, Number(process.env.ALERT_TIMEOUT_MS) || 5_000);

// key -> { until, suppressed }. In-process on purpose: one box per alert stream
// is the right granularity, and a shared counter in Redis would make alerting
// depend on the cache it is supposed to warn about.
const throttle = new Map();

function webhookUrl() {
  return String(process.env.ALERT_WEBHOOK_URL || '').trim();
}

function isEnabled() {
  return Boolean(webhookUrl());
}

// A message like "insufficient funds for 08031234567" would otherwise key a new
// bucket per victim and defeat the throttle - and carry a phone number into the
// key. Digits go, so every instance of a failure shares one bucket.
function throttleKey(scope, message) {
  return `${scope}:${String(message || '').replace(/\d+/g, '#').slice(0, 120)}`;
}

function takeSlot(key) {
  const now = Date.now();
  const hit = throttle.get(key);
  if (hit && hit.until > now) {
    hit.suppressed += 1;
    return { send: false, suppressed: hit.suppressed };
  }
  const suppressed = hit ? hit.suppressed : 0;
  throttle.set(key, { until: now + WINDOW_MS, suppressed: 0 });
  if (throttle.size > 500) {
    for (const [k, v] of throttle) if (v.until <= now) throttle.delete(k);
  }
  return { send: true, suppressed };
}

function formatContext(context) {
  if (!context || typeof context !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(context)) {
    if (v == null || v === '') continue;
    parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : String(v).slice(0, 120)}`);
  }
  return parts.join(' ');
}

async function post(text) {
  const url = webhookUrl();
  if (!url) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // `text` is Slack's field, `content` is Discord's. Each ignores the other.
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, content: text }),
      signal: controller.signal,
    });
    return true;
  } catch (e) {
    console.error('alerts: webhook delivery failed', { reason: String(e?.message || e).slice(0, 120) });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function emit({ level, scope, message, context }) {
  const line = String(message || 'unknown error').slice(0, 500);
  const ctx = formatContext(context);
  const logLine = `${level === 'error' ? '🚨' : '⚠️'} [${scope}] ${line}${ctx ? ` | ${ctx}` : ''}`;

  if (level === 'error') console.error(logLine);
  else console.warn(logLine);

  if (!isEnabled()) return Promise.resolve(false);

  const slot = takeSlot(throttleKey(scope, line));
  if (!slot.send) return Promise.resolve(false);

  const env = String(process.env.NODE_ENV || 'development');
  const repeated = slot.suppressed ? `\n_(${slot.suppressed} more like this in the last ${Math.round(WINDOW_MS / 60_000)} min)_` : '';
  return post(`*VoltPay ${env}* · ${scope}\n${line}${ctx ? `\n\`${ctx}\`` : ''}${repeated}`);
}

/**
 * Something threw where it should not have. Logs, then alerts.
 * `context` is for ids only.
 */
function captureError(scope, error, context = {}) {
  const message = error instanceof Error
    ? `${error.message}`
    : String(error || 'unknown error');

  if (error instanceof Error && error.stack) {
    // Full stack to stdout only. The webhook gets the message.
    console.error(`[${scope}] stack:`, error.stack);
  }

  // Written down as well as shouted. Deliberately NOT behind the throttle: the
  // throttle exists so a chat room is readable, and a feed an admin pages
  // through wants the row that the throttle would have swallowed. Fire and
  // forget - persistence is a monitoring concern and must not delay a caller.
  recordSecurityEvent({ kind: `error.${scope}`, severity: 'error', message, metadata: context }).catch(() => null);

  return emit({ level: 'error', scope, message, context }).catch(() => false);
}

/**
 * A money movement did not complete. Always alert-worthy - this is the signal
 * the README's "monitor failed payments" line is asking for.
 *
 * @param {object} p
 * @param {string} p.provider  mysubwallet | paystack | paymentpoint | payvessel
 * @param {string} p.action    airtime | data | electricity | transfer | funding | float | config
 * @param {string} p.reference our reference, never the customer identifier
 */
function paymentFailure({ provider, action, reference, userId, amount, message, context }) {
  // The reconciliation screen reads these back: a failed vend that never
  // reached a funding or ledger row exists nowhere else in the database.
  recordPaymentAlert({
    provider, action, reference, userId, amount,
    message: message || 'Payment failed',
    metadata: context,
  }).catch(() => null);

  return emit({
    level: 'error',
    scope: `payment.${String(provider || 'provider')}.${String(action || 'call')}`,
    message: String(message || 'Payment failed'),
    context: {
      reference: reference || null,
      user_id: userId != null ? Number(userId) : null,
      amount: amount != null ? String(amount) : null,
      ...(context || {}),
    },
  }).catch(() => false);
}

/**
 * Something that should never happen in a security path did. Separate entry so
 * these are greppable and never throttled together with payment noise.
 * An identifier is keyed through the blind index first, exactly like the rate
 * limiter, so the alert can be correlated without carrying a phone number.
 */
function securityEvent(scope, message, { identifier, domain = 'mobile', ...context } = {}) {
  // The risk queue. `user_id` is lifted out of the context so the row can be
  // pulled by subject through the (target_type, target_id) index; the raw
  // identifier is keyed first and never stored.
  recordSecurityEvent({
    kind: scope,
    severity: 'critical',
    message,
    userId: context?.user_id ?? null,
    metadata: {
      ...context,
      ...(identifier ? { subject: String(blindIndex(identifier, domain) || '').slice(0, 16) } : {}),
    },
  }).catch(() => null);

  return emit({
    level: 'error',
    scope: `security.${scope}`,
    message,
    context: {
      ...context,
      ...(identifier ? { subject: String(blindIndex(identifier, domain) || '').slice(0, 16) } : {}),
    },
  }).catch(() => false);
}

module.exports = {
  captureError,
  paymentFailure,
  securityEvent,
  isEnabled,
  // exported for tests
  __test: { throttleKey, takeSlot, throttle, formatContext },
};
