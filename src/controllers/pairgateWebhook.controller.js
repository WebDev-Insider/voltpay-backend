// PairGate delivery notifications.
//
// This rail is asymmetric: a purchase call returns "accepted", not "delivered",
// and a prepaid electricity token is never in that response. It is never in
// `transaction/status` either. The token exists in exactly one place - the
// webhook body - which makes this file load-bearing rather than an optimisation.
// A customer who paid for power and got no token has, from their side, simply
// lost the money.
//
// This file owns only PairGate's own delivery format and its authorization
// rules. The fallbacks for a notification that never arrives - the receipt poll
// and the timed sweep - are provider-agnostic and live in
// helpers/billReconcile.helper.js. All paths converge on billSettlement.helper,
// which is idempotent, so they can race freely.
const prisma = require('../../database/prisma');
const pairgate = require('../funding/pairgate.service');
const settlement = require('../helpers/billSettlement.helper');
const alerts = require('../services/alerts.service');

// PairGate retries a webhook three times and then drops it, so a delivery must
// be acknowledged even when it is about a transaction this does not recognise -
// a 500 buys nothing but two more copies of the same unknown reference.
function acknowledge(res, remark = 'ok', message = 'OK') {
  return res.json({ remark, status: 'success', message: [message], data: null });
}

function headerOf(req, ...names) {
  for (const name of names) {
    const value = req.headers?.[name];
    if (value) return Array.isArray(value) ? value[0] : String(value);
  }
  return '';
}

/**
 * Pull the fields out of a delivery, tolerating the shapes this can arrive in.
 *
 * The payload is either the transaction object itself or wrapped in `data`, and
 * the reference has been seen as both `reference_code` and `reference`. Reading
 * defensively costs nothing; guessing wrong strands a token.
 */
function parseDelivery(body) {
  const payload = body && typeof body === 'object' ? body : {};
  const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;

  const event = String(payload.event || payload.type || '').trim().toLowerCase();
  const status = String(data.status ?? payload.status ?? '')
    .toString()
    .trim()
    .toLowerCase();

  return {
    event,
    reference: String(data.reference_code || data.reference || payload.reference_code || '').trim(),
    // `true`/`false` is a legitimate status here, and String(false) is "false",
    // which is neither of the words settlement recognises. Map it first.
    status: status === 'true' ? 'successful' : status === 'false' ? 'failed' : status || eventStatus(event),
    // The token. `pin` is what PairGate calls it; the others are cheap insurance.
    token: String(data.pin || data.token || data.purchased_code || '').trim(),
    units: String(data.units || data.unit || '').trim(),
    message: String(data.message || payload.message || '').trim(),
  };
}

// Some providers put the outcome only in the event name.
function eventStatus(event) {
  if (!event) return '';
  if (event.includes('fail') || event.includes('reject') || event.includes('revers')) return 'failed';
  if (event.includes('success') || event.includes('complet')) return 'successful';
  return '';
}

/**
 * Decide whether a delivery may be acted on, and on whose authority.
 *
 * With `PAIRGATE_WEBHOOK_SECRET` set, a valid HMAC is the authority and the body
 * is trusted as it stands.
 *
 * Without it, the body is an anonymous POST to a public URL - anyone who learns
 * the endpoint could flip a bill to "failed" and collect the refund. So the
 * delivery is downgraded to a hint: the status is re-read from PairGate over the
 * authenticated API, and only the token is taken from the body, because nothing
 * else carries it. A forgery can then no longer move money; the worst it can do
 * is write a junk token onto a bill that really did succeed.
 */
async function authorize(req, delivery) {
  const check = pairgate.verifyWebhookSignature({
    rawBody: req.rawBody,
    signature: headerOf(req, 'x-pairgate-signature', 'x-signature', 'pairgate-signature'),
    timestamp: headerOf(req, 'x-pairgate-timestamp', 'x-timestamp', 'pairgate-timestamp'),
  });

  if (check.verified) return { allow: true, status: delivery.status, trusted: true };
  if (check.configured) {
    // A secret is set and the signature did not match. That is not a delivery.
    return { allow: false, reason: check.reason };
  }

  warnUnsigned();

  try {
    const remote = await pairgate.getTransactionStatus(delivery.reference);
    return { allow: true, status: remote.status, trusted: false };
  } catch (e) {
    // Rejecting means PairGate retries, which is what we want - but it spends
    // one of only three attempts, and after the third the token is gone.
    console.error('pairgate.webhook requery failed:', { reference: delivery.reference, error: e?.message });
    return { allow: false, reason: 'requery_failed' };
  }
}

