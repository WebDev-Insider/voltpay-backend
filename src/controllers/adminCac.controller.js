/**
 * CAC Registration - the processing queue and the prices.
 *
 *   GET   /admin/cac/settings                          every type's price, time, on/off + the service switch
 *   PATCH /admin/cac/settings                          { registration_type, price?, processing_time?, enabled? }
 *                                                      or { enabled } for the whole service - finance | superadmin
 *   GET   /admin/cac/applications                      the queue - paid applications only
 *   GET   /admin/cac/applications/:id                  one application, logged as a disclosure
 *   GET   /admin/cac/applications/:id/documents/:kind  one of the customer's documents, streamed, logged
 *   POST  /admin/cac/applications/:id/start            -> in_progress
 *   POST  /admin/cac/applications/:id/request-info     { note } -> needs_more_info
 *   POST  /admin/cac/applications/:id/deliverables     multipart `file` + kind, label (+ registered_name,
 *                                                      registration_number with the certificate) - one per call
 *   GET   /admin/cac/applications/:id/deliverables/:docId  an issued document, streamed
 *   DELETE /admin/cac/applications/:id/deliverables/:docId a wrong one (never a completed certificate)
 *   POST  /admin/cac/applications/:id/complete         -> completed (certificate required)
 *   POST  /admin/cac/applications/:id/reject           { note, refund } -> rejected
 *   POST  /admin/cac/applications/:id/refund           finance | superadmin
 *   POST  /admin/cac/applications/:id/notes            { note } - internal
 *
 * Every write is recorded by adminAudit.middleware. The two reads that hand an
 * admin somebody's identity - the application and its documents - record
 * themselves here, because that middleware only sees writes.
 */
const service = require('../services/cac.service');
const CAC = require('../helpers/cac.helper');
const { logAdminAction, clientIp } = require('../services/audit.service');

// A refund writes money into a wallet, so it carries the same role gate as the
// price and the Airtime to Cash settlement.
const MONEY_ROLES = new Set(['finance', 'superadmin']);

function ok(res, remark, message, data = null) {
  return res.json({ remark, status: 'success', message: [message], data });
}

function fail(res, status, remark, message, data = null) {
  return res.status(status).json({ remark, status: 'error', message: [message], data });
}

function sendError(res, e, req, where, fallback) {
  if (res.headersSent) return res.end();
  if (e?.remark && e?.statusCode) return fail(res, e.statusCode, e.remark, e.message, e.data || null);
  // An admin can act on this one, so the fix is in the message itself.
  if (service.isSchemaBehind(e)) {
    service.warnSchemaBehind();
    return fail(res, 503, 'schema_out_of_date', 'The CAC tables are missing or out of date. Run `npm run ddl:cac` on the backend.');
  }
  console.error(`adminCac.${where} error:`, { id: req.params?.id, message: e?.message });
  return fail(res, 500, 'error', fallback);
}

/** Ids and states only - the disclosure is never written into its own record. */
function logView(req, action, applicationId, metadata = {}) {
  const admin = req.admin;
  return logAdminAction({
    actor: admin?.name || (admin?.id ? `admin:${admin.id}` : 'admin'),
    action,
    method: 'GET',
    path: req.originalUrl?.slice(0, 256) || null,
    targetType: 'cac_application',
    targetId: applicationId,
    statusCode: 200,
    ip: clientIp(req),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 256) || null,
    metadata: { admin_id: admin?.id || null, ...metadata },
  }).catch(() => {});
}

async function getSettings(req, res) {
  try {
    const settings = await service.getSettings();
    return ok(res, 'cac_settings', 'OK', { ...settings, min_price: CAC.MIN_PRICE, max_price: CAC.MAX_PRICE });
  } catch (e) {
    return sendError(res, e, req, 'getSettings', 'Could not load the CAC settings');
  }
}

async function updateSettings(req, res) {
  try {
    const body = req.body || {};
    const settings = await service.updateSettings({
      registration_type: body.registration_type,
      price: body.price,
      processing_time: body.processing_time,
      enabled: body.enabled,
    });
    return ok(res, 'cac_settings', 'CAC settings saved', { ...settings, min_price: CAC.MIN_PRICE, max_price: CAC.MAX_PRICE });
  } catch (e) {
    return sendError(res, e, req, 'updateSettings', 'Could not save the CAC settings');
  }
}

