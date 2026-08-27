// Admin accounts: login, two-factor, session, and the superadmin-only
// management of other admins.
//
// Login is deliberately noisy in the audit log - success and failure both write
// a row, because "who was trying to get in, from where, and when" is the first
// question asked after any incident. The audit middleware does not cover this
// controller's public routes (they mount before it), so they log explicitly.
//
// Everything follows the same rules as the customer side: passwords through
// hashSecret/verifySecret, email encrypted + blind-indexed, per-account lockout
// after three failures, and never a bare row in a response.

const { randomUUID } = require('crypto');
const prisma = require('../../database/prisma');
const { hashSecret, verifySecret, blindIndex, encryptValue, decryptValue } = require('../helpers/pii.helper');
const {
  ROLES,
  CHALLENGE_TYP,
  adminJwtSecret,
  signAdminToken,
  signChallengeToken,
  verifyAdminToken,
  findAdminByEmail,
  publicAdmin,
  emailFields,
  normalizeEmail,
  validateAdminPassword,
  isValidEmail,
  generateRecoveryCodes,
  consumeRecoveryCode,
} = require('../helpers/adminAccount.helper');
const totp = require('../helpers/totp.helper');
const { getLockRemainingSeconds, registerFailure, clearFailures } = require('../helpers/loginLockout.helper');
const { logAdminAction, clientIp } = require('../services/audit.service');

const PASSWORD_DOMAIN = 'admin_password';

const ok = (res, remark, message, data = null) =>
  res.json({ remark, status: 'success', message: [message], data });

const fail = (res, code, remark, message, data = null) =>
  res.status(code).json({ remark, status: 'error', message: [message], data });

// One key for both the password step and the 2FA step: an attacker who gets
// past the password must not get a fresh three tries at the code.
const lockoutKey = emailIdx => (emailIdx ? `admin:${emailIdx}` : '');

function configured(res) {
  if (!prisma.adminUser) {
    return fail(res, 500, 'config_error', 'Admin accounts table is missing - run scripts/apply-admin-ddl.js');
  }
  if (!adminJwtSecret()) {
    return fail(res, 500, 'config_error', 'ADMIN_JWT_SECRET is not configured (and must differ from JWT_SECRET)');
  }
  return null;
}

function audit(req, admin, action, statusCode, metadata = null) {
  logAdminAction({
    actor: admin?.name || 'unknown',
    action,
    method: req.method,
    path: String(req.originalUrl || req.url || '').split('?')[0],
    targetType: 'admin',
    targetId: admin?.id ? String(admin.id) : null,
    statusCode,
    ip: clientIp(req),
    userAgent: req.headers['user-agent'] || null,
    metadata,
  }).catch(() => null);
}

async function issueSession(req, res, admin, remark = 'login_success') {
  const sid = randomUUID();
  const updated = await prisma.adminUser.update({
    where: { id: admin.id },
    data: { active_session_id: sid, last_login_at: new Date(), last_login_ip: clientIp(req) },
  });

  audit(req, admin, 'admin.login', 200, { role: admin.role, totp: !!admin.totp_enabled });

  return ok(res, remark, 'Login successful', {
    access_token: signAdminToken(admin, sid),
    token_type: 'Bearer',
    admin: publicAdmin(updated),
  });
}

// ---------------------------------------------------------------- public

