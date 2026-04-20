const prisma = require('../../database/prisma');

async function logStaffPayEvent({ userId, event, metadata }) {
  try {
    if (!prisma.userActivity) return;
    const uid = Number(userId);
    if (!uid) return;
    await prisma.userActivity.create({
      data: {
        user_id: uid,
        event: String(event || 'staffpay'),
        metadata: metadata != null ? metadata : null,
      },
    });
  } catch (_) {}
}

module.exports = {
  logStaffPayEvent,
};
