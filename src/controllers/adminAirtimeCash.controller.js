// Airtime to Cash - the operations side.
//
//   GET  /admin/airtime-cash/overview                      the cards, and whether Paystack is funded
//   GET  /admin/airtime-cash/conversions                   the queue, filterable
//   GET  /admin/airtime-cash/conversions/:id               one conversion, its trail and its payout
//   POST /admin/airtime-cash/conversions/mark-available    { ids, note?, confirm_unconfirmed? }   finance
//   POST /admin/airtime-cash/conversions/:id/mark-failed   { note }                               finance
//   POST /admin/airtime-cash/conversions/:id/notes         { note }
//   GET  /admin/airtime-cash/withdrawals                   bank payouts and their Paystack refs
//   POST /admin/airtime-cash/withdrawals/:id/requery       ask Paystack now instead of at the next sweep
//
// The settlement model this screen exists for: a conversion credits our
// MySubWallet float, not Paystack. Somebody moves that money to Paystack, then
// marks the conversions available here - and only then can the customer pull
// it out. Nothing unlocks itself.
const prisma = require('../../database/prisma');
const service = require('../services/airtimeCash.service');
const A2C = require('../helpers/airtimeCash.helper');
const msw = require('../funding/mysubwallet.service');
const paystack = require('../funding/paystack.service');
const { reveal, revealText, revealUserFields, blindIndex } = require('../helpers/pii.helper');
const { profileName } = require('../helpers/nameMatch.helper');
const { maskPhone, displayPhone } = require('../helpers/topupSchedule.helper');

const ALL_STATUSES = Object.values(A2C.STATUS);
const WITHDRAWAL_STATUSES = ['pending', 'processing', 'success', 'failed', 'reversed'];

function ok(res, data, message = 'OK', remark = 'airtime_cash') {
  return res.json({ remark, status: 'success', message: [message], data });
}

function fail(res, code, message, remark = 'validation_error', data = null) {
  return res.status(code).json({ remark, status: 'error', message: [message], data });
}

function sendError(res, e, where, fallback) {
  if (e?.remark && e?.statusCode) return fail(res, e.statusCode, e.message, e.remark, e.data || null);
  console.error(`adminAirtimeCash.${where} failed:`, e?.message || e);
  return fail(res, 500, fallback, 'error');
}

function safeReveal(enc) {
  try {
    return reveal(enc) || '';
  } catch {
    return '';
  }
}

const money = value => A2C.moneyStr(A2C.toKobo(value));

/** Display names for a page of rows, in one query. */
async function usersById(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(Number))];
  if (!unique.length) return new Map();
  const rows = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, firstname: true, lastname: true, firstname_enc: true, lastname_enc: true, username: true, username_enc: true },
  });
  return new Map(
    rows.map(u => {
      const r = revealUserFields(u);
      return [u.id, { id: u.id, name: profileName(r) || r.username || `User #${u.id}`, username: r.username || '' }];
    }),
  );
}

function minutesSince(at) {
  if (!at) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(at).getTime()) / 60_000));
}

function adminConversion(row, user) {
  const cfg = A2C.networkConfig(row.network);
  return {
    id: row.id,
    reference: row.reference,
    user_id: row.user_id,
    user_name: user?.name || `User #${row.user_id}`,
    network: row.network,
    network_label: cfg?.label || row.network,
    phone_masked: maskPhone(safeReveal(row.phone_enc)),
    amount: row.amount != null ? money(row.amount) : null,
    payout: row.payout != null ? money(row.payout) : null,
    fee: row.fee != null ? money(row.fee) : null,
    margin: row.margin != null ? money(row.margin) : null,
    provider_credit: row.provider_credit != null ? money(row.provider_credit) : null,
    rate_label: row.payout_rate_bps ? A2C.rateLabel(row.payout_rate_bps) : '',
    provider_rate_label: row.provider_rate_bps ? A2C.rateLabel(row.provider_rate_bps) : '',
    status: row.status,
    status_label: A2C.statusLabel(row),
    provider_status: row.provider_status,
    confirmed: A2C.isConfirmed(row),
    settled_by: row.settled_by,
    withdrawal_id: row.withdrawal_id,
    failure_reason: row.failure_reason,
    // The request-id step 3 went out under, and MySubWallet's last words about
    // it - what support reads against their dashboard.
    provider_reference: row.provider_request_id,
    provider_message: row.provider_message,
    // step3_sent, provider_recorded, user_credited, needs_review, recordable.
    ...service.reviewState(row),
    // How long it has been waiting - the only priority signal a settlement
    // queue has.
    waiting_minutes: row.status === A2C.STATUS.PROCESSING ? minutesSince(row.converted_at || row.created_at) : null,
    created_at: row.created_at,
    submitted_at: row.submitted_at,
    converted_at: row.converted_at,
    available_at: row.available_at,
    withdrawn_at: row.withdrawn_at,
    failed_at: row.failed_at,
  };
}

