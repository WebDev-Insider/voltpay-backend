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
//
// **One upstream cannot be asked about our own reference at all.** CashBuddy's
// purchase call carries no reference of ours, and its lookup takes only its
// own - so a purchase whose answer was lost has no key to look up by. Such a
// row is written `unconfirmed` and found here by what it was instead (see
// reconcileUnconfirmed): the account's own bill history, matched on amount,
// recipient and time, never guessing between two. It is refunded only after
// repeated complete looks have found nothing for half an hour.
const prisma = require('../../database/prisma');
const bills = require('../funding/billsProvider');
const settlement = require('./billSettlement.helper');
const alerts = require('../services/alerts.service');
const { blindIndex } = require('./pii.helper');
const { normalizeNgPhone } = require('./phone.helper');

// A provider's rate budget is shared by the whole key - every catalogue read and
// every vend. A receipt screen polling every few seconds must not be able to
// spend it, so each transaction is requeried at most once per window no matter
// how often the poll asks.
const RECHECK_MS = Number(process.env.BILLS_RECHECK_MS || 15_000);

// An unconfirmed purchase is refunded only when BOTH hold: this many complete
// looks through the provider's history found nothing, and it is at least this
// old. Airtime lands in seconds, so half an hour of absence is not a slow
// biller; the count stops one empty read made in the first minute - before the
// order was written on their side - from deciding anything.
const UNCONFIRMED_REFUND_AFTER_MS = Number(process.env.BILLS_UNCONFIRMED_REFUND_AFTER_MS || 30 * 60_000);
const UNCONFIRMED_MIN_MISSES = Number(process.env.BILLS_UNCONFIRMED_MIN_MISSES || 3);

// How an order in their history is placed against our row: their clock may run
// behind ours, and an order can only appear after we sent it.
const MATCH_SKEW_MS = 5 * 60_000;
const MATCH_WINDOW_MS = 30 * 60_000;

// `meta.unconfirmed` while a refund is being made: claimed first, so nothing
// can adopt an order for a row that is already being refunded.
const REFUNDING = 'refunding';

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
 * A recipient in the one form both sides can be compared in, as a keyed blind
 * index - so the row never holds the number itself (`meta` is not encrypted),
 * and their history row and ours meet without either being logged.
 *
 * Phones go through the local 11-digit form, so 0803..., 234803... and +234...
 * all agree; meters and smartcards are compared on their digits.
 */
function recipientIndex(service, value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const normalized =
    service === 'airtime' || service === 'data' ? normalizeNgPhone(raw)?.local || '' : raw.replace(/\D/g, '');
  return normalized ? blindIndex(normalized, 'bill_recipient') : null;
}

