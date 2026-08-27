const prisma = require('../../database/prisma');
const { revealText } = require('../helpers/pii.helper');

function isAccelerateCommError(e) {
  return Boolean(e && (e.code === 'P6000' || e?.meta?.code === 'P6000'));
}

async function withDirectFallback(run) {
  try {
    return await run(prisma);
  } catch (e) {
    if (isAccelerateCommError(e) && prisma.$direct) {
      return await run(prisma.$direct);
    }
    throw e;
  }
}

function getBaseUrl(req) {
  const configured = process.env.PUBLIC_BASE_URL || process.env.APP_URL || process.env.BACKEND_URL;
  if (configured) return String(configured).trim().replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString().split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.get('host') || '').toString().split(',')[0].trim();
  return `${proto}://${host}`.replace(/\/+$/, '');
}

function toItem(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    agent_id: null,
    merchant_id: null,
    admin_id: null,
    sender: 'admin',
    sent_from: 'admin',
    sent_to: 'user',
    // Event notifications name a counterparty, so notify.service encrypts
    // both. revealText() returns plain rows (campaigns) untouched.
    subject: revealText(row.subject),
    message: revealText(row.message),
    notification_type: row.notification_type,
    image: row.image || null,
    user_read: row.user_read ? '1' : '0',
    created_at: row.created_at ? row.created_at.toISOString() : null,
    updated_at: row.updated_at ? row.updated_at.toISOString() : null,
  };
}

async function list(req, res) {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });
    }

    if (!prisma.pushNotification) {
      return res.status(500).json({
        remark: 'server_error',
        status: 'error',
        message: ['PushNotification model is not available. Run prisma generate + db push/migrate and restart the server.'],
        data: null,
      });
    }

    const perPage = 15;
    const pageNum = Math.max(1, Number(req.query?.page) || 1);
    const skip = (pageNum - 1) * perPage;

    const where = { user_id: Number(user.id) };

    const [total, rows] = await withDirectFallback(p => Promise.all([
      p.pushNotification.count({ where }),
      p.pushNotification.findMany({
        where,
        orderBy: { id: 'desc' },
        skip,
        take: perPage,
      }),
    ]));

    const base = getBaseUrl(req);
    const path = `${process.env.API_PREFIX || '/api'}/push-notifications`;
    const nextPage = skip + perPage < total ? pageNum + 1 : null;

    return res.json({
      remark: 'push_notifications',
      status: 'success',
      message: ['Notifications fetched'],
      data: {
        notifications: {
          data: rows.map(toItem),
          next_page_url: nextPage ? `${base}${path}?page=${nextPage}` : null,
          path: `${base}${path}`,
        },
      },
    });
  } catch (e) {
    console.error('Push notifications list error:', e);
    if (e?.code && typeof e.code === 'string' && e.code.startsWith('P100')) {
      return res.status(500).json({
        remark: 'server_error',
        status: 'error',
        message: ['Database connection failed. Check DATABASE_URL and database availability.'],
        data: null,
      });
    }
    if (String(e?.message || '').toLowerCase().includes('database_url')) {
      return res.status(500).json({
        remark: 'server_error',
        status: 'error',
        message: ['DATABASE_URL is missing/invalid. Set DATABASE_URL in backend .env and restart the server.'],
        data: null,
      });
    }
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to fetch notifications'], data: null });
  }
}

