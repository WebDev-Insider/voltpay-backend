// Payvessel issuing - the USD Virtual Mastercard.
//
// A fourth Payvessel product on the same two credentials as the KYC check
// (payvessel.service.js) and the betting rail (payvesselBiller.service.js),
// under its own path family: /pms/api/external/request/virtual-cards/.
//
// Five properties of the API shape everything below:
//
//   1. Cards are funded from OUR Payvessel business USD wallet, never from the
//      customer. Create (issuance) and fund both debit that wallet, so an empty
//      wallet is our outage, not the customer's problem.
//   2. Create is asynchronous. A 201 is a card in PENDING with an id; the final
//      answer comes later, by polling Get a Card (or a webhook, when one can be
//      delivered - see webhookHeaders below).
//   3. Neither create nor fund takes a documented idempotency key, so neither is
//      EVER retried. An answer we could not read is `ambiguous`, and the caller
//      settles it later by reading the card back - never by asking again.
//   4. Get a Card returns the full PAN, CVV and expiry for an ACTIVE card. That
//      is the only per-card read there is, so it is also how the balance is
//      read. getCard() drops the credentials before returning unless the
//      caller asks for them by name (`withSecrets`), which only reveal does.
//      Nothing here logs or stores them.
//   5. Errors are classified for the customer HERE. `err.message` is always safe
//      to show; Payvessel's own text is `err.providerMessage`, for operators.
//      `err.kind` says what the caller may do with the money:
//         refused       Payvessel said no and nothing ran - refund
//         not_found     unknown card - nothing ran - refund
//         misconfigured our key, our environment - nothing ran - refund + page
//         float         our USD wallet is short - nothing ran - refund + page
//         rate_limited  429 - nothing ran - refund
//         ambiguous     sent, answer unreadable - DO NOT refund, settle later

const crypto = require('crypto');
const { withRetry } = require('../helpers/retry.helper');
const { getCreds } = require('./payvessel.service');

const PRODUCTION_HOST = 'https://api.payvessel.com';
const PATH = '/pms/api/external/request/virtual-cards/';

const envMs = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Read at call time, not load time: an env change (or a test) must not need a
// restart to take effect.
function baseUrl() {
  return String(process.env.PAYVESSEL_CARD_BASE_URL || PRODUCTION_HOST).trim().replace(/\/+$/, '');
}

function isSandboxHost(url = baseUrl()) {
  return /sandbox/i.test(url);
}

/** Payvessel keys are present. Says nothing about whether they work. */
function isConfigured() {
  return Boolean(
    String(process.env.PAYVESSEL_API_KEY || '').trim() &&
    String(process.env.PAYVESSEL_API_SECRET || '').trim(),
  );
}

// `statusCode` is PAYVESSEL's HTTP status (0 when no answer came back), because
// withRetry reads it to decide what is transient - a 401 stamped 503 would be
// re-sent three times. What WE answer the app is the service's call, by kind.
function cardError(kind, message, { statusCode = 0, providerMessage = '', payload = null } = {}) {
  const err = new Error(message);
  err.kind = kind;
  err.statusCode = statusCode;
  err.providerMessage = providerMessage;
  err.payvessel = payload;
  return err;
}

const OUTAGE_MESSAGE = 'USD cards are briefly unavailable. Please try again shortly.';

/**
 * Payvessel's words, made safe to show a customer: no HTML, one line, short,
 * and no long digit runs - a refusal can quote the BVN or NIN it refused.
 */
