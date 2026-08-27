// ClubKonnect delivery callbacks.
//
// The counterpart to pairgateWebhook.controller.js, and it differs in one way
// that shapes the whole file: **this provider has no signature scheme at all.**
// The callback is whatever URL we sent with the order, hit with no HMAC, no
// shared secret and no timestamp. Anyone who learns the endpoint can post to it.
//
// So the delivery is never the authority. It is a *hint that something changed*,
// and the outcome is always re-read from ClubKonnect over the authenticated
// query API before a single naira moves. A forgery can then do nothing: the
// worst it achieves is making us spend one status call.
//
// The other rail treats an unsigned delivery the same way, but there it is a
// degraded mode you fix by setting a secret. Here it is the only mode there is,
// which is why there is no signature branch below to fall out of.
//
// Two smaller differences from the other rail:
//
//   - the body can arrive as JSON *or* as a query string, and as a POST or a
//     GET, so both are parsed;
//   - `statuscode` is the real outcome and the status word is ambiguous
//     (ORDER_COMPLETED covers both a delivery and a network timeout), so
//     classification is delegated to the provider module rather than re-derived
//     from strings here.
//
// The fallbacks for a callback that never arrives - the receipt poll and the
// timed sweep - are provider-agnostic and live in helpers/billReconcile.helper.js.
const clubkonnect = require('../funding/clubkonnect.service');
const settlement = require('../helpers/billSettlement.helper');
const { settleRewardClaim } = require('./pairgateWebhook.controller');

// Acknowledge even a delivery about a transaction we do not recognise. A
// non-200 buys nothing but another copy of the same unknown reference.
function acknowledge(res, remark = 'ok', message = 'OK') {
  return res.json({ remark, status: 'success', message: [message], data: null });
}

/**
 * Pull the fields out of a callback, tolerating every shape it arrives in.
 *
 * Their documentation shows a JSON body, but the callback has also been seen as
 * form-encoded and as a bare query string on a GET. Reading all three costs
 * nothing; guessing wrong strands a token.
 */
function parseDelivery(req) {
  const body = req?.body && typeof req.body === 'object' ? req.body : {};
  const query = req?.query && typeof req.query === 'object' ? req.query : {};
  // Body wins where both carry a field - a POST body is the documented form.
  const data = { ...query, ...body };

  const pick = (...names) => {
    for (const name of names) {
      const value = data[name];
      if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
    }
    return '';
  };

  return {
    // Their order id. `requestid` is ours, echoed back - kept because it is the
    // fallback join key when the order id never reached us.
    reference: pick('orderid', 'OrderID', 'order_id'),
    requestId: pick('requestid', 'RequestID', 'request_id'),
    statusCode: pick('statuscode', 'StatusCode', 'status_code'),
    statusText: pick('orderstatus', 'status', 'OrderStatus'),
    token: pick('metertoken', 'MeterToken', 'pin', 'token'),
    units: pick('units', 'unit'),
    message: pick('remark', 'orderremark', 'message'),
  };
}

async function webhook(req, res) {
  try {
    const delivery = parseDelivery(req);
    const reference = delivery.reference || delivery.requestId;
    if (!reference) return acknowledge(res, 'ignored', 'No reference');

    // The whole security model of this endpoint, in one call: whatever the body
    // claimed, ask ClubKonnect directly. `byRequestId` covers the case where the
    // callback carries only the reference we generated.
    let remote;
    try {
      remote = await clubkonnect.getTransactionStatus(reference, {
        byRequestId: !delivery.reference,
      });
    } catch (e) {
      // Rejecting means they retry, which is what we want - and unlike the other
      // rail there is no token riding on this body that a dropped retry would
      // lose forever, because the query endpoint carries it too.
      console.error('clubkonnect.webhook requery failed:', { reference, error: e?.message });
      return res.status(503).json({
        remark: 'requery_failed',
        status: 'error',
        message: ['Could not verify'],
        data: null,
      });
    }

    const status = remote.status;

    // Take the token from whichever source has one. The body is untrusted, but a
    // token is not a money decision - it is a string the customer types into a
    // meter, and the row is only being written at all because the *authenticated*
    // requery said the vend succeeded. A forged token on a genuinely successful
    // bill is the worst case, and it is recoverable; a missing one is not.
    const token = remote.token || delivery.token;
    const units = remote.units || delivery.units;

    const row = await settlement.findByProviderReference(remote.reference_code || reference);
    if (!row) {
      // Bill Hero rewards vend through the same credentials but land in their own
      // table, so a reference with no ledger row is routine rather than an error.
      const claimed = await settleRewardClaim(remote.reference_code || reference, status, 'clubkonnect');
      return acknowledge(res, claimed ? 'ok' : 'ignored', claimed ? 'OK' : 'Unknown reference');
    }

    const result = await settlement.applyOutcome({
      trx: row.trx,
      status,
      token,
      units,
      reason: 'Provider reported failure on callback',
    });

    // Ids and codes only. `remark` can quote a meter number or a phone number.
    console.log('clubkonnect.webhook:', {
      trx: row.trx,
      status,
      status_code: remote.status_code,
      applied: result.applied,
      outcome: result.reason || 'applied',
    });

    return acknowledge(res);
  } catch (e) {
    console.error('clubkonnect.webhook error:', e?.message);
    // Deliberately a 200. The delivery has been read; if settlement broke, a
    // retry will break the same way, and the sweep will pick the row up anyway.
    return acknowledge(res, 'error', 'Received');
  }
}

module.exports = { webhook, parseDelivery };
