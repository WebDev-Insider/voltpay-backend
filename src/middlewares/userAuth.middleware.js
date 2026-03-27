const prisma = require('../../database/prisma');
const jwt = require('jsonwebtoken');

module.exports = async function userAuth(req, res, next) {
  try {
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

    if (typeof token === 'string' && token.startsWith('token_')) {
      return res.status(401).json({
        remark: 'unauthorized',
        status: 'error',
        message: ['Invalid access token'],
        data: null
      });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(500).json({
        remark: 'config_error',
        status: 'error',
        message: ['JWT_SECRET not configured'],
        data: null
      });
    }

    let payload = null;
    try {
      payload = jwt.verify(String(token), secret);
    } catch (_) {
      return res.status(401).json({
        remark: 'unauthorized',
        status: 'error',
        message: ['Invalid access token'],
        data: null
      });
    }

    const userId = payload && payload.sub ? Number(payload.sub) : null;
    if (!userId || Number.isNaN(userId)) {
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

    const tokenSid = payload && payload.sid ? String(payload.sid) : '';
    const activeSid = user.active_session_id ? String(user.active_session_id) : '';
    if (!tokenSid || !activeSid || tokenSid !== activeSid) {
      return res.status(401).json({
        remark: 'session_revoked',
        status: 'error',
        message: ['Please login first'],
        data: null
      });
    }

    // Enforce strict single device: header/body/query device_id must match stored active_device_id
    const requestDeviceId =
      req.headers['x-device-id'] ||
      req.body?.device_id ||
      req.query?.device_id ||
      '';
    const activeDeviceId = user.active_device_id ? String(user.active_device_id) : '';
    if (activeDeviceId && String(requestDeviceId || '').trim() !== activeDeviceId) {
      return res.status(401).json({
        remark: 'device_mismatch',
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

    // Bind to request
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
