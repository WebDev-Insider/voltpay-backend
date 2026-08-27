const prisma = require('../../database/prisma');
const { encryptValue } = require('../helpers/pii.helper');
const { invalidateUser } = require('../services/userCache.service');

/**
 * FCM registration token registry.
 *
 * The client posts here right after login and again on every
 * onTokenRefresh - FCM rotates tokens on reinstall, restore-from-backup and
 * app-data clear, and a stale token silently drops every push.
 *
 * Stored encrypted, on the user row. Lookup for a credit alert is
 * account number -> funding_transactions.tx_ref (`ppcust_<customer_id>`) ->
 * user_id -> this column, so no separate index is needed.
 */
async function register(req, res) {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });
    }

    const token = String(req.body?.token || req.body?.device_token || '').trim();
    const deviceId = String(req.body?.device_id || req.headers['x-device-id'] || '').trim();
    const platform = String(req.body?.platform || '').trim().toLowerCase();

    // FCM tokens are ~140-180 chars today but the length is not contractual;
    // bound it loosely so a junk body cannot fill the column.
    if (!token || token.length < 20 || token.length > 4096) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['A valid device token is required'], data: null });
    }

    await prisma.user.update({
      where: { id: Number(user.id) },
      data: {
        fcm_token_enc: encryptValue(token),
        fcm_device_id: deviceId || null,
        fcm_platform: platform === 'ios' || platform === 'android' ? platform : null,
        fcm_token_updated_at: new Date(),
      },
    });
    await invalidateUser(Number(user.id));

    return res.json({ remark: 'device_token_saved', status: 'success', message: ['Device token saved'], data: null });
  } catch (e) {
    console.error('Device token register error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to save device token'], data: null });
  }
}

/** Called on logout so the handset stops receiving the previous user's alerts. */
async function unregister(req, res) {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });
    }

    await prisma.user.update({
      where: { id: Number(user.id) },
      data: { fcm_token_enc: null, fcm_device_id: null, fcm_platform: null },
    });
    await invalidateUser(Number(user.id));

    return res.json({ remark: 'device_token_removed', status: 'success', message: ['Device token removed'], data: null });
  } catch (e) {
    console.error('Device token unregister error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to remove device token'], data: null });
  }
}

module.exports = { register, unregister };
