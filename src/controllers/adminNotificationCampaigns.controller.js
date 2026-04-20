const prisma = require('../../database/prisma')
const { broadcastToUserIds } = require('../services/notificationWs.service')

function isAccelerateCommError(e) {
  return Boolean(e && (e.code === 'P6000' || e?.meta?.code === 'P6000'))
}

async function withDirectFallback(run) {
  try {
    return await run(prisma)
  } catch (e) {
    if (isAccelerateCommError(e) && prisma.$direct) {
      return await run(prisma.$direct)
    }
    throw e
  }
}

function asString(v) {
  return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim())
}

async function listCampaigns(req, res) {
  try {
    if (!prisma.notificationCampaign) {
      return res.status(500).json({ remark: 'server_error', status: 'error', message: ['NotificationCampaign model is not available. Run prisma generate + db push/migrate and restart the server.'], data: null })
    }

    const page = Math.max(1, Number(req.query.page || 1))
    const perPage = Math.min(Math.max(1, Number(req.query.perPage || 20)), 100)
    const skip = (page - 1) * perPage

    const [total, rows] = await withDirectFallback(p => Promise.all([
      p.notificationCampaign.count(),
      p.notificationCampaign.findMany({
        orderBy: { id: 'desc' },
        skip,
        take: perPage,
      }),
    ]))

    const ids = rows.map(r => r.id)
    const deliveredById = new Map()
    const readById = new Map()

    if (ids.length && prisma.pushNotification) {
      const [delivered, read] = await withDirectFallback(p => Promise.all([
        p.pushNotification.groupBy({
          by: ['campaign_id'],
          where: { campaign_id: { in: ids } },
          _count: { _all: true },
        }),
        p.pushNotification.groupBy({
          by: ['campaign_id'],
          where: { campaign_id: { in: ids }, user_read: true },
          _count: { _all: true },
        }),
      ]))

      for (const r of delivered || []) deliveredById.set(Number(r.campaign_id), Number(r._count?._all || 0))
      for (const r of read || []) readById.set(Number(r.campaign_id), Number(r._count?._all || 0))
    }

    const items = rows.map(r => {
      const deliveredCount = deliveredById.get(Number(r.id)) || 0
      const readCount = readById.get(Number(r.id)) || 0
      const recipients = Number(r.recipient_count || 0) || deliveredCount
      const readRate = recipients > 0 ? Math.round((readCount / recipients) * 1000) / 10 : 0

      return {
        id: r.id,
        title: r.title,
        message: r.message,
        notification_type: r.notification_type,
        image: r.image || null,
        status: r.status,
        recipient_count: recipients,
        delivered_count: deliveredCount,
        read_count: readCount,
        unread_count: Math.max(0, recipients - readCount),
        read_rate: readRate,
        sent_at: r.sent_at ? r.sent_at.toISOString() : null,
        created_at: r.created_at ? r.created_at.toISOString() : null,
        updated_at: r.updated_at ? r.updated_at.toISOString() : null,
      }
    })

    return res.json({
      remark: 'admin_notification_campaigns',
      status: 'success',
      data: {
        campaigns: {
          current_page: page,
          per_page: perPage,
          total,
          last_page: Math.max(1, Math.ceil(total / perPage)),
          data: items,
        }
      }
    })
  } catch (e) {
    console.error('admin.listNotificationCampaigns error', e)
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to list notification campaigns'], data: null })
  }
}

async function createCampaign(req, res) {
  try {
    if (!prisma.notificationCampaign) {
      return res.status(500).json({ remark: 'server_error', status: 'error', message: ['NotificationCampaign model is not available. Run prisma generate + db push/migrate and restart the server.'], data: null })
    }

    const title = asString(req.body?.title)
    const message = asString(req.body?.message)
    const notification_type = asString(req.body?.notification_type) || 'general'
    const image = asString(req.body?.image) || null
    const data = req.body?.data != null ? req.body.data : null

    if (!title || !message) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['title and message are required'], data: null })
    }

    const created = await withDirectFallback(p => p.notificationCampaign.create({
      data: {
        title,
        message,
        notification_type,
        image,
        data,
        status: 'draft',
      }
    }))

    return res.json({
      remark: 'notification_campaign_created',
      status: 'success',
      data: {
        id: created.id,
        status: created.status,
      }
    })
  } catch (e) {
    console.error('admin.createNotificationCampaign error', e)
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to create campaign'], data: null })
  }
}

async function getCampaign(req, res) {
  try {
    if (!prisma.notificationCampaign) {
      return res.status(500).json({ remark: 'server_error', status: 'error', message: ['NotificationCampaign model is not available. Run prisma generate + db push/migrate and restart the server.'], data: null })
    }

    const id = parseInt(req.params.id, 10)
    if (!id || Number.isNaN(id)) {
      return res.status(400).json({ remark: 'bad_request', status: 'error', message: ['Invalid campaign id'], data: null })
    }

    const campaign = await withDirectFallback(p => p.notificationCampaign.findUnique({ where: { id } }))
    if (!campaign) {
      return res.status(404).json({ remark: 'not_found', status: 'error', message: ['Campaign not found'], data: null })
    }

    let deliveredCount = 0
    let readCount = 0
    if (prisma.pushNotification) {
      ;[deliveredCount, readCount] = await withDirectFallback(p => Promise.all([
        p.pushNotification.count({ where: { campaign_id: id } }),
        p.pushNotification.count({ where: { campaign_id: id, user_read: true } }),
      ]))
    }

    const recipients = Number(campaign.recipient_count || 0) || deliveredCount
    const readRate = recipients > 0 ? Math.round((readCount / recipients) * 1000) / 10 : 0

    return res.json({
      remark: 'admin_notification_campaign',
      status: 'success',
      data: {
        campaign: {
          id: campaign.id,
          title: campaign.title,
          message: campaign.message,
          notification_type: campaign.notification_type,
          image: campaign.image || null,
          status: campaign.status,
          recipient_count: recipients,
          delivered_count: deliveredCount,
          read_count: readCount,
          unread_count: Math.max(0, recipients - readCount),
          read_rate: readRate,
          sent_at: campaign.sent_at ? campaign.sent_at.toISOString() : null,
          created_at: campaign.created_at ? campaign.created_at.toISOString() : null,
          updated_at: campaign.updated_at ? campaign.updated_at.toISOString() : null,
        }
      }
    })
  } catch (e) {
    console.error('admin.getNotificationCampaign error', e)
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to fetch campaign'], data: null })
  }
}

