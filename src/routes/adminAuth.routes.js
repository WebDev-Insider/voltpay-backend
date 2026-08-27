// Admin account routes, in two halves.
//
// `publicRoutes` mounts BEFORE adminAuth - an admin signing in has no
// credential yet, so login and the 2FA step cannot sit behind the very gate
// they exist to open. Everything else mounts inside the authenticated chain.
//
// Both public routes are rate limited by IP+email: three failures lock the
// account (loginLockout), and this stops the endpoint being sprayed across many
// accounts from one host.

const express = require('express');
const AdminAuthController = require('../controllers/adminAuth.controller');
const { requireAdminRole } = require('../middlewares/adminAuth.middleware');
const rateLimit = require('../middlewares/rateLimit.middleware');

const superadmin = requireAdminRole('superadmin');

const publicRoutes = express.Router();

publicRoutes.post(
  '/auth/login',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, name: 'admin-login', field: 'email' }),
  AdminAuthController.login,
);

publicRoutes.post(
  '/auth/2fa/verify',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 15, name: 'admin-2fa' }),
  AdminAuthController.verifyTwoFactor,
);

const sessionRoutes = express.Router();

sessionRoutes.get('/auth/me', AdminAuthController.me);
sessionRoutes.post('/auth/logout', AdminAuthController.logout);
sessionRoutes.post('/auth/password', AdminAuthController.changePassword);
sessionRoutes.post('/auth/2fa/setup', AdminAuthController.setupTwoFactor);
sessionRoutes.post('/auth/2fa/enable', AdminAuthController.enableTwoFactor);
sessionRoutes.post('/auth/2fa/disable', AdminAuthController.disableTwoFactor);

// Creating admins is creating access. Superadmin only, every call audited by
// adminAudit because these are POST/PATCH/DELETE under /admin.
sessionRoutes.get('/admins', superadmin, AdminAuthController.listAdmins);
sessionRoutes.post('/admins', superadmin, AdminAuthController.createAdmin);
sessionRoutes.patch('/admins/:id', superadmin, AdminAuthController.updateAdmin);
sessionRoutes.post('/admins/:id/reset-password', superadmin, AdminAuthController.resetAdminPassword);
sessionRoutes.post('/admins/:id/clear-2fa', superadmin, AdminAuthController.clearAdminTwoFactor);
sessionRoutes.delete('/admins/:id', superadmin, AdminAuthController.deleteAdmin);

module.exports = { publicRoutes, sessionRoutes };
