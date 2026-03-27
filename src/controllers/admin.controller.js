const prisma = require('../../database/prisma')

const bcrypt = require('bcryptjs')



async function getStats(req, res) {

  try {

    const totalUsers = await prisma.user.count()

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

      orderBy: { created_at: 'desc' },

      take: 5,

      select: { id: true, firstname: true, lastname: true, username: true, email: true, mobile: true, status: true, created_at: true, image: true, role: true }

    })

    const today = new Date()

    today.setHours(0, 0, 0, 0)

    const keyFor = d => {

      const y = d.getFullYear()

      const m = String(d.getMonth() + 1).padStart(2, '0')

      const day = String(d.getDate()).padStart(2, '0')

      return `daily_login_users:${y}-${m}-${day}`

    }

    const days = [...Array(7)].map((_, i) => {

      const d = new Date(today)

      d.setDate(today.getDate() - (6 - i))

      return d

    })

    const keys = days.map(keyFor)

    let weeklyLogins = keys.map(() => 0)

    let dailyLoginToday = 0

    try {

      const rows = await prisma.appSetting.findMany({ where: { setting_key: { in: keys } }, select: { setting_key: true, setting_value: true } })

      const map = new Map(rows.map(r => [r.setting_key, r.setting_value]))

      weeklyLogins = keys.map(k => {

        const raw = map.get(k)

        if (!raw) return 0

        try {

          const arr = JSON.parse(raw)

          return Array.isArray(arr) ? arr.length : 0

        } catch {

          return 0

        }

      })

      dailyLoginToday = weeklyLogins[weeklyLogins.length - 1] || 0

    } catch (e) {

      console.error('admin.getStats: failed to load weekly login stats', e)

    }



    res.json({ remark: 'admin_stats', status: 'success', data: { totalUsers, activeUsers, blockedUsers, totalBalance, recent, dailyLoginToday, weeklyLogins } })

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

    const where = q

      ? {

          OR: [

            { email: { contains: q, mode: 'insensitive' } },

            { mobile: { contains: q, mode: 'insensitive' } },

            { firstname: { contains: q, mode: 'insensitive' } },

            { lastname: { contains: q, mode: 'insensitive' } },

            { username: { contains: q, mode: 'insensitive' } }

          ]

        }

      : {}

    const total = await prisma.user.count({ where })

    const items = await prisma.user.findMany({

      where,

      orderBy: { created_at: 'desc' },

      skip: (page - 1) * perPage,

      take: perPage,

      select: {

        id: true,

        firstname: true,

        lastname: true,

        username: true,

        email: true,

        mobile: true,

        country_code: true,

        role: true,

        image: true,

        status: true,

        created_at: true

      }

    })

    res.json({ remark: 'admin_users', status: 'success', data: { items, pagination: { page, perPage, total, totalPages: Math.ceil(total / perPage) } } })

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

    const hashed = await bcrypt.hash(rawPin, 10)

    const user = await prisma.user.update({ where: { id }, data: { pin: hashed } })

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

        firstname: true,

        lastname: true,

        username: true,

        email: true,

        mobile: true,

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

        created_at: true,

        updated_at: true

      }

    })

    if (!user) return res.status(404).json({ remark: 'not_found', status: 'error', message: ['User not found'], data: null })

    const country = await prisma.country.findUnique({ where: { code: user.country_code }, select: { name: true, dial_code: true, image_src: true } })

    res.json({ remark: 'admin_user', status: 'success', data: { user, country } })

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



    const existing = await prisma.user.findUnique({ where: { id }, select: { id: true } })

    if (!existing) {

      return res.status(404).json({ remark: 'not_found', status: 'error', message: ['User not found'], data: null })

    }



    const deleteWithClient = async db => {

      const deletedVerificationCodes = await db.verificationCode.deleteMany({ where: { user_id: id } })

      const deletedPasswordResets = await db.passwordReset.deleteMany({ where: { user_id: id } })

      const deletedWalletTransactions = await db.walletTransaction.deleteMany({ where: { user_id: id } })

      const deletedFundingTransactions = await db.fundingTransaction.deleteMany({ where: { user_id: id } })



      const deletedMonthlyStatements = db.monthlyStatement?.deleteMany

        ? await db.monthlyStatement.deleteMany({ where: { user_id: id } })

        : { count: 0 }



      const deletedPushNotifications = db.pushNotification?.deleteMany

        ? await db.pushNotification.deleteMany({ where: { user_id: id } })

        : { count: 0 }



      if (db.appSetting?.findMany && db.appSetting?.update) {

        try {

          const loginRows = await db.appSetting.findMany({

            where: { setting_key: { startsWith: 'daily_login_users:' } },

            select: { id: true, setting_value: true },

          })



          for (const row of loginRows) {

            try {

              const raw = row.setting_value

              if (!raw) continue

              const parsed = JSON.parse(raw)

              if (!Array.isArray(parsed)) continue

              const filtered = parsed.filter(x => Number(x) !== id)

              if (filtered.length !== parsed.length) {

                await db.appSetting.update({

                  where: { id: row.id },

                  data: { setting_value: JSON.stringify(filtered) },

                })

              }

            } catch (_) {}

          }

        } catch (_) {}

      }



      if (db.$queryRaw && db.$executeRawUnsafe) {

        try {

          const rows = await db.$queryRaw`

            SELECT conrelid::regclass::text AS table_name,

                   a.attname AS column_name

            FROM pg_constraint c

            JOIN pg_attribute a ON a.attnum = ANY(c.conkey) AND a.attrelid = c.conrelid

            WHERE c.contype = 'f'

              AND c.confrelid = 'users'::regclass

          `



          const qIdent = s => `"${String(s).replace(/"/g, '""')}"`

          const isSafeIdent = s => /^[a-zA-Z0-9_]+$/.test(String(s))

          const isSafeTable = s => /^[a-zA-Z0-9_\.]+$/.test(String(s))



          for (const r of rows || []) {

            const tableName = String(r.table_name || '')

            const colName = String(r.column_name || '')

            if (!tableName || !colName) continue

            if (!isSafeTable(tableName) || !isSafeIdent(colName)) continue



            const parts = tableName.split('.')

            const target = parts.length === 2 && isSafeIdent(parts[0]) && isSafeIdent(parts[1])

              ? `${qIdent(parts[0])}.${qIdent(parts[1])}`

              : (parts.length === 1 && isSafeIdent(parts[0]) ? qIdent(parts[0]) : '')

            if (!target) continue



            await db.$executeRawUnsafe(`DELETE FROM ${target} WHERE ${qIdent(colName)} = $1`, id)

          }

        } catch (_) {}

      }



      const deletedUser = await db.user.delete({ where: { id }, select: { id: true } })

      return {

        deletedUser,

        deletedVerificationCodes,

        deletedPasswordResets,

        deletedWalletTransactions,

        deletedFundingTransactions,

        deletedMonthlyStatements,

        deletedPushNotifications,

      }

    }



    let result

    try {

      result = await prisma.$transaction(async tx => {

        return await deleteWithClient(tx)

      })

    } catch (e) {

      console.error('admin.deleteUser transaction failed, retrying without transaction', e)

      result = await deleteWithClient(prisma)

    }



    res.json({ remark: 'user_deleted', status: 'success', data: result })

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

    const result = await prisma.user.updateMany({ where: { role: { in: ['customer'] } }, data: { status } })

    res.json({ remark: 'bulk_user_status_updated', status: 'success', data: { updated: result.count, status } })

  } catch (e) {

    res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to bulk update user status'], data: null })

  }

}



module.exports.bulkUpdateUserStatus = bulkUpdateUserStatus

