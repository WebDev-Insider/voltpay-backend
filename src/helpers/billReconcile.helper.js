// The two fallbacks for a bill whose delivery notification never arrived.
//
// A purchase call returns "accepted", not "delivered". So there are three ways a
// bill reaches its final state:
//
//   1. the provider's webhook  - where the provider has one switched on;
//   2. the receipt poll        - when the customer is looking at the screen;
//   3. the sweep, on a timer   - when nobody is.
//
// "Final" includes the token on a prepaid meter. A bill the provider calls
// delivered but whose token has not reached us is `awaiting_token` - still
// open, still asked about - never successful (see billSettlement.helper).
//
// (1) is provider-specific and lives in each provider's webhook controller.
// (2) and (3) are this file. All three converge on billSettlement.helper, which
// is idempotent, so they can race freely.
//
// This is the layer that must be provider-aware, and getting it wrong is a
// money-losing bug rather than a cosmetic one: a bill whose gateway this does
// not recognise is never requeried, so it never settles and - if the vend
// actually failed - never refunds. The customer is just out of pocket.
//
// **What this must never touch is anything that is not a bills rail.**
// `bill_status` is not exclusive to bills - betting writes it too. A reference
// asked about on the wrong rail would at best waste a call and at worst settle
// a row against a stranger's transaction. That is why the gateway test is a
// membership check against the **named** bills adapters and never a wildcard
// or a truthiness test: a gateway this file does not own is skipped, and
// anything added later is skipped by default rather than swept up.
//
// Betting is also excluded by `remark`, on top of the gateway test. Today that
// is belt and braces - betting is Payvessel's, which is not a bills gateway -
// but betting has already been moved onto a bills provider once, and a row on a
// shared gateway would otherwise be settled here as well as by its own
// `settleOrder` (betting.controller), which marks a failure `refunded` rather
// than `failed`. Two settlements writing two vocabularies onto one row is how a
// receipt ends up saying both.
const prisma = require('../../database/prisma');
const bills = require('../funding/billsProvider');
const settlement = require('./billSettlement.helper');
const alerts = require('../services/alerts.service');

// A provider's rate budget is shared by the whole key - every catalogue read and
// every vend. A receipt screen polling every few seconds must not be able to
// spend it, so each transaction is requeried at most once per window no matter
// how often the poll asks.
const RECHECK_MS = Number(process.env.BILLS_RECHECK_MS || 15_000);

// Rows on a bills gateway that belong to another rail. See the header.
const NOT_BILLS_REMARKS = ['betting'];

// The states a provider can still be asked about.
const OPEN_STATES = ['processing', settlement.AWAITING_TOKEN];

const lastChecked = new Map();

function throttled(key) {
  const now = Date.now();
  const previous = lastChecked.get(key) || 0;
  if (now - previous < RECHECK_MS) return true;

  // Unbounded growth would be a slow leak on a long-lived process. The map only
  // ever holds in-flight bills, so this ceiling is never reached in practice -
  // it is here for the case where it is.
  if (lastChecked.size > 5000) lastChecked.clear();
  lastChecked.set(key, now);
  return false;
}

/** The bills gateways this file owns. Everything else is somebody else's row. */
function isBillsGateway(gateway) {
  return bills.isKnownProvider(gateway);
}

/**
 * Ask the upstream that sold this bill what happened to it, and settle it if the
 * answer is final.
 *
 * Returns the row's state after the attempt, so the receipt can render it
 * without a second read.
 *
 * The upstream is chosen from `meta.gateway` - the row's own record of who sold
 * it - never from the switch's current setting. Those differ the moment an admin
 * flips a rail, and asking the wrong provider about a reference it never issued
 * is how a live bill gets settled against nothing.
 *
 * A bill younger than `minAgeMs` is left alone: it was dispatched seconds ago
 * and asking again immediately just burns a call the vend itself may still be
 * holding open.
 */
