const crypto = require('crypto');

const { withRetry } = require('../helpers/retry.helper');

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

function budgetMs(envName, fallback) {
  return Math.max(1_000, Number(process.env[envName]) || fallback);
}

// Opening an account sends the NIN to PalmPay, who check it with NIMC before
// PaymentPoint answers. The general 8s budget cut those calls off while
// PaymentPoint went on to open the account, so the customer was told "not
// available" about an account that existed. 60s stays inside nginx's 120s and
// the 90s account lock; the app waits longer than this on that one call.
const requestTimeoutMs = () => budgetMs('PAYMENTPOINT_TIMEOUT_MS', 8_000);
const createTimeoutMs = () => budgetMs('PAYMENTPOINT_CREATE_TIMEOUT_MS', 60_000);

function tagged(message, fields) {
  return Object.assign(new Error(message), fields);
}

/**
 * Every failure carries `kind`, because the caller's question is not "did it
 * fail" but "could PaymentPoint have acted on it anyway":
 *
 *   config       our env, before anything was sent           - nothing happened
 *   unreachable  refused before a byte left (DNS, ECONNREFUSED) - nothing happened
 *   timeout      sent, answer not heard in time                - may have happened
 *   network      sent, connection lost before the answer       - may have happened
 *   unreadable   2xx with no JSON (an HTML page, an empty body) - may have happened
 *   http         non-2xx; `statusCode` and the body tell which
 *   declined     2xx JSON whose status word is a refusal
 */
const UNSENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

// `status` has arrived as "success", "Success", true and "00" from providers
// like this one; a status word we do not recognise as an acceptance is a
// refusal. Pending words are acceptances: the account may follow later.
const PENDING_WORDS = new Set(['pending', 'processing', 'in_progress', 'in progress', 'queued', 'accepted', 'submitted']);
const ACCEPTED_WORDS = new Set(['', 'success', 'successful', 'ok', 'true', '00', 'created', ...PENDING_WORDS]);

function statusWord(json) {
  if (!json || typeof json !== 'object') return '';
  let s = json.status ?? json.Status;
  if (s === undefined && typeof json.success === 'boolean') s = json.success;
  if (s === true) return 'success';
  if (s === false) return 'failed';
  return String(s ?? '').trim().toLowerCase();
}

function prim(v) {
  return typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
}

