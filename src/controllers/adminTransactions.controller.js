const prisma = require('../../database/prisma')

function formatAmount(value) {
  const n = Number.parseFloat(String(value ?? 0))
  if (!Number.isFinite(n)) return '0'
  return String(Number.parseFloat(n.toFixed(2)))
}

function computeFundingFee(amountNaira) {
  const amt = Number(amountNaira)
  if (!Number.isFinite(amt) || amt <= 0) return 0
  if (amt >= 100 && amt <= 1000) return 10
  if (amt > 1000 && amt <= 20000) return 30
  if (amt > 20000) return 50
  return 0
}

function toIso(d) {
  try {
    if (!d) return new Date().toISOString()
    return d instanceof Date ? d.toISOString() : new Date(d).toISOString()
  } catch {
    return new Date().toISOString()
  }
}

async function listTransactions(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page || 1))
    const perPage = Math.min(Math.max(1, Number(req.query.perPage || 20)), 100)
    const skip = (page - 1) * perPage

    const q = String(req.query.q || '').trim().toLowerCase()
    const type = String(req.query.type || '').trim().toLowerCase() // plus|minus
    const remark = String(req.query.remark || '').trim().toLowerCase()
    const status = String(req.query.status || '').trim().toLowerCase()
    const userId = Number(req.query.userId) || null

    let walletRows = []
    try {
      if (prisma.walletTransaction) {
        walletRows = await prisma.walletTransaction.findMany({
          where: {
            ...(userId ? { user_id: Number(userId) } : {}),
            ...(remark ? { remark: { equals: remark, mode: 'insensitive' } } : {}),
            ...(type === 'plus' ? { trx_type: '+' } : (type === 'minus' ? { trx_type: '-' } : {})),
          },
          orderBy: { id: 'desc' },
          take: 1000,
        })
      }
    } catch (_) {
      walletRows = []
    }

    const fundingRows = await prisma.fundingTransaction.findMany({
      where: {
        ...(userId ? { user_id: Number(userId) } : {}),
        ...(status ? { status: { equals: status, mode: 'insensitive' } } : {}),
      },
      orderBy: { id: 'desc' },
      take: 1000,
    })

    const userIds = new Set()

    const walletMapped = (Array.isArray(walletRows) ? walletRows : []).map(r => {
      if (r?.user_id) userIds.add(Number(r.user_id))
      return {
        id: r.id,
        user_id: Number(r.user_id),
        ref: String(r.trx),
        source: 'wallet',
        trx_type: String(r.trx_type),
        amount: formatAmount(r.amount),
        charge: formatAmount(r.charge),
        total_amount: formatAmount(r.total_amount),
        remark: String(r.remark || ''),
        status: '',
        other_data: r.other_data || {},
        meta: r.meta || {},
        details: r.details || '',
        created_at: toIso(r.created_at),
      }
    })

    const fundingMapped = (Array.isArray(fundingRows) ? fundingRows : []).map(r => {
      if (r?.user_id) userIds.add(Number(r.user_id))
      const gross = Number(r.amount?.toString?.() ?? r.amount)
      const fee = computeFundingFee(gross)
      const net = Math.max(0, (Number.isFinite(gross) ? gross : 0) - fee)
      const s = String(r.status || '').toLowerCase()
      const statusLabel = s === 'successful' || s === 'success' ? 'successful' : (s || 'pending')
      return {
        id: r.id,
        user_id: Number(r.user_id),
        ref: String(r.tx_ref),
        source: 'funding',
        trx_type: '+',
        amount: formatAmount(net),
        charge: formatAmount(fee),
        total_amount: formatAmount(gross),
        remark: 'fund_account',
        status: statusLabel,
        other_data: {
          title: 'Transfer to Wallet',
          subtitle: 'Wallet Funding',
        },
        meta: {},
        details: 'Wallet funding',
        created_at: toIso(r.created_at),
      }
    })

    let combined = [...walletMapped, ...fundingMapped]

    if (q) {
      const s = q
      combined = combined.filter(x =>
        String(x.ref || '').toLowerCase().includes(s) ||
        String(x.remark || '').toLowerCase().includes(s)
      )
    }

    if (remark) {
      const rmk = remark
      combined = combined.filter(x => String(x.remark || '').toLowerCase() === rmk)
    }

    if (type) {
      if (type === 'plus') combined = combined.filter(x => x.trx_type === '+')
      else if (type === 'minus') combined = combined.filter(x => x.trx_type === '-')
    }

    if (status) {
      combined = combined.filter(x => String(x.status || '').toLowerCase() === status)
    }

    combined.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    const total = combined.length
    const pageData = combined.slice(skip, skip + perPage)

    let usersById = new Map()
    if (userIds.size) {
      const users = await prisma.user.findMany({
        where: { id: { in: Array.from(userIds) } },
        select: { id: true, firstname: true, lastname: true, username: true, email: true, mobile: true, image: true }
      })
      usersById = new Map(users.map(u => [Number(u.id), u]))
    }

    const data = pageData.map(t => ({
      ...t,
      user: usersById.get(Number(t.user_id)) || null,
    }))

    return res.json({
      remark: 'admin_transactions',
      status: 'success',
      data: {
        transactions: {
          current_page: page,
          data,
          first_page_url: `/api/admin/transactions?page=1`,
          last_page: Math.max(1, Math.ceil(total / perPage)),
          next_page_url: page * perPage < total ? `/api/admin/transactions?page=${page + 1}` : null,
          path: '/api/admin/transactions',
          per_page: perPage,
          total,
        }
      }
    })
  } catch (e) {
    console.error('admin.listTransactions error', e)
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to fetch transactions'], data: null })
  }
}

