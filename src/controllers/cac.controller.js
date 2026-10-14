// CAC Registration - the customer's side. The engine is services/cac.service.js;
// this file is HTTP in and out.
//
//   GET    /cac                                     home: price, time, draft, latest
//   GET    /cac/applications                        history, paged, by status
//   GET    /cac/applications/:id                    one application + timeline
//   POST   /cac/applications                        the form + 3 documents -> draft
//   POST   /cac/applications/:id/update             edit a draft / answer "needs more info"
//   DELETE /cac/applications/:id                    drop an unpaid draft
//   POST   /cac/applications/:id/pay/wallet         { pin, expected_amount }
//   POST   /cac/applications/:id/paystack           { expected_amount } -> checkout link
//   POST   /cac/applications/:id/paystack/verify    { reference }
//   GET    /cac/applications/:id/deliverables/:docId  an issued document, once completed
//   GET    /cac/paystack/callback                   where Paystack sends the browser back
//
// Nothing logged here carries the body: it holds a PIN, an address, a date of
// birth and three photographs.
const service = require('../services/cac.service');
const CAC = require('../helpers/cac.helper');

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
  // The database is behind the code. Ours to fix with `npm run ddl:cac`, and
  // temporary from the customer's side - so a 503 they can retry, not a 500.
  if (service.isSchemaBehind(e)) {
    service.warnSchemaBehind();
    return fail(res, 503, 'service_unavailable', 'CAC Registration is not available right now. Please try again shortly.');
  }
  console.error(`cac.${where} error:`, { user_id: req.user?.id, message: e?.message });
  return fail(res, 500, 'error', fallback);
}

async function home(req, res) {
  try {
    return ok(res, 'cac_home', 'OK', await service.home(req.user.id));
  } catch (e) {
    return sendError(res, e, req, 'home', 'Could not load CAC Registration');
  }
}

async function applications(req, res) {
  try {
    const data = await service.listForUser(req.user.id, {
      status: String(req.query?.status || '').trim().toLowerCase(),
      page: req.query?.page,
    });
    return ok(res, 'cac_applications', 'OK', data);
  } catch (e) {
    return sendError(res, e, req, 'applications', 'Could not load your applications');
  }
}

async function details(req, res) {
  try {
    const application = await service.detailForUser(req.user.id, req.params?.id);
    return ok(res, 'cac_application', 'OK', { application });
  } catch (e) {
    return sendError(res, e, req, 'details', 'Could not load this application');
  }
}

async function create(req, res) {
  try {
    const application = await service.createDraft({ userId: req.user.id, body: req.body || {}, files: req.files, req });
    return ok(res, 'cac_draft_saved', 'Application saved. Review it and pay to submit.', { application });
  } catch (e) {
    return sendError(res, e, req, 'create', 'Could not save your application. Please try again.');
  }
}

async function update(req, res) {
  try {
    const application = await service.updateApplication({
      userId: req.user.id,
      id: req.params?.id,
      body: req.body || {},
      files: req.files,
      req,
    });
    const resubmitted = application.status === CAC.STATUS.SUBMITTED;
    return ok(
      res,
      resubmitted ? 'cac_info_provided' : 'cac_draft_saved',
      resubmitted ? 'Thanks - your update has been sent for review.' : 'Application updated',
      { application },
    );
  } catch (e) {
    return sendError(res, e, req, 'update', 'Could not update your application. Please try again.');
  }
}

async function discard(req, res) {
  try {
    await service.discardDraft({ userId: req.user.id, id: req.params?.id });
    return ok(res, 'cac_draft_discarded', 'Application discarded');
  } catch (e) {
    return sendError(res, e, req, 'discard', 'Could not discard this application');
  }
}

async function payWallet(req, res) {
  try {
    const result = await service.payWithWallet({
      userId: req.user.id,
      id: req.params?.id,
      pin: req.body?.pin,
      expectedAmount: req.body?.expected_amount,
      req,
    });
    const application = await service.detailForUser(req.user.id, result.row.id);
    return ok(
      res,
      'cac_paid',
      result.alreadyPaid ? 'This application is already paid for' : 'Payment successful - your application has been submitted',
      { application, already_paid: Boolean(result.alreadyPaid), trx: result.trx || null },
    );
  } catch (e) {
    return sendError(res, e, req, 'payWallet', 'Could not complete the payment. Please try again.');
  }
}

async function paystackInit(req, res) {
  try {
    const checkout = await service.initializePaystack({
      userId: req.user.id,
      id: req.params?.id,
      expectedAmount: req.body?.expected_amount,
      req,
    });
    return ok(res, 'cac_checkout', 'OK', checkout);
  } catch (e) {
    return sendError(res, e, req, 'paystackInit', 'Could not start the payment. Please try again.');
  }
}

async function paystackVerify(req, res) {
  try {
    const { result, application } = await service.verifyPaystack({
      userId: req.user.id,
      id: req.params?.id,
      reference: req.body?.reference,
    });
    const message = result.paid
      ? 'Payment successful - your application has been submitted'
      : result.duplicate
        ? 'This application was already paid for, so this payment was returned to your wallet'
        : 'We have not received this payment yet';
    return ok(res, result.paid ? 'cac_paid' : 'cac_payment_pending', message, {
      application,
      payment_state: result.state,
      paid: Boolean(result.paid),
    });
  } catch (e) {
    return sendError(res, e, req, 'paystackVerify', 'Could not check the payment. Please try again.');
  }
}

async function deliverable(req, res) {
  try {
    await service.deliverableForUser(res, req.user.id, req.params?.id, req.params?.docId);
  } catch (e) {
    return sendError(res, e, req, 'deliverable', 'Could not download the document. Please try again.');
  }
}

/**
 * Where Paystack sends the browser after checkout. Public, and it decides
 * nothing: the app verifies over its own session, the webhook is signed, and
 * the sweep asks Paystack directly. Echoes no query value - a page that
 * reflects its URL into HTML is a cross-site scripting hole on the API domain.
 */
function paystackCallback(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(`<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>VoltPay</title>
    <style>body{font-family:system-ui,Segoe UI,Roboto,Arial;padding:32px 20px;color:#1b1b1f}.box{max-width:480px;margin:0 auto;text-align:center}.muted{color:#666}</style>
  </head>
  <body>
    <div class="box">
      <h2>You can return to VoltPay</h2>
      <p class="muted">Your CAC application updates as soon as Paystack confirms the payment.</p>
    </div>
  </body>
</html>`);
}

module.exports = {
  home,
  applications,
  details,
  create,
  update,
  discard,
  payWallet,
  paystackInit,
  paystackVerify,
  deliverable,
  paystackCallback,
};
