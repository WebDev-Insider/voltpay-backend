// Admin authentication. Three modes, in order of preference:
//
//   Authorization: Bearer <token>
//       A real admin account (admin_users). Password + optional TOTP, issued by
//       /admin/auth/login. The token carries a session id that must still match
//       the row, so logout and "revoke this admin" take effect immediately.
//
//   x-admin-secret: <key>   with ADMIN_API_KEYS = "ada:superadmin:<key>,..."
//       Named static keys. Kept for machine callers and for the window between
//       deploying this and seeding the first account.
//
//   x-admin-secret: <key>   with ADMIN_API_SECRET = "<key>"
//       The original single shared secret. Still honoured so nothing breaks,
//       and treated as superadmin - but it is anonymous by construction: every
//       action it signs is attributed to "admin" and nobody can be held to it.
//
// Set ADMIN_ALLOW_STATIC_KEYS=0 once every human has an account, and the two
// header modes stop working.
//
// Static-key comparison is length-safe constant time - a shared secret compared
// with === leaks its prefix to anyone patient enough to time the endpoint.

const { timingSafeEqual } = require('crypto');
const prisma = require('../../database/prisma');
const { ROLES, verifyAdminToken } = require('../helpers/adminAccount.helper');

// The only routes an admin with a forced password change may still reach.
const PASSWORD_CHANGE_PATHS = new Set(['/auth/password', '/auth/me', '/auth/logout']);

function deny(res, message = 'Admin access denied') {
  return res.status(401).json({ remark: 'unauthorized', status: 'error', message: [message], data: null });
}

function sameSecret(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** "name:role:key,name:role:key" -> [{ name, role, key }]. Malformed entries are dropped, loudly. */
function parseKeys(raw) {
  return String(raw || '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      const [name, role, ...rest] = entry.split(':');
      const key = rest.join(':');
      if (!name || !key || !ROLES.includes(String(role))) {
        console.warn('adminAuth: ignoring malformed ADMIN_API_KEYS entry (expected name:role:key)');
        return null;
      }
      return { name: name.trim().slice(0, 64), role: String(role), key };
    })
    .filter(Boolean);
}

let cached = null;
let cachedRaw = null;

function configuredKeys() {
  const raw = process.env.ADMIN_API_KEYS || '';
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parseKeys(raw);
  }
  return cached;
}

function staticKeysAllowed() {
  return String(process.env.ADMIN_ALLOW_STATIC_KEYS ?? '1').trim() !== '0';
}

function staticKeysConfigured() {
  return !!process.env.ADMIN_API_SECRET || !!String(process.env.ADMIN_API_KEYS || '').trim();
}

function resolveAdmin(presented) {
  if (!presented || !staticKeysAllowed()) return null;

  for (const entry of configuredKeys()) {
    if (sameSecret(presented, entry.key)) return { name: entry.name, role: entry.role, source: 'static_key' };
  }

  const shared = process.env.ADMIN_API_SECRET;
  if (shared && sameSecret(presented, shared)) return { name: 'admin', role: 'superadmin', source: 'shared_secret' };

  return null;
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

/**
 * Resolves a Bearer token to a live admin row.
 *
 * The row is re-read on every request rather than trusted from the token: a
 * revoked, blocked or demoted admin has to lose access now, not when their
 * 12-hour token expires. Admin traffic is low enough that this costs nothing.
 */
async function resolveSession(req) {
  const token = bearerToken(req);
  if (!token || !prisma.adminUser) return null;

  const payload = verifyAdminToken(token);
  if (!payload?.sub) return null;

  const admin = await prisma.adminUser.findUnique({ where: { id: Number(payload.sub) } });
  if (!admin || admin.status !== 1) return null;
  // Rotated by logout, by a password change and by a superadmin reset.
  if (!admin.active_session_id || admin.active_session_id !== payload.sid) return null;

  return { id: admin.id, name: admin.name, role: admin.role, source: 'session', row: admin };
}

async function adminAuth(req, res, next) {
  try {
    const session = await resolveSession(req);
    if (session) {
      req.admin = session;
      // Everything except the change-password endpoint is closed until the
      // forced rotation is done, so a handed-over password cannot be used to
      // work the dashboard indefinitely.
      if (session.row?.must_change_password && !PASSWORD_CHANGE_PATHS.has(String(req.path || ''))) {
        return res.status(403).json({
          remark: 'password_change_required',
          status: 'error',
          message: ['Set a new password before continuing'],
          data: null,
        });
      }
      return next();
    }

    const staticAdmin = resolveAdmin(req.headers['x-admin-secret']);
    if (staticAdmin) {
      req.admin = staticAdmin;
      return next();
    }

    if (!staticKeysConfigured() && !prisma.adminUser) {
      return res.status(500).json({ remark: 'config_error', status: 'error', message: ['Admin authentication is not configured'], data: null });
    }

    return deny(res);
  } catch (e) {
    console.error('adminAuth error:', e?.message || e);
    return deny(res);
  }
}

/**
 * Second gate for the actions that cannot be undone: deleting a user, bulk
 * status changes, resetting a PIN, moving a price. Placed per route rather than
 * on the router so a read-only support login still works everywhere else.
 */
function requireAdminRole(...allowed) {
  const permitted = new Set(allowed.length ? allowed : ['superadmin']);
  return function adminRoleGate(req, res, next) {
    if (req.admin && permitted.has(req.admin.role)) return next();
    return res.status(403).json({
      remark: 'forbidden',
      status: 'error',
      message: ['This action requires a higher admin role'],
      data: null,
    });
  };
}

module.exports = adminAuth;
module.exports.requireAdminRole = requireAdminRole;
module.exports.ROLES = ROLES;
module.exports.__test = { parseKeys, resolveAdmin, sameSecret, bearerToken, staticKeysAllowed };
