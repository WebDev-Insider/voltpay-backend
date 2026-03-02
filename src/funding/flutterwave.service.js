const FLW_BASE_URL = 'https://api.flutterwave.com/v3';
const https = require('https');
const { URL } = require('url');

const fetchFn =
  typeof fetch === 'function'
    ? fetch
    : (() => {
        try {
          return require('undici').fetch;
        } catch {
          return null;
        }
      })();

// Simple in-memory cache for catalog responses
const cacheStore = new Map(); // key -> { value, expires }

function cacheGet(key) {
  const hit = cacheStore.get(key);
  if (!hit) return null;
  if (hit.expires && hit.expires > Date.now()) return hit.value;
  cacheStore.delete(key);
  return null;
}

function cacheSet(key, value, ttlMs = 15 * 60_000) {
  cacheStore.set(key, { value, expires: Date.now() + Math.max(1_000, ttlMs) });
}

function getFlutterwaveBearerToken() {
  const secretKey = (process.env.FLUTTERWAVE_SECRET_KEY || '').trim();
  if (secretKey) {
    if (!/^FLWSECK[-_]/i.test(secretKey)) {
      throw new Error('Invalid Flutterwave secret key. Expected FLUTTERWAVE_SECRET_KEY to start with FLWSECK_ or FLWSECK-');
    }
    return secretKey;
  }

  const clientId = (process.env.FLUTTERWAVE_CLIENT_ID || '').trim();
  const clientSecret = (process.env.FLUTTERWAVE_CLIENT_SECRET || '').trim();
  if (clientId || clientSecret) {
    throw new Error(
      'Flutterwave /v3 endpoints require FLUTTERWAVE_SECRET_KEY (FLWSECK_LIVE-...). Your env currently has V4 Client ID/Secret, but /v3/payments will reject them.'
    );
  }

  throw new Error('Missing required env: FLUTTERWAVE_SECRET_KEY');
}

function httpsRequest(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ''),
      headers: Object.assign(
        {},
        headers,
        payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}
      ),
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: async () => data,
        });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function flwRequest(path, { method = 'GET', body } = {}) {
  const bearerToken = getFlutterwaveBearerToken();
  const url = `${FLW_BASE_URL}${path}`;
  const headers = {
    Authorization: `Bearer ${bearerToken}`,
    'Content-Type': 'application/json',
  };

  const res = fetchFn
    ? await fetchFn(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
    : await httpsRequest(url, { method, headers, body });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const msg = json?.message || json?.data?.message || text || `Flutterwave request failed (${res.status})`;
    const err = new Error(msg);
    err.statusCode = res.status;
    err.flutterwave = json;
    throw err;
  }

  return json;
}

async function createPaymentLink({ tx_ref, amount, currency = 'NGN', redirect_url, customer, customizations }) {
  const body = {
    tx_ref,
    amount,
    currency,
    redirect_url,
    payment_options: 'card,banktransfer',
    customer,
    customizations,
  };

  const json = await flwRequest('/payments', { method: 'POST', body });
  const link = json?.data?.link;
  if (!link) {
    const err = new Error('Flutterwave did not return a payment link');
    err.flutterwave = json;
    throw err;
  }
  return { link, raw: json };
}

async function verifyTransaction(transactionId) {
  if (!transactionId) throw new Error('transactionId is required');
  const json = await flwRequest(`/transactions/${encodeURIComponent(String(transactionId))}/verify`, { method: 'GET' });
  return { raw: json, data: json?.data };
}

// Flutterwave Bills - Airtime purchase (V3)
// Docs: https://api.flutterwave.com/v3/bills
// Minimal payload for airtime top-up. "type" of "AIRTIME" is acceptable for generic airtime topup.
async function purchaseAirtime({ reference, country = 'NG', customer, amount, type = 'AIRTIME' }) {
  if (!customer) throw new Error('customer (phone) is required');
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Invalid amount');

  const body = {
    country: String(country || 'NG').toUpperCase(),
    customer: String(customer),
    amount: amt,
    type: String(type || 'AIRTIME').toUpperCase(),
    reference: String(reference || `airtime_${Date.now()}`),
  };

  const json = await flwRequest('/bills', { method: 'POST', body });
  return { raw: json, data: json?.data };
}

