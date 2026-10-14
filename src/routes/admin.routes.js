const express = require('express')
const router = express.Router()

const AdminController = require('../controllers/admin.controller')
const AdminNotificationCampaignsController = require('../controllers/adminNotificationCampaigns.controller')
const AdminSupportController = require('../controllers/adminSupport.controller')
const AdminStaffPayController = require('../controllers/adminStaffPay.controller')
const AdminTransactionsController = require('../controllers/adminTransactions.controller')
const AdminDeletedAccountsController = require('../controllers/adminDeletedAccounts.controller')
const AdminBillHeroController = require('../controllers/adminBillHero.controller')
const AdminBillChampionsController = require('../controllers/adminBillChampions.controller')
const AdminKycController = require('../controllers/adminKyc.controller')
const AdminAppUpdateController = require('../controllers/adminAppUpdate.controller')
const AdminRecoveryController = require('../controllers/adminRecovery.controller')
const AdminUserProfileController = require('../controllers/adminUserProfile.controller')
const AdminOpsController = require('../controllers/adminOps.controller')
const AdminRiskController = require('../controllers/adminRisk.controller')
const AdminInsightsController = require('../controllers/adminInsights.controller')
const AdminAirtimeCashController = require('../controllers/adminAirtimeCash.controller')
const AdminCacController = require('../controllers/adminCac.controller')
const AdminVirtualCardController = require('../controllers/adminVirtualCard.controller')
const { uploadAnyAttachments, uploadCacDeliverable } = require('../middlewares/upload.middleware')
const { requireAdminRole } = require('../middlewares/adminAuth.middleware')
const rateLimit = require('../middlewares/rateLimit.middleware')

// Second gate on the actions nobody can undo from the dashboard. A deployment
// still on the single ADMIN_API_SECRET authenticates as superadmin, so this
// changes nothing until named keys are configured.
const superadmin = requireAdminRole('superadmin')

router.get('/stats', AdminController.getStats)
router.get('/users', AdminController.listUsers)
router.get('/users/:id', AdminController.getUser)
router.patch('/users/:id/status', AdminController.updateUserStatus)

// The fields the app locks: legal name, username, email, phone, address. A
// misspelled name can only be fixed from here, because profile_edit_screen makes
// it read-only and profileSetting does not read it from the body.
//
// Not superadmin-gated as a whole - fixing a name is the support desk's daily
// work. The controller gates email and mobile on its own, because those two are
// credentials rather than profile text. Rate limited for the same reason the
// recovery reset is: this endpoint sends a notification to the account holder,
// and an unbounded one is a way to spam a customer from inside the dashboard.
const profileEditLimit = rateLimit({ windowMs: 15 * 60_000, max: 30, name: 'admin-profile-edit' })
router.patch('/users/:id/profile', profileEditLimit, AdminUserProfileController.updateUserProfile)
router.post('/users/:id/reset-pin', superadmin, AdminController.resetUserPin)
router.patch('/users/:id/role', superadmin, AdminController.updateUserRole)
router.delete('/users/:id', superadmin, AdminController.deleteUser)
router.patch('/users/status/bulk', superadmin, AdminController.bulkUpdateUserStatus)

// Recovery phrase. A lost phrase cannot be looked up - it is a scrypt digest -
// so the only support action is to mint a new one, and that destroys whatever
// the user still had. Superadmin, therefore, alongside the PIN reset.
//
// The limiter is not there to stop a careless admin; it is there because this
// endpoint sends mail to an address it is given an id for, and an unbounded one
// is a way to flood a customer's inbox from inside the dashboard.
const recoveryResetLimit = rateLimit({ windowMs: 15 * 60_000, max: 10, name: 'admin-recovery-reset' })
router.get('/recovery-phrase/lookup', AdminRecoveryController.lookupUser)
router.get('/recovery-phrase/resets', AdminRecoveryController.listResets)
router.post('/users/:id/recovery-phrase/reset', superadmin, recoveryResetLimit, AdminRecoveryController.resetRecoveryPhrase)

