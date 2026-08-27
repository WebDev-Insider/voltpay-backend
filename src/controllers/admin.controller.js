const prisma = require('../../database/prisma')

const { hashSecret, blindIndex, publicUser } = require('../helpers/pii.helper')

const { invalidateUser } = require('../services/userCache.service')

const { listAdminActions } = require('../services/audit.service')

const { listUserEvents } = require('../services/userAudit.service')

const { listFeatures, setFeature } = require('../helpers/featureFlag.helper')

const { DELETED } = require('../helpers/accountStatus.helper')


// Closing an account is the account lifecycle's job, not the dashboard's. See
// account.controller.js for what "erased" means and why the ledger stays.
const { purgeUser } = require('./account.controller')



async function getStats(req, res) {

  try {

    // Purged accounts keep their row for the ledger, so every headline count
    // has to exclude them or the dashboard reports customers who no longer
    // exist. Balance is summed over everyone on purpose - a purged row's
    // balance is zero, and money that somehow survived must not vanish from
    // the total.
    const totalUsers = await prisma.user.count({ where: { status: { not: DELETED } } })

    const activeUsers = await prisma.user.count({ where: { status: 1 } })

    const blockedUsers = await prisma.user.count({ where: { status: 0 } })

    let totalBalance = '0'

    try {

      const sum = await prisma.user.aggregate({ _sum: { balance: true } })

      totalBalance = String(sum._sum.balance || 0)

    } catch (e) {

      console.error('admin.getStats: failed to aggregate balances', e)

    }

    const recent = await prisma.user.findMany({

      where: { status: { not: DELETED } },

      orderBy: { created_at: 'desc' },

      take: 5,

      select: { id: true, firstname_enc: true, lastname_enc: true, username_enc: true, email_enc: true, mobile_enc: true, status: true, created_at: true, image: true, role: true }

    })

    const timeZone = process.env.APP_TIMEZONE

    const dateKeyForStats = d => {
      if (timeZone) {
        try {
          const parts = new Intl.DateTimeFormat('en', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
          }).formatToParts(d)

          const y = parts.find(p => p.type === 'year')?.value
          const m = parts.find(p => p.type === 'month')?.value
          const day = parts.find(p => p.type === 'day')?.value
          if (y && m && day) return `${y}-${m}-${day}`
        } catch (_) {}
      }

      const dt = new Date(d)
      dt.setHours(0, 0, 0, 0)
      const y = dt.getFullYear()
      const m = String(dt.getMonth() + 1).padStart(2, '0')
      const day = String(dt.getDate()).padStart(2, '0')
      return `${y}-${m}-${day}`
    }

    const base = new Date()
    base.setHours(12, 0, 0, 0)

    const weeklyLoginDates = [...Array(7)].map((_, i) => {
      const d = new Date(base)
      d.setDate(base.getDate() - (6 - i))
      return dateKeyForStats(d)
    })

    const keys = weeklyLoginDates.map(d => `daily_login_users:${d}`)

    let weeklyLogins = keys.map(() => 0)
    let weeklyUniqueUsers = 0

    let dailyLoginToday = 0

    try {

      const rows = await prisma.appSetting.findMany({ where: { setting_key: { in: keys } }, select: { setting_key: true, setting_value: true } })

      const map = new Map(rows.map(r => [r.setting_key, r.setting_value]))

      const weeklyUserSet = new Set()

      weeklyLogins = keys.map(k => {

        const raw = map.get(k)

        if (!raw) return 0

        try {

          const arr = JSON.parse(raw)

          if (!Array.isArray(arr)) return 0

          for (const id of arr) {
            const n = Number(id)
            if (!Number.isNaN(n)) weeklyUserSet.add(n)
          }

          return arr.length

        } catch {

          return 0

        }

      })

      weeklyUniqueUsers = weeklyUserSet.size

      dailyLoginToday = weeklyLogins[weeklyLogins.length - 1] || 0

    } catch (e) {

      console.error('admin.getStats: failed to load weekly login stats', e)

    }



    const recentPublic = recent.map(publicUser)

    res.json({ remark: 'admin_stats', status: 'success', data: { totalUsers, activeUsers, blockedUsers, totalBalance, recent: recentPublic, dailyLoginToday, weeklyLogins, weeklyLoginDates, weeklyUniqueUsers } })

  } catch (e) {

    console.error('admin.getStats error', e)

    res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to fetch admin stats'], data: null })

  }

}



