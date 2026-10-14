const crypto = require('crypto');

const { withRetry } = require('../helpers/retry.helper');

const PAYSTACK_BASE_URL = 'https://api.paystack.co';

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

function getDefaultChannels() {
  const raw = (process.env.PAYSTACK_CHANNELS || '').trim();
  if (!raw) return ['card', 'bank_transfer', 'bank', 'ussd'];
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function getPaystackSecretKey() {
  const v = (process.env.PAYSTACK_SECRET_KEY || '').trim();
  if (!v) throw new Error('Missing required env: PAYSTACK_SECRET_KEY');
  return v;
}

// Reads retry with backoff; a transfer or a charge does not. A POST that timed
// out may have moved money, and the verify poll is what settles those.
async function paystackRequest(path, { method = 'GET', body, retry } = {}) {
  const once = () => paystackRequestOnce(path, { method, body });
  const shouldRetry = retry != null ? Boolean(retry) : String(method).toUpperCase() === 'GET';
  if (!shouldRetry) return once();
  return withRetry(once, { label: `paystack ${path.split('?')[0]}` });
}

async function paystackRequestOnce(path, { method = 'GET', body } = {}) {
  if (!fetchFn) {
    throw new Error('Fetch API is not available in this Node.js runtime');
  }

  const secret = getPaystackSecretKey();

  const timeoutMs = Math.max(1_000, Number(process.env.PAYSTACK_TIMEOUT_MS) || 5_000);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let res;
  try {
    res = await fetchFn(`${PAYSTACK_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller ? controller.signal : undefined,
    });
  } catch (e) {
    const err = new Error(e?.name === 'AbortError' ? 'Paystack request timed out' : (e?.message || 'Paystack request failed'));
    err.statusCode = 504;
    throw err;
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok || json?.status === false) {
    const msg = json?.message || text || `Paystack request failed (${res.status})`;
    const err = new Error(msg);
    err.statusCode = res.status || 500;
    err.paystack = json;
    throw err;
  }

  return json;
}

async function initializeTransaction({ email, amountKobo, reference, callback_url, metadata, channels }) {
  if (!email) throw new Error('email is required');
  if (!Number.isInteger(amountKobo) || amountKobo <= 0) throw new Error('amountKobo must be a positive integer');
  if (!reference) throw new Error('reference is required');

  const resolvedChannels = Array.isArray(channels) && channels.length ? channels : getDefaultChannels();

  const body = {
    email,
    amount: amountKobo,
    reference,
    callback_url,
    currency: 'NGN',
    metadata,
    channels: resolvedChannels,
  };

  const json = await paystackRequest('/transaction/initialize', { method: 'POST', body });
  const url = json?.data?.authorization_url;
  const ref = json?.data?.reference;
  if (!url || !ref) {
    const err = new Error('Paystack did not return authorization_url/reference');
    err.paystack = json;
    throw err;
  }

  return { authorization_url: url, reference: ref, raw: json };
}

async function verifyTransaction(reference) {
  if (!reference) throw new Error('reference is required');
  const json = await paystackRequest(`/transaction/verify/${encodeURIComponent(String(reference))}`, { method: 'GET' });
  return { raw: json, data: json?.data };
}

// --- banks & account resolution -------------------------------------------

const bankCache = new Map(); // currency -> { rows, expiresAt }

async function listBanks({ currency = 'NGN' } = {}) {
  const key = String(currency).toUpperCase();
  const hit = bankCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.rows;

  const json = await paystackRequest(`/bank?currency=${encodeURIComponent(key)}&perPage=200`);
  const rows = Array.isArray(json?.data) ? json.data : [];
  const ttlMs = Math.max(60_000, Number(process.env.PAYSTACK_BANK_CACHE_MS) || 24 * 60 * 60 * 1000);
  bankCache.set(key, { rows, expiresAt: Date.now() + ttlMs });
  return rows;
}

async function resolveAccount({ account_number, bank_code }) {
  const acct = String(account_number || '').replace(/\D/g, '');
  const code = String(bank_code || '').trim();
  if (!acct || !code) throw new Error('account_number and bank_code are required');

  const json = await paystackRequest(`/bank/resolve?account_number=${encodeURIComponent(acct)}&bank_code=${encodeURIComponent(code)}`);
  return { raw: json, data: json?.data };
}

// --- transfers -------------------------------------------------------------

async function createTransferRecipient({ name, account_number, bank_code }) {
  const body = {
    type: 'nuban',
    name: String(name || '').trim() || 'Staff',
    account_number: String(account_number || '').replace(/\D/g, ''),
    bank_code: String(bank_code || '').trim(),
    currency: 'NGN',
  };
  if (!body.account_number || !body.bank_code) throw new Error('account_number and bank_code are required');

  const json = await paystackRequest('/transferrecipient', { method: 'POST', body });
  const code = json?.data?.recipient_code;
  if (!code) {
    const err = new Error('Paystack did not return a recipient_code');
    err.paystack = json;
    throw err;
  }
  return { recipient_code: code, raw: json };
}

async function initiateTransfer({ amountKobo, recipient, reference, reason }) {
  if (!Number.isInteger(amountKobo) || amountKobo <= 0) throw new Error('amountKobo must be a positive integer');
  if (!recipient) throw new Error('recipient is required');
  if (!reference) throw new Error('reference is required');

  const json = await paystackRequest('/transfer', {
    method: 'POST',
    body: { source: 'balance', amount: amountKobo, recipient, reference, reason: reason || 'Salary payment', currency: 'NGN' },
  });
  return { data: json?.data, raw: json };
}

async function verifyTransfer(reference) {
  if (!reference) throw new Error('reference is required');
  const json = await paystackRequest(`/transfer/verify/${encodeURIComponent(String(reference))}`);
  return { data: json?.data, raw: json };
}

/**
 * What the integration holds to pay transfers from, in kobo. Read by the ops
 * screens only - Paystack is the authority at transfer time, and a balance read
 * a second earlier is not a reservation.
 */
async function getBalance() {
  const json = await paystackRequest('/balance');
  const rows = Array.isArray(json?.data) ? json.data : [];
  const ngn = rows.find(r => String(r?.currency || '').toUpperCase() === 'NGN');
  if (!ngn) return null;
  const kobo = Number(ngn.balance);
  return { balance_kobo: Number.isFinite(kobo) ? kobo : 0, currency: 'NGN' };
}

// Paystack publishes flat NGN transfer fees rather than an API to quote them,
// so the tiers live here. Overridable because Paystack has changed them before
// and a wrong fee under-reserves the wallet.
function transferFeeNaira(amountNaira) {
  const amount = Number(amountNaira);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const small = Number(process.env.PAYSTACK_TRANSFER_FEE_SMALL) || 10;
  const mid = Number(process.env.PAYSTACK_TRANSFER_FEE_MID) || 25;
  const large = Number(process.env.PAYSTACK_TRANSFER_FEE_LARGE) || 50;
  if (amount <= 5_000) return small;
  if (amount <= 50_000) return mid;
  return large;
}

// --- dedicated virtual accounts -------------------------------------------

async function createCustomer({ email, first_name, last_name, phone }) {
  if (!email) throw new Error('email is required');
  const json = await paystackRequest('/customer', {
    method: 'POST',
    body: { email, first_name, last_name, phone },
  });
  const code = json?.data?.customer_code;
  if (!code) {
    const err = new Error('Paystack did not return a customer_code');
    err.paystack = json;
    throw err;
  }
  return { customer_code: code, raw: json };
}

async function createDedicatedAccount({ customer_code, preferred_bank, phone }) {
  if (!customer_code) throw new Error('customer_code is required');
  const bank = String(preferred_bank || process.env.PAYSTACK_DVA_PREFERRED_BANK || 'wema-bank').trim();

  const json = await paystackRequest('/dedicated_account', {
    method: 'POST',
    body: { customer: customer_code, preferred_bank: bank, phone },
  });

  const data = json?.data || {};
  const account_number = String(data?.account_number || '').trim();
  const bank_name = String(data?.bank?.name || '').trim();
  if (!account_number || !bank_name) {
    const err = new Error('Paystack did not return dedicated account details');
    err.paystack = json;
    throw err;
  }

  return { account_number, bank_name, dedicated_account_id: data?.id != null ? String(data.id) : null, raw: json };
}

/**
 * Take a dedicated virtual account out of service.
 *
 * Called when the owner's account is closed: a DVA left live keeps accepting
 * transfers into a wallet nobody can sign in to, and the money then has to be
 * traced and returned by hand. Paystack keeps the record, so this does not
 * destroy anything the ledger is reconciled from.
 */
async function deactivateDedicatedAccount(dedicatedAccountId) {
  if (!dedicatedAccountId) return { deactivated: false, reason: 'no_dedicated_account' };
  const json = await paystackRequest(`/dedicated_account/${encodeURIComponent(String(dedicatedAccountId))}`, {
    method: 'DELETE',
  });
  return { deactivated: json?.status !== false, raw: json };
}

/**
 * Resolve a `CUS_...` code to the numeric customer id. `/transaction?customer=`
 * only matches on the id - passed a customer_code it silently returns an empty
 * list, which reads exactly like "this customer never paid".
 */
async function getCustomerId(customerCode) {
  if (!customerCode) return null;
  const json = await paystackRequest(`/customer/${encodeURIComponent(String(customerCode))}`);
  const id = json?.data?.id;
  return id != null ? String(id) : null;
}

async function listTransactions({ status = 'success', from, to, page = 1, perPage = 50, customer } = {}) {
  const qs = new URLSearchParams({ status, page: String(page), perPage: String(perPage) });
  if (from) qs.set('from', String(from));
  if (to) qs.set('to', String(to));
  if (customer) qs.set('customer', String(customer));
  const json = await paystackRequest(`/transaction?${qs.toString()}`);
  return { data: Array.isArray(json?.data) ? json.data : [], raw: json };
}

function verifyWebhookSignature({ rawBody, signature }) {
  const secret = getPaystackSecretKey();
  if (!rawBody) return false;
  if (!signature) return false;
  const computed = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  return String(signature).trim() === computed;
}

module.exports = {
  initializeTransaction,
  verifyTransaction,
  verifyWebhookSignature,
  listBanks,
  resolveAccount,
  createTransferRecipient,
  initiateTransfer,
  verifyTransfer,
  getBalance,
  transferFeeNaira,
  createCustomer,
  createDedicatedAccount,
  deactivateDedicatedAccount,
  listTransactions,
  getCustomerId,
};