async function login(req, res) {
  try {
    const bad = configured(res);
    if (bad) return bad;

    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!email || !password) return fail(res, 400, 'validation_error', 'Email and password are required');

    const key = lockoutKey(blindIndex(email, 'email'));
    const locked = await getLockRemainingSeconds(key);
    if (locked > 0) {
      return fail(res, 429, 'account_locked', `Too many failed attempts. Try again in ${Math.ceil(locked / 60)} minute(s).`);
    }

    const admin = await findAdminByEmail(email);
    // Same message and same work either way: a distinct "no such admin" reply
    // would tell an attacker which addresses are worth guessing against.
    const verified = admin
      ? await verifySecret(password, admin.password, PASSWORD_DOMAIN)
      : { ok: false, needsRehash: false };

    if (!admin || admin.status !== 1 || !verified.ok) {
      const state = await registerFailure(key);
      if (admin) audit(req, admin, 'admin.login.failed', 401, { reason: admin.status !== 1 ? 'disabled' : 'bad_password' });
      return fail(res, 401, 'unauthorized', state.locked
        ? 'Too many failed attempts. This account is locked for 10 minutes.'
        : 'Invalid email or password');
    }

    await clearFailures(key);

    if (verified.needsRehash) {
      prisma.adminUser
        .update({ where: { id: admin.id }, data: { password: await hashSecret(password, PASSWORD_DOMAIN) } })
        .catch(e => console.warn('adminAuth: password rehash failed', { admin_id: admin.id, reason: e?.message }));
    }

    if (admin.totp_enabled && admin.totp_secret_enc) {
      return ok(res, 'totp_required', 'Enter the code from your authenticator app', {
        challenge: signChallengeToken(admin.id),
        expires_in: 300,
      });
    }

    return issueSession(req, res, admin);
  } catch (e) {
    console.error('adminAuth.login error:', e?.message || e);
    return fail(res, 500, 'error', 'Login failed');
  }
}

async function verifyTwoFactor(req, res) {
  try {
    const bad = configured(res);
    if (bad) return bad;

    const payload = verifyAdminToken(req.body?.challenge, CHALLENGE_TYP);
    if (!payload?.sub) return fail(res, 401, 'invalid_challenge', 'This login attempt expired. Please sign in again.');

    const admin = await prisma.adminUser.findUnique({ where: { id: Number(payload.sub) } });
    if (!admin || admin.status !== 1 || !admin.totp_enabled) {
      return fail(res, 401, 'unauthorized', 'Invalid login attempt');
    }

    const key = lockoutKey(admin.email_idx);
    const locked = await getLockRemainingSeconds(key);
    if (locked > 0) {
      return fail(res, 429, 'account_locked', `Too many failed attempts. Try again in ${Math.ceil(locked / 60)} minute(s).`);
    }

    const code = String(req.body?.code || '').trim();
    const recoveryCode = String(req.body?.recovery_code || '').trim();

    let passed = false;
    let usedRecovery = false;

    if (code) {
      let secret = '';
      try {
        secret = decryptValue(admin.totp_secret_enc);
      } catch (e) {
        console.error('adminAuth: cannot decrypt TOTP secret', { admin_id: admin.id });
      }
      passed = totp.verifyToken(secret, code);
    } else if (recoveryCode) {
      const remaining = await consumeRecoveryCode(admin.recovery_codes, recoveryCode);
      if (remaining) {
        // Consumed before the session is issued: a code that lets you in twice
        // is not single-use.
        await prisma.adminUser.update({ where: { id: admin.id }, data: { recovery_codes: remaining } });
        passed = true;
        usedRecovery = true;
      }
    } else {
      return fail(res, 400, 'validation_error', 'Enter your 6-digit code or a recovery code');
    }

    if (!passed) {
      const state = await registerFailure(key);
      audit(req, admin, 'admin.login.2fa_failed', 401, { recovery: !!recoveryCode });
      return fail(res, 401, 'unauthorized', state.locked
        ? 'Too many failed attempts. This account is locked for 10 minutes.'
        : 'Invalid code');
    }

    await clearFailures(key);
    if (usedRecovery) audit(req, admin, 'admin.login.recovery_code_used', 200, null);
    return issueSession(req, res, admin);
  } catch (e) {
    console.error('adminAuth.verifyTwoFactor error:', e?.message || e);
    return fail(res, 500, 'error', 'Verification failed');
  }
}

// ------------------------------------------------------------- session

async function me(req, res) {
  if (req.admin?.source !== 'session') {
    return ok(res, 'admin_profile', 'Static admin key', {
      admin: { id: null, name: req.admin?.name || 'admin', role: req.admin?.role || 'superadmin', source: req.admin?.source },
    });
  }
  return ok(res, 'admin_profile', 'Admin profile', { admin: publicAdmin(req.admin.row) });
}

