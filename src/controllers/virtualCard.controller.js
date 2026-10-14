// USD Virtual Mastercard - the customer's side. The engine is
// services/virtualCard.service.js; this file is HTTP in and out.
//
//   GET    /virtual-card                  home: settings, the card, recent activity
//   GET    /virtual-card/form             the application, prefilled from the account
//   POST   /virtual-card/validate         the review step - checks everything, moves nothing
//   POST   /virtual-card/create           { pin, consent, expected_fee, image, address, (bvn), (nin), (dob) }
//   GET    /virtual-card/quote?amount=    prices a top-up, moves nothing
//   POST   /virtual-card/fund             { amount, expected_total, pin }
//   POST   /virtual-card/freeze           {}
//   POST   /virtual-card/unfreeze         { pin }
//   GET    /virtual-card/terminate        what terminating would return to the wallet
//   POST   /virtual-card/terminate        { pin } -> closed for good, balance credited
//   POST   /virtual-card/reveal           { pin } -> the full card details, once
//   GET    /virtual-card/transactions     the card's history, paged
//   POST   /virtual-card/webhook          Payvessel, HMAC-signed (public)
//
// Nothing logged here carries the body: it holds a PIN, a BVN, a NIN and a
// photograph. And reveal's response is the card number itself - it is sent
// with no-store and never echoed anywhere else.
const service = require('../services/virtualCard.service');
const payvessel = require('../funding/payvesselCard.service');
const VC = require('../helpers/virtualCard.helper');
const { securityEvent, captureError } = require('../services/alerts.service');

function ok(res, remark, message, data = null) {
  return res.json({ remark, status: 'success', message: [message], data });
}

function fail(res, status, remark, message, data = null) {
  return res.status(status).json({ remark, status: 'error', message: [message], data });
}

/** A refusal the service worded for the customer, or a 500 that says nothing. */
function sendError(res, e, req, where, fallback) {
  if (res.headersSent) return res.end();
  if (e?.remark && e?.statusCode) return fail(res, e.statusCode, e.remark, e.message, e.data || null);
  if (service.isSchemaBehind(e)) {
    service.warnSchemaBehind();
    return fail(res, 503, 'service_unavailable', 'USD cards are not available right now. Please try again shortly.');
  }
  // Ids only. The error can carry a provider message that quotes a name.
  console.error(`virtualCard.${where} error:`, { user_id: req.user?.id, kind: e?.kind || null, message: String(e?.message || '').slice(0, 160) });
  return fail(res, 500, 'error', fallback);
}

async function home(req, res) {
  try {
    return ok(res, 'virtual_card', 'OK', await service.home(req.user.id));
  } catch (e) {
    return sendError(res, e, req, 'home', 'Could not load your USD card');
  }
}

async function form(req, res) {
  try {
    return ok(res, 'virtual_card_form', 'OK', await service.form(req.user.id));
  } catch (e) {
    return sendError(res, e, req, 'form', 'Could not load the card application');
  }
}

async function validate(req, res) {
  try {
    const { summary } = await service.validateApplication(req.user.id, req.body || {});
    return ok(res, 'virtual_card_review', 'Review your details and pay to create your card.', { review: summary });
  } catch (e) {
    return sendError(res, e, req, 'validate', 'Could not check your details. Please try again.');
  }
}

async function create(req, res) {
  try {
    const body = req.body || {};
    const result = await service.createCard({ userId: req.user.id, body, pin: body.pin, req });
    return ok(
      res,
      result.processing ? 'virtual_card_processing' : 'virtual_card_created',
      result.processing ? 'We are creating your USD card. This usually takes a few minutes.' : 'Your USD card is ready.',
      result,
    );
  } catch (e) {
    return sendError(res, e, req, 'create', 'Could not create your card. Please try again.');
  }
}

async function quote(req, res) {
  try {
    return ok(res, 'virtual_card_quote', 'OK', await service.quote(req.user.id, req.query?.amount));
  } catch (e) {
    return sendError(res, e, req, 'quote', 'Could not price this top-up');
  }
}

async function fund(req, res) {
  try {
    const body = req.body || {};
    const result = await service.fundCard({
      userId: req.user.id,
      amountNgn: body.amount,
      expectedTotal: body.expected_total,
      pin: body.pin,
      req,
    });
    return ok(
      res,
      result.processing ? 'virtual_card_fund_processing' : 'virtual_card_funded',
      result.processing ? 'Your top-up is being confirmed. We will let you know shortly.' : `${result.funding.amount_usd ? `$${result.funding.amount_usd}` : 'Your top-up'} has been added to your card.`,
      result,
    );
  } catch (e) {
    return sendError(res, e, req, 'fund', 'Could not top up your card. Please try again.');
  }
}

async function freeze(req, res) {
  try {
    return ok(res, 'virtual_card_frozen', 'Your card is frozen. Payments will be declined until you unfreeze it.', await service.freeze({ userId: req.user.id, req }));
  } catch (e) {
    return sendError(res, e, req, 'freeze', 'Could not freeze your card. Please try again.');
  }
}

async function unfreeze(req, res) {
  try {
    return ok(res, 'virtual_card_unfrozen', 'Your card is active again.', await service.unfreeze({ userId: req.user.id, pin: req.body?.pin, req }));
  } catch (e) {
    return sendError(res, e, req, 'unfreeze', 'Could not unfreeze your card. Please try again.');
  }
}