// The identification record: BVN and NIN. Readable while the account is live
// and after it is closed, because the retention duty outlives the account.
// The numbers themselves need the admin's own password, and that gate is what
// the limiter protects - a session left unattended must not be worth guessing
// against.
const revealLimit = rateLimit({ windowMs: 15 * 60_000, max: 10, name: 'admin-kyc-reveal' })
router.get('/users/:id/kyc', AdminKycController.getUserKyc)
router.post('/users/:id/kyc/reveal', revealLimit, AdminKycController.revealUserKyc)

// Taking verification back off a user who has it. This re-freezes a live wallet
// holding real money, so it is superadmin - the same bar as a PIN reset or a
// recovery-phrase reset, and for the same reason: the customer feels it
// immediately and cannot undo it themselves. Approving a slip below is ordinary
// queue work and is not gated this way.
router.post('/users/:id/kyc/revoke', superadmin, AdminKycController.revokeKyc)

// Accounts on their way out: closing, anonymised, or fully purged. Read-only -
// this screen exists so the five-year retention can be seen and answered from,
// not so it can be shortened by hand.
router.get('/deleted-accounts', AdminDeletedAccountsController.listDeletedAccounts)

// Written by adminAudit.middleware on every admin write. Read-only by design -
// an audit trail an admin can edit is not one.
router.get('/audit-logs', AdminController.listAuditLogs)

// One user's own trail - what they paid, when, from which IP and device.
router.get('/users/:id/activity', AdminController.listUserActivity)

// The money trail: every ledger row, failed funding and salary transfer, across
// live and deleted accounts alike. Read-only - nothing here writes to a ledger.
router.get('/transactions', AdminTransactionsController.listTransactions)
router.get('/transactions/:ref', AdminTransactionsController.getTransaction)

// Kill switch. Throwing one is a superadmin action and is itself audited.
router.get('/features', AdminController.getFeatureFlags)
router.patch('/features/:slug', superadmin, AdminController.updateFeatureFlag)

// Which app builds are still allowed in, and where the new APK lives. Not
// superadmin-gated: during a rollout the dangerous state is a stale rule nobody
// can edit. The guard that matters is in appUpdate.helper, which refuses a
// minimum above the latest build and force-update with no download link.
router.get('/app-updates', AdminAppUpdateController.getAppUpdate)
router.patch('/app-updates', AdminAppUpdateController.updateAppUpdate)

router.get('/notification-campaigns', AdminNotificationCampaignsController.listCampaigns)
router.post('/notification-campaigns', AdminNotificationCampaignsController.createCampaign)
router.get('/notification-campaigns/:id', AdminNotificationCampaignsController.getCampaign)
router.post('/notification-campaigns/:id/send', AdminNotificationCampaignsController.sendCampaign)
router.delete('/notification-campaigns/:id', AdminNotificationCampaignsController.deleteCampaign)

// Attachments are accepted on an admin reply too - screenshots go both ways.
router.get('/support/tickets', AdminSupportController.listTickets)
router.get('/support/tickets/:id', AdminSupportController.getTicket)
router.post('/support/tickets/:id/reply', uploadAnyAttachments, AdminSupportController.replyTicket)
router.patch('/support/tickets/:id/status', AdminSupportController.updateStatus)
router.patch('/support/tickets/:id/priority', AdminSupportController.updatePriority)

// Bill Hero: what the promotion is doing, and the switch that shuts it. The
// lock is not superadmin-gated - closing it stops rewards going out, so the
// risky direction is leaving it open during an incident, not turning it off.
router.get('/bill-hero/overview', AdminBillHeroController.getOverview)
router.get('/bill-hero/participants', AdminBillHeroController.listParticipants)
router.get('/bill-hero/rewards', AdminBillHeroController.listRewards)
router.get('/bill-hero/availability', AdminBillHeroController.getAvailability)
router.patch('/bill-hero/availability', AdminBillHeroController.updateAvailability)