function adminWithdrawal(w, user) {
  if (!w) return null;
  return {
    id: w.id,
    reference: w.reference,
    user_id: w.user_id,
    user_name: user?.name || `User #${w.user_id}`,
    amount: money(w.amount),
    fee: money(w.fee),
    provider_fee: money(w.provider_fee),
    conversion_count: w.conversion_count,
    bank_code: w.bank_code,
    bank_name: w.bank_name || '',
    account_masked: A2C.maskAccount(w.account_last4),
    account_name: safeReveal(w.account_name_enc),
    account_source: w.account_source,
    status: w.status,
    status_label: A2C.WITHDRAWAL_LABELS[w.status] || w.status,
    transfer_code: w.transfer_code,
    failure_reason: w.failure_reason,
    // Paystack's own words, for the person reconciling. Never sent to the app.
    provider_message: w.provider_message,
    created_at: w.created_at,
    submitted_at: w.submitted_at,
    completed_at: w.completed_at,
  };
}

/** Best effort: a provider that does not answer is shown as unknown, never as zero. */
async function readPaystackBalance() {
  if (!String(process.env.PAYSTACK_SECRET_KEY || '').trim()) return { available: false, reason: 'not_configured' };
  try {
    const bal = await paystack.getBalance();
    return bal ? { available: true, balance: A2C.moneyStr(bal.balance_kobo) } : { available: false, reason: 'no_ngn_balance' };
  } catch {
    return { available: false, reason: 'unreachable' };
  }
}

/**
 * One read, two figures: the bills float (`balance`) and, separately, the
 * Airtime to Cash balance conversions are credited to. Either can be missing
 * without the other.
 */
async function readMswBalance() {
  if (!msw.isConfigured()) return { available: false, reason: 'not_configured' };
  try {
    const bal = await msw.getWalletBalance();
    const a2c = bal?.airtime_to_cash_balance == null ? null : Number(bal.airtime_to_cash_balance).toFixed(2);
    const retrievedAt = bal?.retrieved_at || null;
    if (bal?.balance == null) return { available: false, reason: 'unreadable', airtime_to_cash_balance: a2c, retrieved_at: retrievedAt };
    return {
      available: true,
      balance: Number(bal.balance).toFixed(2),
      verdict: msw.floatVerdict(bal.balance),
      airtime_to_cash_balance: a2c,
      retrieved_at: retrievedAt,
    };
  } catch {
    return { available: false, reason: 'unreachable' };
  }
}

/**
 * Everything that needs a person: step 3 in flight, credited but unconfirmed,
 * or sent and never recorded. Fetched whole and classified here, because "never
 * recorded" depends on MySubWallet's words, which SQL cannot read. The set is
 * small by nature - every row in it is a case somebody has to close.
 */
async function needsReviewRows(extraWhere = {}) {
  const rows = await prisma.airtimeCashConversion.findMany({
    where: {
      // AND, not a spread: a search's own OR (reference or request-id) must
      // narrow this one, not replace it.
      AND: [
        extraWhere,
        {
          OR: [
            { status: A2C.STATUS.SUBMITTING },
            { status: A2C.STATUS.PROCESSING, provider_status: { in: ['pending', 'unknown'] } },
            { status: { in: [A2C.STATUS.OTP_VERIFIED, A2C.STATUS.ABANDONED] }, convert_attempts: { gte: 1 } },
          ],
        },
      ],
    },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    take: 500,
  });
  return rows.filter(r => service.reviewState(r).needs_review);
}