async function logout(req, res) {
  try {
    if (req.admin?.source === 'session') {
      // Clearing the session id invalidates every token ever issued for this
      // admin, not just the one presented - the safe reading of "log me out".
      await prisma.adminUser.update({ where: { id: req.admin.id }, data: { active_session_id: null } });
      audit(req, req.admin, 'admin.logout', 200, null);
    }
    return ok(res, 'logout_success', 'Signed out');
  } catch (e) {
    console.error('adminAuth.logout error:', e?.message || e);
    return fail(res, 500, 'error', 'Logout failed');
  }
}

async function changePassword(req, res) {
  try {
    if (req.admin?.source !== 'session') return fail(res, 400, 'not_supported', 'Static admin keys have no password');

    const current = String(req.body?.current_password || '');
    const next = String(req.body?.new_password || '');
    if (!current || !next) return fail(res, 400, 'validation_error', 'Current and new password are required');

    const invalid = validateAdminPassword(next);
    if (invalid) return fail(res, 400, 'validation_error', invalid);
    if (current === next) return fail(res, 400, 'validation_error', 'New password must be different');

    const verified = await verifySecret(current, req.admin.row.password, PASSWORD_DOMAIN);
    if (!verified.ok) return fail(res, 401, 'unauthorized', 'Current password is incorrect');

    // A new session id logs out every other device holding the old password.
    const sid = randomUUID();
    const updated = await prisma.adminUser.update({
      where: { id: req.admin.id },
      data: {
        password: await hashSecret(next, PASSWORD_DOMAIN),
        must_change_password: false,
        active_session_id: sid,
      },
    });

    audit(req, req.admin, 'admin.password.changed', 200, null);
    return ok(res, 'password_changed', 'Password updated', {
      access_token: signAdminToken(updated, sid),
      token_type: 'Bearer',
      admin: publicAdmin(updated),
    });
  } catch (e) {
    console.error('adminAuth.changePassword error:', e?.message || e);
    return fail(res, 500, 'error', 'Could not change password');
  }
}

async function setupTwoFactor(req, res) {
  try {
    if (req.admin?.source !== 'session') return fail(res, 400, 'not_supported', 'Static admin keys cannot use 2FA');
    if (req.admin.row.totp_enabled) return fail(res, 409, 'already_enabled', 'Two-factor is already on. Turn it off first.');

    const secret = totp.generateSecret();
    // Stored but not enabled: an interrupted setup must not lock anyone out.
    await prisma.adminUser.update({ where: { id: req.admin.id }, data: { totp_secret_enc: encryptValue(secret) } });

    return ok(res, 'totp_setup', 'Scan this in your authenticator app', {
      secret,
      otpauth_url: totp.otpauthUri({ secret, account: req.admin.name }),
    });
  } catch (e) {
    console.error('adminAuth.setupTwoFactor error:', e?.message || e);
    return fail(res, 500, 'error', 'Could not start two-factor setup');
  }
}

async function enableTwoFactor(req, res) {
  try {
    if (req.admin?.source !== 'session') return fail(res, 400, 'not_supported', 'Static admin keys cannot use 2FA');
    if (!req.admin.row.totp_secret_enc) return fail(res, 400, 'setup_required', 'Start setup first');

    const code = String(req.body?.code || '').trim();
    if (!totp.verifyToken(decryptValue(req.admin.row.totp_secret_enc), code)) {
      return fail(res, 400, 'invalid_code', 'That code did not match. Check your phone clock and try again.');
    }

    const { plain, hashed } = await generateRecoveryCodes();
    await prisma.adminUser.update({
      where: { id: req.admin.id },
      data: { totp_enabled: true, recovery_codes: hashed },
    });

    audit(req, req.admin, 'admin.2fa.enabled', 200, null);
    // The only time these are readable. Only the hashes are stored.
    return ok(res, 'totp_enabled', 'Two-factor is on. Save these recovery codes.', { recovery_codes: plain });
  } catch (e) {
    console.error('adminAuth.enableTwoFactor error:', e?.message || e);
    return fail(res, 500, 'error', 'Could not enable two-factor');
  }
}