// Challenge authoring. Same reasoning as the lock: any admin can write one,
// and every write is picked up by adminAudit.middleware.
// The data sizes a reward can promise, priced per network off the data rail's
// live catalogue. Read-only, and it degrades to an empty list rather than an
// error so a provider outage cannot block challenge authoring.
router.get('/bill-hero/data-plans', AdminBillHeroController.listDataPlanOptions)

router.get('/bill-hero/challenges', AdminBillHeroController.listChallengeRows)
router.post('/bill-hero/challenges', AdminBillHeroController.createChallenge)
router.patch('/bill-hero/challenges/:id', AdminBillHeroController.updateChallenge)
router.delete('/bill-hero/challenges/:id', AdminBillHeroController.deleteChallenge)

// Bill Champions: who pays the most bills, for the social shout-out. Read-only,
// and the only admin endpoint whose output is meant to leave the building - so
// it carries no email, no phone and no wallet balance, refunds are netted off
// before anyone is crowned, and betting is not counted as a utility bill.
router.get('/bill-champions', AdminBillChampionsController.getChampions)

// ---------------------------------------------------------------------------
// Money operations
// ---------------------------------------------------------------------------

// Payments that reached a provider and stopped. Read-only except the credit,
// which is the reason the screen exists: a customer whose transfer settled at
// the provider but never reached their wallet needs somebody able to finish it.
//
// Superadmin, and rate limited for the same reason the recovery reset is - this
// one writes money into a wallet, and an unbounded endpoint that does that is
// worth more to an attacker than anything else in this file.
const manualCreditLimit = rateLimit({ windowMs: 15 * 60_000, max: 20, name: 'admin-manual-credit' })
router.get('/reconciliation', AdminOpsController.getReconciliation)
router.post('/reconciliation/:ref/credit', superadmin, manualCreditLimit, AdminOpsController.creditFunding)

// Which rail is failing and how badly. Reads the funding table and the
// persisted alert feed side by side - neither is complete on its own.
router.get('/providers', AdminOpsController.getProviderHealth)

// Vending capacity. Bills are prepaid from a float held with the provider, so
// this is the number that decides whether airtime, data, TV and electricity
// work at all - independent of how well funded any customer wallet is.
// `/bills/floats` covers every provider and says which rails each is carrying.
router.get('/bills/floats', AdminOpsController.getBillsFloats)

// The provider switch. Four rails, four independent choices, so a provider
// having a bad day with data plans can be dropped without moving electricity
// off it too.
//
// Superadmin on the write: this reroutes every customer's purchase on a rail to
// a different upstream, at a different price, with a different float behind it.
// It is a money decision, not a display setting. Audited by the middleware
// mounted on this router.
router.get('/bills/providers', AdminOpsController.getBillsProviders)
router.patch('/bills/providers/:service', superadmin, AdminOpsController.updateBillsProvider)

// What the platform earned, and on what. `charge` on a debit is our fee;
// `charge` on a credit is the provider's. Never summed together.
router.get('/revenue', AdminOpsController.getRevenue)

// Does every wallet still add up. Two checks, deliberately separate: the MAC
// catches a row edited outside the application, the drift catches a money path
// that forgot to write a ledger row. Drift is its own endpoint because it
// aggregates the whole ledger and must not run on page load.
router.get('/integrity', AdminOpsController.getIntegrity)
router.get('/integrity/drift', AdminOpsController.getIntegrityDrift)