function cleanProviderText(text) {
  return String(text ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\d{6,}/g, '•••')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

const FIELD_LABELS = {
  first_name: 'First name',
  last_name: 'Last name',
  email: 'Email',
  phone: 'Phone number',
  bvn: 'BVN',
  nin: 'NIN',
  dob: 'Date of birth',
  image: 'Photo',
  state: 'State',
  lga: 'LGA',
  street: 'Street address',
  postal_code: 'Postal code',
  amount: 'Amount',
};

/** `{ message, errors: { bvn: ['Invalid BVN'] } }` -> "BVN: Invalid BVN". */
function providerMessageOf(json) {
  const errors = json?.errors && typeof json.errors === 'object' ? json.errors : null;
  if (errors) {
    for (const [field, value] of Object.entries(errors)) {
      const first = Array.isArray(value) ? value[0] : value;
      const text = cleanProviderText(typeof first === 'object' ? JSON.stringify(first) : first);
      if (text) return `${FIELD_LABELS[field] || field}: ${text}`;
    }
  }
  return cleanProviderText(json?.message || json?.detail || json?.error_message || '');
}

// Our wallet ran short. Payvessel answers a 400 for "insufficient wallet
// balance" (their error table), and the customer's wallet is never involved in
// a Payvessel call - so any "insufficient" on create or fund is ours.
const INSUFFICIENT = /insufficient|not enough (funds|balance)|low balance/i;

function assertEnvironment() {
  if (process.env.NODE_ENV === 'production') {
    if (isSandboxHost()) {
      throw cardError('misconfigured', OUTAGE_MESSAGE, {
        providerMessage: 'PAYVESSEL_CARD_BASE_URL points at the sandbox on production',
      });
    }
  }
  if (!isConfigured()) {
    throw cardError('misconfigured', OUTAGE_MESSAGE, {
      providerMessage: 'PAYVESSEL_API_KEY / PAYVESSEL_API_SECRET are not set',
    });
  }
}

/**
 * One call. `write: true` marks a call that moves money or changes the card -
 * it is never retried, and any answer we cannot read becomes `ambiguous`.
 */
async function request(path, { method = 'GET', body = null, write = false, timeoutMs, prefix = PATH } = {}) {
  assertEnvironment();
  const { apiKey, apiSecret } = getCreds();
  const url = `${baseUrl()}${prefix}${path}`;
  const limit = timeoutMs || envMs('PAYVESSEL_TIMEOUT_MS', 30_000);

  const call = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limit);
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          'api-key': apiKey,
          'api-secret': apiSecret,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      // Never reached an answer. For a write this is the dangerous case: the
      // request may have been executed, so it is not a refusal.
      if (write) {
        throw cardError('ambiguous', 'We are confirming this with our card partner.', {
          providerMessage: `transport: ${e?.name === 'AbortError' ? 'timeout' : e?.message || 'error'}`,
        });
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text().catch(() => '');
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    const status = response.status;
    const said = providerMessageOf(json);

    if (status === 401 || status === 403) {
      throw cardError('misconfigured', OUTAGE_MESSAGE, { statusCode: status, providerMessage: said || `HTTP ${status}`, payload: json });
    }
    if (status === 402 || (status === 400 && INSUFFICIENT.test(said))) {
      throw cardError('float', OUTAGE_MESSAGE, { statusCode: status, providerMessage: said || `HTTP ${status}`, payload: json });
    }
    if (status === 429) {
      throw cardError('rate_limited', OUTAGE_MESSAGE, { statusCode: 429, providerMessage: said || 'HTTP 429', payload: json });
    }
    if (status === 404) {
      throw cardError('not_found', 'We could not find this card with our card partner.', {
        statusCode: 404,
        providerMessage: said || 'HTTP 404',
        payload: json,
      });
    }
    // A 409 on a write is "that already exists" - for a create, possibly the
    // card we asked for. Settled by reading, never by refunding.
    if (write && status === 409) {
      throw cardError('ambiguous', 'We are confirming this with our card partner.', { statusCode: 409, providerMessage: said || 'HTTP 409', payload: json });
    }
    if (status >= 400 && status < 500) {
      throw cardError('refused', said || 'Our card partner declined this request.', {
        statusCode: status,
        providerMessage: said || `HTTP ${status}`,
        payload: json,
      });
    }
    if (status >= 500) {
      if (write) {
        throw cardError('ambiguous', 'We are confirming this with our card partner.', { statusCode: status, providerMessage: said || `HTTP ${status}`, payload: json });
      }
      throw cardError('outage', OUTAGE_MESSAGE, { statusCode: status, providerMessage: said || `HTTP ${status}`, payload: json });
    }

    // 2xx from here. An unreadable 2xx (an HTML page) proves nothing.
    if (!json || typeof json !== 'object') {
      if (write) {
        throw cardError('ambiguous', 'We are confirming this with our card partner.', { providerMessage: 'unreadable 2xx body' });
      }
      throw cardError('outage', OUTAGE_MESSAGE, { providerMessage: 'unreadable 2xx body' });
    }
    if (json.status === false) {
      if (INSUFFICIENT.test(said)) {
        throw cardError('float', OUTAGE_MESSAGE, { statusCode: status, providerMessage: said, payload: json });
      }
      throw cardError('refused', said || 'Our card partner declined this request.', { statusCode: status, providerMessage: said, payload: json });
    }
    return json;
  };

  if (write) return call();
  return withRetry(call, { label: `payvessel card ${method} ${path.split('/')[0] || 'list'}` });
}

