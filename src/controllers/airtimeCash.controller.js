// Airtime to Cash - the customer's side. The engine is
// services/airtimeCash.service.js; this file is HTTP in and out.
//
//   GET  /airtime-cash                              home: totals, rates, recent
//   GET  /airtime-cash/conversions                  history, paged, by status
//   GET  /airtime-cash/conversions/:id              one conversion + timeline
//   POST /airtime-cash/start                        { network, phone }   -> code to the line
//   POST /airtime-cash/conversions/:id/resend                            -> another code
//   POST /airtime-cash/conversions/:id/verify       { otp }
//   POST /airtime-cash/conversions/:id/convert      { amount, share_pin }
//   GET  /airtime-cash/withdraw                     what can be withdrawn, and where to
//   POST /airtime-cash/payout-account/resolve       { bank_code, account_number }
//   POST /airtime-cash/withdraw                     { conversion_ids | 'all', account, pin, save_account }
//   GET  /airtime-cash/withdrawals/:id              a withdrawal's status, for the receipt
//
// Nothing logged here carries the body: it holds the Share & Sell PIN, the
// VoltPay PIN, an OTP and an account number.
const prisma = require('../../database/prisma');
const service = require('../services/airtimeCash.service');
const A2C = require('../helpers/airtimeCash.helper');
const { isKycVerified } = require('../helpers/kycGate.helper');
const { isFeatureEnabled } = require('../helpers/featureFlag.helper');
const { revealUserFields } = require('../helpers/pii.helper');
const { profileName } = require('../helpers/nameMatch.helper');

function ok(res, remark, message, data = null) {
  return res.json({ remark, status: 'success', message: [message], data });
}

function fail(res, status, remark, message, data = null) {
  return res.status(status).json({ remark, status: 'error', message: [message], data });
}

/** A refusal the service worded for the customer, or a 500 that says nothing. */
function sendError(res, e, req, where, fallback) {
  if (e?.remark && e?.statusCode) return fail(res, e.statusCode, e.remark, e.message, e.data || null);
  console.error(`airtimeCash.${where} error:`, { user_id: req.user?.id, message: e?.message });
  return fail(res, 500, 'error', fallback);
}

async function home(req, res) {
  try {
    const uid = Number(req.user.id);
    const [summary, recent, conversionsOn, withdrawalsOn, verified] = await Promise.all([
      service.summaryFor(uid),
      service.listConversions({ userId: uid, perPage: 20 }),
      isFeatureEnabled('airtime_cash'),
      isFeatureEnabled('withdrawals'),
      A2C.requireKyc() ? isKycVerified(uid) : true,
    ]);
    const limits = A2C.limits();

    return ok(res, 'airtime_cash', 'OK', {
      summary,
      // The customer's rate and fee only. What MySubWallet pays us is not theirs.
      networks: A2C.NETWORK_CODES.map(A2C.publicNetwork),
      limits: {
        min_amount: limits.min,
        max_amount: limits.max,
        daily_limit: limits.daily,
        otp_seconds: A2C.otpTtlSeconds(),
      },
      kyc: { required: A2C.requireKyc(), verified: Boolean(verified) },
      service: { conversions_enabled: conversionsOn, withdrawals_enabled: withdrawalsOn },
      conversions: recent.conversions,
      has_more: recent.has_more,
    });
  } catch (e) {
    return sendError(res, e, req, 'home', 'Could not load Airtime to Cash');
  }
}

async function conversions(req, res) {
  try {
    const data = await service.listConversions({
      userId: req.user.id,
      status: String(req.query?.status || '').trim().toLowerCase(),
      page: req.query?.page,
    });
    return ok(res, 'airtime_cash_conversions', 'OK', data);
  } catch (e) {
    return sendError(res, e, req, 'conversions', 'Could not load your conversions');
  }
}

async function details(req, res) {
  try {
    const conversion = await service.conversionDetails({ userId: req.user.id, id: req.params?.id });
    return ok(res, 'airtime_cash_conversion', 'OK', { conversion });
  } catch (e) {
    return sendError(res, e, req, 'details', 'Could not load this conversion');
  }
}

async function start(req, res) {
  try {
    const row = await service.startConversion({
      userId: req.user.id,
      network: req.body?.network,
      phone: req.body?.phone,
    });
    return ok(res, 'airtime_cash_otp_sent', 'We sent a code to the line', { draft: service.publicDraft(row) });
  } catch (e) {
    return sendError(res, e, req, 'start', 'Could not send a code. Please try again.');
  }
}

async function resend(req, res) {
  try {
    const row = await service.resendOtp({ userId: req.user.id, id: req.params?.id });
    return ok(res, 'airtime_cash_otp_sent', 'We sent a new code to the line', { draft: service.publicDraft(row) });
  } catch (e) {
    return sendError(res, e, req, 'resend', 'Could not send a new code. Please try again.');
  }
}