async function overview(req, res) {
  try {
    const [grouped, unconfirmed, oldest, withdrawals, paystackBalance, mswBalance, review] = await Promise.all([
      prisma.airtimeCashConversion.groupBy({
        by: ['status'],
        where: { status: { in: A2C.LISTED_STATUSES } },
        _count: { _all: true },
        _sum: { payout: true, amount: true, margin: true },
      }),
      prisma.airtimeCashConversion.count({
        where: { status: A2C.STATUS.PROCESSING, provider_status: { in: ['pending', 'unknown'] } },
      }),
      prisma.airtimeCashConversion.findFirst({
        where: { status: A2C.STATUS.PROCESSING },
        orderBy: { converted_at: 'asc' },
        select: { converted_at: true },
      }),
      prisma.airtimeCashWithdrawal.groupBy({
        by: ['status'],
        _count: { _all: true },
        _sum: { amount: true, provider_fee: true },
      }),
      readPaystackBalance(),
      readMswBalance(),
      needsReviewRows(),
    ]);

    const g = status => grouped.find(x => x.status === status);
    const kobo = (status, field) => A2C.toKobo(g(status)?._sum?.[field] ?? 0);
    const count = status => g(status)?._count?._all || 0;

    // Pending settlement includes a step 3 still in flight: it is shown to the
    // customer as pending, so it is owed as pending.
    const pendingKobo = kobo(A2C.STATUS.PROCESSING, 'payout') + kobo(A2C.STATUS.SUBMITTING, 'payout');
    const availableKobo = kobo(A2C.STATUS.AVAILABLE, 'payout');
    const withdrawingKobo = kobo(A2C.STATUS.WITHDRAWING, 'payout');
    const marginKobo = [A2C.STATUS.PROCESSING, A2C.STATUS.AVAILABLE, A2C.STATUS.WITHDRAWING, A2C.STATUS.WITHDRAWN].reduce(
      (n, s) => n + kobo(s, 'margin'),
      0,
    );
    const paystackFeesKobo = A2C.toKobo(withdrawals.find(w => w.status === 'success')?._sum?.provider_fee ?? 0);

    // What Paystack must hold for every conversion to be withdrawable at once.
    // Information, not a rule: the balance is shared with StaffPay payroll.
    const obligationsKobo = pendingKobo + availableKobo + withdrawingKobo;
    const paystackKobo = paystackBalance.available ? A2C.toKobo(paystackBalance.balance) : null;

    const reviewCount = reason => review.filter(r => service.reviewState(r).needs_review === reason).length;

    return ok(res, {
      // MySubWallet's own figure, named as they name it: what conversions have
      // credited VoltPay there and nobody has moved out yet - the money a
      // Paystack top-up for withdrawals comes from. Not the bills float
      // (funding.mysubwallet). Unknown is reported as unknown, never as 0.
      airtime_to_cash_balance:
        mswBalance.airtime_to_cash_balance != null
          ? { available: true, balance: mswBalance.airtime_to_cash_balance, retrieved_at: mswBalance.retrieved_at }
          : { available: false, reason: mswBalance.available ? 'not_reported' : mswBalance.reason },
      // Every naira customers are owed and not yet paid out - pending
      // settlement, available, and in flight to a bank. The figure Paystack has
      // to be able to cover.
      owed_to_customers: {
        total: A2C.moneyStr(obligationsKobo),
        pending: A2C.moneyStr(pendingKobo),
        available: A2C.moneyStr(availableKobo),
        withdrawing: A2C.moneyStr(withdrawingKobo),
      },
      needs_review: {
        count: review.length,
        in_flight: reviewCount('in_flight'),
        unconfirmed: reviewCount('unconfirmed'),
        unrecorded: reviewCount('unrecorded'),
      },
      cards: {
        pending: {
          count: count(A2C.STATUS.PROCESSING) + count(A2C.STATUS.SUBMITTING),
          payout: A2C.moneyStr(pendingKobo),
          airtime: A2C.moneyStr(kobo(A2C.STATUS.PROCESSING, 'amount') + kobo(A2C.STATUS.SUBMITTING, 'amount')),
        },
        available: { count: count(A2C.STATUS.AVAILABLE), payout: A2C.moneyStr(availableKobo) },
        withdrawing: { count: count(A2C.STATUS.WITHDRAWING), payout: A2C.moneyStr(withdrawingKobo) },
        withdrawn: { count: count(A2C.STATUS.WITHDRAWN), payout: A2C.moneyStr(kobo(A2C.STATUS.WITHDRAWN, 'payout')) },
        failed: { count: count(A2C.STATUS.FAILED) },
        unconfirmed: { count: unconfirmed },
      },
      margin: {
        gross: A2C.moneyStr(marginKobo),
        paystack_fees: A2C.moneyStr(paystackFeesKobo),
        net: A2C.moneyStr(marginKobo - paystackFeesKobo),
      },
      waiting: {
        oldest_converted_at: oldest?.converted_at || null,
        oldest_minutes: minutesSince(oldest?.converted_at),
        alert_after_hours: A2C.settlementAlertHours(),
      },
      funding: {
        obligations: A2C.moneyStr(obligationsKobo),
        paystack: paystackBalance,
        mysubwallet: mswBalance,
        shortfall: paystackKobo == null ? null : A2C.moneyStr(Math.max(0, obligationsKobo - paystackKobo)),
      },
      withdrawals: Object.fromEntries(
        WITHDRAWAL_STATUSES.map(s => {
          const row = withdrawals.find(w => w.status === s);
          return [s, { count: row?._count?._all || 0, amount: A2C.moneyStr(A2C.toKobo(row?._sum?.amount ?? 0)) }];
        }),
      ),
      rates: A2C.NETWORK_CODES.map(code => {
        const cfg = A2C.networkConfig(code);
        return {
          network: code,
          label: cfg.label,
          payout_rate: A2C.rateLabel(cfg.payoutBps),
          fee: A2C.moneyStr(cfg.feeKobo),
          provider_rate: A2C.rateLabel(cfg.providerBps),
        };
      }),
    }, 'Airtime to Cash overview');
  } catch (e) {
    return sendError(res, e, 'overview', 'Failed to load the Airtime to Cash overview');
  }
}

