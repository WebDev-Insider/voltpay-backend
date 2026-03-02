const { setPending } = require('../services/pending.service');
const { listCableTVPackagesV2Cached, verifyCableTVV1 } = require('../funding/clubkonnect.service');

const smartCardVerifyCache = new Map();
const ngOperatorsCache = new Map();

const KNOWN_NG_CABLE_PROVIDERS = [
  { biller_code: 'dstv', name: 'DStv' },
  { biller_code: 'gotv', name: 'GOtv' },
  { biller_code: 'startimes', name: 'Startimes' },
  { biller_code: 'showmax', name: 'Showmax' },
];

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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function moneyStr(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0.00';
  return num.toFixed(2);
}

function parseNum(v) {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').replace(/[^0-9.]/g, '');
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function extractProvidersFromPackages(packagesJson) {
  const tv = packagesJson?.TV_ID;
  if (!tv || typeof tv !== 'object') return [];
  const out = [];
  for (const [name, arr] of Object.entries(tv)) {
    if (!Array.isArray(arr)) continue;
    for (const row of arr) {
      const code = String(row?.ID || row?.id || '').trim().toLowerCase();
      if (!code) continue;
      out.push({ biller_code: code, name: String(name || code).trim() || code });
    }
  }
  return out;
}

function extractPackagesForProvider(packagesJson, providerCode) {
  const tv = packagesJson?.TV_ID;
  const code = String(providerCode || '').trim().toLowerCase();
  if (!tv || typeof tv !== 'object' || !code) return [];

  let products = [];
  for (const arr of Object.values(tv)) {
    if (!Array.isArray(arr)) continue;
    for (const row of arr) {
      const id = String(row?.ID || row?.id || '').trim().toLowerCase();
      if (!id || id !== code) continue;
      const p = row?.PRODUCT;
      if (Array.isArray(p)) products = products.concat(p);
    }
  }

  return products
    .map((p, idx) => ({
      id: idx + 1,
      biller_code: code,
      item_code: String(p?.PACKAGE_ID || p?.package_id || p?.PackageID || '').trim(),
      name: String(p?.PACKAGE_NAME || p?.package_name || p?.PackageName || '').trim(),
      amount: parseNum(p?.PACKAGE_AMOUNT ?? p?.package_amount ?? 0),
      fee: 0,
      label_name: 'Smart Card / IUC',
      description: '',
    }))
    .filter(x => x.item_code && x.name && Number.isFinite(x.amount) && x.amount > 0);
}

async function listNgOperatorsCached() {
  const cached = cacheGet(ngOperatorsCache, 'ng_ops');
  if (cached) return cached;

  let packages;
  try {
    packages = await listCableTVPackagesV2Cached({ ttlMs: 30 * 60_000 });
  } catch (_) {
    packages = null;
  }

  const providers = extractProvidersFromPackages(packages);
  const map = new Map();
  for (const p of providers) {
    const code = String(p?.biller_code || '').trim().toLowerCase();
    if (!code) continue;
    if (!map.has(code)) map.set(code, p);
  }
  for (const known of KNOWN_NG_CABLE_PROVIDERS) {
    const code = String(known.biller_code).trim().toLowerCase();
    if (!code) continue;
    if (!map.has(code)) map.set(code, known);
  }

  const operators = Array.from(map.values())
    .map((b, idx) => ({
      id: idx + 1,
      name: String(b?.name || 'Cable TV').trim() || 'Cable TV',
      biller_code: String(b?.biller_code || '').trim().toLowerCase(),
      logo_urls: [''],
    }))
    .filter(o => Boolean(o.biller_code));

  cacheSet(ngOperatorsCache, 'ng_ops', operators, operators.length > 0 ? 15 * 60_000 : 30_000);
  return operators;
}

async function listPackagesForProviderCached({ providerCode }) {
  const code = String(providerCode || '').trim().toLowerCase();
  if (!code) return [];
  const cacheKey = `pkg:${code}`;
  const cached = cacheGet(ngOperatorsCache, cacheKey);
  if (cached) return cached;
  const packagesJson = await listCableTVPackagesV2Cached({ ttlMs: 30 * 60_000 });
  const list = extractPackagesForProvider(packagesJson, code);
  cacheSet(ngOperatorsCache, cacheKey, list, list.length > 0 ? 15 * 60_000 : 30_000);
  return list;
}

async function create(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const operators = await listNgOperatorsCached();

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
      operators,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const data = { countries: [NG], supported_otp_types: [], current_balance: moneyStr(balance) };
    return res.json({ remark: 'cable_info', status: 'success', message: ['OK'], data });
  } catch (e) {
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: e?.clubkonnect || null });
  }
}

