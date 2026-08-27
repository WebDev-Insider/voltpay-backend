// The money trail. One page an admin can answer "where did the money go" from,
// across every table that moves naira.
//
// Four sources, deliberately non-overlapping:
//
//   wallet          wallet_transactions - the ledger. Every user-wallet credit
//                   and debit: funding, transfers, airtime, data, bills,
//                   request money, StaffPay subscription.
//   funding         funding_transactions with credited_at = null - top-up
//                   attempts that never reached the ledger. A credited funding
//                   writes a wallet row under the SAME ref (funding.controller
//                   claims the row and creates the ledger entry in one tx), so
//                   including credited ones here would double count every
//                   deposit. `credited_at IS NULL` is the exact complement.
//   staffpay_payout staffpay_payroll_items - salary transfers. These leave the
//                   company's StaffPay float, not the user wallet, so they are
//                   in no ledger row and would otherwise be invisible here.
//   staffpay_fund   staffpay_funding_transactions - float top-ups.
//
// Deleted accounts stay visible. account.controller nulls the PII columns and
// sets status = 3 but keeps the row and every transaction attached to it, which
// is the whole point: the ledger outlives the person. Rows are never filtered
// by user status, and a purged owner is flagged `deleted: true` so the UI can
// say "Deleted account #41" instead of rendering a blank name.
const prisma = require('../../database/prisma');
const { blindIndex, publicUser, revealLedgerText } = require('../helpers/pii.helper');
const { publicStaff, publicCompany } = require('../helpers/staffpayPii.helper');
const { DELETED } = require('../helpers/accountStatus.helper');

const USER_SELECT = {
  id: true,
  status: true,
  firstname_enc: true,
  lastname_enc: true,
  username_enc: true,
  email_enc: true,
  mobile_enc: true,
  image: true,
};

function sanitize(value) {
  return String(value ?? '').trim();
}