async function listConversions(req, res) {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
    const perPage = Math.min(Math.max(parseInt(req.query.perPage || '25', 10) || 25, 1), 100);

    const status = String(req.query.status || '').trim().toLowerCase();
    const network = A2C.parseNetwork(req.query.network);
    const providerStatus = String(req.query.provider_status || '').trim().toLowerCase();
    const userId = Number(req.query.user_id) || null;
    const q = String(req.query.q || '').trim().toUpperCase();
    const needsReview = ['1', 'true', 'yes'].includes(String(req.query.needs_review || '').trim().toLowerCase());

    // Search by the customer's line: the column is ciphertext, so it is found
    // through its blind index - exact number only, by design.
    const rawPhone = String(req.query.phone || '').trim();
    const line = rawPhone ? A2C.parsePhone(rawPhone) : null;
    if (rawPhone && !line) return fail(res, 400, 'Enter a valid Nigerian phone number');

    // A search for a person or a reference finds every attempt they made,
    // drafts included - "my airtime left and nothing shows" can be any of them.
    const searching = Boolean(line || q);
    const statusWhere = ALL_STATUSES.includes(status) ? status : searching ? undefined : { in: A2C.LISTED_STATUSES };

    const where = {
      ...(statusWhere ? { status: statusWhere } : {}),
      ...(network ? { network } : {}),
      ...(providerStatus === 'unconfirmed' ? { provider_status: { in: ['pending', 'unknown'] } } : {}),
      ...(providerStatus === 'confirmed' ? { provider_status: 'confirmed' } : {}),
      ...(userId ? { user_id: userId } : {}),
      ...(line ? { phone_idx: blindIndex(line.local, 'mobile') } : {}),
      // Our reference, or the request-id step 3 went out under (reference-2...).
      ...(q ? { OR: [{ reference: { startsWith: q } }, { provider_request_id: { startsWith: q } }] } : {}),
    };

    // The settlement queue is worked oldest first - that is the customer who
    // has waited longest. Everything else reads newest first.
    const sort = String(req.query.sort || (status === A2C.STATUS.PROCESSING || needsReview ? 'oldest' : 'newest'));
    const orderBy = sort === 'oldest' ? [{ created_at: 'asc' }, { id: 'asc' }] : [{ created_at: 'desc' }, { id: 'desc' }];

    let total;
    let rows;
    if (needsReview) {
      const { status: _ignored, ...rest } = where;
      const all = await needsReviewRows(rest);
      if (sort !== 'oldest') all.reverse();
      total = all.length;
      rows = all.slice((page - 1) * perPage, page * perPage);
    } else {
      [total, rows] = await Promise.all([
        prisma.airtimeCashConversion.count({ where }),
        prisma.airtimeCashConversion.findMany({ where, orderBy, skip: (page - 1) * perPage, take: perPage }),
      ]);
    }

    const [byStatus, review] = await Promise.all([
      prisma.airtimeCashConversion.groupBy({
        by: ['status'],
        where: { status: { in: A2C.LISTED_STATUSES } },
        _count: { _all: true },
      }),
      needsReviewRows(),
    ]);
    const users = await usersById(rows.map(r => r.user_id));

    return ok(res, {
      items: rows.map(r => adminConversion(r, users.get(r.user_id))),
      counts: {
        ...byStatus.reduce((acc, r) => ({ ...acc, [r.status]: r._count._all }), {}),
        needs_review: review.length,
      },
      pagination: { page, perPage, total, totalPages: Math.max(Math.ceil(total / perPage), 1) },
    }, 'Airtime to Cash conversions', 'airtime_cash_conversions');
  } catch (e) {
    return sendError(res, e, 'listConversions', 'Failed to load conversions');
  }
}

