const admin = require('firebase-admin');

/**
 * Firebase Admin bootstrap, shared by server.js, scripts/check-fcm.js and
 * scripts/send-test-push.js so the credential is parsed one way everywhere.
 *
 * This credential is what mints the OAuth2 access token for FCM HTTP v1
 * (fcm.service.js). Prefer FIREBASE_SERVICE_ACCOUNT_JSON - a PaaS gives you an
 * env var, not a file on disk - and fall back to GOOGLE_APPLICATION_CREDENTIALS.
 * The JSON is a secret: env var only, never committed.
 */
function loadFirebaseServiceAccount() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) return null;
  // Accept both the raw JSON and a base64 blob, because a multi-line private
  // key pasted straight into a dashboard env field usually arrives mangled.
  const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const parsed = JSON.parse(text);
  if (parsed.private_key) parsed.private_key = String(parsed.private_key).replace(/\\n/g, '\n');
  return parsed;
}

/** Returns the credential source, or null if Firebase could not start. */
function initFirebase() {
  if (admin.apps.length) return 'already_initialized';
  try {
    const serviceAccount = loadFirebaseServiceAccount();
    admin.initializeApp({
      credential: serviceAccount
        ? admin.credential.cert(serviceAccount)
        : admin.credential.applicationDefault(),
      projectId: (serviceAccount && serviceAccount.project_id) || process.env.FIREBASE_PROJECT_ID,
    });
    return serviceAccount ? 'FIREBASE_SERVICE_ACCOUNT_JSON' : 'application_default';
  } catch (error) {
    console.log('⚠️  Firebase Admin SDK not initialized (push notifications disabled):', error.message);
    return null;
  }
}

module.exports = { loadFirebaseServiceAccount, initFirebase };