function money(value) {
  const n = Number.parseFloat(String(value ?? 0));
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

function iso(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Same rule as support search: a fragment is not a phone number.
function normalizeNgPhone(input) {
  const digits = sanitize(input).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('234')) return digits;
  if (digits.startsWith('0')) return `234${digits.slice(1)}`;
  if (digits.length === 10) return `234${digits}`;
  return digits;
}

/** `{ gte, lte }` for a pair of calendar days, or null when neither is set. */
function dateRange(from, to) {
  if (!from && !to) return null;
  const range = {};
  if (from) range.gte = new Date(`${from}T00:00:00`);
  // `to` names a day, so it has to cover all of it.
  if (to) range.lte = new Date(`${to}T23:59:59.999`);
  if (range.gte && Number.isNaN(range.gte.getTime())) delete range.gte;
  if (range.lte && Number.isNaN(range.lte.getTime())) delete range.lte;
  return Object.keys(range).length ? range : null;
}

/**
 * Turn the search box into user ids.
 *
 * Email, mobile and username are ciphertext, so the only thing comparable is
 * their blind index - exact values only, never a fragment. A bare number is
 * also tried as a user id, which is how you look up an account whose email and
 * phone were erased by a deletion.
 */
async function resolveUserIds(q) {
  const value = sanitize(q);
  if (!value) return [];

  const or = [];
  const email = blindIndex(value.toLowerCase(), 'email');
  const mobile = blindIndex(normalizeNgPhone(value), 'mobile');
  const username = blindIndex(value, 'username');
  if (email) or.push({ email_idx: email });
  if (mobile) or.push({ mobile_idx: mobile });
  if (username) or.push({ username_idx: username });

  const rows = await prisma.user.findMany({ where: { OR: or }, select: { id: true } });
  const ids = rows.map(r => Number(r.id));

  if (/^\d{1,9}$/.test(value)) {
    const id = Number(value);
    if (!ids.includes(id)) ids.push(id);
  }

  return ids;
}

/**
 * Search clause for one source: match the reference, or any user the search
 * term resolved to. Returns null when `q` is empty.
 */
function searchClause(q, refField, userIds) {
  const value = sanitize(q);
  if (!value) return null;
  const or = [{ [refField]: { contains: value, mode: 'insensitive' } }];
  if (userIds.length) or.push({ user_id: { in: userIds } });
  return { OR: or };
}

// --- row mappers: every source ends up in one shape ------------------------

function mapWallet(row) {
  const { details, other_data } = revealLedgerText(row);
  return {
    source: 'wallet',
    id: row.id,
    ref: String(row.trx),
    user_id: Number(row.user_id),
    direction: String(row.trx_type),
    amount: money(row.amount),
    charge: money(row.charge),
    total_amount: money(row.total_amount),
    remark: String(row.remark || ''),
    // Written on every ledger row; falls back to successful for rows old
    // enough to predate the field.
    status: String(other_data.feedback || 'Successful').toLowerCase(),
    title: String(other_data.title || ''),
    counterparty: String(other_data.subtitle || ''),
    description: details,
    meta: row.meta || {},
    created_at: iso(row.created_at),
  };
}

function mapFunding(row) {
  return {
    source: 'funding',
    id: row.id,
    ref: String(row.tx_ref),
    user_id: Number(row.user_id),
    direction: '+',
    amount: money(row.amount),
    charge: '0.00',
    total_amount: money(row.amount),
    remark: 'fund_account',
    status: String(row.status || 'pending').toLowerCase(),
    title: 'Wallet funding',
    counterparty: '',
    // Never credited, by construction - this source excludes credited rows.
    description: 'Funding attempt - never credited to the wallet',
    meta: {},
    created_at: iso(row.created_at),
  };
}

function mapPayout(row) {
  const staff = publicStaff(row.staff) || {};
  const fees =
    Number(row.provider_fee || 0) + Number(row.voltpay_fee || 0) + Number(row.vat || 0);
  return {
    source: 'staffpay_payout',
    id: row.id,
    ref: String(row.reference || `staffpay_payout_${row.id}`),
    user_id: Number(row.payroll_run?.company?.owner_user_id || 0) || null,
    direction: '-',
    amount: money(row.amount),
    charge: money(fees),
    total_amount: money(Number(row.amount || 0) + fees),
    remark: 'staff_salary',
    status: String(row.status || '').toLowerCase(),
    title: String(row.payroll_run?.title || 'StaffPay payout'),
    counterparty: staff.full_name || '',
    description: row.complete_message || '',
    meta: {
      company_id: row.payroll_run?.company_id ?? null,
      payroll_run_id: row.payroll_run_id,
      staff_id: row.staff_id,
      account_last4: row.staff?.account_number_last4 || null,
      bank_name: row.staff?.bank_name || null,
      provider_transfer_id: row.provider_transfer_id || null,
      refunded_at: iso(row.refunded_at),
    },
    created_at: iso(row.created_at),
  };
}

function mapStaffFunding(row) {
  const company = publicCompany(row.company) || {};
  return {
    source: 'staffpay_fund',
    id: row.id,
    ref: String(row.tx_ref),
    user_id: Number(row.user_id),
    direction: '+',
    amount: money(row.amount),
    charge: '0.00',
    total_amount: money(row.amount),
    remark: 'staffpay_funding',
    status: String(row.status || 'pending').toLowerCase(),
    title: 'StaffPay float funding',
    counterparty: company.name || '',
    description: '',
    meta: { company_id: row.company_id, provider_tx_id: row.provider_tx_id || null },
    created_at: iso(row.created_at),
  };
}

/**
 * Attach the owning account to each row. Deleted owners are kept and flagged:
 * publicUser on a purged row returns nulls for every name field, so without the
 * flag the table would show an empty cell and look broken.
 */
async function attachUsers(rows) {
  const ids = [...new Set(rows.map(r => r.user_id).filter(Boolean))];
  if (!ids.length) return rows.map(r => ({ ...r, user: null }));

  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: USER_SELECT });

  const byId = new Map(
    users.map(u => [
      Number(u.id),
      { ...publicUser(u), deleted: Number(u.status) === DELETED },
    ])
  );

  return rows.map(r => ({ ...r, user: byId.get(Number(r.user_id)) || null }));
}

/**
 * Every `where` the list needs, from the query string plus the user ids the
 * search term resolved to. Pure - no DB - so the filter rules can be checked
 * without a database. This is where the double-counting guard lives, so it is
 * the part worth a test.
 */
