const prisma = require('../../database/prisma');
const { getPending, clearPending } = require('../services/pending.service');
const { addHistory, generateTrx } = require('../services/airtime.service');
const { applyBalanceDelta } = require('../helpers/balance.helper');
const { verifySecret, revealUserFields, protectText } = require('../helpers/pii.helper');
const { createOrder, resolveBettingItemId, verifyOrder } = require('../funding/payvesselBiller.service');
const { getCountryByCode } = require('../helpers/country.helper');
const { Prisma } = require('@prisma/client');
const { generateNumericCode } = require('../helpers/code.helper');
const { sendResetEmail } = require('../services/email.service');
const { logMoneyEvent } = require('../services/userAudit.service');
const { checkVelocity } = require('../helpers/velocity.helper');
const { clearAcknowledgement } = require('../helpers/beneficiary.helper');
const { isFeatureEnabled } = require('../helpers/featureFlag.helper');

// verifyPin settles two different rails, so the switch is picked per pending
// remark rather than mounted on the route.
const FEATURE_FOR_REMARK = { send_money: 'send_money', betting: 'betting' };

function moneyStr(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0.00';
  return num.toFixed(2);
}

const VERIFICATION_CODE_TTL_MS = 5 * 60 * 1000;

function normalizeVerificationType(type) {
  const t = String(type || '').trim().toLowerCase();
  if (t === 'email') return 'email';
  if (t === 'mobile' || t === 'sms') return 'mobile';
  return '';
}

async function issueVerificationCode({ userId, type, target }) {
  const code = generateNumericCode(6);
  const row = await prisma.verificationCode.create({
    data: {
      user_id: Number(userId),
      type: String(type),
      target: target ? String(target).trim() : null,
      code: String(code),
      expires_at: new Date(Date.now() + VERIFICATION_CODE_TTL_MS),
      used: false,
    },
  });
  return { row, code };
}

async function findValidVerificationCode({ userId, type, code }) {
  const normalizedCode = String(code).trim().padStart(6, '0');
  return await prisma.verificationCode.findFirst({
    where: {
      user_id: Number(userId),
      type: String(type),
      code: normalizedCode,
      used: false,
      expires_at: { gt: new Date() },
    },
    orderBy: { created_at: 'desc' },
  });
}

function buildAuthLikeResponse({ remark, status, message, user }) {
  const countryDetails = getCountryByCode(user.country_code);
  const pii = revealUserFields(user);
  return {
    remark,
    status,
    message,
    data: {
      user: {
        id: user.id,
        firstname: pii.firstname,
        lastname: pii.lastname,
        username: pii.username,
        email: pii.email,
        mobile: pii.mobile,
        country_code: user.country_code,
        country_name: countryDetails.name,
        country_flag: countryDetails.image_src,
        dial_code: countryDetails.dial_code,
        balance: user.balance,
        currency_symbol: user.currency_symbol || '₦',
        profile_complete: user.profile_complete,
        status: user.status,
        ev: user.ev,
        sv: user.sv,
        tv: user.tv,
        kv: user.kv,
        image: user.image,
        created_at: user.created_at,
        updated_at: user.updated_at,
      },
    },
  };
}

async function validatePin(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const pinInput = String(req.body?.pin || '').trim();
    if (!pinInput) return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['PIN is required'], data: null });

    const freshUser = await prisma.user.findUnique({ where: { id: Number(user.id) } });
    if (!freshUser) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login again'], data: null });

    const valid = (await verifySecret(pinInput, freshUser.pin, 'pin')).ok;
    if (!valid) {
      return res.status(401).json({ remark: 'invalid_pin', status: 'error', message: ['Invalid PIN'], data: null });
    }

    return res.json({ remark: 'pin_valid', status: 'success', message: ['PIN verified'], data: null });
  } catch (e) {
    console.error('validatePin error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to validate PIN'], data: null });
  }
}

