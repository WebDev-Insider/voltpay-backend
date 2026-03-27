const prisma = require('../../database/prisma');
const { Prisma } = require('@prisma/client');

const { createVirtualAccount, verifyWebhookSignature } = require('./paymentpoint.service');

const reconcileLocks = new Map();

function toMoneyString(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n.toFixed(2);
}

function getBaseUrl(req) {
  const configured = process.env.PUBLIC_BASE_URL || process.env.APP_URL || process.env.BACKEND_URL;
  if (configured) return String(configured).trim().replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString().split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

function txRefFor(userId) {
  const rand = Math.random().toString(16).slice(2, 10);
  return `fund_${userId}_${Date.now()}_${rand}`;
}

function computeFundingFee(amountNaira) {
  const amt = Number(amountNaira);
  if (!Number.isFinite(amt) || amt <= 0) return 0;
  if (amt >= 100 && amt <= 1000) return 10;
  if (amt > 1000 && amt <= 20000) return 30;
  if (amt > 20000) return 50;
  return 0;
}

function parsePaymentPointBankCodes() {
  const raw = (process.env.PAYMENTPOINT_BANK_CODES || '').trim();
  if (!raw) return ['20946', '20897'];
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function getPaymentPointBusinessId() {
  const v = (process.env.PAYMENTPOINT_BUSINESS_ID || '').trim();
  if (!v) throw new Error('Missing required env: PAYMENTPOINT_BUSINESS_ID');
  return v;
}

function buildCustomerName(user) {
  const first = String(user?.firstname || '').trim();
  const last = String(user?.lastname || '').trim();
  const full = `${first} ${last}`.trim();
  return full || `User ${user?.id || ''}`.trim();
}

function normalizePaymentPointPhoneNumber(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 11) return digits;
  if (digits.length === 10) return `0${digits}`;
  if (digits.startsWith('234') && digits.length === 13) return `0${digits.slice(3)}`;
  if (digits.startsWith('2340') && digits.length === 14) return digits.slice(3);
  const last11 = digits.slice(-11);
  if (last11.length === 11 && last11.startsWith('0')) return last11;
  return null;
}

function normalizeAmountToDecimal(amount) {
  const cleaned = String(amount ?? '').replace(/,/g, '').trim();
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Prisma.Decimal(n.toFixed(2));
}

function isSuccessfulPaymentPointPayload(payload) {
  const txStatus = String(payload?.transaction_status || payload?.transactionStatus || payload?.status || '').toLowerCase();
  const notif = String(payload?.notification_status || payload?.notificationStatus || '').toLowerCase();
  const event = String(payload?.event || payload?.event_type || payload?.type || payload?.notificationType || '').toLowerCase();
  return (
    txStatus === 'success' ||
    txStatus === 'successful' ||
    notif === 'payment_successful' ||
    event === 'payment_successful' ||
    event === 'transfer_successful'
  );
}

async function initiate(req, res) {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });
    }

    if (!prisma.fundingTransaction) {
      return res.status(500).json({
        remark: 'server_error',
        status: 'error',
        message: ['FundingTransaction model is not available. Run prisma generate + db push/migrate and restart the server.'],
        data: null,
      });
    }

    return virtualAccount(req, res);
  } catch (e) {
    console.error('Funding initiate error:', e);
    const status = Number(e?.statusCode) || 500;
    const msg = e?.message || 'Failed to initiate funding';
    return res.status(status).json({ remark: 'error', status: 'error', message: [msg], data: null });
  }
}