async function ingest(req, res) {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });
    }

    if (!prisma.pushNotification) {
      return res.status(500).json({
        remark: 'server_error',
        status: 'error',
        message: ['PushNotification model is not available. Run prisma generate + db push/migrate and restart the server.'],
        data: null,
      });
    }

    const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    const notification_type = typeof req.body?.notification_type === 'string' ? req.body.notification_type.trim() : 'general';
    const image = typeof req.body?.image === 'string' ? req.body.image.trim() : null;
    const data = req.body?.data != null ? req.body.data : null;
    const client_message_id = typeof req.body?.client_message_id === 'string' ? req.body.client_message_id.trim() : null;

    if (!subject || !message) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: ['subject and message are required'],
        data: null,
      });
    }

    let created;
    try {
      created = await withDirectFallback(p => p.pushNotification.create({
        data: {
          user_id: Number(user.id),
          subject,
          message,
          notification_type: notification_type || 'general',
          image: image || null,
          data,
          client_message_id: client_message_id || null,
        },
      }));
    } catch (e) {
      if (e?.code === 'P2002') {
        return res.json({ remark: 'notification_exists', status: 'success', message: ['Notification already stored'], data: null });
      }
      if (e?.code === 'P2021') {
        return res.status(500).json({
          remark: 'server_error',
          status: 'error',
          message: ['push_notifications table is missing. Run prisma db push/migrate and restart the server.'],
          data: null,
        });
      }
      if (e?.code === 'P2022') {
        return res.status(500).json({
          remark: 'server_error',
          status: 'error',
          message: ['push_notifications schema is out of sync with Prisma. Run prisma db push/migrate and restart the server.'],
          data: null,
        });
      }
      throw e;
    }

    return res.json({ remark: 'notification_stored', status: 'success', message: ['Notification stored'], data: { id: created.id } });
  } catch (e) {
    console.error('Push notifications ingest error:', e);
    if (e?.code && typeof e.code === 'string' && e.code.startsWith('P100')) {
      return res.status(500).json({
        remark: 'server_error',
        status: 'error',
        message: ['Database connection failed. Check DATABASE_URL and database availability.'],
        data: null,
      });
    }
    if (String(e?.message || '').toLowerCase().includes('database_url')) {
      return res.status(500).json({
        remark: 'server_error',
        status: 'error',
        message: ['DATABASE_URL is missing/invalid. Set DATABASE_URL in backend .env and restart the server.'],
        data: null,
      });
    }
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to store notification'], data: null });
  }
}

async function unreadCount(req, res) {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });
    }

    if (!prisma.pushNotification) {
      return res.status(500).json({
        remark: 'server_error',
        status: 'error',
        message: ['PushNotification model is not available. Run prisma generate + db push/migrate and restart the server.'],
        data: null,
      });
    }

    const count = await withDirectFallback(p => p.pushNotification.count({
      where: { user_id: Number(user.id), user_read: false },
    }));

    return res.json({
      remark: 'push_notifications_unread_count',
      status: 'success',
      message: ['Unread count fetched'],
      data: { unread_count: Number(count || 0) },
    });
  } catch (e) {
    console.error('Push notifications unreadCount error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to fetch unread count'], data: null });
  }
}

async function markRead(req, res) {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });
    }

    if (!prisma.pushNotification) {
      return res.status(500).json({
        remark: 'server_error',
        status: 'error',
        message: ['PushNotification model is not available. Run prisma generate + db push/migrate and restart the server.'],
        data: null,
      });
    }

    const id = parseInt(req.params.id, 10);
    if (!id || Number.isNaN(id)) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid notification id'], data: null });
    }

    const updated = await withDirectFallback(p => p.pushNotification.updateMany({
      where: { id: Number(id), user_id: Number(user.id) },
      data: { user_read: true },
    }));

    if (!updated || Number(updated.count || 0) <= 0) {
      return res.status(404).json({ remark: 'not_found', status: 'error', message: ['Notification not found'], data: null });
    }

    return res.json({ remark: 'push_notification_read', status: 'success', message: ['Notification marked as read'], data: { id } });
  } catch (e) {
    console.error('Push notifications markRead error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to mark notification as read'], data: null });
  }
}

async function markAllRead(req, res) {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });
    }

    if (!prisma.pushNotification) {
      return res.status(500).json({
        remark: 'server_error',
        status: 'error',
        message: ['PushNotification model is not available. Run prisma generate + db push/migrate and restart the server.'],
        data: null,
      });
    }

    const updated = await withDirectFallback(p => p.pushNotification.updateMany({
      where: { user_id: Number(user.id), user_read: false },
      data: { user_read: true },
    }));

    return res.json({ remark: 'push_notifications_read_all', status: 'success', message: ['Notifications marked as read'], data: { updated: Number(updated?.count || 0) } });
  } catch (e) {
    console.error('Push notifications markAllRead error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to mark all notifications as read'], data: null });
  }
}

async function clearAll(req, res) {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });
    }

    if (!prisma.pushNotification) {
      return res.status(500).json({
        remark: 'server_error',
        status: 'error',
        message: ['PushNotification model is not available. Run prisma generate + db push/migrate and restart the server.'],
        data: null,
      });
    }

    const deleted = await withDirectFallback(p => p.pushNotification.deleteMany({
      where: { user_id: Number(user.id) },
    }));

    return res.json({
      remark: 'push_notifications_cleared',
      status: 'success',
      message: ['Notifications cleared'],
      data: { deleted: Number(deleted?.count || 0) },
    });
  } catch (e) {
    console.error('Push notifications clearAll error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to clear notifications'], data: null });
  }
}

module.exports = { list, ingest, unreadCount, markRead, markAllRead, clearAll };