async function listUsers(req, res) {

  try {

    const page = parseInt(req.query.page || '1', 10)

    const perPage = Math.min(parseInt(req.query.perPage || '20', 10), 100)

    const q = String(req.query.q || '').trim()

    // A purged account keeps its row for the ledger's sake, but it has no name,
    // email or phone left - it would list as an empty line nobody can act on.
    const where = { status: { not: DELETED } }

    if (q) {

      where.OR = [

        { email_idx: blindIndex(q, 'email') },

        { mobile_idx: blindIndex(q, 'mobile') },

        { username_idx: blindIndex(q, 'username') }

      ]

    }

    const total = await prisma.user.count({ where })

    const items = await prisma.user.findMany({

      where,

      orderBy: { created_at: 'desc' },

      skip: (page - 1) * perPage,

      take: perPage,

      select: {

        id: true,

        firstname_enc: true,

        lastname_enc: true,

        username_enc: true,

        email_enc: true,

        mobile_enc: true,

        country_code: true,

        role: true,

        image: true,

        status: true,

        created_at: true

      }

    })

    const itemsPublic = items.map(publicUser)

    res.json({ remark: 'admin_users', status: 'success', data: { items: itemsPublic, pagination: { page, perPage, total, totalPages: Math.ceil(total / perPage) } } })

  } catch (e) {

    res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to list users'], data: null })

  }

}



async function updateUserStatus(req, res) {

  try {

    const id = parseInt(req.params.id, 10)

    const status = Number(req.body.status)

    if (!(status === 0 || status === 1)) {

      return res.status(400).json({ remark: 'bad_request', status: 'error', message: ['Invalid status'], data: null })

    }

    const user = await prisma.user.update({ where: { id }, data: { status } })

    // Blocking must take effect on the next request, not after the cache TTL.
    await invalidateUser(id)

    res.json({ remark: 'user_status_updated', status: 'success', data: { id: user.id, status: user.status } })

  } catch (e) {

    res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to update user status'], data: null })

  }

}



async function resetUserPin(req, res) {

  try {

    const id = parseInt(req.params.id, 10)

    const incoming = typeof req.body.pin === 'string' ? req.body.pin : (req.body.pin == null ? '' : String(req.body.pin))

    const rawPin = incoming.trim() || '0000'

    const hashed = await hashSecret(rawPin, 'pin')

    const user = await prisma.user.update({ where: { id }, data: { pin: hashed } })

    await invalidateUser(id)

    res.json({ remark: 'user_pin_reset', status: 'success', data: { id: user.id } })

  } catch (e) {

    res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to reset user PIN'], data: null })

  }

}



module.exports = { getStats, listUsers, updateUserStatus, resetUserPin }



async function getUser(req, res) {

  try {

    const id = parseInt(req.params.id, 10)

    const user = await prisma.user.findUnique({

      where: { id },

      select: {

        id: true,

        firstname_enc: true,

        lastname_enc: true,

        username_enc: true,

        email_enc: true,

        mobile_enc: true,

        country_code: true,

        balance: true,

        currency_symbol: true,

        profile_complete: true,

        status: true,

        role: true,

        ev: true,

        sv: true,

        tv: true,

        kv: true,

        image: true,

        address: true,

        state: true,

        city: true,

        zip: true,

        address_enc: true,

        state_enc: true,

        city_enc: true,

        zip_enc: true,

        created_at: true,

        updated_at: true

      }

    })

    if (!user) return res.status(404).json({ remark: 'not_found', status: 'error', message: ['User not found'], data: null })

    const country = await prisma.country.findUnique({ where: { code: user.country_code }, select: { name: true, dial_code: true, image_src: true } })

    res.json({ remark: 'admin_user', status: 'success', data: { user: publicUser(user), country } })

  } catch (e) {

    res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to fetch user'], data: null })

  }

}



module.exports.getUser = getUser



async function updateUserRole(req, res) {

  try {

    const id = parseInt(req.params.id, 10)

    const role = String(req.body.role || '').toLowerCase()

    const allowed = ['customer', 'admin', 'developer']

    if (!allowed.includes(role)) {

      return res.status(400).json({ remark: 'bad_request', status: 'error', message: ['Invalid role'], data: null })

    }

    const user = await prisma.user.update({ where: { id }, data: { role } })

    await invalidateUser(id)

    res.json({ remark: 'user_role_updated', status: 'success', data: { id: user.id, role: user.role } })

  } catch (e) {

    res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to update user role'], data: null })

  }

}



module.exports.updateUserRole = updateUserRole