function isUnconfirmed(meta) {
  return meta.unconfirmed === true || meta.unconfirmed === REFUNDING;
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

  // No reference of ours ever reached this upstream, and none of theirs reached
  // us: the purchase can only be found by what it was.
  const byHistory =
    !reference &&
    !upstream.SUPPORTS_REQUEST_ID_LOOKUP &&
    typeof upstream.listRecentOrders === 'function' &&
    isUnconfirmed(meta);

  // An upstream that hands back an order id of its own for every order it
  // holds (ClubKonnect), on a bill that never got one: asked about by our
  // RequestID until an order turns up - or, on evidence, refunded.
  const awaitingOrder =
    !byHistory &&
    upstream.SUPPORTS_REQUEST_ID_LOOKUP &&
    typeof upstream.isOrderId === 'function' &&
    !upstream.isOrderId(reference);

  if (!reference && !byHistory && !awaitingOrder) {
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

  if (byHistory) return reconcileUnconfirmed(row, meta, upstream, gateway, age);
  if (awaitingOrder) return reconcileAwaitingOrder(row, meta, upstream, gateway, age);

  let remote;
  try {
    remote = await upstream.getTransactionStatus(reference, { byRequestId });
  } catch (e) {
    console.error('bills.reconcile error:', { trx: row.trx, gateway, error: e?.message });
    return { checked: false, reason: 'provider_error' };
  }

  // A vend whose response we lost, found alive under our own reference. Stamp
  // the upstream's order id so the next requery is a normal one.
  //
  // **Before settling, not after.** Settlement re-reads the row and writes its
  // outcome - status, token - into `meta`. This write replaces `meta` from the
  // copy read before any of that, so made afterwards it put a settled row back
  // to `processing` and dropped its token; a refunded one then stayed
  // "Processing" for good, since its next settlement found the refund already
  // made and changed nothing. Guarded on the status that copy was read with,
  // so it can never overwrite a row that has moved on.
  if (byRequestId && remote.reference_code && remote.status !== 'not_found') {
    await prisma.walletTransaction
      .updateMany({
        where: { trx: row.trx, meta: { path: ['bill_status'], equals: String(meta.bill_status || '') } },
        data: { meta: { ...meta, provider_reference: String(remote.reference_code) } },
      })
      .catch(() => null);
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

  return { checked: true, status: remote.status, applied: result.applied, reason: result.reason };
}

/**
 * Move an unconfirmed row on, guarded on it still being unconfirmed.
 *
 * Every transition out of "unconfirmed" goes through here: adopting an order,
 * counting an empty look, claiming the refund. The guard is what lets the sweep
 * and a receipt poll race - once one of them has adopted an order or claimed
 * the refund, the other's write matches nothing.
 */
async function moveUnconfirmed(row, meta, patch) {
  const moved = await prisma.walletTransaction.updateMany({
    where: {
      trx: row.trx,
      AND: [
        { meta: { path: ['bill_status'], equals: 'processing' } },
        { meta: { path: ['unconfirmed'], equals: true } },
      ],
    },
    data: { meta: { ...meta, ...patch } },
  });
  return moved.count > 0;
}

/**
 * Other rows of ours that could own the same order: same provider, same
 * recipient, same amount, also unconfirmed, near in time. If there is one, an
 * order in their history could be either row's, and it is not guessed.
 */
async function rivalsOf(row, meta, gateway) {
  const created = new Date(row.created_at).getTime();
  return prisma.walletTransaction.count({
    where: {
      trx: { not: row.trx },
      trx_type: '-',
      created_at: { gt: new Date(created - MATCH_WINDOW_MS), lt: new Date(created + MATCH_WINDOW_MS) },
      AND: [
        { meta: { path: ['gateway'], equals: gateway } },
        { meta: { path: ['service'], equals: String(meta.service || '') } },
        { meta: { path: ['unconfirmed'], equals: true } },
        { meta: { path: ['recipient_idx'], equals: String(meta.recipient_idx || '') } },
        { meta: { path: ['vend_amount'], equals: Number(meta.vend_amount) } },
      ],
    },
  });
}

async function refundUnconfirmed(row) {
  const result = await settlement.settleFailure({ trx: row.trx, reason: 'Provider has no record of this purchase' });
  return { checked: true, status: 'failed', applied: result.applied, reason: result.reason || 'refunded_unconfirmed' };
}

/**
 * Find a purchase whose answer was lost, on an upstream that cannot be asked
 * about our own reference - or give the money back once it plainly never
 * happened.
 *
 *   one match, nobody else's   adopt its reference, then settle on its status
 *   two or more, or a rival    leave it: the hour-old alert hands it to a person
 *   none, on a complete read   count it; refund after enough looks and time
 *   none, on a partial read    proves nothing - not counted
 */
async function reconcileUnconfirmed(row, meta, upstream, gateway, age) {
  // A refund already claimed is finished, whatever a listing would say now.
  if (meta.unconfirmed === REFUNDING) return refundUnconfirmed(row);

  const want = String(meta.recipient_idx || '');
  const amount = Number(meta.vend_amount);
  // Written by executePurchase on the first ledger write. Without them a match
  // is a guess, so the row waits for a person instead.
  if (!want || !Number.isFinite(amount)) return { checked: true, reason: 'unmatchable' };

  const created = new Date(row.created_at).getTime();

  let listing;
  try {
    listing = await upstream.listRecentOrders({ since: new Date(created - MATCH_SKEW_MS) });
  } catch (e) {
    // A failed read is not evidence of anything.
    console.error('bills.reconcile history lookup error:', { trx: row.trx, gateway, error: e?.message });
    return { checked: false, reason: 'provider_error' };
  }

  const matches = (listing?.orders || []).filter(
    order =>
      order.service === meta.service &&
      Math.abs(Number(order.amount) - amount) < 0.005 &&
      Number.isFinite(order.created_ms) &&
      order.created_ms >= created - MATCH_SKEW_MS &&
      order.created_ms <= created + MATCH_WINDOW_MS &&
      order.reference &&
      recipientIndex(meta.service, order.recipient) === want
  );

  // An order another of our rows already holds is that row's.
  const free = [];
  for (const order of matches) {
    const owner = await settlement.findByProviderReference(order.reference, gateway);
    if (!owner || owner.trx === row.trx) free.push(order);
  }

  if (free.length > 1) return { checked: true, reason: 'ambiguous_match' };

  if (free.length === 1) {
    if ((await rivalsOf(row, meta, gateway)) > 0) return { checked: true, reason: 'ambiguous_match' };

    const [order] = free;
    const adopted = await moveUnconfirmed(row, meta, {
      unconfirmed: false,
      provider_reference: order.reference,
      found_by: 'history_match',
    });
    if (!adopted) return { checked: true, reason: 'raced' };

    const result = await settlement.applyOutcome({
      trx: row.trx,
      status: order.status,
      token: order.token,
      reason: 'Provider reported failure on lookup',
    });
    return { checked: true, status: order.status, applied: result.applied, reason: result.reason, adopted: true };
  }

  // Nothing there. Only a read that covered the whole window counts as a look.
  if (!listing?.complete) return { checked: true, reason: 'incomplete_listing' };

  return recordAbsence(row, meta, age);
}

/**
 * One more look that found no order. Counted, and refunded once there have
 * been enough of them over enough time - the same rule for every upstream that
 * cannot confirm a purchase by our own reference.
 */
async function recordAbsence(row, meta, age) {
  const misses = (Number(meta.lookup_misses) || 0) + 1;
  if (misses >= UNCONFIRMED_MIN_MISSES && age >= UNCONFIRMED_REFUND_AFTER_MS) {
    // Claimed before it is paid, so a late match cannot also adopt an order for
    // a row that is being refunded.
    const claimed = await moveUnconfirmed(row, meta, { unconfirmed: REFUNDING, lookup_misses: misses });
    if (!claimed) return { checked: true, reason: 'raced' };
    return refundUnconfirmed(row);
  }

  await moveUnconfirmed(row, meta, { lookup_misses: misses });
  return { checked: true, reason: 'not_found_yet' };
}

/**
 * A bill on an upstream that gives every order it holds an id of its own
 * (ClubKonnect), which never got one.
 *
 * Accepted without an order id is not proof of an order: it was a status word
 * with nothing behind it (INSUFFICIENT_APIAMOUNT on its own), or a lost answer
 * our RequestID could not place. On 2026-10-20 one such airtime purchase sat at
 * "Processing" with ClubKonnect's wallet untouched, and nothing would ever have
 * closed it - outside vend(), "not found" was never a reason to refund.
 *
 *   an order turns up under our RequestID   its id is stamped, and it settles
 *                                           on its own status like any other
 *   no order, look after look               refunded on the same evidence as a
 *                                           lost CashBuddy purchase: enough
 *                                           complete looks AND enough time
 *   their query fails                       proves nothing, not counted
 */
async function reconcileAwaitingOrder(row, meta, upstream, gateway, age) {
  // Written before this rule existed, a bill carries no flag to guard the
  // transitions on. Given one first - guarded on still being open.
  if (meta.unconfirmed !== true && meta.unconfirmed !== REFUNDING) {
    const flagged = await prisma.walletTransaction.updateMany({
      where: { trx: row.trx, meta: { path: ['bill_status'], equals: 'processing' } },
      data: { meta: { ...meta, unconfirmed: true } },
    });
    if (!flagged.count) return { checked: false, reason: 'raced' };
    meta = { ...meta, unconfirmed: true };
  }

  if (meta.unconfirmed === REFUNDING) return refundUnconfirmed(row);

  let remote;
  try {
    remote = await upstream.getTransactionStatus(row.trx, { byRequestId: true });
  } catch (e) {
    console.error('bills.reconcile request-id lookup error:', { trx: row.trx, gateway, error: e?.message });
    return { checked: false, reason: 'provider_error' };
  }

  // An order they hold carries their id or, at the least, a status code. A
  // "not found", or an answer with neither, is no order at all.
  const orderId = upstream.isOrderId(remote.reference_code) ? String(remote.reference_code) : '';
  const holdsOrder = remote.status !== 'not_found' && Boolean(orderId || remote.status_code);
  if (!holdsOrder) return recordAbsence(row, meta, age);

  if (orderId) {
    const adopted = await moveUnconfirmed(row, meta, {
      unconfirmed: false,
      provider_reference: orderId,
      found_by: 'request_id',
    });
    if (!adopted) return { checked: true, reason: 'raced' };
  }

  const result = await settlement.applyOutcome({
    trx: row.trx,
    status: remote.status,
    token: remote.token,
    units: remote.units,
    reason: 'Provider reported failure on requery',
  });
  return { checked: true, status: remote.status, applied: result.applied, reason: result.reason, adopted: Boolean(orderId) };
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

module.exports = {
  reconcile,
  sweepProcessingBills,
  isBillsGateway,
  recipientIndex,
  __test: { throttled, NOT_BILLS_REMARKS, REFUNDING, lastChecked },
};