async function validatePassword(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const passwordInput = String(req.body?.password || '').trim();
    if (!passwordInput) return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Password is required'], data: null });

    const freshUser = await prisma.user.findUnique({ where: { id: Number(user.id) } });
    if (!freshUser) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login again'], data: null });

    const storedPassword = String(freshUser.password || '').trim();
    if (!storedPassword) {
      return res.status(400).json({ remark: 'password_not_set', status: 'error', message: ['Password not set for this account'], data: null });
    }

    const valid = (await verifySecret(passwordInput, storedPassword, 'password')).ok;
    if (!valid) {
      return res.status(401).json({ remark: 'invalid_password', status: 'error', message: ['Invalid password'], data: null });
    }

    return res.json({ remark: 'password_valid', status: 'success', message: ['Password verified'], data: null });
  } catch (e) {
    console.error('validatePassword error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to validate password'], data: null });
  }
}

async function verifyPin(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const pinInput = String(req.body?.pin || '').trim();
    const remark = String(req.body?.remark || 'air_time');
    if (!pinInput) return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['PIN is required'], data: null });

    const freshUser = await prisma.user.findUnique({ where: { id: Number(user.id) } });
    if (!freshUser) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login again'], data: null });

    const valid = (await verifySecret(pinInput, freshUser.pin, 'pin')).ok;
    if (!valid) {
      return res.status(401).json({ remark: 'invalid_pin', status: 'error', message: ['Invalid PIN'], data: null });
    }

    const pending = await getPending(user.id, remark);
    if (!pending) {
      let msg = 'No pending airtime transaction';
      if (remark === 'electricity') msg = 'No pending electricity transaction';
      else if (remark === 'data_bundle') msg = 'No pending data transaction';
      else if (remark === 'cable_tv') msg = 'No pending cable TV transaction';
      else if (remark === 'send_money') msg = 'No pending send money transaction';
      else if (remark === 'betting') msg = 'No pending betting transaction';
      return res.status(400).json({ remark: 'no_pending', status: 'error', message: [msg], data: null });
    }

    // The kill switch is checked again here, not only on the route that priced
    // this. A pending payload lives five minutes; a rail switched off inside
    // that window must not settle anyway - that is the whole point of a switch.
    const gatedFeature = FEATURE_FOR_REMARK[remark];
    if (gatedFeature && !(await isFeatureEnabled(gatedFeature))) {
      return res.status(503).json({
        remark: 'feature_disabled',
        status: 'error',
        message: ['This service is temporarily unavailable. Please try again shortly.'],
        data: null,
      });
    }

    if (remark === 'send_money') {
      const amount = Number(pending.amount);
      const charge = Number(pending.charge || 0);
      const total = Number(pending.total_amount ?? (amount + charge));
      const receiverId = Number(pending.receiver_id);
      const transferRef = String(pending.transfer_ref || pending.transferRef || generateTrx('sm'));

      if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(total) || total <= 0) {
        return res.status(400).json({ remark: 'invalid_amount', status: 'error', message: ['Invalid amount'], data: null });
      }
      if (!receiverId) {
        return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid receiver'], data: null });
      }

      const senderTrx = `${transferRef}_s`;
      const receiverTrx = `${transferRef}_r`;

      try {
        const already = await prisma.walletTransaction.findUnique({ where: { trx: senderTrx } });
        if (already) {
          await clearPending(user.id, remark);

          const receiverUserExisting = receiverId
            ? await prisma.user.findUnique({ where: { id: receiverId } })
            : null;
          const receiverCountryExisting = receiverUserExisting ? getCountryByCode(receiverUserExisting.country_code) : null;
          const receiverExistingPii = revealUserFields(receiverUserExisting);

          const data = {
            send_money: {
              user_id: Number(user.id),
              before_charge: moneyStr(total),
              amount: moneyStr(amount),
              post_balance: null,
              charge: moneyStr(charge),
              charge_type: 'none',
              trx_type: 'debit',
              remark: 'send_money',
              details: `Send money`,
              receiver_id: receiverId,
              receiver_type: 'user',
              trx: senderTrx,
              updated_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
              id: already.id,
              receiver_user: receiverUserExisting
                ? {
                    id: receiverUserExisting.id,
                    firstname: receiverExistingPii.firstname,
                    lastname: receiverExistingPii.lastname,
                    username: receiverExistingPii.username,
                    email: receiverExistingPii.email,
                    mobile: receiverExistingPii.mobile,
                    dial_code: receiverCountryExisting?.dial_code,
                    country_code: receiverUserExisting.country_code,
                    country_name: receiverCountryExisting?.name,
                    country_flag: receiverCountryExisting?.image_src,
                    image: receiverUserExisting.image,
                    image_src: receiverUserExisting.image,
                  }
                : null,
            },
          };

          return res.json({ remark: 'send_money_success', status: 'success', message: ['Money sent successfully'], data });
        }
      } catch (_) {
        // ignore idempotency check errors and proceed with normal flow
      }

      // Re-checked here, not only where the transfer was priced.
      //
      // sendMoney.controller checks velocity at quote time - before the pending
      // payload is written, and before the new-beneficiary confirmation sends
      // the user round again. That is the wrong side of a five-minute window:
      // velocity counts SETTLED ledger rows, so a transfer quoted at T and
      // confirmed at T+4min is scored against a count that has since moved. Pay
      // four bills in between and the hourly ceiling is overshot by a whole
      // transfer - ₦1m against a ₦500k cap.
      //
      // Bills, request-money and betting all check at the settle step for this
      // reason. Transfers are the path the control was written for in the first
      // place: velocity.helper's own header names the stolen handset with a
      // known PIN, and a transfer is what that handset makes.
      //
      // BELOW the idempotency short-circuit on purpose. A retried confirm of a
      // transfer that already settled must hand back the original result, not a
      // 429 - the money moved once, and the ledger row it would now be counted
      // against is its own.
      const velocity = await checkVelocity({ userId: user.id, amount: total });
      if (!velocity.ok) {
        return res.status(429).json({
          remark: 'velocity_limit',
          status: 'error',
          message: [velocity.message],
          data: { reason: velocity.reason, retry_after_minutes: velocity.retryAfterMinutes },
        });
      }

      const debitTotal = new Prisma.Decimal(total.toFixed(2));
      const creditAmount = new Prisma.Decimal(amount.toFixed(2));
      const chargeDec = new Prisma.Decimal((Number.isFinite(charge) ? charge : 0).toFixed(2));
      const zero = new Prisma.Decimal('0.00');

      let senderAfter = null;
      let receiverUser = null;
      let receiverAfter = null;

      await prisma.$transaction(async tx => {
        const senderId = Number(user.id);
        const users = await tx.user.findMany({
          where: { id: { in: [senderId, receiverId] } },
          select: {
            id: true,
            firstname_enc: true,
            lastname_enc: true,
            username_enc: true,
            email_enc: true,
            mobile_enc: true,
            country_code: true,
            image: true,
            status: true,
            balance: true,
          },
        });

        const sender = users.find(u => Number(u.id) === senderId) || null;
        if (!sender) throw new Error('Please login again');
        const senderBal = Number(sender.balance?.toString?.() ?? sender.balance);
        if (!Number.isFinite(senderBal) || senderBal < total) {
          const err = new Error('Insufficient balance');
          err.code = 'INSUFFICIENT';
          throw err;
        }

        const receiver = users.find(u => Number(u.id) === receiverId) || null;
        if (!receiver) {
          const err = new Error('Recipient not found');
          err.code = 'RECEIVER_NOT_FOUND';
          throw err;
        }
        if (Number(receiver.status) !== 1) {
          const err = new Error('Recipient account is blocked');
          err.code = 'RECEIVER_BLOCKED';
          throw err;
        }

        const updatedSender = await applyBalanceDelta(tx, 'user', user.id, debitTotal.negated());
        const updatedReceiver = await applyBalanceDelta(tx, 'user', receiverId, creditAmount);

        senderAfter = Number(updatedSender.balance?.toString?.() ?? updatedSender.balance);
        receiverAfter = Number(updatedReceiver.balance?.toString?.() ?? updatedReceiver.balance);
        receiverUser = updatedReceiver;

        const receiverPii = revealUserFields(receiver);
        const senderPii = revealUserFields(sender);
        const receiverFullName = `${String(receiverPii.firstname || '').trim()} ${String(receiverPii.lastname || '').trim()}`.trim();
        const senderFullName = `${String(senderPii.firstname || '').trim()} ${String(senderPii.lastname || '').trim()}`.trim();

        await tx.walletTransaction.createMany({
          data: [
            {
              user_id: senderId,
              trx: senderTrx,
              trx_type: '-',
              amount: creditAmount,
              charge: chargeDec,
              total_amount: debitTotal,
              remark: 'send_money',
              details: protectText(`Sent money to ${receiverFullName}`.trim()),
              other_data: {
                title: 'Send Money',
                subtitle: protectText(receiverFullName),
                feedback: 'Successful',
                note: 'Wallet',
                image_src: receiver.image || '',
              },
              // Only ids here. Name/username/email/mobile were duplicated from
              // the user row and are recoverable from receiver_id when needed.
              meta: {
                transfer_ref: transferRef,
                receiver_id: receiverId,
                receiver_trx: receiverTrx,
              },
            },
            {
              user_id: receiverId,
              trx: receiverTrx,
              trx_type: '+',
              amount: creditAmount,
              charge: zero,
              total_amount: creditAmount,
              remark: 'receive_money',
              details: protectText(`Received money from ${senderFullName}`.trim()),
              other_data: {
                title: 'Money Received',
                subtitle: protectText(senderFullName),
                feedback: 'Successful',
                note: 'Wallet',
                image_src: sender.image || '',
              },
              meta: {
                transfer_ref: transferRef,
                sender_id: senderId,
                sender_trx: senderTrx,
              },
            },
          ],
        });
      });

      await clearPending(user.id, remark);
      // The ledger now proves the recipient is known, so the ack has done its
      // job. Dropping it keeps the next transfer from reading a stale one.
      await clearAcknowledgement(user.id, receiverId);
      await logMoneyEvent({
        req,
        userId: user.id,
        event: 'send_money',
        trx: senderTrx,
        amount: total,
        counterpartyId: receiverId,
        extra: { charge: Number(charge) || 0 },
      });

      const receiverCountry = receiverUser ? getCountryByCode(receiverUser.country_code) : null;
      const receiverUserPii = revealUserFields(receiverUser);
      const data = {
        send_money: {
          user_id: Number(user.id),
          before_charge: moneyStr(total),
          amount: moneyStr(amount),
          post_balance: moneyStr(senderAfter ?? 0),
          charge: moneyStr(charge),
          charge_type: 'none',
          trx_type: 'debit',
          remark: 'send_money',
          details: `Send money`,
          receiver_id: receiverId,
          receiver_type: 'user',
          trx: senderTrx,
          updated_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          id: Date.now(),
          receiver_user: receiverUser
            ? {
                id: receiverUser.id,
                firstname: receiverUserPii.firstname,
                lastname: receiverUserPii.lastname,
                username: receiverUserPii.username,
                email: receiverUserPii.email,
                mobile: receiverUserPii.mobile,
                dial_code: receiverCountry?.dial_code,
                country_code: receiverUser.country_code,
                country_name: receiverCountry?.name,
                country_flag: receiverCountry?.image_src,
                image: receiverUser.image,
                image_src: receiverUser.image,
              }
            : null,
        },
      };

      return res.json({ remark: 'send_money_success', status: 'success', message: ['Money sent successfully'], data });
    }

    // Airtime, data, TV subscription and electricity moved to the bills rail
    // (POST /bills/:service/confirm), which owns its own PIN check, debit and
    // ledger write. Betting is the only rail still settled here.
    if (remark !== 'betting') {
      return res.status(400).json({
        remark: 'unsupported_remark',
        status: 'error',
        message: ['This payment type is no longer confirmed here'],
        data: null,
      });
    }

    const amount = Number(pending.amount ?? pending.price);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ remark: 'invalid_amount', status: 'error', message: ['Invalid amount'], data: null });
    }

    // Payvessel `biller_id`, case-sensitive - do not normalise it.
    const bettingCompany = String(pending.betting_company || pending.biller_code || '').trim();
    const bettingCompanyName = String(pending.betting_company_name || '').trim() || bettingCompany;
    const bettingCustomerId = String(pending.customer_id || '').trim().replace(/\s+/g, '');
    if (!bettingCompany || !bettingCustomerId) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid betting pending payload'], data: null });
    }

    const trx = generateTrx('bet');

    const preBalance = Number(freshUser.balance?.toString?.() ?? freshUser.balance);
    if (!Number.isFinite(preBalance) || preBalance < amount) {
      return res.status(400).json({ remark: 'insufficient_balance', status: 'error', message: ['Insufficient balance'], data: null });
    }

    // Checked here rather than at quote time: betting funds an external wallet
    // over a GET that cannot be reversed, so the last gate before dispatch is
    // the only one that counts.
    const bettingVelocity = await checkVelocity({ userId: user.id, amount });
    if (!bettingVelocity.ok) {
      return res.status(429).json({
        remark: 'velocity_limit',
        status: 'error',
        message: [bettingVelocity.message],
        data: { reason: bettingVelocity.reason, retry_after_minutes: bettingVelocity.retryAfterMinutes },
      });
    }

    // Resolved at verify time and carried in the pending payload; looked up
    // again only if the payload predates that.
    let itemId = String(pending.item_id || '').trim();

    let providerRef = '';
    let orderStatus = 'processing';
    try {
      if (!itemId) itemId = await resolveBettingItemId(bettingCompany);

      const base = String(process.env.PUBLIC_BASE_URL || process.env.APP_URL || process.env.BACKEND_URL || '')
        .trim()
        .replace(/\/+$/, '');

      const order = await createOrder({
        billerId: bettingCompany,
        itemId,
        rechargeAccount: bettingCustomerId,
        amount,
        reference: trx,
        // Only sent when the deployment has a reachable public URL. Without it
        // the receipt requery (GET /betting/query) is what settles the row.
        webhookUrl: base ? `${base}${process.env.API_PREFIX || '/api'}/betting/callback` : undefined,
      });

      providerRef = order.order_reference || '';
      orderStatus = order.status;

      // Rejected outright: nothing was funded and nothing was charged, so the
      // wallet is never touched.
      if (orderStatus === 'failed') {
        return res.status(400).json({
          remark: 'provider_error',
          status: 'error',
          message: [order.error_message || 'Betting wallet funding failed'],
          data: null,
        });
      }
    } catch (err) {
      // A create that never came back may still have landed - the order is
      // keyed on our own `trx`, so ask before concluding nobody was charged.
      // If it exists, Payvessel has already debited us and credited the
      // customer's betting wallet, and walking away would leave the user's
      // wallet untouched for a top-up they received.
      let recovered = null;
      try {
        recovered = await verifyOrder(trx);
      } catch {
        recovered = null;
      }

      if (!recovered || recovered.status === 'failed') {
        return res.status(err?.statusCode === 503 ? 503 : 400).json({
          remark: 'provider_error',
          status: 'error',
          message: [err?.message || 'Betting wallet funding failed'],
          data: null,
        });
      }

      providerRef = recovered.order_reference || '';
      orderStatus = recovered.status;
    }

    const detailsStr = `${bettingCompanyName} - ${bettingCustomerId}`;

    const debit = new Prisma.Decimal(amount.toFixed(2));
    const zero = new Prisma.Decimal('0.00');

    let updated;
    await prisma.$transaction(async tx => {
      const u = await tx.user.findUnique({ where: { id: Number(user.id) } });
      const current = Number(u.balance?.toString?.() ?? u.balance);
      if (!Number.isFinite(current) || current < amount) {
        throw new Error('Insufficient balance');
      }
      updated = await applyBalanceDelta(tx, 'user', user.id, debit.negated());
      await tx.user.update({ where: { id: Number(user.id) }, data: { currency_symbol: '₦' } });

      try {
        await tx.walletTransaction.create({
          data: {
            user_id: Number(user.id),
            trx: String(trx),
            trx_type: '-',
            amount: debit,
            charge: zero,
            total_amount: debit,
            remark: 'betting',
            details: protectText(detailsStr),
            other_data: {
              title: 'Betting',
              subtitle: protectText(detailsStr),
              // Payvessel fulfils after it accepts, so an accepted order is
              // not a funded betting wallet. The webhook or the receipt
              // requery flips this through betting.controller `settleOrder`.
              feedback: orderStatus === 'success' ? 'Successful' : 'Processing',
              note: 'Wallet',
              image_src: '',
            },
            // The betting account id names the counterparty, so it stays out
            // of meta - only the company and the provider references go here.
            meta: {
              gateway: 'payvessel',
              provider: bettingCompanyName,
              betting_company: bettingCompany,
              item_id: itemId,
              bill_status: orderStatus === 'success' ? 'successful' : 'processing',
              reference: trx,
              provider_reference: providerRef || '',
            },
          },
        });
      } catch (e) {
        if (e?.code !== 'P2002') throw e;
      }
    });

    const post_balance = Number(updated.balance?.toString?.() ?? updated.balance);

    const record = {
      id: Date.now(),
      operator_id: pending.operator_id,
      amount,
      charge: 0,
      post_balance,
      trx,
      details: detailsStr,
      dial_code: pending.calling_code,
      mobile_number: pending.mobile_number,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      operator: { id: 0, name: 'Betting', logo_urls: [''] },
      remark: 'betting',
    };
    addHistory(user.id, record);

    await clearPending(user.id, remark);
    await logMoneyEvent({
      req,
      userId: user.id,
      event: 'betting',
      trx,
      amount,
      extra: { provider: bettingCompany, order_id: providerRef || null },
    });

    const data = {
      redirect_type: null,
      airtime: {
        user_id: Number(user.id),
        total: moneyStr(amount),
        amount: moneyStr(amount),
        post_balance: moneyStr(post_balance),
        charge: '0.00',
        charge_type: 'none',
        trx_type: 'debit',
        remark: 'betting',
        details: record.details,
        receiver_id: null,
        receiver_type: null,
        trx,
        updated_at: record.updated_at,
        created_at: record.created_at,
        id: record.id,
      },
      token: '',
      units: '',
      // Payvessel accepts first and funds afterwards, so an accepted order is
      // not yet a funded betting wallet. The receipt sheet reads this to say
      // "processing" instead of claiming a delivery that has not happened.
      status: orderStatus === 'success' ? 'successful' : 'processing',
      provider_reference: providerRef || '',
    };

    return res.json({
      remark: 'betting_success',
      status: 'success',
      message: [
        orderStatus === 'success'
          ? 'Betting wallet funded successfully'
          : 'Payment received. Your betting wallet will be credited shortly.',
      ],
      data,
    });
  } catch (e) {
    const msg = e?.message || 'Failed to verify PIN';
    return res.status(400).json({ remark: 'error', status: 'error', message: [msg], data: null });
  }
}

