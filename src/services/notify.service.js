const prisma = require('../../database/prisma');
const { protectText } = require('../helpers/pii.helper');
const { broadcastToUserIds } = require('./notificationWs.service');
const { sendToUser } = require('./fcm.service');

/**
 * One place that turns "something happened to this user" into every delivery
 * channel we have:
 *
 *   1. a row in push_notifications  - the in-app history list
 *   2. a WebSocket frame            - live badge update while the app is open
 *   3. an FCM push                  - the heads-up banner when it is not
 *
 * Each channel is independent. A dead socket or a rejected token must not stop
 * the row from being written, and none of the three may throw into the caller:
 * the callers are money paths that have already committed.
 *
 * `subject` / `message` go through protectText() because they name a
 * counterparty ("John Doe sent you ..."). Same rule as walletTransaction.details.
 * revealText() passes non-prefixed values through unchanged, so rows written
 * before this existed still read back fine.
 *
 * `data` is persisted, so it follows the ledger `meta` rule: ids and amounts
 * only, never a name. `pushData` is transient - it is handed to FCM and lands
 * on the device, never in a column - so the sender's name belongs there.
 */
async function notifyUser({
  userId,
  subject,
  message,
  type = 'general',
  data = null,
  pushData = null,
  clientMessageId = null,
  push = true,
}) {
  const id = Number(userId);
  if (!id || Number.isNaN(id) || !subject || !message) return false;

  let stored = false;
  if (prisma.pushNotification) {
    try {
      await prisma.pushNotification.create({
        data: {
          user_id: id,
          subject: protectText(subject),
          message: protectText(message),
          notification_type: String(type || 'general'),
          data: data || null,
          client_message_id: clientMessageId || null,
        },
      });
      stored = true;
    } catch (e) {
      // P2002 = this event already produced a notification (webhook retry).
      // Stop here so the user is not banner-ed twice for one credit.
      if (e?.code === 'P2002') return false;
      console.error('notifyUser: failed to store notification', { user_id: id, error: e?.message || e });
    }
  }

  try {
    broadcastToUserIds([id], { event: 'notification.created', data: { type } });
  } catch (_) {}

  if (push) {
    try {
      await sendToUser(id, { title: subject, body: message, data: pushData || data || {} });
    } catch (e) {
      console.error('notifyUser: push failed', { user_id: id, error: e?.message || e });
    }
  }

  return stored;
}

module.exports = { notifyUser };