async function listApplications(req, res) {
  try {
    const data = await service.adminList({
      status: String(req.query?.status || '').trim().toLowerCase(),
      type: String(req.query?.type || '').trim().toLowerCase(),
      q: req.query?.q,
      page: req.query?.page,
      perPage: req.query?.perPage,
    });
    return ok(res, 'cac_applications', 'OK', data);
  } catch (e) {
    return sendError(res, e, req, 'listApplications', 'Could not load the CAC queue');
  }
}

async function getApplication(req, res) {
  try {
    const data = await service.adminDetail(req.params?.id);
    await logView(req, 'admin.cac_application_viewed', data.application.id, { status: data.application.status });
    return ok(res, 'cac_application', 'OK', data);
  } catch (e) {
    return sendError(res, e, req, 'getApplication', 'Could not load this application');
  }
}

async function viewDocument(req, res) {
  try {
    const kind = String(req.params?.kind || '');
    const row = await service.adminDocument(res, req.params?.id, kind);
    await logView(req, 'admin.cac_document_viewed', row.id, { kind });
  } catch (e) {
    return sendError(res, e, req, 'viewDocument', 'Could not load this document');
  }
}

function transition(action, message) {
  return async function adminCacTransition(req, res) {
    try {
      const refund = action === 'reject' && (req.body?.refund === true || req.body?.refund === 'true');
      if (refund && !MONEY_ROLES.has(req.admin?.role)) {
        return fail(res, 403, 'forbidden', 'Refunding needs the finance or superadmin role. Reject without a refund, and ask finance to refund it.');
      }
      const { refund_trx: refundTrx } = await service.adminTransition({
        id: req.params?.id,
        action,
        note: req.body?.note,
        refund,
        admin: req.admin,
      });
      const data = await service.adminDetail(req.params?.id);
      return ok(res, `cac_${action}`, refundTrx ? `${message} and refunded` : message, data);
    } catch (e) {
      return sendError(res, e, req, action, 'That did not go through. Please try again.');
    }
  };
}

const start = transition('start', 'Marked in progress - the customer has been notified');
const requestInfo = transition('request_info', 'Request sent to the customer');
const complete = transition('complete', 'Marked completed - the customer has been notified');
const reject = transition('reject', 'Application rejected');

async function uploadDeliverable(req, res) {
  try {
    const { deliverable } = await service.adminUploadDeliverable({
      id: req.params?.id,
      file: req.file,
      kind: req.body?.kind,
      label: req.body?.label,
      registeredName: req.body?.registered_name,
      registrationNumber: req.body?.registration_number,
      admin: req.admin,
    });
    const data = await service.adminDetail(req.params?.id);
    return ok(res, 'cac_deliverable_uploaded', deliverable.kind === 'certificate' ? 'Certificate uploaded' : 'Document uploaded', data);
  } catch (e) {
    return sendError(res, e, req, 'uploadDeliverable', 'Could not upload the document');
  }
}

async function viewDeliverable(req, res) {
  try {
    const { row, deliverable } = await service.adminDeliverable(res, req.params?.id, req.params?.docId);
    await logView(req, 'admin.cac_deliverable_viewed', row.id, { deliverable_id: deliverable.id, kind: deliverable.kind });
  } catch (e) {
    return sendError(res, e, req, 'viewDeliverable', 'Could not load this document');
  }
}

async function deleteDeliverable(req, res) {
  try {
    await service.adminDeleteDeliverable({ id: req.params?.id, docId: req.params?.docId, admin: req.admin });
    const data = await service.adminDetail(req.params?.id);
    return ok(res, 'cac_deliverable_removed', 'Document removed', data);
  } catch (e) {
    return sendError(res, e, req, 'deleteDeliverable', 'Could not remove the document');
  }
}

async function refund(req, res) {
  try {
    await service.adminRefund({ id: req.params?.id, admin: req.admin });
    const data = await service.adminDetail(req.params?.id);
    return ok(res, 'cac_refunded', 'Refunded to the customer\'s wallet', data);
  } catch (e) {
    return sendError(res, e, req, 'refund', 'Could not refund this application');
  }
}

async function addNote(req, res) {
  try {
    await service.adminAddNote({ id: req.params?.id, note: req.body?.note, admin: req.admin });
    const data = await service.adminDetail(req.params?.id);
    return ok(res, 'cac_note_added', 'Note added', data);
  } catch (e) {
    return sendError(res, e, req, 'addNote', 'Could not add the note');
  }
}

module.exports = {
  getSettings,
  updateSettings,
  listApplications,
  getApplication,
  viewDocument,
  start,
  requestInfo,
  uploadDeliverable,
  viewDeliverable,
  deleteDeliverable,
  complete,
  reject,
  refund,
  addNote,
};