/* ------------------------------------------------------------------ money */

/**
 * "3.00", 3, "1,250.5" -> integer cents. null for anything that is not money.
 * String arithmetic, not float: 0.1 + 0.2 must not become a cent.
 */
function toCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = typeof value === 'number' ? (Number.isFinite(value) ? value.toFixed(3) : '') : String(value).replace(/,/g, '').trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!m) return null;
  const frac = (m[3] || '').padEnd(3, '0');
  let cents = Number(m[2]) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1;
  if (!Number.isSafeInteger(cents)) return null;
  return m[1] ? -cents : cents;
}

/** 1234 -> "12.34", the shape Payvessel's amount fields take. */
function centsToUsd(cents) {
  const n = Math.trunc(Number(cents) || 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/* ------------------------------------------------------------- normalise */

const STATUSES = new Set(['PENDING', 'ACTIVE', 'FROZEN', 'TERMINATED', 'FAILED']);

function text(v) {
  return String(v ?? '').trim();
}

/**
 * One card, in the shape the engine reads. Credentials are copied out ONLY
 * when asked for, so the default object is safe to hand anywhere.
 */
function normalizeCard(data, { withSecrets = false } = {}) {
  const d = data && typeof data === 'object' ? data : {};
  const rawStatus = text(d.status).toUpperCase();
  const card = {
    id: text(d.id),
    // '' when Payvessel said nothing - e.g. a freeze acknowledged with no card
    // object. Never defaulted: an absent status is not evidence of any state.
    status: STATUSES.has(rawStatus) ? rawStatus : rawStatus,
    masked_pan: text(d.masked_pan),
    expiry: /^\d{2}\/\d{2}$/.test(text(d.expiry)) ? text(d.expiry) : '',
    name: text(d.card_name) || text(d.customer_name),
    // Both kept apart for reconciliation: card_name is what we sent, and
    // customer_name is Payvessel's own record of the person (register order,
    // upper case - "MUSA GANIYU" for a card named "Ganiyu Musa").
    card_name: text(d.card_name),
    customer_name: text(d.customer_name),
    kind: text(d.kind).toLowerCase(),
    brand: text(d.brand).toUpperCase(),
    currency: text(d.currency).toUpperCase() || 'USD',
    balance_cents: toCents(d.balance),
    created_at: text(d.created_datetime) || null,
  };
  if (withSecrets) {
    const pan = text(d.card_number).replace(/\s+/g, '');
    card.card_number = /^\d{12,19}$/.test(pan) ? pan : '';
    card.cvv = /^\d{3,4}$/.test(text(d.cvv)) ? text(d.cvv) : '';
    const addr = d.billing_address && typeof d.billing_address === 'object' ? d.billing_address : null;
    card.billing_address = addr
      ? {
          street: text(addr.street),
          city: text(addr.city),
          state: text(addr.state),
          postal_code: text(addr.postal_code),
          country: text(addr.country),
        }
      : null;
  }
  // A masked PAN from Get a Card is not always present (the list carries it,
  // the single read documents only the full number). Derive one from the full
  // number we were handed rather than leave the card face blank - first six
  // and last four only, which is what Payvessel's own masked_pan carries.
  if (!card.masked_pan) {
    const pan = text(d.card_number).replace(/\s+/g, '');
    if (/^\d{12,19}$/.test(pan)) card.masked_pan = `${pan.slice(0, 6)}${'*'.repeat(pan.length - 10)}${pan.slice(-4)}`;
  }
  return card;
}

/**
 * One card transaction - from the list endpoint or a webhook, whose shapes
 * differ - in one shape. `id` is the key our table is unique on.
 */
function normalizeTransaction(row, { cardId = '' } = {}) {
  const r = row && typeof row === 'object' ? row : {};
  const merchant = r.merchant && typeof r.merchant === 'object' ? r.merchant : null;
  const entry = text(r.entry || r.mode).toUpperCase();
  const type = text(r.type || r.event_type).toUpperCase().replace(/\s+/g, '_');
  const amount = toCents(r.amount);
  const occurred = text(r.date || r.created_datetime || r.created_at || r.transaction_date) || null;
  const id = text(r.id || r.reference || r.ref_id) ||
    // issuing.charge carries no reference at all; its own fields are the key.
    (amount != null && occurred ? `charge:${text(r.card_id) || cardId}:${occurred}:${amount}` : '');
  return {
    id,
    card_id: text(r.card_id) || cardId,
    amount_cents: amount == null ? 0 : Math.abs(amount),
    fee_cents: Math.abs(toCents(r.fee) || 0),
    currency: text(r.currency).toUpperCase() || 'USD',
    entry: entry === 'CREDIT' ? 'CREDIT' : 'DEBIT',
    status: text(r.status).toUpperCase(),
    type: type || 'UNKNOWN',
    merchant: text(merchant ? merchant.name : r.merchant || r.merchant_name),
    merchant_country: text(merchant?.country || r.merchant_country).toUpperCase().slice(0, 3),
    description: text(r.description),
    occurred_at: occurred,
  };
}

/* ------------------------------------------------------------- endpoints */

/**
 * POST /virtual-cards/ - asynchronous. Answers a PENDING card with an id.
 *
 * `reference` is not in the request schema but the lifecycle webhooks are
 * documented to echo "your-create-reference" back, so it is sent; it is also
 * what links the card row and the webhook when the create answer was lost.
 *
 * `prefundCents` is REQUIRED in practice. The docs call `prefund_amount`
 * optional; the live API refused a create without one - "card balance less
 * than initial minimum card balance of 1" (2026-10-14) - so a card is always
 * created holding at least $1.00, drawn from our USD wallet.
 */
async function createCard({ reference, kyc, name, brand = 'MASTERCARD', prefundCents = 100 }) {
  const body = {
    first_name: kyc.firstName,
    last_name: kyc.lastName,
    email: kyc.email,
    phone: kyc.phone,
    bvn: kyc.bvn,
    nin: kyc.nin,
    dob: kyc.dob,
    image: kyc.image,
    state: kyc.state,
    lga: kyc.lga,
    street: kyc.street,
    postal_code: kyc.postalCode,
    brand,
    currency: 'USD',
    // Standard card. Contactless is a different card with a different
    // issuance fee, and out of scope.
    is_contactless: false,
    prefund_amount: centsToUsd(Math.max(100, Math.trunc(Number(prefundCents) || 0))),
    card_name: String(name || '').slice(0, 255),
    reference: String(reference),
  };
  const json = await request('', {
    method: 'POST',
    body,
    write: true,
    timeoutMs: envMs('VCARD_CREATE_TIMEOUT_MS', 60_000),
  });
  const card = normalizeCard(json?.data);
  if (!card.id) {
    // Accepted, but no id to follow it by. The sweep finds it by reference.
    throw cardError('ambiguous', 'We are confirming this with our card partner.', { providerMessage: 'create answered with no card id', payload: null });
  }
  // Documented as starting PENDING; an answer that leaves it out means the same.
  if (!card.status) card.status = 'PENDING';
  return card;
}

async function getCard(cardId, { withSecrets = false } = {}) {
  const json = await request(`${encodeURIComponent(String(cardId))}/`);
  return normalizeCard(json?.data, { withSecrets });
}

/** Every card on our business. Masked PANs only. */
async function listCards({ status } = {}) {
  const query = status ? `?status=${encodeURIComponent(String(status).toUpperCase())}` : '';
  const json = await request(query);
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.map(row => ({ ...normalizeCard(row), reference: text(row?.reference) }));
}

/** POST /{card}/fund/ - never retried. Answers the card after the credit. */
async function fundCard(cardId, amountCents) {
  const json = await request(`${encodeURIComponent(String(cardId))}/fund/`, {
    method: 'POST',
    body: { amount: centsToUsd(amountCents) },
    write: true,
  });
  return normalizeCard(json?.data);
}

async function freezeCard(cardId) {
  const json = await request(`${encodeURIComponent(String(cardId))}/freeze/`, { method: 'POST', write: true });
  return normalizeCard(json?.data);
}

async function unfreezeCard(cardId) {
  const json = await request(`${encodeURIComponent(String(cardId))}/unfreeze/`, { method: 'POST', write: true });
  return normalizeCard(json?.data);
}

/**
 * POST /{card}/terminate/ - permanent. The card stops working and whatever it
 * held goes back to OUR business USD wallet ("minus fees", amount unstated).
 * Never retried, like every write; the engine reads the card back to learn
 * whether it closed, whatever this answers.
 */
async function terminateCard(cardId) {
  const json = await request(`${encodeURIComponent(String(cardId))}/terminate/`, { method: 'POST', write: true });
  return normalizeCard(json?.data);
}

/**
 * Our Payvessel business wallet, for the admin float tile. Payvessel's sample
 * answers in NGN; the currency is reported as given, never assumed to be USD.
 */
async function walletBalance() {
  const json = await request('', { prefix: '/pms/api/external/request/wallet/balance/' });
  const d = json?.data && typeof json.data === 'object' ? json.data : {};
  return {
    available_cents: toCents(d.available_balance),
    ledger_cents: toCents(d.ledger_balance),
    currency: text(d.currency).toUpperCase() || null,
  };
}

async function listTransactions(cardId, { size = 50 } = {}) {
  const n = Math.min(100, Math.max(1, Math.trunc(Number(size) || 50)));
  const json = await request(`${encodeURIComponent(String(cardId))}/transactions/?size=${n}`);
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.map(row => normalizeTransaction(row, { cardId })).filter(t => t.id);
}

/* --------------------------------------------------------------- webhook */

function webhookSecret() {
  const raw = String(process.env.PAYVESSEL_WEBHOOK_SECRET || process.env.PAYVESSEL_API_SECRET || '').trim();
  return raw.replace(/^bearer\s+/i, '');
}

// Payvessel's samples read `HTTP_PAYVESSEL_HTTP_SIGNATURE` - the CGI/Django
// spelling of a `Payvessel-Http-Signature` header - and their Node sample
// reads that literal name. Node keeps underscores, some proxies drop them, so
// every spelling is accepted.
const SIGNATURE_HEADERS = ['payvessel-http-signature', 'http_payvessel_http_signature', 'payvessel-signature', 'x-payvessel-signature'];

function signatureFrom(headers = {}) {
  for (const name of SIGNATURE_HEADERS) {
    const v = headers[name];
    if (v) return Array.isArray(v) ? v[0] : String(v);
  }
  return '';
}

/** HMAC-SHA512 of the raw body, hex, constant-time compared. */
function verifyWebhookSignature({ rawBody, signature }) {
  const secret = webhookSecret();
  if (!secret || !rawBody || !signature) return false;
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  const provided = String(signature).trim().replace(/^sha512=/i, '').toLowerCase();
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Payvessel's published sender addresses, opt-in through PAYVESSEL_WEBHOOK_IPS.
 * Checked against `req.ip` (which honours `trust proxy`), never a raw
 * X-Forwarded-For, whose left-most entry the caller writes.
 */
function webhookIpAllowed(ip) {
  const raw = String(process.env.PAYVESSEL_WEBHOOK_IPS ?? '').trim();
  if (!raw) return true;
  const allowed = new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
  return allowed.has(String(ip || '').trim().replace(/^::ffff:/, ''));
}

module.exports = {
  isConfigured,
  isSandboxHost,
  createCard,
  getCard,
  listCards,
  fundCard,
  freezeCard,
  unfreezeCard,
  terminateCard,
  listTransactions,
  walletBalance,
  verifyWebhookSignature,
  webhookIpAllowed,
  signatureFrom,
  toCents,
  centsToUsd,
  normalizeCard,
  normalizeTransaction,
  OUTAGE_MESSAGE,
  __test: { cleanProviderText, providerMessageOf, request, cardError },
};