async function getTransactionDetail(req, res) {
  try {
    const ref = String(req.params.ref || '').trim()
    if (!ref) return res.status(400).json({ remark: 'bad_request', status: 'error', message: ['ref is required'], data: null })

    let tx = null
    let source = null

    if (prisma.walletTransaction) {
      const w = await prisma.walletTransaction.findUnique({ where: { trx: ref } })
      if (w) {
        tx = {
          id: w.id,
          user_id: Number(w.user_id),
          ref: String(w.trx),
          source: 'wallet',
          trx_type: String(w.trx_type),
          amount: formatAmount(w.amount),
          charge: formatAmount(w.charge),
          total_amount: formatAmount(w.total_amount),
          remark: String(w.remark || ''),
          status: '',
          other_data: w.other_data || {},
          meta: w.meta || {},
          details: w.details || '',
          created_at: toIso(w.created_at),
        }
        source = 'wallet'
      }
    }

    if (!tx) {
      const f = await prisma.fundingTransaction.findUnique({ where: { tx_ref: ref } })
      if (f) {
        const gross = Number(f.amount?.toString?.() ?? f.amount)
        const fee = computeFundingFee(gross)
        const net = Math.max(0, (Number.isFinite(gross) ? gross : 0) - fee)
        tx = {
          id: f.id,
          user_id: Number(f.user_id),
          ref: String(f.tx_ref),
          source: 'funding',
          trx_type: '+',
          amount: formatAmount(net),
          charge: formatAmount(fee),
          total_amount: formatAmount(gross),
          remark: 'fund_account',
          status: String(f.status || ''),
          other_data: {},
          meta: {},
          details: 'Wallet funding',
          created_at: toIso(f.created_at),
          raw_payload: f.raw_payload || null,
        }
        source = 'funding'
      }
    }

    if (!tx) return res.status(404).json({ remark: 'not_found', status: 'error', message: ['Transaction not found'], data: null })

    const user = await prisma.user.findUnique({ where: { id: Number(tx.user_id) }, select: { id: true, firstname: true, lastname: true, username: true, email: true, mobile: true, image: true } })

    return res.json({ remark: 'admin_transaction', status: 'success', data: { transaction: tx, user, source } })
  } catch (e) {
    console.error('admin.getTransactionDetail error', e)
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to fetch transaction'], data: null })
  }
}

async function markResolved(req, res) {
  try {
    const ref = String(req.params.ref || '').trim()
    if (!ref) return res.status(400).json({ remark: 'bad_request', status: 'error', message: ['ref is required'], data: null })

    let updated = null
    if (prisma.walletTransaction) {
      const w = await prisma.walletTransaction.findUnique({ where: { trx: ref } })
      if (w) {
        const meta = Object.assign({}, w.meta || {}, { resolved_by_admin: true, resolved_at: new Date().toISOString() })
        const row = await prisma.walletTransaction.update({ where: { id: w.id }, data: { meta } })
        updated = { kind: 'wallet', id: row.id }
      }
    }

    if (!updated) {
      const f = await prisma.fundingTransaction.findUnique({ where: { tx_ref: ref } })
      if (f) {
        const newStatus = String(f.status || '').toLowerCase() === 'successful' ? 'successful' : 'resolved'
        const row = await prisma.fundingTransaction.update({ where: { id: f.id }, data: { status: newStatus } })
        updated = { kind: 'funding', id: row.id }
      }
    }

    if (!updated) return res.status(404).json({ remark: 'not_found', status: 'error', message: ['Transaction not found'], data: null })

    return res.json({ remark: 'transaction_resolved', status: 'success', data: updated })
  } catch (e) {
    console.error('admin.markResolved error', e)
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to resolve transaction'], data: null })
  }
}

module.exports = { listTransactions, getTransactionDetail, markResolved }