async function verifyEmail(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const code = req.body?.code;
    if (!code) {
      return res.status(200).json(buildAuthLikeResponse({ remark: 'validation_error', status: 'error', message: ['Code is required'], user }));
    }

    const found = await findValidVerificationCode({ userId: user.id, type: 'email', code });
    if (!found) {
      return res.status(200).json(buildAuthLikeResponse({ remark: 'invalid_or_expired_code', status: 'error', message: ['Invalid or expired verification code'], user }));
    }

    await prisma.$transaction([
      prisma.verificationCode.update({ where: { id: found.id }, data: { used: true } }),
      prisma.user.update({ where: { id: Number(user.id) }, data: { ev: '1' } }),
    ]);

    const updated = await prisma.user.findUnique({ where: { id: Number(user.id) } });
    return res.json(buildAuthLikeResponse({ remark: 'email_verified', status: 'success', message: ['Email verified successfully'], user: updated }));
  } catch (e) {
    console.error('verifyEmail error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to verify email'], data: null });
  }
}

async function verifyMobile(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const code = req.body?.code;
    if (!code) {
      return res.status(200).json(buildAuthLikeResponse({ remark: 'validation_error', status: 'error', message: ['Code is required'], user }));
    }

    const found = await findValidVerificationCode({ userId: user.id, type: 'mobile', code });
    if (!found) {
      return res.status(200).json(buildAuthLikeResponse({ remark: 'invalid_or_expired_code', status: 'error', message: ['Invalid or expired verification code'], user }));
    }

    await prisma.$transaction([
      prisma.verificationCode.update({ where: { id: found.id }, data: { used: true } }),
      prisma.user.update({ where: { id: Number(user.id) }, data: { sv: '1' } }),
    ]);

    const updated = await prisma.user.findUnique({ where: { id: Number(user.id) } });
    return res.json(buildAuthLikeResponse({ remark: 'mobile_verified', status: 'success', message: ['Mobile verified successfully'], user: updated }));
  } catch (e) {
    console.error('verifyMobile error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to verify mobile'], data: null });
  }
}

