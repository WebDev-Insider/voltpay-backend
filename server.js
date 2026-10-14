
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env'), override: true });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const multer = require('multer');
const prisma = require('./database/prisma');
const { Resend } = require('resend');
const https = require('https');
const dns = require('dns');
const passwordRoutes = require('./src/routes/password.routes');
const settingsRoutes = require('./src/routes/settings.routes');
const appVersionRoutes = require('./src/routes/appVersion.routes');
const authRoutes = require('./src/routes/auth.routes');
const signupRoutes = require('./src/routes/signup.routes');
const userRoutes = require('./src/routes/user.routes');
const accountRoutes = require('./src/routes/account.routes');
const uploadRoutes = require('./src/routes/upload.routes');
const dashboardRoutes = require('./src/routes/dashboard.routes');
const transactionsRoutes = require('./src/routes/transactions.routes');
const bettingRoutes = require('./src/routes/betting.routes');
const billsRoutes = require('./src/routes/bills.routes');
const billHeroRoutes = require('./src/routes/billHero.routes');
const scheduledTopupRoutes = require('./src/routes/scheduledTopup.routes');
const airtimeCashRoutes = require('./src/routes/airtimeCash.routes');
const cacRoutes = require('./src/routes/cac.routes');
const virtualCardRoutes = require('./src/routes/virtualCard.routes');
const sendMoneyRoutes = require('./src/routes/sendMoney.routes');
const requestMoneyRoutes = require('./src/routes/requestMoney.routes');
const verificationRoutes = require('./src/routes/verification.routes');
const kycRoutes = require('./src/routes/kyc.routes');
const statementsRoutes = require('./src/routes/statements.routes');
const fundingRoutes = require('./src/routes/funding.routes');
const miscRoutes = require('./src/routes/misc.routes');
const pushNotificationsRoutes = require('./src/routes/pushNotifications.routes');
const assetsRoutes = require('./src/routes/assets.routes');
const contentRoutes = require('./src/routes/content.routes');
const supportRoutes = require('./src/routes/support.routes');
const staffPayRoutes = require('./src/routes/staffpay.routes');
const adminRoutes = require('./src/routes/admin.routes');
const adminAuthRoutes = require('./src/routes/adminAuth.routes');
const adminAuth = require('./src/middlewares/adminAuth.middleware');
const adminAudit = require('./src/middlewares/adminAudit.middleware');
const { parseOrigins, corsOrigin } = require('./src/helpers/cors.helper');
const { captureError } = require('./src/services/alerts.service');
const { ensurePasswordResetsTable } = require('./src/models/passwordReset.model');
const userAuth = require('./src/middlewares/userAuth.middleware');
const appVersionGate = require('./src/middlewares/appVersionGate.middleware');
const { uploadErrorMessage, bodyErrorReply } = require('./src/middlewares/upload.middleware');
const { startStaffPayScheduler } = require('./src/services/staffpayScheduler.service');
const { initNotificationWs } = require('./src/services/notificationWs.service');
const redis = require('./src/services/redis.service');
// Prefer IPv4 and keep-alive at the fetch/Undici layer used by Resend SDK
try {
  const { Agent, setGlobalDispatcher } = require('undici');
  setGlobalDispatcher(new Agent({
    connect: { family: 4 },
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 15_000,
    pipelining: 0,
  }));
  console.log('🌐 Undici global dispatcher set to IPv4-first with keep-alive');
} catch (e) {
  console.log('ℹ️  Undici dispatcher not set (optional):', e.message);
}

// Prefer IPv4 first to avoid intermittent IPv6/SSL middlebox issues
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (_) {
  // Node < 18 may not support this; ignore
}

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.disable('x-powered-by');

// Initialize Firebase Admin SDK - see services/firebase.service.js.
const firebaseSource = require('./src/services/firebase.service').initFirebase();
if (firebaseSource) {
  console.log('🔥 Firebase Admin SDK initialized', { source: firebaseSource });
}

// Resend-related helpers and password reset helpers moved into services/controllers under src/


// File storage is UploadThing - configured per call in helpers/upload.helper.js
// from UPLOADTHING_TOKEN, so there is nothing to set up at boot.

