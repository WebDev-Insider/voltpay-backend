const prisma = require('../../database/prisma');
const { setPending } = require('../services/pending.service');
const { listBettingCompaniesV2, verifyBettingCustomerV1, queryTransactionV1, cancelTransactionV1 } = require('../funding/clubkonnect.service');

const companiesCache = new Map();
const verifyCache = new Map();

function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (hit.expires && hit.expires > Date.now()) return hit.value;
  map.delete(key);
  return null;
}

function cacheSet(map, key, value, ttlMs) {
  map.set(key, { value, expires: Date.now() + Math.max(1_000, Number(ttlMs) || 0) });
}

function moneyStr(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0.00';
  return num.toFixed(2);
}

function normalizeCompanies(raw) {
  const out = [];

  const pickArr = v => (Array.isArray(v) ? v : []);
  const pickArrOrMap = v => {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      return Object.entries(v).map(([code, name]) => ({ code, name }));
    }
    return [];
  };

  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (raw && typeof raw === 'object') {
    arr = pickArrOrMap(raw.BETTING_COMPANIES)
      .concat(pickArrOrMap(raw.betting_companies))
      .concat(pickArrOrMap(raw.BETTING_COMPANY))
      .concat(pickArrOrMap(raw.betting_company));

    if (!arr.length) {
      for (const [k, v] of Object.entries(raw)) {
        if (k.toLowerCase().includes('bet')) {
          if (Array.isArray(v)) {
            arr = v;
            break;
          }
          if (v && typeof v === 'object') {
            arr = Object.entries(v).map(([code, name]) => ({ code, name }));
            break;
          }
        }
      }
    }
  }

  for (const row of arr) {
    if (!row) continue;
    const code = String(
      row.slug ??
        row.code ??
        row.betting_code ??
        row.BettingCompany ??
        row.BETTING_COMPANY ??
        row.ID ??
        row.id ??
        ''
    )
      .trim()
      .toUpperCase();

    const name = String(row.name ?? row.NAME ?? row.company_name ?? row.CompanyName ?? row.COMPANY_NAME ?? code)
      .trim();

    if (!code) continue;
    out.push({ code, name: name || code });
  }

  const map = new Map();
  for (const c of out) {
    if (!map.has(c.code)) map.set(c.code, c);
  }

  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function companies(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const cached = cacheGet(companiesCache, 'companies');
    const list = cached || normalizeCompanies(await listBettingCompaniesV2());

    if (!cached) cacheSet(companiesCache, 'companies', list, list.length ? 15 * 60_000 : 30_000);

    const balance = user?.balance?.toString ? Number(user.balance.toString()) : Number(user?.balance || 0);

    return res.json({
      remark: 'betting_companies',
      status: 'success',
      message: ['OK'],
      data: {
        companies: list,
        current_balance: moneyStr(balance),
      },
    });
  } catch (e) {
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed to load companies'], data: e?.clubkonnect || null });
  }
}

async function verifyCustomer(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const betting_company = String(req.body?.betting_company || req.body?.BettingCompany || '').trim().toUpperCase();
    const customer_id = String(req.body?.customer_id || req.body?.CustomerID || '').trim();

    if (!betting_company || !customer_id) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['betting_company and customer_id are required'], data: null });
    }

    const key = `${betting_company}|${customer_id}`;
    const cached = cacheGet(verifyCache, key);
    if (cached) {
      return res.json({ remark: 'verified', status: 'success', message: ['OK'], data: cached });
    }

    const resp = await verifyBettingCustomerV1({ bettingCompany: betting_company, customerId: customer_id });
    const customerName = String(resp?.customer_name || resp?.customerName || '').trim();

    if (!customerName || customerName.toLowerCase().startsWith('error')) {
      return res.status(400).json({ remark: 'invalid_customer', status: 'error', message: ['Invalid customer ID'], data: resp || null });
    }

    const data = { customer_name: customerName, betting_company, customer_id, raw: resp };
    cacheSet(verifyCache, key, data, 10 * 60_000);
    return res.json({ remark: 'verified', status: 'success', message: ['OK'], data });
  } catch (e) {
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed to verify customer'], data: e?.clubkonnect || null });
  }
}