async function virtualAccount(req, res) {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });
    }

    if (!prisma.fundingTransaction) {
      return res.status(500).json({
        remark: 'server_error',
        status: 'error',
        message: ['FundingTransaction model is not available. Run prisma generate + db push/migrate and restart the server.'],
        data: null,
      });
    }

    const existing = await prisma.fundingTransaction.findFirst({
      where: {
        user_id: Number(user.id),
        status: 'virtual_account',
      },
      orderBy: { id: 'desc' },
    });

    if (existing?.raw_payload?.bankAccounts?.length) {
      return res.json({
        remark: 'virtual_account',
        status: 'success',
        message: ['Virtual account is ready'],
        data: {
          provider: 'paymentpoint',
          customer: existing.raw_payload.customer || null,
          bankAccounts: existing.raw_payload.bankAccounts || [],
        },
      });
    }

    const bankCodes = parsePaymentPointBankCodes();
    const businessId = getPaymentPointBusinessId();

    const email = (user.email || '').toString().trim() || `user${user.id}@voltpay.local`;
    const name = buildCustomerName(user);
    const phoneNumber = normalizePaymentPointPhoneNumber(user.mobile);
    if (!phoneNumber) {
      return res.status(400).json({
        remark: 'validation_error',
        status: 'error',
        message: ['Invalid phone number. Please update your phone number to an 11-digit Nigerian number (e.g., 08012345678).'],
        data: null,
      });
    }

    const { raw } = await createVirtualAccount({
      email,
      name,
      phoneNumber,
      bankCode: bankCodes,
      businessId,
    });

    const customerId = raw?.customer?.customer_id;
    if (!customerId) {
      return res.status(500).json({
        remark: 'provider_error',
        status: 'error',
        message: ['PaymentPoint did not return customer_id'],
        data: null,
      });
    }

    const tx_ref = `ppcust_${String(customerId)}`;
    const amount = new Prisma.Decimal('0.00');

    try {
      if (existing) {
        await prisma.fundingTransaction.update({
          where: { id: existing.id },
          data: {
            tx_ref,
            amount,
            currency: 'NGN',
            status: 'virtual_account',
            raw_payload: raw,
          },
        });
      } else {
        await prisma.fundingTransaction.create({
          data: {
            user_id: Number(user.id),
            tx_ref,
            amount,
            currency: 'NGN',
            status: 'virtual_account',
            raw_payload: raw,
          },
        });
      }
    } catch (e) {
      if (e?.code === 'P2002') {
        const byRef = await prisma.fundingTransaction.findUnique({ where: { tx_ref } });
        if (byRef && Number(byRef.user_id) !== Number(user.id)) {
          return res.status(409).json({
            remark: 'conflict',
            status: 'error',
            message: ['Virtual account reference conflict'],
            data: null,
          });
        }

        if (byRef?.raw_payload?.bankAccounts?.length) {
          return res.json({
            remark: 'virtual_account',
            status: 'success',
            message: ['Virtual account is ready'],
            data: {
              provider: 'paymentpoint',
              customer: byRef.raw_payload.customer || null,
              bankAccounts: byRef.raw_payload.bankAccounts || [],
            },
          });
        }
      }
      throw e;
    }

    return res.json({
      remark: 'virtual_account',
      status: 'success',
      message: [raw?.message || 'Virtual account created successfully'],
      data: {
        provider: 'paymentpoint',
        customer: raw?.customer || null,
        bankAccounts: raw?.bankAccounts || [],
      },
    });
  } catch (e) {
    console.error('Virtual account error:', e);
    const status = Number(e?.statusCode) || 500;
    const msg = e?.message || 'Failed to create virtual account';
    return res.status(status).json({ remark: 'error', status: 'error', message: [msg], data: null });
  }
}

async function verify(req, res) {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });
    }

    if (!prisma.fundingTransaction) {
      return res.status(500).json({
        remark: 'server_error',
        status: 'error',
        message: ['FundingTransaction model is not available. Run prisma generate + db push/migrate and restart the server.'],
        data: null,
      });
    }

    const tx_ref = String(req.body?.tx_ref || '').trim();
    if (!tx_ref) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['tx_ref is required'], data: null });
    }

    const funding = await prisma.fundingTransaction.findUnique({ where: { tx_ref } });
    if (funding && Number(funding.user_id) === Number(user.id) && funding.status === 'virtual_account') {
      return res.json({
        remark: 'virtual_account',
        status: 'success',
        message: ['Virtual account is ready'],
        data: {
          provider: 'paymentpoint',
          customer: funding.raw_payload?.customer || null,
          bankAccounts: funding.raw_payload?.bankAccounts || [],
        },
      });
    }

    return res.status(400).json({
      remark: 'not_supported',
      status: 'error',
      message: ['PaymentPoint funding is credited automatically after your transfer is confirmed.'],
      data: null,
    });
  } catch (e) {
    console.error('Funding verify error:', e);
    const status = Number(e?.statusCode) || 500;
    const msg = e?.message || 'Failed to verify funding';
    return res.status(status).json({ remark: 'error', status: 'error', message: [msg], data: null });
  }
}

async function reconcileWorker({ userId, pending }) {
  return;
}

async function reconcile(req, res) {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });
    }

    if (!prisma.fundingTransaction) {
      return res.status(500).json({
        remark: 'server_error',
        status: 'error',
        message: ['FundingTransaction model is not available. Run prisma generate + db push/migrate and restart the server.'],
        data: null,
      });
    }

    return res.json({ remark: 'reconcile_disabled', status: 'success', message: ['Reconcile is not required for PaymentPoint funding'], data: { results: [] } });
  } catch (e) {
    console.error('Funding reconcile error:', e);
    const status = Number(e?.statusCode) || 500;
    const msg = e?.message || 'Failed to reconcile funding';
    return res.status(status).json({ remark: 'error', status: 'error', message: [msg], data: null });
  }
}