// Configure Multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    console.log('📥 File filter check:', {
      fieldname: file.fieldname,
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size
    });
    
    // Allow common image types
    const allowedMimes = [
      'image/jpeg',
      'image/jpg', 
      'image/png',
      'image/gif',
      'image/webp',
      'image/bmp',
      'image/svg+xml',
      'application/octet-stream' // Flutter often sends images as octet-stream
    ];
    
    // Check file extension for octet-stream files
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
    const fileExtension = file.originalname.toLowerCase().substring(file.originalname.lastIndexOf('.'));
    
    if (allowedMimes.includes(file.mimetype) || 
        file.mimetype.startsWith('image/') ||
        (file.mimetype === 'application/octet-stream' && imageExtensions.includes(fileExtension))) {
      console.log('✅ File accepted:', file.originalname);
      cb(null, true);
    } else {
      console.error('❌ File rejected:', file.mimetype, 'Extension:', fileExtension);
      cb(new Error(`File type ${file.mimetype} not allowed. Only image files are accepted.`), false);
    }
  }
});

app.use(helmet());

// Browser callers are the admin dashboard and Flutter web, and both live on
// known hosts. Rules and the empty-list caveat are in helpers/cors.helper.js.
const CORS_ORIGINS = parseOrigins(process.env.CORS_ALLOWED_ORIGINS);

if (CORS_ORIGINS.length === 0 && String(process.env.NODE_ENV) === 'production') {
  console.warn('⚠️  CORS_ALLOWED_ORIGINS is unset in production - every origin is allowed.');
}

