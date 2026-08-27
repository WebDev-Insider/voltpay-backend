const admin = require('firebase-admin');
const prisma = require('../../database/prisma');
const { reveal } = require('../helpers/pii.helper');
const { invalidateUser } = require('./userCache.service');

/**
 * Firebase Cloud Messaging, HTTP v1 only.
 *
 * `admin.messaging().send()` mints an OAuth2 access token from the service
 * account and posts to
 * https://fcm.googleapis.com/v1/projects/{PROJECT_ID}/messages:send.
 * The legacy `Authorization: key=AIza...` endpoint was shut down in 2024 and
 * is not used anywhere here.
 *
 * Like redis.service, this fails open. A push that cannot be delivered must
 * never turn a credited wallet into a failed webhook - the money is already
 * in, the banner is a nicety.
 */

function messagingAvailable() {
  try {
    return Array.isArray(admin.apps) && admin.apps.length > 0;
  } catch (_) {
    return false;
  }
}

/** FCM rejects non-string data values, and silently for nested objects. */
function stringifyData(data) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (v === null || v === undefined) continue;
    out[String(k)] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

function isDeadTokenError(e) {
  const code = String(e?.errorInfo?.code || e?.code || '');
  return (
    code === 'messaging/registration-token-not-registered' ||
    code === 'messaging/invalid-registration-token' ||
    code === 'messaging/invalid-argument'
  );
}

async function clearToken(userId) {
  try {
    await prisma.user.update({
      where: { id: Number(userId) },
      data: { fcm_token_enc: null, fcm_device_id: null, fcm_platform: null },
    });
    await invalidateUser(Number(userId));
  } catch (e) {
    console.error('FCM token cleanup failed', { user_id: Number(userId), error: e?.message || e });
  }
}

async function getUserToken(userId) {
  const row = await prisma.user.findUnique({
    where: { id: Number(userId) },
    select: { fcm_token_enc: true },
  });
  if (!row?.fcm_token_enc) return null;
  try {
    return reveal(row.fcm_token_enc) || null;
  } catch (e) {
    console.error('FCM token decrypt failed', { user_id: Number(userId), error: e?.message || e });
    return null;
  }
}

/**
 * The one message shape every send path uses.
 *
 * Both `notification` and `data` are sent. Notification-only messages are
 * rendered by the OS with its default styling when the app is backgrounded,
 * which bypasses the branded big-text layout the client builds; the data block
 * is what the client's own handler reads.
 *
 * `image` must be a public https URL - FCM fetches it on the device, so an
 * UploadThing link works and a signed/expiring one does not. Android draws it
 * as a big-picture notification by itself while the app is backgrounded; iOS
 * needs `mutable-content` (already set) plus a Notification Service Extension,
 * without which it silently falls back to a text-only banner.
 */
function buildMessage({ title, body, image = null, data = {} }) {
  const imageUrl = typeof image === 'string' && /^https:\/\//i.test(image.trim()) ? image.trim() : null;

  return {
    notification: {
      title: String(title),
      body: String(body),
      ...(imageUrl ? { image: imageUrl } : {}),
    },
    data: stringifyData(data),
    android: {
      priority: 'high',
      notification: {
        channelId: 'voltpay_alerts',
        // Matches the channel the client creates with IMPORTANCE_HIGH; without
        // a matching high-importance channel Android 8+ refuses to show a
        // heads-up banner no matter what priority the message carries.
        priority: 'high',
        sound: 'default',
        color: '#EEBE2B',
        ...(imageUrl ? { imageUrl } : {}),
      },
    },
    apns: {
      headers: { 'apns-priority': '10' },
      payload: {
        aps: {
          sound: 'default',
          'content-available': 1,
          'mutable-content': 1,
        },
      },
      ...(imageUrl ? { fcmOptions: { imageUrl } } : {}),
    },
  };
}

/**
 * Deliver one push to a user's current device.
 *
 * Returns true only when FCM accepted the message.
 */
async function sendToUser(userId, { title, body, image = null, data = {} } = {}) {
  if (!messagingAvailable()) return false;
  if (!title || !body) return false;

  let token;
  try {
    token = await getUserToken(userId);
  } catch (e) {
    console.error('FCM token lookup failed', { user_id: Number(userId), error: e?.message || e });
    return false;
  }
  if (!token) return false;

  const message = { token, ...buildMessage({ title, body, image, data }) };

  try {
    await admin.messaging().send(message);
    return true;
  } catch (e) {
    if (isDeadTokenError(e)) {
      await clearToken(userId);
      return false;
    }
    console.error('FCM send failed', { user_id: Number(userId), error: e?.message || e });
    return false;
  }
}

/** FCM caps one multicast request at 500 registration tokens. */
const MULTICAST_LIMIT = 500;

/**
 * Broadcast to many devices at once.
 *
 * `tokens` is [{ userId, token }] so a per-token failure can be traced back to
 * the row that has to be cleaned up. One request per 500 tokens instead of one
 * per user - a 50k-user campaign is 100 calls, not 50k.
 *
 * Fails open like everything else here: a campaign that cannot reach FCM still
 * has its in-app rows written by the caller.
 *
 * Returns { sent, failed, deadUserIds }.
 */
async function sendToTokens(tokens, { title, body, image = null, data = {} } = {}) {
  const empty = { sent: 0, failed: 0, deadUserIds: [] };
  if (!messagingAvailable() || !title || !body) return empty;

  const list = (tokens || []).filter(t => t && t.token);
  if (!list.length) return empty;

  const base = buildMessage({ title, body, image, data });
  let sent = 0;
  let failed = 0;
  const deadUserIds = [];

  for (let i = 0; i < list.length; i += MULTICAST_LIMIT) {
    const chunk = list.slice(i, i + MULTICAST_LIMIT);

    let result;
    try {
      result = await admin.messaging().sendEachForMulticast({
        ...base,
        tokens: chunk.map(t => t.token),
      });
    } catch (e) {
      // Whole-request failure (auth, network). Nothing to attribute per token.
      console.error('FCM multicast failed', { count: chunk.length, error: e?.message || e });
      failed += chunk.length;
      continue;
    }

    sent += Number(result?.successCount || 0);
    failed += Number(result?.failureCount || 0);

    (result?.responses || []).forEach((r, idx) => {
      if (r?.success || !r?.error) return;
      if (isDeadTokenError(r.error)) deadUserIds.push(Number(chunk[idx].userId));
    });
  }

  // Uninstalled/reinstalled devices. Left in place they burn a slot in every
  // future campaign and skew the delivery numbers.
  for (const userId of deadUserIds) await clearToken(userId);

  return { sent, failed, deadUserIds };
}

/**
 * Broadcast to an FCM topic.
 *
 * One request no matter how many devices are subscribed, and FCM keeps the
 * subscription list - but that means no per-user rows, no read receipts and no
 * way to know how many handsets it reached. Use for reach; use sendToTokens
 * when the campaign has to show delivery stats.
 */
async function sendToTopic(topic, { title, body, image = null, data = {} } = {}) {
  if (!messagingAvailable() || !title || !body) return false;

  const name = String(topic || '').trim();
  // FCM's own topic-name rule. An invalid name is a 400, not a silent drop.
  if (!/^[a-zA-Z0-9-_.~%]{1,900}$/.test(name)) return false;

  try {
    await admin.messaging().send({ topic: name, ...buildMessage({ title, body, image, data }) });
    return true;
  } catch (e) {
    console.error('FCM topic send failed', { topic: name, error: e?.message || e });
    return false;
  }
}

module.exports = { sendToUser, sendToTokens, sendToTopic, messagingAvailable, buildMessage };
