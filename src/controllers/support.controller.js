// Support tickets. Everything a user or an admin writes lands in
// support_tickets / support_ticket_messages; email is a notification channel on
// top of that, not the store of record like it used to be.
//
// PII rules, same as everywhere else:
//   - name / email / phone      -> protect() = ciphertext + blind index. The
//                                  index is what admin search matches, so it is
//                                  exact-match only by construction.
//   - subject / message bodies  -> protectText(). Free text that routinely
//                                  names a person or quotes an account number.
//   - attachments               -> UploadThing. We keep the URL, not the file.
const prisma = require('../../database/prisma');
const { protect, reveal, protectText, revealText } = require('../helpers/pii.helper');
const { uploadFile } = require('../helpers/upload.helper');
const { sendSupportTicketEmail, renderEmail, blocks } = require('../services/email.service');
const { notifyUser } = require('../services/notify.service');

const STATUS = { OPEN: 0, IN_PROGRESS: 1, RESOLVED: 2, CLOSED: 3 };
const STATUS_LABEL = { 0: 'Open', 1: 'In Progress', 2: 'Resolved', 3: 'Closed' };
const PRIORITY_LABEL = { 1: 'Low', 2: 'Medium', 3: 'High' };
const PAGE_SIZE = 15;
const MAX_ATTACHMENTS = 5;
const ADMIN_DISPLAY_NAME = process.env.SUPPORT_ADMIN_NAME || 'VoltPay Support';
// A resolved ticket nobody has touched for this long closes itself.
const AUTO_CLOSE_DAYS = Number(process.env.SUPPORT_AUTO_CLOSE_DAYS || 7);

function sanitize(str) {
  return String(str || '').trim();
}

/** Naive HTML escape - every one of these values is user-supplied. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One canonical shape for a Nigerian number so the blind index of "08012345678"
 * and "+234 801 234 5678" is the same value - otherwise admin search finds a
 * ticket only if the admin happens to type it the way the user did.
 */
function normalizeNgPhone(input) {
  const digits = sanitize(input).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('234')) return digits;
  if (digits.startsWith('0')) return `234${digits.slice(1)}`;
  if (digits.length === 10) return `234${digits}`;
  return digits;
}

function parsePriority(value) {
  const raw = sanitize(value).toLowerCase();
  if (raw === '3' || raw === 'high') return 3;
  if (raw === '2' || raw === 'medium') return 2;
  return 1;
}

function parseStatus(value) {
  const raw = sanitize(value).toLowerCase();
  if (raw === '3' || raw === 'closed') return STATUS.CLOSED;
  if (raw === '2' || raw === 'resolved') return STATUS.RESOLVED;
  if (raw === '1' || raw === 'in progress' || raw === 'in_progress') return STATUS.IN_PROGRESS;
  if (raw === '0' || raw === 'open') return STATUS.OPEN;
  return null;
}

function fail(res, message, remark = 'validation_error', code = 200) {
  return res.status(code).json({ remark, status: 'error', message: [message], data: null });
}

/**
 * VP-SUP-YYYYMMDD-NNN, where NNN restarts each day. The count is a hint, not a
 * lock: two simultaneous submissions can compute the same number, so the caller
 * retries on the unique-constraint violation rather than serializing every
 * insert behind a transaction.
 */
async function nextTicketCode(attempt = 0) {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const stamp = `${start.getFullYear()}${String(start.getMonth() + 1).padStart(2, '0')}${String(start.getDate()).padStart(2, '0')}`;
  const todayCount = await prisma.supportTicket.count({ where: { created_at: { gte: start } } });
  const sequence = todayCount + 1 + attempt;
  return `VP-SUP-${stamp}-${String(sequence).padStart(3, '0')}`;
}

/** Files are optional and best effort per file: one rejected upload must not lose the message. */
async function storeAttachments(files) {
  const list = Array.isArray(files) ? files.slice(0, MAX_ATTACHMENTS) : [];
  const stored = [];
  for (const file of list) {
    try {
      const result = await uploadFile(file, { prefix: 'support' });
      stored.push({ url: result.url, name: file.originalname || result.name, size: result.size });
    } catch (error) {
      console.error('support: attachment upload failed', { error: error?.message || error });
    }
  }
  return stored;
}

