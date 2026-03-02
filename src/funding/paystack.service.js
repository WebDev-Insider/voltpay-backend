const crypto = require('crypto');

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

async function paystackRequest(path, { method = 'GET', body } = {}) {
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
};