async function webhook(req, res) {
  try {
    if (!prisma.fundingTransaction) {
      return res.status(200).json({ received: true });
    }

    const signature =
      req.headers['paymentpoint-signature'] ||
      req.headers['x-paymentpoint-signature'] ||
      req.headers['x-webhook-signature'] ||
      req.headers['x-signature'];
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';
    if (!verifyWebhookSignature({ rawBody, signature })) {
      console.warn('PaymentPoint webhook signature verification failed', {
        hasRawBody: Boolean(rawBody),
        hasSignature: Boolean(signature),
        headerKeys: Object.keys(req.headers || {}),
      });
      return res.status(401).send('Unauthorized');
    }

    console.log('PaymentPoint webhook received', {
      headerKeys: Object.keys(req.headers || {}),
    });

    const root = req.body || {};
    const payload = root?.data && typeof root.data === 'object' ? root.data : root;
    if (!isSuccessfulPaymentPointPayload(root) && !isSuccessfulPaymentPointPayload(payload)) {
      console.log('PaymentPoint webhook ignored (not successful)', {
        keys: Object.keys(payload || {}),
      });
      return res.status(200).json({ received: true });
    }

    const customerId =
      payload?.customer_id ||
      payload?.customerId ||
      payload?.customer?.customer_id ||
      payload?.customer?.id ||
      payload?.customer?.customerId;

    const transactionId =
      payload?.transaction_id ||
      payload?.transactionId ||
      payload?.transaction?.transaction_id ||
      payload?.transaction?.id ||
      payload?.transaction?.transactionId ||
      payload?.id ||
      payload?.reference;

    const grossAmountDec = normalizeAmountToDecimal(
      payload?.amount_paid ??
        payload?.amountPaid ??
        payload?.amount ??
        payload?.transaction_amount ??
        payload?.transactionAmount ??
        payload?.transaction?.amount ??
        payload?.transaction?.transaction_amount
    );

    const settlementAmountDec = normalizeAmountToDecimal(
      payload?.settlement_amount ?? payload?.settlementAmount ?? payload?.settled_amount ?? payload?.settledAmount
    );

    const settlementFeeDec = normalizeAmountToDecimal(payload?.settlement_fee ?? payload?.settlementFee ?? payload?.fee);

    const creditAmountDec = settlementAmountDec || grossAmountDec;
    const currency = (payload?.currency || 'NGN').toString().toUpperCase();

    if (!customerId || !transactionId || !creditAmountDec) {
      console.log('PaymentPoint webhook ignored (missing required fields)', {
        hasCustomerId: Boolean(customerId),
        hasTransactionId: Boolean(transactionId),
        hasAmount: Boolean(creditAmountDec),
        keys: Object.keys(payload || {}),
      });
      return res.status(200).json({ received: true });
    }

    if (currency !== 'NGN') {
      return res.status(200).json({ received: true });
    }

    const virtualRef = `ppcust_${String(customerId)}`;
    const vaRecord = await prisma.fundingTransaction.findUnique({ where: { tx_ref: virtualRef } });
    if (!vaRecord) {
      console.log('PaymentPoint webhook ignored (virtual account not found)', {
        virtualRef,
      });
      return res.status(200).json({ received: true });
    }

    const tx_ref = `pp_${String(transactionId)}`;
    const creditAmount = creditAmountDec;
    const grossAmount = grossAmountDec || creditAmount;
    const feeAmount = settlementFeeDec || new Prisma.Decimal('0.00');
    const fee = Number(feeAmount.toString());

    await prisma.$transaction(
      async tx => {
        try {
          await tx.fundingTransaction.create({
            data: {
              user_id: Number(vaRecord.user_id),
              tx_ref,
              amount: creditAmount,
              currency: 'NGN',
              status: 'pending',
              raw_payload: payload,
            },
          });
        } catch (e) {
          if (e?.code !== 'P2002') throw e;
        }

        const creditedAt = new Date();
        const claimed = await tx.fundingTransaction.updateMany({
          where: {
            tx_ref,
            credited_at: null,
          },
          data: {
            status: 'successful',
            credited_at: creditedAt,
            amount: creditAmount,
            currency: 'NGN',
            raw_payload: payload,
          },
        });

        if (!claimed?.count) return;

        await tx.user.update({
          where: { id: Number(vaRecord.user_id) },
          data: { balance: { increment: creditAmount }, currency_symbol: '₦' },
        });

        if (tx.walletTransaction) {
          try {
            await tx.walletTransaction.create({
              data: {
                user_id: Number(vaRecord.user_id),
                trx: String(tx_ref),
                trx_type: '+',
                amount: creditAmount,
                charge: feeAmount,
                total_amount: grossAmount,
                remark: 'fund_account',
                details: 'Wallet funding',
                other_data: {
                  title: 'Transfer to Wallet',
                  subtitle: 'Wallet Funding',
                  feedback: 'Successful',
                  note: 'PaymentPoint',
                  image_src: '',
                },
                meta: {
                  gross_amount: Number(grossAmount.toString()),
                  fee,
                  credited_amount: Number(creditAmount.toString()),
                  settlement_amount: Number(creditAmount.toString()),
                  paymentpoint_transaction_id: String(transactionId),
                  customer_id: String(customerId),
                },
              },
            });
          } catch (e) {
            if (e?.code !== 'P2002') throw e;
          }
        }
      },
      {
        maxWait: 10_000,
        timeout: 15_000,
      }
    );

    console.log('PaymentPoint wallet credited', {
      tx_ref: `pp_${String(transactionId)}`,
      user_id: Number(vaRecord.user_id),
      amount: Number(creditAmount.toString()),
    });

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('Funding webhook error:', e);
    return res.status(200).json({ received: true });
  }
}

async function callback(req, res) {
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

module.exports = {
  initiate,
  virtualAccount,
  verify,
  reconcile,
  webhook,
  callback,
};