async function deleteUser(req, res) {

  try {

    const id = parseInt(req.params.id, 10)

    if (!id || Number.isNaN(id)) {

      return res.status(400).json({ remark: 'bad_request', status: 'error', message: ['Invalid user id'], data: null })

    }



    const existing = await prisma.user.findUnique({ where: { id }, select: { id: true, status: true, image: true, email: true, email_enc: true } })

    if (!existing) {

      return res.status(404).json({ remark: 'not_found', status: 'error', message: ['User not found'], data: null })

    }



    // Anonymise, never drop. This used to walk every foreign key back to
    // users and DELETE, which took the wallet ledger with it - the record a
    // chargeback, a CBN report or the user's own dispute is answered from.
    // Same eraser the 30-day self-service purge uses, so "deleted" means one
    // thing in this system: the person is gone, the money trail is not.
    if (Number(existing.status) === DELETED) {

      return res.json({ remark: 'user_deleted', status: 'success', message: ['User is already deleted'], data: { id, already_deleted: true } })

    }

    // The whole stage-one teardown, not just the column wipe: the profile image
    // at the upload provider, the StaffPay virtual accounts (still live and
    // still able to take a transfer until they are closed), the cache, and the
    // notice to the address on file. An account closed by an admin gets the
    // same treatment as one closed by its owner - there is no second, quieter
    // kind of deletion.
    await purgeUser(existing)



    // The DELETE itself is already recorded by adminAudit.middleware, and
    // purgeUser writes its own account.purged row.

    res.json({ remark: 'user_deleted', status: 'success', message: ['User deleted'], data: { id, anonymised: true } })

  } catch (e) {

    console.error('admin.deleteUser error', e)

    const msg = process.env.NODE_ENV === 'production' ? 'Failed to delete user' : `Failed to delete user: ${e?.message || String(e)}`

    res.status(500).json({ remark: 'error', status: 'error', message: [msg], data: null })

  }

}



module.exports.deleteUser = deleteUser



async function bulkUpdateUserStatus(req, res) {

  try {

    const status = Number(req.body.status)

    if (!(status === 0 || status === 1)) {

      return res.status(400).json({ remark: 'bad_request', status: 'error', message: ['Invalid status'], data: null })

    }

    // No per-id invalidation here: updateMany returns a count, not ids. The
    // cached rows expire on their own within USER_CACHE_TTL_SECONDS.
    const result = await prisma.user.updateMany({ where: { role: { in: ['customer'] } }, data: { status } })

    res.json({ remark: 'bulk_user_status_updated', status: 'success', data: { updated: result.count, status } })

  } catch (e) {

    res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to bulk update user status'], data: null })

  }

}



module.exports.bulkUpdateUserStatus = bulkUpdateUserStatus



// The trail written by adminAudit.middleware. Read-only, and it holds no PII -
// target_id is a row id, so this needs no publicUser-style mapper.
async function listAuditLogs(req, res) {

  try {

    // Default view is the human trail. The `security` and `alert` rows share
    // this table but have their own screen, and they out-number admin actions
    // by orders of magnitude during an incident - which is exactly when
    // somebody opens this page looking for who changed what.
    const data = await listAdminActions({
      page: req.query.page,
      perPage: req.query.perPage,
      targetType: req.query.targetType,
      targetId: req.query.targetId,
      action: req.query.action,
      actor: req.query.actor,
      from: req.query.from,
      to: req.query.to,
      excludeTargetTypes: ['security', 'alert'],
    })

    res.json({ remark: 'admin_audit_logs', status: 'success', data })

  } catch (e) {

    console.error('admin.listAuditLogs error', e)

    res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to list audit logs'], data: null })

  }

}



module.exports.listAuditLogs = listAuditLogs



// One user's own trail: logins, transfers, bill payments, with the IP and
// device each came from. This is what a dispute is answered with.
async function listUserActivity(req, res) {

  try {

    const data = await listUserEvents({
      userId: req.params.id,
      page: req.query.page,
      perPage: req.query.perPage,
      event: req.query.event,
    })

    res.json({ remark: 'user_activity', status: 'success', data })

  } catch (e) {

    console.error('admin.listUserActivity error', e)

    res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to list user activity'], data: null })

  }

}



module.exports.listUserActivity = listUserActivity



// Kill switch. GET renders the toggles, PATCH throws one.
async function getFeatureFlags(req, res) {

  try {

    const features = await listFeatures()

    res.json({ remark: 'feature_flags', status: 'success', data: { features } })

  } catch (e) {

    console.error('admin.getFeatureFlags error', e)

    res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to load feature flags'], data: null })

  }

}



async function updateFeatureFlag(req, res) {

  try {

    const slug = String(req.params.slug || '').trim()

    const raw = req.body?.enabled

    if (raw === undefined || raw === null) {

      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['`enabled` is required'], data: null })

    }

    const enabled = raw === true || raw === 1 || String(raw).toLowerCase() === 'true' || String(raw) === '1'

    const result = await setFeature(slug, enabled)

    res.json({ remark: 'feature_flag_updated', status: 'success', message: [`${slug} is now ${enabled ? 'on' : 'off'}`], data: result })

  } catch (e) {

    if (e?.code === 'UNKNOWN_FEATURE') {

      return res.status(400).json({ remark: 'validation_error', status: 'error', message: [e.message], data: null })

    }

    console.error('admin.updateFeatureFlag error', e)

    res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to update feature flag'], data: null })

  }

}



module.exports.getFeatureFlags = getFeatureFlags

module.exports.updateFeatureFlag = updateFeatureFlag

