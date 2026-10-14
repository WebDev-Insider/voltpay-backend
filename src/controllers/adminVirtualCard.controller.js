/**
 * USD Virtual Mastercard - the support and finance view.
 *
 *   GET   /admin/virtual-cards/overview        counts, today's top-ups, fees, Payvessel float, settings
 *   GET   /admin/virtual-cards/settings        the pricing and limits, cost rate included
 *   PATCH /admin/virtual-cards/settings        any subset of them, or { enabled } - finance | superadmin
 *   GET   /admin/virtual-cards/fundings        every top-up, by status - failed and stuck included
 *   GET   /admin/virtual-cards/webhooks        Payvessel's deliveries, newest first, + the URL to configure
 *   GET   /admin/virtual-cards                 the cards, by status (failed creations are a tab)
 *   GET   /admin/virtual-cards/:id             one card: provider refs, top-ups, activity, events
 *   POST  /admin/virtual-cards/:id/freeze      { note } - a risk hold the customer cannot lift
 *   POST  /admin/virtual-cards/:id/unfreeze    { note }
 *   POST  /admin/virtual-cards/:id/terminate   { note } - permanent; the balance goes to the wallet - finance | superadmin
 *   POST  /admin/virtual-cards/:id/sync        re-read the card, its history and anything in flight
 *
 * No admin action moves money by hand. Every refund here is the engine's own,
 * guarded and automatic; "sync" only makes it happen now rather than at the
 * next sweep. Writes are recorded by adminAudit.middleware; the card view is a
 * disclosure (a name beside a masked card number) and records itself.
 */
const service = require('../services/virtualCard.service');
const { logAdminAction, clientIp } = require('../services/audit.service');

function ok(res, remark, message, data = null) {
  return res.json({ remark, status: 'success', message: [message], data });
}

function fail(res, status, remark, message, data = null) {
  return res.status(status).json({ remark, status: 'error', message: [message], data });
}

function sendError(res, e, req, where, fallback) {
  if (res.headersSent) return res.end();
  if (e?.remark && e?.statusCode) return fail(res, e.statusCode, e.remark, e.message, e.data || null);
  if (service.isSchemaBehind(e)) {
    service.warnSchemaBehind();
    return fail(res, 503, 'schema_out_of_date', 'The USD card tables are missing or out of date. Run `npm run ddl:virtual-card` on the backend.');
  }
  console.error(`adminVirtualCard.${where} error:`, { id: req.params?.id, kind: e?.kind || null, message: String(e?.message || '').slice(0, 160) });
  return fail(res, 500, 'error', fallback);
}

function logView(req, cardId) {
  const admin = req.admin;
  return logAdminAction({
    actor: admin?.name || (admin?.id ? `admin:${admin.id}` : 'admin'),
    action: 'virtual_card.view',
    method: 'GET',
    path: req.originalUrl?.slice(0, 256) || null,
    targetType: 'virtual_card',
    targetId: cardId,
    statusCode: 200,
    ip: clientIp(req),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 256) || null,
    metadata: { admin_id: admin?.id || null },
  }).catch(() => {});
}

async function overview(req, res) {
  try {
    return ok(res, 'virtual_card_overview', 'OK', await service.adminOverview());
  } catch (e) {
    return sendError(res, e, req, 'overview', 'Could not load the card overview');
  }
}

async function getSettings(req, res) {
  try {
    return ok(res, 'virtual_card_settings', 'OK', service.adminSettingsView(await service.getSettings()));
  } catch (e) {
    return sendError(res, e, req, 'getSettings', 'Could not load the card settings');
  }
}

async function updateSettings(req, res) {
  try {
    const settings = await service.updateSettings(req.body || {});
    return ok(res, 'virtual_card_settings_saved', 'Card settings saved', service.adminSettingsView(settings));
  } catch (e) {
    return sendError(res, e, req, 'updateSettings', 'Could not save the card settings');
  }
}

async function listCards(req, res) {
  try {
    const data = await service.adminList({
      status: String(req.query?.status || '').trim().toLowerCase(),
      q: req.query?.q,
      page: req.query?.page,
      perPage: req.query?.perPage,
    });
    return ok(res, 'virtual_cards', 'OK', data);
  } catch (e) {
    return sendError(res, e, req, 'listCards', 'Could not load the cards');
  }
}

async function listFundings(req, res) {
  try {
    const data = await service.adminFundings({
      status: String(req.query?.status || '').trim().toLowerCase(),
      q: req.query?.q,
      page: req.query?.page,
      perPage: req.query?.perPage,
    });
    return ok(res, 'virtual_card_fundings', 'OK', data);
  } catch (e) {
    return sendError(res, e, req, 'listFundings', 'Could not load the top-ups');
  }
}

/** The webhook log: what Payvessel delivered, when, and what we did with it. */
async function listWebhooks(req, res) {
  try {
    const data = await service.adminWebhooks({ page: req.query?.page, perPage: req.query?.perPage });
    return ok(res, 'virtual_card_webhooks', 'OK', { ...data, status: await service.webhookStatus() });
  } catch (e) {
    return sendError(res, e, req, 'listWebhooks', 'Could not load the webhook log');
  }
}

async function getCard(req, res) {
  try {
    const data = await service.adminDetail(req.params.id);
    logView(req, data.card.id);
    return ok(res, 'virtual_card', 'OK', data);
  } catch (e) {
    return sendError(res, e, req, 'getCard', 'Could not load this card');
  }
}

async function freeze(req, res) {
  try {
    const data = await service.adminSetFrozen({ id: req.params.id, frozen: true, note: req.body?.note, admin: req.admin });
    return ok(res, 'virtual_card_frozen', 'Card frozen. The customer cannot unfreeze it.', data);
  } catch (e) {
    return sendError(res, e, req, 'freeze', 'Could not freeze this card');
  }
}

async function unfreeze(req, res) {
  try {
    const data = await service.adminSetFrozen({ id: req.params.id, frozen: false, note: req.body?.note, admin: req.admin });
    return ok(res, 'virtual_card_unfrozen', 'Card unfrozen', data);
  } catch (e) {
    return sendError(res, e, req, 'unfreeze', 'Could not unfreeze this card');
  }
}

async function terminate(req, res) {
  try {
    const data = await service.adminTerminate({ id: req.params.id, note: req.body?.note, admin: req.admin });
    const message = data.pending
      ? 'Termination sent - Payvessel has not confirmed it yet. The sweep finishes it within minutes.'
      : data.already_terminated
        ? 'The card was already terminated at Payvessel - it is closed here too.'
        : 'Card terminated. Its balance has been credited to the customer\'s wallet.';
    return ok(res, 'virtual_card_terminated', message, data);
  } catch (e) {
    return sendError(res, e, req, 'terminate', 'Could not terminate this card');
  }
}

async function sync(req, res) {
  try {
    return ok(res, 'virtual_card_synced', 'Card re-read from Payvessel', await service.adminSync(req.params.id));
  } catch (e) {
    return sendError(res, e, req, 'sync', e?.kind ? `Payvessel did not answer: ${e.message}` : 'Could not sync this card');
  }
}

module.exports = { overview, getSettings, updateSettings, listCards, listFundings, listWebhooks, getCard, freeze, unfreeze, terminate, sync };
