// Admin audit trail.
//
// Separate from staffpayAudit.service, which writes user_activity - that table
// hangs off User with onDelete: Cascade, so deleting a user erases exactly the
// trail a dispute about that deletion would need. admin_audit_log carries no
// foreign key for that reason: the row outlives its subject.
//
// Never write a name, email, phone or any request body value into `metadata`.
// Ids, route, status code and admin-authored fields only.

const prisma = require('../../database/prisma');

let warnedMissingModel = false;

function modelAvailable() {
  if (prisma.adminAuditLog) return true;
  if (!warnedMissingModel) {
    warnedMissingModel = true;
    console.warn('ℹ️  admin_audit_log model unavailable - run scripts/apply-audit-ddl.js then `npx prisma generate`. Admin actions are not being recorded.');
  }
  return false;
}

// A proxy hands us "client, proxy1, proxy2"; only the first entry is the caller.
function clientIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return (forwarded || req?.ip || req?.socket?.remoteAddress || '').slice(0, 64) || null;
}

/**
 * Record one admin action. Fails open - an audit write that throws must not
 * turn a completed admin action into a 500. It is logged either way.
 */
async function logAdminAction({
  actor = 'admin',
  action,
  method = null,
  path = null,
  targetType = null,
  targetId = null,
  statusCode = null,
  ip = null,
  userAgent = null,
  metadata = null,
}) {
  const line = {
    actor: String(actor || 'admin').slice(0, 64),
    action: String(action || 'admin_action').slice(0, 128),
    method: method ? String(method).slice(0, 8) : null,
    path: path ? String(path).slice(0, 256) : null,
    target_type: targetType ? String(targetType).slice(0, 64) : null,
    target_id: targetId != null ? String(targetId).slice(0, 64) : null,
    status_code: statusCode != null ? Number(statusCode) : null,
    ip: ip ? String(ip).slice(0, 64) : null,
    user_agent: userAgent ? String(userAgent).slice(0, 256) : null,
    metadata: metadata != null ? metadata : null,
  };

  // Always on stdout, so the trail survives even when the table does not.
  console.log('🧾 admin', line);

  if (!modelAvailable()) return null;

  try {
    return await prisma.adminAuditLog.create({ data: line });
  } catch (e) {
    console.error('audit: failed to record admin action', { action: line.action, reason: String(e?.message || e).slice(0, 160) });
    return null;
  }
}

/** Used by the purge worker and any other unattended writer. */
function logSystemAction(action, metadata) {
  return logAdminAction({ actor: 'system', action, metadata });
}

/**
 * `from`/`to` are date-only strings from a filter form. The end of the window
 * has to be the end of that day, otherwise picking the same date twice - the
 * obvious way to ask "what happened today" - matches nothing but midnight.
 */
function dateWindow(from, to) {
  const window = {};

  if (from) {
    const start = new Date(`${String(from).slice(0, 10)}T00:00:00.000Z`);
    if (!Number.isNaN(start.getTime())) window.gte = start;
  }

  if (to) {
    const end = new Date(`${String(to).slice(0, 10)}T23:59:59.999Z`);
    if (!Number.isNaN(end.getTime())) window.lte = end;
  }

  return Object.keys(window).length ? window : null;
}

/**
 * Page the trail.
 *
 * `excludeTargetTypes` exists because this table now carries two different
 * feeds. The machine one (securityEvents.service writes `security` and `alert`
 * rows) is far chattier than the human one, and left unfiltered a single
 * velocity storm buries every admin action of that afternoon. The two are read
 * on separate screens, so they are filtered apart here rather than merged and
 * sorted in a page component.
 */
async function listAdminActions({
  page = 1,
  perPage = 50,
  targetType,
  targetId,
  action,
  actor,
  excludeTargetTypes,
  from,
  to,
} = {}) {
  if (!modelAvailable()) return { items: [], pagination: { page: 1, perPage, total: 0, totalPages: 0 } };

  const take = Math.min(Math.max(Number(perPage) || 50, 1), 100);
  const current = Math.max(Number(page) || 1, 1);

  const excluded = Array.isArray(excludeTargetTypes) ? excludeTargetTypes.filter(Boolean).map(String) : [];

  // An excluded list plus a NULL target_type is the trap here: `notIn` is SQL
  // three-valued logic, so it drops the rows where target_type is NULL - and a
  // plain login or a settings change has no target. The OR puts them back.
  const notExcluded = excluded.length
    ? { OR: [{ target_type: null }, { target_type: { notIn: excluded } }] }
    : {};

  const range = dateWindow(from, to);

  const where = {
    ...(targetType ? { target_type: String(targetType) } : notExcluded),
    ...(targetId != null && targetId !== '' ? { target_id: String(targetId) } : {}),
    ...(action ? { action: { contains: String(action) } } : {}),
    ...(actor ? { actor: { contains: String(actor) } } : {}),
    ...(range ? { created_at: range } : {}),
  };

  const [total, items] = await Promise.all([
    prisma.adminAuditLog.count({ where }),
    prisma.adminAuditLog.findMany({
      where,
      orderBy: { created_at: 'desc' },
      skip: (current - 1) * take,
      take,
    }),
  ]);

  return { items, pagination: { page: current, perPage: take, total, totalPages: Math.ceil(total / take) } };
}

module.exports = {
  logAdminAction,
  logSystemAction,
  listAdminActions,
  clientIp,
};
