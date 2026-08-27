// Betting wallet top-ups, on the Payvessel biller-reseller rail.
//
// Screen flow: companies -> verify (resolve the account holder) -> store (park
// a pending payload) -> POST /verify-pin, which is where the debit and the
// order actually happen (controllers/verification.controller.js).
//
// The order settles asynchronously at Payvessel, so this file also owns the
// after-the-fact half: the webhook and the requery both funnel into
// `settleOrder`, which is the only place a betting row changes outcome.

const prisma = require('../../database/prisma');
const { Prisma } = require('@prisma/client');
const { setPending } = require('../services/pending.service');
const { applyBalanceDelta } = require('../helpers/balance.helper');
const { protectText } = require('../helpers/pii.helper');
const {
  listBettingCompanies,
  resolveBettingItemId,
  validateAccount,
  verifyOrder,
  MIN_AMOUNT,
} = require('../funding/payvesselBiller.service');

const companiesCache = new Map();
const verifyCache = new Map();

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

function moneyStr(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0.00';
  return num.toFixed(2);
}

/** The company list, cached - it changes about as often as a biller signs up. */
async function getCompanies() {
  const cached = cacheGet(companiesCache, 'companies');
  if (cached) return cached;

  const list = await listBettingCompanies();
  cacheSet(companiesCache, 'companies', list, list.length ? 15 * 60_000 : 30_000);
  return list;
}

async function findCompany(code) {
  const wanted = String(code || '').trim();
  if (!wanted) return null;
  const list = await getCompanies();
  return list.find(c => c.code === wanted) || null;
}

async function companies(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const list = await getCompanies();
    const balance = user?.balance?.toString ? Number(user.balance.toString()) : Number(user?.balance || 0);

    return res.json({
      remark: 'betting_companies',
      status: 'success',
      message: ['OK'],
      data: {
        companies: list,
        min_amount: MIN_AMOUNT,
        current_balance: moneyStr(balance),
      },
    });
  } catch (e) {
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed to load companies'], data: null });
  }
}

// The account holder's name, and the `item_id` the order will need. Resolved
// together because both come from the same biller and the screen already waits
// here - doing it at store time would put a provider round trip between the
// PIN keypad and the debit.
async function verifyCustomer(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const betting_company = String(req.body?.betting_company || req.body?.biller_id || '').trim();
    const customer_id = String(req.body?.customer_id || '').trim();

    if (!betting_company || !customer_id) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['betting_company and customer_id are required'], data: null });
    }

    const company = await findCompany(betting_company);
    if (!company) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Unknown betting company'], data: null });
    }

    const key = `${betting_company}|${customer_id}`;
    const cached = cacheGet(verifyCache, key);
    if (cached) {
      return res.json({ remark: 'verified', status: 'success', message: ['OK'], data: cached });
    }

    const itemId = await resolveBettingItemId(company.code);
    const resolved = await validateAccount({
      billerId: company.code,
      itemId,
      rechargeAccount: customer_id,
    });

    // A rejected account throws, so reaching here means Payvessel accepted it.
    // Not every biller hands back a name though - Bet9ja answers with the
    // account id itself. Echoing that back as "customer name" would dress a
    // format check up as an identity check, so it is dropped and the screen
    // says "verified" instead of inventing a person.
    const customerName = resolved && resolved !== customer_id ? resolved : '';

    const data = {
      customer_name: customerName,
      account_verified: true,
      betting_company: company.code,
      betting_company_name: company.name,
      customer_id,
      item_id: itemId,
    };
    cacheSet(verifyCache, key, data, 10 * 60_000);
    return res.json({ remark: 'verified', status: 'success', message: ['OK'], data });
  } catch (e) {
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed to verify customer'], data: null });
  }
}