// List data bundles (bill items) for a given biller code, with in-memory caching
// Example biller codes (NG): MTN=BIL108, GLO=BIL109, Airtel=BIL110, 9Mobile=BIL111
async function listDataBundles({ billerCode }) {
  const code = String(billerCode || '').trim().toUpperCase();
  if (!code) throw new Error('billerCode is required');
  const json = await flwRequest(`/billers/${encodeURIComponent(code)}/items`, { method: 'GET' });
  const items = json?.data?.items || json?.data || json?.items || [];
  return Array.isArray(items) ? items : [];
}

async function listDataBundlesCached({ billerCode, ttlMs = 15 * 60_000 }) {
  const key = `flw:data:items:${String(billerCode || '').toUpperCase()}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const items = await listDataBundles({ billerCode });
  cacheSet(key, items, ttlMs);
  return items;
}

async function listBillers({ country = 'NG', category }) {
  const qs = new URLSearchParams();
  if (country) qs.set('country', String(country).toUpperCase());
  if (category) qs.set('category', String(category).toUpperCase());
  const path = `/billers?${qs.toString()}`;

  const extractBillers = json => {
    const data = json?.data;
    if (Array.isArray(data)) return data;
    if (Array.isArray(json?.billers)) return json.billers;
    if (Array.isArray(data?.billers)) return data.billers;
    if (Array.isArray(data?.data)) return data.data;
    if (Array.isArray(data?.items)) return data.items;
    return [];
  };

  const extractTotalPages = json => {
    const data = json?.data;
    const pageInfo = data?.page_info || data?.pageInfo || json?.meta?.page_info || json?.meta?.pageInfo || json?.page_info;
    const total = Number(pageInfo?.total_pages ?? pageInfo?.totalPages ?? 1);
    return Number.isFinite(total) && total > 1 ? total : 1;
  };

  const first = await flwRequest(path, { method: 'GET' });
  let billers = extractBillers(first);

  const totalPages = extractTotalPages(first);
  if (totalPages > 1) {
    for (let page = 2; page <= totalPages; page++) {
      try {
        qs.set('page', String(page));
        const j = await flwRequest(`/billers?${qs.toString()}`, { method: 'GET' });
        billers = billers.concat(extractBillers(j));
      } catch (_) {
        break;
      }
    }
  }

  return Array.isArray(billers) ? billers : [];
}

async function listBillersCached({ country = 'NG', category, ttlMs = 15 * 60_000 }) {
  const key = `flw:billers:${String(country || 'NG').toUpperCase()}:${String(category || '').toUpperCase()}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const billers = await listBillers({ country, category });
  cacheSet(key, billers, Array.isArray(billers) && billers.length > 0 ? ttlMs : 30_000);
  return billers;
}

async function listBillItems({ billerCode }) {
  const code = String(billerCode || '').trim().toUpperCase();
  if (!code) throw new Error('billerCode is required');
  const json = await flwRequest(`/billers/${encodeURIComponent(code)}/items`, { method: 'GET' });

  const looksLikeBillItems = arr => {
    if (!Array.isArray(arr) || arr.length === 0) return false;
    const first = arr[0];
    if (!first || typeof first !== 'object') return false;
    const keys = Object.keys(first);
    const hasCode = keys.includes('item_code') || keys.includes('itemCode') || keys.includes('code');
    const hasName = keys.includes('name') || keys.includes('product_name') || keys.includes('product') || keys.includes('short_name');
    const hasAmount = keys.includes('amount') || keys.includes('price');
    return hasCode && (hasName || hasAmount);
  };

  const extractItemsShallow = j => {
    const d = j?.data;
    const candidates = [
      d,
      j?.items,
      d?.items,
      d?.data,
      d?.items?.data,
      d?.bill_items,
      d?.billItems,
    ];
    for (const c of candidates) {
      if (looksLikeBillItems(c)) return c;
      if (Array.isArray(c) && c.length > 0 && typeof c[0] === 'object') return c;
    }
    return null;
  };

  const deepFind = (obj, depth = 0) => {
    if (!obj || depth > 6) return null;
    if (Array.isArray(obj)) {
      if (looksLikeBillItems(obj)) return obj;
      return null;
    }
    if (typeof obj !== 'object') return null;

    const shallow = extractItemsShallow(obj);
    if (shallow) return shallow;

    for (const v of Object.values(obj)) {
      const found = deepFind(v, depth + 1);
      if (found) return found;
    }
    return null;
  };

  const items = deepFind(json) || [];
  return Array.isArray(items) ? items : [];
}