async function operatorsByCountry(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });
    const data = { operators: { data: await listNgOperatorsCached() }, supported_otp_types: [] };
    return res.json({ remark: 'operators', status: 'success', message: ['OK'], data });
  } catch (e) {
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: e?.clubkonnect || null });
  }
}

async function bundles(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const biller_code = String(req.params.service || '').trim().toLowerCase();
    if (!biller_code) return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid operator'], data: null });

    const list = await listPackagesForProviderCached({ providerCode: biller_code });
    const data = { bundles: { data: list } };

    return res.json({ remark: 'bundles', status: 'success', message: ['OK'], data });
  } catch (e) {
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: e?.clubkonnect || null });
  }
}

async function verify(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const biller_code = String(req.body?.biller_code || '').trim().toLowerCase();
    const smart_number = String(req.body?.smart_number || req.body?.smartNo || '').trim().replace(/\s+/g, '');
    const item_code_input = String(req.body?.item_code || '').trim();

    if (!biller_code || !smart_number) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['biller_code and smart_number are required'], data: null });
    }

    const cacheKey = `${biller_code}|${smart_number}|${item_code_input || ''}`;
    const cached = cacheGet(smartCardVerifyCache, cacheKey);
    if (cached) {
      return res.json({ remark: 'verified', status: 'success', message: ['OK'], data: cached });
    }

    const verifyResp = await verifyCableTVV1({ cableTv: biller_code, smartCardNo: smart_number });
    const item_code = String(item_code_input || '').trim();
    const item_name = '';
    const d = verifyResp;

    const data = {
      name: String(d?.customer_name || d?.name || d?.CustomerName || ''),
      address: String(d?.address || ''),
      type: 'cable',
      item_code,
      item_name,
      biller_code,
      smart_number,
      raw: d,
    };

    cacheSet(smartCardVerifyCache, cacheKey, data, 10 * 60_000);
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
    const biller_code = String(req.body?.biller_code || '').trim().toLowerCase();
    const smart_number = String(req.body?.smart_number || req.body?.smartNo || '').trim().replace(/\s+/g, '');
    const item_code = String(req.body?.item_code || '').trim();
    const country = String(req.body?.country || '1').trim();
    const calling_code = String(req.body?.calling_code || '').replace('+', '').trim();
    const mobile_number = String(req.body?.mobile_number || '').trim();
    const remark = String(req.body?.remark || 'cable_tv');

    if (!biller_code || !smart_number || !item_code || !calling_code || !mobile_number) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid input'], data: null });
    }

    const ops = await listNgOperatorsCached();
    const opFromList = ops.find(o => String(o.biller_code).toLowerCase() === String(biller_code).toLowerCase()) || null;

    const list = await listPackagesForProviderCached({ providerCode: biller_code });
    const found = list.find(it => String(it?.item_code || '').trim() === item_code);
    if (!found) {
      return res.status(400).json({ remark: 'invalid_bundle', status: 'error', message: ['Invalid package'], data: null });
    }

    const amount = Number(found?.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ remark: 'invalid_amount', status: 'error', message: ['Invalid amount for package'], data: null });
    }

    const item_name = String(found?.name || 'Cable TV').trim();

    const payload = {
      operator_id: operator ? Number(operator) : (opFromList?.id || null),
      operator_name: operator_name || opFromList?.name || biller_code,
      biller_code,
      item_code,
      item_name,
      smart_number,
      amount,
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

module.exports = { create, operatorsByCountry, bundles, verify, store };
