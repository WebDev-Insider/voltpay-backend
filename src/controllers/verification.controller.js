const prisma = require('../../database/prisma');
const bcrypt = require('bcryptjs');
const { getPending, clearPending } = require('../services/pending.service');
const { addHistory, generateTrx } = require('../services/airtime.service');
const {
  payElectricityV1,
  queryTransactionV1,
  buyDatabundleV1,
  buyAirtimeV1,
  payCableTVV1,
  fundBettingWalletV1,
} = require('../funding/clubkonnect.service');
const { getCountryByCode } = require('../helpers/country.helper');
const { Prisma } = require('@prisma/client');
const { generateNumericCode } = require('../helpers/code.helper');
const { sendResetEmail } = require('../services/email.service');

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
  return {
    remark,
    status,
    message,
    data: {
      user: {
        id: user.id,
        firstname: user.firstname,
        lastname: user.lastname,
        username: user.username,
        email: user.email,
        mobile: user.mobile,
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

    const storedPin = String(freshUser.pin || '');
    const looksHashed = storedPin.startsWith('$2a$') || storedPin.startsWith('$2b$') || storedPin.startsWith('$2y$');
    const valid = storedPin ? (looksHashed ? await bcrypt.compare(pinInput, storedPin) : storedPin === pinInput) : false;
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

    const valid = await bcrypt.compare(passwordInput, storedPassword);
    if (!valid) {
      return res.status(401).json({ remark: 'invalid_password', status: 'error', message: ['Invalid password'], data: null });
    }

    return res.json({ remark: 'password_valid', status: 'success', message: ['Password verified'], data: null });
  } catch (e) {
    console.error('validatePassword error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to validate password'], data: null });
  }
}

function normalizeMsisdn({ calling_code, mobile_number }) {
  const cc = String(calling_code || '').replace('+', '');
  const raw = String(mobile_number || '').replace(/\D/g, '');
  if (!cc) return raw;
  if (raw.startsWith(cc)) return raw;
  if (raw.startsWith('0')) return cc + raw.substring(1);
  if (raw.startsWith('+')) return raw.substring(1);
  if (raw.length <= 11) return cc + raw;
  return raw;
}

function normalizeClubKonnectMobileNumber({ calling_code, mobile_number }) {
  const cc = String(calling_code || '').replace('+', '').trim();
  const raw = String(mobile_number || '').replace(/\D/g, '');
  if (cc === '234') {
    if (raw.startsWith('0') && raw.length === 11) return raw;
    if (raw.startsWith('234') && raw.length === 13) return `0${raw.substring(3)}`;
    if (!raw.startsWith('0') && raw.length === 10) return `0${raw}`;
    if (!raw.startsWith('0') && raw.length === 11) return raw;
  }
  return raw;
}

function ckNetworkFromBillerCode(billerCode) {
  const code = String(billerCode || '').trim().toUpperCase();
  if (code === 'BIL108') return '01';
  if (code === 'BIL109') return '02';
  if (code === 'BIL111') return '03';
  if (code === 'BIL110') return '04';
  return '';
}