async function reconcile(row, { minAgeMs = 20_000, maxAgeMs = 24 * 60 * 60_000 } = {}) {
  const meta = row?.meta && typeof row.meta === 'object' ? row.meta : {};
  const gateway = String(meta.gateway || '');

  if (!isBillsGateway(gateway)) return { checked: false, reason: 'other_gateway' };
  if (NOT_BILLS_REMARKS.includes(String(row?.remark || ''))) return { checked: false, reason: 'other_rail' };
  if (!OPEN_STATES.includes(String(meta.bill_status || ''))) return { checked: false, reason: 'not_processing' };

  const upstream = bills.adapterFor(gateway);

  // Normally the upstream's own order id, stamped when the vend was accepted.
  let reference = String(meta.provider_reference || '').trim();
  let byRequestId = false;

  if (!reference) {
    // No order id means the vend's response never reached us. On an upstream
    // that can be queried by the reference *we* generated, that is recoverable:
    // the order may well exist on their side under our trx. On one that can
    // only be queried by its own order id, there is nothing to ask with.
    if (!upstream.SUPPORTS_REQUEST_ID_LOOKUP) return { checked: false, reason: 'no_provider_reference' };
    reference = String(row.trx || '').trim();
    byRequestId = true;
    if (!reference) return { checked: false, reason: 'no_provider_reference' };
  }

  const age = Date.now() - new Date(row.created_at).getTime();
  if (age < minAgeMs) return { checked: false, reason: 'too_fresh' };
  // Past this age it has been asked dozens of times. What it needs is a person.
  if (age > maxAgeMs) return { checked: false, reason: 'too_old' };
  if (throttled(row.trx)) return { checked: false, reason: 'throttled' };

  let remote;
  try {
    remote = await upstream.getTransactionStatus(reference, { byRequestId });
  } catch (e) {
    console.error('bills.reconcile error:', { trx: row.trx, gateway, error: e?.message });
    return { checked: false, reason: 'provider_error' };
  }

  const result = await settlement.applyOutcome({
    trx: row.trx,
    status: remote.status,
    // A requery can carry the prepaid token. Passing it through costs nothing
    // when it is absent and rescues a receipt whose webhook was lost when it is
    // not.
    token: remote.token,
    units: remote.units,
    reason: 'Provider reported failure on requery',
  });

  // A vend whose response we lost, found alive under our own reference. Stamp
  // the upstream's order id so the next requery is a normal one.
  if (byRequestId && remote.reference_code) {
    await prisma.walletTransaction
      .update({
        where: { trx: row.trx },
        data: { meta: { ...meta, provider_reference: String(remote.reference_code) } },
      })
      .catch(() => null);
  }

  return { checked: true, status: remote.status, applied: result.applied, reason: result.reason };
}

/**
 * Settle bills that are still processing, on a timer.
 *
 * A webhook needs a reachable URL and the requery needs the customer to have the
 * receipt open. Neither is guaranteed, and a failed bill nobody asks about is a
 * customer silently out of pocket - so the outcome is also pulled from the
 * server, on a schedule (wired in server.js).
 *
 * `limit` is small on purpose. Twenty requeries every five minutes is four calls
 * a minute against a rate budget that live traffic is also spending. It is not
 * multiplied per provider: the rails share the sweep. `tokenLimit` more go to
 * bills awaiting a token, which are asked about in a pass of their own.
 */
async function sweepProcessingBills({
  limit = 20,
  tokenLimit = 5,
  olderThanMs = 3 * 60_000,
  windowMs = 24 * 60 * 60_000,
} = {}) {
  const now = Date.now();

  // One OR arm per bills gateway, generated from the registry so another
  // provider needs no edit here. Deliberately an allowlist of names: a bare
  // `bill_status: processing` filter would also pull in rows from rails this
  // file has no business asking anyone about. Betting is excluded by remark on
  // top - see the header.
  const gatewayFilter = Object.keys(bills.ADAPTERS).map(name => ({
    meta: { path: ['gateway'], equals: name },
  }));

  const rowsIn = (status, order, take) =>
    prisma.walletTransaction.findMany({
      where: {
        trx_type: '-',
        remark: { notIn: NOT_BILLS_REMARKS },
        created_at: { lt: new Date(now - olderThanMs), gt: new Date(now - windowMs) },
        AND: [{ OR: gatewayFilter }, { meta: { path: ['bill_status'], equals: status } }],
      },
      orderBy: { created_at: order },
      take,
    });

  const rows = await rowsIn('processing', 'asc', limit);
  // Delivered prepaid bills still waiting for their token. They are not in
  // flight - the provider has said yes - so they must never hold the slots a
  // failed bill needs to reach its refund. Newest first: a token that is coming
  // at all tends to come early, and one that has been asked about all afternoon
  // was raised to a person when it was parked.
  const tokenRows = await rowsIn(settlement.AWAITING_TOKEN, 'desc', tokenLimit);
  const swept = [...rows, ...tokenRows];

  let settled = 0;
  // Counted per gateway, because "which upstream is stuck" is the first thing
  // the responder needs and the whole reason the switch exists.
  const stuck = {};

  for (const row of swept) {
    try {
      const outcome = await reconcile(row, { minAgeMs: olderThanMs, maxAgeMs: windowMs });
      if (outcome.applied) {
        settled += 1;
      } else if (
        outcome.checked &&
        // Waiting on a token is not a stuck biller, and parking it raised its
        // own alert already.
        outcome.reason !== settlement.AWAITING_TOKEN &&
        now - new Date(row.created_at).getTime() > 60 * 60_000
      ) {
        // Still processing after an hour is not a slow biller any more.
        const gateway = String(row.meta?.gateway || 'unknown');
        stuck[gateway] = (stuck[gateway] || 0) + 1;
      }
    } catch (e) {
      console.error('bills.sweep error:', { trx: row.trx, error: e?.message });
    }
  }

  for (const [gateway, count] of Object.entries(stuck)) {
    alerts.paymentFailure({
      provider: gateway,
      action: 'stuck_bills',
      message: `${count} ${bills.PROVIDER_LABELS[gateway] || gateway} bill(s) still processing after an hour`,
      context: { checked: swept.length, settled },
    });
  }

  const stuckTotal = Object.values(stuck).reduce((a, b) => a + b, 0);
  return { checked: swept.length, settled, stuck: stuckTotal, stuck_by_gateway: stuck };
}

module.exports = { reconcile, sweepProcessingBills, isBillsGateway, __test: { throttled, NOT_BILLS_REMARKS } };