async function disableTwoFactor(req, res) {
  try {
    if (req.admin?.source !== 'session') return fail(res, 400, 'not_supported', 'Static admin keys cannot use 2FA');

    // Password, not a code: turning off a security control is exactly the
    // action a stolen unlocked session would want to take.
    const verified = await verifySecret(String(req.body?.password || ''), req.admin.row.password, PASSWORD_DOMAIN);
    if (!verified.ok) return fail(res, 401, 'unauthorized', 'Password is incorrect');

    await prisma.adminUser.update({
      where: { id: req.admin.id },
      data: { totp_enabled: false, totp_secret_enc: null, recovery_codes: null },
    });

    audit(req, req.admin, 'admin.2fa.disabled', 200, null);
    return ok(res, 'totp_disabled', 'Two-factor is off');
  } catch (e) {
    console.error('adminAuth.disableTwoFactor error:', e?.message || e);
    return fail(res, 500, 'error', 'Could not disable two-factor');
  }
}

// --------------------------------------------------- manage other admins

async function listAdmins(req, res) {
  try {
    const bad = configured(res);
    if (bad) return bad;
    const rows = await prisma.adminUser.findMany({ orderBy: { created_at: 'desc' }, take: 200 });
    return ok(res, 'admins', 'Admins', { admins: rows.map(publicAdmin) });
  } catch (e) {
    console.error('adminAuth.listAdmins error:', e?.message || e);
    return fail(res, 500, 'error', 'Could not load admins');
  }
}

async function createAdmin(req, res) {
  try {
    const bad = configured(res);
    if (bad) return bad;

    const name = String(req.body?.name || '').trim().slice(0, 64);
    const email = normalizeEmail(req.body?.email);
    const role = String(req.body?.role || 'support');
    // Handed over out of band and forced to change on first login, so the
    // creator never knows the working password.
    const password = String(req.body?.password || '') || `Vp!${randomUUID().replace(/-/g, '').slice(0, 16)}A1`;

    if (!name) return fail(res, 400, 'validation_error', 'Name is required');
    if (!isValidEmail(email)) return fail(res, 400, 'validation_error', 'A valid email is required');
    if (!ROLES.includes(role)) return fail(res, 400, 'validation_error', `Role must be one of: ${ROLES.join(', ')}`);

    const invalid = validateAdminPassword(password);
    if (invalid) return fail(res, 400, 'validation_error', invalid);

    if (await findAdminByEmail(email)) return fail(res, 409, 'duplicate', 'An admin with that email already exists');

    const created = await prisma.adminUser.create({
      data: {
        name,
        ...emailFields(email),
        password: await hashSecret(password, PASSWORD_DOMAIN),
        role,
        must_change_password: true,
        created_by: req.admin?.id || null,
      },
    });

    return ok(res, 'admin_created', 'Admin created', {
      admin: publicAdmin(created),
      // Shown once. Nothing recoverable is stored.
      temporary_password: req.body?.password ? undefined : password,
    });
  } catch (e) {
    console.error('adminAuth.createAdmin error:', e?.message || e);
    return fail(res, 500, 'error', 'Could not create admin');
  }
}