function ckNetworkFromOperatorName(opName) {
  const name = String(opName || '').trim().toUpperCase();
  if (name.includes('MTN')) return '01';
  if (name.includes('GLO')) return '02';
  if (name.includes('9MOBILE') || name.includes('ETISALAT')) return '03';
  if (name.includes('AIRTEL')) return '04';
  return '';
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

    const storedPin = String(freshUser.pin || '');
    const looksHashed = storedPin.startsWith('$2a$') || storedPin.startsWith('$2b$') || storedPin.startsWith('$2y$');
    const valid = storedPin ? (looksHashed ? await bcrypt.compare(pinInput, storedPin) : storedPin === pinInput) : false;
    if (!valid) {
      return res.status(401).json({ remark: 'invalid_pin', status: 'error', message: ['Invalid PIN'], data: null });
    }

    const pending = getPending(user.id, remark);
    if (!pending) {
      let msg = 'No pending airtime transaction';
      if (remark === 'electricity') msg = 'No pending electricity transaction';
      else if (remark === 'data_bundle') msg = 'No pending data transaction';
      else if (remark === 'cable_tv') msg = 'No pending cable TV transaction';
      else if (remark === 'send_money') msg = 'No pending send money transaction';
      else if (remark === 'betting') msg = 'No pending betting transaction';
      return res.status(400).json({ remark: 'no_pending', status: 'error', message: [msg], data: null });
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
          clearPending(user.id, remark);

          const receiverUserExisting = receiverId
            ? await prisma.user.findUnique({ where: { id: receiverId } })
            : null;
          const receiverCountryExisting = receiverUserExisting ? getCountryByCode(receiverUserExisting.country_code) : null;

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
                    firstname: receiverUserExisting.firstname,
                    lastname: receiverUserExisting.lastname,
                    username: receiverUserExisting.username,
                    email: receiverUserExisting.email,
                    mobile: receiverUserExisting.mobile,
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
            firstname: true,
            lastname: true,
            username: true,
            email: true,
            mobile: true,
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

        const updatedSender = await tx.user.update({
          where: { id: Number(user.id) },
          data: { balance: { decrement: debitTotal } },
          select: { id: true, balance: true },
        });
        const updatedReceiver = await tx.user.update({
          where: { id: receiverId },
          data: { balance: { increment: creditAmount } },
          select: {
            id: true,
            firstname: true,
            lastname: true,
            username: true,
            email: true,
            mobile: true,
            country_code: true,
            image: true,
            balance: true,
          },
        });

        senderAfter = Number(updatedSender.balance?.toString?.() ?? updatedSender.balance);
        receiverAfter = Number(updatedReceiver.balance?.toString?.() ?? updatedReceiver.balance);
        receiverUser = updatedReceiver;

        const receiverFullName = `${String(receiver.firstname || '').trim()} ${String(receiver.lastname || '').trim()}`.trim();
        const senderFullName = `${String(sender.firstname || '').trim()} ${String(sender.lastname || '').trim()}`.trim();

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
              details: `Sent money to ${receiverFullName}`.trim(),
              other_data: {
                title: 'Send Money',
                subtitle: receiverFullName,
                feedback: 'Successful',
                note: 'Wallet',
                image_src: receiver.image || '',
              },
              meta: {
                transfer_ref: transferRef,
                receiver_id: receiverId,
                receiver_trx: receiverTrx,
                receiver_name: receiverFullName,
                receiver_username: receiver.username,
                receiver_email: receiver.email,
                receiver_mobile: receiver.mobile,
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
              details: `Received money from ${senderFullName}`.trim(),
              other_data: {
                title: 'Money Received',
                subtitle: senderFullName,
                feedback: 'Successful',
                note: 'Wallet',
                image_src: sender.image || '',
              },
              meta: {
                transfer_ref: transferRef,
                sender_id: senderId,
                sender_trx: senderTrx,
                sender_name: senderFullName,
                sender_username: sender.username,
                sender_email: sender.email,
                sender_mobile: sender.mobile,
              },
            },
          ],
        });
      });

      clearPending(user.id, remark);

      const receiverCountry = receiverUser ? getCountryByCode(receiverUser.country_code) : null;
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
                firstname: receiverUser.firstname,
                lastname: receiverUser.lastname,
                username: receiverUser.username,
                email: receiverUser.email,
                mobile: receiverUser.mobile,
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

    const amount = Number(pending.amount ?? pending.price);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ remark: 'invalid_amount', status: 'error', message: ['Invalid amount'], data: null });
    }

    const msisdn = normalizeMsisdn({ calling_code: pending.calling_code, mobile_number: pending.mobile_number });
    const ckMobileNumber = normalizeClubKonnectMobileNumber({ calling_code: pending.calling_code, mobile_number: pending.mobile_number });
    const trx = generateTrx(
      remark === 'data_bundle'
        ? 'data'
        : (remark === 'betting'
          ? 'bet'
        : (remark === 'electricity'
          ? 'ele'
          : (remark === 'cable_tv' ? 'cbl' : 'air')))
    );

    const preBalance = Number(freshUser.balance?.toString?.() ?? freshUser.balance);
    if (!Number.isFinite(preBalance) || preBalance < amount) {
      return res.status(400).json({ remark: 'insufficient_balance', status: 'error', message: ['Insufficient balance'], data: null });
    }

    let flw;
    let token = '';
    let units = '';
    let flw_tx_ref = '';
    let flw_reference = '';
    let bill_status = '';
    try {
      if (remark === 'electricity') {
        const biller_code = String(pending.biller_code || '').trim().toUpperCase();
        const meter_number = String(pending.meter_number || pending.customer_id || '').trim().replace(/\s+/g, '');
        const meter_type = String(pending.meter_type || '').trim().toLowerCase();
        if (!biller_code || !meter_number) {
          return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid electricity pending payload'], data: null });
        }

        flw_tx_ref = trx;

        const payResp = await payElectricityV1({
          electricCompany: biller_code,
          meterType: meter_type,
          meterNo: meter_number,
          amount,
          phoneNo: ckMobileNumber,
          requestId: trx,
        });
        flw = payResp;

        try {
          flw_reference = String(payResp?.orderid || payResp?.OrderID || payResp?.order_id || payResp?.orderID || '').trim();
        } catch (_) {}

        try {
          token = String(payResp?.metertoken || payResp?.MeterToken || payResp?.meter_token || '').trim();
          units = String(payResp?.units || payResp?.Units || payResp?.unit || '').trim();
        } catch (_) {}

        try {
          const statusCode = String(payResp?.statuscode || payResp?.StatusCode || '').trim();
          const orderStatus = String(payResp?.orderstatus || payResp?.OrderStatus || payResp?.status || '').trim();
          bill_status = orderStatus || statusCode;
        } catch (_) {}

        // If token isn't present immediately (common for prepaid), attempt a quick query.
        if (!String(token || '').trim()) {
          try {
            const q = await queryTransactionV1({ orderId: flw_reference || null, requestId: trx });
            token = String(q?.metertoken || q?.MeterToken || q?.meter_token || token || '').trim();
            units = String(q?.units || q?.Units || q?.unit || units || '').trim();
            const qStatusCode = String(q?.statuscode || q?.StatusCode || '').trim();
            const qOrderStatus = String(q?.orderstatus || q?.OrderStatus || q?.status || '').trim();
            bill_status = qOrderStatus || qStatusCode || bill_status;
          } catch (_) {}
        }
      } else if (remark === 'cable_tv') {
        const biller_code = String(pending.biller_code || '').trim().toLowerCase();
        const item_code = String(pending.item_code || '').trim();
        const smart_number = String(pending.smart_number || pending.customer_id || '').trim().replace(/\s+/g, '');
        if (!biller_code || !item_code || !smart_number) {
          return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid cable TV pending payload'], data: null });
        }

        flw_tx_ref = trx;
        flw = await payCableTVV1({
          cableTv: biller_code,
          packageCode: item_code,
          smartCardNo: smart_number,
          phoneNo: ckMobileNumber,
          requestId: trx,
        });

        try {
          flw_reference = String(flw?.orderid || flw?.OrderID || flw?.order_id || flw?.orderID || '').trim();
        } catch (_) {}
        try {
          const statusCode = String(flw?.statuscode || flw?.StatusCode || '').trim();
          const orderStatus = String(flw?.orderstatus || flw?.OrderStatus || flw?.status || '').trim();
          bill_status = orderStatus || statusCode;
        } catch (_) {}
      } else if (remark === 'data_bundle') {
        const biller_code = String(pending.biller_code || '').trim().toUpperCase();
        const ckNetwork = String(pending.ck_network_code || '').trim() || ckNetworkFromBillerCode(biller_code);
        const dataPlan = String(pending.item_code || '').trim();
        if (!ckNetwork || !dataPlan) {
          return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid data pending payload'], data: null });
        }

        flw_tx_ref = trx;
        flw = await buyDatabundleV1({
          mobileNetwork: ckNetwork,
          dataPlan,
          mobileNumber: ckMobileNumber,
          requestId: trx,
        });

        try {
          flw_reference = String(flw?.orderid || flw?.OrderID || flw?.order_id || flw?.orderID || '').trim();
        } catch (_) {}
        try {
          const statusCode = String(flw?.statuscode || flw?.StatusCode || '').trim();
          const orderStatus = String(flw?.orderstatus || flw?.OrderStatus || flw?.status || '').trim();
          bill_status = orderStatus || statusCode;
        } catch (_) {}
      } else if (remark === 'betting') {
        const betting_company = String(pending.betting_company || pending.biller_code || '').trim().toUpperCase();
        const customer_id = String(pending.customer_id || '').trim().replace(/\s+/g, '');
        const customer_name = String(pending.customer_name || '').trim();
        if (!betting_company || !customer_id) {
          return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid betting pending payload'], data: null });
        }

        flw_tx_ref = trx;
        flw = await fundBettingWalletV1({
          bettingCompany: betting_company,
          customerId: customer_id,
          amount,
          requestId: trx,
          callbackUrl: undefined,
        });

        try {
          flw_reference = String(flw?.orderid || flw?.OrderID || flw?.order_id || flw?.orderID || '').trim();
        } catch (_) {}
        try {
          const statusCode = String(flw?.statuscode || flw?.StatusCode || '').trim();
          const orderStatus = String(flw?.orderstatus || flw?.OrderStatus || flw?.status || '').trim();
          bill_status = orderStatus || statusCode;
        } catch (_) {}

        // ensure we keep verified name if any
        pending.customer_name = customer_name || String(flw?.customer_name || flw?.CustomerName || '').trim() || pending.customer_name;
      } else {
        const ckNetwork = String(pending.ck_network_code || '').trim() || ckNetworkFromOperatorName(pending.operator_name);
        if (!ckNetwork) {
          return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid airtime operator'], data: null });
        }

        flw_tx_ref = trx;
        flw = await buyAirtimeV1({
          mobileNetwork: ckNetwork,
          amount,
          mobileNumber: ckMobileNumber,
          requestId: trx,
        });

        try {
          flw_reference = String(flw?.orderid || flw?.OrderID || flw?.order_id || flw?.orderID || '').trim();
        } catch (_) {}
        try {
          const statusCode = String(flw?.statuscode || flw?.StatusCode || '').trim();
          const orderStatus = String(flw?.orderstatus || flw?.OrderStatus || flw?.status || '').trim();
          bill_status = orderStatus || statusCode;
        } catch (_) {}
      }
    } catch (err) {
      const msg = err?.message || (
        remark === 'data_bundle'
          ? 'ClubKonnect data purchase failed'
          : (remark === 'electricity'
            ? 'ClubKonnect electricity purchase failed'
            : (remark === 'betting'
              ? 'ClubKonnect betting wallet funding failed'
            : (remark === 'cable_tv'
              ? 'ClubKonnect cable TV purchase failed'
              : 'ClubKonnect airtime purchase failed')))
      );
      if (remark === 'electricity' || remark === 'data_bundle' || remark === 'cable_tv' || remark === 'air_time' || remark === 'betting') {
        const payload = err?.clubkonnect || null;
        return res.status(400).json({ remark: 'provider_error', status: 'error', message: [msg], data: payload });
      }
      const payload = err?.flutterwave || null;
      return res.status(400).json({ remark: 'flutterwave_error', status: 'error', message: [msg], data: payload });
    }

    const dbElectricityMeterType = String(pending.meter_type || '').trim().toLowerCase();
    const utilityFeedback = remark === 'electricity'
      ? ((dbElectricityMeterType === 'prepaid' && !String(token || '').trim()) ? 'Processing' : 'Successful')
      : 'Successful';

    const detailsStr = remark === 'electricity'
      ? `${pending.operator_name || pending.biller_code || ''} ${pending.meter_type || ''} - ${pending.meter_number}`.trim()
      : (remark === 'betting'
        ? `${String(pending.betting_company || 'Betting').trim()} - ${String(pending.customer_id || '').trim()}`.trim()
      : (remark === 'data_bundle'
        ? `${pending.operator_name} Data - ${pending.item_name} - ${pending.calling_code}${pending.mobile_number}`
        : (remark === 'cable_tv'
          ? `${pending.operator_name || pending.biller_code || 'Cable TV'} - ${pending.smart_number || ''}`.trim()
          : `${pending.operator_name} - ${pending.calling_code}${pending.mobile_number}`)));

    const debit = new Prisma.Decimal(amount.toFixed(2));
    const zero = new Prisma.Decimal('0.00');

    let updated;
    await prisma.$transaction(async tx => {
      const u = await tx.user.findUnique({ where: { id: Number(user.id) } });
      const current = Number(u.balance?.toString?.() ?? u.balance);
      if (!Number.isFinite(current) || current < amount) {
        throw new Error('Insufficient balance');
      }
      updated = await tx.user.update({ where: { id: Number(user.id) }, data: { balance: { decrement: debit }, currency_symbol: '₦' } });

      if (tx.walletTransaction) {
        const dbRemark = remark === 'electricity'
          ? 'utility_bill'
          : (remark === 'cable_tv'
            ? 'cable_tv'
            : (remark === 'betting' ? 'betting' : 'mobile_recharge'));
        const provider = remark === 'betting'
          ? String(pending.betting_company || pending.operator_name || pending.biller_code || '')
          : String(pending.operator_name || pending.biller_code || '');
        const meterType = String(pending.meter_type || '').trim().toLowerCase();
        const meterNumber = String(pending.meter_number || pending.customer_id || '').trim().replace(/\s+/g, '');
        const customerName = String(pending.customer_name || '').trim();
        const serviceAddress = String(pending.address || '').trim();
        const bundleName = String(pending.item_name || '').trim();
        const msisdnForDb = String(msisdn || '').trim();
        const smartNumber = String(pending.smart_number || '').trim().replace(/\s+/g, '');
        const itemCode = String(pending.item_code || '').trim();
        const itemName = String(pending.item_name || '').trim();

        const bettingCompany = String(pending.betting_company || '').trim().toUpperCase();
        const bettingCustomerId = String(pending.customer_id || '').trim().replace(/\s+/g, '');
        const bettingCustomerName = String(pending.customer_name || '').trim();

        const other_data = dbRemark === 'betting'
          ? {
            title: 'Betting',
            subtitle: `${bettingCompany || provider || 'Betting'} - ${bettingCustomerId || '-'}`.trim(),
            feedback: 'Successful',
            note: bettingCustomerName || 'Wallet',
            image_src: '',
          }
          : (dbRemark === 'utility_bill'
          ? {
            title: provider || 'Electricity',
            subtitle: `${(meterType || 'prepaid').toUpperCase()} - ${meterNumber || '-'}`,
            feedback: utilityFeedback,
            note: 'Wallet',
            image_src: '',
          }
          : (dbRemark === 'cable_tv'
            ? {
              title: 'Cable TV',
              subtitle: `${String(provider || 'Provider')} - ${String(smartNumber || '-')}`.trim(),
              feedback: 'Successful',
              note: itemName || itemCode,
              image_src: '',
            }
            : {
            title: remark === 'data_bundle' ? 'Data' : 'Airtime',
            subtitle: `${String(pending.operator_name || 'Operator')} ${msisdnForDb}`.trim(),
            feedback: 'Successful',
            note: remark === 'data_bundle' ? bundleName : 'Airtime',
            image_src: '',
          }));

        let meta;
        if (dbRemark === 'betting') {
          meta = {
            provider: bettingCompany || provider,
            betting_company: bettingCompany || provider,
            customer_id: bettingCustomerId,
            customer_name: bettingCustomerName,
            flw_tx_ref: flw_tx_ref || '',
            flw_reference: flw_reference || '',
            bill_status: bill_status || '',
            ck_request_id: flw_tx_ref || '',
            ck_order_id: flw_reference || '',
          };
        } else if (dbRemark === 'utility_bill') {
          meta = {
            provider,
            meter_number: meterNumber,
            meter_type: meterType,
            customer_name: customerName,
            address: serviceAddress,
            token: token || '',
            units: units || '',
            flw_tx_ref: flw_tx_ref || '',
            flw_reference: flw_reference || '',
            bill_status: bill_status || '',
            ck_request_id: flw_tx_ref || '',
            ck_order_id: flw_reference || '',
          };
        } else if (dbRemark === 'cable_tv') {
          meta = {
            provider,
            biller_code: String(pending.biller_code || '').trim().toLowerCase(),
            item_code: itemCode,
            item_name: itemName,
            smart_number: smartNumber,
            customer_id: smartNumber,
            customer_name: '',
            address: '',
            flw_tx_ref: flw_tx_ref || '',
            flw_reference: flw_reference || '',
            bill_status: bill_status || '',
            ck_request_id: flw_tx_ref || '',
            ck_order_id: flw_reference || '',
          };
        } else {
          meta = {
            operator: String(pending.operator_name || ''),
            mobile: msisdnForDb,
            bundle: bundleName,
            type: remark === 'data_bundle' ? 'data' : 'airtime',
          };
          if (remark === 'air_time') {
            meta.ck_request_id = flw_tx_ref || '';
            meta.ck_order_id = flw_reference || '';
            meta.bill_status = bill_status || '';
            meta.ck_network_code = String(pending.ck_network_code || ckNetworkFromOperatorName(pending.operator_name) || '');
          }
          if (remark === 'data_bundle') {
            meta.ck_request_id = flw_tx_ref || '';
            meta.ck_order_id = flw_reference || '';
            meta.bill_status = bill_status || '';
            meta.ck_network_code = String(pending.ck_network_code || '');
            meta.dataplan = String(pending.item_code || '');
          }
        }

        try {
          await tx.walletTransaction.create({
            data: {
              user_id: Number(user.id),
              trx: String(trx),
              trx_type: '-',
              amount: debit,
              charge: zero,
              total_amount: debit,
              remark: dbRemark,
              details: String(detailsStr || ''),
              other_data,
              meta,
            },
          });
        } catch (e) {
          if (e?.code !== 'P2002') throw e;
        }
      }
    });

    const post_balance = Number(updated.balance?.toString?.() ?? updated.balance);

    const operator = remark === 'electricity'
      ? { id: pending.operator_id || 0, name: pending.biller_code || 'Electricity', logo_urls: [''] }
      : (remark === 'betting'
        ? { id: 0, name: 'Betting', logo_urls: [''] }
        : { id: pending.operator_id, name: pending.operator_name, logo_urls: [''] });

    const details = detailsStr;

    const record = {
      id: Date.now(),
      operator_id: pending.operator_id,
      amount,
      charge: 0,
      post_balance: post_balance,
      trx,
      details,
      dial_code: pending.calling_code,
      mobile_number: pending.mobile_number,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      operator,
      remark: remark === 'data_bundle'
        ? 'data'
        : (remark === 'electricity'
          ? 'electricity'
          : (remark === 'cable_tv'
            ? 'cable_tv'
            : (remark === 'betting' ? 'betting' : 'air_time'))),
    };
    addHistory(user.id, record);

    clearPending(user.id, remark);

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
        remark: remark === 'data_bundle'
          ? 'data'
          : (remark === 'electricity'
            ? 'electricity'
            : (remark === 'cable_tv'
              ? 'cable_tv'
              : (remark === 'betting' ? 'betting' : 'air_time'))),
        details: record.details,
        receiver_id: null,
        receiver_type: null,
        trx,
        updated_at: record.updated_at,
        created_at: record.created_at,
        id: record.id,
      },
      token,
      units,
    };

    const successRemark = remark === 'electricity'
      ? 'electricity_success'
      : (remark === 'data_bundle'
        ? 'data_success'
        : (remark === 'cable_tv'
          ? 'cable_tv_success'
          : (remark === 'betting' ? 'betting_success' : 'airtime_success')));

    const isElectricityProcessing = remark === 'electricity'
      && dbElectricityMeterType === 'prepaid'
      && !String(token || '').trim();

    const successMsg = remark === 'electricity'
      ? (isElectricityProcessing
        ? 'Electricity payment is processing. Please refresh later to get your token.'
        : 'Electricity purchased successfully')
      : (remark === 'data_bundle'
        ? 'Data purchased successfully'
        : (remark === 'cable_tv'
          ? 'Cable TV purchased successfully'
          : (remark === 'betting' ? 'Betting wallet funded successfully' : 'Airtime purchased successfully')));

    return res.json({ remark: successRemark, status: 'success', message: [successMsg], data });
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

    const target = type === 'email' ? fresh.email : fresh.mobile;
    if (type === 'email' && (!target || !String(target).trim())) {
      return res.status(200).json(buildAuthLikeResponse({ remark: 'validation_error', status: 'error', message: ['Email is required to resend code'], user: fresh }));
    }

    const { code } = await issueVerificationCode({ userId: fresh.id, type, target });

    if (type === 'email') {
      const sendResult = await sendResetEmail(String(fresh.email).trim(), code, process.env.RESEND_FROM, { type: 'email_verification' });
      if (!sendResult || !sendResult.queued) {
        console.error('❌ resendVerify email not queued:', sendResult && sendResult.error ? sendResult.error : 'unknown reason');

        const devBypass = String(process.env.DEV_BYPASS_EMAIL_OTP || '').trim().toLowerCase() === 'true';
        if (devBypass) {
          console.log(`✉️  [DEV BYPASS] Email verification code for ${String(fresh.email).trim()}: ${code}`);

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
      console.log(`📱 [DEV MODE] Would send mobile verification code to ${target}: ${code}`);
    }

    return res.json(buildAuthLikeResponse({ remark: 'code_resent', status: 'success', message: ['Verification code resent successfully'], user: fresh }));
  } catch (e) {
    console.error('resendVerify error:', e);
    return res.status(500).json({ remark: 'error', status: 'error', message: ['Failed to resend verification code'], data: null });
  }
}

module.exports = { verifyPin, validatePin, validatePassword, verifyEmail, verifyMobile, resendVerify };