async function sendCampaign(req, res) {
  try {
    if (!prisma.notificationCampaign) {
      return res.status(500).json({ remark: 'server_error', status: 'error', message: ['NotificationCampaign model is not available. Run prisma generate + db push/migrate and restart the server.'], data: null })
    }
    if (!prisma.pushNotification) {
      return res.status(500).json({ remark: 'server_error', status: 'error', message: ['PushNotification model is not available. Run prisma generate + db push/migrate and restart the server.'], data: null })
    }

    const id = parseInt(req.params.id, 10)
    if (!id || Number.isNaN(id)) {
      return res.status(400).json({ remark: 'bad_request', status: 'error', message: ['Invalid campaign id'], data: null })
    }

    const campaign = await withDirectFallback(p => p.notificationCampaign.findUnique({ where: { id } }))
    if (!campaign) {
      return res.status(404).json({ remark: 'not_found', status: 'error', message: ['Campaign not found'], data: null })
    }

    const status = String(campaign.status || 'draft').toLowerCase()
    const force = String(req.query?.force || '').trim() === '1'
    if (status === 'sent' && !force) {
      return res.json({ remark: 'notification_campaign_sent', status: 'success', data: { id: campaign.id, status: 'sent', recipient_count: campaign.recipient_count || 0 } })
    }

    const recipientsWhere = { status: 1 }
    const totalRecipients = await withDirectFallback(p => p.user.count({ where: recipientsWhere }))

    const now = new Date()

    await withDirectFallback(p => p.notificationCampaign.update({
      where: { id },
      data: {
        status: 'sending',
        recipient_count: totalRecipients,
        sent_at: now,
      }
    }))

    const batchSize = 500
    let lastId = 0

    while (true) {
      const users = await withDirectFallback(p => p.user.findMany({
        where: { ...recipientsWhere, id: { gt: lastId } },
        orderBy: { id: 'asc' },
        take: batchSize,
        select: { id: true },
      }))

      if (!users || users.length === 0) break
      lastId = Number(users[users.length - 1].id)

      const data = users.map(u => ({
        user_id: Number(u.id),
        campaign_id: id,
        subject: String(campaign.title),
        message: String(campaign.message),
        notification_type: String(campaign.notification_type || 'general'),
        image: campaign.image || null,
        data: campaign.data || null,
        client_message_id: `campaign:${id}`,
        user_read: false,
      }))

      await withDirectFallback(p => p.pushNotification.createMany({
        data,
        skipDuplicates: true,
      }))

       try {
         broadcastToUserIds(
           users.map(u => Number(u.id)),
           {
             event: 'notification.created',
             data: {
               campaign_id: id,
             },
           }
         )
       } catch (_) {}
    }

    await withDirectFallback(p => p.notificationCampaign.update({
      where: { id },
      data: { status: 'sent' },
    }))

    return res.json({ remark: 'notification_campaign_sent', status: 'success', data: { id, status: 'sent', recipient_count: totalRecipients } })
  } catch (e) {
    console.error('admin.sendNotificationCampaign error', e)
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to send campaign'], data: null })
  }
}

async function deleteCampaign(req, res) {
  try {
    if (!prisma.notificationCampaign) {
      return res.status(500).json({ remark: 'server_error', status: 'error', message: ['NotificationCampaign model is not available. Run prisma generate + db push/migrate and restart the server.'], data: null })
    }

    const id = parseInt(req.params.id, 10)
    if (!id || Number.isNaN(id)) {
      return res.status(400).json({ remark: 'bad_request', status: 'error', message: ['Invalid campaign id'], data: null })
    }

    let deletedNotifications = 0
    try {
      if (prisma.pushNotification) {
        const result = await withDirectFallback(p => p.$transaction([
          p.pushNotification.deleteMany({ where: { campaign_id: id } }),
          p.notificationCampaign.delete({ where: { id } }),
        ]))
        deletedNotifications = Number(result?.[0]?.count || 0)
      } else {
        await withDirectFallback(p => p.notificationCampaign.delete({ where: { id } }))
      }
    } catch (e) {
      if (e?.code === 'P2025') {
        return res.status(404).json({ remark: 'not_found', status: 'error', message: ['Campaign not found'], data: null })
      }
      throw e
    }

    return res.json({
      remark: 'notification_campaign_deleted',
      status: 'success',
      data: {
        id,
        deleted_notifications: deletedNotifications,
      }
    })
  } catch (e) {
    console.error('admin.deleteNotificationCampaign error', e)
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to delete campaign'], data: null })
  }
}

module.exports = { listCampaigns, createCampaign, getCampaign, sendCampaign, deleteCampaign }
