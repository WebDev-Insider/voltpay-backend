const prisma = require('../../database/prisma');
const { Prisma } = require('@prisma/client');
const { applyBalanceDelta, upsertBalanceDelta, restampBalance } = require('../helpers/balance.helper');
const { revealUserFields, verifySecret } = require('../helpers/pii.helper');

const {
  listBanks,
  resolveAccount,
  createTransferRecipient,
  initializeTransaction,
  verifyTransaction,
  verifyWebhookSignature,
  createCustomer,
  createDedicatedAccount,
  listTransactions,
  getCustomerId,
} = require('../funding/paystack.service');

const {
  createPayrollRunForCompany,
  retryFailedItems,
  syncPayrollRunById,
  handleTransferEvent,
  quotePayroll,
  payoutTimeOrDefault,
} = require('../services/staffpayPayroll.service');

const { encryptString, decryptString } = require('../helpers/encryption.helper');
const {
  protectCompanyFields,
  revealCompanyFields,
  protectStaffFields,
  revealStaffFields,
  publicCompany,
  publicStaff,
  publicPayrollRun,
} = require('../helpers/staffpayPii.helper');
const { logStaffPayEvent } = require('../services/staffpayAudit.service');
const { handleTransferEvent: handleAirtimeCashTransferEvent } = require('../services/airtimeCash.service');
const { settlePaystack: settleCacPayment } = require('../services/cac.service');
const { getAccessState } = require('../helpers/staffpayAccess.helper');
const { nextDueAtUtc, listDueStaff } = require('../helpers/staffpayDue.helper');

function normalizeAmountToDecimal(amount) {
  const cleaned = String(amount ?? '').replace(/,/g, '').trim();
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Prisma.Decimal(n.toFixed(2));
}

// Payday window from the spec: salaries land between the 25th and the 29th.
const MIN_PAYMENT_DAY = 25;
const MAX_PAYMENT_DAY = 29;
const DEFAULT_PAYMENT_DAY = 25;

function validatePaymentDay(day) {
  if (day == null) return null;
  if (!Number.isInteger(day) || day < MIN_PAYMENT_DAY || day > MAX_PAYMENT_DAY) {
    return `payment_day must be between ${MIN_PAYMENT_DAY} and ${MAX_PAYMENT_DAY}`;
  }
  return null;
}

// Total monthly payroll (salaries + fees) against the wallet, as strings so the
// app can render them without losing precision through JSON.
async function payrollCoverage(companyId) {
  const quote = await quotePayroll({ companyId });
  return {
    monthly_total: quote.totals.total.toFixed(2),
    salary_total: quote.totals.salary.toFixed(2),
    fee_total: quote.totals.provider.plus(quote.totals.volt).plus(quote.totals.vat).toFixed(2),
    wallet_balance: quote.balance.toFixed(2),
    shortfall: quote.shortfall.toFixed(2),
    is_sufficient: quote.is_sufficient,
    staff_count: quote.staff.length,
  };
}

/**
 * History is filtered by calendar month, and a Nigerian calendar month starts
 * at 00:00 WAT (UTC+1, no DST). Building the bounds from plain UTC would put
 * the first hour of the month in the previous one.
 *
 * `year` alone is allowed and means the whole year.
 */
function monthYearRange(month, year) {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) return null;

  const m = month === undefined || month === null || String(month).trim() === '' ? null : Number(month);
  if (m !== null && (!Number.isInteger(m) || m < 1 || m > 12)) return null;

  const startMonth = m === null ? 1 : m;
  const start = new Date(`${y}-${String(startMonth).padStart(2, '0')}-01T00:00:00.000+01:00`);

  const end = m === null
    ? new Date(`${y + 1}-01-01T00:00:00.000+01:00`)
    : new Date(m === 12
      ? `${y + 1}-01-01T00:00:00.000+01:00`
      : `${y}-${String(m + 1).padStart(2, '0')}-01T00:00:00.000+01:00`);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { gte: start, lt: end };
}

/** Wall-clock WAT for a human reading the export, not the UTC the row is stored in. */
function watStamp(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() + 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

/** RFC 4180 quoting. A staff name with a comma must not shift the columns. */
function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function formatDateYmd(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// The business timezone. StaffPay already reasons in it everywhere that matters
// (payout_timezone, companyPayoutTimeReached), and the dashboard trend has to
// agree or a chart bar disagrees with the payday it is describing.
const TREND_TZ = 'Africa/Lagos';

const DAY_MS = 24 * 60 * 60 * 1000;
// Length of the dashboard trend window, in days. The app labels this card
// "Last N days" off the number of points it receives, so widening the window
// here is the only change needed.
const TREND_DAYS = 7;

/**
 * The calendar day a timestamp falls on *in Lagos*, as `YYYY-MM-DD`.
 *
 * A UTC bucket puts anything between 00:00 and 01:00 WAT on the previous day,
 * so a wallet funded at half past midnight showed up on yesterday's bar. Uses
 * `en-CA` because it formats as YYYY-MM-DD natively; falls back to the UTC day
 * if Intl is unavailable, which is the old behaviour rather than a crash.
 */
function formatDateYmdInTz(date, timeZone = TREND_TZ) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch (_) {
    return formatDateYmd(d);
  }
}

/** How many minutes `timeZone` is ahead of UTC at this instant. +60 for WAT. */
function tzOffsetMinutes(date, timeZone = TREND_TZ) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second),
    );
    return Math.round((asUtc - date.getTime()) / 60000);
  } catch (_) {
    return 0;
  }
}

/**
 * The UTC instant of midnight in `timeZone` on the day containing `date`.
 * Nigeria has no DST, so stepping whole days off this stays exact.
 */
function tzStartOfDayUtc(date, timeZone = TREND_TZ) {
  const ymd = formatDateYmdInTz(date, timeZone);
  if (!ymd) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - (tzOffsetMinutes(date, timeZone) * 60000));
}

function staffPayVatRate() {
  const raw = String(process.env.STAFFPAY_VAT_RATE || '').trim();
  if (!raw) return 0.075;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0.075;
  return n;
}

function computeVoltPayHybridFee(amountDecimal) {
  const pct = 0.01;
  const min = new Prisma.Decimal('20.00');
  const cap = new Prisma.Decimal('200.00');
  let fee;
  try {
    fee = new Prisma.Decimal(amountDecimal).mul(new Prisma.Decimal(pct.toFixed(4)));
  } catch {
    fee = new Prisma.Decimal('0.00');
  }
  try {
    fee = new Prisma.Decimal(fee.toFixed(2));
  } catch (_) {}
  if (fee.lt(min)) return min;
  if (fee.gt(cap)) return cap;
  return fee;
}

/**
 * Safety net for wallet funding: a webhook Paystack never delivered, or one we
 * dropped. Walks recent successful charges for the company's Paystack customer
 * and credits any that have no funding row yet.
 *
 * Credit is claimed by creating the row first - `provider_tx_id` is unique, so
 * a duplicate throws P2002 and the balance is left alone. That is what makes
 * this safe to run alongside the webhook.
 */
async function creditMissingCharges({ company, lookbackDays = 7, maxVerify = 30 }) {
  const customerCode = String(company.paystack_customer_code || '').trim();
  if (!customerCode) return { credited: 0, reason: 'no_dedicated_account' };

  // `to` is tomorrow, not today: Paystack reads a bare date as midnight, so
  // `to=<today>` excludes every payment made today - the exact window a user
  // pulls to refresh in.
  const to = formatDateYmd(new Date(Date.now() + 24 * 60 * 60 * 1000));
  const from = formatDateYmd(new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000));

  let rows = [];
  try {
    const customerId = await getCustomerId(customerCode);
    if (!customerId) return { credited: 0, reason: 'provider_unavailable' };
    ({ data: rows } = await listTransactions({ status: 'success', from, to, customer: customerId, perPage: maxVerify }));
  } catch (e) {
    console.error('staffpay reconcile list error:', e?.message || e);
    return { credited: 0, reason: 'provider_unavailable' };
  }

  let credited = 0;

  for (const t of rows.slice(0, maxVerify)) {
    const providerTxId = t?.id != null ? String(t.id) : '';
    const amount = koboToDecimal(t?.amount);
    if (!providerTxId || !amount) continue;
    if (String(t?.currency || 'NGN').toUpperCase() !== 'NGN') continue;
    // The provider-side filter is the only thing tying this charge to the
    // company, so re-check it here rather than trust the query string.
    if (String(t?.customer?.customer_code || '') !== customerCode) continue;
    // Subscription fees ride the same customer. They are not wallet funding.
    if (String(t?.reference || '').startsWith('SPSUB-')) continue;
    // Nor are CAC Registration checkouts: Paystack keeps one customer per email,
    // so the owner's CAC payment sits on this customer too. It already paid for
    // an application (cac.service settles it); crediting it here would count
    // the same money twice.
    if (String(t?.reference || '').startsWith('CACPAY-')) continue;

    const already = await withDirectFallback(db => db.staffPayFundingTransaction.findFirst({ where: { provider_tx_id: providerTxId } }));
    if (already) continue;

    try {
      await withDirectFallback(db => db.$transaction(async tx => {
        await tx.staffPayFundingTransaction.create({
          data: {
            company_id: Number(company.id),
            user_id: Number(company.owner_user_id),
            tx_ref: `spva_${company.id}_${providerTxId}`,
            provider_tx_id: providerTxId,
            amount,
            currency: 'NGN',
            status: 'successful',
            raw_payload: t,
            credited_at: new Date(),
          },
        });

        await upsertBalanceDelta(tx, 'staffPayWallet', company.id, amount);
      }, { timeout: 15000 }));

      credited += 1;
    } catch (e) {
      if (e?.code !== 'P2002') console.error('staffpay reconcile credit error:', e?.message || e);
    }
  }

  return { credited };
}

