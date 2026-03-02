const prisma = require('../../database/prisma');
const userAuth = require('../middlewares/userAuth.middleware');
const { setPending, getPending } = require('../services/pending.service');
const { listHistory, addHistory, generateTrx, toDecimal } = require('../services/airtime.service');

const CURRENCY = 'NGN';

function moneyStr(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0.00';
  return num.toFixed(2);
}

function ngOperators() {
  return [
    { id: 101, name: 'MTN', bundle: '0', min_amount: '50', max_amount: '50000', logo_urls: [''], fixed_amounts: [], fixed_amounts_descriptions: {}, suggested_amounts: ['100', '200', '500', '1000'] },
    { id: 102, name: 'Airtel', bundle: '0', min_amount: '50', max_amount: '50000', logo_urls: [''], fixed_amounts: [], fixed_amounts_descriptions: {}, suggested_amounts: ['100', '200', '500', '1000'] },
    { id: 103, name: 'Glo', bundle: '0', min_amount: '50', max_amount: '50000', logo_urls: [''], fixed_amounts: [], fixed_amounts_descriptions: {}, suggested_amounts: ['100', '200', '500', '1000'] },
    { id: 104, name: '9mobile', bundle: '0', min_amount: '50', max_amount: '50000', logo_urls: [''], fixed_amounts: [], fixed_amounts_descriptions: {}, suggested_amounts: ['100', '200', '500', '1000'] },
  ];
}

function countryListFor(user) {
  const balance = user?.balance?.toString ? Number(user.balance.toString()) : Number(user?.balance || 0);
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
    operators: ngOperators(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  return { countries: [NG], supported_otp_types: [], current_balance: moneyStr(balance) };
}

async function create(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const data = countryListFor(user);
    return res.json({ remark: 'airtime_info', status: 'success', message: ['OK'], data });
  } catch (e) {
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function operatorsByCountry(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });
    const countryID = Number(req.params.countryID);
    let ops = [];
    if (countryID === 1) ops = ngOperators();
    const data = { operators: { data: ops }, supported_otp_types: [] };
    return res.json({ remark: 'operators', status: 'success', message: ['OK'], data });
  } catch (e) {
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function store(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const operator = String(req.body?.operator || '').trim();
    const country = String(req.body?.country || '').trim();
    const calling_code = String(req.body?.calling_code || '').replace('+', '').trim();
    const amount = Number(req.body?.amount);
    const mobile_number = String(req.body?.mobile_number || '').trim();
    const remark = String(req.body?.remark || 'air_time');
    const verification_type = String(req.body?.verification_type || '');

    if (!operator || !country || !calling_code || !mobile_number || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid input'], data: null });
    }

    const opId = Number(operator);
    const ops = country === '1' ? ngOperators() : ngOperators();
    const op = ops.find(o => Number(o.id) === opId);

    const opName = String(op?.name || '').trim().toUpperCase();
    const ck_network_code = opName.includes('MTN')
      ? '01'
      : (opName.includes('GLO')
        ? '02'
        : ((opName.includes('9MOBILE') || opName.includes('ETISALAT'))
          ? '03'
          : (opName.includes('AIRTEL') ? '04' : '')));

    const payload = { operator_id: opId, operator_name: op?.name || 'Operator', country, calling_code, amount, mobile_number, ck_network_code };
    setPending(user.id, remark, payload, { ttlMs: 5 * 60_000 });

    const nextStep = 'pin';
    return res.json({ remark: nextStep, status: 'success', message: ['Proceed to PIN'], data: null });
  } catch (e) {
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function history(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });
    const page = Number(req.query?.page || 1);
    const pageSize = 10;
    const all = listHistory(user.id);
    const start = (page - 1) * pageSize;
    const slice = all.slice(start, start + pageSize);
    const nextPageUrl = start + pageSize < all.length ? `${req.baseUrl}${req.path}?page=${page + 1}` : null;

    const data = {
      top_ups: {
        data: slice.map(rec => ({
          id: rec.id,
          user_id: Number(user.id),
          operator_id: rec.operator_id,
          amount: moneyStr(rec.amount),
          charge: moneyStr(rec.charge || 0),
          post_balance: moneyStr(rec.post_balance),
          trx: rec.trx,
          details: rec.details,
          dial_code: rec.dial_code,
          mobile_number: rec.mobile_number,
          created_at: rec.created_at,
          updated_at: rec.updated_at,
          operator: rec.operator,
        })),
        next_page_url: nextPageUrl,
      },
    };

    return res.json({ remark: 'airtime_history', status: 'success', message: ['OK'], data });
  } catch (e) {
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

module.exports = { create, operatorsByCountry, store, history };
