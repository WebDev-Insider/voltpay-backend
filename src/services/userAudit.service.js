// Per-user audit trail: what moved money, when, from which IP and device.
//
// Writes user_activity - the table staffpayAudit already used - so there is one
// trail per user rather than one per feature. That table cascades with the User
// row on purpose: it is the user's own record and has to go when they are
// erased. The trail that must OUTLIVE the user (an admin closing an account) is
// admin_audit_log, in services/audit.service.js. Two tables, two lifetimes.
//
// `metadata` follows the ledger rule from CLAUDE.md: amounts, references and
// counterparty ids only. Never a name, email, phone, meter or card number - the
// column is plain JSON.

const prisma = require('../../database/prisma');
const { clientIp } = require('./audit.service');

// The app sends its device id on every authenticated call; userAuth checks it
// against active_device_id. Same header here, so the trail and the session
// binding always name the same device.
function deviceIdOf(req) {
  const raw = req?.headers?.['x-device-id'] || req?.body?.device_id || req?.user?.active_device_id || '';
  return String(raw).trim().slice(0, 128) || null;
}

/**
 * Record one user-visible event. Fails open: an audit write that throws must
 * not turn a completed payment into a 500. The money already moved.
 */
async function logUserEvent({ req = null, userId, event, metadata = null }) {
  const uid = Number(userId ?? req?.user?.id);
  if (!Number.isFinite(uid) || uid <= 0) return null;

  const row = {
    user_id: uid,
    event: String(event || 'activity').slice(0, 64),
    ip: req ? clientIp(req) : null,
    device_id: req ? deviceIdOf(req) : null,
    user_agent: req ? String(req.headers?.['user-agent'] || '').slice(0, 256) || null : null,
    metadata: metadata != null ? metadata : null,
  };

  try {
    if (!prisma.userActivity) return null;
    return await prisma.userActivity.create({ data: row });
  } catch (e) {
    console.error('audit: failed to record user event', { user_id: uid, event: row.event, reason: String(e?.message || e).slice(0, 160) });
    return null;
  }
}

/**
 * Money movement, which is the case a dispute is actually about. Kept separate
 * from logUserEvent only so every caller spells the same fields.
 */
function logMoneyEvent({ req, userId, event, trx, amount, counterpartyId = null, extra = null }) {
  return logUserEvent({
    req,
    userId,
    event,
    metadata: {
      trx: trx ? String(trx) : null,
      amount: Number.isFinite(Number(amount)) ? Number(Number(amount).toFixed(2)) : null,
      ...(counterpartyId != null ? { counterparty_id: Number(counterpartyId) } : {}),
      ...(extra && typeof extra === 'object' ? extra : {}),
    },
  });
}

async function listUserEvents({ userId, page = 1, perPage = 50, event } = {}) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0 || !prisma.userActivity) {
    return { items: [], pagination: { page: 1, perPage: 0, total: 0, totalPages: 0 } };
  }

  const take = Math.min(Math.max(Number(perPage) || 50, 1), 100);
  const current = Math.max(Number(page) || 1, 1);
  const where = { user_id: uid, ...(event ? { event: String(event) } : {}) };

  const [total, items] = await Promise.all([
    prisma.userActivity.count({ where }),
    prisma.userActivity.findMany({
      where,
      orderBy: { created_at: 'desc' },
      skip: (current - 1) * take,
      take,
    }),
  ]);

  return { items, pagination: { page: current, perPage: take, total, totalPages: Math.ceil(total / take) } };
}

module.exports = { logUserEvent, logMoneyEvent, listUserEvents, __test: { deviceIdOf } };
