const prisma = require('../../database/prisma');
const { Prisma } = require('@prisma/client');

const { initializeTransaction, verifyTransaction, verifyWebhookSignature } = require('./paystack.service');

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

    const amountStr = toMoneyString(req.body?.amount);
    if (!amountStr) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid amount'], data: null });
    }

    const tx_ref = txRefFor(user.id);
    const callback_url = `${getBaseUrl(req)}/api/funding/callback?tx_ref=${encodeURIComponent(tx_ref)}`;

    const funding = await prisma.fundingTransaction.create({
      data: {
        user_id: Number(user.id),
        tx_ref,
        amount: new Prisma.Decimal(amountStr),
        currency: 'NGN',
        status: 'pending',
      },
    });

    const amountKobo = Math.round(Number(amountStr) * 100);
    const { authorization_url, raw } = await initializeTransaction({
      email: user.email || `user${user.id}@voltpay.local`,
      amountKobo,
      reference: tx_ref,
      callback_url,
      metadata: {
        tx_ref,
        user_id: Number(user.id),
        purpose: 'wallet_funding',
      },
    });

    await prisma.fundingTransaction.update({
      where: { id: funding.id },
      data: {
        raw_payload: raw,
      },
    });

    return res.json({
      remark: 'funding_initiated',
      status: 'success',
      message: ['Proceed to payment'],
      data: {
        tx_ref,
        redirect_url: authorization_url,
        callback_url,
      },
    });
  } catch (e) {
    console.error('Funding initiate error:', e);
    const status = Number(e?.statusCode) || 500;
    const msg = e?.message || 'Failed to initiate funding';
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
    const reference = String(req.body?.transaction_id || req.body?.reference || req.body?.trxref || '').trim();

    if (!tx_ref || !reference) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['tx_ref and reference are required'], data: null });
    }

    const funding = await prisma.fundingTransaction.findUnique({ where: { tx_ref } });
    if (!funding || Number(funding.user_id) !== Number(user.id)) {
      return res.status(404).json({ remark: 'not_found', status: 'error', message: ['Funding transaction not found'], data: null });
    }

    if (funding.credited_at) {
      return res.json({ remark: 'funding_already_credited', status: 'success', message: ['Payment already processed'], data: { tx_ref, status: funding.status } });
    }

    const { data, raw } = await verifyTransaction(reference);

    const paystackStatus = (data?.status || '').toString().toLowerCase();
    const paystackCurrency = (data?.currency || '').toString().toUpperCase();
    const paystackReference = (data?.reference || '').toString();
    const paystackId = data?.id != null ? String(data.id) : null;
    const amountKobo = Number(data?.amount);

    if (paystackReference && paystackReference !== tx_ref) {
      return res.status(400).json({ remark: 'mismatch', status: 'error', message: ['Transaction reference mismatch'], data: null });
    }

    if (paystackStatus !== 'success') {
      await prisma.fundingTransaction.update({
        where: { tx_ref },
        data: { status: paystackStatus || 'failed', flutterwave_tx_id: paystackId, raw_payload: raw },
      });

      return res.status(400).json({ remark: 'payment_not_successful', status: 'error', message: ['Payment not successful'], data: { status: paystackStatus } });
    }

    if (paystackCurrency !== 'NGN') {
      return res.status(400).json({ remark: 'currency_mismatch', status: 'error', message: ['Currency must be NGN'], data: null });
    }

    const expected = Number(funding.amount?.toString?.() ?? funding.amount);
    const paid = Number.isFinite(amountKobo) ? amountKobo / 100 : NaN;
    if (!Number.isFinite(paid) || !Number.isFinite(expected) || paid < expected) {
      return res.status(400).json({ remark: 'amount_mismatch', status: 'error', message: ['Amount mismatch'], data: null });
    }

    const fee = computeFundingFee(expected);
    const net = Math.max(0, expected - fee);
    const creditAmount = new Prisma.Decimal(net.toFixed(2));
    const feeAmount = new Prisma.Decimal(fee.toFixed(2));
    const grossAmount = new Prisma.Decimal(expected.toFixed(2));

    await prisma.$transaction(async tx => {
      const latest = await tx.fundingTransaction.findUnique({ where: { tx_ref } });
      if (latest?.credited_at) return;

      await tx.user.update({
        where: { id: Number(user.id) },
        data: {
          balance: { increment: creditAmount },
          currency_symbol: '₦',
        },
      });

      if (tx.walletTransaction) {
        try {
          await tx.walletTransaction.create({
            data: {
              user_id: Number(user.id),
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
                note: 'Paystack',
                image_src: '',
              },
              meta: {
                gross_amount: expected,
                fee,
                credited_amount: net,
                paystack_id: paystackId,
              },
            },
          });
        } catch (e) {
          if (e?.code !== 'P2002') throw e;
        }
      }

      await tx.fundingTransaction.update({
        where: { tx_ref },
        data: {
          status: 'successful',
          flutterwave_tx_id: paystackId,
          credited_at: new Date(),
          raw_payload: raw,
        },
      });
    });

    return res.json({
      remark: 'funding_success',
      status: 'success',
      message: ['Wallet funded successfully'],
      data: { tx_ref, amount: expected, fee, credited_amount: net },
    });
  } catch (e) {
    console.error('Funding verify error:', e);
    const status = Number(e?.statusCode) || 500;
    const msg = e?.message || 'Failed to verify funding';
    return res.status(status).json({ remark: 'error', status: 'error', message: [msg], data: null });
  }
}

