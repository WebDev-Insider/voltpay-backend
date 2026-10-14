const prisma = require('../../database/prisma');
const { listHistory } = require('../services/airtime.service');
const { revealLedgerText, revealUserFields } = require('../helpers/pii.helper');
const { buildStatementPdf } = require('../helpers/statementPdf.helper');
const cache = require('../services/cache.service');

function formatAmount(value) {
  const n = Number.parseFloat(String(value ?? 0));
  if (!Number.isFinite(n)) return '0';
  return String(Number.parseFloat(n.toFixed(2)));
}

function computeFundingFee(amountNaira) {
  const amt = Number(amountNaira);
  if (!Number.isFinite(amt) || amt <= 0) return 0;
  if (amt >= 100 && amt <= 1000) return 10;
  if (amt > 1000 && amt <= 20000) return 30;
  if (amt > 20000) return 50;
  return 0;
}

// A calendar day for a Nigerian user is WAT (UTC+1, no DST), so a plain
// `new Date('2026-08-05')` would start the range an hour late and drop the
// first hour of transactions. Pin the offset explicitly instead.
function watDayStart(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return null;
  const d = new Date(`${dateStr}T00:00:00.000+01:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function watDayEnd(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return null;
  const d = new Date(`${dateStr}T23:59:59.999+01:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The Postgres half of a history read: wallet transactions plus the legacy
 * funding rows, mapped into the shape the app renders, newest-first.
 *
 * Split out from collectTransactions so it can be cached on its own. Two things
 * make that safe:
 *
 * - **The rows leave here still encrypted.** `details` and
 *   `other_data.subtitle` name a counterparty, so they stay in their stored
 *   ciphertext form and are opened by revealLedgerText per request, after the
 *   cache. Caching the decrypted text would put customer names in plaintext
 *   into Redis, which is exactly what the ledger rule in CLAUDE.md forbids -
 *   Redis is held to the same standard as the database. AES-GCM in process is
 *   microseconds; the Neon round trip it replaces is milliseconds.
 * - **The in-memory airtime history is deliberately not in here.** It lives in
 *   a per-process Map, so caching it would let one instance serve its rows to
 *   another - or, worse, cache a list *without* them and hide them from the
 *   instance that owns them. It is merged per request instead.
 */
async function loadLedgerRows({ id, type, remark, search, createdRange }) {
  let walletRows = [];
  try {
    if (prisma.walletTransaction) {
      walletRows = await prisma.walletTransaction.findMany({
        where: {
          user_id: id,
          ...(remark ? { remark } : {}),
          ...(search ? { trx: { contains: search, mode: 'insensitive' } } : {}),
          ...(type === 'plus' ? { trx_type: '+' } : (type === 'minus' ? { trx_type: '-' } : {})),
          ...createdRange,
        },
        orderBy: { id: 'desc' },
      });
    }
  } catch (_) {
    walletRows = [];
  }

  // Legacy: persisted funding transactions
  const whereFunding = { user_id: id, ...createdRange };
  const fundingRows = await prisma.fundingTransaction.findMany({
    where: search ? { ...whereFunding, tx_ref: { contains: search, mode: 'insensitive' } } : whereFunding,
    orderBy: { id: 'desc' },
  });

  const fundingMapped = fundingRows.map(r => {
    const gross = Number(r.amount?.toString?.() ?? r.amount);
    const fee = computeFundingFee(gross);
    const net = Math.max(0, (Number.isFinite(gross) ? gross : 0) - fee);

    const status = String(r.status || '').toLowerCase();
    const statusLabel = status === 'successful' || status === 'success' ? 'Successful' : status ? status : 'Pending';
    return {
      id: r.id,
      trx: String(r.tx_ref),
      trx_type: '+',
      amount: formatAmount(net),
      charge: formatAmount(fee),
      total_amount: formatAmount(gross),
      remark: 'fund_account',
      other_data: {
        title: 'Transfer to Wallet',
        subtitle: 'Wallet Funding',
        feedback: statusLabel,
        note: '',
        image_src: '',
      },
      details: 'Wallet funding',
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
      created_at_diff: '',
    };
  });

  const walletMapped = (Array.isArray(walletRows) ? walletRows : []).map(r => {
    const createdIso = r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString();
    return {
      id: r.id,
      trx: String(r.trx),
      trx_type: String(r.trx_type),
      amount: formatAmount(r.amount),
      charge: formatAmount(r.charge),
      total_amount: formatAmount(r.total_amount),
      remark: String(r.remark),
      // Left as stored - still ciphertext when it names a counterparty. Opened
      // by revealLedgerText in collectTransactions, after the cache.
      details: r.details || '',
      other_data: r.other_data || {},
      meta: r.meta || {},
      created_at: createdIso,
      created_at_diff: '',
    };
  });

  return [...walletMapped, ...fundingMapped];
}

/**
 * Reads every ledger source for a user and returns one unified, de-duplicated,
 * newest-first list. Shared by the paginated history endpoint and the CSV
 * export so both always describe the same transactions.
 */
async function collectTransactions({ userId, type = '', remark = '', search = '', from = null, to = null }) {
  const id = Number(userId);
  const createdRange = from || to
    ? { created_at: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
    : {};

  // Only the unfiltered read is cached, and it is the one that matters: the
  // transaction screen opens on it, then every page of infinite scroll asks for
  // it again. Pagination happens in JavaScript below, so page 40 costs the same
  // full history read as page 1 - which is precisely what caching removes.
  //
  // Filtered and date-ranged reads (search, the statement export) go straight
  // to Postgres. They are rare, they are many-shaped, and giving each shape its
  // own key would fill Redis with entries read once and invalidated together.
  const isUnfiltered = !type && !remark && !search && !from && !to;
  const loadRows = () => loadLedgerRows({ id, type, remark, search, createdRange });

  const ledgerMapped = isUnfiltered
    ? await cache.remember(cache.keys.txList(id), cache.TTL.txList, loadRows)
    : await loadRows();

  // Legacy: in-memory airtime/data history. Per-process and never cached.
  const airtimeRows = Array.isArray(listHistory(id)) ? listHistory(id) : [];

  const airtimeMapped = airtimeRows.map((a) => {
    const isElectricity = String(a.remark || '').toLowerCase() === 'electricity';
    const amountStr = formatAmount(Number(a.amount));
    const createdIso = a.created_at ? new Date(a.created_at).toISOString() : new Date().toISOString();
    const msisdn = `${a.dial_code || ''}${a.mobile_number || ''}`;
    const isData = String(a.remark || '').toLowerCase() === 'data';
    const remarkVal = isElectricity ? 'utility_bill' : 'mobile_recharge';
    const title = isElectricity ? 'Electricity' : (isData ? 'Data' : 'Airtime');
    const detailsFallback = isElectricity ? 'Electricity purchase' : (isData ? `Data to ${msisdn}` : `Airtime to ${msisdn}`);
    const subtitleOp = isElectricity
      ? (a.details || 'Utility Bill')
      : (a.operator?.name ? `${a.operator.name} ${msisdn}` : `${title} ${msisdn}`);
    return {
      id: a.id,
      trx: String(a.trx),
      trx_type: '-',
      amount: amountStr,
      charge: '0.00',
      total_amount: amountStr,
      remark: remarkVal,
      other_data: {
        title,
        subtitle: subtitleOp,
        feedback: 'Successful',
        note: '',
        image_src: '',
      },
      details: a.details || detailsFallback,
      created_at: createdIso,
      created_at_diff: '',
    };
  });

  // Order matters: wallet rows, then funding, then airtime - the de-duplication
  // below keeps the first occurrence of a trx, so the ledger row wins over the
  // legacy copy of the same transaction. loadLedgerRows preserves that order.
  let combined = [...ledgerMapped, ...airtimeMapped];

  // De-duplicate by trx (prefer first occurrence)
  const seenTrx = new Set();
  combined = combined.filter(x => {
    const key = String(x.trx || '');
    if (!key) return true;
    if (seenTrx.has(key)) return false;
    seenTrx.add(key);
    return true;
  });

  // The in-memory airtime rows are not filtered by the queries above, so every
  // filter has to be re-applied over the combined list.
  if (remark) {
    const rmk = remark.toLowerCase();
    combined = combined.filter(x => String(x.remark || '').toLowerCase() === rmk);
  }

  if (type === 'plus') combined = combined.filter(x => x.trx_type === '+');
  else if (type === 'minus') combined = combined.filter(x => x.trx_type === '-');

  if (search) {
    const s = search.toLowerCase();
    combined = combined.filter(x => String(x.trx || '').toLowerCase().includes(s));
  }

  if (from || to) {
    const fromMs = from ? from.getTime() : -Infinity;
    const toMs = to ? to.getTime() : Infinity;
    combined = combined.filter(x => {
      const t = new Date(x.created_at).getTime();
      return t >= fromMs && t <= toMs;
    });
  }

  combined.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  // Open the counterparty text last, once, on the rows that actually survived
  // the filters. Every filter above keys on trx, remark, type or date, so none
  // of them needed the plaintext - which is what lets the decryption happen
  // here, outside the cache, instead of before it. Rows that were never
  // encrypted (funding, airtime, older ledger rows) pass through untouched.
  return combined.map(row => ({ ...row, ...revealLedgerText(row) }));
}

async function getTransactions(req, res) {
  try {
    const { page = 1 } = req.query;

    const user = req.user;
    if (!user) {
      return res.status(401).json({
        remark: 'unauthorized',
        status: 'error',
        message: ['Please login first'],
        data: null,
      });
    }

    const perPage = 15;
    const pageNum = Math.max(1, Number(page) || 1);
    const skip = (pageNum - 1) * perPage;

    const combined = await collectTransactions({
      userId: user.id,
      type: String(req.query?.type || '').toLowerCase(),
      remark: String(req.query?.remark || '').trim(),
      search: String(req.query?.search || '').trim(),
    });

    const total = combined.length;
    const lastPage = Math.max(1, Math.ceil(total / perPage));
    const hasNext = pageNum < lastPage;
    const pageData = combined.slice(skip, skip + perPage);

    const remarkSet = new Set(combined.map(x => String(x.remark || '')).filter(Boolean));
    return res.json({
      remark: 'transactions',
      status: 'success',
      message: ['Transactions fetched successfully'],
      data: {
        transactions: {
          current_page: pageNum,
          data: pageData,
          first_page_url: `/api/transactions?page=1`,
          last_page: lastPage,
          last_page_url: `/api/transactions?page=${lastPage}`,
          next_page_url: hasNext ? `/api/transactions?page=${pageNum + 1}` : null,
          path: '/api/transactions',
          per_page: perPage,
          total,
        },
        remarks: Array.from(remarkSet).sort().map(r => ({ remark: r })),
      },
    });
  } catch (error) {
    console.error('Error fetching transactions (controller):', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to fetch transactions'],
      data: null,
    });
  }
}

const REMARK_LABELS = {
  fund_account: 'Fund Account',
  balance_add: 'Balance Added',
  balance_subtract: 'Balance Subtracted',
  add_money: 'Add Money',
  withdraw: 'Money Withdrawn',
  cash_in: 'Cash In',
  send_money: 'Send Money',
  receive_money: 'Money Received',
  cash_out: 'Cash Out',
  make_payment: 'Payment',
  utility_bill: 'Utility Bill',
  cable_tv: 'Cable TV',
  mobile_recharge: 'Mobile Recharge',
  donation: 'Donation',
  bank_transfer: 'Bank Transfer',
  education_fee: 'Education Fee',
  request_money_accept: 'Requested Money Sent',
  requested_money_fund_added: 'Requested Money Received',
  microfinance: 'Microfinance',
  virtual_card_add_fund: 'Virtual Card',
  virtual_card: 'USD Virtual Card',
  top_up: 'Top Up',
  cashback: 'Cash Back',
  air_time: 'Airtime',
  betting: 'Betting',
};

function watParts(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  // Shift into WAT, then read the UTC fields so the output is the wall clock
  // the user actually saw.
  const wat = new Date(d.getTime() + 60 * 60 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return {
    date: `${wat.getUTCFullYear()}-${pad(wat.getUTCMonth() + 1)}-${pad(wat.getUTCDate())}`,
    time: `${pad(wat.getUTCHours())}:${pad(wat.getUTCMinutes())}:${pad(wat.getUTCSeconds())}`,
  };
}

async function exportTransactions(req, res) {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({
        remark: 'unauthorized',
        status: 'error',
        message: ['Please login first'],
        data: null,
      });
    }

    const fromStr = String(req.query?.from || '').trim();
    const toStr = String(req.query?.to || '').trim();
    const from = watDayStart(fromStr);
    const to = watDayEnd(toStr);

    if (!from || !to) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Provide a valid date range (from and to, as YYYY-MM-DD)'],
        data: null,
      });
    }
    if (from.getTime() > to.getTime()) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: ['The start date must not be after the end date'],
        data: null,
      });
    }

    const rows = await collectTransactions({ userId: user.id, from, to });

    // The statement carries the account holder's own name and contact, so the
    // encrypted columns have to be opened here. Plaintext lives only for the
    // length of this request and is never logged.
    const owner = revealUserFields(user) || {};
    const accountName = [owner.firstname, owner.lastname].filter(Boolean).join(' ').trim()
      || String(owner.username || '').trim();

    const pdf = await buildStatementPdf({
      rows,
      from: fromStr,
      to: toStr,
      accountName,
      accountEmail: owner.email || '',
      accountMobile: owner.mobile || '',
      watParts,
      categoryFor: remark => REMARK_LABELS[String(remark || '')] || String(remark || ''),
    });

    const filename = `voltpay-statement-${fromStr}-to-${toStr}.pdf`;

    if (String(req.query?.format || '').toLowerCase() === 'file') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(pdf);
    }

    // Base64 in the usual envelope: the app shares the file through the OS
    // sheet, so it needs the bytes plus the count for its own messaging, and
    // ApiService only ever parses JSON.
    return res.json({
      remark: 'transactions_export',
      status: 'success',
      message: ['Statement generated successfully'],
      data: {
        filename,
        from: fromStr,
        to: toStr,
        count: rows.length,
        mime: 'application/pdf',
        pdf: pdf.toString('base64'),
      },
    });
  } catch (error) {
    console.error('Error exporting transactions (controller):', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to export transactions'],
      data: null,
    });
  }
}

module.exports = {
  getTransactions,
  exportTransactions,
  // Exported for test/transactions.export.test.js
  watParts,
  watDayStart,
  watDayEnd,
};
