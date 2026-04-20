const prisma = require('../../database/prisma');
const { Prisma } = require('@prisma/client');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const {
  listBanksCached,
  listBankBranches,
  resolveAccount,
  createPaymentLink,
  createVirtualAccountNumber,
  verifyTransaction,
  listTransactions,
  createBulkTransfer,
  getBulkTransfer,
  getTransferFee,
} = require('../funding/flutterwave.service');

const { encryptString, decryptString } = require('../helpers/encryption.helper');
const { logStaffPayEvent } = require('../services/staffpayAudit.service');

function normalizeAmountToDecimal(amount) {
  const cleaned = String(amount ?? '').replace(/,/g, '').trim();
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Prisma.Decimal(n.toFixed(2));
}

function formatDateYmd(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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

async function autoReconcileWalletFunding(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const company_id = Number(req.body?.company_id || req.query?.company_id);
    const lookbackDays = Math.max(1, Math.min(30, Number(req.body?.lookback_days || process.env.STAFFPAY_RECONCILE_LOOKBACK_DAYS || 14)));

    let company;
    if (company_id) {
      company = await getOwnedCompanyOrFail({ userId: user.id, companyId: company_id, res });
      if (!company) return;
    } else {
      const companies = await withDirectFallback(db => db.staffPayCompany.findMany({
        where: { owner_user_id: Number(user.id) },
        include: { wallet: true },
        orderBy: { id: 'asc' },
      }));

      if (!companies || !Array.isArray(companies) || !companies.length) {
        return res.status(404).json({ remark: 'not_found', status: 'error', message: ['Company not found'], data: null });
      }

      let selected = companies[0];
      let best = new Prisma.Decimal(selected?.wallet?.balance || '0');
      for (const c of companies) {
        const bal = new Prisma.Decimal(c?.wallet?.balance || '0');
        if (bal.gt(best)) {
          best = bal;
          selected = c;
        }
      }
      company = selected;
    }

    const vaTxRef = String(company.virtual_account_tx_ref || '').trim();
    const vaNumber = String(company.virtual_account_number || '').replace(/\D/g, '');
    if (!vaTxRef && !vaNumber) {
      const wallet = await withDirectFallback(db => db.staffPayWallet.findUnique({ where: { company_id: Number(company.id) } }));
      return res.json({ remark: 'staffpay_wallet_auto_reconcile', status: 'success', message: ['No virtual account configured'], data: { wallet, credited_count: 0 } });
    }

    const now = new Date();
    const fromDate = new Date(Date.now() - (lookbackDays * 24 * 60 * 60 * 1000));
    const from = formatDateYmd(fromDate);
    const to = formatDateYmd(now);

    const maxPages = Math.max(1, Math.min(10, Number(process.env.STAFFPAY_RECONCILE_MAX_PAGES || 5)));
    const maxVerify = Math.max(5, Math.min(200, Number(process.env.STAFFPAY_RECONCILE_MAX_VERIFY || 30)));

    let txList = [];
    try {
      if (vaTxRef) {
        const { data } = await listTransactions({ status: 'successful', tx_ref: vaTxRef, from, to, page: 1 });
        txList = Array.isArray(data) ? data : [];
      }
    } catch (_) {
      txList = [];
    }

    if (!txList.length) {
      const collected = [];
      for (let page = 1; page <= maxPages; page++) {
        try {
          const { data } = await listTransactions({ status: 'successful', from, to, page });
          const pageRows = Array.isArray(data) ? data : [];
          if (!pageRows.length) break;
          collected.push(...pageRows);
        } catch (_) {
          break;
        }
      }
      txList = collected;
    }

    const credited = [];
    const candidates = Array.isArray(txList) ? txList : [];

    for (const t of candidates.slice(0, maxVerify)) {
      const tid = t?.id != null ? String(t.id).trim() : '';
      if (!tid) continue;

      const summaryTxRef = String(t?.tx_ref || t?.txRef || t?.reference || '').trim();
      if (vaTxRef && summaryTxRef && summaryTxRef !== vaTxRef) {
        continue;
      }

      const existing = await withDirectFallback(db => db.staffPayFundingTransaction.findFirst({ where: { flutterwave_tx_id: tid } }));
      if (existing) continue;

      let verified;
      try {
        verified = await verifyTransaction(tid);
      } catch {
        continue;
      }

      const data = verified?.data || {};
      const status = String(data?.status || '').toLowerCase();
      const currency = String(data?.currency || '').toUpperCase();
      const paymentType = String(data?.payment_type || '').toLowerCase();
      const txRef = String(data?.tx_ref || data?.txRef || data?.reference || '').trim();
      const flwRef = String(data?.flw_ref || data?.flwRef || '').trim();
      const orderRef = String(data?.order_ref || data?.orderRef || '').trim();
      const amount = toDecimalOrNull(data?.amount) || toDecimalOrNull(data?.charged_amount);
      const acct = String(data?.account_number || data?.account || '').replace(/\D/g, '');

      const isBankTransfer = paymentType === 'bank_transfer' || paymentType === 'account' || paymentType === 'banktransfer';
      if (status !== 'successful' || currency !== 'NGN' || !isBankTransfer || !amount) continue;

      const matchesCompany =
        (vaTxRef && txRef && txRef === vaTxRef) ||
        (flwRef && company.virtual_account_flw_ref && flwRef === String(company.virtual_account_flw_ref)) ||
        (orderRef && company.virtual_account_order_ref && orderRef === String(company.virtual_account_order_ref)) ||
        (vaNumber && acct && acct === vaNumber);

      if (!matchesCompany) continue;

      const internalTxRef = `spva_${company.id}_${tid}`;
      const creditedAt = new Date();

      try {
        await withDirectFallback(db => db.$transaction(async tx => {
          await tx.staffPayFundingTransaction.create({
            data: {
              company_id: Number(company.id),
              user_id: Number(company.owner_user_id),
              tx_ref: internalTxRef,
              flutterwave_tx_id: tid,
              amount,
              currency: 'NGN',
              status: 'successful',
              raw_payload: verified?.raw || t,
              credited_at: creditedAt,
            },
          });

          await tx.staffPayWallet.upsert({
            where: { company_id: Number(company.id) },
            update: { balance: { increment: amount } },
            create: { company_id: Number(company.id), balance: amount },
          });
        }, { timeout: 15000 }));

        credited.push(tid);
      } catch (e) {
        if (e?.code !== 'P2002') {
          console.error('staffpay autoReconcileWalletFunding credit error:', e);
        }
      }
    }

    const wallet = await withDirectFallback(db => db.staffPayWallet.findUnique({ where: { company_id: Number(company.id) } }));
    return res.json({
      remark: 'staffpay_wallet_auto_reconcile',
      status: 'success',
      message: ['OK'],
      data: { wallet, credited_count: credited.length },
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
          flutterwave_tx_id: true,
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
          flutterwave_tx_id: r.flutterwave_tx_id ? String(r.flutterwave_tx_id) : null,
        },
        details: company.name,
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

      const staffName = String(r.staff?.full_name || '').trim() || 'Staff';
      const bankName = String(r.staff?.bank_name || '').trim();
      const acctLast4 = String(r.staff?.account_number_last4 || '').trim();
      const subtitle = `${bankName || 'Bank'}${acctLast4 ? ` • ****${acctLast4}` : ''}`;

      const amount = r.amount != null ? r.amount.toString() : '0';
      const flwFee = r.flutterwave_fee != null ? r.flutterwave_fee.toString() : '0';
      const vpFee = r.voltpay_fee != null ? r.voltpay_fee.toString() : '0';
      const vatFee = r.vat != null ? r.vat.toString() : '0';

      const feeTotal = (() => {
        try {
          return new Prisma.Decimal(flwFee).plus(new Prisma.Decimal(vpFee)).plus(new Prisma.Decimal(vatFee)).toFixed(2);
        } catch {
          return flwFee;
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
          flutterwave_transfer_id: r.flutterwave_transfer_id != null ? Number(r.flutterwave_transfer_id) : null,
          status: st,
          fee_breakdown: {
            flutterwave_fee: flwFee,
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

async function reconcileWalletFunding(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const company_id = Number(req.body?.company_id);
    const transaction_id = String(req.body?.transaction_id || req.body?.id || '').trim();
    if (!company_id || !transaction_id) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['company_id and transaction_id are required'], data: null });
    }

    const company = await getOwnedCompanyOrFail({ userId: user.id, companyId: company_id, res });
    if (!company) return;

    const { raw, data } = await verifyTransaction(transaction_id);

    const status = String(data?.status || '').toLowerCase();
    const currency = String(data?.currency || '').toUpperCase();
    const paymentType = String(data?.payment_type || '').toLowerCase();
    const txRef = String(data?.tx_ref || data?.txRef || data?.reference || '').trim();
    const flwRef = String(data?.flw_ref || data?.flwRef || '').trim();
    const orderRef = String(data?.order_ref || data?.orderRef || '').trim();
    const flwTxId = data?.id != null ? String(data.id).trim() : transaction_id;
    const amount = toDecimalOrNull(data?.amount) || toDecimalOrNull(data?.charged_amount);

    if (status !== 'successful' || currency !== 'NGN' || !amount) {
      return res.status(400).json({ remark: 'payment_not_successful', status: 'error', message: ['Payment not successful'], data: null });
    }

    const isBankTransfer = paymentType === 'bank_transfer' || paymentType === 'account' || paymentType === 'banktransfer';
    if (!isBankTransfer) {
      return res.status(400).json({ remark: 'invalid_payment_type', status: 'error', message: ['Payment type is not bank transfer'], data: null });
    }

    const acct = String(data?.account_number || data?.account || '').replace(/\D/g, '');

    const matchesCompany =
      (txRef && company.virtual_account_tx_ref && txRef === company.virtual_account_tx_ref) ||
      (flwRef && company.virtual_account_flw_ref && flwRef === company.virtual_account_flw_ref) ||
      (orderRef && company.virtual_account_order_ref && orderRef === company.virtual_account_order_ref) ||
      (acct && company.virtual_account_number && acct === String(company.virtual_account_number).replace(/\D/g, ''));

    if (!matchesCompany) {
      return res.status(400).json({
        remark: 'mismatch',
        status: 'error',
        message: ['This transaction does not match the StaffPay virtual account for this company'],
        data: { tx_ref: txRef || null, flw_ref: flwRef || null, order_ref: orderRef || null, account_number: acct || null },
      });
    }

    const internalTxRef = `spva_${company.id}_${flwTxId}`;
    const creditedAt = new Date();

    try {
      await withDirectFallback(db => db.$transaction(async tx => {
        await tx.staffPayFundingTransaction.create({
          data: {
            company_id: Number(company.id),
            user_id: Number(company.owner_user_id),
            tx_ref: internalTxRef,
            flutterwave_tx_id: flwTxId,
            amount,
            currency: 'NGN',
            status: 'successful',
            raw_payload: raw,
            credited_at: creditedAt,
          },
        });

        await tx.staffPayWallet.upsert({
          where: { company_id: Number(company.id) },
          update: { balance: { increment: amount } },
          create: { company_id: Number(company.id), balance: amount },
        });
      }, { timeout: 15000 }));
    } catch (e) {
      if (e?.code !== 'P2002') {
        console.error('staffpay reconcileWalletFunding credit error:', e);
        const statusCode = Number(e?.statusCode) || 500;
        return res.status(statusCode).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
      }
    }

    const wallet = await withDirectFallback(db => db.staffPayWallet.findUnique({ where: { company_id: Number(company.id) } }));
    return res.json({ remark: 'staffpay_wallet_reconciled', status: 'success', message: ['OK'], data: { wallet } });
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

function getFlutterwaveSecretHash() {
  const v = String(process.env.FLUTTERWAVE_SECRET_HASH || process.env.FLUTTERWAVE_WEBHOOK_HASH || process.env.FLW_SECRET_HASH || '').trim();
  return v || null;
}

function isValidFlutterwaveWebhook({ rawBody, headers }) {
  if (!rawBody) return false;
  const secretHash = getFlutterwaveSecretHash();
  if (!secretHash) return false;

  const verifHash = String(headers?.['verif-hash'] || headers?.['Verif-Hash'] || '').trim();
  if (verifHash) {
    return verifHash === secretHash;
  }

  const sig = String(headers?.['flutterwave-signature'] || headers?.['Flutterwave-Signature'] || headers?.['x-flutterwave-signature'] || '').trim();
  if (!sig) return false;

  const computedBase64 = crypto.createHmac('sha256', secretHash).update(rawBody).digest('base64');
  if (computedBase64 === sig) return true;

  const computedHex = crypto.createHmac('sha256', secretHash).update(rawBody).digest('hex');
  return computedHex === sig;
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

    const country = String(req.query?.country || 'NG').trim().toUpperCase() || 'NG';
    const rows = await listBanksCached({ country });

    const banks = (rows || []).map(b => ({
      id: b?.id ?? null,
      name: b?.name ?? b?.bank_name ?? b?.bankName ?? '',
      code: String(b?.code ?? b?.bank_code ?? b?.bankCode ?? '').trim(),
    }));

    return res.json({ remark: 'staffpay_bank_list', status: 'success', message: ['OK'], data: { banks } });
  } catch (e) {
    console.error('staffpay banks error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function bankBranches(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const bankId = String(req.params?.bankId || '').trim();
    if (!bankId) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['bankId is required'], data: null });
    }

    const rows = await listBankBranches({ bank_id: bankId });
    const branches = (rows || []).map(b => ({
      id: b?.id ?? null,
      branch_code: String(b?.branch_code ?? b?.branchCode ?? b?.code ?? '').trim(),
      branch_name: b?.branch_name ?? b?.branchName ?? b?.name ?? '',
    }));

    return res.json({ remark: 'staffpay_bank_branch_list', status: 'success', message: ['OK'], data: { branches } });
  } catch (e) {
    console.error('staffpay bankBranches error:', e);
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
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

    const { data } = await resolveAccount({ account_number, account_bank: bank_code });

    return res.json({
      remark: 'staffpay_account_resolved',
      status: 'success',
      message: ['OK'],
      data: {
        account_number,
        bank_code,
        account_name: data?.account_name || data?.accountName || null,
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
        name,
        address,
        cac_number,
        phone,
        email,
        auto_pay_enabled: true,
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

    return res.json({ remark: 'staffpay_company_created', status: 'success', message: ['Company created'], data: { company: created } });
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
          ...c,
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

    return res.json({ remark: 'staffpay_company', status: 'success', message: ['OK'], data: { company } });
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
    let auto_pay_enabled = undefined;
    if (req.body?.auto_pay_enabled != null) {
      const v = req.body.auto_pay_enabled;
      let parsed = null;
      if (typeof v === 'boolean') parsed = v;
      else if (typeof v === 'number') parsed = v === 1;
      else {
        const s = String(v).trim().toLowerCase();
        if (s === 'true' || s === '1' || s === 'yes') parsed = true;
        else if (s === 'false' || s === '0' || s === 'no') parsed = false;
      }
      if (parsed == null) {
        return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid auto_pay_enabled'], data: null });
      }
      auto_pay_enabled = parsed;
    }

    let payout_time = undefined;
    if (req.body?.payout_time != null) {
      const t = String(req.body.payout_time).trim();
      if (t && !/^\d{2}:\d{2}$/.test(t)) {
        return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid payout_time (expected HH:mm)'], data: null });
      }
      if (t) {
        const [hhRaw, mmRaw] = t.split(':');
        const hh = Number(hhRaw);
        const mm = Number(mmRaw);
        if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
          return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid payout_time'], data: null });
        }
      }
      payout_time = t || null;
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
        ...(name !== undefined ? { name } : {}),
        ...(address !== undefined ? { address } : {}),
        ...(cac_number !== undefined ? { cac_number } : {}),
        ...(phone !== undefined ? { phone } : {}),
        ...(email !== undefined ? { email } : {}),
        ...(auto_pay_enabled !== undefined ? { auto_pay_enabled } : {}),
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

    return res.json({ remark: 'staffpay_company_updated', status: 'success', message: ['Company updated'], data: { company: updated } });
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

    const looksHashed = storedPassword.startsWith('$2a$') || storedPassword.startsWith('$2b$') || storedPassword.startsWith('$2y$');
    const valid = looksHashed ? (await bcrypt.compare(passwordInput, storedPassword)) : storedPassword === passwordInput;
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
      metadata: { company_id: company.id, company_name: company.name },
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
    const phone = String(req.body?.phone || '').trim();
    const bank_code = String(req.body?.bank_code || '').trim();
    const bank_name = req.body?.bank_name != null ? String(req.body.bank_name).trim() : null;
    const bank_branch_code = req.body?.bank_branch_code != null ? String(req.body.bank_branch_code).trim() : null;
    const bank_branch_name = req.body?.bank_branch_name != null ? String(req.body.bank_branch_name).trim() : null;
    const account_number = String(req.body?.account_number || '').trim();
    const account_name_input = req.body?.account_name != null ? String(req.body.account_name).trim() : null;
    const salary_amount = normalizeAmountToDecimal(req.body?.salary_amount);
    const frequency = String(req.body?.frequency || '').trim();
    const payment_day = req.body?.payment_day != null ? Number(req.body.payment_day) : null;
    const start_date_raw = req.body?.start_date;

    if (!full_name || !bank_code || !account_number || !salary_amount || !frequency) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: ['full_name, bank_code, account_number, salary_amount, frequency are required'],
        data: null,
      });
    }

    let start_date = new Date();
    if (start_date_raw != null && String(start_date_raw).trim() !== '') {
      const parsedStart = new Date(start_date_raw);
      if (Number.isNaN(parsedStart.getTime())) {
        return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid start_date'], data: null });
      }
      start_date = parsedStart;
    }

    const shouldResolve = req.body?.resolve === false ? false : true;
    let account_name = null;
    if (shouldResolve) {
      try {
        const { data } = await resolveAccount({ account_number, account_bank: bank_code });
        account_name = data?.account_name || data?.accountName || null;
      } catch (_) {
        account_name = null;
      }
      if (!account_name && account_name_input) {
        account_name = account_name_input;
      }
    } else if (account_name_input) {
      account_name = account_name_input;
    }

    const last4 = safeLast4(account_number);
    if (!last4) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid account_number'], data: null });
    }

    const created = await prisma.staffPayStaff.create({
      data: {
        company_id: company.id,
        full_name,
        phone,
        bank_code,
        bank_name,
        bank_branch_code,
        bank_branch_name,
        account_number_enc: encryptString(account_number),
        account_number_last4: last4,
        account_name,
        salary_amount,
        frequency,
        payment_day: payment_day != null && Number.isFinite(payment_day) ? payment_day : null,
        start_date,
        is_active: true,
      },
    });

    await logStaffPayEvent({
      userId: user.id,
      event: 'staffpay_staff_created',
      metadata: { company_id: company.id, staff_id: created.id },
    });

    return res.json({ remark: 'staffpay_staff_created', status: 'success', message: ['Staff created'], data: { staff: created } });
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

    return res.json({ remark: 'staffpay_staff_list', status: 'success', message: ['OK'], data: { staff } });
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
    if (req.body?.full_name != null) data.full_name = String(req.body.full_name).trim();
    if (req.body?.phone != null) data.phone = String(req.body.phone).trim();
    if (req.body?.bank_code != null) data.bank_code = String(req.body.bank_code).trim();
    if (req.body?.bank_name != null) data.bank_name = String(req.body.bank_name).trim();
    if (req.body?.bank_branch_code != null) data.bank_branch_code = String(req.body.bank_branch_code).trim();
    if (req.body?.bank_branch_name != null) data.bank_branch_name = String(req.body.bank_branch_name).trim();
    if (req.body?.account_name != null) data.account_name = String(req.body.account_name).trim();
    if (req.body?.frequency != null) data.frequency = String(req.body.frequency).trim();
    if (req.body?.payment_day != null) data.payment_day = Number(req.body.payment_day);
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

    if (req.body?.account_number != null) {
      const account_number = String(req.body.account_number).trim();
      const last4 = safeLast4(account_number);
      if (!last4) {
        return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid account_number'], data: null });
      }
      data.account_number_enc = encryptString(account_number);
      data.account_number_last4 = last4;

      const bank_code = data.bank_code || existing.bank_code;
      const shouldResolve = req.body?.resolve === false ? false : true;
      if (shouldResolve && bank_code) {
        try {
          const { data: resolved } = await resolveAccount({ account_number, account_bank: bank_code });
          data.account_name = resolved?.account_name || resolved?.accountName || null;
        } catch (_) {
          // keep existing
        }
      } else if (req.body?.account_name != null) {
        data.account_name = String(req.body.account_name).trim();
      }
    }

    const updated = await prisma.staffPayStaff.update({ where: { id: staffId }, data });

    await logStaffPayEvent({
      userId: user.id,
      event: 'staffpay_staff_updated',
      metadata: { company_id: existing.company_id, staff_id: updated.id },
    });
    return res.json({ remark: 'staffpay_staff_updated', status: 'success', message: ['Staff updated'], data: { staff: updated } });
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

    const trendStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6));
    const trendEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

    const [staffCount, incomeTotalAgg, expenseTotalAgg, incomeThisAgg, expenseThisAgg, incomePrevAgg, expensePrevAgg, fundingTrendRows, paidItemRows] = await Promise.all([
      prisma.staffPayStaff.count({ where: { company_id: company.id, is_active: true } }),
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
      prisma.staffPayPayrollItem.findMany({
        where: {
          payroll_run: { is: { company_id: company.id } },
          status: { in: ['SUCCESSFUL', 'SUCCESS', 'COMPLETED'] },
          updated_at: { gte: trendStart, lt: trendEnd },
        },
        select: { staff_id: true, updated_at: true },
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
      const k = formatDateYmd(dt);
      const prev = fundedByDay.get(k) || new Prisma.Decimal('0.00');
      fundedByDay.set(k, prev.plus(r?.amount || new Prisma.Decimal('0.00')));
    }

    const paidByDay = new Map();
    for (const r of Array.isArray(paidItemRows) ? paidItemRows : []) {
      const dt = r?.updated_at ? new Date(r.updated_at) : null;
      if (!dt || Number.isNaN(dt.getTime())) continue;
      const k = formatDateYmd(dt);
      const set = paidByDay.get(k) || new Set();
      if (r?.staff_id != null) {
        set.add(Number(r.staff_id));
      }
      paidByDay.set(k, set);
    }

    const trendDays = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
      const k = formatDateYmd(d);
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

    return res.json({
      remark: 'staffpay_dashboard',
      status: 'success',
      message: ['OK'],
      data: {
        company: {
          id: company.id,
          name: company.name,
          low_balance_alert_enabled: lowBalanceEnabled,
          low_balance_threshold: lowBalanceThreshold,
        },
        wallet: company.wallet,
        low_balance_alert: {
          enabled: lowBalanceEnabled,
          threshold: lowBalanceThreshold,
          is_low_balance: isLowBalance,
        },
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

    const email = String(user.email || '').trim() || `user${user.id}@voltpay.local`;
    const customer = {
      email,
      name: `${String(user.firstname || '').trim()} ${String(user.lastname || '').trim()}`.trim() || `User ${user.id}`,
      phonenumber: String(user.mobile || '').trim() || undefined,
    };

    const { link, raw } = await createPaymentLink({
      tx_ref: txRef,
      amount: Number(amountDec.toString()),
      currency: 'NGN',
      redirect_url: redirectUrl,
      customer,
      customizations: {
        title: 'StaffPay Wallet Funding',
        description: `Wallet funding for ${company.name}`,
      },
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
        payment_url: link,
        redirect_url: redirectUrl,
      },
    });
  } catch (e) {
    console.error('staffpay initiateWalletFunding error:', e);
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function walletFundingCallback(req, res) {
  try {
    const status = String(req.query?.status || '').toLowerCase();
    const tx_ref = String(req.query?.tx_ref || '');
    const transaction_id = String(req.query?.transaction_id || req.query?.reference || req.query?.trxref || '');

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

    const tx_ref = String(req.body?.tx_ref || '').trim();
    const transaction_id = String(req.body?.transaction_id || req.body?.reference || '').trim();
    if (!tx_ref || !transaction_id) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['tx_ref and transaction_id are required'], data: null });
    }

    const funding = await prisma.staffPayFundingTransaction.findUnique({ where: { tx_ref } });
    if (!funding || Number(funding.user_id) !== Number(user.id)) {
      return res.status(404).json({ remark: 'not_found', status: 'error', message: ['Funding transaction not found'], data: null });
    }

    if (funding.status === 'successful' && funding.credited_at) {
      const wallet = await prisma.staffPayWallet.findUnique({ where: { company_id: Number(funding.company_id) } });
      return res.json({ remark: 'staffpay_wallet_funding_verified', status: 'success', message: ['Already verified'], data: { wallet } });
    }

    const { raw, data } = await verifyTransaction(transaction_id);

    const txRefFromProvider = String(data?.tx_ref || data?.txRef || '').trim();
    const paymentStatus = String(data?.status || '').toLowerCase();
    const currency = String(data?.currency || 'NGN').toUpperCase();
    const amount = toDecimalOrNull(data?.amount);

    if (!txRefFromProvider || txRefFromProvider !== tx_ref) {
      return res.status(400).json({ remark: 'invalid_reference', status: 'error', message: ['tx_ref mismatch'], data: null });
    }

    if (paymentStatus !== 'successful' || currency !== 'NGN' || !amount) {
      await prisma.staffPayFundingTransaction.update({
        where: { tx_ref },
        data: {
          status: paymentStatus || 'failed',
          flutterwave_tx_id: String(data?.id || data?.flw_ref || transaction_id),
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
          flutterwave_tx_id: String(data?.id || data?.flw_ref || transaction_id),
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

      const wallet = await tx.staffPayWallet.upsert({
        where: { company_id: Number(funding.company_id) },
        update: { balance: { increment: amount } },
        create: { company_id: Number(funding.company_id), balance: amount },
      });

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

    const preferStatic = String(process.env.STAFFPAY_VIRTUAL_ACCOUNT_IS_PERMANENT || '1').toLowerCase() === 'true' || String(process.env.STAFFPAY_VIRTUAL_ACCOUNT_IS_PERMANENT || '1') === '1';

    const kycBvn = String(req.query?.bvn || req.body?.bvn || '').trim();
    const kycNin = String(req.query?.nin || req.body?.nin || '').trim();
    const bvn = kycBvn || null;
    const nin = kycNin || null;

    const existingType = company.virtual_account_expires_at ? 'dynamic' : 'static';
    const shouldUpgradeToStatic = preferStatic && existingType !== 'static' && Boolean(bvn);

    if (preferStatic && existingType === 'dynamic' && !bvn) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: ['BVN is required to upgrade to a permanent virtual account'],
        data: null,
      });
    }

    if (company.virtual_account_number && company.virtual_account_bank_name && !shouldUpgradeToStatic) {
      return res.json({
        remark: 'staffpay_virtual_account',
        status: 'success',
        message: ['OK'],
        data: {
          virtual_account: {
            tx_ref: company.virtual_account_tx_ref,
            account_number: company.virtual_account_number,
            bank_name: company.virtual_account_bank_name,
            expires_at: company.virtual_account_expires_at,
            type: existingType,
          },
        },
      });
    }

    if (preferStatic && !bvn) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: ['BVN is required to create a permanent virtual account'],
        data: null,
      });
    }

    const staticTxRef = `spva_${company.id}_static`;
    const dynamicTxRef = `spva_${company.id}_${Date.now()}`;

    const baseEmail = String(company.email || user.email || '').trim() || `user${user.id}@voltpay.local`;
    const email = baseEmail;
    const phonenumber = String(company.phone || user.mobile || '').trim() || undefined;
    const narration = `StaffPay Wallet - ${company.name}`;

    const bank_code = process.env.STAFFPAY_VIRTUAL_ACCOUNT_BANK_CODE ? String(process.env.STAFFPAY_VIRTUAL_ACCOUNT_BANK_CODE).trim() : undefined;

    const firstName = String(user.firstname || '').trim();
    const lastName = String(user.lastname || '').trim();

    let acct = '';
    let bankName = '';
    let expiresAt = null;
    let vaRaw = null;

    let virtualAccountType = 'dynamic';

    if (preferStatic) {
      if (!bvn) {
        return res.status(400).json({
          remark: 'validation_error',
          status: 'error',
          message: ['BVN is required to create a permanent virtual account'],
          data: null,
        });
      }

      try {
        const created = await createVirtualAccountNumber({
          email,
          tx_ref: staticTxRef,
          phonenumber,
          firstname: firstName || undefined,
          lastname: lastName || undefined,
          narration,
          is_permanent: true,
          bvn,
          ...(bank_code ? { bank_code } : {}),
        });

        const data = created?.data || {};
        acct = String(data?.account_number || '').trim();
        bankName = String(data?.bank_name || '').trim();
        expiresAt = null;
        vaRaw = created?.raw;
        virtualAccountType = 'static';
      } catch (e) {
        console.error('staffpay static virtual account create failed:', e?.message || e);
        const status = Number(e?.statusCode) || 400;
        return res.status(status).json({ remark: 'provider_error', status: 'error', message: [e?.message || 'Failed to create static virtual account'], data: null });
      }
    } else {
      const amount = Number(process.env.STAFFPAY_VIRTUAL_ACCOUNT_MIN_AMOUNT || 100);
      const created = await createVirtualAccountNumber({
        email,
        amount,
        tx_ref: dynamicTxRef,
        phonenumber,
        firstname: firstName || undefined,
        lastname: lastName || undefined,
        narration,
      });
      const data = created?.data || {};
      acct = String(data?.account_number || '').trim();
      bankName = String(data?.bank_name || '').trim();
      if (data?.expiry_date) {
        const d = new Date(String(data.expiry_date));
        if (!Number.isNaN(d.getTime())) expiresAt = d;
      }
      vaRaw = created?.raw;
      virtualAccountType = 'dynamic';
    }

    if (!acct || !bankName) {
      return res.status(500).json({ remark: 'provider_error', status: 'error', message: ['Flutterwave did not return account details'], data: null });
    }

    if (expiresAt && expiresAt.getUTCFullYear && expiresAt.getUTCFullYear() >= new Date().getUTCFullYear() + 100) {
      expiresAt = null;
    }

    await prisma.staffPayCompany.update({
      where: { id: company.id },
      data: {
        virtual_account_tx_ref: virtualAccountType === 'static' ? staticTxRef : dynamicTxRef,
        virtual_account_number: acct,
        virtual_account_bank_name: bankName,
        virtual_account_order_ref: vaRaw?.data?.order_ref ? String(vaRaw.data.order_ref) : null,
        virtual_account_flw_ref: vaRaw?.data?.flw_ref ? String(vaRaw.data.flw_ref) : null,
        virtual_account_expires_at: expiresAt,
      },
    });

    return res.json({
      remark: 'staffpay_virtual_account',
      status: 'success',
      message: ['OK'],
      data: {
        virtual_account: {
          tx_ref: virtualAccountType === 'static' ? staticTxRef : dynamicTxRef,
          account_number: acct,
          bank_name: bankName,
          expires_at: expiresAt,
          type: virtualAccountType,
        },
      },
    });
  } catch (e) {
    console.error('staffpay getWalletVirtualAccount error:', e);
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function walletWebhook(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';
    if (!isValidFlutterwaveWebhook({ rawBody, headers: req.headers })) {
      console.error('staffpay walletWebhook unauthorized: invalid webhook signature/hash');
      return res.status(401).send('Unauthorized');
    }

    const payload = req.body;
    const event = String(payload?.event || '').trim();
    const eventType = String(payload?.['event.type'] || '').trim();
    const data = payload?.data || {};

    const debug = String(process.env.STAFFPAY_WEBHOOK_DEBUG || '').trim() === '1';

    if (event !== 'charge.completed') {
      return res.status(200).json({ received: true });
    }

    const status = String(data?.status || '').toLowerCase();
    const paymentType = String(data?.payment_type || '').toLowerCase();
    const currency = String(data?.currency || '').toUpperCase();
    const providerTxRef = String(data?.tx_ref || data?.txRef || data?.reference || '').trim();
    const flwRef = String(data?.flw_ref || data?.flwRef || '').trim();
    const orderRef = String(data?.order_ref || data?.orderRef || '').trim();
    const flwTxId = data?.id != null ? String(data.id).trim() : '';
    const amount = toDecimalOrNull(data?.amount) || toDecimalOrNull(data?.charged_amount);

    const isSuccessful = status === 'successful' || status === 'success' || status === 'completed';

    if (debug) {
      console.log('staffpay walletWebhook received:', {
        event,
        eventType,
        status,
        paymentType,
        currency,
        tx_ref: providerTxRef,
        flw_ref: flwRef,
        order_ref: orderRef,
        flwTxId,
        amount: amount ? String(amount) : null,
      });
    }

    if (!isSuccessful || currency !== 'NGN' || !flwTxId || !amount) {
      return res.status(200).json({ received: true });
    }

    if (providerTxRef) {
      const funding = await prisma.staffPayFundingTransaction.findUnique({ where: { tx_ref: providerTxRef } });
      if (funding) {
        try {
          await withDirectFallback(db => db.$transaction(async tx => {
            const claimed = await tx.staffPayFundingTransaction.updateMany({
              where: {
                tx_ref: providerTxRef,
                credited_at: null,
              },
              data: {
                status: 'successful',
                flutterwave_tx_id: flwTxId,
                raw_payload: payload,
                credited_at: new Date(),
                amount,
                currency: 'NGN',
              },
            });

            if (claimed?.count) {
              await tx.staffPayWallet.upsert({
                where: { company_id: Number(funding.company_id) },
                update: { balance: { increment: amount } },
                create: { company_id: Number(funding.company_id), balance: amount },
              });
            }
          }, { timeout: 15000 }));
        } catch (e) {
          if (e?.code !== 'P2002') {
            console.error('staffpay walletWebhook funding credit error:', e);
          }
        }

        return res.status(200).json({ received: true });
      }
    }

    const isBankTransfer = paymentType === 'bank_transfer' || paymentType === 'account' || eventType.toUpperCase().includes('BANK_TRANSFER') || eventType.toUpperCase().includes('BANK_TRANSFER_TRANSACTION');
    if (!isBankTransfer || (!providerTxRef && !flwRef && !orderRef)) {
      return res.status(200).json({ received: true });
    }

    let company = null;
    if (providerTxRef) {
      company = await prisma.staffPayCompany.findFirst({ where: { virtual_account_tx_ref: providerTxRef } });
    }
    if (!company && flwRef) {
      company = await prisma.staffPayCompany.findFirst({ where: { virtual_account_flw_ref: flwRef } });
    }
    if (!company && orderRef) {
      company = await prisma.staffPayCompany.findFirst({ where: { virtual_account_order_ref: orderRef } });
    }
    if (!company) {
      const webhookAcct = String(data?.account_number || data?.account || '').replace(/\D/g, '');
      if (webhookAcct) {
        company = await prisma.staffPayCompany.findFirst({ where: { virtual_account_number: webhookAcct } });
      }
    }
    if (!company) {
      const originatorAcct = String(
        payload?.meta_data?.originatoraccountnumber ||
          payload?.meta_data?.originatorAccountNumber ||
          data?.meta_data?.originatoraccountnumber ||
          data?.meta_data?.originatorAccountNumber ||
          data?.meta?.originatoraccountnumber ||
          data?.meta?.originatorAccountNumber ||
          ''
      ).replace(/\D/g, '');
      if (originatorAcct) {
        company = await prisma.staffPayCompany.findFirst({ where: { virtual_account_number: originatorAcct } });
      }
    }
    if (!company) {
      console.warn('staffpay walletWebhook: company not found', { tx_ref: providerTxRef, flw_ref: flwRef, order_ref: orderRef, flwTxId });
      return res.status(200).json({ received: true });
    }

    const internalTxRef = `spva_${company.id}_${flwTxId}`;
    const creditedAt = new Date();

    try {
      await withDirectFallback(db => db.$transaction(async tx => {
          await tx.staffPayFundingTransaction.create({
            data: {
              company_id: Number(company.id),
              user_id: Number(company.owner_user_id),
              tx_ref: internalTxRef,
              flutterwave_tx_id: flwTxId,
              amount,
              currency: 'NGN',
              status: 'successful',
              raw_payload: payload,
              credited_at: creditedAt,
            },
          });

          await tx.staffPayWallet.upsert({
            where: { company_id: Number(company.id) },
            update: { balance: { increment: amount } },
            create: { company_id: Number(company.id), balance: amount },
          });
        }, { timeout: 15000 }));
    } catch (e) {
      if (e?.code !== 'P2002') {
        console.error('staffpay walletWebhook credit error:', e);
      }
    }

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('staffpay walletWebhook error:', e);
    return res.status(200).json({ received: true });
  }
}

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

    const staff = await prisma.staffPayStaff.findMany({
      where: {
        company_id: company.id,
        is_active: true,
        ...(staffIds.length ? { id: { in: staffIds } } : {}),
      },
      orderBy: { id: 'asc' },
    });

    if (!staff.length) {
      return res.status(400).json({ remark: 'no_staff', status: 'error', message: ['No active staff to pay'], data: null });
    }

    const totalSalary = staff.reduce((acc, s) => acc.plus(s.salary_amount || new Prisma.Decimal('0.00')), new Prisma.Decimal('0.00'));

    const vatRate = staffPayVatRate();

    const feeByStaffId = new Map();
    let flutterwaveFeeTotal = new Prisma.Decimal('0.00');
    let voltpayFeeTotal = new Prisma.Decimal('0.00');
    let vatTotal = new Prisma.Decimal('0.00');

    for (const s of staff) {
      const bankCode = String(s.bank_code || '').trim();
      const isGhanaBank = /^GH/i.test(bankCode);
      const currency = isGhanaBank ? 'GHS' : 'NGN';
      const amt = s.salary_amount || new Prisma.Decimal('0.00');

      let flwFee = new Prisma.Decimal('0.00');
      try {
        const { data } = await getTransferFee({ amount: Number(new Prisma.Decimal(amt).toString()), currency });
        const nFee = data?.fee != null && Number.isFinite(Number(data.fee)) ? Number(data.fee) : 0;
        flwFee = new Prisma.Decimal(nFee.toFixed(2));
      } catch (_) {
        flwFee = new Prisma.Decimal('0.00');
      }

      const voltFee = currency === 'NGN' ? computeVoltPayHybridFee(amt) : new Prisma.Decimal('0.00');
      let itemVat = currency === 'NGN' ? (new Prisma.Decimal(vatRate.toString()).mul(flwFee.plus(voltFee))) : new Prisma.Decimal('0.00');
      try {
        itemVat = new Prisma.Decimal(itemVat.toFixed(2));
      } catch (_) {}

      flutterwaveFeeTotal = flutterwaveFeeTotal.plus(flwFee);
      voltpayFeeTotal = voltpayFeeTotal.plus(voltFee);
      vatTotal = vatTotal.plus(itemVat);

      feeByStaffId.set(Number(s.id), { flutterwave_fee: flwFee, voltpay_fee: voltFee, vat: itemVat });
    }

    const totalDebit = totalSalary.plus(flutterwaveFeeTotal).plus(voltpayFeeTotal).plus(vatTotal);

    const payrollRun = await prisma.$transaction(async tx => {
      const reserved = await tx.staffPayWallet.updateMany({
        where: { company_id: company.id, balance: { gte: totalDebit } },
        data: { balance: { decrement: totalDebit } },
      });

      if (!reserved?.count) {
        throw Object.assign(new Error('Insufficient StaffPay wallet balance'), { statusCode: 400 });
      }

      const run = await tx.staffPayPayrollRun.create({
        data: {
          company_id: company.id,
          title,
          status: 'preparing',
          total_salary: totalSalary,
          flutterwave_fee_total: flutterwaveFeeTotal,
          voltpay_fee_total: voltpayFeeTotal,
          vat_total: vatTotal,
          total_debit: totalDebit,
          items: {
            createMany: {
              data: staff.map(s => ({
                staff_id: s.id,
                amount: s.salary_amount,
                flutterwave_fee: feeByStaffId.get(Number(s.id))?.flutterwave_fee || new Prisma.Decimal('0.00'),
                voltpay_fee: feeByStaffId.get(Number(s.id))?.voltpay_fee || new Prisma.Decimal('0.00'),
                vat: feeByStaffId.get(Number(s.id))?.vat || new Prisma.Decimal('0.00'),
                status: 'NEW',
              })),
            },
          },
        },
      });

      return run;
    }, { timeout: 15000, maxWait: 15000 });

    await logStaffPayEvent({
      userId: user.id,
      event: 'staffpay_payroll_run_initiated',
      metadata: { company_id: company.id, payroll_run_id: payrollRun.id, total_salary: Number(totalSalary.toString()) },
    });

    let bulk;
    try {
      const bulk_data = staff.map(s => {
        const acct = decryptString(s.account_number_enc);
        const bankCode = String(s.bank_code || '').trim();
        const isGhanaBank = /^GH/i.test(bankCode);
        const currency = isGhanaBank ? 'GHS' : 'NGN';

        const item = {
          bank_code: bankCode,
          account_number: acct,
          amount: Number(new Prisma.Decimal(s.salary_amount || '0').toString()),
          currency,
          narration: 'Salary payment',
        };

        if (isGhanaBank) {
          const branch = String(s.bank_branch_code || '').trim();
          if (branch) {
            item.destination_branch_code = branch;
          }
        }

        return item;
      });

      bulk = await createBulkTransfer({ title, bulk_data });
    } catch (e) {
      console.error('staffpay createPayrollRun bulk transfer error:', {
        statusCode: e?.statusCode,
        message: e?.message,
        flutterwave: e?.flutterwave,
      });

      await prisma.$transaction([
        prisma.staffPayPayrollRun.update({ where: { id: payrollRun.id }, data: { status: 'failed' } }),
        prisma.staffPayWallet.update({ where: { company_id: company.id }, data: { balance: { increment: totalDebit } } }),
        prisma.staffPayPayrollItem.updateMany({ where: { payroll_run_id: payrollRun.id }, data: { status: 'FAILED', complete_message: e?.message || 'Bulk transfer failed' } }),
      ]);

      const status = Number(e?.statusCode) || 500;
      return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Bulk transfer failed'], data: null });
    }

    const batchId = bulk?.data?.id;
    await prisma.staffPayPayrollRun.update({
      where: { id: payrollRun.id },
      data: {
        status: 'queued',
        batch_id: batchId != null ? Number(batchId) : null,
      },
    });

    const walletAfter = await prisma.staffPayWallet.findUnique({ where: { company_id: company.id } });
    try {
      const settings = await prisma.staffPayCompany.findUnique({ where: { id: company.id } });
      const enabled = settings?.low_balance_alert_enabled !== false;
      const threshold = settings?.low_balance_threshold;
      if (enabled && walletAfter && threshold && new Prisma.Decimal(walletAfter.balance || '0').lt(threshold)) {
        if (prisma.pushNotification) {
          await prisma.pushNotification.create({
            data: {
              user_id: Number(user.id),
              subject: 'Low StaffPay wallet balance',
              message: `Your StaffPay wallet balance is low for ${company.name}.`,
              notification_type: 'staffpay',
              data: { company_id: company.id, balance: walletAfter.balance, threshold },
            },
          });
        }

        await logStaffPayEvent({
          userId: user.id,
          event: 'staffpay_low_balance_alert',
          metadata: { company_id: company.id, balance: Number(walletAfter.balance.toString()), threshold: Number(threshold.toString()) },
        });
      }
    } catch (_) {}

    const runWithItems = await prisma.staffPayPayrollRun.findUnique({
      where: { id: payrollRun.id },
      include: { items: { include: { staff: true } } },
    });

    return res.json({
      remark: 'staffpay_payroll_run_created',
      status: 'success',
      message: ['Bulk transfer queued'],
      data: {
        payroll_run: runWithItems,
        batch: bulk?.data || null,
      },
    });
  } catch (e) {
    console.error('staffpay createPayrollRun error:', e);
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function clearHistory(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const company_id = Number(req.query?.company_id);
    if (!company_id) return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['company_id is required'], data: null });

    const company = await getOwnedCompanyOrFail({ userId: user.id, companyId: company_id, res });
    if (!company) return;

    const [fundingDeleted, runsDeleted] = await prisma.$transaction([
      prisma.staffPayFundingTransaction.deleteMany({ where: { company_id: company.id } }),
      prisma.staffPayPayrollRun.deleteMany({ where: { company_id: company.id } }),
    ]);

    await logStaffPayEvent({
      userId: user.id,
      event: 'staffpay_history_cleared',
      metadata: { company_id: company.id, funding_deleted: fundingDeleted?.count || 0, runs_deleted: runsDeleted?.count || 0 },
    });

    return res.json({
      remark: 'staffpay_history_cleared',
      status: 'success',
      message: ['Cleared'],
      data: { funding_deleted: fundingDeleted?.count || 0, payroll_runs_deleted: runsDeleted?.count || 0 },
    });
  } catch (e) {
    console.error('staffpay clearHistory error:', e);
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
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

async function clearPayrollRuns(req, res) {
  try {
    const ok = await requireModels(res);
    if (!ok) return;

    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const company_id = Number(req.query?.company_id);
    if (!company_id) return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['company_id is required'], data: null });

    const company = await getOwnedCompanyOrFail({ userId: user.id, companyId: company_id, res });
    if (!company) return;

    const deleted = await prisma.staffPayPayrollRun.deleteMany({ where: { company_id: company.id } });

    return res.json({
      remark: 'staffpay_payroll_runs_cleared',
      status: 'success',
      message: ['Cleared'],
      data: { deleted: deleted?.count || 0 },
    });
  } catch (e) {
    console.error('staffpay clearPayrollRuns error:', e);
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
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

    return res.json({ remark: 'staffpay_payroll_run', status: 'success', message: ['OK'], data: { payroll_run: run } });
  } catch (e) {
    console.error('staffpay getPayrollRun error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function syncPayrollRun(req, res) {
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

    if (!run.batch_id) {
      return res.status(400).json({ remark: 'missing_batch_id', status: 'error', message: ['Payroll run has no batch_id'], data: null });
    }

    const { data: transfers } = await getBulkTransfer({ batch_id: String(run.batch_id) });
    const transferList = Array.isArray(transfers) ? transfers : [];

    const itemsByStaffId = new Map(run.items.map(i => [Number(i.staff_id), i]));

    let feeTotal = new Prisma.Decimal('0.00');
    let vatTotal = new Prisma.Decimal('0.00');
    let voltpayFeeTotal = new Prisma.Decimal('0.00');
    const vatRate = staffPayVatRate();

    for (const t of transferList) {
      const bank_code = String(t?.bank_code || '').trim();
      const acct = String(t?.account_number || '').trim();
      const last4 = safeLast4(acct);
      const staff = run.items.map(i => i.staff).find(s => String(s.bank_code) === bank_code && String(s.account_number_last4) === last4);
      if (!staff) continue;

      const item = itemsByStaffId.get(Number(staff.id));
      if (!item) continue;

      const fee = toDecimalOrNull(t?.fee) || new Prisma.Decimal('0.00');
      feeTotal = feeTotal.plus(fee);

      const existingVoltFee = item?.voltpay_fee != null ? new Prisma.Decimal(item.voltpay_fee) : new Prisma.Decimal('0.00');
      voltpayFeeTotal = voltpayFeeTotal.plus(existingVoltFee);
      const bankCode = String(staff?.bank_code || '').trim();
      const isGhanaBank = /^GH/i.test(bankCode);
      const itemVat = isGhanaBank ? new Prisma.Decimal('0.00') : new Prisma.Decimal(vatRate.toString()).mul(fee.plus(existingVoltFee));
      const itemVat2 = (() => {
        try {
          return new Prisma.Decimal(itemVat.toFixed(2));
        } catch {
          return itemVat;
        }
      })();
      vatTotal = vatTotal.plus(itemVat2);

      await prisma.staffPayPayrollItem.update({
        where: { id: item.id },
        data: {
          flutterwave_transfer_id: t?.id != null ? Number(t.id) : null,
          reference: t?.reference ? String(t.reference) : null,
          status: t?.status ? String(t.status) : item.status,
          complete_message: t?.complete_message ? String(t.complete_message) : (t?.completeMessage ? String(t.completeMessage) : null),
          flutterwave_fee: fee,
          vat: itemVat2,
          raw_payload: t,
        },
      });
    }

    const oldTotalDebit = run.total_debit != null ? new Prisma.Decimal(run.total_debit) : new Prisma.Decimal(run.total_salary || '0');
    const newTotalDebit = new Prisma.Decimal(run.total_salary || '0').plus(feeTotal).plus(voltpayFeeTotal).plus(vatTotal);
    const delta = newTotalDebit.minus(oldTotalDebit);

    await prisma.$transaction(async tx => {
      await tx.staffPayPayrollRun.update({
        where: { id: run.id },
        data: {
          flutterwave_fee_total: feeTotal,
          voltpay_fee_total: voltpayFeeTotal,
          vat_total: vatTotal,
          total_debit: newTotalDebit,
        },
      });

      if (!delta.isZero()) {
        if (delta.gt(new Prisma.Decimal('0.00'))) {
          await tx.staffPayWallet.upsert({
            where: { company_id: run.company_id },
            update: { balance: { decrement: delta } },
            create: { company_id: run.company_id, balance: new Prisma.Decimal('0.00').minus(delta) },
          });
        } else {
          await tx.staffPayWallet.upsert({
            where: { company_id: run.company_id },
            update: { balance: { increment: delta.abs() } },
            create: { company_id: run.company_id, balance: delta.abs() },
          });
        }
      }
    }, { timeout: 15000, maxWait: 15000 });

    const refreshed = await prisma.staffPayPayrollRun.findUnique({
      where: { id: run.id },
      include: { items: { include: { staff: true } } },
    });

    const statuses = (refreshed?.items || []).map(i => String(i.status || '').toUpperCase());
    const hasPending = statuses.some(s => s === 'NEW' || s === 'PENDING');
    const hasFailed = statuses.some(s => s === 'FAILED');
    const allSuccessful = statuses.length > 0 && statuses.every(s => s === 'SUCCESSFUL');

    const newStatus = allSuccessful ? 'successful' : (hasPending ? 'processing' : (hasFailed ? 'failed' : 'processing'));

    await prisma.staffPayPayrollRun.update({ where: { id: run.id }, data: { status: newStatus } });

    const finalRun = await prisma.staffPayPayrollRun.findUnique({
      where: { id: run.id },
      include: { items: { include: { staff: true } } },
    });

    await logStaffPayEvent({
      userId: user.id,
      event: 'staffpay_payroll_run_synced',
      metadata: { company_id: run.company_id, payroll_run_id: run.id, status: newStatus },
    });

    return res.json({
      remark: 'staffpay_payroll_run_synced',
      status: 'success',
      message: ['OK'],
      data: { payroll_run: finalRun, transfers: transferList },
    });
  } catch (e) {
    console.error('staffpay syncPayrollRun error:', e);
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

module.exports = {
  banks,
  bankBranches,
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
  clearHistory,
  getWallet,
  getWalletVirtualAccount,
  initiateWalletFunding,
  verifyWalletFunding,
  walletFundingCallback,
  walletWebhook,
  reconcileWalletFunding,
  autoReconcileWalletFunding,

  createPayrollRun,
  listPayrollRuns,
  clearPayrollRuns,
  getPayrollRun,
  syncPayrollRun,
};