async function autoReconcileWalletFunding(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const company_id = Number(req.body?.company_id || req.query?.company_id);
    const lookbackDays = Math.max(1, Math.min(30, Number(req.body?.days || req.query?.days || 7)));

    let company;
    if (company_id) {
      company = await getOwnedCompanyOrFail({ userId: user.id, companyId: company_id, res });
      if (!company) return;
    } else {
      company = await prisma.staffPayCompany.findFirst({
        where: { owner_user_id: Number(user.id) },
        orderBy: { id: 'asc' },
      });
      if (!company) {
        return res.status(404).json({ remark: 'not_found', status: 'error', message: ['Company not found'], data: null });
      }
    }

    const { credited, reason } = await creditMissingCharges({ company, lookbackDays });
    const wallet = await withDirectFallback(db => db.staffPayWallet.findUnique({ where: { company_id: Number(company.id) } }));

    return res.json({
      remark: 'staffpay_wallet_auto_reconcile',
      status: 'success',
      message: [reason === 'no_dedicated_account' ? 'No dedicated account configured' : 'OK'],
      data: { wallet, credited_count: credited },
    });
  } catch (e) {
    console.error('staffpay autoReconcileWalletFunding error:', e);
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}


async function listFundingHistory(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const company_id = Number(req.query?.company_id);
    if (!company_id) return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['company_id is required'], data: null });

    const company = await getOwnedCompanyOrFail({ userId: user.id, companyId: company_id, res });
    if (!company) return;

    const page = Math.max(1, Number(req.query?.page || 1));
    const pageSize = Math.max(1, Math.min(50, Number(req.query?.page_size || 20)));
    const status = String(req.query?.status || 'successful').trim().toLowerCase();
    const source = String(req.query?.source || 'all').trim().toLowerCase();

    const where = {
      company_id: Number(company.id),
    };

    if (req.query?.year) {
      const range = monthYearRange(req.query?.month, req.query?.year);
      if (!range) {
        return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid month or year'], data: null });
      }
      where.created_at = range;
    }

    if (status !== 'all') {
      where.status = status;
    }

    if (source === 'virtual_account') {
      where.tx_ref = { startsWith: 'spva_' };
    } else if (source === 'payment_link') {
      where.tx_ref = { startsWith: 'spfund_' };
    }

    const [rows, total] = await Promise.all([
      prisma.staffPayFundingTransaction.findMany({
        where,
        orderBy: [{ credited_at: 'desc' }, { created_at: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          tx_ref: true,
          provider_tx_id: true,
          amount: true,
          status: true,
          created_at: true,
          updated_at: true,
          credited_at: true,
        },
      }),
      prisma.staffPayFundingTransaction.count({ where }),
    ]);

    const hasNext = page * pageSize < (total || 0);
    const nextPageUrl = hasNext ? `page=${page + 1}` : null;

    const companyName = revealCompanyFields(company).name;

    const items = (rows || []).map(r => {
      const txRef = String(r.tx_ref || '').trim();
      const src = txRef.startsWith('spva_') ? 'virtual_account' : 'payment_link';
      const srcLabel = src === 'virtual_account' ? 'Via Virtual Account' : 'Via Payment Link';

      const st = String(r.status || '').trim();
      const feedback = st ? (st.charAt(0).toUpperCase() + st.slice(1)) : 'Pending';
      const createdAt = (r.credited_at || r.updated_at || r.created_at || new Date()).toISOString();

      return {
        id: r.id,
        trx: txRef,
        trx_type: '+',
        amount: (r.amount != null ? r.amount.toString() : '0'),
        charge: '0',
        total_amount: (r.amount != null ? r.amount.toString() : '0'),
        remark: 'fund_account',
        other_data: {
          title: 'StaffPay Funding',
          subtitle: srcLabel,
          feedback,
          note: src,
          image_src: null,
        },
        meta: {
          company_id: Number(company.id),
          source: src,
          provider_tx_id: r.provider_tx_id ? String(r.provider_tx_id) : null,
        },
        details: companyName,
        created_at: createdAt,
        created_at_diff: null,
      };
    });

    return res.json({
      remark: 'staffpay_funding_history',
      status: 'success',
      message: ['OK'],
      data: {
        transactions: {
          data: items,
          next_page_url: nextPageUrl,
          path: 'staffpay/history/funding',
        },
        remarks: [],
      },
    });
  } catch (e) {
    console.error('staffpay listFundingHistory error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function listPayoutHistory(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const company_id = Number(req.query?.company_id);
    if (!company_id) return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['company_id is required'], data: null });

    const company = await getOwnedCompanyOrFail({ userId: user.id, companyId: company_id, res });
    if (!company) return;

    const page = Math.max(1, Number(req.query?.page || 1));
    const pageSize = Math.max(1, Math.min(50, Number(req.query?.page_size || 20)));
    const status = String(req.query?.status || 'all').trim().toLowerCase();

    const successStatuses = ['SUCCESSFUL', 'SUCCESS', 'COMPLETED'];
    const failedStatuses = ['FAILED', 'FAIL', 'ERROR', 'REJECTED'];
    const pendingStatuses = ['NEW', 'PENDING', 'PROCESSING'];

    const where = {
      payroll_run: { is: { company_id: Number(company.id) } },
    };

    if (req.query?.year) {
      const range = monthYearRange(req.query?.month, req.query?.year);
      if (!range) {
        return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid month or year'], data: null });
      }
      where.created_at = range;
    }

    if (status === 'successful') {
      where.status = { in: successStatuses };
    } else if (status === 'failed') {
      where.status = { in: failedStatuses };
    } else if (status === 'pending') {
      where.status = { in: pendingStatuses };
    }

    const [rows, total] = await Promise.all([
      prisma.staffPayPayrollItem.findMany({
        where,
        orderBy: [{ updated_at: 'desc' }, { created_at: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          staff: true,
          payroll_run: true,
        },
      }),
      prisma.staffPayPayrollItem.count({ where }),
    ]);

    const hasNext = page * pageSize < (total || 0);
    const nextPageUrl = hasNext ? `page=${page + 1}` : null;

    const items = (rows || []).map(r => {
      const st = String(r.status || '').trim();
      const stUpper = st.toUpperCase();
      const feedback = st ? (st.charAt(0).toUpperCase() + st.slice(1).toLowerCase()) : 'Pending';

      const createdAt = (r.updated_at || r.created_at || new Date()).toISOString();

      const staffName = String(revealStaffFields(r.staff).full_name || '').trim() || 'Staff';
      const bankName = String(r.staff?.bank_name || '').trim();
      const acctLast4 = String(r.staff?.account_number_last4 || '').trim();
      const subtitle = `${bankName || 'Bank'}${acctLast4 ? ` • ****${acctLast4}` : ''}`;

      const amount = r.amount != null ? r.amount.toString() : '0';
      const providerFee = r.provider_fee != null ? r.provider_fee.toString() : '0';
      const vpFee = r.voltpay_fee != null ? r.voltpay_fee.toString() : '0';
      const vatFee = r.vat != null ? r.vat.toString() : '0';

      const feeTotal = (() => {
        try {
          return new Prisma.Decimal(providerFee).plus(new Prisma.Decimal(vpFee)).plus(new Prisma.Decimal(vatFee)).toFixed(2);
        } catch {
          return providerFee;
        }
      })();
      const totalDebit = (() => {
        try {
          return new Prisma.Decimal(amount).plus(new Prisma.Decimal(feeTotal)).toFixed(2);
        } catch {
          return amount;
        }
      })();

      const remark = 'bank_transfer';

      return {
        id: r.id,
        trx: String(r.reference || `staffpay_payout_${r.id}`),
        trx_type: '-',
        amount,
        charge: feeTotal,
        total_amount: totalDebit,
        remark,
        other_data: {
          title: staffName,
          subtitle,
          feedback,
          note: (stUpper === 'SUCCESSFUL') ? 'successful' : (stUpper === 'FAILED' ? 'failed' : 'pending'),
          image_src: null,
        },
        meta: {
          company_id: Number(company.id),
          payroll_run_id: Number(r.payroll_run_id),
          staff_id: Number(r.staff_id),
          provider_transfer_id: r.provider_transfer_id || null,
          status: st,
          fee_breakdown: {
            provider_fee: providerFee,
            voltpay_fee: vpFee,
            vat: vatFee,
            total_fee: feeTotal,
          },
        },
        details: String(r.payroll_run?.title || '').trim() || 'StaffPay payout',
        created_at: createdAt,
        created_at_diff: null,
      };
    });

    return res.json({
      remark: 'staffpay_payout_history',
      status: 'success',
      message: ['OK'],
      data: {
        transactions: {
          data: items,
          next_page_url: nextPageUrl,
          path: 'staffpay/history/payouts',
        },
        remarks: [],
      },
    });
  } catch (e) {
    console.error('staffpay listPayoutHistory error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

/**
 * CSV of the payout history for one month (or a whole year). Same columns the
 * history screen shows: Date, Staff Name, Amount, Status, Reference.
 *
 * Defaults to base64 in the usual envelope because the Flutter ApiService only
 * parses JSON; `format=file` returns the raw file for the admin dashboard.
 */
async function exportPayoutHistory(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const company_id = Number(req.query?.company_id);
    if (!company_id) return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['company_id is required'], data: null });

    const company = await getOwnedCompanyOrFail({ userId: user.id, companyId: company_id, res });
    if (!company) return;

    const where = { payroll_run: { is: { company_id: Number(company.id) } } };

    let label = 'all';
    if (req.query?.year) {
      const range = monthYearRange(req.query?.month, req.query?.year);
      if (!range) {
        return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid month or year'], data: null });
      }
      where.created_at = range;
      label = req.query?.month
        ? `${req.query.year}-${String(Number(req.query.month)).padStart(2, '0')}`
        : String(req.query.year);
    }

    // A month of payroll is tens of rows; the cap only stops an unbounded
    // "all time" export from paging the whole table into memory.
    const rows = await prisma.staffPayPayrollItem.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: 5000,
      include: { staff: true },
    });

    const lines = [['Date', 'Staff Name', 'Amount', 'Status', 'Reference'].join(',')];
    for (const r of rows) {
      lines.push([
        watStamp(r.created_at),
        String(revealStaffFields(r.staff).full_name || '').trim() || 'Staff',
        r.amount != null ? r.amount.toString() : '0',
        String(r.status || '').toUpperCase(),
        String(r.reference || ''),
      ].map(csvCell).join(','));
    }

    const csv = `${lines.join('\r\n')}\r\n`;
    const filename = `staffpay-payouts-${company.id}-${label}.csv`;

    if (String(req.query?.format || '').toLowerCase() === 'file') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(csv);
    }

    return res.json({
      remark: 'staffpay_payout_export',
      status: 'success',
      message: ['OK'],
      data: {
        filename,
        count: rows.length,
        mime: 'text/csv',
        csv: Buffer.from(csv, 'utf8').toString('base64'),
      },
    });
  } catch (e) {
    console.error('staffpay exportPayoutHistory error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

/** Manual version of the same sweep, for support to run against one company. */
async function reconcileWalletFunding(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const company_id = Number(req.body?.company_id);
    if (!company_id) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['company_id is required'], data: null });
    }

    const company = await getOwnedCompanyOrFail({ userId: user.id, companyId: company_id, res });
    if (!company) return;

    const lookbackDays = Math.max(1, Math.min(30, Number(req.body?.days || 7)));
    const { credited, reason } = await creditMissingCharges({ company, lookbackDays });
    const wallet = await withDirectFallback(db => db.staffPayWallet.findUnique({ where: { company_id: Number(company.id) } }));

    return res.json({
      remark: 'staffpay_wallet_reconciled',
      status: 'success',
      message: [reason === 'no_dedicated_account' ? 'No dedicated account configured' : 'OK'],
      data: { wallet, credited_count: credited },
    });
  } catch (e) {
    console.error('staffpay reconcileWalletFunding error:', e);
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}