function serializeTicket(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    name: reveal(row.name_enc),
    email: reveal(row.email_enc),
    phone: reveal(row.phone_enc),
    ticket: row.ticket,
    subject: revealText(row.subject),
    status: String(row.status),
    status_label: STATUS_LABEL[row.status] || 'Open',
    priority: String(row.priority),
    priority_label: PRIORITY_LABEL[row.priority] || 'Low',
    last_reply: row.last_reply,
    rating: row.rating,
    rating_comment: row.rating_comment ? revealText(row.rating_comment) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * The app reads `admin_id == "1"` to colour a reply as staff and falls back to
 * `ticket.name` for the user's own messages, so both sides are filled here.
 * Attachment ids are synthetic: the app uses them only to mark which thumbnail
 * is currently downloading, and they have to be unique within the thread.
 */
function serializeMessage(row, ticket) {
  const files = Array.isArray(row.attachments) ? row.attachments : [];
  return {
    id: row.id,
    support_ticket_id: String(row.ticket_id),
    admin_id: row.is_admin ? '1' : null,
    is_admin: row.is_admin,
    is_internal: row.is_internal,
    message: revealText(row.message),
    created_at: row.created_at,
    updated_at: row.created_at,
    admin: row.is_admin ? { id: 1, name: row.admin_name || ADMIN_DISPLAY_NAME } : null,
    ticket: row.is_admin ? null : { id: ticket.id, name: reveal(ticket.name_enc), ticket: ticket.ticket },
    attachments: files.map((file, index) => ({
      id: row.id * 100 + index,
      support_message_id: String(row.id),
      attachment: file.url,
      name: file.name || '',
      created_at: row.created_at,
      updated_at: row.created_at,
    })),
  };
}

/**
 * The app opens a ticket by its VP-SUP code but replies to it by row id, so
 * both are accepted. `userId` scopes the lookup - a ticket is only ever visible
 * to the account that raised it.
 */
async function findTicket(idOrCode, userId = null) {
  const raw = sanitize(idOrCode);
  if (!raw) return null;
  const numeric = /^\d+$/.test(raw) ? Number(raw) : null;
  const where = numeric ? { id: numeric } : { ticket: raw };
  const ticket = await prisma.supportTicket.findFirst({ where });
  if (!ticket) return null;
  if (userId && ticket.user_id && ticket.user_id !== userId) return null;
  return ticket;
}

async function emailAdminNewTicket(ticket, message, files) {
  const to = process.env.SUPPORT_EMAIL_TO;
  if (!to) return false;
  const name = reveal(ticket.name_enc);
  const email = reveal(ticket.email_enc);
  const phone = reveal(ticket.phone_enc);
  const subject = revealText(ticket.subject);

  // This one goes to the support inbox, not to a customer, so the reporter's
  // contact details are the point of it - they are revealed here and nowhere
  // else. It still renders through the shared shell: an agent triaging fifty
  // of these reads a scannable layout faster than a wall of <p>.
  const attachmentLinks = files
    .map(
      f =>
        `<a href="${esc(f.url)}" style="color:#2B5BEE;text-decoration:underline;">${esc(f.name || 'attachment')}</a>`
    )
    .join('<br/>');

  const html = renderEmail({
    subject: `New ticket ${ticket.ticket}`,
    preheader: `${PRIORITY_LABEL[ticket.priority]} priority - ${subject}`,
    eyebrow: 'New support ticket',
    tag: ticket.ticket,
    heading: esc(subject),
    blocks: [
      blocks.detailList([
        ['Priority', esc(PRIORITY_LABEL[ticket.priority])],
        ['Name', esc(name) || 'N/A'],
        ['Email', esc(email) || 'N/A'],
        ['Phone', esc(phone) || 'N/A'],
        attachmentLinks ? ['Attachments', attachmentLinks] : null,
      ]),
      blocks.quote(esc(message).replace(/\n/g, '<br/>')),
    ],
    footnote: `Reply from the admin dashboard so the response is recorded on ticket ${esc(ticket.ticket)}.`,
  });

  const text = `New Support Ticket ${ticket.ticket}\nSubject: ${subject}\nPriority: ${PRIORITY_LABEL[ticket.priority]}\n\n${message}`;
  const result = await sendSupportTicketEmail({
    to,
    // No literal fallback: email.service already chains BREVO_FROM ->
    // EMAIL_FROM, and passing an unverified address instead makes Brevo reject
    // the send.
    fromArg: process.env.RESEND_FROM,
    replyTo: email || undefined,
    subject: `[Support] ${ticket.ticket} - ${subject}`,
    html,
    text,
  });
  return !!(result && result.queued);
}

/**
 * Anything the user should hear about: a staff reply, or the ticket being
 * resolved or closed. Push and email are both best effort - neither may throw
 * into the write that triggered it.
 */
async function notifyTicketUser(ticket, { subject, body, type }) {
  if (ticket.user_id) {
    try {
      await notifyUser({
        userId: ticket.user_id,
        subject,
        message: body,
        type,
        // Persisted, so ids only - the ticket code is the id here.
        data: { ticket: ticket.ticket, ticket_id: ticket.id },
        pushData: { type, ticket: ticket.ticket, ticket_id: String(ticket.id) },
      });
    } catch (error) {
      console.error('support: notify failed', { ticket_id: ticket.id, error: error?.message || error });
    }
  }

  const email = reveal(ticket.email_enc);
  if (!email) {
    console.warn('support: no email on ticket, in-app only', { ticket_id: ticket.id });
    return;
  }
  try {
    const result = await sendSupportTicketEmail({
      to: email,
      fromArg: process.env.RESEND_FROM,
      subject: `[${ticket.ticket}] ${subject}`,
      html: userEmailHtml({ ticket, subject, body }),
      text: `${subject}\n\n${body}\n\nTicket ${ticket.ticket}\nOpen the VoltPay app to reply.`,
    });
    // sendViaBrevo resolves { queued: false } rather than throwing, so without
    // this a rejected sender or a bad API key looks exactly like a success.
    if (!result?.queued) {
      console.error('support: user email not queued', { ticket_id: ticket.id, error: result?.error });
    }
  } catch (error) {
    console.error('support: user email failed', { ticket_id: ticket.id, error: error?.message || error });
  }
}

/**
 * The reply / resolved / closed email a user gets.
 *
 * The agent's message goes in a quote block rather than as body copy, so it
 * reads as "someone wrote this to you" and not as an automated notice - and
 * the ticket code sits in the card header where a reader scanning a thread of
 * them can find it. `subject` and `body` are both free text written by a
 * person, so both are escaped.
 */
function userEmailHtml({ ticket, subject, body }) {
  return renderEmail({
    subject: `[${ticket.ticket}] ${subject}`,
    preheader: String(body || '').replace(/\s+/g, ' ').slice(0, 140),
    eyebrow: 'Support',
    tag: ticket.ticket,
    heading: esc(subject),
    blocks: [
      blocks.quote(esc(body).replace(/\n/g, '<br/>')),
      blocks.paragraph(
        `Reply from the <b>Support</b> section of the VoltPay app to keep everything on ticket ${esc(ticket.ticket)}. Replying to this email will not reach us.`,
        { small: true }
      ),
    ],
    footnote: 'You are receiving this because you opened a support ticket with VoltPay.',
  });
}

/** Append a message and move the ticket's activity clock. */
async function appendMessage(ticket, { message, files = [], isAdmin = false, isInternal = false, adminName = null, status = null }) {
  const created = await prisma.supportTicketMessage.create({
    data: {
      ticket_id: ticket.id,
      is_admin: isAdmin,
      is_internal: isInternal,
      admin_name: isAdmin ? adminName || ADMIN_DISPLAY_NAME : null,
      message: protectText(message),
      attachments: files.length ? files : undefined,
    },
  });

  // An internal note is invisible to the user, so it must not look like a reply.
  const data = isInternal ? {} : { last_reply: new Date() };
  if (status !== null) {
    data.status = status;
    if (status === STATUS.RESOLVED) data.resolved_at = new Date();
    if (status === STATUS.CLOSED) data.closed_at = new Date();
  }
  const updated = Object.keys(data).length
    ? await prisma.supportTicket.update({ where: { id: ticket.id }, data })
    : ticket;

  return { message: created, ticket: updated };
}

// ---------------------------------------------------------------- app routes

async function createTicket(req, res) {
  try {
    const userId = req.user?.id ? Number(req.user.id) : null;
    // The form's contact fields are optional, but every reply and status change
    // emails the address on the ticket - a blank one means the user only ever
    // hears about it in-app. Fall back to the account's own details.
    const account = req.user || {};
    const accountName = [reveal(account.firstname_enc) || account.firstname || '', reveal(account.lastname_enc) || account.lastname || '']
      .join(' ')
      .trim();
    const name = sanitize(req.body.name) || sanitize(accountName);
    const email = (sanitize(req.body.email) || sanitize(reveal(account.email_enc) || account.email || '')).toLowerCase();
    const phone = normalizeNgPhone(req.body.phone) || normalizeNgPhone(reveal(account.mobile_enc) || account.mobile || '');
    const subject = sanitize(req.body.subject);
    const message = sanitize(req.body.message);
    const priority = parsePriority(req.body.priority);

    if (!subject || !message) return fail(res, 'Subject and message are required');
    if (subject.length > 200) return fail(res, 'Subject is too long');
    if (message.length > 5000) return fail(res, 'Message is too long');
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 'Enter a valid email address');
    if (phone && !/^234\d{10}$/.test(phone)) return fail(res, 'Enter a valid Nigerian phone number');

    const files = await storeAttachments(req.files);
    const protectedName = protect(name, 'name');
    const protectedEmail = protect(email, 'email');
    const protectedPhone = protect(phone, 'mobile');

    let ticket = null;
    for (let attempt = 0; attempt < 5 && !ticket; attempt += 1) {
      const code = await nextTicketCode(attempt);
      try {
        ticket = await prisma.supportTicket.create({
          data: {
            ticket: code,
            user_id: userId,
            name_enc: protectedName.enc,
            name_idx: protectedName.idx,
            email_enc: protectedEmail.enc,
            email_idx: protectedEmail.idx,
            phone_enc: protectedPhone.enc,
            phone_idx: protectedPhone.idx,
            subject: protectText(subject),
            priority,
            status: STATUS.OPEN,
          },
        });
      } catch (error) {
        // P2002 = another submission took this number in the same millisecond.
        if (error?.code !== 'P2002') throw error;
      }
    }
    if (!ticket) return fail(res, 'Could not create your ticket. Please try again.', 'error', 500);

    await appendMessage(ticket, { message, files });

    let emailed = false;
    try {
      emailed = await emailAdminNewTicket(ticket, message, files);
    } catch (error) {
      console.error('support: admin email failed', { ticket_id: ticket.id, error: error?.message || error });
    }

    return res.json({
      remark: 'ticket_created',
      status: 'success',
      message: [`Ticket ${ticket.ticket} created. We will get back to you shortly.`],
      data: { ticket: ticket.ticket, id: ticket.id, emailed },
    });
  } catch (error) {
    console.error('support.createTicket failed:', error?.message || error);
    return fail(res, 'Failed to submit your complaint. Please try again later.', 'error', 500);
  }
}