function buildWheres(query, userIds = []) {
  const q = sanitize(query.q);
  const userId = Number.parseInt(query.userId || '', 10) || null;
  const direction = sanitize(query.direction);
  const remark = sanitize(query.remark).toLowerCase();
  const status = sanitize(query.status).toLowerCase();
  const source = sanitize(query.source).toLowerCase();
  const created_at = dateRange(sanitize(query.from), sanitize(query.to));

  const common = {
    ...(userId ? { user_id: userId } : {}),
    ...(created_at ? { created_at } : {}),
  };

  return {
    source,
    // A debit filter excludes the credit-only sources outright, and vice versa.
    creditOnly: direction === '-',
    debitOnly: direction === '+',

    // Wallet: status lives in other_data.feedback, written capitalised on every
    // ledger write ('Successful' | 'Processing' | 'Failed' | 'Refunded').
    wallet: {
      ...common,
      ...(remark ? { remark } : {}),
      ...(direction === '+' || direction === '-' ? { trx_type: direction } : {}),
      ...(status
        ? { other_data: { path: ['feedback'], equals: status.charAt(0).toUpperCase() + status.slice(1) } }
        : {}),
      ...(searchClause(q, 'trx', userIds) || {}),
    },

    funding: {
      // Credited fundings ARE the wallet rows above - same reference, written in
      // the same transaction. Including them here would show every deposit
      // twice and inflate the total. `credited_at IS NULL` is the exact
      // complement: attempts that never reached the ledger.
      credited_at: null,
      ...common,
      ...(status ? { status } : {}),
      ...(searchClause(q, 'tx_ref', userIds) || {}),
    },

    // Salary transfers hang off the company, so the owner is two relations away
    // and the search has to reach through them - same "reference or user" rule
    // as the other three sources.
    payout: {
      ...(created_at ? { created_at } : {}),
      ...(status ? { status: { equals: status, mode: 'insensitive' } } : {}),
      ...(userId ? { payroll_run: { company: { owner_user_id: userId } } } : {}),
      ...(q
        ? {
            OR: [
              { reference: { contains: q, mode: 'insensitive' } },
              ...(userIds.length
                ? [{ payroll_run: { company: { owner_user_id: { in: userIds } } } }]
                : []),
            ],
          }
        : {}),
    },

    staffFund: {
      ...common,
      ...(status ? { status } : {}),
      ...(searchClause(q, 'tx_ref', userIds) || {}),
    },
  };
}

/** Newest first. String compare is safe - every created_at is an ISO instant. */
function sortByNewest(rows) {
  return [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

async function listTransactions(req, res) {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page || '1', 10) || 1);
    const perPage = Math.min(Math.max(1, Number.parseInt(req.query.perPage || '25', 10) || 25), 100);
    const skip = (page - 1) * perPage;

    // Global sort is created_at desc, so page N of the merge is contained in
    // the first (skip + perPage) rows of each source. Anything past that
    // cannot surface on this page.
    const need = skip + perPage;

    const q = sanitize(req.query.q);
    const userIds = q ? await resolveUserIds(q) : [];

    const {
      source,
      creditOnly,
      debitOnly,
      wallet: walletWhere,
      funding: fundingWhere,
      payout: payoutWhere,
      staffFund: staffFundWhere,
    } = buildWheres(req.query, userIds);

    const wants = s => !source || source === s;

    const page$ = (model, where, order = { created_at: 'desc' }, include) =>
      model.findMany({ where, orderBy: [order, { id: 'desc' }], take: need, ...(include ? { include } : {}) });

    const [walletRows, walletCount] = wants('wallet')
      ? await Promise.all([
          page$(prisma.walletTransaction, walletWhere),
          prisma.walletTransaction.count({ where: walletWhere }),
        ])
      : [[], 0];

    const [fundingRows, fundingCount] =
      wants('funding') && !creditOnly
        ? await Promise.all([
            page$(prisma.fundingTransaction, fundingWhere),
            prisma.fundingTransaction.count({ where: fundingWhere }),
          ])
        : [[], 0];

    const [payoutRows, payoutCount] =
      wants('staffpay_payout') && !debitOnly
        ? await Promise.all([
            page$(prisma.staffPayPayrollItem, payoutWhere, { created_at: 'desc' }, {
              staff: true,
              payroll_run: { include: { company: { select: { id: true, owner_user_id: true } } } },
            }),
            prisma.staffPayPayrollItem.count({ where: payoutWhere }),
          ])
        : [[], 0];

    const [staffFundRows, staffFundCount] =
      wants('staffpay_fund') && !creditOnly
        ? await Promise.all([
            page$(prisma.staffPayFundingTransaction, staffFundWhere, { created_at: 'desc' }, {
              company: true,
            }),
            prisma.staffPayFundingTransaction.count({ where: staffFundWhere }),
          ])
        : [[], 0];

    const merged = sortByNewest([
      ...walletRows.map(mapWallet),
      ...fundingRows.map(mapFunding),
      ...payoutRows.map(mapPayout),
      ...staffFundRows.map(mapStaffFunding),
    ]);

    const total = walletCount + fundingCount + payoutCount + staffFundCount;
    const items = await attachUsers(merged.slice(skip, skip + perPage));

    // Fed to the filter dropdown so it stays right as new remarks appear.
    const remarks = await prisma.walletTransaction.groupBy({ by: ['remark'], _count: { remark: true } });

    res.json({
      remark: 'admin_transactions',
      status: 'success',
      message: ['OK'],
      data: {
        items,
        remarks: remarks
          .map(r => ({ value: r.remark, count: r._count.remark }))
          .sort((a, b) => b.count - a.count),
        totals: {
          wallet: walletCount,
          funding: fundingCount,
          staffpay_payout: payoutCount,
          staffpay_fund: staffFundCount,
        },
        pagination: { page, perPage, total, totalPages: Math.max(1, Math.ceil(total / perPage)) },
      },
    });
  } catch (e) {
    console.error('admin.listTransactions error', e);
    res
      .status(500)
      .json({ remark: 'error', status: 'error', message: ['Failed to list transactions'], data: null });
  }
}

