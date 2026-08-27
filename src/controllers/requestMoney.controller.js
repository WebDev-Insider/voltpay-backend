const prisma = require('../../database/prisma');
const { Prisma } = require('@prisma/client');
const { getCountryByCode } = require('../helpers/country.helper');
const { generateTrx } = require('../services/airtime.service');
const { applyBalanceDelta } = require('../helpers/balance.helper');
const { notifyUser } = require('../services/notify.service');
const {
  blindIndex,
  revealUserFields,
  protectText,
  revealText,
  verifySecret,
} = require('../helpers/pii.helper');
const { invalidateUser } = require('../services/userCache.service');
const { checkVelocity } = require('../helpers/velocity.helper');
const { logMoneyEvent } = require('../services/userAudit.service');

/// A request nobody answers must not stay payable forever - a stale "pay me"
/// that fires three weeks later is indistinguishable from a scam.
const REQUEST_TTL_HOURS = Number(process.env.REQUEST_MONEY_TTL_HOURS || 24);
/// How long a pending request sits before the one reminder push goes out.
const REMINDER_AFTER_HOURS = Number(process.env.REQUEST_MONEY_REMINDER_HOURS || 6);

const PAGE_SIZE = 15;

// The Flutter models read `status` as a numeric string, so the word the column
// stores is mapped on the way out. Kept in one place so a new state cannot be
// added on one side only.
const STATUS_CODE = {
  pending: '0',
  paid: '1',
  declined: '2',
  expired: '3',
  cancelled: '4',
};

function moneyStr(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0.00';
  return num.toFixed(2);
}

function chargeConfig() {
  return {
    id: 1,
    name: 'Request Money',
    slug: 'request_money',
    fixed_charge: '10',
    percent_charge: '0',
    min_limit: '50',
    max_limit: '1000000',
    cap: '-1',
  };
}

function computeCharge(amount) {
  const cfg = chargeConfig();
  const fixed = Number(cfg.fixed_charge || 0) || 0;
  const percent = Number(cfg.percent_charge || 0) || 0;
  const raw = (amount * percent) / 100 + fixed;
  const cap = Number(cfg.cap || -1);
  return cap !== -1 && raw > cap ? cap : raw;
}

/// Accepts a username or a phone number in any of the shapes a Nigerian user
/// might type it (+2348012345678, 2348012345678, 08012345678, 8012345678).
function parseUserInputToLookup(userInputRaw) {
  const raw = String(userInputRaw || '').trim();
  if (!raw) return { username: '', mobiles: [] };
  const digits = raw.replace(/\D/g, '');
  const looksNumeric = digits.length >= 7 && /^[+\d\s()-]+$/.test(raw);
  if (!looksNumeric) return { username: raw, mobiles: [] };

  const last10 = digits.length > 10 ? digits.slice(-10) : digits;
  const mobiles = Array.from(
    new Set([digits, last10, last10.length === 10 ? `0${last10}` : ''].filter(Boolean))
  );
  return { username: '', mobiles };
}

async function findUserByInput(userInput) {
  const lookup = parseUserInputToLookup(userInput);
  const or = [
    ...(lookup.username ? [{ username_idx: blindIndex(lookup.username, 'username') }] : []),
    ...lookup.mobiles.map(m => ({ mobile_idx: blindIndex(m, 'mobile') })),
  ];
  if (!or.length) return null;
  return prisma.user.findFirst({ where: { OR: or } });
}

function publicCounterparty(user) {
  if (!user) return null;
  const pii = revealUserFields(user);
  const country = getCountryByCode(user.country_code);
  return {
    id: user.id,
    firstname: pii.firstname,
    lastname: pii.lastname,
    username: pii.username,
    email: pii.email,
    mobile: pii.mobile,
    dial_code: country?.dial_code,
    country_code: user.country_code,
    country_name: country?.name,
    country_flag: country?.image_src,
    image: user.image,
    image_src: user.image,
  };
}

