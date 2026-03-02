const prisma = require('../../database/prisma');

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
    subject: row.subject,
    message: row.message,
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

    const [total, rows] = await Promise.all([
      prisma.pushNotification.count({ where }),
      prisma.pushNotification.findMany({
        where,
        orderBy: { id: 'desc' },
        skip,
        take: perPage,
      }),
    ]);

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
      created = await prisma.pushNotification.create({
        data: {
          user_id: Number(user.id),
          subject,
          message,
          notification_type: notification_type || 'general',
          image: image || null,
          data,
          client_message_id: client_message_id || null,
        },
      });
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

async function getSettings(req, res) {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });
    }

    const key = `notification_settings:user:${Number(user.id)}`;
    const row = await prisma.appSetting.findUnique({ where: { setting_key: key } });

    let settings = { en: '1', pn: '1', sn: '1', is_allow_promotional_notify: '1' };
    if (row?.setting_value) {
      try {
        const parsed = JSON.parse(String(row.setting_value));
        if (parsed && typeof parsed === 'object') {
          settings = {
            en: parsed.en != null ? String(parsed.en) : settings.en,
            pn: parsed.pn != null ? String(parsed.pn) : settings.pn,
            sn: parsed.sn != null ? String(parsed.sn) : settings.sn,
            is_allow_promotional_notify: parsed.is_allow_promotional_notify != null ? String(parsed.is_allow_promotional_notify) : settings.is_allow_promotional_notify,
          };
        }
      } catch (_) {}
    }

    return res.json({
      remark: 'notification_settings',
      status: 'success',
      message: ['Notification settings fetched'],
      data: {
        user: {
          id: user.id,
          en: settings.en === '1' ? '1' : '0',
          pn: settings.pn === '1' ? '1' : '0',
          sn: settings.sn === '1' ? '1' : '0',
          is_allow_promotional_notify: settings.is_allow_promotional_notify === '1' ? '1' : '0',
        },
      },
    });
  } catch (e) {
    console.error('Notification settings get error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to fetch notification settings'], data: null });
  }
}

function as01(v, defaultValue = '1') {
  if (v == null) return defaultValue;
  const s = String(v).trim();
  if (s === '1' || s.toLowerCase() === 'true') return '1';
  if (s === '0' || s.toLowerCase() === 'false') return '0';
  return defaultValue;
}

async function setSettings(req, res) {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });
    }

    const incoming = req.body || {};
    const promo = incoming.is_allow_promotional_notify != null ? incoming.is_allow_promotional_notify : (incoming.pmn != null ? incoming.pmn : null);
    const settings = {
      en: as01(incoming.en, '1'),
      pn: as01(incoming.pn, '1'),
      sn: as01(incoming.sn, '1'),
      is_allow_promotional_notify: as01(promo, '1'),
    };

    const key = `notification_settings:user:${Number(user.id)}`;
    const value = JSON.stringify(settings);

    await prisma.appSetting.upsert({
      where: { setting_key: key },
      update: { setting_value: value, description: 'User notification settings' },
      create: { setting_key: key, setting_value: value, description: 'User notification settings' },
    });

    return res.json({
      remark: 'notification_settings_updated',
      status: 'success',
      message: ['Notification settings updated'],
      data: {
        user: {
          id: user.id,
          en: settings.en,
          pn: settings.pn,
          sn: settings.sn,
          is_allow_promotional_notify: settings.is_allow_promotional_notify,
        },
      },
    });
  } catch (e) {
    console.error('Notification settings set error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to update notification settings'], data: null });
  }
}

module.exports = { list, ingest, getSettings, setSettings };
