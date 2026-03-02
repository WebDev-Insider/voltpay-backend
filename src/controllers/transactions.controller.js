const prisma = require('../../database/prisma');
const { listHistory, clearHistory } = require('../services/airtime.service');

function formatAmount(value) {
  const n = Number.parseFloat(String(value ?? 0));
  if (!Number.isFinite(n)) return '0';
  return String(Number.parseFloat(n.toFixed(2)));
}

function computeFundingFee(amountNaira) {
  const amt = Number(amountNaira);
  if (!Number.isFinite(amt) || amt <= 0) return 0;
  if (amt >= 100 && amt <= 1000) return 10;
  if (amt > 1000 && amt <= 20000) return 30;
  if (amt > 20000) return 50;
  return 0;
}

async function getTransactions(req, res) {
  try {
    const { page = 1 } = req.query;
    console.log('📥 Transactions request (controller):', req.query);

    const user = req.user;
    if (!user) {
      return res.status(401).json({
        remark: 'unauthorized',
        status: 'error',
        message: ['Please login first'],
        data: null,
      });
    }

    const perPage = 15;
    const pageNum = Math.max(1, Number(page) || 1);
    const skip = (pageNum - 1) * perPage;

    // Filters from app (optional)
    const type = String(req.query?.type || '').toLowerCase(); // plus/minus
    const remark = String(req.query?.remark || '').trim();
    const search = String(req.query?.search || '').trim();

    let walletRows = [];
    try {
      if (prisma.walletTransaction) {
        walletRows = await prisma.walletTransaction.findMany({
          where: {
            user_id: Number(user.id),
            ...(remark ? { remark: String(remark).trim() } : {}),
            ...(search ? { trx: { contains: search, mode: 'insensitive' } } : {}),
            ...(type === 'plus' ? { trx_type: '+' } : (type === 'minus' ? { trx_type: '-' } : {})),
          },
          orderBy: { id: 'desc' },
        });
      }
    } catch (_) {
      walletRows = [];
    }

    // Legacy: persisted funding transactions
    const whereFunding = { user_id: Number(user.id) };
    const fundingRows = await prisma.fundingTransaction.findMany({
      where: search ? { ...whereFunding, tx_ref: { contains: search, mode: 'insensitive' } } : whereFunding,
      orderBy: { id: 'desc' },
    });

    // Legacy: in-memory airtime/data history
    const airtimeRows = Array.isArray(listHistory(user.id)) ? listHistory(user.id) : [];

    // Map to unified transaction model
    const fundingMapped = fundingRows.map(r => {
      const gross = Number(r.amount?.toString?.() ?? r.amount);
      const fee = computeFundingFee(gross);
      const net = Math.max(0, (Number.isFinite(gross) ? gross : 0) - fee);

      const amountStr = formatAmount(net);
      const feeStr = formatAmount(fee);
      const paidStr = formatAmount(gross);
      const status = String(r.status || '').toLowerCase();
      const statusLabel = status === 'successful' || status === 'success' ? 'Successful' : status ? status : 'Pending';
      return {
        id: r.id,
        trx: String(r.tx_ref),
        trx_type: '+',
        amount: amountStr,
        charge: feeStr,
        total_amount: paidStr,
        remark: 'fund_account',
        other_data: {
          title: 'Transfer to Wallet',
          subtitle: 'Wallet Funding',
          feedback: statusLabel,
          note: '',
          image_src: '',
        },
        details: 'Wallet funding',
        created_at: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
        created_at_diff: '',
      };
    });

    const walletMapped = (Array.isArray(walletRows) ? walletRows : []).map(r => {
      const createdIso = r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString();
      return {
        id: r.id,
        trx: String(r.trx),
        trx_type: String(r.trx_type),
        amount: formatAmount(r.amount),
        charge: formatAmount(r.charge),
        total_amount: formatAmount(r.total_amount),
        remark: String(r.remark),
        other_data: r.other_data || {},
        meta: r.meta || {},
        details: r.details || '',
        created_at: createdIso,
        created_at_diff: '',
      };
    });

    const airtimeMapped = airtimeRows.map((a) => {
      const isElectricity = String(a.remark || '').toLowerCase() === 'electricity';
      const amountStr = formatAmount(Number(a.amount));
      const createdIso = a.created_at ? new Date(a.created_at).toISOString() : new Date().toISOString();
      const msisdn = `${a.dial_code || ''}${a.mobile_number || ''}`;
      const isData = String(a.remark || '').toLowerCase() === 'data';
      const remarkVal = isElectricity ? 'utility_bill' : 'mobile_recharge';
      const title = isElectricity ? 'Electricity' : (isData ? 'Data' : 'Airtime');
      const detailsFallback = isElectricity ? 'Electricity purchase' : (isData ? `Data to ${msisdn}` : `Airtime to ${msisdn}`);
      const subtitleOp = isElectricity
        ? (a.details || 'Utility Bill')
        : (a.operator?.name ? `${a.operator.name} ${msisdn}` : `${title} ${msisdn}`);
      return {
        id: a.id,
        trx: String(a.trx),
        trx_type: '-',
        amount: amountStr,
        charge: '0.00',
        total_amount: amountStr,
        remark: remarkVal,
        other_data: {
          title,
          subtitle: subtitleOp,
          feedback: 'Successful',
          note: '',
          image_src: '',
        },
        details: a.details || detailsFallback,
        created_at: createdIso,
        created_at_diff: '',
      };
    });

    // Combine (prefer walletMapped then fallback sources)
    let combined = [...walletMapped, ...fundingMapped, ...airtimeMapped];

    // De-duplicate by trx (prefer first occurrence)
    const seenTrx = new Set();
    combined = combined.filter(x => {
      const key = String(x.trx || '');
      if (!key) return true;
      if (seenTrx.has(key)) return false;
      seenTrx.add(key);
      return true;
    });

    // Apply remark filter if provided
    if (remark) {
      const rmk = remark.toLowerCase();
      combined = combined.filter(x => String(x.remark || '').toLowerCase() === rmk);
    }

    // Apply type filter if provided
    if (type) {
      if (type === 'plus') combined = combined.filter(x => x.trx_type === '+');
      else if (type === 'minus') combined = combined.filter(x => x.trx_type === '-');
    }

    // Apply search on trx if provided
    if (search) {
      const s = search.toLowerCase();
      combined = combined.filter(x => String(x.trx || '').toLowerCase().includes(s));
    }

    // Sort by created_at desc
    combined.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const total = combined.length;
    const lastPage = Math.max(1, Math.ceil(total / perPage));
    const hasNext = pageNum < lastPage;
    const pageData = combined.slice(skip, skip + perPage);

    const remarkSet = new Set(combined.map(x => String(x.remark || '')).filter(Boolean));
    const response = {
      remark: 'transactions',
      status: 'success',
      message: ['Transactions fetched successfully'],
      data: {
        transactions: {
          current_page: pageNum,
          data: pageData,
          first_page_url: `/api/transactions?page=1`,
          last_page: lastPage,
          last_page_url: `/api/transactions?page=${lastPage}`,
          next_page_url: hasNext ? `/api/transactions?page=${pageNum + 1}` : null,
          path: '/api/transactions',
          per_page: perPage,
          total
        },
        remarks: Array.from(remarkSet).sort().map(r => ({ remark: r }))
      }
    };

    return res.json(response);
  } catch (error) {
    console.error('Error fetching transactions (controller):', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to fetch transactions'],
      data: null
    });
  }
}

async function clearTransactions(req, res) {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({
        remark: 'unauthorized',
        status: 'error',
        message: ['Please login first'],
        data: null,
      });
    }

    const userId = Number(user.id);

    let walletDeleted = 0;
    let fundingDeleted = 0;

    try {
      if (prisma.walletTransaction) {
        const r = await prisma.walletTransaction.deleteMany({ where: { user_id: userId } });
        walletDeleted = Number(r?.count || 0);
      }
    } catch (_) {}

    try {
      if (prisma.fundingTransaction) {
        const r = await prisma.fundingTransaction.deleteMany({ where: { user_id: userId } });
        fundingDeleted = Number(r?.count || 0);
      }
    } catch (_) {}

    try {
      clearHistory(userId);
    } catch (_) {}

    return res.json({
      remark: 'transactions_cleared',
      status: 'success',
      message: ['Transaction history cleared'],
      data: {
        wallet_deleted: walletDeleted,
        funding_deleted: fundingDeleted,
      },
    });
  } catch (error) {
    console.error('Error clearing transactions (controller):', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to clear transactions'],
      data: null,
    });
  }
}

module.exports = { getTransactions, clearTransactions };
