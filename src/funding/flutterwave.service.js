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

async function flwRequest(path, { method = 'GET', body, headers: extraHeaders } = {}) {
  const bearerToken = getFlutterwaveBearerToken();
  const url = `${FLW_BASE_URL}${path}`;
  const headers = {
    Authorization: `Bearer ${bearerToken}`,
    'Content-Type': 'application/json',
    ...(extraHeaders || {}),
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

async function createCustomer({ first_name, last_name, email }) {
  const mail = String(email || '').trim();
  const first = String(first_name || '').trim();
  const last = String(last_name || '').trim();
  if (!mail) throw new Error('email is required');
  if (!first || !last) throw new Error('first_name and last_name are required');

  const body = {
    name: {
      first,
      last,
    },
    email: mail,
  };

  const json = await flwRequest('/customers', { method: 'POST', body });
  return { raw: json, data: json?.data };
}

async function createVirtualAccount({
  tx_ref,
  customer_id,
  amount,
  currency = 'NGN',
  type,
  narration,
  bvn,
  nin,
  bank_code,
  expiry_time,
  idempotencyKey,
}) {
  const ref = String(tx_ref || '').trim();
  const customerId = String(customer_id || '').trim();
  const amt = Number(amount);
  if (!ref) throw new Error('tx_ref is required');
  if (!customerId) throw new Error('customer_id is required');
  if (!Number.isFinite(amt) || amt < 0) throw new Error('Invalid amount');

  const vaType = String(type || '').trim().toLowerCase();
  if (vaType !== 'static' && vaType !== 'dynamic') {
    throw new Error('type must be static or dynamic');
  }

  const body = {
    tx_ref: ref,
    customer_id: customerId,
    amount: amt,
    currency: String(currency || 'NGN').toUpperCase(),
    type: vaType,
  };

  if (narration) body.narration = String(narration);
  if (expiry_time) body.expiry_time = String(expiry_time);
  if (bvn) body.bvn = String(bvn);
  if (nin) body.nin = String(nin);
  if (bank_code) body.bank_code = String(bank_code);

  const headers = {};
  if (idempotencyKey) headers['X-Idempotency-Key'] = String(idempotencyKey);

  const json = await flwRequest('/virtual-accounts', { method: 'POST', body, headers });
  return { raw: json, data: json?.data };
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

async function createVirtualAccountNumber({
  email,
  amount,
  tx_ref,
  phonenumber,
  firstname,
  lastname,
  narration,
  is_permanent,
  bvn,
  bank_code,
}) {
  const mail = String(email || '').trim();
  const ref = String(tx_ref || '').trim();
  if (!mail) throw new Error('email is required');
  if (!ref) throw new Error('tx_ref is required');

  const permanent = is_permanent != null ? Boolean(is_permanent) : false;
  const hasAmount = !(amount == null || String(amount).trim() === '');
  const amt = hasAmount ? Number(amount) : null;
  if (!hasAmount && !permanent) throw new Error('amount is required');
  if (hasAmount && (!Number.isFinite(amt) || amt <= 0)) throw new Error('Invalid amount');

  const body = {
    email: mail,
    tx_ref: ref,
  };

  if (hasAmount) body.amount = amt;

  if (phonenumber) body.phonenumber = String(phonenumber);
  if (firstname) body.firstname = String(firstname);
  if (lastname) body.lastname = String(lastname);
  if (narration) body.narration = String(narration);
  if (is_permanent != null) body.is_permanent = permanent;
  if (bvn) body.bvn = String(bvn);
  if (bank_code) body.bank_code = String(bank_code);

  const json = await flwRequest('/virtual-account-numbers', { method: 'POST', body });
  return { raw: json, data: json?.data };
}

async function verifyTransaction(transactionId) {
  if (!transactionId) throw new Error('transactionId is required');
  const json = await flwRequest(`/transactions/${encodeURIComponent(String(transactionId))}/verify`, { method: 'GET' });
  return { raw: json, data: json?.data };
}

async function listTransactions({
  from,
  to,
  status,
  tx_ref,
  customer_email,
  page,
} = {}) {
  const qs = new URLSearchParams();
  if (from) qs.set('from', String(from));
  if (to) qs.set('to', String(to));
  if (status) qs.set('status', String(status));
  if (tx_ref) qs.set('tx_ref', String(tx_ref));
  if (customer_email) qs.set('customer_email', String(customer_email));
  if (page != null) qs.set('page', String(page));

  const path = qs.toString() ? `/transactions?${qs.toString()}` : '/transactions';
  const json = await flwRequest(path, { method: 'GET' });

  const data = json?.data;
  if (Array.isArray(data)) return { raw: json, data };
  if (Array.isArray(data?.data)) return { raw: json, data: data.data };
  if (Array.isArray(json?.data?.transactions)) return { raw: json, data: json.data.transactions };
  return { raw: json, data: [] };
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

async function listBanks({ country = 'NG' } = {}) {
  const cc = String(country || 'NG').trim().toUpperCase();
  if (!cc) throw new Error('country is required');

  try {
    const json = await flwRequest(`/banks/${encodeURIComponent(cc)}`, { method: 'GET' });
    const banks = json?.data || json?.banks || [];
    return Array.isArray(banks) ? banks : [];
  } catch (e) {
    const qs = new URLSearchParams({ country: cc });
    const json = await flwRequest(`/banks?${qs.toString()}`, { method: 'GET' });
    const banks = json?.data || json?.banks || [];
    return Array.isArray(banks) ? banks : [];
  }
}

async function listBanksCached({ country = 'NG', ttlMs = 12 * 60 * 60_000 } = {}) {
  const key = `flw:banks:${String(country || 'NG').toUpperCase()}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const banks = await listBanks({ country });
  cacheSet(key, banks, Array.isArray(banks) && banks.length > 0 ? ttlMs : 30_000);
  return banks;
}

async function resolveAccount({ account_number, account_bank }) {
  const acct = String(account_number || '').trim();
  const bank = String(account_bank || '').trim();
  if (!acct || !bank) throw new Error('account_number and account_bank are required');
  const body = { account_number: acct, account_bank: bank };
  const json = await flwRequest('/accounts/resolve', { method: 'POST', body });
  return { raw: json, data: json?.data };
}

async function listBankBranches({ bank_id } = {}) {
  const bid = String(bank_id || '').trim();
  if (!bid) throw new Error('bank_id is required');
  const json = await flwRequest(`/banks/${encodeURIComponent(bid)}/branches`, { method: 'GET' });
  const branches = json?.data || json?.branches || [];
  return Array.isArray(branches) ? branches : [];
}

async function createBeneficiary({ account_number, account_bank, beneficiary_name, currency = 'NGN' }) {
  const acct = String(account_number || '').trim();
  const bank = String(account_bank || '').trim();
  const name = String(beneficiary_name || '').trim();
  const cur = String(currency || 'NGN').trim().toUpperCase();
  if (!acct || !bank || !name) throw new Error('account_number, account_bank and beneficiary_name are required');
  const body = {
    account_number: acct,
    account_bank: bank,
    beneficiary_name: name,
    currency: cur,
  };
  const json = await flwRequest('/beneficiaries', { method: 'POST', body });
  return { raw: json, data: json?.data };
}

async function createBulkTransfer({ title, bulk_data }) {
  const t = String(title || '').trim() || `bulk_${Date.now()}`;
  if (!Array.isArray(bulk_data) || bulk_data.length === 0) throw new Error('bulk_data must be a non-empty array');
  const body = {
    title: t,
    bulk_data,
  };
  const json = await flwRequest('/bulk-transfers', { method: 'POST', body });
  return { raw: json, data: json?.data };
}

async function getBulkTransfer({ batch_id }) {
  const bid = String(batch_id || '').trim();
  if (!bid) throw new Error('batch_id is required');
  const qs = new URLSearchParams({ batch_id: bid });
  const json = await flwRequest(`/bulk-transfers?${qs.toString()}`, { method: 'GET' });
  return { raw: json, data: json?.data };
}

async function getTransferFee({ amount, currency = 'NGN', type = 'account' }) {
  const amt = Number(amount);
  const cur = String(currency || 'NGN').toUpperCase();
  const t = String(type || 'account').trim().toLowerCase() || 'account';
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Invalid amount');

  const key = `flw_transfer_fee_${cur}_${t}_${amt.toFixed(2)}`;
  const cached = cacheGet(key);
  if (cached != null) return { raw: null, data: cached };

  const qs = new URLSearchParams({ amount: String(amt), currency: cur, type: t });
  const json = await flwRequest(`/transfers/fee?${qs.toString()}`, { method: 'GET' });
  const fee = json?.data?.fee ?? json?.data?.data?.fee;
  const res = {
    fee: fee != null ? Number(fee) : 0,
    currency: cur,
    type: t,
  };
  cacheSet(key, res, 5 * 60_000);
  return { raw: json, data: res };
}

module.exports = {
  createPaymentLink,
  createVirtualAccountNumber,
  createCustomer,
  createVirtualAccount,
  verifyTransaction,
  listTransactions,
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
  listBanks,
  listBanksCached,
  listBankBranches,
  resolveAccount,
  createBeneficiary,
  createBulkTransfer,
  getBulkTransfer,
  getTransferFee,
};
//testing