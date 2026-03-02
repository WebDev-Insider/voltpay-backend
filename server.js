
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const prisma = require('./database/prisma');
const admin = require('firebase-admin');
const { Resend } = require('resend');
const https = require('https');
const dns = require('dns');
const passwordRoutes = require('./src/routes/password.routes');
const settingsRoutes = require('./src/routes/settings.routes');
const authRoutes = require('./src/routes/auth.routes');
const userRoutes = require('./src/routes/user.routes');
const uploadRoutes = require('./src/routes/upload.routes');
const dashboardRoutes = require('./src/routes/dashboard.routes');
const transactionsRoutes = require('./src/routes/transactions.routes');
const airtimeRoutes = require('./src/routes/airtime.routes');
const dataRoutes = require('./src/routes/data.routes');
const electricityRoutes = require('./src/routes/electricity.routes');
const cableRoutes = require('./src/routes/cable.routes');
const sendMoneyRoutes = require('./src/routes/sendMoney.routes');
const verificationRoutes = require('./src/routes/verification.routes');
const statementsRoutes = require('./src/routes/statements.routes');
const fundingRoutes = require('./src/routes/funding.routes');
const miscRoutes = require('./src/routes/misc.routes');
const pushNotificationsRoutes = require('./src/routes/pushNotifications.routes');
const assetsRoutes = require('./src/routes/assets.routes');
const contentRoutes = require('./src/routes/content.routes');
const supportRoutes = require('./src/routes/support.routes');
const adminRoutes = require('./src/routes/admin.routes');
const adminAuth = require('./src/middlewares/adminAuth.middleware');
const session = require('./src/services/session.service');
const { ensurePasswordResetsTable } = require('./src/models/passwordReset.model');
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

// Initialize Firebase Admin SDK
try {
  // For development, we'll use the default credentials
  // In production, set GOOGLE_APPLICATION_CREDENTIALS environment variable
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: process.env.FIREBASE_PROJECT_ID || 'your-firebase-project-id'
  });
  console.log('🔥 Database Admin SDK initialized successfully');
} catch (error) {
  console.log('⚠️  Firebase Admin SDK not initialized (using mock mode):', error.message);
}

// Resend-related helpers and password reset helpers moved into services/controllers under src/


// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'demo',
  api_key: process.env.CLOUDINARY_API_KEY || 'demo',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'demo'
});

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
app.use(cors({ maxAge: 86400 }));
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
  })
);

if (process.env.HTTP_LOGGING === '1' || process.env.NODE_ENV !== 'production') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// API base prefix to match Flutter's UrlContainer.baseUrl = `${domain}/api/`
const API_PREFIX = process.env.API_PREFIX || '/api';

// Mount modular routes
app.use(API_PREFIX, passwordRoutes);
app.use(API_PREFIX, settingsRoutes);
app.use(API_PREFIX, authRoutes);
app.use(API_PREFIX, userRoutes);
app.use(API_PREFIX, uploadRoutes);
app.use(API_PREFIX, dashboardRoutes);
app.use(API_PREFIX, transactionsRoutes);
app.use(API_PREFIX, statementsRoutes);
app.use(API_PREFIX, fundingRoutes);
app.use(API_PREFIX, airtimeRoutes);
app.use(API_PREFIX, dataRoutes);
app.use(API_PREFIX, electricityRoutes);
app.use(API_PREFIX, cableRoutes);
app.use(API_PREFIX, sendMoneyRoutes);
app.use(API_PREFIX, verificationRoutes);
app.use(API_PREFIX, miscRoutes);
app.use(API_PREFIX, pushNotificationsRoutes);
app.use(API_PREFIX, contentRoutes);
app.use(API_PREFIX, supportRoutes);
app.use(`${API_PREFIX}/admin`, adminAuth, adminRoutes);
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

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    
    res.json({
      status: 'healthy',
      database: 'connected',
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
      add_device_token: `${API_PREFIX}/add-device-token`,
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
  console.error('Unhandled error:', error);
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
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🌍 Countries API: http://localhost:${PORT}${API_PREFIX}/get-countries`);
  console.log(`🌐 Language API: http://localhost:${PORT}${API_PREFIX}/language/en`);
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