async function store(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const betting_company = String(req.body?.betting_company || '').trim();
    const customer_id = String(req.body?.customer_id || '').trim();
    const amount = Number(req.body?.amount);
    const remark = String(req.body?.remark || 'betting').trim();

    if (!betting_company || !customer_id || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid input'], data: null });
    }

    const company = await findCompany(betting_company);
    if (!company) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Unknown betting company'], data: null });
    }

    // The biller's own floor when it publishes one, Payvessel's otherwise.
    const min = Number(company.min_amount) || MIN_AMOUNT;
    if (amount < min) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: [`Minimum betting amount is ₦${min}`], data: null });
    }
    if (company.max_amount && amount > Number(company.max_amount)) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: [`Maximum betting amount is ₦${company.max_amount}`], data: null });
    }

    const key = `${betting_company}|${customer_id}`;
    const cached = cacheGet(verifyCache, key);
    const customer_name = String(cached?.customer_name || '').trim();
    const item_id = String(cached?.item_id || '').trim() || (await resolveBettingItemId(company.code));

    const payload = {
      betting_company: company.code,
      betting_company_name: company.name,
      item_id,
      customer_id,
      customer_name: customer_name || null,
      amount: Number(amount),
    };

    await setPending(user.id, remark, payload, { ttlMs: 5 * 60_000 });

    // Priced here so the confirmation sheet renders the server's numbers rather
    // than re-deriving them from the form - same envelope the bill rails return
    // from POST /bills/quote, so betting reuses their sheet unchanged.
    //
    // Identifiers only: the sheet draws total, charge and balance itself, and a
    // duplicate Amount row would sit directly above the Total saying the same
    // thing. Betting carries no fee, so the debit is the amount.
    const summary = [{ label: 'Company', value: company.name }, { label: 'Customer ID', value: customer_id }];
    if (customer_name) summary.push({ label: 'Customer name', value: customer_name });

    const balance = Number(user.balance?.toString?.() ?? user.balance ?? 0);
    return res.json({
      remark: 'pin',
      status: 'success',
      message: ['Proceed to PIN'],
      data: {
        service: 'betting',
        title: `${company.name} top-up`,
        provider: company.name,
        summary,
        amount: moneyStr(amount),
        charge: '0.00',
        total: moneyStr(amount),
        balance: moneyStr(balance),
        sufficient_balance: balance >= amount,
        expires_in_seconds: 300,
      },
    });
  } catch (e) {
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

/* ------------------------------------------------------------------ settle */

/**
 * Apply a verified order outcome to the ledger row, once.
 *
 * Payvessel debits us at order creation and fulfils afterwards, so the row is
 * written as `Processing` and lands here when the answer is known. A failed
 * order means the customer's betting wallet was never funded, so the naira
 * goes back - that credit is what makes this worth having rather than a
 * cosmetic status update.
 *
 * @returns {Promise<'processing'|'successful'|'failed'|'unchanged'>}
 */
async function settleOrder(trx, order) {
  const row = await prisma.walletTransaction.findUnique({ where: { trx } });
  if (!row || row.remark !== 'betting') return 'unchanged';

  const meta = (row.meta && typeof row.meta === 'object') ? row.meta : {};
  const other = (row.other_data && typeof row.other_data === 'object') ? row.other_data : {};

  // Already terminal. A late webhook for a settled order is normal and must
  // not refund a second time.
  if (meta.bill_status === 'successful' || meta.bill_status === 'refunded') return 'unchanged';

  const nextMeta = {
    ...meta,
    provider_reference: order.order_reference || meta.provider_reference || '',
    bill_status: order.status === 'success' ? 'successful' : order.status === 'failed' ? 'refunded' : 'processing',
    provider_status: order.raw_status || '',
  };

  if (order.status === 'processing') {
    await prisma.walletTransaction.update({ where: { trx }, data: { meta: nextMeta } });
    return 'processing';
  }

  if (order.status === 'success') {
    await prisma.walletTransaction.update({
      where: { trx },
      data: { meta: nextMeta, other_data: { ...other, feedback: 'Successful' } },
    });
    return 'successful';
  }

  // Failed: give the money back and leave a matching credit, so the statement
  // shows the debit and its reversal rather than a balance that silently healed.
  const debit = new Prisma.Decimal(row.total_amount ?? row.amount);
  try {
    await prisma.$transaction(async tx => {
      await applyBalanceDelta(tx, 'user', row.user_id, debit);
      await tx.walletTransaction.create({
        data: {
          user_id: Number(row.user_id),
          trx: `${trx}_r`,
          trx_type: '+',
          amount: debit,
          charge: new Prisma.Decimal('0.00'),
          total_amount: debit,
          remark: 'betting',
          details: row.details,
          other_data: {
            title: 'Betting refund',
            subtitle: other.subtitle || '',
            feedback: 'Refunded',
            note: 'Provider declined',
            image_src: '',
          },
          meta: {
            gateway: 'payvessel',
            reference: `${trx}_r`,
            reversal_of: trx,
            bill_status: 'refunded',
          },
        },
      });
      await tx.walletTransaction.update({
        where: { trx },
        data: { meta: nextMeta, other_data: { ...other, feedback: 'Failed', note: 'Refunded' } },
      });
    });
  } catch (e) {
    // A refund that fails is a real incident: the user is out of pocket and
    // nothing was delivered. Ids only - never the provider reason, which can
    // quote a betting account id.
    console.error('betting.refund FAILED - manual settlement required:', {
      user_id: row.user_id,
      trx,
      error: e?.message,
    });
    return 'unchanged';
  }

  return 'failed';
}

/* ------------------------------------------------------------- requery/hook */

// Receipt refresh. Keyed on our own trx, which is the merchant reference the
// order was created with.
async function query(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const trx = String(req.query?.trx || req.query?.reference || req.query?.request_id || '').trim();
    if (!trx) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['trx is required'], data: null });
    }

    const row = await prisma.walletTransaction.findUnique({ where: { trx } });
    // Same 404 for "no such transaction" and "not yours" - the distinction
    // would turn this into a lookup oracle for other people's references.
    if (!row || Number(row.user_id) !== Number(user.id) || row.remark !== 'betting') {
      return res.status(404).json({ remark: 'not_found', status: 'error', message: ['Transaction not found'], data: null });
    }

    const order = await verifyOrder(trx);
    const outcome = await settleOrder(trx, order);

    return res.json({
      remark: 'betting_query',
      status: 'success',
      message: ['OK'],
      data: {
        trx,
        status: order.status,
        settled: outcome,
        provider_reference: order.order_reference || null,
      },
    });
  } catch (e) {
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed to query transaction'], data: null });
  }
}

