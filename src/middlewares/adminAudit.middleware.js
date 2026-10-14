// Every admin write, recorded. Mounted once on the /admin router, so a new
// admin endpoint is audited the day it is added and nobody has to remember.
//
// Reads are skipped - listing users is not an event worth a row, and logging
// every dashboard poll would bury the writes that matter.
//
// The body is NOT logged. `POST /admin/users/:id/reset-pin` carries a PIN, and
// campaign bodies carry message text. What goes in is the set of key names plus
// the values of a short allowlist of admin-authored scalars, so "who changed
// what to what" survives without any user data leaving the database.

const { logAdminAction, clientIp } = require('../services/audit.service');

const AUDITED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Values admins type or choose. No free text from a user ever reaches these.
const SAFE_BODY_KEYS = new Set([
  'status',
  'role',
  'priority',
  'price',
  'amount',
  'decision',
  'approved',
  'is_active',
  'enabled',
  'reason',
  'title',
  'auto_pay_enabled',
  // A bills provider name, from a closed set. Without the value the trail says
  // a rail was switched but not to what, which is the only fact anyone reads
  // this row for.
  'provider',
  // CAC: whether a rejection also refunded the customer, and the service's
  // admin-set terms - which type a price change was for, and the time quoted.
  // All admin-chosen; none carries customer data.
  'refund',
  'processing_time',
  'registration_type',
]);

function safeBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};

  const keys = Object.keys(body);
  const safe = {};
  for (const key of keys) {
    if (!SAFE_BODY_KEYS.has(key)) continue;
    const value = body[key];
    if (value == null) continue;
    if (typeof value === 'object') continue;
    safe[key] = String(value).slice(0, 200);
  }

  // Key names alone are safe and answer "did they send a new PIN or not".
  return { fields: keys.slice(0, 25), values: safe };
}

// `/api/admin/users/12/status` -> { type: 'users', id: '12', action: 'users.status' }
// Parsed from the URL rather than req.params: params belong to whichever router
// layer is executing, and by the time 'finish' fires that is no longer ours.
function describe(req) {
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  const segments = path.split('/').filter(Boolean);
  const adminAt = segments.indexOf('admin');
  const rest = adminAt === -1 ? segments : segments.slice(adminAt + 1);

  const type = rest[0] || 'admin';
  const idPart = rest.find(s => /^\d+$/.test(s));
  const verb = rest.slice(1).filter(s => !/^\d+$/.test(s)).join('.');

  return {
    path,
    targetType: type,
    targetId: idPart || null,
    action: `${req.method.toLowerCase()}.${[type, verb].filter(Boolean).join('.')}`,
  };
}

module.exports = function adminAudit(req, res, next) {
  if (!AUDITED_METHODS.has(req.method)) return next();

  // Snapshot now: a controller is free to mutate req.body, and the response is
  // already on its way out by the time 'finish' fires.
  const metadata = safeBody(req.body);
  const info = describe(req);
  const ip = clientIp(req);
  const userAgent = req.headers['user-agent'] || null;
  // Set by adminAuth from the named key that signed the request. Falls back to
  // 'admin' when the deployment is still on the single shared secret, which is
  // exactly the case where nobody can be held to the action.
  const actor = req.admin?.name || 'admin';
  const role = req.admin?.role || null;

  res.on('finish', () => {
    logAdminAction({
      actor,
      action: info.action,
      method: req.method,
      path: info.path,
      targetType: info.targetType,
      targetId: info.targetId,
      statusCode: res.statusCode,
      ip,
      userAgent,
      metadata: role ? { ...metadata, actor_role: role } : metadata,
    }).catch(() => null);
  });

  return next();
};

module.exports.__test = { safeBody, describe };
