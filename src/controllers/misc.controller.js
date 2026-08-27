const prisma = require('../../database/prisma');
const { randomUUID } = require('crypto');
const { invalidateUser } = require('../services/userCache.service');

async function revokeUserSession(userId) {
  if (!userId) return;
  await prisma.user.update({
    where: { id: Number(userId) },
    data: {
      active_session_id: randomUUID(),
      active_device_id: null,
    },
  });
  // Logout has to bite immediately - a cached row would keep the old session
  // id valid for the rest of the TTL.
  await invalidateUser(userId);
}

async function postLogout(req, res) {
  try {
    console.log('📥 Logout request (POST)');
    try {
      await revokeUserSession(req.user?.id);
    } catch (e) {
      console.warn('⚠️ Failed to revoke session during logout (POST):', e?.message || e);
    }
    return res.json({
      remark: 'logout_success',
      status: 'success',
      message: ['Logged out successfully'],
      data: null
    });
  } catch (error) {
    console.error('Error in logout (controller):', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to logout'],
      data: null
    });
  }
}

async function getLogout(req, res) {
  try {
    console.log('📥 Logout request (GET)');
    try {
      await revokeUserSession(req.user?.id);
    } catch (e) {
      console.warn('⚠️ Failed to revoke session during logout (GET):', e?.message || e);
    }
    return res.json({
      remark: 'logout_success',
      status: 'success',
      message: ['Logged out successfully'],
      data: null
    });
  } catch (error) {
    console.error('Error in logout GET (controller):', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to logout'],
      data: null
    });
  }
}

module.exports = { postLogout, getLogout };