/**
 * One transaction by reference, plus every sibling that shares its money.
 *
 * The siblings are what a double-debit or a missing-transfer investigation
 * actually needs: the other leg of a transfer, the ledger row a funding did or
 * did not produce, the retries of one payroll item.
 */
async function getTransaction(req, res) {
  try {
    const ref = sanitize(req.params.ref);
    if (!ref) {
      return res
        .status(400)
        .json({ remark: 'bad_request', status: 'error', message: ['Reference is required'], data: null });
    }

    let tx = null;

    const wallet = await prisma.walletTransaction.findUnique({ where: { trx: ref } });
    if (wallet) tx = mapWallet(wallet);

    if (!tx) {
      const funding = await prisma.fundingTransaction.findUnique({ where: { tx_ref: ref } });
      if (funding) {
        tx = mapFunding(funding);
        tx.status = String(funding.status || '').toLowerCase();
        tx.description = funding.credited_at
          ? 'Credited to the wallet - see the ledger row under the same reference'
          : 'Funding attempt - never credited to the wallet';
        tx.raw_payload = funding.raw_payload || null;
        tx.credited_at = iso(funding.credited_at);
      }
    }

    if (!tx) {
      const item = await prisma.staffPayPayrollItem.findUnique({
        where: { reference: ref },
        include: {
          staff: true,
          payroll_run: { include: { company: { select: { id: true, owner_user_id: true } } } },
        },
      });
      if (item) {
        tx = mapPayout(item);
        tx.raw_payload = item.raw_payload || null;
      }
    }

    if (!tx) {
      const fund = await prisma.staffPayFundingTransaction.findUnique({
        where: { tx_ref: ref },
        include: { company: true },
      });
      if (fund) {
        tx = mapStaffFunding(fund);
        tx.raw_payload = fund.raw_payload || null;
      }
    }

    if (!tx) {
      return res
        .status(404)
        .json({ remark: 'not_found', status: 'error', message: ['Transaction not found'], data: null });
    }

    // The other leg. A transfer stores the counterparty's trx in meta, a
    // funding shares its ref with the ledger row it produced, and a payroll
    // item shares its run with the rest of the batch.
    const relatedRefs = new Set(
      [tx.meta?.receiver_trx, tx.meta?.sender_trx, tx.meta?.transfer_ref].filter(Boolean).map(String)
    );

    // A funding shares its reference with the ledger row it produced. Looking
    // it up is the check for the worst case: money claimed and credited, but no
    // ledger entry to show for it.
    if (tx.source === 'funding') relatedRefs.add(tx.ref);
    else relatedRefs.delete(tx.ref);

    const related = relatedRefs.size
      ? (await prisma.walletTransaction.findMany({ where: { trx: { in: [...relatedRefs] } } })).map(mapWallet)
      : [];

    const [withUser] = await attachUsers([tx]);
    const relatedWithUsers = await attachUsers(related);

    res.json({
      remark: 'admin_transaction',
      status: 'success',
      message: ['OK'],
      data: { transaction: withUser, related: relatedWithUsers },
    });
  } catch (e) {
    console.error('admin.getTransaction error', e);
    res
      .status(500)
      .json({ remark: 'error', status: 'error', message: ['Failed to fetch transaction'], data: null });
  }
}

module.exports = {
  listTransactions,
  getTransaction,
  __test: { buildWheres, sortByNewest, dateRange, normalizeNgPhone, mapWallet, mapFunding },
};