function fullName(user) {
  const pii = revealUserFields(user);
  const name = `${String(pii.firstname || '').trim()} ${String(pii.lastname || '').trim()}`.trim();
  return name || String(pii.username || '').trim();
}

function serializeRequest(row, { sender = null, receiver = null } = {}) {
  return {
    id: row.id,
    sender_id: String(row.sender_id),
    receiver_id: String(row.receiver_id),
    amount: moneyStr(row.amount),
    charge: moneyStr(row.charge),
    note: revealText(row.note || ''),
    decline_reason: revealText(row.decline_reason || ''),
    status: STATUS_CODE[row.status] || '0',
    status_label: row.status,
    expires_at: row.expires_at instanceof Date ? row.expires_at.toISOString() : null,
    paid_at: row.paid_at instanceof Date ? row.paid_at.toISOString() : null,
    trx: row.trx || '',
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    // `request_sender` is whoever asked for the money, `request_receiver` is
    // whoever was asked to pay. Named from the request's point of view, not the
    // money's - the cash flows the other way.
    request_sender: publicCounterparty(sender),
    request_receiver: publicCounterparty(receiver),
  };
}

/// Requests are expired lazily rather than by a job, so a request is never
/// payable past its deadline even if no scheduler ever runs.
async function expireStale() {
  try {
    await prisma.moneyRequest.updateMany({
      where: { status: 'pending', expires_at: { lt: new Date() } },
      data: { status: 'expired' },
    });
  } catch (_) {}
}