async function verify(req, res) {
  try {
    const row = await service.verifyOtp({ userId: req.user.id, id: req.params?.id, otp: req.body?.otp });
    return ok(res, 'airtime_cash_otp_verified', 'Line verified', { draft: service.publicDraft(row) });
  } catch (e) {
    return sendError(res, e, req, 'verify', 'Could not check that code. Please try again.');
  }
}

async function convert(req, res) {
  try {
    const result = await service.convert({
      userId: req.user.id,
      id: req.params?.id,
      amount: req.body?.amount,
      sharePin: req.body?.share_pin,
      req,
    });
    // Never an error once MySubWallet has answered: a customer shown one would
    // convert again, and the first conversion is already theirs.
    const message = result.deferred
      ? 'Your conversion was received. It can take a few minutes to appear in your history.'
      : result.unconfirmed || !A2C.isConfirmed(result.row)
        ? 'We are confirming your conversion with the network'
        : 'Airtime converted';
    return ok(res, 'airtime_cash_converted', message, {
      conversion: service.publicConversion(result.row, { timeline: true }),
      replay: Boolean(result.replay),
    });
  } catch (e) {
    return sendError(res, e, req, 'convert', 'Could not complete the conversion. Please try again.');
  }
}

async function withdrawOptions(req, res) {
  try {
    const uid = Number(req.user.id);
    const [summary, available, accounts, withdrawalsOn, user] = await Promise.all([
      service.summaryFor(uid),
      service.listConversions({ userId: uid, status: A2C.STATUS.AVAILABLE, perPage: 50 }),
      service.payoutAccounts(uid),
      isFeatureEnabled('withdrawals'),
      prisma.user.findUnique({ where: { id: uid } }),
    ]);
    return ok(res, 'airtime_cash_withdraw_options', 'OK', {
      available_total: summary.available_total,
      conversions: available.conversions,
      accounts,
      // Free to the customer: VoltPay absorbs Paystack's transfer fee.
      fee: '0.00',
      own_name_only: A2C.ownNameOnly(),
      // Their own name, so the screen can say whose account it must be.
      profile_name: profileName(revealUserFields(user)),
      withdrawals_enabled: withdrawalsOn,
    });
  } catch (e) {
    return sendError(res, e, req, 'withdrawOptions', 'Could not load your withdrawal options');
  }
}

async function resolveAccount(req, res) {
  try {
    const user = await prisma.user.findUnique({ where: { id: Number(req.user.id) } });
    const resolved = await service.resolveAccountName({
      user,
      bankCode: req.body?.bank_code,
      accountNumber: req.body?.account_number,
    });
    return ok(res, 'airtime_cash_account', 'Account confirmed', {
      account_name: resolved.account_name,
      bank_name: resolved.bank_name || '',
      bank_code: resolved.bank_code,
      account_masked: A2C.maskAccount(resolved.number.slice(-4)),
    });
  } catch (e) {
    return sendError(res, e, req, 'resolveAccount', 'Could not confirm that account. Please try again.');
  }
}

async function withdraw(req, res) {
  try {
    const ids = req.body?.conversion_ids;
    const w = await service.withdraw({
      userId: req.user.id,
      conversionIds: ids === undefined || ids === null || ids === 'all' ? 'all' : ids,
      account: req.body?.account,
      pin: req.body?.pin,
      saveAccount: req.body?.save_account === true || req.body?.save_account === 'true',
      req,
    });

    // Refused on the spot - a closed account, or our Paystack balance. The
    // money is already available again, so this is an error the customer can
    // read and act on, not a receipt.
    if (w.status === 'failed') {
      return fail(
        res,
        502,
        'withdrawal_failed',
        `${w.failure_reason || 'The transfer did not go through.'} Your cash is available to withdraw again.`,
        { withdrawal: service.publicWithdrawal(w) },
      );
    }

    return ok(
      res,
      'airtime_cash_withdrawal',
      w.status === 'success' ? 'Withdrawal successful' : 'Withdrawal submitted',
      { withdrawal: service.publicWithdrawal(w) },
    );
  } catch (e) {
    return sendError(res, e, req, 'withdraw', 'Could not start the withdrawal. Please try again.');
  }
}

async function withdrawal(req, res) {
  try {
    const id = Number(req.params?.id);
    const row = Number.isInteger(id) && id > 0
      ? await prisma.airtimeCashWithdrawal.findFirst({ where: { id, user_id: Number(req.user.id) } })
      : null;
    if (!row) return fail(res, 404, 'not_found', 'Withdrawal not found');
    return ok(res, 'airtime_cash_withdrawal', 'OK', { withdrawal: service.publicWithdrawal(row) });
  } catch (e) {
    return sendError(res, e, req, 'withdrawal', 'Could not load this withdrawal');
  }
}

module.exports = {
  home,
  conversions,
  details,
  start,
  resend,
  verify,
  convert,
  withdrawOptions,
  resolveAccount,
  withdraw,
  withdrawal,
};