async function resendVerify(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const type = normalizeVerificationType(req.params?.type);
    if (!type) {
      return res.status(200).json(buildAuthLikeResponse({ remark: 'validation_error', status: 'error', message: ['Invalid verification type'], user }));
    }

    const fresh = await prisma.user.findUnique({ where: { id: Number(user.id) } });
    if (!fresh) {
      return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login again'], data: null });
    }

    const freshPii = revealUserFields(fresh);
    const target = type === 'email' ? freshPii.email : freshPii.mobile;
    if (type === 'email' && (!target || !String(target).trim())) {
      return res.status(200).json(buildAuthLikeResponse({ remark: 'validation_error', status: 'error', message: ['Email is required to resend code'], user: fresh }));
    }

    const { code } = await issueVerificationCode({ userId: fresh.id, type, target });

    if (type === 'email') {
      const sendResult = await sendResetEmail(String(freshPii.email).trim(), code, process.env.RESEND_FROM, { type: 'email_verification' });
      if (!sendResult || !sendResult.queued) {
        console.error('❌ resendVerify email not queued:', sendResult && sendResult.error ? sendResult.error : 'unknown reason');

        const devBypass = String(process.env.DEV_BYPASS_EMAIL_OTP || '').trim().toLowerCase() === 'true';
        if (devBypass) {
          console.log(`✉️  [DEV BYPASS] Email verification code for user ${fresh.id}: ${code}`);

          const includeCode = String(process.env.DEV_INCLUDE_OTP_IN_RESPONSE || '').trim().toLowerCase() === 'true';
          const devMessage = includeCode
            ? ['Verification code generated (dev bypass enabled).', `Code: ${String(code)}`]
            : ['Verification code generated (dev bypass enabled). Check server logs for the code.'];

          const response = buildAuthLikeResponse({
            remark: 'code_resent',
            status: 'success',
            message: devMessage,
            user: fresh,
          });
          response.data = response.data || {};
          response.data.debug_code = includeCode ? String(code) : undefined;
          response.data.email_delivery = 'bypassed';
          return res.json(response);
        }

        return res.status(200).json(buildAuthLikeResponse({ remark: 'email_send_failed', status: 'error', message: ['Unable to resend code. Please try again later.'], user: fresh }));
      }
    } else {
      // SMS sending not integrated yet; keep code stored and acknowledge for now.
      console.log(`📱 [DEV MODE] Mobile verification code for user ${fresh.id}: ${code}`);
    }

    return res.json(buildAuthLikeResponse({ remark: 'code_resent', status: 'success', message: ['Verification code resent successfully'], user: fresh }));
  } catch (e) {
    console.error('resendVerify error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to resend verification code'], data: null });
  }
}

module.exports = { verifyPin, validatePin, validatePassword, verifyEmail, verifyMobile, resendVerify };