async function reconcileWorker({ userId, pending }) {
  if (!pending?.length) return;
  if (reconcileLocks.get(userId)) return;
  reconcileLocks.set(userId, true);

  try {
    const results = [];

    for (const funding of pending) {
      const tx_ref = String(funding.tx_ref || '').trim();
      if (!tx_ref) continue;

      try {
        const { data, raw } = await verifyTransaction(tx_ref);
        const paystackStatus = (data?.status || '').toString().toLowerCase();
        const paystackCurrency = (data?.currency || '').toString().toUpperCase();
        const paystackId = data?.id != null ? String(data.id) : null;
        const amountKobo = Number(data?.amount);

        if (paystackStatus !== 'success' || paystackCurrency !== 'NGN') {
          await prisma.fundingTransaction.update({
            where: { tx_ref },
            data: { status: paystackStatus || 'failed', flutterwave_tx_id: paystackId, raw_payload: raw },
          });
          results.push({ tx_ref, status: paystackStatus || 'failed', credited: false });
          continue;
        }

        const expected = Number(funding.amount?.toString?.() ?? funding.amount);
        const paid = Number.isFinite(amountKobo) ? amountKobo / 100 : NaN;
        if (!Number.isFinite(paid) || !Number.isFinite(expected) || paid < expected) {
          results.push({ tx_ref, status: 'amount_mismatch', credited: false });
          continue;
        }

        const fee = computeFundingFee(expected);
        const net = Math.max(0, expected - fee);
        const creditAmount = new Prisma.Decimal(net.toFixed(2));
        const feeAmount = new Prisma.Decimal(fee.toFixed(2));
        const grossAmount = new Prisma.Decimal(expected.toFixed(2));

        await prisma.$transaction(async tx => {
          const latest = await tx.fundingTransaction.findUnique({ where: { tx_ref } });
          if (latest?.credited_at) return;

          await tx.user.update({
            where: { id: userId },
            data: { balance: { increment: creditAmount }, currency_symbol: '₦' },
          });

          if (tx.walletTransaction) {
            try {
              await tx.walletTransaction.create({
                data: {
                  user_id: userId,
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
                    note: 'Paystack',
                    image_src: '',
                  },
                  meta: {
                    gross_amount: expected,
                    fee,
                    credited_amount: net,
                    paystack_id: paystackId,
                  },
                },
              });
            } catch (e) {
              if (e?.code !== 'P2002') throw e;
            }
          }

          await tx.fundingTransaction.update({
            where: { tx_ref },
            data: {
              status: 'successful',
              flutterwave_tx_id: paystackId,
              credited_at: new Date(),
              raw_payload: raw,
            },
          });
        });

        results.push({ tx_ref, status: 'successful', credited: true, fee, credited_amount: net });
      } catch (e) {
        results.push({ tx_ref, status: 'error', credited: false, message: e?.message || String(e) });
      }
    }

    if (results.length) {
      console.log('Funding reconcile worker results:', { userId, resultsCount: results.length });
    }
  } finally {
    reconcileLocks.delete(userId);
  }
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

    const userId = Number(user.id);
    if (reconcileLocks.get(userId)) {
      return res.json({ remark: 'reconcile_running', status: 'success', message: ['Reconcile already running'], data: { queued: true } });
    }

    const pending = await prisma.fundingTransaction.findMany({
      where: {
        user_id: userId,
        credited_at: null,
      },
      orderBy: { id: 'desc' },
      take: 10,
    });

    if (!pending.length) {
      return res.json({ remark: 'reconcile_done', status: 'success', message: ['No pending funding to reconcile'], data: { results: [] } });
    }

    setImmediate(() => {
      reconcileWorker({ userId, pending }).catch(e => console.error('Funding reconcile worker error:', e));
    });

    return res.json({
      remark: 'reconcile_queued',
      status: 'success',
      message: ['Reconcile queued'],
      data: { queued: true, pending_count: pending.length },
    });
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

    const signature = req.headers['x-paystack-signature'];
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';
    if (!verifyWebhookSignature({ rawBody, signature })) {
      return res.status(401).send('Unauthorized');
    }

    const reference = req.body?.data?.reference || req.body?.reference;
    if (!reference) {
      return res.status(200).json({ received: true });
    }

    const tx_ref = String(reference);

    // Try to verify + credit (idempotent)
    const funding = await prisma.fundingTransaction.findUnique({ where: { tx_ref } });
    if (!funding || funding.credited_at) {
      return res.status(200).json({ received: true });
    }

    const { data, raw } = await verifyTransaction(tx_ref);
    const paystackStatus = (data?.status || '').toString().toLowerCase();
    const paystackCurrency = (data?.currency || '').toString().toUpperCase();
    const paystackId = data?.id != null ? String(data.id) : null;
    const amountKobo = Number(data?.amount);

    if (paystackStatus !== 'success' || paystackCurrency !== 'NGN') {
      await prisma.fundingTransaction.update({
        where: { tx_ref },
        data: { status: paystackStatus || 'failed', flutterwave_tx_id: paystackId, raw_payload: raw },
      });
      return res.status(200).json({ received: true });
    }

    const expectedAmount = Number(funding.amount?.toString?.() ?? funding.amount);
    const paid = Number.isFinite(amountKobo) ? amountKobo / 100 : NaN;
    if (!Number.isFinite(paid) || !Number.isFinite(expectedAmount) || paid < expectedAmount) {
      return res.status(200).json({ received: true });
    }

    const fee = computeFundingFee(expectedAmount);
    const net = Math.max(0, expectedAmount - fee);
    const creditAmount = new Prisma.Decimal(net.toFixed(2));
    const feeAmount = new Prisma.Decimal(fee.toFixed(2));
    const grossAmount = new Prisma.Decimal(expectedAmount.toFixed(2));

    await prisma.$transaction(async tx => {
      const latest = await tx.fundingTransaction.findUnique({ where: { tx_ref } });
      if (latest?.credited_at) return;

      await tx.user.update({
        where: { id: Number(funding.user_id) },
        data: { balance: { increment: creditAmount }, currency_symbol: '₦' },
      });

      if (tx.walletTransaction) {
        try {
          await tx.walletTransaction.create({
            data: {
              user_id: Number(funding.user_id),
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
                note: 'Paystack',
                image_src: '',
              },
              meta: {
                gross_amount: expectedAmount,
                fee,
                credited_amount: net,
                paystack_id: paystackId,
              },
            },
          });
        } catch (e) {
          if (e?.code !== 'P2002') throw e;
        }
      }

      await tx.fundingTransaction.update({
        where: { tx_ref },
        data: {
          status: 'successful',
          flutterwave_tx_id: paystackId,
          credited_at: new Date(),
          raw_payload: raw,
        },
      });
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
  verify,
  reconcile,
  webhook,
  callback,
};