async function getConversion(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid conversion id');
    const row = await prisma.airtimeCashConversion.findUnique({ where: { id } });
    if (!row) return fail(res, 404, 'Conversion not found', 'not_found');

    const [events, withdrawal, users] = await Promise.all([
      prisma.airtimeCashEvent.findMany({ where: { conversion_id: id }, orderBy: { created_at: 'asc' } }),
      row.withdrawal_id ? prisma.airtimeCashWithdrawal.findUnique({ where: { id: row.withdrawal_id } }) : null,
      usersById([row.user_id]),
    ]);
    // Every withdrawal this conversion was ever part of, failed ones included -
    // a failed payout clears withdrawal_id, so the trail is where they live.
    const pastIds = [...new Set(events.map(e => Number(e.meta?.withdrawal_id)).filter(Boolean))];
    const history = pastIds.length
      ? await prisma.airtimeCashWithdrawal.findMany({ where: { id: { in: pastIds } }, orderBy: { created_at: 'desc' } })
      : [];

    const user = users.get(row.user_id);
    return ok(res, {
      conversion: {
        ...adminConversion(row, user),
        // In full on the details page only: reconciling against the MySubWallet
        // dashboard needs the actual line.
        phone: displayPhone(safeReveal(row.phone_enc)),
        provider_request_id: row.provider_request_id,
        provider_message: row.provider_message,
        convert_attempts: row.convert_attempts,
        otp_sends: row.otp_sends,
      },
      events: events.map(e => ({
        id: e.id,
        event: e.event,
        from_status: e.from_status,
        to_status: e.to_status,
        actor: e.actor,
        note: e.note ? revealText(e.note) : null,
        meta: e.meta,
        created_at: e.created_at,
      })),
      withdrawal: adminWithdrawal(withdrawal, user),
      withdrawal_history: history.map(w => adminWithdrawal(w, user)),
      timeline: A2C.timeline(row, { withdrawal }),
    }, 'Airtime to Cash conversion', 'airtime_cash_conversion');
  } catch (e) {
    return sendError(res, e, 'getConversion', 'Failed to load this conversion');
  }
}

async function markAvailable(req, res) {
  try {
    const result = await service.markAvailable({
      ids: req.body?.ids,
      actor: req.admin?.name || 'admin',
      note: req.body?.note,
      confirmUnconfirmed: req.body?.confirm_unconfirmed === true,
    });
    const message = result.updated.length
      ? `${result.updated.length} conversion(s) marked available`
      : 'Nothing was marked available';
    return ok(res, result, message, 'airtime_cash_mark_available');
  } catch (e) {
    return sendError(res, e, 'markAvailable', 'Could not mark these conversions available');
  }
}