async function store(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const betting_company = String(req.body?.betting_company || '').trim().toUpperCase();
    const customer_id = String(req.body?.customer_id || '').trim();
    const amount = Number(req.body?.amount);
    const remark = String(req.body?.remark || 'betting').trim();

    if (!betting_company || !customer_id || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid input'], data: null });
    }

    if (amount < 100) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Minimum betting amount is 100'], data: null });
    }

    const key = `${betting_company}|${customer_id}`;
    const cached = cacheGet(verifyCache, key);
    const customer_name = String(cached?.customer_name || '').trim();

    const payload = {
      betting_company,
      customer_id,
      customer_name: customer_name || null,
      amount: Number(amount),
    };

    setPending(user.id, remark, payload, { ttlMs: 5 * 60_000 });

    return res.json({ remark: 'pin', status: 'success', message: ['Proceed to PIN'], data: null });
  } catch (e) {
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function query(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const orderId = String(req.query?.order_id || req.query?.OrderID || '').trim();
    const requestId = String(req.query?.request_id || req.query?.RequestID || '').trim();

    if (!orderId && !requestId) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['order_id or request_id is required'], data: null });
    }

    const resp = await queryTransactionV1({ orderId: orderId || null, requestId: requestId || null });
    return res.json({ remark: 'betting_query', status: 'success', message: ['OK'], data: resp || null });
  } catch (e) {
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed to query transaction'], data: e?.clubkonnect || null });
  }
}

async function cancel(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const orderId = String(req.body?.order_id || req.body?.OrderID || '').trim();
    if (!orderId) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['order_id is required'], data: null });
    }

    const resp = await cancelTransactionV1({ orderId });
    return res.json({ remark: 'betting_cancel', status: 'success', message: ['OK'], data: resp || null });
  } catch (e) {
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed to cancel transaction'], data: e?.clubkonnect || null });
  }
}

async function callback(req, res) {
  try {
    const payload = (req.body && Object.keys(req.body).length) ? req.body : (req.query || {});

    const requestId = String(payload.requestid || payload.request_id || payload.RequestID || payload.requestId || '').trim();
    const orderId = String(payload.orderid || payload.order_id || payload.OrderID || payload.orderId || '').trim();

    const statusCode = String(payload.statuscode || payload.StatusCode || '').trim();
    const orderStatus = String(payload.orderstatus || payload.OrderStatus || payload.status || payload.OrderStatus || '').trim();
    const orderRemark = String(payload.orderremark || payload.OrderRemark || payload.remark || '').trim();

    if (!requestId && !orderId) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['requestid or orderid is required'], data: null });
    }

    if (requestId) {
      const txRow = await prisma.walletTransaction.findUnique({ where: { trx: requestId } });
      if (txRow) {
        const meta = (txRow.meta && typeof txRow.meta === 'object') ? txRow.meta : {};
        const other = (txRow.other_data && typeof txRow.other_data === 'object') ? txRow.other_data : {};

        const s = String(orderStatus || statusCode || '').toLowerCase();
        const ok = statusCode === '200' || s.includes('completed') || s.includes('success');
        const pending = statusCode === '100' || s.includes('received') || s.includes('hold') || s.includes('processing');

        const feedback = ok ? 'Successful' : (pending ? 'Processing' : 'Failed');

        await prisma.walletTransaction.update({
          where: { trx: requestId },
          data: {
            meta: {
              ...meta,
              ck_request_id: requestId,
              ck_order_id: orderId || String(meta.ck_order_id || ''),
              ck_statuscode: statusCode,
              ck_orderstatus: orderStatus,
              ck_orderremark: orderRemark,
              ck_callback: payload,
            },
            other_data: {
              ...other,
              feedback,
            },
          },
        });
      }
    }

    return res.json({ remark: 'ok', status: 'success', message: ['OK'], data: null });
  } catch (e) {
    console.error('betting.callback error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to process callback'], data: null });
  }
}

module.exports = { companies, verifyCustomer, store, query, cancel, callback };
