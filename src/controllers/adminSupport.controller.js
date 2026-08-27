// Admin half of the ticket system. Mounted under /api/admin behind
// adminAuth.middleware (shared secret), so nothing here reads req.user.
//
// Search is exact-match by construction: name, email and phone live as
// ciphertext, and the only thing we can compare is their blind index. Same
// limitation as admin user search - a fragment of a name will not match.
const prisma = require('../../database/prisma');
const { blindIndex } = require('../helpers/pii.helper');
const Support = require('./support.controller');

const { STATUS, STATUS_LABEL, PRIORITY_LABEL } = Support;

function fail(res, message, remark = 'validation_error', code = 200) {
  return res.status(code).json({ remark, status: 'error', message: [message], data: null });
}

function ok(res, data, message = 'OK', remark = 'support') {
  return res.json({ remark, status: 'success', message: [message], data });
}

/**
 * `q` can be a ticket code, an email, a phone number or a full name. We do not
 * know which, so every index is tried and the first that matches wins.
 */
function searchWhere(q) {
  const value = Support.sanitize(q);
  if (!value) return null;
  const or = [{ ticket: value.toUpperCase() }];
  const email = blindIndex(value.toLowerCase(), 'email');
  const phone = blindIndex(Support.normalizeNgPhone(value), 'mobile');
  const name = blindIndex(value, 'name');
  if (email) or.push({ email_idx: email });
  if (phone) or.push({ phone_idx: phone });
  if (name) or.push({ name_idx: name });
  return { OR: or };
}

async function listTickets(req, res) {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
    const perPage = Math.min(Math.max(parseInt(req.query.perPage || '20', 10) || 20, 1), 100);

    const filters = [];
    const search = searchWhere(req.query.q);
    if (search) filters.push(search);

    const status = Support.parseStatus(req.query.status);
    if (status !== null) filters.push({ status });
    if (Support.sanitize(req.query.priority)) filters.push({ priority: Support.parsePriority(req.query.priority) });

    const from = Support.sanitize(req.query.from);
    const to = Support.sanitize(req.query.to);
    if (from || to) {
      const created_at = {};
      if (from) created_at.gte = new Date(`${from}T00:00:00`);
      // `to` is a calendar day, so it has to cover the whole of it.
      if (to) created_at.lte = new Date(`${to}T23:59:59.999`);
      filters.push({ created_at });
    }

    // `since` is an instant, not a calendar day - the dashboard bell passes the
    // moment it last showed the admin a ticket, and gets back the ones that
    // arrived after it.
    const since = Support.sanitize(req.query.since);
    if (since) {
      const at = new Date(since);
      if (!Number.isNaN(at.getTime())) filters.push({ created_at: { gt: at } });
    }

    const where = filters.length ? { AND: filters } : {};
    const total = await prisma.supportTicket.count({ where });
    const rows = await prisma.supportTicket.findMany({
      where,
      orderBy: { last_reply: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    });

    const counts = await prisma.supportTicket.groupBy({ by: ['status'], _count: { _all: true } });
    const byStatus = { open: 0, in_progress: 0, resolved: 0, closed: 0 };
    const key = { 0: 'open', 1: 'in_progress', 2: 'resolved', 3: 'closed' };
    for (const row of counts) byStatus[key[row.status]] = row._count._all;

    return ok(
      res,
      {
        items: rows.map(Support.serializeTicket),
        counts: byStatus,
        pagination: { page, perPage, total, totalPages: Math.max(Math.ceil(total / perPage), 1) },
      },
      'Support tickets',
      'support_tickets'
    );
  } catch (error) {
    console.error('adminSupport.listTickets failed:', error?.message || error);
    return fail(res, 'Failed to load tickets', 'error', 500);
  }
}

async function getTicket(req, res) {
  try {
    const ticket = await Support.findTicket(req.params.id);
    if (!ticket) return fail(res, 'Ticket not found', 'not_found', 404);

    // Internal notes are included here and nowhere else.
    const messages = await prisma.supportTicketMessage.findMany({
      where: { ticket_id: ticket.id },
      orderBy: { created_at: 'asc' },
    });

    return ok(
      res,
      { ticket: Support.serializeTicket(ticket), messages: messages.map(row => Support.serializeMessage(row, ticket)) },
      'Ticket details',
      'support_ticket'
    );
  } catch (error) {
    console.error('adminSupport.getTicket failed:', error?.message || error);
    return fail(res, 'Failed to load the ticket', 'error', 500);
  }
}

