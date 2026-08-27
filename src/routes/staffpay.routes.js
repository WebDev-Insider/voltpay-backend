const express = require('express');
const router = express.Router();

const userAuth = require('../middlewares/userAuth.middleware');
const rateLimit = require('../middlewares/rateLimit.middleware');
const staffPayAccess = require('../middlewares/staffpayAccess.middleware');
const idempotency = require('../middlewares/idempotency.middleware');
const { uploadAnyAttachments } = require('../middlewares/upload.middleware');
const StaffPayController = require('../controllers/staffpay.controller');
const StaffPayVerificationController = require('../controllers/staffpayVerification.controller');
const StaffPaySubscriptionController = require('../controllers/staffpaySubscription.controller');

router.get('/staffpay/banks', userAuth, StaffPayController.banks);
router.post('/staffpay/resolve-account', userAuth, StaffPayController.resolveBankAccount);

router.post('/staffpay/companies', userAuth, StaffPayController.createCompany);
router.get('/staffpay/companies', userAuth, StaffPayController.listCompanies);
router.get('/staffpay/companies/:companyId', userAuth, StaffPayController.getCompany);
router.put('/staffpay/companies/:companyId', userAuth, StaffPayController.updateCompany);
router.delete('/staffpay/companies/:companyId', userAuth, StaffPayController.deleteCompany);

// KYB. Documents arrive as multipart; the text fields ride along in req.body.
router.post(
  '/staffpay/companies/:companyId/verification',
  userAuth,
  uploadAnyAttachments,
  StaffPayVerificationController.submitVerification
);
router.get('/staffpay/companies/:companyId/verification', userAuth, StaffPayVerificationController.getVerification);

// Yearly subscription. The webhook is signature-authenticated, not session
// authenticated - see PUBLIC_API_PATHS in server.js.
router.get('/staffpay/subscription/price', userAuth, StaffPaySubscriptionController.getPrice);
router.post('/staffpay/subscription/webhook', StaffPaySubscriptionController.webhook);
router.get('/staffpay/companies/:companyId/subscription', userAuth, StaffPaySubscriptionController.getSubscription);

// Paid from the VoltPay wallet - PIN authorised, no gateway. This is what the
// app uses; initiate/verify below stay for builds already in the field.
router.post(
  '/staffpay/companies/:companyId/subscription/pay-wallet',
  userAuth,
  // It takes a PIN and it moves money, so it is rate limited like the bill
  // confirm endpoint rather than left open to guessing.
  rateLimit({ windowMs: 10 * 60_000, max: 10, name: 'staffpay-subscription-pay', byUser: true }),
  StaffPaySubscriptionController.payWithWallet
);
router.post(
  '/staffpay/companies/:companyId/subscription/initiate',
  userAuth,
  StaffPaySubscriptionController.initiateSubscription
);
router.post(
  '/staffpay/companies/:companyId/subscription/verify',
  userAuth,
  StaffPaySubscriptionController.verifySubscription
);

// Everything below moves money or the people it is paid to: verified,
// subscribed businesses only.
router.post('/staffpay/staff', userAuth, staffPayAccess, StaffPayController.createStaff);
router.get('/staffpay/staff', userAuth, StaffPayController.listStaff);
router.put('/staffpay/staff/:staffId', userAuth, staffPayAccess, StaffPayController.updateStaff);
router.delete('/staffpay/staff/:staffId', userAuth, staffPayAccess, StaffPayController.deleteStaff);

router.get('/staffpay/dashboard', userAuth, StaffPayController.getDashboard);

router.get('/staffpay/history/funding', userAuth, StaffPayController.listFundingHistory);
router.get('/staffpay/history/payouts', userAuth, StaffPayController.listPayoutHistory);
router.get('/staffpay/history/payouts/export', userAuth, StaffPayController.exportPayoutHistory);

router.get('/staffpay/wallet', userAuth, StaffPayController.getWallet);
router.get('/staffpay/wallet/virtual-account', userAuth, StaffPayController.getWalletVirtualAccount);
router.post('/staffpay/wallet/virtual-account', userAuth, staffPayAccess, StaffPayController.getWalletVirtualAccount);
router.post('/staffpay/wallet/fund/initiate', userAuth, staffPayAccess, StaffPayController.initiateWalletFunding);
router.post('/staffpay/wallet/fund/verify', userAuth, StaffPayController.verifyWalletFunding);
router.post('/staffpay/wallet/fund/reconcile', userAuth, StaffPayController.reconcileWalletFunding);
router.post('/staffpay/wallet/fund/reconcile-auto', userAuth, StaffPayController.autoReconcileWalletFunding);
router.get('/staffpay/wallet/fund/callback', StaffPayController.walletFundingCallback);
router.post('/staffpay/wallet/webhook', StaffPayController.walletWebhook);

// A payroll run debits the company wallet once and fans out to every staff
// member. A blind retry after a timeout would pay everyone twice, so the key
// the app sends is what makes "run payroll" safe to press again.
router.post(
  '/staffpay/payroll/run',
  userAuth,
  staffPayAccess,
  idempotency({ name: 'staffpay_payroll_run' }),
  StaffPayController.createPayrollRun,
);
// Run payroll now: only the staff whose payday has arrived, stamped with the
// same cycle keys the scheduler uses. Pressing it after automatic payroll has
// already paid somebody cannot pay them twice - the database refuses it.
router.post(
  '/staffpay/payroll/run-now',
  userAuth,
  staffPayAccess,
  idempotency({ name: 'staffpay_payroll_run_now' }),
  StaffPayController.runDuePayrollNow,
);
router.get('/staffpay/payroll/runs', userAuth, StaffPayController.listPayrollRuns);
router.get('/staffpay/payroll/runs/:runId', userAuth, StaffPayController.getPayrollRun);
router.post('/staffpay/payroll/runs/:runId/sync', userAuth, StaffPayController.syncPayrollRun);
// Retry moves money, so it sits behind the same gate as the run itself.
router.post(
  '/staffpay/payroll/runs/:runId/retry',
  userAuth,
  staffPayAccess,
  idempotency({ name: 'staffpay_payroll_retry' }),
  StaffPayController.retryPayrollRun,
);

module.exports = router;