async function markFailed(req, res) {
  try {
    const row = await service.markFailed({ id: req.params.id, actor: req.admin?.name || 'admin', note: req.body?.note });
    return ok(res, { id: row.id, status: row.status }, 'Conversion marked failed', 'airtime_cash_mark_failed');
  } catch (e) {
    return sendError(res, e, 'markFailed', 'Could not mark this conversion failed');
  }
}

/**
 * MySubWallet's dashboard shows the conversion and VoltPay does not: record
 * it, credit the customer as pending, tell them. The note must say where it
 * was confirmed - it is the only evidence there is, since their requery
 * cannot see Airtime to Cash.
 */
async function recordProviderSuccess(req, res) {
  try {
    const row = await service.recordProviderSuccess({ id: req.params.id, actor: req.admin?.name || 'admin', note: req.body?.note });
    return ok(res, { id: row.id, status: row.status }, 'Conversion recorded - the customer has been credited and notified', 'airtime_cash_recorded');
  } catch (e) {
    return sendError(res, e, 'recordProviderSuccess', 'Could not record this conversion');
  }
}

async function addNote(req, res) {
  try {
    await service.addNote({ id: req.params.id, actor: req.admin?.name || 'admin', note: req.body?.note });
    return ok(res, { id: Number(req.params.id) }, 'Note added', 'airtime_cash_note');
  } catch (e) {
    return sendError(res, e, 'addNote', 'Could not add the note');
  }
}

async function listWithdrawals(req, res) {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
    const perPage = Math.min(Math.max(parseInt(req.query.perPage || '25', 10) || 25, 1), 100);
    const status = String(req.query.status || '').trim().toLowerCase();
    const userId = Number(req.query.user_id) || null;
    const q = String(req.query.q || '').trim().toLowerCase();

    const where = {
      ...(WITHDRAWAL_STATUSES.includes(status) ? { status } : {}),
      ...(userId ? { user_id: userId } : {}),
      ...(q ? { reference: { startsWith: q } } : {}),
    };

    const [total, rows, byStatus] = await Promise.all([
      prisma.airtimeCashWithdrawal.count({ where }),
      prisma.airtimeCashWithdrawal.findMany({ where, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], skip: (page - 1) * perPage, take: perPage }),
      prisma.airtimeCashWithdrawal.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    const users = await usersById(rows.map(r => r.user_id));

    return ok(res, {
      items: rows.map(w => adminWithdrawal(w, users.get(w.user_id))),
      counts: byStatus.reduce((acc, r) => ({ ...acc, [r.status]: r._count._all }), {}),
      pagination: { page, perPage, total, totalPages: Math.max(Math.ceil(total / perPage), 1) },
    }, 'Airtime to Cash withdrawals', 'airtime_cash_withdrawals');
  } catch (e) {
    return sendError(res, e, 'listWithdrawals', 'Failed to load withdrawals');
  }
}

async function requeryWithdrawal(req, res) {
  try {
    const id = Number(req.params.id);
    const w = Number.isInteger(id) && id > 0 ? await prisma.airtimeCashWithdrawal.findUnique({ where: { id } }) : null;
    if (!w) return fail(res, 404, 'Withdrawal not found', 'not_found');
    // A settled row is final apart from a reversal, which only the webhook
    // reports - asking Paystack again changes nothing.
    if (!['pending', 'processing'].includes(w.status)) {
      return ok(res, { withdrawal: adminWithdrawal(w), changed: false }, 'This withdrawal is already settled', 'airtime_cash_requery');
    }
    const changed = await service.syncWithdrawal(w);
    const fresh = await prisma.airtimeCashWithdrawal.findUnique({ where: { id } });
    const users = await usersById([fresh.user_id]);
    return ok(
      res,
      { withdrawal: adminWithdrawal(fresh, users.get(fresh.user_id)), changed: Boolean(changed) },
      changed ? 'Withdrawal updated from Paystack' : 'Paystack has no final answer yet',
      'airtime_cash_requery',
    );
  } catch (e) {
    return sendError(res, e, 'requeryWithdrawal', 'Could not ask Paystack about this withdrawal');
  }
}

module.exports = {
  overview,
  listConversions,
  getConversion,
  markAvailable,
  markFailed,
  recordProviderSuccess,
  addNote,
  listWithdrawals,
  requeryWithdrawal,
};
