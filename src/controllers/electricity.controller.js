const prisma = require('../../database/prisma');
const { setPending } = require('../services/pending.service');
const { listElectricityDiscosV2, verifyElectricityMeterV1, queryTransactionV1 } = require('../funding/clubkonnect.service');

const meterVerifyCache = new Map();
const ngOperatorsCache = new Map();

function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (hit.expires && hit.expires > Date.now()) return hit.value;
  map.delete(key);
  return null;
}

async function status(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const trx = String(req.params?.trx || req.query?.trx || '').trim();
    if (!trx) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['trx is required'], data: null });
    }

    const txRow = await prisma.walletTransaction.findUnique({ where: { trx } });
    if (!txRow || Number(txRow.user_id) !== Number(user.id)) {
      return res.status(404).json({ remark: 'not_found', status: 'error', message: ['Transaction not found'], data: null });
    }

    if (String(txRow.remark || '').toLowerCase() !== 'utility_bill') {
      return res.status(400).json({ remark: 'invalid_transaction', status: 'error', message: ['Not an electricity/utility bill transaction'], data: null });
    }

    const meta = (txRow.meta && typeof txRow.meta === 'object') ? txRow.meta : {};
    const otherData = (txRow.other_data && typeof txRow.other_data === 'object') ? txRow.other_data : {};

    const requestId = String(meta.flw_tx_ref || meta.ck_request_id || trx).trim();
    const orderId = String(meta.flw_reference || meta.ck_order_id || '').trim();

    let statusResp;
    try {
      statusResp = await queryTransactionV1({ orderId: orderId || null, requestId: requestId || null });
    } catch (e) {
      return res.status(400).json({ remark: 'provider_error', status: 'error', message: [e?.message || 'Failed to fetch bill status'], data: null });
    }

    const statusCode = String(statusResp?.statuscode || '').trim();
    const orderStatus = String(statusResp?.orderstatus || statusResp?.status || '').trim();
    const orderRemark = String(statusResp?.orderremark || '').trim();
    const billStatus = orderStatus || statusCode;
    const billStatusLower = String(billStatus || '').toLowerCase();

    const token = String(statusResp?.metertoken || statusResp?.meter_token || meta.token || '').trim();

    const isPrepaid = String(meta.meter_type || '').trim().toLowerCase() !== 'postpaid';
    const isSuccessful = !!token || statusCode === '200' || billStatusLower.includes('completed') || billStatusLower.includes('success');
    const isFailed = !isSuccessful && (
      billStatusLower.includes('fail')
      || billStatusLower.includes('cancel')
      || billStatusLower.includes('revers')
      || billStatusLower.includes('refund')
      || statusCode === '400'
      || statusCode === '401'
      || statusCode === '402'
      || statusCode === '500'
    );

    let feedback = otherData.feedback ? String(otherData.feedback) : '';
    if (isSuccessful) {
      feedback = (isPrepaid && !token) ? 'Processing' : 'Successful';
    } else if (isFailed) {
      feedback = 'Reversed';
    } else {
      feedback = (isPrepaid && !token) ? 'Processing' : (feedback || 'Processing');
    }

    const updatedMeta = {
      ...meta,
      flw_tx_ref: requestId,
      flw_reference: orderId || String(meta.flw_reference || '').trim(),
      bill_status: billStatus,
      token: token || String(meta.token || ''),
      ck_statuscode: statusCode,
      ck_orderstatus: orderStatus,
      ck_orderremark: orderRemark,
      ck_status: statusResp || null,
    };
    const updatedOther = {
      ...otherData,
      feedback,
    };

    const amount = Number(txRow.amount?.toString?.() ?? txRow.amount);
    const debit = Number.isFinite(amount) ? amount : 0;
    const refundTrx = `${trx}_rvsl`;

    let refunded = false;
    if (isFailed && debit > 0) {
      await prisma.$transaction(async ptx => {
        const alreadyRefunded = await ptx.walletTransaction.findUnique({ where: { trx: refundTrx } });
        if (alreadyRefunded) {
          refunded = true;
          return;
        }

        await ptx.user.update({
          where: { id: Number(user.id) },
          data: { balance: { increment: debit }, currency_symbol: '₦' },
        });

        try {
          await ptx.walletTransaction.create({
            data: {
              user_id: Number(user.id),
              trx: refundTrx,
              trx_type: '+',
              amount: txRow.amount,
              charge: txRow.charge,
              total_amount: txRow.total_amount,
              remark: 'balance_add',
              details: `Reversal for ${trx}`,
              other_data: {
                title: 'Reversal',
                subtitle: String(updatedMeta.provider || 'Electricity'),
                feedback: 'Reversed',
                note: 'ClubKonnect',
                image_src: '',
              },
              meta: {
                original_trx: trx,
                flw_tx_ref: requestId,
                bill_status: billStatus,
              },
            },
          });
          refunded = true;
        } catch (e) {
          if (e?.code !== 'P2002') throw e;
          refunded = true;
        }

        await ptx.walletTransaction.update({
          where: { trx },
          data: {
            meta: updatedMeta,
            other_data: updatedOther,
          },
        });
      });
    } else {
      await prisma.walletTransaction.update({
        where: { trx },
        data: {
          meta: updatedMeta,
          other_data: updatedOther,
        },
      });
    }

    return res.json({
      remark: 'electricity_status',
      status: 'success',
      message: ['OK'],
      data: {
        trx,
        flw_tx_ref: requestId,
        bill_status: billStatus,
        feedback,
        token: token || '',
        refunded,
      },
    });
  } catch (e) {
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

function cacheSet(map, key, value, ttlMs) {
  map.set(key, { value, expires: Date.now() + Math.max(1_000, Number(ttlMs) || 0) });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const KNOWN_NG_ELECTRICITY_BILLERS = [
  { biller_code: '01', name: 'Eko Electric - EKEDC (PHCN)', category: 'UTILITYBILLS' },
  { biller_code: '02', name: 'Ikeja Electric - IKEDC (PHCN)', category: 'UTILITYBILLS' },
  { biller_code: '03', name: 'Abuja Electric - AEDC', category: 'UTILITYBILLS' },
  { biller_code: '04', name: 'Kano Electric - KEDC', category: 'UTILITYBILLS' },
  { biller_code: '05', name: 'Portharcourt Electric - PHEDC', category: 'UTILITYBILLS' },
  { biller_code: '06', name: 'Jos Electric - JEDC', category: 'UTILITYBILLS' },
  { biller_code: '07', name: 'Ibadan Electric - IBEDC', category: 'UTILITYBILLS' },
  { biller_code: '08', name: 'Kaduna Electric - KAEDC', category: 'UTILITYBILLS' },
  { biller_code: '09', name: 'ENUGU Electric - EEDC', category: 'UTILITYBILLS' },
  { biller_code: '10', name: 'BENIN Electric - BEDC', category: 'UTILITYBILLS' },
  { biller_code: '11', name: 'YOLA Electric - YEDC', category: 'UTILITYBILLS' },
  { biller_code: '12', name: 'ABA Electric - APLE', category: 'UTILITYBILLS' },
];

function moneyStr(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0.00';
  return num.toFixed(2);
}

async function listNgUtilityBillers() {
  const rxElectric = /(electric|power|prepaid|postpaid|disco|edc|ikedc|ekedc|aedc|kedco|jedc|ibedc|phedc|eedc|bedc|yedc)/i;

  const timeoutMs = 5000;

  let list = [];
  try {
    const p = listElectricityDiscosV2();
    p.catch(() => null);
    const resp = await Promise.race([p, delay(timeoutMs).then(() => null)]);
    const companies = resp?.ELECTRIC_COMPANY;
    if (companies && typeof companies === 'object') {
      const out = [];
      for (const key of Object.keys(companies)) {
        const arr = companies[key];
        if (!Array.isArray(arr)) continue;
        for (const row of arr) {
          const code = String(row?.ID || row?.id || '').trim();
          const name = String(row?.NAME || row?.name || '').trim();
          if (!code) continue;
          out.push({ biller_code: code, name: name || `Disco ${code}`, category: 'UTILITYBILLS' });
        }
      }
      list = out;
    } else {
      list = [];
    }
  } catch (_) {
    list = [];
  }

  if (!list.length) {
    list = KNOWN_NG_ELECTRICITY_BILLERS;
  }

  list = list.filter(b => {
    const cat = String(b?.category || b?.category_code || b?.categoryCode || '').toUpperCase();
    if (cat === 'UTILITYBILLS') return true;
    const name = String(b?.name || b?.biller_name || b?.short_name || b?.shortName || '');
    return rxElectric.test(name);
  });

  const map = new Map();
  for (const b of list) {
    const code = String(b?.biller_code || b?.billerCode || b?.code || '').trim().toUpperCase();
    if (!code) continue;
    if (!map.has(code)) map.set(code, b);
  }

  list = Array.from(map.values());

  return list;
}

async function listNgOperatorsCached() {
  const cached = cacheGet(ngOperatorsCache, 'ng_ops');
  if (cached) return cached;

  const billers = await listNgUtilityBillers();
  const seen = new Set();
  const operators = billers
    .map((b, idx) => normalizeBillerOperator(b, idx))
    .filter(o => o.biller_code)
    .filter(o => {
      const key = String(o.biller_code).toUpperCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  cacheSet(ngOperatorsCache, 'ng_ops', operators, 30 * 60_000);
  return operators;
}

setImmediate(() => {
  listNgOperatorsCached().catch(() => null);
});

function normalizeBillerOperator(b, idx) {
  const biller_code = String(b?.biller_code || b?.billerCode || b?.code || '').trim();
  const name = String(b?.name || b?.biller_name || b?.short_name || b?.shortName || 'Electricity').trim();
  return {
    id: Number(b?.id) || (idx + 1),
    name,
    biller_code,
    logo_urls: [String(b?.logo || b?.logo_url || '')],
  };
}

async function create(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const balance = user?.balance?.toString ? Number(user.balance.toString()) : Number(user?.balance || 0);

    const operators = await listNgOperatorsCached();

    const NG = {
      id: 1,
      name: 'Nigeria',
      iso_name: 'NG',
      continent: 'Africa',
      currency_code: 'NGN',
      currency_name: 'Naira',
      currency_symbol: '₦',
      flag_url: 'ng.png',
      calling_codes: ['+234'],
      status: '1',
      operators,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const data = {
      countries: [NG],
      supported_otp_types: [],
      current_balance: moneyStr(balance),
    };

    return res.json({ remark: 'electricity_info', status: 'success', message: ['OK'], data });
  } catch (e) {
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function operatorsByCountry(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const ops = await listNgOperatorsCached();

    const data = { operators: { data: ops }, supported_otp_types: [] };
    return res.json({ remark: 'operators', status: 'success', message: ['OK'], data });
  } catch (e) {
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function verify(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const biller_code = String(req.body?.biller_code || '').trim().toUpperCase();
    const meter_number = String(req.body?.meter_number || '').trim().replace(/\s+/g, '');
    const meter_type = String(req.body?.meter_type || 'prepaid').trim().toLowerCase();

    if (!biller_code || !meter_number) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['biller_code and meter_number are required'], data: null });
    }

    const cacheKey = `${biller_code}|${meter_number}|${meter_type}`;
    const cached = cacheGet(meterVerifyCache, cacheKey);
    if (cached) {
      return res.json({ remark: 'verified', status: 'success', message: ['OK'], data: cached });
    }

    const verifyResp = await verifyElectricityMeterV1({
      electricCompany: biller_code,
      meterNo: meter_number,
      meterType: meter_type,
    });

    const customerName = String(verifyResp?.customer_name || verifyResp?.name || '').trim();
    if (!customerName || customerName.toUpperCase() === 'INVALID_METERNO') {
      return res.status(400).json({ remark: 'invalid_meter', status: 'error', message: ['Invalid meter number'], data: verifyResp || null });
    }

    const data = {
      name: customerName,
      address: '',
      type: meter_type,
      biller_code,
      raw: verifyResp,
    };

    cacheSet(meterVerifyCache, cacheKey, data, 10 * 60_000);

    return res.json({ remark: 'verified', status: 'success', message: ['OK'], data });
  } catch (e) {
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: e?.clubkonnect || null });
  }
}

async function store(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const operator = String(req.body?.operator || '').trim();
    const operator_name = String(req.body?.operator_name || '').trim();
    const biller_code = String(req.body?.biller_code || '').trim().toUpperCase();
    const meter_number = String(req.body?.meter_number || '').trim().replace(/\s+/g, '');
    const meter_type = String(req.body?.meter_type || 'prepaid').trim().toLowerCase();
    const amount = Number(req.body?.amount);
    const country = String(req.body?.country || '1').trim();
    const calling_code = String(req.body?.calling_code || '').replace('+', '').trim();
    const mobile_number = String(req.body?.mobile_number || '').trim();
    const remark = String(req.body?.remark || 'electricity');

    if (!biller_code || !meter_number || !calling_code || !mobile_number || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid input'], data: null });
    }

    if (amount < 1000) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Minimum electricity amount is 1000'], data: null });
    }

    const cacheKey = `${biller_code}|${meter_number}|${meter_type}`;
    const cached = cacheGet(meterVerifyCache, cacheKey);

    const customer_name = String(cached?.name || '').trim();
    const address = String(cached?.address || '').trim();

    const payload = {
      operator_id: operator ? Number(operator) : null,
      operator_name: operator_name || null,
      biller_code,
      meter_number,
      meter_type,
      customer_name: customer_name || null,
      address: address || null,
      amount: Number(amount),
      country,
      calling_code,
      mobile_number,
    };

    setPending(user.id, remark, payload, { ttlMs: 5 * 60_000 });

    return res.json({ remark: 'pin', status: 'success', message: ['Proceed to PIN'], data: null });
  } catch (e) {
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: e?.clubkonnect || null });
  }
}

module.exports = { create, operatorsByCountry, verify, store, status };