// Laravel-style refusals put the useful sentence under `errors`
// ({ message: "The given data was invalid.", errors: { email: ["The email has
// already been taken."] } }), so both are kept: `message` for the customer,
// `providerErrors` for classifying.
function errorStrings(json) {
  const out = [];
  const visit = v => {
    if (out.length >= 5) return;
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(json?.errors);
  visit(json?.error);
  return out;
}

function messageOf(json, text, status) {
  const said = prim(json?.message) || errorStrings(json)[0];
  if (said) return said;
  const t = String(text || '').trim();
  if (t && t.length <= 200 && !/[<>{}]/.test(t)) return t;
  return `PaymentPoint request failed (${status})`;
}

// Reads retry with backoff. createVirtualAccount does not: a repeat of an
// accepted request can hand the same user a second permanent account number.
async function paymentpointRequest(path, { method = 'GET', body, retry, timeoutMs } = {}) {
  const once = () => paymentpointRequestOnce(path, { method, body, timeoutMs });
  const shouldRetry = retry != null ? Boolean(retry) : String(method).toUpperCase() === 'GET';
  if (!shouldRetry) return once();
  return withRetry(once, { label: `paymentpoint ${path}` });
}

async function paymentpointRequestOnce(path, { method = 'GET', body, timeoutMs } = {}) {
  if (!fetchFn) {
    throw tagged('Fetch API is not available in this Node.js runtime', { kind: 'config', statusCode: 503 });
  }

  let apiKey;
  let secret;
  try {
    apiKey = getPaymentPointApiKey();
    secret = getPaymentPointSecretKey();
  } catch (e) {
    throw Object.assign(e, { kind: 'config', statusCode: 503 });
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  // Held until the body is read, not just the headers: a server that answers
  // the status line and then stalls must not hang the request forever.
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs || requestTimeoutMs()) : null;

  let res;
  let text;
  try {
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
      if (e?.name === 'AbortError') throw tagged('PaymentPoint request timed out', { kind: 'timeout', statusCode: 504 });
      const unsent = UNSENT_CODES.has(e?.cause?.code || e?.code);
      throw tagged(e?.message || 'PaymentPoint request failed', {
        kind: unsent ? 'unreachable' : 'network',
        statusCode: unsent ? 503 : 504,
      });
    }

    try {
      text = await res.text();
    } catch (e) {
      const timedOut = e?.name === 'AbortError';
      throw tagged(timedOut ? 'PaymentPoint request timed out' : 'PaymentPoint answer was cut off', {
        kind: timedOut ? 'timeout' : 'network',
        statusCode: 504,
      });
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    throw tagged(messageOf(json, text, res.status), {
      kind: 'http',
      statusCode: res.status || 500,
      paymentpoint: json,
      providerErrors: errorStrings(json),
    });
  }

  if (!json || typeof json !== 'object') {
    throw tagged(`PaymentPoint answered ${res.status} without JSON`, { kind: 'unreadable', statusCode: 502 });
  }

  if (!ACCEPTED_WORDS.has(statusWord(json))) {
    throw tagged(messageOf(json, text, res.status), {
      kind: 'declined',
      statusCode: res.status,
      paymentpoint: json,
      providerErrors: errorStrings(json),
    });
  }

  return json;
}

async function createVirtualAccount({ email, name, phoneNumber, bankCode, businessId, idType, idNumber }) {
  // Our own bugs, caught before anything is sent - so 'config', never ambiguous.
  const missing = (field) => tagged(`${field} is required`, { kind: 'config', statusCode: 500 });
  if (!email) throw missing('email');
  if (!name) throw missing('name');
  if (!phoneNumber) throw missing('phoneNumber');
  if (!Array.isArray(bankCode) || bankCode.length === 0) throw missing('bankCode');
  if (!businessId) throw missing('businessId');
  if (!idType) throw missing('idType');
  if (!idNumber) throw missing('idNumber');

  const body = {
    email,
    name,
    phoneNumber,
    bankCode,
    businessId,
    idType,
    idNumber,
  };

  const json = await paymentpointRequest('/api/v1/createVirtualAccount', {
    method: 'POST',
    body,
    timeoutMs: createTimeoutMs(),
  });
  return { raw: json };
}

// ---------------------------------------------------------------------------
// Reading an account out of whatever PaymentPoint sent
// ---------------------------------------------------------------------------
//
// The documented answer is { customer: { customer_id }, bankAccounts: [{
// accountNumber, ... }] }, and the rest of this file was written against it.
// The NIN-backed flow has not been seen live with its body logged, so every
// read below also accepts a `data` envelope, snake_case, a single account
// object instead of a list, and `customer.id`. A shape that still yields
// nothing is never guessed at: the caller keeps the attempt pending and logs
// describeShape(), which is keys only.

const ACCOUNT_LIST_KEYS = [
  'bankAccounts',
  'bank_accounts',
  'accounts',
  'virtualAccounts',
  'virtual_accounts',
  'virtualAccount',
  'virtual_account',
  'bankAccount',
  'bank_account',
  'account',
];
const ACCOUNT_NUMBER_KEYS = ['accountNumber', 'account_number', 'accountNo', 'account_no', 'virtualAccountNumber', 'virtual_account_number', 'nuban'];
const ACCOUNT_NAME_KEYS = ['accountName', 'account_name', 'virtualAccountName', 'virtual_account_name'];
const BANK_NAME_KEYS = ['bankName', 'bank_name', 'bank'];
const BANK_CODE_KEYS = ['bankCode', 'bank_code'];

// A NUBAN. Anything else - a reserved-account id, a reference - is not a
// number anybody can transfer to, and showing it would be worse than nothing.
const NUBAN = /^\d{10}$/;
const CUSTOMER_ID = /^[A-Za-z0-9_.:-]{1,80}$/;

const isObject = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function firstPrim(obj, keys) {
  for (const k of keys) {
    const v = prim(obj?.[k]);
    if (v) return v;
  }
  return '';
}

function envelopesOf(json) {
  const out = [];
  for (const v of [json, json?.data, json?.data?.data, json?.result]) {
    if (isObject(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/** One account object, or null when it holds no transferable number. */
function readAccount(obj) {
  if (!isObject(obj)) return null;
  const accountNumber = firstPrim(obj, ACCOUNT_NUMBER_KEYS).replace(/[\s-]/g, '');
  if (!NUBAN.test(accountNumber)) return null;
  return {
    accountNumber,
    accountName: firstPrim(obj, ACCOUNT_NAME_KEYS),
    bankName: firstPrim(obj, BANK_NAME_KEYS),
    bankCode: firstPrim(obj, BANK_CODE_KEYS),
  };
}

function readCustomerId(env) {
  const c = env?.customer;
  const v = isObject(c)
    ? prim(c.customer_id) || prim(c.customerId) || prim(c.id)
    : prim(c);
  const id = v || prim(env?.customer_id) || prim(env?.customerId);
  return CUSTOMER_ID.test(id) ? id : '';
}

/**
 * The account and customer id in a create response or an account event.
 * Prefers the PalmPay account when more than one comes back. Never throws.
 *
 * Do not point this at a payment notification: its envelope can carry the
 * sender's account number, which is somebody else's. receiverAccountNumber()
 * is the payment-side read.
 */
function extractVirtualAccount(json, { preferBankCode = '' } = {}) {
  const envelopes = envelopesOf(json);
  let customerId = '';
  const found = [];
  for (const env of envelopes) {
    customerId = customerId || readCustomerId(env);
    const candidates = [];
    for (const key of ACCOUNT_LIST_KEYS) {
      const v = env[key];
      if (Array.isArray(v)) candidates.push(...v);
      else if (isObject(v)) candidates.push(v);
    }
    candidates.push(env);
    for (const c of candidates) {
      const account = readAccount(c);
      if (account && !found.some(a => a.accountNumber === account.accountNumber)) found.push(account);
    }
  }

  const code = String(preferBankCode || '');
  const account =
    found.find(a => code && a.bankCode === code) || found.find(a => /palm/i.test(a.bankName)) || found[0] || null;
  return { customerId, account, accounts: found.length };
}

/** The virtual account a payment landed in - never the sender's - or null. */
function receiverAccount(payload) {
  for (const key of ['receiver', 'recipient', 'virtual_account', 'virtualAccount', 'beneficiary']) {
    const block = payload?.[key];
    const account = readAccount(block);
    if (account) return { ...account, accountName: account.accountName || prim(block.name) };
  }
  return null;
}

/** What PaymentPoint knows the customer by: the email and phone we sent it. */
function customerContact(payload) {
  const c = isObject(payload?.customer) ? payload.customer : {};
  return {
    email: prim(c.email) || prim(c.customer_email) || prim(payload?.customer_email),
    phone:
      prim(c.phone) ||
      prim(c.phone_number) ||
      prim(c.phoneNumber) ||
      prim(c.customer_phone_number) ||
      prim(payload?.customer_phone_number),
  };
}

function keysOf(v) {
  return isObject(v) ? Object.keys(v).slice(0, 30) : [];
}

/**
 * The shape of a body, for a log line: key names and counts, never a value.
 * This is what tells us, from one live attempt, where PaymentPoint put things.
 */
function describeShape(json) {
  if (!isObject(json)) return { type: json === null ? 'null' : Array.isArray(json) ? 'array' : typeof json };
  const data = json.data;
  const list = [json.bankAccounts, data?.bankAccounts, json.bank_accounts, data?.bank_accounts].find(Array.isArray);
  return {
    status: statusWord(json) || null,
    keys: keysOf(json),
    data_keys: Array.isArray(data) ? ['[array]'] : keysOf(data),
    customer_keys: keysOf(json.customer ?? data?.customer),
    accounts: list ? list.length : null,
    account_keys: list && isObject(list[0]) ? keysOf(list[0]) : [],
  };
}

/**
 * "This customer already exists" in any of the ways an API says it. Never
 * matches "does not exist".
 */
function isDuplicateWording(...texts) {
  return texts.some(text => {
    const t = String(text || '').toLowerCase();
    if (!t || /(does\s*not|doesn'?t|not)\s+exists?/.test(t)) return false;
    if (/\bduplicate\b/.test(t)) return true;
    return /\balready\b/.test(t) && /(exist|taken|registered|created|in use|used|linked|assigned|has an? )/.test(t);
  });
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
  extractVirtualAccount,
  receiverAccount,
  customerContact,
  describeShape,
  isDuplicateWording,
  statusWord,
  // exported for test/paymentpoint.service.test.js
  __test: { paymentpointRequestOnce, createTimeoutMs, requestTimeoutMs },
};
