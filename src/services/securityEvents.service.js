// Persisted security and payment-failure feed.
//
// alerts.service.js already shouts every one of these at a Slack webhook. That
// is the right thing at 3am and the wrong thing at 3pm: a webhook is a stream
// nobody can filter, nobody can page through, and - if ALERT_WEBHOOK_URL is
// unset - nobody ever sees at all. This is the same events, written down.
//
// No new table. admin_audit_log already has the exact shape: no foreign key, so
// a row about a user survives that user's deletion; an index on created_at for
// the feed; an index on (target_type, target_id) for "everything about user
// 41"; a JSON metadata column; and an `actor` that already tells a human write
// apart from a machine one. Adding a model here would mean a migration against
// a live payments database to store what an existing table stores correctly.
//
// PII rule is the database's rule, and it is stricter here than anywhere:
// these rows are read by support, exported into incident threads, and quoted in
// tickets. Ids, references, provider names, counts. Never a name, email, phone,
// meter number or account number. Callers that only have an identifier pass it
// through blindIndex() first, exactly as rateLimit.middleware does.

const prisma = require('../../database/prisma');

// Rows are written under one of two target_types so a single indexed read can
// pull the whole feed, and so the two audiences stay separable: risk works the
// security queue, operations works the payment one.
const SECURITY = 'security';
const ALERT = 'alert';

const SEVERITIES = new Set(['critical', 'error', 'warning', 'info']);

let warnedMissingModel = false;

function modelAvailable() {
  if (prisma.adminAuditLog) return true;
  if (!warnedMissingModel) {
    warnedMissingModel = true;
    console.warn('ℹ️  admin_audit_log model unavailable - security events are not being recorded.');
  }
  return false;
}

// A kind is the thing that happened, in dotted form: velocity.limit,
// login.lockout, payment.mysubwallet.float. It becomes the action column, so it is
// what an admin filters on, and it must not carry a value that varies per
// victim - "velocity.limit.08031234567" would make the filter useless and put a
// phone number in an indexed column.
function actionFor(prefix, kind) {
  return `${prefix}.${String(kind || 'unknown')}`.slice(0, 128);
}

/**
 * Write one event. Fails open in every direction - this is a monitoring path,
 * and a monitoring path that can throw is a way to fail the payment it watches.
 *
 * @param {object} p
 * @param {string} p.kind      dotted, stable, never per-user. `velocity.limit`
 * @param {string} p.severity  critical | error | warning | info
 * @param {string} p.message   one line, human, no identifiers
 * @param {number} [p.userId]  the subject, when there is one
 * @param {object} [p.metadata] ids and counts only
 */
async function recordSecurityEvent({ kind, severity = 'error', message, userId = null, metadata = null, ip = null }) {
  if (!modelAvailable()) return null;

  const level = SEVERITIES.has(String(severity)) ? String(severity) : 'error';

  try {
    return await prisma.adminAuditLog.create({
      data: {
        actor: 'system',
        action: actionFor(SECURITY, kind),
        target_type: SECURITY,
        target_id: userId != null ? String(userId).slice(0, 64) : null,
        ip: ip ? String(ip).slice(0, 64) : null,
        metadata: { severity: level, message: String(message || '').slice(0, 500), ...(metadata || {}) },
      },
    });
  } catch (e) {
    console.error('securityEvents: write failed', { kind, reason: String(e?.message || e).slice(0, 160) });
    return null;
  }
}

/**
 * Same, for a money movement that did not complete. Kept apart from the
 * security feed because the response is different: a payment failure is chased
 * by operations against a provider, a security event is reviewed by risk.
 */
async function recordPaymentAlert({ provider, action, reference = null, userId = null, amount = null, message, metadata = null }) {
  if (!modelAvailable()) return null;

  try {
    return await prisma.adminAuditLog.create({
      data: {
        actor: 'system',
        action: actionFor(ALERT, `${provider || 'provider'}.${action || 'call'}`),
        target_type: ALERT,
        target_id: userId != null ? String(userId).slice(0, 64) : null,
        metadata: {
          severity: 'error',
          message: String(message || 'Payment failed').slice(0, 500),
          provider: provider ? String(provider).slice(0, 40) : null,
          action: action ? String(action).slice(0, 40) : null,
          reference: reference ? String(reference).slice(0, 80) : null,
          amount: amount != null ? String(amount) : null,
          ...(metadata || {}),
        },
      },
    });
  } catch (e) {
    console.error('securityEvents: payment alert write failed', { provider, reason: String(e?.message || e).slice(0, 160) });
    return null;
  }
}

function windowStart(hours) {
  return new Date(Date.now() - Number(hours) * 3_600_000);
}