async function info(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    await expireStale();

    const fresh = await prisma.user.findUnique({ where: { id: Number(user.id) } });
    const balance = Number(fresh?.balance?.toString?.() ?? fresh?.balance ?? 0);

    const pendingCount = await prisma.moneyRequest.count({
      where: { receiver_id: Number(user.id), status: 'pending' },
    });

    const latestRows = await prisma.moneyRequest.findMany({
      where: { sender_id: Number(user.id) },
      orderBy: { id: 'desc' },
      take: 5,
      include: { sender: true, receiver: true },
    });

    const data = {
      supported_otp_types: [],
      current_balance: moneyStr(balance),
      charge: chargeConfig(),
      pending_request_counter: String(pendingCount),
      request_expiry_hours: REQUEST_TTL_HOURS,
      latest_request_money: latestRows.map(r =>
        serializeRequest(r, { sender: r.sender, receiver: r.receiver })
      ),
    };

    return res.json({ remark: 'request_money', status: 'success', message: ['OK'], data });
  } catch (e) {
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

/// Create the request. No PIN here on purpose: asking for money moves nothing,
/// and the PIN belongs on the side that actually pays.
async function store(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const amount = Number(req.body?.amount);
    const userInput = String(req.body?.user || '').trim();
    const note = String(req.body?.note || '').trim().slice(0, 200);

    const cfg = chargeConfig();
    const min = Number(cfg.min_limit);
    const max = Number(cfg.max_limit);

    if (!userInput) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Enter a username or phone number'], data: null });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Enter a valid amount'], data: null });
    }
    if (amount < min || amount > max) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: [`Amount must be between ${moneyStr(min)} and ${moneyStr(max)}`],
        data: null,
      });
    }

    const receiver = await findUserByInput(userInput);
    if (!receiver) {
      return res.status(404).json({ remark: 'not_found', status: 'error', message: ['User not found'], data: null });
    }
    if (Number(receiver.id) === Number(user.id)) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['You cannot request money from yourself'], data: null });
    }
    if (Number(receiver.status) !== 1) {
      return res.status(403).json({ remark: 'blocked', status: 'error', message: ['That account cannot receive requests'], data: null });
    }

    const charge = computeCharge(amount);
    const expiresAt = new Date(Date.now() + REQUEST_TTL_HOURS * 60 * 60_000);

    const created = await prisma.moneyRequest.create({
      data: {
        sender_id: Number(user.id),
        receiver_id: Number(receiver.id),
        amount: new Prisma.Decimal(amount.toFixed(2)),
        charge: new Prisma.Decimal(charge.toFixed(2)),
        // The note names a person or an invoice as often as not, so it gets the
        // same treatment as walletTransaction.details.
        note: note ? protectText(note) : null,
        status: 'pending',
        expires_at: expiresAt,
      },
    });

    const sender = await prisma.user.findUnique({ where: { id: Number(user.id) } });
    const senderName = fullName(sender);

    await notifyUser({
      userId: Number(receiver.id),
      subject: 'Money request',
      message: `${senderName} is requesting ${moneyStr(amount)}${note ? ` - ${note}` : ''}`,
      type: 'money_request',
      // Persisted, so ids and amounts only.
      data: { request_id: created.id, sender_id: Number(user.id), amount: moneyStr(amount) },
      // Transient - this one lands on the device and drives the deep link.
      pushData: {
        type: 'money_request',
        request_id: String(created.id),
        amount: moneyStr(amount),
        route: '/request_money_history_screen',
      },
    });

    return res.json({
      remark: 'request_money_success',
      status: 'success',
      message: ['Money request sent'],
      data: { money_request: serializeRequest(created, { sender, receiver }) },
    });
  } catch (e) {
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function historyPage(req, res, { mine }) {
  const user = req.user;
  if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

  await expireStale();

  const page = Math.max(1, Number(req.query?.page || 1) || 1);
  const skip = (page - 1) * PAGE_SIZE;
  const where = mine ? { sender_id: Number(user.id) } : { receiver_id: Number(user.id) };

  let rows = await prisma.moneyRequest.findMany({
    where,
    orderBy: { id: 'desc' },
    skip,
    take: PAGE_SIZE + 1,
    include: { sender: true, receiver: true },
  });

  const hasNext = rows.length > PAGE_SIZE;
  if (hasNext) rows = rows.slice(0, PAGE_SIZE);

  const list = rows.map(r => serializeRequest(r, { sender: r.sender, receiver: r.receiver }));
  const path = `${req.baseUrl}${req.path}`;
  const payload = {
    current_page: page,
    data: list,
    last_page_url: null,
    next_page_url: hasNext ? `${path}?page=${page + 1}` : null,
    path,
  };

  return res.json({
    remark: 'request_money_history',
    status: 'success',
    message: ['OK'],
    data: mine ? { request_moneys: payload } : { requested_moneys: payload },
  });
}

async function sentHistory(req, res) {
  try {
    return await historyPage(req, res, { mine: true });
  } catch (e) {
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function receivedHistory(req, res) {
  try {
    return await historyPage(req, res, { mine: false });
  } catch (e) {
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

/// Pay a request. This is the money path: PIN checked against the fresh row,
/// balance guarded and both ledger legs written inside one transaction.
async function approve(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const requestId = Number(req.params?.id);
    const pinInput = String(req.body?.pin || '').trim();

    if (!requestId) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid request'], data: null });
    }
    if (!pinInput) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['PIN is required'], data: null });
    }

    const freshUser = await prisma.user.findUnique({ where: { id: Number(user.id) } });
    if (!freshUser) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login again'], data: null });

    const valid = (await verifySecret(pinInput, freshUser.pin, 'pin')).ok;
    if (!valid) {
      return res.status(401).json({ remark: 'invalid_pin', status: 'error', message: ['Invalid PIN'], data: null });
    }

    await expireStale();

    const request = await prisma.moneyRequest.findUnique({
      where: { id: requestId },
      include: { sender: true, receiver: true },
    });

    if (!request || Number(request.receiver_id) !== Number(user.id)) {
      return res.status(404).json({ remark: 'not_found', status: 'error', message: ['Request not found'], data: null });
    }
    if (request.status === 'paid') {
      // Idempotent: a retried tap must not debit twice.
      return res.json({
        remark: 'request_money_paid',
        status: 'success',
        message: ['Request already paid'],
        data: { money_request: serializeRequest(request, { sender: request.sender, receiver: request.receiver }) },
      });
    }
    if (request.status !== 'pending') {
      return res.status(400).json({
        remark: 'invalid_status',
        status: 'error',
        message: [`This request is ${request.status}`],
        data: null,
      });
    }

    const amount = Number(request.amount?.toString?.() ?? request.amount);
    const charge = Number(request.charge?.toString?.() ?? request.charge ?? 0);
    const total = amount + charge;
    const payerId = Number(request.receiver_id);
    const payeeId = Number(request.sender_id);

    // Approving a request is a transfer with a nicer wrapper, so it counts
    // against the same wallet velocity as one.
    const velocity = await checkVelocity({ userId: payerId, amount: total });
    if (!velocity.ok) {
      return res.status(429).json({
        remark: 'velocity_limit',
        status: 'error',
        message: [velocity.message],
        data: { reason: velocity.reason, retry_after_minutes: velocity.retryAfterMinutes },
      });
    }

    const transferRef = generateTrx('rm');
    const payerTrx = `${transferRef}_s`;
    const payeeTrx = `${transferRef}_r`;

    const debitTotal = new Prisma.Decimal(total.toFixed(2));
    const creditAmount = new Prisma.Decimal(amount.toFixed(2));
    const chargeDec = new Prisma.Decimal(charge.toFixed(2));
    const zero = new Prisma.Decimal('0.00');

    let payerAfter = null;

    try {
      await prisma.$transaction(async tx => {
        const users = await tx.user.findMany({
          where: { id: { in: [payerId, payeeId] } },
        });

        const payer = users.find(u => Number(u.id) === payerId) || null;
        const payee = users.find(u => Number(u.id) === payeeId) || null;
        if (!payer) throw new Error('Please login again');
        if (!payee) {
          const err = new Error('Requester not found');
          err.code = 'PAYEE_NOT_FOUND';
          throw err;
        }
        if (Number(payee.status) !== 1) {
          const err = new Error('Requester account is blocked');
          err.code = 'PAYEE_BLOCKED';
          throw err;
        }

        const payerBal = Number(payer.balance?.toString?.() ?? payer.balance);
        if (!Number.isFinite(payerBal) || payerBal < total) {
          const err = new Error('Insufficient balance');
          err.code = 'INSUFFICIENT';
          throw err;
        }

        // Claim the request inside the transaction. If a second tap got here
        // first this updates 0 rows and the whole thing rolls back, so the
        // debit can never happen twice.
        const claimed = await tx.moneyRequest.updateMany({
          where: { id: requestId, status: 'pending' },
          data: { status: 'paid', paid_at: new Date(), trx: transferRef },
        });
        if (claimed.count !== 1) {
          const err = new Error('This request is no longer pending');
          err.code = 'RACED';
          throw err;
        }

        const updatedPayer = await applyBalanceDelta(tx, 'user', payerId, debitTotal.negated());
        await applyBalanceDelta(tx, 'user', payeeId, creditAmount);
        payerAfter = Number(updatedPayer.balance?.toString?.() ?? updatedPayer.balance);

        const payerName = fullName(payer);
        const payeeName = fullName(payee);

        await tx.walletTransaction.createMany({
          data: [
            {
              user_id: payerId,
              trx: payerTrx,
              trx_type: '-',
              amount: creditAmount,
              charge: chargeDec,
              total_amount: debitTotal,
              remark: 'request_money',
              details: protectText(`Paid money request from ${payeeName}`.trim()),
              other_data: {
                title: 'Request Money',
                subtitle: protectText(payeeName),
                feedback: 'Successful',
                note: 'Wallet',
                image_src: payee.image || '',
              },
              meta: { transfer_ref: transferRef, request_id: requestId, receiver_id: payeeId, receiver_trx: payeeTrx },
            },
            {
              user_id: payeeId,
              trx: payeeTrx,
              trx_type: '+',
              amount: creditAmount,
              charge: zero,
              total_amount: creditAmount,
              remark: 'receive_money',
              details: protectText(`Money request paid by ${payerName}`.trim()),
              other_data: {
                title: 'Request Money',
                subtitle: protectText(payerName),
                feedback: 'Successful',
                note: 'Wallet',
                image_src: payer.image || '',
              },
              meta: { transfer_ref: transferRef, request_id: requestId, sender_id: payerId, sender_trx: payerTrx },
            },
          ],
        });
      });
    } catch (e) {
      const code = e?.code;
      if (code === 'INSUFFICIENT') {
        return res.status(400).json({ remark: 'insufficient_balance', status: 'error', message: ['Insufficient balance'], data: null });
      }
      if (code === 'RACED') {
        return res.status(409).json({ remark: 'invalid_status', status: 'error', message: ['This request is no longer pending'], data: null });
      }
      if (code === 'PAYEE_NOT_FOUND' || code === 'PAYEE_BLOCKED') {
        return res.status(400).json({ remark: 'validation_error', status: 'error', message: [e.message], data: null });
      }
      throw e;
    }

    // Both balances changed, so neither cached row may be served again.
    await Promise.all([invalidateUser(payerId), invalidateUser(payeeId)]);

    await logMoneyEvent({
      req,
      userId: payerId,
      event: 'request_money.paid',
      trx: payerTrx,
      amount: total,
      counterpartyId: payeeId,
      extra: { request_id: requestId, charge: Number(charge) || 0 },
    });

    const settled = await prisma.moneyRequest.findUnique({
      where: { id: requestId },
      include: { sender: true, receiver: true },
    });

    await notifyUser({
      userId: payeeId,
      subject: 'Money request paid',
      message: `${fullName(settled?.receiver)} paid your request of ${moneyStr(amount)}`,
      type: 'money_request',
      data: { request_id: requestId, payer_id: payerId, amount: moneyStr(amount) },
      pushData: {
        type: 'money_request_paid',
        request_id: String(requestId),
        amount: moneyStr(amount),
        route: '/request_money_history_screen',
      },
    });

    return res.json({
      remark: 'request_money_paid',
      status: 'success',
      message: ['Money request paid'],
      data: {
        money_request: settled ? serializeRequest(settled, { sender: settled.sender, receiver: settled.receiver }) : null,
        post_balance: moneyStr(payerAfter ?? 0),
        trx: payerTrx,
      },
    });
  } catch (e) {
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

/// Decline a request. The reason is optional; the requester is told either way.
async function reject(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const requestId = Number(req.params?.id);
    if (!requestId) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid request'], data: null });
    }

    const reason = String(req.body?.reason || '').trim().slice(0, 200);

    const request = await prisma.moneyRequest.findUnique({ where: { id: requestId } });
    if (!request || Number(request.receiver_id) !== Number(user.id)) {
      return res.status(404).json({ remark: 'not_found', status: 'error', message: ['Request not found'], data: null });
    }
    if (request.status !== 'pending') {
      return res.status(400).json({ remark: 'invalid_status', status: 'error', message: [`This request is ${request.status}`], data: null });
    }

    const updated = await prisma.moneyRequest.updateMany({
      where: { id: requestId, status: 'pending' },
      data: { status: 'declined', decline_reason: reason ? protectText(reason) : null },
    });
    if (updated.count !== 1) {
      return res.status(409).json({ remark: 'invalid_status', status: 'error', message: ['This request is no longer pending'], data: null });
    }

    const settled = await prisma.moneyRequest.findUnique({
      where: { id: requestId },
      include: { sender: true, receiver: true },
    });

    await notifyUser({
      userId: Number(request.sender_id),
      subject: 'Money request declined',
      message: `${fullName(settled?.receiver)} declined your request of ${moneyStr(request.amount)}${reason ? ` - ${reason}` : ''}`,
      type: 'money_request',
      data: { request_id: requestId, amount: moneyStr(request.amount) },
      pushData: {
        type: 'money_request_declined',
        request_id: String(requestId),
        route: '/request_money_history_screen',
      },
    });

    return res.json({
      remark: 'request_money_declined',
      status: 'success',
      message: ['Money request declined'],
      data: { money_request: settled ? serializeRequest(settled, { sender: settled.sender, receiver: settled.receiver }) : null },
    });
  } catch (e) {
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

/// Withdraw a request you sent. Mirror image of reject(): the only differences
/// are which side owns the row and who gets told.
async function cancel(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const requestId = Number(req.params?.id);
    if (!requestId) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid request'], data: null });
    }

    const request = await prisma.moneyRequest.findUnique({ where: { id: requestId } });
    if (!request || Number(request.sender_id) !== Number(user.id)) {
      return res.status(404).json({ remark: 'not_found', status: 'error', message: ['Request not found'], data: null });
    }
    if (request.status !== 'pending') {
      return res.status(400).json({ remark: 'invalid_status', status: 'error', message: [`This request is ${request.status}`], data: null });
    }

    // Conditional update, not a plain one: the receiver may be paying it in the
    // same second, and the payer wins.
    const updated = await prisma.moneyRequest.updateMany({
      where: { id: requestId, status: 'pending' },
      data: { status: 'cancelled' },
    });
    if (updated.count !== 1) {
      return res.status(409).json({ remark: 'invalid_status', status: 'error', message: ['This request is no longer pending'], data: null });
    }

    const settled = await prisma.moneyRequest.findUnique({
      where: { id: requestId },
      include: { sender: true, receiver: true },
    });

    await notifyUser({
      userId: Number(request.receiver_id),
      subject: 'Money request cancelled',
      message: `${fullName(settled?.sender)} cancelled the request of ${moneyStr(request.amount)}`,
      type: 'money_request',
      data: { request_id: requestId, amount: moneyStr(request.amount) },
      pushData: {
        type: 'money_request_cancelled',
        request_id: String(requestId),
        route: '/request_money_history_screen',
      },
    });

    return res.json({
      remark: 'request_money_cancelled',
      status: 'success',
      message: ['Money request cancelled'],
      data: { money_request: settled ? serializeRequest(settled, { sender: settled.sender, receiver: settled.receiver }) : null },
    });
  } catch (e) {
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

/// One reminder per request, once it has been pending for REMINDER_AFTER_HOURS
/// and while it is still payable. `reminded_at` is the guard - without it a job
/// that runs hourly would nag hourly.
async function sendPendingReminders() {
  try {
    await expireStale();

    const cutoff = new Date(Date.now() - REMINDER_AFTER_HOURS * 60 * 60_000);
    const due = await prisma.moneyRequest.findMany({
      where: {
        status: 'pending',
        reminded_at: null,
        created_at: { lt: cutoff },
        expires_at: { gt: new Date() },
      },
      take: 200,
      include: { sender: true },
    });

    for (const request of due) {
      // Stamp first. A push that fails is a missed reminder; a push that
      // succeeds without the stamp is a reminder every hour until expiry.
      const claimed = await prisma.moneyRequest.updateMany({
        where: { id: request.id, reminded_at: null },
        data: { reminded_at: new Date() },
      });
      if (claimed.count !== 1) continue;

      await notifyUser({
        userId: Number(request.receiver_id),
        subject: 'Money request reminder',
        message: `${fullName(request.sender)} is still waiting for ${moneyStr(request.amount)}`,
        type: 'money_request',
        data: { request_id: request.id, amount: moneyStr(request.amount) },
        pushData: {
          type: 'money_request_reminder',
          request_id: String(request.id),
          route: '/request_money_history_screen',
        },
      });
    }

    return due.length;
  } catch (e) {
    console.error('sendPendingReminders failed', { error: e?.message || e });
    return 0;
  }
}

module.exports = {
  info,
  store,
  sentHistory,
  receivedHistory,
  approve,
  reject,
  cancel,
  sendPendingReminders,
  // Exported for test/requestMoney.controller.test.js
  parseUserInputToLookup,
  computeCharge,
  STATUS_CODE,
  REQUEST_TTL_HOURS,
};