async function listBillItemsCached({ billerCode, ttlMs = 15 * 60_000 }) {
  const key = `flw:billers:${String(billerCode || '').toUpperCase()}:items`;
  const cached = cacheGet(key);
  if (cached) return { items: cached };
  const items = await listBillItems({ billerCode });
  cacheSet(key, items, Array.isArray(items) && items.length > 0 ? ttlMs : 30_000);
  return { items };
}

async function validateCustomerDetails({ itemCode, billerCode, customer }) {
  const item = String(itemCode || '').trim();
  const code = String(billerCode || '').trim().toUpperCase();
  const cust = String(customer || '').trim();
  if (!item || !code || !cust) throw new Error('itemCode, billerCode and customer are required');
  const qs = new URLSearchParams({ code, customer: cust });
  const json = await flwRequest(`/bill-items/${encodeURIComponent(item)}/validate?${qs.toString()}`, { method: 'GET' });
  return json;
}

async function createBillPayment({ billerCode, itemCode, country = 'NG', customer_id, amount, reference, callback_url }) {
  const code = String(billerCode || '').trim().toUpperCase();
  const item = String(itemCode || '').trim();
  if (!code || !item) throw new Error('billerCode and itemCode are required');
  if (!customer_id) throw new Error('customer_id is required');
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Invalid amount');

  const body = {
    country: String(country || 'NG').toUpperCase(),
    customer_id: String(customer_id),
    amount: amt,
    reference: String(reference || `bill_${Date.now()}`),
  };
  if (callback_url) body.callback_url = String(callback_url);

  const path = `/billers/${encodeURIComponent(code)}/items/${encodeURIComponent(item)}/payment`;
  const json = await flwRequest(path, { method: 'POST', body });
  return { raw: json, data: json?.data };
}

async function getBillStatusVerbose({ reference }) {
  if (!reference) throw new Error('reference is required');
  const json = await flwRequest(`/bills/${encodeURIComponent(String(reference))}`, { method: 'GET' });
  return { raw: json, data: json?.data };
}

// Purchase a data bundle using the generic /v3/bills endpoint
// For data bundles, Flutterwave expects the 'type' field to be the specific bundle name (e.g., "MTN 1.5 GB DATA BUNDLE")
async function purchaseData({ reference, country = 'NG', customer, amount, item_name }) {
  if (!customer) throw new Error('customer (phone) is required');
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Invalid amount');
  const type = String(item_name || '').trim();
  if (!type) throw new Error('item_name (bundle name) is required');

  const body = {
    country: String(country || 'NG').toUpperCase(),
    customer: String(customer),
    amount: amt,
    recurrence: 'ONCE',
    type: type,
    reference: String(reference || `data_${Date.now()}`),
  };

  const json = await flwRequest('/bills', { method: 'POST', body });
  return { raw: json, data: json?.data };
}

module.exports = {
  createPaymentLink,
  verifyTransaction,
  purchaseAirtime,
  listDataBundles,
  listDataBundlesCached,
  purchaseData,
  listBillers,
  listBillersCached,
  listBillItems,
  listBillItemsCached,
  validateCustomerDetails,
  createBillPayment,
  getBillStatusVerbose,
};