// Airtime to Cash. Conversions credit our MySubWallet float, not Paystack, so
// a customer's cash only becomes withdrawable when somebody has moved the money
// across and marks it available here.
//
// The unlock and the failure are money decisions - one lets customers pull cash
// out of Paystack, the other tells a customer they will not be paid - so they
// are finance or superadmin. Support can read everything and leave notes. All
// three writes are audited by the middleware on this router.
const settlement = requireAdminRole('finance', 'superadmin')
router.get('/airtime-cash/overview', AdminAirtimeCashController.overview)
router.get('/airtime-cash/conversions', AdminAirtimeCashController.listConversions)
router.post('/airtime-cash/conversions/mark-available', settlement, AdminAirtimeCashController.markAvailable)
router.get('/airtime-cash/conversions/:id', AdminAirtimeCashController.getConversion)
router.post('/airtime-cash/conversions/:id/mark-failed', settlement, AdminAirtimeCashController.markFailed)
// MySubWallet credited it, VoltPay never recorded it: credit the customer as
// pending. A money decision - the same role as the unlock - with a note naming
// where it was confirmed, since their requery cannot confirm Airtime to Cash.
router.post('/airtime-cash/conversions/:id/record-success', settlement, AdminAirtimeCashController.recordProviderSuccess)
router.post('/airtime-cash/conversions/:id/notes', AdminAirtimeCashController.addNote)
router.get('/airtime-cash/withdrawals', AdminAirtimeCashController.listWithdrawals)
router.post('/airtime-cash/withdrawals/:id/requery', AdminAirtimeCashController.requeryWithdrawal)

// CAC Registration. The queue is paid applications only - an unpaid draft is
// never listed and every transition is guarded on payment in the service, so
// "do not process unpaid applications" is not a rule anybody here has to
// remember.
//
// Processing is ordinary queue work for any admin - including handing over the
// documents CAC issued, one file per call. The price, the on/off switch and a
// refund are money decisions: finance or superadmin. Rejecting WITH a refund is
// checked in the controller, because the flag is in the body.
//
// The application and its documents are identity data - the controller logs
// every read of either, since adminAudit only records writes. Documents stream
// through this API, so an UploadThing link never reaches the browser.
const cacMoney = requireAdminRole('finance', 'superadmin')
router.get('/cac/settings', AdminCacController.getSettings)
router.patch('/cac/settings', cacMoney, AdminCacController.updateSettings)
router.get('/cac/applications', AdminCacController.listApplications)
router.get('/cac/applications/:id', AdminCacController.getApplication)
router.get('/cac/applications/:id/documents/:kind', AdminCacController.viewDocument)
router.post('/cac/applications/:id/start', AdminCacController.start)
router.post('/cac/applications/:id/request-info', AdminCacController.requestInfo)
router.post('/cac/applications/:id/deliverables', uploadCacDeliverable, AdminCacController.uploadDeliverable)
router.get('/cac/applications/:id/deliverables/:docId', AdminCacController.viewDeliverable)
router.delete('/cac/applications/:id/deliverables/:docId', AdminCacController.deleteDeliverable)
router.post('/cac/applications/:id/complete', AdminCacController.complete)
router.post('/cac/applications/:id/reject', AdminCacController.reject)
router.post('/cac/applications/:id/refund', cacMoney, AdminCacController.refund)
router.post('/cac/applications/:id/notes', AdminCacController.addNote)

// USD Virtual Mastercard. Reads, freezes and syncs are support work for any
// admin; the price, the dollar rate, the limits and the kill switch are money
// decisions - finance or superadmin. Nothing here refunds by hand: every
// refund is the engine's own, guarded and automatic, and "sync" only makes the
// sweep's work happen now. The fixed paths come before /:id.
const cardMoney = requireAdminRole('finance', 'superadmin')
router.get('/virtual-cards/overview', AdminVirtualCardController.overview)
router.get('/virtual-cards/settings', AdminVirtualCardController.getSettings)
router.patch('/virtual-cards/settings', cardMoney, AdminVirtualCardController.updateSettings)
router.get('/virtual-cards/fundings', AdminVirtualCardController.listFundings)
router.get('/virtual-cards/webhooks', AdminVirtualCardController.listWebhooks)
router.get('/virtual-cards', AdminVirtualCardController.listCards)
router.get('/virtual-cards/:id', AdminVirtualCardController.getCard)
router.post('/virtual-cards/:id/freeze', AdminVirtualCardController.freeze)
router.post('/virtual-cards/:id/unfreeze', AdminVirtualCardController.unfreeze)
// Permanent, and it writes money into a wallet: the money roles only.
router.post('/virtual-cards/:id/terminate', cardMoney, AdminVirtualCardController.terminate)
router.post('/virtual-cards/:id/sync', AdminVirtualCardController.sync)