// Payvessel order webhook. The payload is not signed in any documented way, so
// nothing in the body is believed: it is read for a reference only, and the
// outcome is re-fetched from Payvessel over our own authenticated call.
async function callback(req, res) {
  try {
    const payload = (req.body && Object.keys(req.body).length) ? req.body : (req.query || {});
    const body = payload?.data && typeof payload.data === 'object' ? payload.data : payload;

    const reference = String(body?.merchant_reference || body?.reference || '').trim();
    if (!reference) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['merchant_reference is required'], data: null });
    }

    const order = await verifyOrder(reference);
    await settleOrder(reference, order);

    return res.json({ remark: 'ok', status: 'success', message: ['OK'], data: null });
  } catch (e) {
    console.error('betting.callback error:', e?.message);
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to process callback'], data: null });
  }
}

/**
 * Settle betting orders that are still processing.
 *
 * The webhook needs a publicly reachable URL and the requery needs the user to
 * open the receipt; neither is guaranteed, and a failed order that nobody asks
 * about is a customer silently out of pocket. So the outcome is also pulled on
 * a timer, from the server (server.js).
 *
 * Rows younger than `olderThanMs` are skipped - the order was created seconds
 * ago and asking Payvessel again immediately just burns a call. Rows older
 * than the window are left alone: at that age this has already asked dozens of
 * times, and what is needed is a human, not another poll.
 */
async function sweepProcessingOrders({ limit = 20, olderThanMs = 2 * 60_000, windowMs = 3 * 24 * 60 * 60_000 } = {}) {
  const now = Date.now();
  const rows = await prisma.walletTransaction.findMany({
    where: {
      remark: 'betting',
      trx_type: '-',
      created_at: { lt: new Date(now - olderThanMs), gt: new Date(now - windowMs) },
      meta: { path: ['bill_status'], equals: 'processing' },
    },
    orderBy: { created_at: 'asc' },
    take: limit,
  });

  let settled = 0;
  for (const row of rows) {
    try {
      const outcome = await settleOrder(row.trx, await verifyOrder(row.trx));
      if (outcome === 'successful' || outcome === 'failed') settled += 1;
    } catch (e) {
      // Ids only - a provider message can quote a betting account id.
      console.error('betting.sweep error:', { trx: row.trx, error: e?.message });
    }
  }

  return { checked: rows.length, settled };
}

module.exports = { companies, verifyCustomer, store, query, callback, settleOrder, sweepProcessingOrders };