app.use(cors({ maxAge: 86400, credentials: true, origin: corsOrigin(CORS_ORIGINS) }));
app.use(compression());
app.use(
  express.json({
    limit: process.env.JSON_BODY_LIMIT || '1mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(
  express.urlencoded({
    limit: process.env.URLENCODED_BODY_LIMIT || '1mb',
    extended: true,
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

if (process.env.HTTP_LOGGING === '1' || process.env.NODE_ENV !== 'production') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// API base prefix to match Flutter's UrlContainer.baseUrl = `${domain}/api/`
const API_PREFIX = process.env.API_PREFIX || '/api';

// Require login for every API route except a short allowlist
const PUBLIC_API_PATHS = [
  '/login',
  '/register',
  '/signup',
  '/authentication',
  '/authorization',
  '/password',
  '/verify-email',
  '/verify-mobile',
  '/resend-verify',
  '/get-countries',
  '/language',
  '/general-setting',
  '/module-setting',
  // Asked before login, by a build that may not be allowed to do anything else
  // yet. Requiring a token here would make a forced update unenforceable on the
  // one screen that has to show it.
  '/app/version-check',
  '/user-data-submit',
  // Reactivation only: a deactivated account has no session to authenticate
  // with. /account/deactivate is deliberately not listed.
  '/account/reactivate',
  '/health',
  '/policies',
  '/faq',
  // PaymentPoint's credit webhook. Authenticated by its HMAC signature in the
  // controller, not by a session.
  '/funding/webhook',
  // MySubWallet delivery, for bills and Bill Hero rewards. Their API has no
  // signature scheme, so this one is authenticated by *not being believed*: the
  // controller re-reads the outcome over the authenticated requery before
  // anything settles.
  '/bills/webhook/mysubwallet',
  '/staffpay/wallet/webhook',
  '/staffpay/wallet/fund/callback',
  '/staffpay/subscription/webhook',
  // Payvessel betting orders. Unsigned too, and treated the same way: the
  // controller re-fetches the order from Payvessel before settling it.
  '/betting/callback',
  // Where Paystack sends the browser after a CAC checkout. A static page that
  // settles nothing - the signed webhook, the app's verify and the sweep do.
  '/cac/paystack/callback',
  // Payvessel card events. HMAC-SHA512 over the raw body, checked in the
  // controller; lifecycle events are then re-read from Payvessel, never
  // believed on their own. Nothing depends on it arriving - see the sweep.
  '/virtual-card/webhook'
  // No KYC path is public. Payvessel answers both the BVN and the NIN check in
  // the HTTP response, so there is no callback for a provider to deliver and
  // nothing on /kyc that should be reachable without a session.
];

function enforceLogin(req, res, next) {
  const route = req.path || '';
  if (route.startsWith('/admin')) return next();
  const isPublic = PUBLIC_API_PATHS.some(publicPath => route.startsWith(publicPath));
  if (isPublic) return next();
  return userAuth(req, res, next);
}

// Ahead of enforceLogin on purpose. A retired build should be told to update,
// not told it is unauthorised - and the answer has to reach it on the public
// routes too, since those are the only ones it can call before signing in.
app.use(API_PREFIX, appVersionGate);

app.use(API_PREFIX, enforceLogin);

// Mount modular routes
app.use(API_PREFIX, passwordRoutes);
app.use(API_PREFIX, settingsRoutes);
app.use(API_PREFIX, appVersionRoutes);
app.use(API_PREFIX, authRoutes);
app.use(API_PREFIX, signupRoutes);
app.use(API_PREFIX, userRoutes);
app.use(API_PREFIX, accountRoutes);
app.use(API_PREFIX, uploadRoutes);
app.use(API_PREFIX, dashboardRoutes);
app.use(API_PREFIX, transactionsRoutes);
app.use(API_PREFIX, statementsRoutes);
app.use(API_PREFIX, fundingRoutes);
app.use(API_PREFIX, bettingRoutes);
app.use(API_PREFIX, billsRoutes);
app.use(API_PREFIX, billHeroRoutes);
app.use(API_PREFIX, scheduledTopupRoutes);
app.use(API_PREFIX, airtimeCashRoutes);
app.use(API_PREFIX, cacRoutes);
app.use(API_PREFIX, virtualCardRoutes);
app.use(API_PREFIX, sendMoneyRoutes);
app.use(API_PREFIX, requestMoneyRoutes);
app.use(API_PREFIX, verificationRoutes);
app.use(API_PREFIX, kycRoutes);
app.use(API_PREFIX, miscRoutes);
app.use(API_PREFIX, pushNotificationsRoutes);
app.use(API_PREFIX, contentRoutes);
app.use(API_PREFIX, supportRoutes);
app.use(API_PREFIX, staffPayRoutes);
// Admin login sits ahead of adminAuth - an admin signing in has no credential
// yet. It logs its own audit rows because adminAudit is not in front of it.
app.use(`${API_PREFIX}/admin`, adminAuthRoutes.publicRoutes);
// adminAudit sits after the secret check and before the routes, so every write
// under /admin is recorded once, without any controller having to remember.
// One mount, both routers: a second app.use would run adminAudit twice and
// write two rows for every request.
app.use(`${API_PREFIX}/admin`, adminAuth, adminAudit, adminAuthRoutes.sessionRoutes, adminRoutes);
app.use(assetsRoutes);

// Ensure auxiliary tables exist (password_resets)
ensurePasswordResetsTable().catch(err => console.error('Failed to ensure password_resets table:', err));

 

 

 

 

// Dashboard route moved to src/routes/dashboard.routes.js

// Transactions route moved to src/routes/transactions.routes.js

// Assets routes moved to src/routes/assets.routes.js

// getCountryByCode moved to src/helpers/country.helper.js

// Session is handled via src/services/session.service

// User info moved to src/routes/user.routes.js

// Profile setting moved to src/routes/user.routes.js

// Login route moved to src/routes/auth.routes.js

// Register route moved to src/routes/auth.routes.js

// Authentication route moved to src/routes/auth.routes.js

// Authorization GET moved to src/routes/auth.routes.js

// Authorization POST moved to src/routes/auth.routes.js

// Add-device-token route moved to src/routes/misc.routes.js

// Upload image moved to src/routes/upload.routes.js

// User-data-submit route moved to src/routes/user.routes.js

// Password routes moved to src/routes/password.routes.js

// Logout routes moved to src/routes/misc.routes.js

// Connectivity probe. Deliberately touches nothing: the app polls it while it
// believes it is offline, and a probe that woke Neon on every poll would be a
// self-inflicted bill.
app.get('/ping', (req, res) => res.status(204).end());

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    // Redis is a cache, so its state is reported but never makes the service
    // unhealthy - every read through it falls back to Postgres.
    const redisStatus = await redis.ping();

    res.json({
      status: 'healthy',
      database: 'connected',
      redis: redisStatus,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      database: 'disconnected',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/', (req, res) => {
  res.json({
    message: 'VoltPay API is running',
    version: '1.0.0',
    endpoints: {
      countries: `${API_PREFIX}/get-countries`,
      language: `${API_PREFIX}/language/:code`,
      general_settings: `${API_PREFIX}/general-setting`,
      module_settings: `${API_PREFIX}/module-setting`,
      login: `${API_PREFIX}/login`,
      register: `${API_PREFIX}/register`,
      logout: `${API_PREFIX}/logout`,
      authentication: `${API_PREFIX}/authentication`,
      authorization: `${API_PREFIX}/authorization`,
      user_data_submit: `${API_PREFIX}/user-data-submit`,
      device_token: `${API_PREFIX}/device-token`,
      upload_image: `${API_PREFIX}/upload-image`,
      profile_setting: `${API_PREFIX}/profile-setting`,
      dashboard: `${API_PREFIX}/dashboard`,
      transactions: `${API_PREFIX}/transactions`,
      statements: `${API_PREFIX}/statements`,
      funding_initiate: `${API_PREFIX}/funding/initiate`,
      funding_verify: `${API_PREFIX}/funding/verify`,
      funding_webhook: `${API_PREFIX}/funding/webhook`,
      admin_stats: `${API_PREFIX}/admin/stats`,
      admin_users: `${API_PREFIX}/admin/users`,
      user_info: `${API_PREFIX}/user-info`,
      password_email: `${API_PREFIX}/password/email`,
      password_verify_code: `${API_PREFIX}/password/verify-code`,
      password_reset: `${API_PREFIX}/password/reset`,
      health: '/health'
    }
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  // A refused upload - too large, the wrong type - is the caller's file, not
  // our failure. Answered as a 400 that says what was wrong; it used to reach
  // the 500 below and tell the customer only "Internal server error".
  const uploadMessage = uploadErrorMessage(error);
  if (uploadMessage) {
    return res.status(400).json({ remark: 'validation_error', status: 'error', message: [uploadMessage], data: null });
  }
  // The same for a body the JSON / form parser refused. A client hanging up
  // mid-upload (a phone losing signal while it sends a photo) used to land
  // below as a crash and page ops on every dropped connection: it is one quiet
  // line now - route and byte counts only, never the body - and no answer,
  // because the socket is already closed.
  const bodyReply = bodyErrorReply(error);
  if (bodyReply) {
    const path = String(req.originalUrl || req.url || '').split('?')[0];
    if (bodyReply.quiet) {
      console.warn(`[http] client closed the request mid-upload: ${req.method} ${path} (${error.received ?? '?'} of ${error.expected ?? '?'} bytes)`);
      return undefined;
    }
    return res.status(bodyReply.status).json({ remark: 'validation_error', status: 'error', message: [bodyReply.message], data: null });
  }
  console.error('Unhandled error:', error);
  // The client still gets nothing but "Internal server error"; the alert carries
  // the route and the user id, never the body.
  captureError('http.unhandled', error, {
    method: req.method,
    path: String(req.originalUrl || req.url || '').split('?')[0],
    user_id: req.user?.id || null,
  });
  res.status(500).json({
    remark: 'error',
    status: 'error',
    message: ['Internal server error'],
    data: null
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    remark: 'not_found',
    status: 'error',
    message: ['Endpoint not found'],
    data: null
  });
});

const server = app.listen(PORT, () => {
  console.log(`🚀 VoltPay API server running on http://localhost:${PORT}`);
  console.log(redis.isEnabled()
    ? '⚡ Redis cache enabled (Upstash REST)'
    : 'ℹ️  Redis not configured - caches and shared counters fall back to in-process memory');
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🌍 Countries API: http://localhost:${PORT}${API_PREFIX}/get-countries`);
  console.log(`🌐 Language API: http://localhost:${PORT}${API_PREFIX}/language/en`);
});

initNotificationWs(server);

// Automatic payroll. Returns null when it refused to start - disabled by
// config, models missing, or a serverless runtime where a timer cannot be
// trusted. In production that silence is the difference between payday
// happening and not, so it is said out loud at boot.
{
  const staffPayScheduler = startStaffPayScheduler();
  if (!staffPayScheduler && process.env.NODE_ENV === 'production') {
    console.error(
      '⚠️  StaffPay automatic payroll is NOT running on this instance. No salary will be paid without a button press. ' +
      'It needs STAFFPAY_SCHEDULER_ENABLED=true and STAFFPAY_AUTOPAY_ENABLED=true on an always-on Node process.',
    );
  }
}

// Scheduled top-ups: standing airtime and data orders, bought in Lagos time on
// a one-minute tick. Same contract as payroll - opt-in, always-on process only,
// safe on several instances (each cycle is claimed once in the database) - and
// the same loud warning when production is not running it, because a customer
// whose Monday top-up silently never happens finds out from their mother.
{
  const { startScheduledTopupWorker } = require('./src/services/scheduledTopup.service');
  const scheduledTopups = startScheduledTopupWorker();
  if (!scheduledTopups && process.env.NODE_ENV === 'production') {
    console.error(
      '⚠️  Scheduled top-ups are NOT running on this instance. Standing orders will not be bought. ' +
      'It needs SCHEDULED_TOPUPS_ENABLED=true on an always-on Node process.',
    );
  }
}

// One pass an hour is enough for a 24h request window, and the reminder itself
// is stamped in the row so a restart mid-tick cannot double-notify.
{
  const { sendPendingReminders } = require('./src/controllers/requestMoney.controller');
  const requestReminderTimer = setInterval(
    () => sendPendingReminders().catch(() => null),
    Number(process.env.REQUEST_MONEY_REMINDER_INTERVAL_MS || 60 * 60_000)
  );
  if (requestReminderTimer && typeof requestReminderTimer.unref === 'function') requestReminderTimer.unref();
}

// A Payvessel betting order settles after we accept it, and a failed one owes
// the customer a refund. The webhook does that when it arrives; this is the
// path that does not depend on it arriving.
{
  const { sweepProcessingOrders } = require('./src/controllers/betting.controller');
  const bettingSweepTimer = setInterval(
    () => sweepProcessingOrders().catch(() => null),
    Number(process.env.BETTING_SWEEP_INTERVAL_MS || 5 * 60_000)
  );
  if (bettingSweepTimer && typeof bettingSweepTimer.unref === 'function') bettingSweepTimer.unref();
}

// Same problem on the bills rails. A provider can accept a vend as pending and
// report the outcome later, and a webhook can be dropped. A bill left processing
// because none of those landed is a customer whose money is gone with nothing
// delivered, so the outcome is also pulled on a timer. One sweep covers every
// bills provider - it dispatches on each row's own gateway.
{
  const { sweepProcessingBills } = require('./src/helpers/billReconcile.helper');
  const billsSweepTimer = setInterval(
    () => sweepProcessingBills().catch(() => null),
    Number(process.env.BILLS_SWEEP_INTERVAL_MS || 5 * 60_000)
  );
  if (billsSweepTimer && typeof billsSweepTimer.unref === 'function') billsSweepTimer.unref();
}

// Bill Hero rewards, the same problem with no money behind it. A reward the
// provider accepted can fail minutes later, and nothing else would notice:
// the provider's webhook cannot be configured. This finishes every reward with
// nobody involved - confirms it, re-sends it on a fresh reference with backoff,
// or, when every send has failed, hands it back for the customer to claim with
// another number and tells them so. See "reward delivery" in
// billHero.controller.
{
  const { settleRewardDeliveries } = require('./src/controllers/billHero.controller');
  const rewardSweepTimer = setInterval(
    () => settleRewardDeliveries().catch(() => null),
    Number(process.env.BILL_HERO_REWARD_SWEEP_INTERVAL_MS || 5 * 60_000)
  );
  if (rewardSweepTimer && typeof rewardSweepTimer.unref === 'function') rewardSweepTimer.unref();
}

// Airtime to Cash finishes itself: payouts Paystack has not answered for,
// conversions MySubWallet has not confirmed, submits a dead process left
// behind, and drafts nobody came back to. The Paystack webhook settles payouts
// faster when it arrives; this is the path that does not depend on it. Also
// pages ops once a conversion has waited too long for somebody to fund
// Paystack and mark it available. See sweep() in airtimeCash.service.
{
  const { sweep: sweepAirtimeCash } = require('./src/services/airtimeCash.service');
  const airtimeCashSweepTimer = setInterval(
    () => sweepAirtimeCash().catch(e => captureError('airtime_cash.sweep', e)),
    Number(process.env.A2C_SWEEP_INTERVAL_MS || 5 * 60_000)
  );
  if (airtimeCashSweepTimer && typeof airtimeCashSweepTimer.unref === 'function') airtimeCashSweepTimer.unref();
}

// CAC Registration finishes itself too: a Paystack checkout whose webhook never
// arrived and whose app never came back to verify is asked about here, and any
// payment that lands on an application already paid is handed back to the
// wallet in the same pass. Also clears out drafts nobody returned to, documents
// and all. See sweep() in cac.service.
{
  const { sweep: sweepCac } = require('./src/services/cac.service');
  const cacSweepTimer = setInterval(
    () => sweepCac().catch(e => captureError('cac.sweep', e)),
    Number(process.env.CAC_SWEEP_INTERVAL_MS || 5 * 60_000)
  );
  if (cacSweepTimer && typeof cacSweepTimer.unref === 'function') cacSweepTimer.unref();
}

// USD cards finish themselves: a card Payvessel is still making is read until
// it is active (or refunded), a top-up whose answer was lost is matched in the
// card's own history (or refunded once a run of good reads shows it never
// landed), live balances are re-read, and a card nobody funded gets its
// reminder before Payvessel closes it. Payvessel's webhook only makes this
// faster - their dashboard may not accept our callback URL at all. See sweep()
// in virtualCard.service.
{
  const { sweep: sweepVirtualCards } = require('./src/services/virtualCard.service');
  const virtualCardSweepTimer = setInterval(
    () => sweepVirtualCards().catch(e => captureError('virtual_card.sweep', e)),
    Number(process.env.VCARD_SWEEP_INTERVAL_MS || 5 * 60_000)
  );
  if (virtualCardSweepTimer && typeof virtualCardSweepTimer.unref === 'function') virtualCardSweepTimer.unref();
}

// Provider catalogues - data plans, TV bouquets, DISCO lists - are what the
// bills screen renders, and the upstream's rate budget is shared with live
// vending. Loading them on demand means the customer who arrives on a cold
// cache waits on the provider for a list everyone else gets instantly.
//
// So the refresh is moved off the request path entirely. Warm once shortly after
// boot, then replace on an interval shorter than the freshness window, so the
// value is renewed before it can go stale rather than after. Both are
// fire-and-forget and lock across instances - see warmCatalogues.
//
// **Every configured provider is warmed, including one no rail is currently
// switched to.** That is the point: an admin flips a rail during an incident and
// the new upstream has to serve the bills screen on the next request, not after
// a cold load. A provider with no credentials skips itself for free, so the only
// cost is a handful of calls against a budget nothing else is spending.
{
  const bills = require('./src/funding/billsProvider');
  const warmAll = async opts => {
    const results = await Promise.all(
      Object.entries(bills.ADAPTERS).map(async ([name, adapter]) => {
        try {
          return { name, ...(await adapter.warmCatalogues(opts)) };
        } catch {
          return { name, loaded: 0, failed: 0, calls: 0, skipped: 'error' };
        }
      })
    );
    return {
      loaded: results.reduce((n, r) => n + (r.loaded || 0), 0),
      failed: results.reduce((n, r) => n + (r.failed || 0), 0),
      calls: results.reduce((n, r) => n + (r.calls || 0), 0),
      // Only when *every* provider skipped is the pass as a whole a no-op - and
      // 'no_shared_cache' wins the reporting, because it is the one reason that
      // means warming has actually stopped rather than simply not applying.
      skipped: results.every(r => r.skipped)
        ? results.find(r => r.skipped === 'no_shared_cache')?.skipped || results.find(r => r.skipped)?.skipped
        : null,
      by_provider: results,
    };
  };
  const warmCatalogues = warmAll;

  // Deferred and unawaited: a slow provider must not delay the listener, and a
  // deploy of N instances should not have all of them call out on the same
  // second - which a fixed delay guaranteed they would.
  //
  // The boot pass does not force, so an instance that starts behind another one
  // reads each catalogue back out of Redis and calls the provider zero times.
  // That dedup is free, but only if the first instance has already written the
  // key, and identical delays put them in the provider together instead. A
  // small offset is enough to fix it: both walk the same steps at the same
  // paced interval, so once staggered the later instance stays a step behind
  // and hits L2 the whole way down. With Redis unavailable there is no dedup at
  // all, and spreading the starts is the only thing keeping N boots off one key.
  const warmJitterMs = Number(process.env.BILLS_WARM_JITTER_MS || 5_000);
  const warmDelayMs = Number(process.env.BILLS_WARM_DELAY_MS || 3_000) + Math.random() * warmJitterMs;

  setTimeout(() => {
    warmCatalogues()
      .then(r => {
        if (r?.skipped) return;
        // `calls` is the rate-limit cost, and it is the number that matters:
        // `loaded` counts steps, and a step is not always exactly one call.
        console.log(`📚 Bills catalogues warmed (${r.loaded} loaded, ${r.failed} failed, ${r.calls} provider calls)`);
      })
      .catch(() => null);
  }, warmDelayMs).unref();

  const warmIntervalMs = Number(process.env.BILLS_WARM_INTERVAL_MS || 25 * 60_000);
  // The lock has to expire *before* the next tick, or the tick that finds it
  // still held skips - and a lock TTL equal to the interval makes that a coin
  // flip. A minute of headroom is far more than a warm pass takes.
  const warmLockMs = Math.max(60_000, warmIntervalMs - 60_000);
  const catalogueWarmTimer = setInterval(
    () =>
      warmCatalogues({ force: true, lockMs: warmLockMs })
        .then(r => {
          // 'locked' is the normal outcome on every instance but one, so it says
          // nothing. 'no_shared_cache' means warming has stopped until Redis is
          // back, which is exactly the kind of thing that used to be silent -
          // one line per cycle is cheap and the outage should be visible.
          if (r?.skipped === 'no_shared_cache') {
            console.warn('⚠️  Catalogue warm skipped: Redis unavailable, plans will load on demand.');
          }
        })
        .catch(() => null),
    warmIntervalMs
  );
  if (catalogueWarmTimer && typeof catalogueWarmTimer.unref === 'function') catalogueWarmTimer.unref();
}

// Resolved tickets close themselves after a week of silence. The threshold is
// days, so six-hourly is plenty and a missed tick costs nothing.
{
  const { autoCloseStaleTickets } = require('./src/controllers/support.controller');
  const supportAutoCloseTimer = setInterval(
    () => autoCloseStaleTickets().catch(() => null),
    Number(process.env.SUPPORT_AUTO_CLOSE_INTERVAL_MS || 6 * 60 * 60_000)
  );
  if (supportAutoCloseTimer && typeof supportAutoCloseTimer.unref === 'function') supportAutoCloseTimer.unref();
}

// Weekly/monthly spending summaries. Hourly is fine: the tick only fires on a
// Monday or the 1st from 09:00 WAT, and the notification is keyed on the period
// so a restart inside that hour cannot send the same summary twice.
{
  const { runSpendingInsightsTick } = require('./src/services/spendingInsights.service');
  const spendingInsightsTimer = setInterval(
    () => runSpendingInsightsTick().catch(() => null),
    Number(process.env.SPENDING_INSIGHTS_INTERVAL_MS || 60 * 60_000)
  );
  if (spendingInsightsTimer && typeof spendingInsightsTimer.unref === 'function') spendingInsightsTimer.unref();
}

// Accounts past their deletion cooling period. Hourly: the window is days, and
// a missed tick only delays a purge by an hour.
{
  const { purgeDueDeletions } = require('./src/controllers/account.controller');
  const deletionPurgeTimer = setInterval(
    () => purgeDueDeletions().catch(() => null),
    Number(process.env.ACCOUNT_PURGE_INTERVAL_MS || 60 * 60_000)
  );
  if (deletionPurgeTimer && typeof deletionPurgeTimer.unref === 'function') deletionPurgeTimer.unref();
}

// A crash in an unawaited promise used to vanish into stdout. Alert on it - it
// is the class of bug that leaves a payment half-applied.
// Registering this handler also stops Node from killing the process over a
// stray rejection, which is the behaviour we want: one aborted provider fetch
// must not take the API down with it.
process.on('unhandledRejection', reason => {
  captureError('process.unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
});

// An uncaught exception leaves the process in an undefined state, so this one
// does exit - but only after the alert has had a moment to go out.
process.on('uncaughtException', error => {
  captureError('process.uncaughtException', error);
  setTimeout(() => process.exit(1), 2_000).unref();
});

server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 61_000);
server.headersTimeout = Number(process.env.HEADERS_TIMEOUT_MS || 65_000);

async function shutdown(signal) {
  try {
    console.log(`\n${signal} received: closing server...`);
    await prisma.$disconnect().catch(() => null);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  } catch (_) {
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