// ---------------------------------------------------------------------------
// Risk and compliance
// ---------------------------------------------------------------------------

// Everything the platform refused: velocity trips, lockouts, security events.
// Written by alerts.service into admin_audit_log, so the trail outlives both
// the Redis counters that produced it and the user it is about.
router.get('/security', AdminRiskController.listSecurity)

// Identification records waiting on a decision. Ids and ages only - the record
// itself is behind the reveal gate on the user's own page.
router.get('/kyc/queue', AdminRiskController.listKycQueue)

// The NIN slip review queue: the manual path for users with no BVN.
//
// Unlike /kyc/queue above, which is a read-only compliance view, these three
// decide things. The detail endpoint hands over a link to a photograph of a
// government ID, so it is the one read in the dashboard that logs itself.
router.get('/kyc/nin-slips', AdminKycController.listNinSlips)
router.get('/kyc/nin-slips/:id', AdminKycController.getNinSlip)

// The register check. A PAID call on OUR account, so unlike its neighbours this
// one costs money every time it is pressed - it de-duplicates against the stored
// verdict and only re-runs when the caller asks for it explicitly.
//
// POST rather than GET precisely because it is not a read: it spends, it writes
// a verdict, and it must never be something a browser can prefetch or a proxy
// can replay. An approval below is refused without it.
router.post('/kyc/nin-slips/:id/verify', AdminKycController.verifyNinLookup)

router.patch('/kyc/nin-slips/:id', AdminKycController.reviewNinSlip)

// Large, aggregate and structured transaction reports, plus the CSV a
// compliance officer actually files from. The export carries no counterparty
// text: a spreadsheet is the easiest thing here to send to the wrong person.
router.get('/aml', AdminRiskController.getAmlReport)
router.get('/aml/export', AdminRiskController.exportTransactions)

// ---------------------------------------------------------------------------
// Platform insight
// ---------------------------------------------------------------------------

// Is every dependency answering, is the scheduler still ticking, and which
// switches are currently thrown. Reports whether a secret is set, never what
// it is.
router.get('/health', AdminInsightsController.getHealth)

// Is support keeping up. First response is measured to the first non-internal
// admin reply, so a private note cannot score as an answer.
router.get('/support/sla', AdminInsightsController.getSupportSla)

// Signups, activation and KYC conversion. Activation is "has at least one
// ledger row" - the only definition the ledger would agree with.
router.get('/growth', AdminInsightsController.getGrowth)

router.get('/staffpay/verifications', AdminStaffPayController.listVerifications)
router.get('/staffpay/verifications/:id', AdminStaffPayController.getVerification)
router.patch('/staffpay/verifications/:id', AdminStaffPayController.reviewVerification)
router.get('/staffpay/price', AdminStaffPayController.getPrice)
router.patch('/staffpay/price', AdminStaffPayController.updatePrice)
router.get('/staffpay/companies', AdminStaffPayController.listCompanies)
router.get('/staffpay/companies/:id', AdminStaffPayController.getCompany)
// Payouts, and whether the thing that makes them happen is still ticking.
// Read-only: admin can see a payday, not start one.
router.get('/staffpay/scheduler', AdminStaffPayController.schedulerStatus)
router.get('/staffpay/payroll-runs', AdminStaffPayController.listPayrollRuns)
router.get('/staffpay/payroll-runs/:id', AdminStaffPayController.getPayrollRun)

module.exports = router