async function terminationPreview(req, res) {
  try {
    return ok(res, 'virtual_card_termination', 'OK', await service.terminationPreview(req.user.id));
  } catch (e) {
    return sendError(res, e, req, 'terminationPreview', 'Could not load your card');
  }
}

async function terminate(req, res) {
  try {
    const result = await service.terminate({ userId: req.user.id, pin: req.body?.pin, req });
    const refund = result.refund;
    let message;
    if (result.pending) message = 'We are confirming the termination with our card partner. We will notify you shortly.';
    else if (result.alreadyTerminated) message = 'Your card is terminated.';
    else if (refund && refund.kobo > 0) message = `Your card is terminated. ${VC.nairaText(refund.kobo)} has been returned to your wallet.`;
    else message = 'Your card is terminated.';
    return ok(res, result.pending ? 'virtual_card_terminating' : 'virtual_card_terminated', message, {
      card: result.card,
      pending: Boolean(result.pending),
      already_terminated: Boolean(result.alreadyTerminated),
      refund_ngn: refund && refund.kobo > 0 ? refund.kobo / 100 : 0,
    });
  } catch (e) {
    return sendError(res, e, req, 'terminate', 'Could not terminate your card. Please try again.');
  }
}

async function reveal(req, res) {
  try {
    const data = await service.revealDetails({ userId: req.user.id, pin: req.body?.pin, req });
    // The card number, once. Nothing between here and the phone may keep it.
    res.set('Cache-Control', 'no-store, max-age=0');
    res.set('Pragma', 'no-cache');
    return ok(res, 'virtual_card_details', 'OK', data);
  } catch (e) {
    return sendError(res, e, req, 'reveal', 'Could not load your card details. Please try again.');
  }
}

async function transactions(req, res) {
  try {
    return ok(res, 'virtual_card_transactions', 'OK', await service.transactions(req.user.id, { page: req.query?.page }));
  } catch (e) {
    return sendError(res, e, req, 'transactions', 'Could not load your card history');
  }
}

/**
 * Public. The HMAC over the raw body is the authentication; an opt-in IP
 * allowlist (PAYVESSEL_WEBHOOK_IPS) is the second check.
 *
 * Payvessel counts a delivery as failed after 10 seconds and sends it again,
 * so the order is: verify, log the delivery, apply it (database work only),
 * answer - and only THEN read the card back from Payvessel (`followUp`). 200
 * only once our state change committed; a 5xx makes Payvessel retry, and every
 * handler is idempotent, so a retry is always safe. A delivery already
 * processed is acknowledged without being applied again.
 *
 * Returns the follow-up's promise so a test can wait for it; Express ignores
 * what a handler returns, and the follow-up catches its own errors.
 */
async function webhook(req, res) {
  const signature = payvessel.signatureFrom(req.headers);
  const rawBody = req.rawBody;
  if (!payvessel.verifyWebhookSignature({ rawBody, signature })) {
    securityEvent('webhook.bad_signature', 'Payvessel card webhook rejected: signature did not verify', {
      has_signature: Boolean(signature),
      source: 'virtual_card',
    });
    return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Invalid signature'], data: null });
  }
  if (!payvessel.webhookIpAllowed(req.ip)) {
    securityEvent('webhook.bad_ip', 'Payvessel card webhook from an address not on PAYVESSEL_WEBHOOK_IPS', { source: 'virtual_card' });
    return res.status(403).json({ remark: 'forbidden', status: 'error', message: ['Forbidden'], data: null });
  }

  const body = req.body || {};
  // The log is for visibility and retry detection. A database that does not
  // have the table yet must not cost us the event itself.
  let delivery = null;
  try {
    delivery = await service.recordDelivery(rawBody, body);
  } catch (e) {
    if (service.isSchemaBehind(e)) service.warnSchemaBehind();
    else console.error('virtualCard.webhook log failed:', { event: String(body.event || '').slice(0, 40), message: String(e?.message || '').slice(0, 160) });
  }
  if (delivery?.duplicate && ['processed', 'ignored'].includes(delivery.row?.outcome)) {
    return res.json({ remark: 'ok', status: 'success', message: ['Already processed'], data: { duplicate: true } });
  }

  let result;
  try {
    result = await service.handleWebhook(body);
  } catch (e) {
    if (service.isSchemaBehind(e)) service.warnSchemaBehind();
    await service.markDelivery(delivery, 'failed', { detail: String(e?.message || 'error').slice(0, 160) });
    console.error('virtualCard.webhook error:', { event: String(body.event || '').slice(0, 40), message: String(e?.message || '').slice(0, 160) });
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to process'], data: null });
  }

  await service.markDelivery(delivery, result.handled ? 'processed' : 'ignored', { cardId: result.cardId || null, detail: result.reason || null });
  res.json({ remark: 'ok', status: 'success', message: ['OK'], data: { handled: result.handled } });

  if (typeof result.followUp !== 'function') return undefined;
  return Promise.resolve()
    .then(result.followUp)
    .catch(e => captureError('virtual_card.webhook_followup', e, { card_id: result.cardId || null, event: String(body.event || '').slice(0, 40) }));
}

module.exports = { home, form, validate, create, quote, fund, freeze, unfreeze, terminationPreview, terminate, reveal, transactions, webhook };