// Rows written after a clear mark. A missing or nonsense mark filters nothing -
// a failure feed that cannot tell where it was cleared shows everything.
function afterIdWhere(afterId) {
  const id = Number(afterId);
  return afterId != null && Number.isSafeInteger(id) && id > 0 ? { id: { gt: id } } : {};
}

// `from`/`to` arrive as `YYYY-MM-DD` from a date input. An end date has to
// become the END of that day or "from 1st to 1st" silently matches nothing.
function dateRange(from, to) {
  const range = {};
  if (from) {
    const d = new Date(`${from}T00:00:00`);
    if (!Number.isNaN(d.getTime())) range.gte = d;
  }
  if (to) {
    const d = new Date(`${to}T23:59:59.999`);
    if (!Number.isNaN(d.getTime())) range.lte = d;
  }
  return Object.keys(range).length ? range : null;
}

/**
 * Page through one feed. `kind` matches a prefix, so `velocity` brings back
 * every velocity.* event and `payment.mysubwallet` narrows to one provider.
 * `afterId` drops everything at or below a clear mark (see clearAlertFeed).
 */
async function listEvents({ feed = SECURITY, page = 1, perPage = 50, kind = '', userId = null, severity = '', from = '', to = '', afterId = null } = {}) {
  const take = Math.min(Math.max(Number(perPage) || 50, 1), 100);
  const current = Math.max(Number(page) || 1, 1);
  const empty = { items: [], pagination: { page: current, perPage: take, total: 0, totalPages: 0 } };

  if (!modelAvailable()) return empty;

  const target = feed === ALERT ? ALERT : SECURITY;
  const range = dateRange(from, to);

  const where = {
    target_type: target,
    ...(kind ? { action: { startsWith: actionFor(target, kind) } } : {}),
    ...(userId != null && userId !== '' ? { target_id: String(userId) } : {}),
    ...(range ? { created_at: range } : {}),
    ...afterIdWhere(afterId),
  };

  try {
    const [total, rows] = await Promise.all([
      prisma.adminAuditLog.count({ where }),
      prisma.adminAuditLog.findMany({ where, orderBy: { created_at: 'desc' }, skip: (current - 1) * take, take }),
    ]);

    // Severity lives in metadata rather than a column, so it is filtered here
    // rather than in SQL. Deliberate: adding a column means a migration, and
    // the severities that matter (critical/error) are the overwhelming
    // majority of what is written - filtering them out client-side would be
    // the wrong trade, filtering them IN after a bounded page read is cheap.
    const items = rows
      .filter(r => !severity || String(r.metadata?.severity || 'error') === severity)
      .map(r => ({
        id: r.id,
        kind: String(r.action || '').replace(`${target}.`, ''),
        severity: String(r.metadata?.severity || 'error'),
        message: r.metadata?.message || '',
        user_id: r.target_id ? Number(r.target_id) : null,
        ip: r.ip || null,
        metadata: r.metadata || {},
        created_at: r.created_at,
      }));

    return { items, pagination: { page: current, perPage: take, total, totalPages: Math.ceil(total / take) } };
  } catch (e) {
    console.error('securityEvents: list failed', { reason: String(e?.message || e).slice(0, 160) });
    return empty;
  }
}

/**
 * Headline counts for the top of the screen: how much is happening, how fast,
 * and which kind dominates. groupBy on an indexed column over a bounded window.
 */
async function summary({ feed = SECURITY, hours = 24, afterId = null } = {}) {
  const target = feed === ALERT ? ALERT : SECURITY;
  const empty = { total: 0, window_hours: Number(hours), by_kind: [], last_at: null };

  if (!modelAvailable()) return empty;

  try {
    const since = windowStart(hours);
    const after = afterIdWhere(afterId);
    const where = { target_type: target, created_at: { gte: since }, ...after };

    const [total, grouped, latest] = await Promise.all([
      prisma.adminAuditLog.count({ where }),
      prisma.adminAuditLog.groupBy({ by: ['action'], where, _count: { _all: true } }),
      prisma.adminAuditLog.findFirst({ where: { target_type: target, ...after }, orderBy: { created_at: 'desc' }, select: { created_at: true } }),
    ]);

    const by_kind = grouped
      .map(g => ({ kind: String(g.action || '').replace(`${target}.`, ''), count: Number(g._count?._all || 0) }))
      .sort((a, b) => b.count - a.count);

    return { total, window_hours: Number(hours), by_kind, last_at: latest?.created_at || null };
  } catch (e) {
    console.error('securityEvents: summary failed', { reason: String(e?.message || e).slice(0, 160) });
    return empty;
  }
}