async function replyTicket(req, res) {
  try {
    const ticket = await Support.findTicket(req.params.id);
    if (!ticket) return fail(res, 'Ticket not found', 'not_found', 404);

    const message = Support.sanitize(req.body.message);
    if (!message) return fail(res, 'Message is required');
    if (message.length > 5000) return fail(res, 'Message is too long');

    const isInternal = req.body.internal === true || req.body.internal === 'true';
    const adminName = Support.sanitize(req.body.admin_name) || null;
    const requested = Support.parseStatus(req.body.status);
    // A public reply moves an untouched ticket to In Progress unless the admin
    // asked for something else. A note changes nothing.
    const status = isInternal ? null : (requested !== null ? requested : (ticket.status === STATUS.OPEN ? STATUS.IN_PROGRESS : null));

    const files = await Support.storeAttachments(req.files);
    const result = await Support.appendMessage(ticket, { message, files, isAdmin: true, isInternal, adminName, status });

    if (!isInternal) {
      await Support.notifyTicketUser(result.ticket, {
        subject: 'Support replied to your ticket',
        body: message,
        type: 'support_reply',
      });
    }

    return ok(res, { ticket: ticket.ticket, id: ticket.id }, isInternal ? 'Note saved' : 'Reply sent', 'support_reply');
  } catch (error) {
    console.error('adminSupport.replyTicket failed:', error?.message || error);
    return fail(res, 'Failed to send the reply', 'error', 500);
  }
}

async function updateStatus(req, res) {
  try {
    const ticket = await Support.findTicket(req.params.id);
    if (!ticket) return fail(res, 'Ticket not found', 'not_found', 404);

    const status = Support.parseStatus(req.body.status);
    if (status === null) return fail(res, 'Unknown status');
    if (status === ticket.status) return ok(res, { ticket: ticket.ticket }, 'Status unchanged', 'support_status');

    const data = { status };
    if (status === STATUS.RESOLVED) data.resolved_at = new Date();
    if (status === STATUS.CLOSED) data.closed_at = new Date();
    if (status === STATUS.OPEN || status === STATUS.IN_PROGRESS) {
      data.resolved_at = null;
      data.closed_at = null;
    }
    const updated = await prisma.supportTicket.update({ where: { id: ticket.id }, data });

    // The user only needs to hear about an outcome, not about us picking the
    // ticket up.
    if (status === STATUS.RESOLVED || status === STATUS.CLOSED) {
      await Support.notifyTicketUser(updated, {
        subject: `Support ticket ${STATUS_LABEL[status].toLowerCase()}`,
        body:
          status === STATUS.RESOLVED
            ? `Ticket ${ticket.ticket} has been marked resolved. Reply in the app if you still need help, and let us know how we did.`
            : `Ticket ${ticket.ticket} has been closed. You can reopen it from the app any time.`,
        type: status === STATUS.RESOLVED ? 'support_resolved' : 'support_closed',
      });
    }

    return ok(res, { ticket: ticket.ticket, status: String(status), status_label: STATUS_LABEL[status] }, 'Status updated', 'support_status');
  } catch (error) {
    console.error('adminSupport.updateStatus failed:', error?.message || error);
    return fail(res, 'Failed to update the status', 'error', 500);
  }
}

async function updatePriority(req, res) {
  try {
    const ticket = await Support.findTicket(req.params.id);
    if (!ticket) return fail(res, 'Ticket not found', 'not_found', 404);

    const priority = Support.parsePriority(req.body.priority);
    await prisma.supportTicket.update({ where: { id: ticket.id }, data: { priority } });

    return ok(res, { ticket: ticket.ticket, priority: String(priority), priority_label: PRIORITY_LABEL[priority] }, 'Priority updated', 'support_priority');
  } catch (error) {
    console.error('adminSupport.updatePriority failed:', error?.message || error);
    return fail(res, 'Failed to update the priority', 'error', 500);
  }
}

module.exports = { listTickets, getTicket, replyTicket, updateStatus, updatePriority };