async function listTickets(req, res) {
  try {
    const userId = Number(req.user.id);
    const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);

    const rows = await prisma.supportTicket.findMany({
      where: { user_id: userId },
      orderBy: { last_reply: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE + 1,
    });

    const hasNext = rows.length > PAGE_SIZE;
    const list = (hasNext ? rows.slice(0, PAGE_SIZE) : rows).map(serializeTicket);
    const path = `${req.baseUrl}${req.path}`;

    return res.json({
      remark: 'ticket_list',
      status: 'success',
      message: ['Support tickets'],
      data: {
        tickets: {
          current_page: page,
          data: list,
          next_page_url: hasNext ? `${path}?page=${page + 1}` : null,
          path,
        },
      },
    });
  } catch (error) {
    console.error('support.listTickets failed:', error?.message || error);
    return fail(res, 'Failed to load your tickets', 'error', 500);
  }
}

async function viewTicket(req, res) {
  try {
    const userId = Number(req.user.id);
    const ticket = await findTicket(req.params.id, userId);
    if (!ticket) return fail(res, 'Ticket not found', 'not_found', 404);

    const messages = await prisma.supportTicketMessage.findMany({
      where: { ticket_id: ticket.id, is_internal: false },
      orderBy: { created_at: 'asc' },
    });

    return res.json({
      remark: 'ticket_details',
      status: 'success',
      message: ['Ticket details'],
      data: {
        my_ticket: serializeTicket(ticket),
        messages: messages.map(row => serializeMessage(row, ticket)),
        // Attachment URLs are absolute (UploadThing), so there is no prefix to
        // prepend. Kept for the app's existing response shape.
        ticket_image_path: '',
      },
    });
  } catch (error) {
    console.error('support.viewTicket failed:', error?.message || error);
    return fail(res, 'Failed to load the ticket', 'error', 500);
  }
}

