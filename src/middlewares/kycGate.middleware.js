// Route guard for the KYC funding lock. See helpers/kycGate.helper.js for the
// rule itself.
//
// A middleware rather than a check inside each controller because the lock has
// nothing to do with what is being bought or how much: a frozen wallet cannot
// spend at all, so the decision is the same on every outgoing route and belongs
// in front of them, not repeated inside them.
//
// Runs after userAuth (it needs req.user) and before idempotency - a request
// that is refused here never moved money, so it must not burn an idempotency
// key that the user's retry-after-verifying would then replay as "already done".

const { checkSpendKyc } = require('../helpers/kycGate.helper');

/**
 * 403 with `remark: 'kyc_required'`, which the app turns into a prompt to
 * verify rather than a bare error.
 */
async function requireKyc(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return next(); // userAuth already answered, or will.

    const verdict = await checkSpendKyc({ userId });
    if (verdict.ok) return next();

    return res.status(403).json({
      remark: verdict.reason,
      status: 'error',
      message: [verdict.message],
      data: { reason: verdict.reason },
    });
  } catch (e) {
    // Fails CLOSED. This reads the same database the payment needs, so a read
    // that cannot complete is not a reason to wave the payment through.
    console.error('kycGate: check failed, refusing payment', {
      user_id: req.user?.id,
      reason: String(e?.message || e).slice(0, 160),
    });
    return res.status(503).json({
      remark: 'kyc_check_failed',
      status: 'error',
      message: ['We could not confirm your account status. Please try again shortly.'],
      data: null,
    });
  }
}

module.exports = requireKyc;
