const express = require('express');
const router = express.Router();

const userAuth = require('../middlewares/userAuth.middleware');
const StaffPayController = require('../controllers/staffpay.controller');

router.get('/staffpay/banks', userAuth, StaffPayController.banks);
router.get('/staffpay/banks/:bankId/branches', userAuth, StaffPayController.bankBranches);
router.post('/staffpay/resolve-account', userAuth, StaffPayController.resolveBankAccount);

router.post('/staffpay/companies', userAuth, StaffPayController.createCompany);
router.get('/staffpay/companies', userAuth, StaffPayController.listCompanies);
router.get('/staffpay/companies/:companyId', userAuth, StaffPayController.getCompany);
router.put('/staffpay/companies/:companyId', userAuth, StaffPayController.updateCompany);
router.delete('/staffpay/companies/:companyId', userAuth, StaffPayController.deleteCompany);

router.post('/staffpay/staff', userAuth, StaffPayController.createStaff);
router.get('/staffpay/staff', userAuth, StaffPayController.listStaff);
router.put('/staffpay/staff/:staffId', userAuth, StaffPayController.updateStaff);
router.delete('/staffpay/staff/:staffId', userAuth, StaffPayController.deleteStaff);

router.get('/staffpay/dashboard', userAuth, StaffPayController.getDashboard);

router.get('/staffpay/history/funding', userAuth, StaffPayController.listFundingHistory);
router.get('/staffpay/history/payouts', userAuth, StaffPayController.listPayoutHistory);
router.delete('/staffpay/history', userAuth, StaffPayController.clearHistory);

router.get('/staffpay/wallet', userAuth, StaffPayController.getWallet);
router.get('/staffpay/wallet/virtual-account', userAuth, StaffPayController.getWalletVirtualAccount);
router.post('/staffpay/wallet/virtual-account', userAuth, StaffPayController.getWalletVirtualAccount);
router.post('/staffpay/wallet/fund/initiate', userAuth, StaffPayController.initiateWalletFunding);
router.post('/staffpay/wallet/fund/verify', userAuth, StaffPayController.verifyWalletFunding);
router.post('/staffpay/wallet/fund/reconcile', userAuth, StaffPayController.reconcileWalletFunding);
router.post('/staffpay/wallet/fund/reconcile-auto', userAuth, StaffPayController.autoReconcileWalletFunding);
router.get('/staffpay/wallet/fund/callback', StaffPayController.walletFundingCallback);
router.post('/staffpay/wallet/webhook', StaffPayController.walletWebhook);

router.post('/staffpay/payroll/run', userAuth, StaffPayController.createPayrollRun);
router.get('/staffpay/payroll/runs', userAuth, StaffPayController.listPayrollRuns);
router.delete('/staffpay/payroll/runs', userAuth, StaffPayController.clearPayrollRuns);
router.get('/staffpay/payroll/runs/:runId', userAuth, StaffPayController.getPayrollRun);
router.post('/staffpay/payroll/runs/:runId/sync', userAuth, StaffPayController.syncPayrollRun);

module.exports = router;
