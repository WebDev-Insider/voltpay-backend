// Applying a provider's final outcome to a bill ledger row.
//
// Provider-agnostic on purpose - it is the one place a bill's fate is decided,
// whichever upstream sold it. Three callers share these rules:
//
//   - a provider's webhook, where the provider has one switched on;
//   - the receipt poll, which requeries when a row has sat in "processing" too
//     long. That is the safety net for a webhook that was never delivered -
//     providers retry a handful of times and then drop it;
//   - the timed sweep, for a row nobody is looking at.
//
// All three can race: a customer refreshing the receipt at the instant the
// webhook lands, with the sweep passing over the same row. So every transition
// here is idempotent and guarded on the row's current state, and the refund
// leans on the unique `trx` column rather than on a read-then-write check, which
// two concurrent callers would both pass.
//
// A row only ever moves forward: out of `processing` - by way of
// `awaiting_token`, for a prepaid meter - and into successful, failed or
// refunded. Once there, a late duplicate delivery is a no-op.
const prisma = require('../../database/prisma');
const { Prisma } = require('@prisma/client');
const { applyBalanceDelta } = require('./balance.helper');
const { protectText, revealLedgerText } = require('./pii.helper');
const alerts = require('../services/alerts.service');

// A prepaid meter's bill is delivered when the customer holds the token, not
// when the provider says yes: without it they have paid for electricity they
// cannot load. So a success that arrives with no token parks the row here
// instead of closing it.
//
// Closing it is what used to happen, and it was permanent - nothing re-reads a
// settled row, so the token was never asked for again and the receipt said
// "Successful" over an empty space. Parked, the row stays open: the receipt
// and history still read "Processing", the sweep keeps asking in a pass of its
// own, a token that turns up later completes it, and a provider that later
// reports a failure still refunds it.
const AWAITING_TOKEN = 'awaiting_token';

function needsToken(meta) {
  return meta.service === 'electricity' && String(meta.meter_type || '').toLowerCase() === 'prepaid';
}

/** The row a provider reference belongs to, or null. */
async function findByProviderReference(referenceCode) {
  const ref = String(referenceCode || '').trim();
  if (!ref) return null;

  return prisma.walletTransaction.findFirst({
    where: { meta: { path: ['provider_reference'], equals: ref } },
  });
}

function metaOf(row) {
  return row?.meta && typeof row.meta === 'object' ? { ...row.meta } : {};
}

function otherDataOf(row) {
  return row?.other_data && typeof row.other_data === 'object' ? { ...row.other_data } : {};
}

/** Only a row still in flight can be settled. */
function isOpen(row) {
  const status = String(metaOf(row).bill_status || '').toLowerCase();
  return status === 'processing' || status === AWAITING_TOKEN || status === '';
}

/**
 * Mark a bill delivered, optionally attaching the token that came with it.
 *
 * The token is the one thing a prepaid electricity customer actually needs. It
 * normally rides on the purchase call, and a requery may or may not carry it -
 * so it is written even if the row has already been marked successful by an
 * earlier delivery that arrived without one, and a prepaid row is not marked
 * successful without one at all (see AWAITING_TOKEN).
 */
async function settleSuccess({ trx, token = '', units = '' }) {
  const row = await prisma.walletTransaction.findUnique({ where: { trx: String(trx) } });
  if (!row) return { applied: false, reason: 'not_found' };

  const meta = metaOf(row);
  const cleanToken = String(token || '').trim();
  const heldToken = String(meta.token || '').trim();
  const alreadyDone = String(meta.bill_status || '').toLowerCase() === 'successful';

  // Nothing new to record: already successful and either already holding a
  // token or never going to have one.
  if (alreadyDone && (!cleanToken || heldToken === cleanToken)) {
    return { applied: false, reason: 'already_settled' };
  }
  if (!alreadyDone && !isOpen(row)) return { applied: false, reason: 'closed' };
  if (!alreadyDone && !cleanToken && !heldToken && needsToken(meta)) return awaitToken(row, meta);

  const other = otherDataOf(row);

  await prisma.walletTransaction.update({
    where: { trx: String(trx) },
    data: {
      other_data: { ...other, feedback: 'Successful' },
      meta: {
        ...meta,
        bill_status: 'successful',
        // An empty token must not overwrite one already delivered.
        token: cleanToken || String(meta.token || ''),
        units: String(units || '').trim() || String(meta.units || ''),
        settled_at: new Date().toISOString(),
      },
    },
  });

  return { applied: true, token: cleanToken || String(meta.token || '') };
}

/**
 * Hold a prepaid bill the provider has delivered until its token arrives.
 *
 * Not a settlement, so `applied` stays false and the sweep does not count it as
 * one. `parked` is true only on the call that moved the row, so the alert fires
 * once per bill rather than on every requery.
 */
