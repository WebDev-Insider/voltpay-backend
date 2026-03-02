const prisma = require('../../database/prisma');
const session = require('../services/session.service');

module.exports = async function userAuth(req, res, next) {
  try {
    // If a session user already exists, refresh it from DB to avoid stale balances
    const current = session.getCurrentUser && session.getCurrentUser();
    if (current?.id != null) {
      const fresh = await prisma.user.findUnique({ where: { id: Number(current.id) } });
      if (fresh) {
        // Blocked users should not access protected routes
        if (Number(fresh.status) !== 1) {
          return res.status(403).json({
            remark: 'blocked',
            status: 'error',
            message: ['Your account is blocked. Please contact support.'],
            data: null
          });
        }
        session.setCurrentUser(fresh);
        req.user = fresh;
        return next();
      }
    }

    // Read token from Authorization header: Bearer <token>
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    let token = null;
    if (authHeader) {
      const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
      token = m ? m[1] : authHeader.trim();
    }
    // Fallbacks: query or body
    token = token || req.query.access_token || req.body?.access_token;

    if (!token) {
      return res.status(401).json({
        remark: 'unauthorized',
        status: 'error',
        message: ['Please login first'],
        data: null
      });
    }

    // Expect token like: token_<userId>_<timestamp>
    let userId = null;
    if (typeof token === 'string' && token.startsWith('token_')) {
      const parts = token.split('_');
      if (parts.length >= 3) {
        const maybeId = Number(parts[1]);
        if (!Number.isNaN(maybeId)) userId = maybeId;
      }
    }

    if (!userId) {
      return res.status(401).json({
        remark: 'unauthorized',
        status: 'error',
        message: ['Invalid access token'],
        data: null
      });
    }

    const user = await prisma.user.findUnique({ where: { id: Number(userId) } });
    if (!user) {
      return res.status(401).json({
        remark: 'unauthorized',
        status: 'error',
        message: ['Please login first'],
        data: null
      });
    }

    // Blocked users should not access protected routes
    if (Number(user.status) !== 1) {
      return res.status(403).json({
        remark: 'blocked',
        status: 'error',
        message: ['Your account is blocked. Please contact support.'],
        data: null
      });
    }

    // Bind to session and request
    session.setCurrentUser(user);
    req.user = user;
    return next();
  } catch (err) {
    console.error('❌ userAuth middleware error:', err);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to authorize request'],
      data: null
    });
  }
};