async function replyTicket(req, res) {
  try {
    const userId = Number(req.user.id);
    const ticket = await findTicket(req.params.id, userId);
    if (!ticket) return fail(res, 'Ticket not found', 'not_found', 404);

    const message = sanitize(req.body.message);
    if (!message) return fail(res, 'Message is required');
    if (message.length > 5000) return fail(res, 'Message is too long');

    const files = await storeAttachments(req.files);
    // Replying to a settled ticket is how a user reopens it - the alternative
    // is a message nobody is looking at.
    const status = ticket.status === STATUS.OPEN ? null : STATUS.OPEN;
    await appendMessage(ticket, { message, files, status });

    return res.json({
      remark: 'ticket_replied',
      status: 'success',
      message: ['Your reply has been sent'],
      data: { ticket: ticket.ticket },
    });
  } catch (error) {
    console.error('support.replyTicket failed:', error?.message || error);
    return fail(res, 'Failed to send your reply', 'error', 500);
  }
}

async function closeTicket(req, res) {
  try {
    const userId = Number(req.user.id);
    const ticket = await findTicket(req.params.id, userId);
    if (!ticket) return fail(res, 'Ticket not found', 'not_found', 404);
    if (ticket.status === STATUS.CLOSED) return fail(res, 'This ticket is already closed');

    await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { status: STATUS.CLOSED, closed_at: new Date() },
    });

    return res.json({
      remark: 'ticket_closed',
      status: 'success',
      message: ['Ticket closed'],
      data: { ticket: ticket.ticket },
    });
  } catch (error) {
    console.error('support.closeTicket failed:', error?.message || error);
    return fail(res, 'Failed to close the ticket', 'error', 500);
  }
}