async function awaitToken(row, meta) {
  if (String(meta.bill_status || '').toLowerCase() === AWAITING_TOKEN) {
    return { applied: false, reason: AWAITING_TOKEN, parked: false };
  }

  // Guarded on the status just read. A caller holding the token can land
  // between that read and this write, and an unguarded write would set the row
  // back to waiting and drop the token it had just been given.
  const moved = await prisma.walletTransaction.updateMany({
    where: { trx: row.trx, meta: { path: ['bill_status'], equals: 'processing' } },
    data: { meta: { ...meta, bill_status: AWAITING_TOKEN } },
  });
  if (!moved.count) return { applied: false, reason: 'raced', parked: false };

  // Paid for, delivered by the provider's account, and unusable. Someone has to
  // get the token while the customer is still waiting for it. Ids only - never
  // the meter number.
  alerts.paymentFailure({
    provider: meta.gateway || 'unknown',
    action: 'electricity',
    reference: row.trx,
    userId: row.user_id,
    amount: row.total_amount ?? row.amount,
    message: 'Prepaid electricity delivered without a token. Ask the provider for it.',
    context: { provider_reference: meta.provider_reference || null },
  });

  return { applied: false, reason: AWAITING_TOKEN, parked: true };
}

/**
 * Reverse a bill the provider could not deliver.
 *
 * The money left the wallet at confirm time, so a failure has to put it back and
 * leave a visible credit leg - a balance that silently heals is indistinguishable
 * from a bug, and the statement has to show both sides.
 *
 * `reason` is the provider's own wording. It can name a meter or a phone number,
 * so it goes nowhere near a log line; only the ids are logged.
 */
async function settleFailure({ trx, reason = '' }) {
  const key = String(trx);
  const row = await prisma.walletTransaction.findUnique({ where: { trx: key } });
  if (!row) return { applied: false, reason: 'not_found' };
  if (!isOpen(row)) return { applied: false, reason: 'closed' };

  // Already reversed by the other caller.
  const existing = await prisma.walletTransaction.findUnique({ where: { trx: `${key}_r` } });
  if (existing) return { applied: false, reason: 'already_refunded' };

  const meta = metaOf(row);
  const other = otherDataOf(row);
  const plain = revealLedgerText(row);
  const details = String(plain.details || other.note || 'Bill payment');
  const title = String(other.title || 'Bill payment');
  const debit = new Prisma.Decimal(String(row.total_amount ?? row.amount ?? '0'));

  try {
    await prisma.$transaction(async tx => {
      await applyBalanceDelta(tx, 'user', row.user_id, debit);

      // The unique `trx` is the concurrency guard. Two callers racing here both
      // reach this line; the loser hits P2002 and the whole transaction - the
      // balance credit included - rolls back.
      await tx.walletTransaction.create({
        data: {
          user_id: Number(row.user_id),
          trx: `${key}_r`,
          trx_type: '+',
          amount: debit,
          charge: new Prisma.Decimal('0.00'),
          total_amount: debit,
          remark: row.remark,
          details: protectText(`Refund - ${details}`),
          other_data: {
            title: `${title} refund`,
            subtitle: protectText(details),
            feedback: 'Refunded',
            note: 'Provider could not deliver',
            image_src: '',
          },
          meta: {
            // The reversal is stamped with the gateway that sold the bill, so
            // the two legs agree about who to ask. The literal is for rows
            // written before a gateway was recorded at all, which were PairGate
            // by definition - it is not a default for new writes, and must not
            // follow the switch.
            gateway: meta.gateway || 'pairgate',
            service: meta.service || '',
            reference: `${key}_r`,
            reversal_of: key,
            bill_status: 'refunded',
          },
        },
      });

      await tx.walletTransaction.update({
        where: { trx: key },
        data: {
          other_data: { ...other, feedback: 'Failed', note: 'Refunded' },
          meta: {
            ...meta,
            bill_status: 'failed',
            settled_at: new Date().toISOString(),
          },
        },
      });
    });
  } catch (e) {
    if (e?.code === 'P2002') return { applied: false, reason: 'already_refunded' };

    // The customer is out of pocket and nothing was delivered. Ids only - the
    // provider's reason can quote a meter or a phone number.
    console.error('billSettlement.settleFailure FAILED - manual settlement required:', {
      user_id: row.user_id,
      trx: key,
      service: meta.service || '',
      error: e?.message,
    });
    return { applied: false, reason: 'error' };
  }

  return { applied: true, refunded: true, provider_reason: reason };
}

/**
 * Dispatch on the provider's status word.
 *
 * `successful` and `failed` are the only two a webhook sends. `transaction/status`
 * adds `processing` and `pending`, both of which mean "still in flight" and are
 * deliberately not settled - a `pending` transaction is awaiting manual review at
 * the provider, and reversing it here would refund a bill that then delivers.
 */
async function applyOutcome({ trx, status, token = '', units = '', reason = '' }) {
  const state = String(status || '').trim().toLowerCase();

  if (state === 'successful' || state === 'success' || state === 'completed') {
    return settleSuccess({ trx, token, units });
  }
  if (state === 'failed' || state === 'failure' || state === 'declined' || state === 'reversed') {
    return settleFailure({ trx, reason });
  }
  return { applied: false, reason: 'not_final' };
}

module.exports = {
  AWAITING_TOKEN,
  findByProviderReference,
  settleSuccess,
  settleFailure,
  applyOutcome,
  isOpen,
};
