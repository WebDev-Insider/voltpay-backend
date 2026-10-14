// MySubWallet delivery notifications.
//
// Two facts about this callback shape the whole file:
//
//   1. **It carries no signature.** One URL, set on their dashboard, hit with a
//      plain JSON POST - no HMAC, no shared secret, no timestamp. Anyone who
//      learns the endpoint can post to it. So a delivery is never the
//      authority: it is a *hint that something changed*, and the outcome is
//      re-read over the authenticated requery before a single naira moves. A
//      forgery can then do nothing worse than make us spend one status call.
//   2. **One callback serves every product we buy from them.** A bill and a
//      Bill Hero reward both report here, named by the `request-id` we sent -
//      our own `trx` for a ledger row, the claim's request id for a reward. So
//      the row is found by our own reference. (Betting is on Payvessel, with
//      its own callback; a betting row is a foreign gateway here and ignored.)
//
// **Nothing depends on this firing.** As of 2026-10-06 their dashboard offers
// no callback setting, so it does not. The receipt poll and the timed sweep in
// helpers/billReconcile.helper.js ask MySubWallet directly, and every path
// converges on idempotent settlement, so they can race freely with this the
// day it is switched on.
const prisma = require('../../database/prisma');
const mysubwallet = require('../funding/mysubwallet.service');
const settlement = require('../helpers/billSettlement.helper');
const billHero = require('./billHero.controller');

const GATEWAY = 'mysubwallet';

// Acknowledge even a delivery about a transaction we do not recognise. A
// non-200 buys nothing but another copy of the same unknown reference.
function acknowledge(res, remark = 'ok', message = 'OK') {
  return res.json({ remark, status: 'success', message: [message], data: null });
}

/**
 * Pull the fields out of a delivery.
 *
 * Their documented body is `{ status, "request-id", response }`. The other
 * spellings are cheap insurance: guessing wrong strands a token.
 */
function parseDelivery(body) {
  const data = body && typeof body === 'object' ? body : {};
  const inner = data.data && typeof data.data === 'object' ? data.data : {};
  const pick = (...names) => {
    for (const source of [data, inner]) {
      for (const name of names) {
        const value = source[name];
        if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
      }
    }
    return '';
  };

  return {
    reference: pick('request-id', 'request_id', 'requestId', 'reference'),
    // Untrusted, like everything here. Read only so a token can be taken from
    // it when the authenticated requery says the vend succeeded but carries
    // none - see below.
    response: pick('response', 'message'),
    token: pick('token', 'meter_token', 'purchased_code'),
  };
}

async function webhook(req, res) {
  try {
    const delivery = parseDelivery(req.body);
    if (!delivery.reference) return acknowledge(res, 'ignored', 'No reference');

    // The whole security model of this endpoint, in one call: whatever the body
    // claimed, ask MySubWallet directly, with our key. Their requery is scoped
    // to our account, so a forged reference for someone else's order reads as
    // not found.
    let remote;
    try {
      remote = await mysubwallet.getTransactionStatus(delivery.reference);
    } catch (e) {
      // Refusing invites a redelivery, which is what we want. Nothing rides on
      // this body that the requery cannot also supply, so a delivery that is
      // never retried costs a slower settlement, not a lost token.
      console.error('mysubwallet.webhook requery failed:', {
        reference: delivery.reference,
        error: String(e?.providerMessage || e?.message || '').slice(0, 160),
      });
      return res.status(503).json({ remark: 'requery_failed', status: 'error', message: ['Could not verify'], data: null });
    }

    if (remote.status === 'not_found') return acknowledge(res, 'ignored', 'Unknown reference');

    const status = remote.status;

    // The token comes from the authenticated answer when it has one. The body's
    // is used only when it does not, and only on a vend the requery itself
    // says succeeded: a token is not a money decision - it is a string the
    // customer types into a meter - and a junk one on a genuinely delivered
    // bill is recoverable, where a missing one is not.
    let token = remote.token;
    if (!token && status === 'successful') {
      token = delivery.token || mysubwallet.extractToken({ message: delivery.response });
    }

    const row = await prisma.walletTransaction.findUnique({ where: { trx: delivery.reference } });

    if (!row) {
      // Bill Hero rewards vend through the same key but land in their own
      // table, so a reference with no ledger row is routine rather than an
      // error. They go through the same transitions as the reward delivery
      // sweep - a failure is re-sent automatically, not just reopened - and
      // the two can race freely.
      const settled = await billHero.settleRewardFromProvider({
        reference: delivery.reference,
        status,
        gateway: GATEWAY,
      });
      return acknowledge(res, settled ? 'ok' : 'ignored', settled ? 'OK' : 'Unknown reference');
    }

    const meta = row.meta && typeof row.meta === 'object' ? row.meta : {};

    // Never settle a row another provider sold - a Payvessel betting row
    // included. Their requery could not have answered for it anyway, but this
    // is the line that makes sure.
    if (String(meta.gateway || '') !== GATEWAY) {
      return acknowledge(res, 'ignored', 'Not a MySubWallet transaction');
    }

    const result = await settlement.applyOutcome({
      trx: row.trx,
      status,
      token,
      units: remote.units,
      reason: 'Provider reported failure on callback',
    });

    // Ids and outcomes only. Their `response` text can quote a meter number or
    // a phone number.
    console.log('mysubwallet.webhook:', {
      trx: row.trx,
      status,
      applied: result.applied,
      outcome: result.reason || 'applied',
    });

    return acknowledge(res);
  } catch (e) {
    console.error('mysubwallet.webhook error:', e?.message);
    // Deliberately a 200. The delivery has been read; if settlement broke, a
    // retry will break the same way, and the sweeps pick the row up anyway.
    return acknowledge(res, 'error', 'Received');
  }
}

module.exports = { webhook, parseDelivery };