function toDecimalOrNull(value) {
  if (value == null) return null;
  try {
    return new Prisma.Decimal(String(value));
  } catch {
    return null;
  }
}

// Paystack talks in kobo. Everything below this line is naira.
function koboToDecimal(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Prisma.Decimal((n / 100).toFixed(2));
}

function isAccelerateCommError(e) {
  return Boolean(e && (e.code === 'P6000' || e?.meta?.code === 'P6000'));
}

async function withDirectFallback(run) {
  try {
    return await run(prisma);
  } catch (e) {
    if (isAccelerateCommError(e) && prisma.$direct) {
      return await run(prisma.$direct);
    }
    throw e;
  }
}

function getBaseUrl(req) {
  const configured = process.env.PUBLIC_BASE_URL || process.env.APP_URL || process.env.BACKEND_URL;
  if (configured) return String(configured).trim().replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString().split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

function safeLast4(accountNumber) {
  const digits = String(accountNumber || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.slice(-4);
}

async function requireModels(res) {
  const missing = [];
  if (!prisma.staffPayCompany) missing.push('StaffPayCompany');
  if (!prisma.staffPayStaff) missing.push('StaffPayStaff');
  if (!prisma.staffPayWallet) missing.push('StaffPayWallet');
  if (!prisma.staffPayFundingTransaction) missing.push('StaffPayFundingTransaction');
  if (!prisma.staffPayPayrollRun) missing.push('StaffPayPayrollRun');
  if (!prisma.staffPayPayrollItem) missing.push('StaffPayPayrollItem');

  if (missing.length) {
    res.status(500).json({
      remark: 'server_error',
      status: 'error',
      message: [`Missing Prisma models: ${missing.join(', ')}. Run prisma generate + migrate/db push and restart the server.`],
      data: null,
    });
    return false;
  }

  return true;
}

async function getOwnedCompanyOrFail({ userId, companyId, res }) {
  const company = await prisma.staffPayCompany.findFirst({
    where: { id: Number(companyId), owner_user_id: Number(userId) },
    include: { wallet: true },
  });

  if (!company) {
    res.status(404).json({ remark: 'not_found', status: 'error', message: ['Company not found'], data: null });
    return null;
  }

  return company;
}

async function banks(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const rows = await listBanks({ currency: 'NGN' });

    const banks = (rows || []).map(b => ({
      id: b?.id ?? null,
      name: b?.name ?? '',
      code: String(b?.code ?? '').trim(),
    }));

    return res.json({ remark: 'staffpay_bank_list', status: 'success', message: ['OK'], data: { banks } });
  } catch (e) {
    console.error('staffpay banks error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function resolveBankAccount(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const account_number = String(req.body?.account_number || '').trim();
    const bank_code = String(req.body?.bank_code || req.body?.account_bank || '').trim();
    if (!account_number || !bank_code) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['account_number and bank_code are required'], data: null });
    }

    const { data } = await resolveAccount({ account_number, bank_code });

    return res.json({
      remark: 'staffpay_account_resolved',
      status: 'success',
      message: ['OK'],
      data: {
        account_number,
        bank_code,
        account_name: data?.account_name || null,
      },
    });
  } catch (e) {
    console.error('staffpay resolveBankAccount error:', e);
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function createCompany(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const name = String(req.body?.name || '').trim();
    const address = String(req.body?.address || '').trim();
    const cac_number = req.body?.cac_number ? String(req.body.cac_number).trim() : null;
    const phone = String(req.body?.phone || '').trim();
    const email = String(req.body?.email || '').trim();

    if (!name || !address || !phone || !email) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: ['name, address, phone and email are required'],
        data: null,
      });
    }

    const existingCount = await prisma.staffPayCompany.count({ where: { owner_user_id: Number(user.id) } });
    if (existingCount >= 2) {
      return res.status(400).json({ remark: 'limit_reached', status: 'error', message: ['Maximum of 2 companies allowed'], data: null });
    }

    const created = await prisma.staffPayCompany.create({
      data: {
        owner_user_id: Number(user.id),
        ...protectCompanyFields({ name, address, phone, email }),
        cac_number,
        auto_pay_enabled: true,
        // Automatic payroll is not optional, so a new company starts on the
        // platform default schedule instead of an unset one.
        payout_time: payoutTimeOrDefault(null),
        payout_timezone: 'Africa/Lagos',
        wallet: {
          create: {
            balance: new Prisma.Decimal('0.00'),
          },
        },
      },
      include: { wallet: true },
    });

    await logStaffPayEvent({
      userId: user.id,
      event: 'staffpay_company_created',
      metadata: { company_id: created.id },
    });

    return res.json({ remark: 'staffpay_company_created', status: 'success', message: ['Company created'], data: { company: publicCompany(created) } });
  } catch (e) {
    console.error('staffpay createCompany error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function listCompanies(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const companies = await prisma.staffPayCompany.findMany({
      where: { owner_user_id: Number(user.id) },
      include: { wallet: true, _count: { select: { staff: true } } },
      orderBy: { id: 'desc' },
    });

    return res.json({
      remark: 'staffpay_company_list',
      status: 'success',
      message: ['OK'],
      data: {
        companies: companies.map(c => ({
          ...publicCompany(c),
          staff_count: c?._count?.staff ?? 0,
        })),
      },
    });
  } catch (e) {
    console.error('staffpay listCompanies error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function getCompany(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const company = await getOwnedCompanyOrFail({ userId: user.id, companyId: req.params?.companyId, res });
    if (!company) return;

    return res.json({ remark: 'staffpay_company', status: 'success', message: ['OK'], data: { company: publicCompany(company) } });
  } catch (e) {
    console.error('staffpay getCompany error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function updateCompany(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const companyId = Number(req.params?.companyId);
    const company = await getOwnedCompanyOrFail({ userId: user.id, companyId, res });
    if (!company) return;

    const name = req.body?.name != null ? String(req.body.name).trim() : undefined;
    const address = req.body?.address != null ? String(req.body.address).trim() : undefined;
    const cac_number = req.body?.cac_number != null ? String(req.body.cac_number).trim() : undefined;
    const phone = req.body?.phone != null ? String(req.body.phone).trim() : undefined;
    const email = req.body?.email != null ? String(req.body.email).trim() : undefined;
    // No AutoPay toggle any more: payroll always runs on the schedule, so
    // `auto_pay_enabled` is system-controlled (account deactivation) and is not
    // accepted from the client.

    // The schedule is required, so clearing the field means "use the platform
    // default", never "no automatic payroll".
    let payout_time = undefined;
    if (req.body?.payout_time != null) {
      const t = String(req.body.payout_time).trim();
      if (!t) {
        payout_time = payoutTimeOrDefault(null);
      } else {
        if (!/^\d{2}:\d{2}$/.test(t)) {
          return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid payout_time (expected HH:mm)'], data: null });
        }
        const [hhRaw, mmRaw] = t.split(':');
        const hh = Number(hhRaw);
        const mm = Number(mmRaw);
        if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
          return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid payout_time'], data: null });
        }
        payout_time = t;
      }
    }

    let payout_timezone = undefined;
    if (req.body?.payout_timezone != null) {
      const tz = String(req.body.payout_timezone).trim();
      if (!tz) {
        payout_timezone = 'Africa/Lagos';
      } else {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
        } catch (_) {
          return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid payout_timezone'], data: null });
        }
        payout_timezone = tz;
      }
    }

    const lbaeRaw = req.body?.low_balance_alert_enabled;
    const low_balance_alert_enabled = lbaeRaw != null
      ? (() => {
          if (typeof lbaeRaw === 'boolean') return lbaeRaw;
          if (typeof lbaeRaw === 'number') return lbaeRaw === 1;
          const s = String(lbaeRaw).trim().toLowerCase();
          if (s === 'true' || s === '1' || s === 'yes') return true;
          if (s === 'false' || s === '0' || s === 'no') return false;
          return undefined;
        })()
      : undefined;
    if (lbaeRaw != null && low_balance_alert_enabled === undefined) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid low_balance_alert_enabled'], data: null });
    }

    let low_balance_threshold = undefined;
    if (req.body?.low_balance_threshold != null) {
      const cleaned = String(req.body.low_balance_threshold).replace(/,/g, '').trim();
      const n = Number(cleaned);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid low_balance_threshold'], data: null });
      }
      low_balance_threshold = new Prisma.Decimal(n.toFixed(2));
    }

    const updated = await prisma.staffPayCompany.update({
      where: { id: company.id },
      data: {
        ...protectCompanyFields({
          ...(name !== undefined ? { name } : {}),
          ...(address !== undefined ? { address } : {}),
          ...(phone !== undefined ? { phone } : {}),
          ...(email !== undefined ? { email } : {}),
        }),
        ...(cac_number !== undefined ? { cac_number } : {}),
        ...(payout_time !== undefined ? { payout_time } : {}),
        ...(payout_timezone !== undefined ? { payout_timezone } : {}),
        ...(low_balance_alert_enabled !== undefined ? { low_balance_alert_enabled } : {}),
        ...(low_balance_threshold !== undefined ? { low_balance_threshold } : {}),
      },
      include: { wallet: true },
    });

    await logStaffPayEvent({
      userId: user.id,
      event: 'staffpay_company_updated',
      metadata: { company_id: updated.id },
    });

    return res.json({ remark: 'staffpay_company_updated', status: 'success', message: ['Company updated'], data: { company: publicCompany(updated) } });
  } catch (e) {
    console.error('staffpay updateCompany error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function deleteCompany(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const companyId = Number(req.params?.companyId);
    if (!companyId) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid companyId'], data: null });
    }

    const passwordInput = String(req.body?.password || '').trim();
    if (!passwordInput) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Password is required'], data: null });
    }

    const freshUser = await prisma.user.findUnique({ where: { id: Number(user.id) }, select: { id: true, password: true } });
    if (!freshUser) {
      return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login again'], data: null });
    }

    const storedPassword = String(freshUser.password || '').trim();
    if (!storedPassword) {
      return res.status(400).json({ remark: 'password_not_set', status: 'error', message: ['Password not set for this account'], data: null });
    }

    const valid = (await verifySecret(passwordInput, storedPassword, 'password')).ok;
    if (!valid) {
      return res.status(400).json({ remark: 'invalid_password', status: 'error', message: ['Invalid password'], data: null });
    }

    const company = await getOwnedCompanyOrFail({ userId: user.id, companyId, res });
    if (!company) return;

    const inflight = await prisma.staffPayPayrollRun.findFirst({
      where: {
        company_id: company.id,
        status: { in: ['preparing', 'queued', 'processing'] },
      },
      orderBy: { id: 'desc' },
    });
    if (inflight) {
      return res.status(409).json({
        remark: 'staffpay_payroll_in_progress',
        status: 'error',
        message: ['A payroll payout is currently in progress. Please wait for it to complete before deleting this company.'],
        data: { payroll_run_id: inflight.id },
      });
    }

    await prisma.staffPayCompany.delete({ where: { id: company.id } });

    await logStaffPayEvent({
      userId: user.id,
      event: 'staffpay_company_deleted',
      // Ids only: an audit row is read by more people than the company row is.
      metadata: { company_id: company.id },
    });

    return res.json({ remark: 'staffpay_company_deleted', status: 'success', message: ['Company deleted'], data: null });
  } catch (e) {
    console.error('staffpay deleteCompany error:', e);
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function createStaff(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const company_id = Number(req.body?.company_id);
    if (!company_id) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['company_id is required'], data: null });
    }

    const company = await getOwnedCompanyOrFail({ userId: user.id, companyId: company_id, res });
    if (!company) return;

    const full_name = String(req.body?.full_name || '').trim();
    // The app collects a job title now, not a phone number. `phone` is still
    // read so an older build does not lose the value it sends.
    const phone = String(req.body?.phone || '').trim();
    const role = String(req.body?.role || '').trim();
    const bank_code = String(req.body?.bank_code || '').trim();
    const bank_name = req.body?.bank_name != null ? String(req.body.bank_name).trim() : null;
    const bank_branch_code = req.body?.bank_branch_code != null ? String(req.body.bank_branch_code).trim() : null;
    const bank_branch_name = req.body?.bank_branch_name != null ? String(req.body.bank_branch_name).trim() : null;
    const account_number = String(req.body?.account_number || '').trim();
    const salary_amount = normalizeAmountToDecimal(req.body?.salary_amount);
    const payment_day = req.body?.payment_day != null ? Number(req.body.payment_day) : null;
    const start_date_raw = req.body?.start_date;

    if (!full_name || !bank_code || !account_number || !salary_amount) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: ['full_name, bank_code, account_number and salary_amount are required'],
        data: null,
      });
    }

    const dayError = validatePaymentDay(payment_day);
    if (dayError) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: [dayError], data: null });
    }

    let start_date = new Date();
    if (start_date_raw != null && String(start_date_raw).trim() !== '') {
      const parsedStart = new Date(start_date_raw);
      if (Number.isNaN(parsedStart.getTime())) {
        return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid start_date'], data: null });
      }
      start_date = parsedStart;
    }

    const last4 = safeLast4(account_number);
    if (!last4) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid account_number'], data: null });
    }

    // The account name is resolved, not typed. A salary sent to a mistyped
    // account is gone, so a bank that will not confirm the name blocks the save.
    let account_name;
    let recipient_code;
    try {
      const { data } = await resolveAccount({ account_number, bank_code });
      account_name = data?.account_name || null;
      if (!account_name) throw new Error('Bank did not return an account name');

      ({ recipient_code } = await createTransferRecipient({ name: account_name, account_number, bank_code }));
    } catch (e) {
      return res.status(400).json({
        remark: 'account_not_resolved',
        status: 'error',
        message: [e?.message || 'Could not verify this bank account'],
        data: null,
      });
    }

    const created = await prisma.staffPayStaff.create({
      data: {
        company_id: company.id,
        ...protectStaffFields({ full_name, phone, account_name }),
        role: role || null,
        bank_code,
        bank_name,
        bank_branch_code,
        bank_branch_name,
        account_number_enc: encryptString(account_number),
        account_number_last4: last4,
        paystack_recipient_code: recipient_code,
        salary_amount,
        frequency: 'monthly',
        payment_day: payment_day != null && Number.isFinite(payment_day) ? payment_day : DEFAULT_PAYMENT_DAY,
        start_date,
        is_active: true,
      },
    });

    await logStaffPayEvent({
      userId: user.id,
      event: 'staffpay_staff_created',
      metadata: { company_id: company.id, staff_id: created.id },
    });

    // Adding a salary changes what payroll costs, so the shortfall is recomputed
    // here rather than leaving the app to discover it on payday.
    const coverage = await payrollCoverage(company.id);

    return res.json({
      remark: 'staffpay_staff_created',
      status: 'success',
      message: coverage.is_sufficient
        ? ['Staff created']
        : ['Staff created', `You need to fund ₦${coverage.shortfall} more to cover this month's payroll.`],
      data: { staff: publicStaff(created), payroll_coverage: coverage },
    });
  } catch (e) {
    console.error('staffpay createStaff error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function listStaff(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const company_id = Number(req.query?.company_id);
    if (!company_id) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['company_id is required'], data: null });
    }

    const company = await getOwnedCompanyOrFail({ userId: user.id, companyId: company_id, res });
    if (!company) return;

    const staff = await prisma.staffPayStaff.findMany({
      where: { company_id: company.id },
      orderBy: { id: 'desc' },
    });

    return res.json({ remark: 'staffpay_staff_list', status: 'success', message: ['OK'], data: { staff: staff.map(publicStaff) } });
  } catch (e) {
    console.error('staffpay listStaff error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function updateStaff(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const staffId = Number(req.params?.staffId);
    if (!staffId) return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid staffId'], data: null });

    const existing = await prisma.staffPayStaff.findUnique({ where: { id: staffId }, include: { company: true } });
    if (!existing || Number(existing.company?.owner_user_id) !== Number(user.id)) {
      return res.status(404).json({ remark: 'not_found', status: 'error', message: ['Staff not found'], data: null });
    }

    const data = {};
    Object.assign(data, protectStaffFields({
      ...(req.body?.full_name != null ? { full_name: String(req.body.full_name).trim() } : {}),
      ...(req.body?.phone != null ? { phone: String(req.body.phone).trim() } : {}),
    }));
    if (req.body?.role != null) data.role = String(req.body.role).trim() || null;
    if (req.body?.bank_code != null) data.bank_code = String(req.body.bank_code).trim();
    if (req.body?.bank_name != null) data.bank_name = String(req.body.bank_name).trim();
    if (req.body?.bank_branch_code != null) data.bank_branch_code = String(req.body.bank_branch_code).trim();
    if (req.body?.bank_branch_name != null) data.bank_branch_name = String(req.body.bank_branch_name).trim();
    if (req.body?.payment_day != null) {
      const day = Number(req.body.payment_day);
      const dayError = validatePaymentDay(day);
      if (dayError) return res.status(400).json({ remark: 'validation_error', status: 'error', message: [dayError], data: null });
      data.payment_day = day;
    }
    if (req.body?.start_date != null) {
      const d = new Date(req.body.start_date);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid start_date'], data: null });
      }
      data.start_date = d;
    }
    if (req.body?.salary_amount != null) {
      const dec = normalizeAmountToDecimal(req.body.salary_amount);
      if (!dec) return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid salary_amount'], data: null });
      data.salary_amount = dec;
    }
    if (req.body?.is_active != null) {
      const v = req.body.is_active;
      let parsed = null;
      if (typeof v === 'boolean') parsed = v;
      else if (typeof v === 'number') parsed = v === 1;
      else {
        const s = String(v).trim().toLowerCase();
        if (s === 'true' || s === '1' || s === 'yes') parsed = true;
        else if (s === 'false' || s === '0' || s === 'no') parsed = false;
      }
      if (parsed == null) {
        return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid is_active'], data: null });
      }
      data.is_active = parsed;
    }

    // Bank details are re-verified on every change, and the old recipient is
    // discarded - keeping it would send the next salary to the previous account.
    const bankChanged = req.body?.account_number != null || (data.bank_code && data.bank_code !== existing.bank_code);
    if (bankChanged) {
      const account_number = req.body?.account_number != null
        ? String(req.body.account_number).trim()
        : decryptString(existing.account_number_enc);
      const bank_code = data.bank_code || existing.bank_code;

      const last4 = safeLast4(account_number);
      if (!last4) {
        return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid account_number'], data: null });
      }

      try {
        const { data: resolved } = await resolveAccount({ account_number, bank_code });
        const account_name = resolved?.account_name || null;
        if (!account_name) throw new Error('Bank did not return an account name');

        const { recipient_code } = await createTransferRecipient({ name: account_name, account_number, bank_code });

        data.account_number_enc = encryptString(account_number);
        data.account_number_last4 = last4;
        Object.assign(data, protectStaffFields({ account_name }));
        data.paystack_recipient_code = recipient_code;
      } catch (e) {
        return res.status(400).json({
          remark: 'account_not_resolved',
          status: 'error',
          message: [e?.message || 'Could not verify this bank account'],
          data: null,
        });
      }
    }

    const updated = await prisma.staffPayStaff.update({ where: { id: staffId }, data });

    await logStaffPayEvent({
      userId: user.id,
      event: 'staffpay_staff_updated',
      metadata: { company_id: existing.company_id, staff_id: updated.id, bank_changed: Boolean(bankChanged) },
    });

    const coverage = await payrollCoverage(existing.company_id);

    return res.json({
      remark: 'staffpay_staff_updated',
      status: 'success',
      message: coverage.is_sufficient
        ? ['Staff updated']
        : ['Staff updated', `You need to fund ₦${coverage.shortfall} more to cover this month's payroll.`],
      data: { staff: publicStaff(updated), payroll_coverage: coverage },
    });
  } catch (e) {
    console.error('staffpay updateStaff error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function deleteStaff(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const staffId = Number(req.params?.staffId);
    if (!staffId) return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid staffId'], data: null });

    const existing = await withDirectFallback(db => db.staffPayStaff.findUnique({ where: { id: staffId }, include: { company: true } }));
    if (!existing || Number(existing.company?.owner_user_id) !== Number(user.id)) {
      return res.status(404).json({ remark: 'not_found', status: 'error', message: ['Staff not found'], data: null });
    }

    await withDirectFallback(db => db.$transaction(async tx => {
      if (tx.staffPayPayrollItem) {
        await tx.staffPayPayrollItem.deleteMany({ where: { staff_id: staffId } });
      }
      await tx.staffPayStaff.delete({ where: { id: staffId } });
    }, { timeout: 15000 }));

    await logStaffPayEvent({
      userId: user.id,
      event: 'staffpay_staff_deleted',
      metadata: { company_id: existing.company_id, staff_id: staffId },
    });
    return res.json({ remark: 'staffpay_staff_deleted', status: 'success', message: ['Staff removed'], data: { staff_id: staffId } });
  } catch (e) {
    console.error('staffpay deleteStaff error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function getWallet(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const company_id = Number(req.query?.company_id);
    if (!company_id) return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['company_id is required'], data: null });

    const company = await getOwnedCompanyOrFail({ userId: user.id, companyId: company_id, res });
    if (!company) return;

    return res.json({ remark: 'staffpay_wallet', status: 'success', message: ['OK'], data: { wallet: company.wallet } });
  } catch (e) {
    console.error('staffpay getWallet error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function getDashboard(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const company_id = Number(req.query?.company_id);
    if (!company_id) return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['company_id is required'], data: null });

    const company = await getOwnedCompanyOrFail({ userId: user.id, companyId: company_id, res });
    if (!company) return;

    const now = new Date();
    const startThis = new Date(now.getFullYear(), now.getMonth(), 1);
    const startNext = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const startPrev = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    // Seven Lagos days ending with today, expressed as the UTC instants that
    // bound them. TREND_DAYS is the single source for the window length - the
    // app's "Last 7 days" caption is describing this number.
    const trendTodayStart = tzStartOfDayUtc(now) || new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const trendStart = new Date(trendTodayStart.getTime() - ((TREND_DAYS - 1) * DAY_MS));
    const trendEnd = new Date(trendTodayStart.getTime() + DAY_MS);

    const [staffCount, salaryAgg, accessState, incomeTotalAgg, expenseTotalAgg, incomeThisAgg, expenseThisAgg, incomePrevAgg, expensePrevAgg, fundingTrendRows, paidItemRows, scheduleRows] = await Promise.all([
      prisma.staffPayStaff.count({ where: { company_id: company.id, is_active: true } }),
      // What one full payroll costs today - the app warns on the shortfall
      // before payday rather than after a half-finished run.
      prisma.staffPayStaff.aggregate({
        _sum: { salary_amount: true },
        where: { company_id: company.id, is_active: true },
      }),
      getAccessState(company.id),
      prisma.staffPayFundingTransaction.aggregate({
        _sum: { amount: true },
        where: { company_id: company.id, status: 'successful' },
      }),
      prisma.staffPayPayrollRun.aggregate({
        _sum: { total_salary: true },
        where: { company_id: company.id, status: 'successful' },
      }),
      prisma.staffPayFundingTransaction.aggregate({
        _sum: { amount: true },
        where: {
          company_id: company.id,
          status: 'successful',
          credited_at: { gte: startThis, lt: startNext },
        },
      }),
      prisma.staffPayPayrollRun.aggregate({
        _sum: { total_salary: true },
        where: {
          company_id: company.id,
          status: 'successful',
          created_at: { gte: startThis, lt: startNext },
        },
      }),
      prisma.staffPayFundingTransaction.aggregate({
        _sum: { amount: true },
        where: {
          company_id: company.id,
          status: 'successful',
          credited_at: { gte: startPrev, lt: startThis },
        },
      }),
      prisma.staffPayPayrollRun.aggregate({
        _sum: { total_salary: true },
        where: {
          company_id: company.id,
          status: 'successful',
          created_at: { gte: startPrev, lt: startThis },
        },
      }),
      prisma.staffPayFundingTransaction.findMany({
        where: {
          company_id: company.id,
          status: 'successful',
          credited_at: { gte: trendStart, lt: trendEnd },
        },
        select: { amount: true, credited_at: true },
      }),
      // paid_at, not updated_at: updated_at is @updatedAt, so a webhook or a
      // sync poll touching an old row would drag a months-old salary into this
      // window and file it under today. SUCCESSFUL is the only success status
      // the payroll service ever writes (mapTransferStatus).
      prisma.staffPayPayrollItem.findMany({
        where: {
          payroll_run: { is: { company_id: company.id } },
          status: 'SUCCESSFUL',
          paid_at: { gte: trendStart, lt: trendEnd },
        },
        select: { staff_id: true, paid_at: true },
      }),
      // Only what the payday countdown needs - the same fields the scheduler
      // reads, so the app counts down to the day payroll actually runs.
      prisma.staffPayStaff.findMany({
        where: { company_id: company.id, is_active: true },
        select: { payment_day: true, frequency: true, start_date: true, last_paid_at: true },
      }),
    ]);

    const income_total = incomeTotalAgg?._sum?.amount || new Prisma.Decimal('0.00');
    const expense_total = expenseTotalAgg?._sum?.total_salary || new Prisma.Decimal('0.00');
    const income_this_month = incomeThisAgg?._sum?.amount || new Prisma.Decimal('0.00');
    const expense_this_month = expenseThisAgg?._sum?.total_salary || new Prisma.Decimal('0.00');
    const income_prev_month = incomePrevAgg?._sum?.amount || new Prisma.Decimal('0.00');
    const expense_prev_month = expensePrevAgg?._sum?.total_salary || new Prisma.Decimal('0.00');

    const fundedByDay = new Map();
    for (const r of Array.isArray(fundingTrendRows) ? fundingTrendRows : []) {
      const dt = r?.credited_at ? new Date(r.credited_at) : null;
      if (!dt || Number.isNaN(dt.getTime())) continue;
      const k = formatDateYmdInTz(dt);
      const prev = fundedByDay.get(k) || new Prisma.Decimal('0.00');
      fundedByDay.set(k, prev.plus(r?.amount || new Prisma.Decimal('0.00')));
    }

    const paidByDay = new Map();
    for (const r of Array.isArray(paidItemRows) ? paidItemRows : []) {
      const dt = r?.paid_at ? new Date(r.paid_at) : null;
      if (!dt || Number.isNaN(dt.getTime())) continue;
      const k = formatDateYmdInTz(dt);
      const set = paidByDay.get(k) || new Set();
      if (r?.staff_id != null) {
        set.add(Number(r.staff_id));
      }
      paidByDay.set(k, set);
    }

    const trendDays = [];
    for (let i = TREND_DAYS - 1; i >= 0; i--) {
      // Step whole days back from Lagos midnight today, then re-read the day in
      // Lagos so the key matches the buckets above exactly.
      const d = new Date(trendTodayStart.getTime() - (i * DAY_MS));
      const k = formatDateYmdInTz(d);
      const funded = fundedByDay.get(k) || new Prisma.Decimal('0.00');
      const paidSet = paidByDay.get(k);
      trendDays.push({
        date: k,
        funded_amount: Number(funded.toFixed(2)),
        staff_paid: paidSet ? paidSet.size : 0,
      });
    }

    const walletBalance = company?.wallet?.balance || new Prisma.Decimal('0.00');
    const lowBalanceEnabled = Boolean(company?.low_balance_alert_enabled);
    const lowBalanceThreshold = company?.low_balance_threshold || null;
    const isLowBalance = Boolean(
      lowBalanceEnabled &&
      lowBalanceThreshold != null &&
      new Prisma.Decimal(walletBalance || '0').lt(new Prisma.Decimal(lowBalanceThreshold || '0'))
    );

    // The soonest date any active staff member is due. Null with no staff, so
    // the app can say "add staff" instead of counting down to nothing.
    let nextPayday = null;
    for (const row of Array.isArray(scheduleRows) ? scheduleRows : []) {
      const due = nextDueAtUtc(row);
      if (!due || Number.isNaN(due.getTime())) continue;
      if (!nextPayday || due.getTime() < nextPayday.getTime()) nextPayday = due;
    }

    const monthlyPayroll = salaryAgg?._sum?.salary_amount || new Prisma.Decimal('0.00');
    const balanceDec = new Prisma.Decimal(walletBalance || '0');
    const shortfall = monthlyPayroll.gt(balanceDec) ? monthlyPayroll.minus(balanceDec) : new Prisma.Decimal('0.00');

    return res.json({
      remark: 'staffpay_dashboard',
      status: 'success',
      message: ['OK'],
      data: {
        company: {
          id: company.id,
          name: revealCompanyFields(company).name,
          low_balance_alert_enabled: lowBalanceEnabled,
          low_balance_threshold: lowBalanceThreshold,
        },
        wallet: company.wallet,
        low_balance_alert: {
          enabled: lowBalanceEnabled,
          threshold: lowBalanceThreshold,
          is_low_balance: isLowBalance,
        },
        access: accessState,
        payroll_coverage: {
          monthly_total: monthlyPayroll,
          wallet_balance: walletBalance,
          shortfall,
          is_sufficient: shortfall.eq(0),
        },
        next_payday: nextPayday,
        staff_count: staffCount,
        income: {
          total: income_total,
          this_month: income_this_month,
          prev_month: income_prev_month,
        },
        expense: {
          total: expense_total,
          this_month: expense_this_month,
          prev_month: expense_prev_month,
        },
        funded_vs_paid: {
          days: trendDays,
        },
      },
    });
  } catch (e) {
    console.error('staffpay getDashboard error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function initiateWalletFunding(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const company_id = Number(req.body?.company_id);
    const amountDec = normalizeAmountToDecimal(req.body?.amount);
    if (!company_id || !amountDec) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['company_id and amount are required'], data: null });
    }

    const company = await getOwnedCompanyOrFail({ userId: user.id, companyId: company_id, res });
    if (!company) return;

    const txRef = `spfund_${user.id}_${company.id}_${Date.now()}`;
    const baseUrl = getBaseUrl(req);
    const redirectUrl = `${baseUrl}${process.env.API_PREFIX || '/api'}/staffpay/wallet/fund/callback`;

    await prisma.staffPayFundingTransaction.create({
      data: {
        company_id: company.id,
        user_id: Number(user.id),
        tx_ref: txRef,
        amount: amountDec,
        currency: 'NGN',
        status: 'pending',
      },
    });

    const userPii = revealUserFields(user);
    const email = String(userPii.email || '').trim() || `user${user.id}@voltpay.local`;

    const { authorization_url, raw } = await initializeTransaction({
      email,
      amountKobo: Math.round(Number(amountDec.toString()) * 100),
      reference: txRef,
      callback_url: redirectUrl,
      metadata: { purpose: 'staffpay_wallet_funding', company_id: company.id, user_id: Number(user.id) },
    });

    await prisma.staffPayFundingTransaction.update({
      where: { tx_ref: txRef },
      data: { raw_payload: raw },
    });

    return res.json({
      remark: 'staffpay_wallet_funding_initiated',
      status: 'success',
      message: ['OK'],
      data: {
        tx_ref: txRef,
        payment_url: authorization_url,
        redirect_url: redirectUrl,
      },
    });
  } catch (e) {
    console.error('staffpay initiateWalletFunding error:', e);
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

// Every query value below is the caller's, so it is escaped before it touches
// HTML. Interpolated raw, this public page reflected script onto the API's own
// origin for anyone who could get a user to open a crafted link.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

async function walletFundingCallback(req, res) {
  try {
    const status = escapeHtml(String(req.query?.status || '').toLowerCase().slice(0, 32));
    const tx_ref = escapeHtml(String(req.query?.tx_ref || '').slice(0, 120));
    const transaction_id = escapeHtml(
      String(req.query?.transaction_id || req.query?.reference || req.query?.trxref || '').slice(0, 120),
    );

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>VoltPay Payment</title>
    <style>body{font-family:system-ui,Segoe UI,Roboto,Arial; padding:24px;} .box{max-width:520px;margin:0 auto;} .muted{color:#666;}</style>
  </head>
  <body>
    <div class="box">
      <h2>Payment ${status || 'completed'}</h2>
      <p class="muted">You can return to the app.</p>
      <p class="muted">tx_ref: ${tx_ref || '-'}<br/>transaction_id: ${transaction_id || '-'}</p>
    </div>
  </body>
</html>`);
  } catch (e) {
    return res.status(200).send('OK');
  }
}

async function verifyWalletFunding(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    // Paystack verifies by our own reference, so transaction_id is optional and
    // only kept so the existing app build keeps working.
    const tx_ref = String(req.body?.tx_ref || req.body?.reference || '').trim();
    if (!tx_ref) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['tx_ref is required'], data: null });
    }

    const funding = await prisma.staffPayFundingTransaction.findUnique({ where: { tx_ref } });
    if (!funding || Number(funding.user_id) !== Number(user.id)) {
      return res.status(404).json({ remark: 'not_found', status: 'error', message: ['Funding transaction not found'], data: null });
    }

    if (funding.status === 'successful' && funding.credited_at) {
      const wallet = await prisma.staffPayWallet.findUnique({ where: { company_id: Number(funding.company_id) } });
      return res.json({ remark: 'staffpay_wallet_funding_verified', status: 'success', message: ['Already verified'], data: { wallet } });
    }

    const { raw, data } = await verifyTransaction(tx_ref);

    const txRefFromProvider = String(data?.reference || '').trim();
    const paymentStatus = String(data?.status || '').toLowerCase();
    const currency = String(data?.currency || 'NGN').toUpperCase();
    // Paystack quotes kobo everywhere; the wallet is in naira.
    const amount = koboToDecimal(data?.amount);

    if (!txRefFromProvider || txRefFromProvider !== tx_ref) {
      return res.status(400).json({ remark: 'invalid_reference', status: 'error', message: ['tx_ref mismatch'], data: null });
    }

    if (paymentStatus !== 'success' || currency !== 'NGN' || !amount) {
      await prisma.staffPayFundingTransaction.update({
        where: { tx_ref },
        data: {
          status: paymentStatus || 'failed',
          provider_tx_id: data?.id != null ? String(data.id) : null,
          raw_payload: raw,
        },
      });
      return res.status(400).json({ remark: 'payment_not_successful', status: 'error', message: ['Payment not successful'], data: null });
    }

    const creditedAt = new Date();

    const result = await prisma.$transaction(
      async tx => {
      const claimed = await tx.staffPayFundingTransaction.updateMany({
        where: {
          tx_ref,
          credited_at: null,
        },
        data: {
          status: 'successful',
          provider_tx_id: data?.id != null ? String(data.id) : null,
          raw_payload: raw,
          credited_at: creditedAt,
          amount: amount,
          currency: 'NGN',
        },
      });

      if (!claimed?.count) {
        const wallet = await tx.staffPayWallet.findUnique({ where: { company_id: Number(funding.company_id) } });
        return { wallet, credited: false };
      }

      const wallet = await upsertBalanceDelta(tx, 'staffPayWallet', funding.company_id, amount);

      return { wallet, credited: true };
      },
      {
        timeout: 15000,
      },
    );

    await logStaffPayEvent({
      userId: user.id,
      event: 'staffpay_wallet_funded',
      metadata: { company_id: funding.company_id, tx_ref, amount: Number(amount.toString()) },
    });

    return res.json({ remark: 'staffpay_wallet_funding_verified', status: 'success', message: ['OK'], data: result });
  } catch (e) {
    console.error('staffpay verifyWalletFunding error:', e);
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

/**
 * Paystack Dedicated Virtual Account.
 *
 * Unlike the old provider there is no dynamic/static distinction and no expiry:
 * a DVA is created once per company against a Paystack customer and lives until
 * it is deactivated. So this is idempotent - once the company has an account
 * number it is handed back, never re-created.
 */
async function getWalletVirtualAccount(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const company_id = Number(req.query?.company_id || req.body?.company_id);
    if (!company_id) return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['company_id is required'], data: null });

    const company = await getOwnedCompanyOrFail({ userId: user.id, companyId: company_id, res });
    if (!company) return;

    // Opened once for this request: the DVA is created against the business's
    // own name, email and phone, none of which are stored readable.
    const companyPii = revealCompanyFields(company);

    if (company.virtual_account_number && company.virtual_account_bank_name) {
      return res.json({
        remark: 'staffpay_virtual_account',
        status: 'success',
        message: ['OK'],
        data: {
          virtual_account: {
            account_number: company.virtual_account_number,
            bank_name: company.virtual_account_bank_name,
            account_name: companyPii.name,
            type: 'dedicated',
          },
        },
      });
    }

    const userPii = revealUserFields(user);
    const email = String(companyPii.email || userPii.email || '').trim() || `user${user.id}@voltpay.local`;
    const phone = String(companyPii.phone || userPii.mobile || '').trim() || undefined;

    try {
      let customerCode = String(company.paystack_customer_code || '').trim();
      if (!customerCode) {
        ({ customer_code: customerCode } = await createCustomer({
          email,
          first_name: String(userPii.firstname || '').trim() || companyPii.name,
          last_name: String(userPii.lastname || '').trim() || 'StaffPay',
          phone,
        }));
      }

      const dva = await createDedicatedAccount({ customer_code: customerCode, phone });

      await prisma.staffPayCompany.update({
        where: { id: company.id },
        data: {
          paystack_customer_code: customerCode,
          paystack_dva_id: dva.dedicated_account_id,
          virtual_account_number: dva.account_number,
          virtual_account_bank_name: dva.bank_name,
          virtual_account_expires_at: null,
        },
      });

      await logStaffPayEvent({
        userId: user.id,
        event: 'staffpay_virtual_account_created',
        metadata: { company_id: company.id },
      });

      return res.json({
        remark: 'staffpay_virtual_account',
        status: 'success',
        message: ['OK'],
        data: {
          virtual_account: {
            account_number: dva.account_number,
            bank_name: dva.bank_name,
            account_name: companyPii.name,
            type: 'dedicated',
          },
        },
      });
    } catch (e) {
      console.error('staffpay dedicated account create failed:', e?.message || e);
      const status = Number(e?.statusCode) || 400;
      return res.status(status).json({
        remark: 'provider_error',
        status: 'error',
        message: [e?.message || 'Could not create a dedicated account'],
        data: null,
      });
    }
  } catch (e) {
    console.error('staffpay getWalletVirtualAccount error:', e);
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}


/**
 * Paystack webhook for everything StaffPay: wallet funding (charge.success,
 * whether from checkout or a transfer into the dedicated account) and payroll
 * outcomes (transfer.success / transfer.failed / transfer.reversed).
 *
 * Always answers 200 once the signature checks out. Paystack retries on any
 * other status, and a retry storm over a row we have already credited is worse
 * than a dropped event the reconciler will pick up anyway.
 */
async function walletWebhook(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';
    const signature = req.headers['x-paystack-signature'];
    if (!verifyWebhookSignature({ rawBody, signature })) {
      console.error('staffpay walletWebhook unauthorized: bad signature');
      return res.status(401).send('Unauthorized');
    }

    const payload = req.body || {};
    const event = String(payload?.event || '').trim();
    const data = payload?.data || {};

    if (event.startsWith('transfer.')) {
      try {
        // Paystack takes one webhook URL per integration, so this one also
        // carries Airtime to Cash payouts. Each handler claims only its own
        // reference prefix and answers false for the other's.
        const handled = await handleTransferEvent({ event, data });
        if (!handled) await handleAirtimeCashTransferEvent({ event, data });
      } catch (e) {
        console.error('staffpay walletWebhook transfer error:', e?.message || e);
      }
      return res.status(200).json({ received: true });
    }

    if (event !== 'charge.success') {
      return res.status(200).json({ received: true });
    }

    // CAC Registration checkouts share this URL - Paystack takes one per
    // integration. Routed BEFORE anything below, and that order is load-bearing:
    // the dedicated-account fallback matches a company by Paystack customer
    // code, and Paystack reuses one customer per email, so a StaffPay owner's
    // CAC payment would otherwise be credited to their company wallet.
    // settlePaystack re-reads the outcome from Paystack and is idempotent.
    if (String(data?.reference || '').trim().startsWith('CACPAY-')) {
      try {
        await settleCacPayment(String(data.reference).trim(), { source: 'webhook' });
      } catch (e) {
        // Paystack unreachable for the re-read: the sweep settles it.
        console.error('staffpay walletWebhook cac settle error:', e?.message || e);
      }
      return res.status(200).json({ received: true });
    }

    const currency = String(data?.currency || '').toUpperCase();
    const reference = String(data?.reference || '').trim();
    const providerTxId = data?.id != null ? String(data.id) : '';
    const amount = koboToDecimal(data?.amount);

    if (currency !== 'NGN' || !providerTxId || !amount) {
      return res.status(200).json({ received: true });
    }

    // Subscription charges ride the same webhook URL only if misconfigured;
    // they have their own endpoint and must not be credited as wallet funding.
    if (reference.startsWith('SPSUB-')) {
      return res.status(200).json({ received: true });
    }

    // 1. Checkout funding: we minted the reference, so the row already exists.
    if (reference) {
      const funding = await prisma.staffPayFundingTransaction.findUnique({ where: { tx_ref: reference } });
      if (funding) {
        try {
          await withDirectFallback(db => db.$transaction(async tx => {
            const claimed = await tx.staffPayFundingTransaction.updateMany({
              where: { tx_ref: reference, credited_at: null },
              data: {
                status: 'successful',
                provider_tx_id: providerTxId,
                raw_payload: payload,
                credited_at: new Date(),
                amount,
                currency: 'NGN',
              },
            });

            if (claimed?.count) {
              await upsertBalanceDelta(tx, 'staffPayWallet', funding.company_id, amount);
            }
          }, { timeout: 15000 }));
        } catch (e) {
          if (e?.code !== 'P2002') console.error('staffpay walletWebhook funding credit error:', e);
        }

        return res.status(200).json({ received: true });
      }
    }

    // 2. Dedicated account funding: Paystack picked the reference, so the payer
    // is identified by the customer the DVA belongs to, or by the account the
    // money landed in.
    const customerCode = String(data?.customer?.customer_code || '').trim();
    const receiverAccount = String(
      data?.metadata?.receiver_account_number ||
      data?.authorization?.receiver_bank_account_number ||
      ''
    ).replace(/\D/g, '');

    let company = null;
    if (customerCode) {
      company = await prisma.staffPayCompany.findFirst({ where: { paystack_customer_code: customerCode } });
    }
    if (!company && receiverAccount) {
      company = await prisma.staffPayCompany.findFirst({ where: { virtual_account_number: receiverAccount } });
    }

    if (!company) {
      console.warn('staffpay walletWebhook: no company for charge', { provider_tx_id: providerTxId });
      return res.status(200).json({ received: true });
    }

    const internalTxRef = `spva_${company.id}_${providerTxId}`;

    try {
      await withDirectFallback(db => db.$transaction(async tx => {
        await tx.staffPayFundingTransaction.create({
          data: {
            company_id: Number(company.id),
            user_id: Number(company.owner_user_id),
            tx_ref: internalTxRef,
            provider_tx_id: providerTxId,
            amount,
            currency: 'NGN',
            status: 'successful',
            raw_payload: payload,
            credited_at: new Date(),
          },
        });

        await upsertBalanceDelta(tx, 'staffPayWallet', company.id, amount);
      }, { timeout: 15000 }));
    } catch (e) {
      // P2002 = this transaction was already credited. Nothing to do.
      if (e?.code !== 'P2002') console.error('staffpay walletWebhook credit error:', e);
    }

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('staffpay walletWebhook error:', e);
    return res.status(200).json({ received: true });
  }
}


/**
 * Pay All Staff. The money logic lives in services/staffpayPayroll.service.js
 * so the scheduler runs exactly the same path; this only does ownership, the
 * in-flight guard and the response.
 */
async function createPayrollRun(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const company_id = Number(req.body?.company_id);
    if (!company_id) return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['company_id is required'], data: null });

    const company = await getOwnedCompanyOrFail({ userId: user.id, companyId: company_id, res });
    if (!company) return;

    const inflight = await prisma.staffPayPayrollRun.findFirst({
      where: {
        company_id: company.id,
        status: { in: ['preparing', 'queued', 'processing'] },
        created_at: { gt: new Date(Date.now() - 2 * 60 * 1000) },
      },
      orderBy: { id: 'desc' },
    });
    if (inflight) {
      return res.status(409).json({
        remark: 'staffpay_payroll_in_progress',
        status: 'error',
        message: ['A payroll payout is already in progress. Please wait for it to complete before starting another one.'],
        data: { payroll_run_id: inflight.id },
      });
    }

    const staffIds = Array.isArray(req.body?.staff_ids) ? req.body.staff_ids.map(Number).filter(Boolean) : [];
    const title = String(req.body?.title || '').trim() || `Staff salary payout (${new Date().toISOString().slice(0, 10)})`;

    let run;
    try {
      run = await createPayrollRunForCompany({ company, staffIds, title, actorUserId: user.id });
    } catch (e) {
      const status = Number(e?.statusCode) || 500;
      return res.status(status).json({
        remark: e?.remark || 'error',
        status: 'error',
        message: [e?.message || 'Failed'],
        data: e?.remark === 'insufficient_balance' ? await payrollCoverage(company.id) : null,
      });
    }

    await maybeWarnLowBalance({ company, userId: user.id });

    const failed = (run?.items || []).filter(i => String(i.status).toUpperCase() === 'FAILED').length;

    return res.json({
      remark: 'staffpay_payroll_run_created',
      status: 'success',
      message: failed ? [`${failed} transfer(s) failed and were refunded. Use Retry Failed Transfers.`] : ['Payroll sent'],
      data: { payroll_run: publicPayrollRun(run), failed_count: failed },
    });
  } catch (e) {
    console.error('staffpay createPayrollRun error:', e);
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

/**
 * Run payroll now: pay exactly the staff whose payday has arrived, on the same
 * cycle keys the scheduler uses.
 *
 * The difference from Pay All Staff above is what makes this the safe button.
 * Pay All Staff pays every active staff member, on purpose, and pressing it an
 * hour after automatic payroll ran pays everybody twice. This one pays only
 * what is owed for the current cycle, and every item it writes carries the
 * cycle key - so if the scheduler already paid somebody today, the database
 * refuses the second item and the wallet is never debited for it.
 *
 * One batch per press. A company with more staff than STAFFPAY_PAYROLL_BATCH_SIZE
 * gets the rest from the scheduler, or from a second press - both are safe.
 */
async function runDuePayrollNow(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const company_id = Number(req.body?.company_id);
    if (!company_id) return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['company_id is required'], data: null });

    const company = await getOwnedCompanyOrFail({ userId: user.id, companyId: company_id, res });
    if (!company) return;

    const inflight = await prisma.staffPayPayrollRun.findFirst({
      where: { company_id: company.id, status: { in: ['preparing', 'queued', 'processing'] } },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    if (inflight) {
      return res.status(409).json({
        remark: 'staffpay_payroll_in_progress',
        status: 'error',
        message: ['A payroll payout is already in progress. Please wait for it to complete before starting another one.'],
        data: { payroll_run_id: inflight.id },
      });
    }

    const due = await listDueStaff({ companyId: company.id });
    if (!due.length) {
      return res.json({
        remark: 'staffpay_no_staff_due',
        status: 'success',
        message: ['No staff are due for payment right now.'],
        data: { due_count: 0, payroll_run: null },
      });
    }

    const batchSize = Math.max(1, Number(process.env.STAFFPAY_PAYROLL_BATCH_SIZE) || 200);
    const batch = due.slice(0, batchSize);

    let run;
    try {
      run = await createPayrollRunForCompany({
        company,
        staffIds: batch.map(d => d.id),
        cycleKeys: new Map(batch.map(d => [d.id, d.cycle_key])),
        title: String(req.body?.title || '').trim() || `Staff salary payout (${new Date().toISOString().slice(0, 10)})`,
        actorUserId: user.id,
        mode: 'manual',
      });
    } catch (e) {
      const status = Number(e?.statusCode) || 500;
      return res.status(status).json({
        remark: e?.remark || 'error',
        status: 'error',
        message: [e?.message || 'Failed'],
        data: e?.remark === 'insufficient_balance' ? await payrollCoverage(company.id) : null,
      });
    }

    await maybeWarnLowBalance({ company, userId: user.id });

    const failed = (run?.items || []).filter(i => String(i.status).toUpperCase() === 'FAILED').length;
    const remaining = due.length - batch.length;

    return res.json({
      remark: 'staffpay_payroll_run_created',
      status: 'success',
      message: [
        failed ? `${failed} transfer(s) failed and were refunded. Use Retry Failed Transfers.` : 'Payroll sent',
        ...(remaining ? [`${remaining} more staff are due and will be paid in the next batch.`] : []),
      ],
      data: {
        payroll_run: publicPayrollRun(run),
        failed_count: failed,
        due_count: due.length,
        paid_in_this_run: batch.length,
        remaining_due: remaining,
      },
    });
  } catch (e) {
    console.error('staffpay runDuePayrollNow error:', e);
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

/** Re-send only the failed items of a run. */
async function retryPayrollRun(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const runId = Number(req.params?.runId);
    if (!runId) return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid runId'], data: null });

    const existing = await prisma.staffPayPayrollRun.findUnique({ where: { id: runId }, include: { company: true } });
    if (!existing || Number(existing.company?.owner_user_id) !== Number(user.id)) {
      return res.status(404).json({ remark: 'not_found', status: 'error', message: ['Payroll run not found'], data: null });
    }

    let run;
    try {
      run = await retryFailedItems({ runId, actorUserId: user.id });
    } catch (e) {
      const status = Number(e?.statusCode) || 500;
      return res.status(status).json({
        remark: e?.remark || 'error',
        status: 'error',
        message: [e?.message || 'Failed'],
        data: e?.remark === 'insufficient_balance' ? await payrollCoverage(existing.company_id) : null,
      });
    }

    const stillFailed = (run?.items || []).filter(i => String(i.status).toUpperCase() === 'FAILED').length;

    return res.json({
      remark: 'staffpay_payroll_retried',
      status: 'success',
      message: stillFailed ? [`${stillFailed} transfer(s) failed again.`] : ['Retry sent'],
      data: { payroll_run: publicPayrollRun(run), failed_count: stillFailed },
    });
  } catch (e) {
    console.error('staffpay retryPayrollRun error:', e);
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

/** Dashboard alert + email + push when the wallet drops under the threshold. */
async function maybeWarnLowBalance({ company, userId }) {
  try {
    const settings = await prisma.staffPayCompany.findUnique({ where: { id: company.id } });
    if (settings?.low_balance_alert_enabled === false) return;

    const wallet = await prisma.staffPayWallet.findUnique({ where: { company_id: company.id } });
    const threshold = settings?.low_balance_threshold;
    if (!wallet || !threshold) return;
    if (!new Prisma.Decimal(wallet.balance || '0').lt(threshold)) return;

    await notifyUser({
      userId: Number(userId || company.owner_user_id),
      subject: 'Low StaffPay wallet balance',
      message: `Your StaffPay wallet for ${revealCompanyFields(company).name} is below ₦${new Prisma.Decimal(threshold).toFixed(2)}. Fund it before the next payday.`,
      type: 'staffpay',
      data: { company_id: company.id },
    });

    await logStaffPayEvent({
      userId: Number(userId || company.owner_user_id),
      event: 'staffpay_low_balance_alert',
      metadata: { company_id: company.id, balance: Number(new Prisma.Decimal(wallet.balance || '0').toString()) },
    });
  } catch (e) {
    console.error('staffpay low balance alert failed:', e?.message || e);
  }
}


async function listPayrollRuns(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const company_id = Number(req.query?.company_id);
    if (!company_id) return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['company_id is required'], data: null });

    const company = await getOwnedCompanyOrFail({ userId: user.id, companyId: company_id, res });
    if (!company) return;

    const runs = await prisma.staffPayPayrollRun.findMany({
      where: { company_id: company.id },
      orderBy: { id: 'desc' },
      include: { _count: { select: { items: true } } },
    });

    return res.json({ remark: 'staffpay_payroll_run_list', status: 'success', message: ['OK'], data: { runs } });
  } catch (e) {
    console.error('staffpay listPayrollRuns error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function getPayrollRun(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const runId = Number(req.params?.runId);
    if (!runId) return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid runId'], data: null });

    const run = await prisma.staffPayPayrollRun.findUnique({
      where: { id: runId },
      include: { company: true, items: { include: { staff: true } } },
    });

    if (!run || Number(run.company?.owner_user_id) !== Number(user.id)) {
      return res.status(404).json({ remark: 'not_found', status: 'error', message: ['Payroll run not found'], data: null });
    }

    return res.json({ remark: 'staffpay_payroll_run', status: 'success', message: ['OK'], data: { payroll_run: publicPayrollRun(run) } });
  } catch (e) {
    console.error('staffpay getPayrollRun error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

/** Poll Paystack for a run's transfers. The webhook normally gets there first. */
async function syncPayrollRun(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const runId = Number(req.params?.runId);
    if (!runId) return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid runId'], data: null });

    const run = await prisma.staffPayPayrollRun.findUnique({ where: { id: runId }, include: { company: true } });
    if (!run || Number(run.company?.owner_user_id) !== Number(user.id)) {
      return res.status(404).json({ remark: 'not_found', status: 'error', message: ['Payroll run not found'], data: null });
    }

    await syncPayrollRunById(runId);

    const finalRun = await prisma.staffPayPayrollRun.findUnique({
      where: { id: runId },
      include: { items: { include: { staff: true } } },
    });

    await logStaffPayEvent({
      userId: user.id,
      event: 'staffpay_payroll_run_synced',
      metadata: { company_id: run.company_id, payroll_run_id: run.id, status: finalRun?.status },
    });

    return res.json({
      remark: 'staffpay_payroll_run_synced',
      status: 'success',
      message: ['OK'],
      data: {
        payroll_run: publicPayrollRun(finalRun),
        failed_count: (finalRun?.items || []).filter(i => String(i.status).toUpperCase() === 'FAILED').length,
      },
    });
  } catch (e) {
    console.error('staffpay syncPayrollRun error:', e);
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}


module.exports = {
  banks,
  resolveBankAccount,

  createCompany,
  listCompanies,
  getCompany,
  updateCompany,
  deleteCompany,

  createStaff,
  listStaff,
  updateStaff,
  deleteStaff,

  getDashboard,
  listFundingHistory,
  listPayoutHistory,
  exportPayoutHistory,
  getWallet,
  getWalletVirtualAccount,
  initiateWalletFunding,
  verifyWalletFunding,
  walletFundingCallback,
  walletWebhook,
  reconcileWalletFunding,
  autoReconcileWalletFunding,

  // Exported for test/staffpayPayroll.test.js - the WAT month boundary and CSV
  // quoting are the only parts of the history endpoints worth pinning down.
  monthYearRange,
  csvCell,

  createPayrollRun,
  runDuePayrollNow,
  retryPayrollRun,
  listPayrollRuns,
  getPayrollRun,
  syncPayrollRun,
};
