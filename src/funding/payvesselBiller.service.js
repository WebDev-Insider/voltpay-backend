// Payvessel biller reseller - betting wallet funding.
//
// Replaces the ClubKonnect rail. Credentials are the same two flat headers as
// the KYC service (funding/payvessel.service.js); only the host prefix differs
// (`/vaas/api/v1/biller-reseller`).
//
// Call order: billers -> that biller's items -> validate the account -> create
// the order. Two properties of the order endpoint shape everything below:
//
//   1. Creating an order debits our Payvessel business wallet immediately, but
//      fulfilment is asynchronous. A created order is not a delivered one, so
//      `createOrder` is never retried and `verifyOrder` is the only authority
//      on the outcome.
//   2. `reference` is our own merchant reference and is what every later
//      lookup keys on, so the wallet transaction `trx` is used for it - one id
//      joins the ledger row, the webhook and the requery.

const { withRetry } = require('../helpers/retry.helper');
const { getCreds } = require('./payvessel.service');

const BASE_URL = String(process.env.PAYVESSEL_VAAS_BASE_URL || 'https://api.payvessel.com').replace(/\/+$/, '');
const PREFIX = '/vaas/api/v1/biller-reseller';
const DEFAULT_TIMEOUT_MS = Number(process.env.PAYVESSEL_TIMEOUT_MS || 30_000);

// Payvessel's floor for a betting order. Overridable because it is their
// number, not ours, and a biller that reports its own `min_amount` wins.
const MIN_AMOUNT = Number(process.env.PAYVESSEL_BETTING_MIN_AMOUNT || 100);

// Payvessel sells three categories - airtime, data and betting - but the
// billers endpoint returns no category field, so betting is "everything that
// is not one of the four Nigerian networks".
// ponytail: name match on the networks; switch to a category filter the day
// Payvessel ships one.
const NETWORK_NAME = /\b(mtn|glo|globacom|airtel|9\s*mobile|9mobile|etisalat)\b/i;

function providerError(message, { statusCode = 502, payload = null } = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.payvessel = payload;
  return err;
}

/**
 * @param {string}  path            appended to the biller-reseller prefix
 * @param {object}  opts
 * @param {string}  opts.method     GET unless stated
 * @param {object}  opts.body       JSON body, POST only
 * @param {boolean} opts.retry      off for anything that moves money
 */
async function request(path, { method = 'GET', body = null, retry = true } = {}) {
  const { apiKey, apiSecret } = getCreds();
  const url = `${BASE_URL}${PREFIX}${path}`;

  const call = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
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
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    // 402 is our wallet, not the customer's: the prepaid business wallet ran
    // dry. Said plainly so an operator funds it instead of chasing the user.
    if (response.status === 402) {
      throw providerError('Betting top-ups are temporarily unavailable', { statusCode: 503, payload: json });
    }

    if (!response.ok) {
      const message = String(json?.message || '').trim() || `Payvessel request failed (${response.status})`;
      throw providerError(message, { statusCode: response.status, payload: json });
    }

    // A 200 with `status: false` is still a refusal.
    if (json && json.status === false) {
      throw providerError(String(json.message || '').trim() || 'Payvessel declined the request', {
        statusCode: 400,
        payload: json,
      });
    }

    return json;
  };

  return retry ? withRetry(call, { label: `payvessel ${path}` }) : call();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// `Number(null)` and `Number('')` are both 0, so an absent limit has to be
// rejected before the cast or it becomes a ₦0 limit downstream.
function intOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** One biller, in the shape the betting screen consumes. */
function toCompany(row) {
  const code = String(row?.biller_id ?? '').trim();
  if (!code) return null;
  const min = intOrNull(row?.min_amount);
  const max = intOrNull(row?.max_amount);
  return {
    code,
    name: String(row?.biller_name ?? '').trim() || code,
    icon: String(row?.biller_icon ?? '').trim(),
    min_amount: min && min > 0 ? min : MIN_AMOUNT,
    // A ceiling of 0 is not a ceiling of zero naira - it is a biller that
    // published no ceiling. Sent as null so the screen reads it as "no cap".
    max_amount: max && max > 0 ? max : null,
  };
}

