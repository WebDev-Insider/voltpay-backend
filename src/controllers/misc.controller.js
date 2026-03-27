const prisma = require('../../database/prisma');
const { randomUUID } = require('crypto');

async function revokeUserSession(userId) {
  if (!userId) return;
  await prisma.user.update({
    where: { id: Number(userId) },
    data: {
      active_session_id: randomUUID(),
      active_device_id: null,
    },
  });
}

async function addDeviceToken(req, res) {
  try {
    const { token } = req.body;
    console.log('📥 Device token request (controller):', req.body);

    if (!token) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Device token is required'],
        data: null
      });
    }

    // TODO: persist device token per user when auth is implemented
    return res.json({
      remark: 'device_token_added',
      status: 'success',
      message: ['Device token added successfully'],
      data: { token, registered_at: new Date().toISOString() }
    });
  } catch (error) {
    console.error('Error adding device token (controller):', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to add device token'],
      data: null
    });
  }
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

module.exports = { addDeviceToken, postLogout, getLogout };
