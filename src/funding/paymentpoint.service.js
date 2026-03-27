const crypto = require('crypto');

const PAYMENTPOINT_BASE_URL = 'https://api.paymentpoint.co';

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

function getPaymentPointApiKey() {
  const v = (process.env.PAYMENTPOINT_API_KEY || '').trim();
  if (!v) throw new Error('Missing required env: PAYMENTPOINT_API_KEY');
  return v;
}

function getPaymentPointSecretKey() {
  const v = (process.env.PAYMENTPOINT_SECRET_KEY || '').trim();
  if (!v) throw new Error('Missing required env: PAYMENTPOINT_SECRET_KEY');
  return v;
}

function getWebhookSecretKey() {
  const v = (process.env.PAYMENTPOINT_WEBHOOK_SECRET || '').trim();
  if (v) return v;
  return getPaymentPointSecretKey();
}

async function paymentpointRequest(path, { method = 'GET', body } = {}) {
  if (!fetchFn) {
    throw new Error('Fetch API is not available in this Node.js runtime');
  }

  const apiKey = getPaymentPointApiKey();
  const secret = getPaymentPointSecretKey();

  const timeoutMs = Math.max(1_000, Number(process.env.PAYMENTPOINT_TIMEOUT_MS) || 8_000);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let res;
  try {
    res = await fetchFn(`${PAYMENTPOINT_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
        'api-key': apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller ? controller.signal : undefined,
    });
  } catch (e) {
    const err = new Error(e?.name === 'AbortError' ? 'PaymentPoint request timed out' : (e?.message || 'PaymentPoint request failed'));
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

  const status = (json?.status || '').toString().toLowerCase();
  if (!res.ok || (status && status !== 'success')) {
    const msg = json?.message || text || `PaymentPoint request failed (${res.status})`;
    const err = new Error(msg);
    err.statusCode = res.status || 500;
    err.paymentpoint = json;
    throw err;
  }

  return json;
}

async function createVirtualAccount({ email, name, phoneNumber, bankCode, businessId }) {
  if (!email) throw new Error('email is required');
  if (!name) throw new Error('name is required');
  if (!phoneNumber) throw new Error('phoneNumber is required');
  if (!Array.isArray(bankCode) || bankCode.length === 0) throw new Error('bankCode must be a non-empty array');
  if (!businessId) throw new Error('businessId is required');

  const body = {
    email,
    name,
    phoneNumber,
    bankCode,
    businessId,
  };

  const json = await paymentpointRequest('/api/v1/createVirtualAccount', { method: 'POST', body });
  return { raw: json };
}

function verifyWebhookSignature({ rawBody, signature }) {
  const secret = getWebhookSecretKey();
  if (!rawBody) return false;
  if (!signature) return false;

  const computedHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const computedHexUpper = computedHex.toUpperCase();
  const computedBase64 = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');

  const provided = String(signature).trim().replace(/^sha256=/i, '');
  if (!provided) return false;

  try {
    const candidates = [computedHex, computedHexUpper, computedBase64];
    for (const computed of candidates) {
      const a = Buffer.from(computed, 'utf8');
      const b = Buffer.from(provided, 'utf8');
      if (a.length !== b.length) continue;
      if (crypto.timingSafeEqual(a, b)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

module.exports = {
  createVirtualAccount,
  verifyWebhookSignature,
};