function isBettingBiller(row) {
  const name = String(row?.biller_name ?? '');
  if (NETWORK_NAME.test(name)) return false;
  // `status` is documented only as "biller availability"; an explicit 0 is the
  // one value safe to read as "down".
  if (row?.status != null && Number(row.status) === 0) return false;
  return true;
}

/** GET /billers, minus the airtime and data providers. */
async function listBettingCompanies() {
  const json = await request('/billers');
  return asArray(json?.data)
    .filter(isBettingBiller)
    .map(toCompany)
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** GET /billers/{biller_id}/items. */
async function listBillerItems(billerId) {
  const json = await request(`/billers/${encodeURIComponent(String(billerId))}/items`);
  return asArray(json?.data);
}

/**
 * The item id `createOrder` requires.
 *
 * A betting top-up is an arbitrary amount, so the variable-priced item is the
 * right one; the first item is the fallback for a biller that only lists one.
 */
async function resolveBettingItemId(billerId) {
  const items = await listBillerItems(billerId);
  if (!items.length) throw providerError('This betting company is not available right now', { statusCode: 400 });

  const variable = items.find(i => i?.is_fixed_amount === false || (i?.amount == null && i?.is_fixed_amount !== true));
  const item = variable || items[0];
  const itemId = String(item?.item_id ?? '').trim();
  if (!itemId) throw providerError('This betting company is not available right now', { statusCode: 400 });
  return itemId;
}

/**
 * POST /validate-account - resolve the betting account holder's name.
 *
 * @returns {Promise<string>} the provider's name for the account, '' if none
 */
async function validateAccount({ billerId, itemId, rechargeAccount }) {
  const body = { biller_id: String(billerId), recharge_account: String(rechargeAccount) };
  if (itemId) body.item_id = String(itemId);
  const json = await request('/validate-account', { method: 'POST', body });
  return String(json?.data?.biller ?? json?.data?.customer_name ?? '').trim();
}

const TERMINAL_OK = new Set(['success', 'successful', 'completed']);
const TERMINAL_BAD = new Set(['failed', 'cancelled', 'canceled', 'reversed']);

/**
 * Collapse an order payload into the three outcomes a caller can act on.
 * Anything unrecognised is `processing` - the safe reading, because it leaves
 * the money where it is until a later verify says otherwise.
 */
function normalizeOrder(payload) {
  const order = payload?.data && typeof payload.data === 'object' ? payload.data : payload || {};
  const raw = String(order?.status ?? '').trim().toLowerCase();

  return {
    status: TERMINAL_OK.has(raw) ? 'success' : TERMINAL_BAD.has(raw) ? 'failed' : 'processing',
    raw_status: raw,
    merchant_reference: String(order?.merchant_reference ?? order?.reference ?? '').trim(),
    order_reference: String(order?.order_reference ?? order?.id ?? '').trim(),
    error_message: String(order?.error_message ?? '').trim() || null,
  };
}

/**
 * POST /orders. Never retried: a repeat is a second top-up, and the timeout
 * that would trigger one says nothing about whether the first landed. A
 * timed-out order is recovered by `verifyOrder(reference)`.
 */
async function createOrder({ billerId, itemId, rechargeAccount, amount, reference, webhookUrl }) {
  const body = {
    biller_id: String(billerId),
    item_id: String(itemId),
    recharge_account: String(rechargeAccount),
    amount: Math.trunc(Number(amount)),
    reference: String(reference).slice(0, 32),
  };
  if (webhookUrl) body.webhook_url = String(webhookUrl);

  const json = await request('/orders', { method: 'POST', body, retry: false });
  return normalizeOrder(json);
}

/** GET /orders/verify/{reference} - forces a fresh status read at Payvessel. */
async function verifyOrder(reference) {
  const json = await request(`/orders/verify/${encodeURIComponent(String(reference))}`);
  return normalizeOrder(json);
}

module.exports = {
  listBettingCompanies,
  listBillerItems,
  resolveBettingItemId,
  validateAccount,
  createOrder,
  verifyOrder,
  MIN_AMOUNT,
  __test: { isBettingBiller, toCompany, normalizeOrder },
};