// Unsigned mode is a working configuration, not a broken one, so it must not
// throw - but it is strictly worse in two ways that are invisible from the
// outside: every delivery costs a provider call, and a delivery arriving while
// that call is failing is rejected, spending one of three retries. Said once per
// process so it appears in the logs of a deployment that has drifted, without
// becoming noise on every notification.
let unsignedWarned = false;
function warnUnsigned() {
  if (unsignedWarned) return;
  unsignedWarned = true;
  console.warn(
    'pairgate.webhook: PAIRGATE_WEBHOOK_SECRET is not set - deliveries cannot be verified, ' +
      'so each one is confirmed with an extra status call. Set it here and in the PairGate dashboard.'
  );
  alerts.paymentFailure({
    provider: 'pairgate',
    action: 'webhook_unsigned',
    message: 'PairGate webhook secret is not configured',
  });
}

/**
 * Settle a Bill Hero reward, which is a vend with no ledger row behind it.
 *
 * A reward is free airtime, so a failure owes nobody a refund - but it does owe
 * the customer another go. `claim` refuses to re-run a row marked `claimed` and
 * allows one marked `failed`, so flipping it here is the whole recovery path: a
 * reward the network rejected after accepting it can be claimed again, which on
 * the previous rail it could not.
 *
 * Success is not written back. The row is already `claimed`, and re-marking it
 * would only add a write.
 *
 * `gateway` scopes the lookup to the rail whose callback this is. `provider_ref`
 * holds the *provider's* order id, and the two upstreams number their orders in
 * their own namespaces - both numeric - so an unscoped match lets one provider's
 * callback fail a claim the other vended. The claim row records which rail it
 * used for exactly this. Optional, and omitting it matches on the reference
 * alone, which is the old behaviour rather than a failed lookup.
 */
async function settleRewardClaim(reference, status, gateway) {
  if (String(status || '').toLowerCase() !== 'failed') return false;

  const rail = String(gateway || '').trim();

  const claim = await prisma.billHeroClaim.findFirst({
    where: {
      provider_ref: String(reference),
      status: 'claimed',
      ...(rail ? { provider: rail } : {}),
    },
  });
  if (!claim) return false;

  await prisma.billHeroClaim.update({
    where: { id: Number(claim.id) },
    data: { status: 'failed', provider_payload: { settled_by: 'webhook', status } },
  });

  // Ids only - the claim row holds an encrypted phone number and nothing here
  // needs to name it.
  console.log('bills.webhook reward reversed:', { claim_id: claim.id, user_id: claim.user_id });
  return true;
}

async function webhook(req, res) {
  try {
    const delivery = parseDelivery(req.body);
    if (!delivery.reference) return acknowledge(res, 'ignored', 'No reference');

    const auth = await authorize(req, delivery);
    if (!auth.allow) {
      // Never echo why. A caller probing for the signature format learns nothing
      // from a flat 401, and a real delivery never sees this branch.
      console.warn('pairgate.webhook rejected:', { reference: delivery.reference, reason: auth.reason });
      return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Invalid signature'], data: null });
    }

    const row = await settlement.findByProviderReference(delivery.reference);
    if (!row) {
      // Bill Hero rewards vend through the same key but land in their own table,
      // so a reference with no ledger row is routine rather than an error.
      const claimed = await settleRewardClaim(delivery.reference, auth.status, 'pairgate');
      return acknowledge(res, claimed ? 'ok' : 'ignored', claimed ? 'OK' : 'Unknown reference');
    }

    const result = await settlement.applyOutcome({
      trx: row.trx,
      status: auth.status,
      token: delivery.token,
      units: delivery.units,
      reason: delivery.message,
    });

    // Ids only. `delivery.message` can quote a meter number or a phone number.
    console.log('pairgate.webhook:', {
      trx: row.trx,
      status: auth.status,
      applied: result.applied,
      outcome: result.reason || 'applied',
      signed: auth.trusted,
    });

    return acknowledge(res);
  } catch (e) {
    console.error('pairgate.webhook error:', e?.message);
    // Deliberately a 200. The delivery has been read; if settlement broke, two
    // more copies of it will break the same way, and the sweep will pick the row
    // up regardless.
    return acknowledge(res, 'error', 'Received');
  }
}

module.exports = { webhook, parseDelivery, settleRewardClaim };