// ---------------------------------------------------------------------------
// Clearing the alert feed
// ---------------------------------------------------------------------------

// "Clear" on the Bills / VTU screen is a mark, never a delete. The alert rows
// are admin_audit_log rows - read-only by design - and for an outbound rail
// (airtime, data, bills) they are the only record a failure leaves. So a clear
// writes down how far the feed has been dealt with, the screen counts from
// there, and its "Show cleared" view still reads every row.
//
// The mark is an alert id, not a time. The dashboard sends the newest id it
// rendered, so a failure written while the admin was reading has a higher id
// and survives the clear; a timestamp would have swallowed it unseen.
const ALERT_CLEAR_KEY = 'alert_feed_cleared_through';

function parseClearMark(value) {
  if (!value) return null;
  try {
    const mark = JSON.parse(value);
    const id = Number(mark?.through_id);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return {
      through_id: id,
      cleared_at: mark.cleared_at || null,
      cleared_by: mark.cleared_by ? String(mark.cleared_by).slice(0, 64) : null,
    };
  } catch {
    return null;
  }
}

async function readClearMark() {
  const row = await prisma.appSetting.findUnique({
    where: { setting_key: ALERT_CLEAR_KEY },
    select: { setting_value: true },
  });
  return parseClearMark(row?.setting_value);
}

/**
 * Where the alert feed was last cleared to, or null. Fails open towards showing
 * everything - the one safe direction for a failure feed.
 */
async function getAlertClearMark() {
  try {
    return await readClearMark();
  } catch (e) {
    console.error('securityEvents: clear mark read failed', { reason: String(e?.message || e).slice(0, 160) });
    return null;
  }
}

function invalidEvent(message) {
  const err = new Error(message);
  err.code = 'INVALID_EVENT';
  return err;
}

/**
 * Mark the alert feed as dealt with up to `throughId` - the newest failure the
 * admin had on screen - or up to the newest one written when none is given.
 *
 * `throughId` must be an existing alert row. An arbitrary number would put the
 * mark past rows that do not exist yet, and every failure written until the
 * sequence caught up would be hidden the moment it arrived.
 *
 * Forward only, so an admin clearing from a page loaded a minute ago cannot put
 * back what a newer page already cleared. Not atomic: two clears racing can
 * leave the lower mark, which only shows rows again - the harmless direction.
 *
 * @returns {{ through_id, cleared_at, cleared_by, cleared }} `cleared` is how
 *   many rows this call moved behind the mark; 0 when someone got there first.
 */
async function clearAlertFeed({ throughId = null, actor = 'admin' } = {}) {
  if (!modelAvailable()) return { through_id: null, cleared_at: null, cleared_by: null, cleared: 0 };

  let target = 0;
  if (throughId != null && throughId !== '') {
    const id = Number(throughId);
    if (!Number.isSafeInteger(id) || id <= 0) throw invalidEvent('`through_id` must be the id of a failure in the feed');
    const row = await prisma.adminAuditLog.findFirst({ where: { id, target_type: ALERT }, select: { id: true } });
    if (!row) throw invalidEvent('That failure is not in the alert feed');
    target = row.id;
  } else {
    const newest = await prisma.adminAuditLog.findFirst({
      where: { target_type: ALERT },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    target = newest?.id || 0;
  }

  // Read without the fail-open wrapper: deciding "forward only" against a mark
  // we could not read would be a guess.
  const current = await readClearMark();
  const from = current?.through_id || 0;

  if (!target || target <= from) {
    return { through_id: from || null, cleared_at: current?.cleared_at || null, cleared_by: current?.cleared_by || null, cleared: 0 };
  }

  const cleared = await prisma.adminAuditLog.count({ where: { target_type: ALERT, id: { gt: from, lte: target } } });

  const mark = {
    through_id: target,
    cleared_at: new Date().toISOString(),
    cleared_by: String(actor || 'admin').slice(0, 64),
  };
  const value = JSON.stringify(mark);

  await prisma.appSetting.upsert({
    where: { setting_key: ALERT_CLEAR_KEY },
    update: { setting_value: value },
    create: {
      setting_key: ALERT_CLEAR_KEY,
      setting_value: value,
      description: 'Bills / VTU: provider failures cleared up to this alert id',
    },
  });

  return { ...mark, cleared };
}

module.exports = {
  recordSecurityEvent,
  recordPaymentAlert,
  listEvents,
  summary,
  getAlertClearMark,
  clearAlertFeed,
  SECURITY,
  ALERT,
  __test: { actionFor, dateRange, windowStart, afterIdWhere, parseClearMark, ALERT_CLEAR_KEY },
};