async function updateAdmin(req, res) {
  try {
    const bad = configured(res);
    if (bad) return bad;

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'validation_error', 'Invalid admin id');

    const target = await prisma.adminUser.findUnique({ where: { id } });
    if (!target) return fail(res, 404, 'not_found', 'Admin not found');

    const data = {};
    if (req.body?.name !== undefined) data.name = String(req.body.name).trim().slice(0, 64);
    if (req.body?.role !== undefined) {
      const role = String(req.body.role);
      if (!ROLES.includes(role)) return fail(res, 400, 'validation_error', `Role must be one of: ${ROLES.join(', ')}`);
      data.role = role;
    }
    if (req.body?.status !== undefined) data.status = Number(req.body.status) === 1 ? 1 : 0;

    // Self-lockout guard: nobody may demote or disable themselves, and the last
    // active superadmin may not be demoted or disabled by anyone.
    const losingPower = (data.role && data.role !== 'superadmin') || data.status === 0;
    if (req.admin?.id === id && losingPower) {
      return fail(res, 400, 'not_allowed', 'You cannot demote or disable your own account');
    }
    if (target.role === 'superadmin' && losingPower) {
      const others = await prisma.adminUser.count({ where: { role: 'superadmin', status: 1, id: { not: id } } });
      if (others === 0) return fail(res, 400, 'not_allowed', 'This is the last active superadmin');
    }

    if (!Object.keys(data).length) return fail(res, 400, 'validation_error', 'Nothing to update');

    // Disabling only takes effect on the next request if the session is also
    // dropped, so drop it here.
    if (data.status === 0) data.active_session_id = null;

    const updated = await prisma.adminUser.update({ where: { id }, data });
    return ok(res, 'admin_updated', 'Admin updated', { admin: publicAdmin(updated) });
  } catch (e) {
    console.error('adminAuth.updateAdmin error:', e?.message || e);
    return fail(res, 500, 'error', 'Could not update admin');
  }
}

async function resetAdminPassword(req, res) {
  try {
    const bad = configured(res);
    if (bad) return bad;

    const id = Number(req.params.id);
    const target = await prisma.adminUser.findUnique({ where: { id } });
    if (!target) return fail(res, 404, 'not_found', 'Admin not found');

    const password = `Vp!${randomUUID().replace(/-/g, '').slice(0, 16)}A1`;
    await prisma.adminUser.update({
      where: { id },
      data: {
        password: await hashSecret(password, PASSWORD_DOMAIN),
        must_change_password: true,
        active_session_id: null,
      },
    });

    return ok(res, 'password_reset', 'Temporary password issued', { temporary_password: password });
  } catch (e) {
    console.error('adminAuth.resetAdminPassword error:', e?.message || e);
    return fail(res, 500, 'error', 'Could not reset password');
  }
}

/** For an admin who lost their authenticator and their recovery codes. */
async function clearAdminTwoFactor(req, res) {
  try {
    const bad = configured(res);
    if (bad) return bad;

    const id = Number(req.params.id);
    const target = await prisma.adminUser.findUnique({ where: { id } });
    if (!target) return fail(res, 404, 'not_found', 'Admin not found');

    await prisma.adminUser.update({
      where: { id },
      data: { totp_enabled: false, totp_secret_enc: null, recovery_codes: null, active_session_id: null },
    });

    return ok(res, 'totp_cleared', 'Two-factor cleared. The admin must set it up again.');
  } catch (e) {
    console.error('adminAuth.clearAdminTwoFactor error:', e?.message || e);
    return fail(res, 500, 'error', 'Could not clear two-factor');
  }
}

async function deleteAdmin(req, res) {
  try {
    const bad = configured(res);
    if (bad) return bad;

    const id = Number(req.params.id);
    if (req.admin?.id === id) return fail(res, 400, 'not_allowed', 'You cannot delete your own account');

    const target = await prisma.adminUser.findUnique({ where: { id } });
    if (!target) return fail(res, 404, 'not_found', 'Admin not found');

    if (target.role === 'superadmin') {
      const others = await prisma.adminUser.count({ where: { role: 'superadmin', status: 1, id: { not: id } } });
      if (others === 0) return fail(res, 400, 'not_allowed', 'This is the last active superadmin');
    }

    // The row goes; admin_audit_log has no foreign key to it, so everything
    // they ever did stays on the record.
    await prisma.adminUser.delete({ where: { id } });
    return ok(res, 'admin_deleted', 'Admin deleted');
  } catch (e) {
    console.error('adminAuth.deleteAdmin error:', e?.message || e);
    return fail(res, 500, 'error', 'Could not delete admin');
  }
}

module.exports = {
  login,
  verifyTwoFactor,
  me,
  logout,
  changePassword,
  setupTwoFactor,
  enableTwoFactor,
  disableTwoFactor,
  listAdmins,
  createAdmin,
  updateAdmin,
  resetAdminPassword,
  clearAdminTwoFactor,
  deleteAdmin,
};