async function reopenTicket(req, res) {
  try {
    const userId = Number(req.user.id);
    const ticket = await findTicket(req.params.id, userId);
    if (!ticket) return fail(res, 'Ticket not found', 'not_found', 404);
    if (ticket.status !== STATUS.CLOSED && ticket.status !== STATUS.RESOLVED) {
      return fail(res, 'This ticket is still open');
    }

    const message = sanitize(req.body.message);
    const updated = await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { status: STATUS.OPEN, closed_at: null, resolved_at: null, last_reply: new Date() },
    });
    if (message) await appendMessage(updated, { message });

    return res.json({
      remark: 'ticket_reopened',
      status: 'success',
      message: [`Ticket ${ticket.ticket} reopened`],
      data: { ticket: ticket.ticket },
    });
  } catch (error) {
    console.error('support.reopenTicket failed:', error?.message || error);
    return fail(res, 'Failed to reopen the ticket', 'error', 500);
  }
}

async function rateTicket(req, res) {
  try {
    const userId = Number(req.user.id);
    const ticket = await findTicket(req.params.id, userId);
    if (!ticket) return fail(res, 'Ticket not found', 'not_found', 404);
    if (ticket.status !== STATUS.RESOLVED && ticket.status !== STATUS.CLOSED) {
      return fail(res, 'You can rate a ticket once it has been resolved');
    }
    if (ticket.rating) return fail(res, 'You have already rated this ticket');

    const rating = parseInt(req.body.rating, 10);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return fail(res, 'Rating must be between 1 and 5');
    const comment = sanitize(req.body.comment).slice(0, 500);

    await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { rating, rating_comment: comment ? protectText(comment) : null },
    });

    return res.json({
      remark: 'ticket_rated',
      status: 'success',
      message: ['Thanks for your feedback'],
      data: { ticket: ticket.ticket, rating },
    });
  } catch (error) {
    console.error('support.rateTicket failed:', error?.message || error);
    return fail(res, 'Failed to save your rating', 'error', 500);
  }
}

// --------------------------------------------------------------- background

/**
 * A resolved ticket nobody has come back to closes itself, so the queue does
 * not fill with threads waiting on a user who is happy. Only RESOLVED is
 * touched: an open ticket is still ours to answer.
 */
async function autoCloseStaleTickets() {
  const cutoff = new Date(Date.now() - AUTO_CLOSE_DAYS * 24 * 60 * 60 * 1000);
  const stale = await prisma.supportTicket.findMany({
    where: { status: STATUS.RESOLVED, last_reply: { lt: cutoff } },
    take: 200,
  });
  if (!stale.length) return 0;

  await prisma.supportTicket.updateMany({
    where: { id: { in: stale.map(t => t.id) } },
    data: { status: STATUS.CLOSED, closed_at: new Date() },
  });

  for (const ticket of stale) {
    await notifyTicketUser(ticket, {
      subject: 'Support ticket closed',
      body: `Ticket ${ticket.ticket} was closed after ${AUTO_CLOSE_DAYS} days without a reply. Reopen it any time from the app if you still need help.`,
      type: 'support_closed',
    });
  }
  return stale.length;
}

module.exports = {
  createTicket,
  listTickets,
  viewTicket,
  replyTicket,
  closeTicket,
  reopenTicket,
  rateTicket,
  autoCloseStaleTickets,
  // Shared with adminSupport.controller
  STATUS,
  STATUS_LABEL,
  PRIORITY_LABEL,
  parseStatus,
  parsePriority,
  normalizeNgPhone,
  serializeTicket,
  serializeMessage,
  appendMessage,
  storeAttachments,
  notifyTicketUser,
  findTicket,
  sanitize,
};
