#!/usr/bin/env node
/**
 * Pre-flight for FCM. Run after setting FIREBASE_SERVICE_ACCOUNT_JSON, and
 * again after every key rotation:
 *
 *   node scripts/check-fcm.js
 *
 * Checks the three things that actually break, in the order they break:
 *
 *   1. the env var parses into a service account
 *   2. the key still mints an OAuth2 access token - this is the exact
 *      credential FCM HTTP v1 runs on, so a pass here means the key is live
 *      and the API is enabled
 *   3. the key's project matches android/app/google-services.json, and that
 *      file carries the app's applicationId
 *
 * (3) is the silent one: a mismatch does not fail at boot, it fails per-send
 * with `SenderId mismatch` long after you have stopped watching the logs.
 *
 * Prints no secrets.
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { loadFirebaseServiceAccount } = require('../src/services/firebase.service');

const ANDROID_JSON = path.join(__dirname, '..', '..', 'android', 'app', 'google-services.json');
const APP_GRADLE = path.join(__dirname, '..', '..', 'android', 'app', 'build.gradle.kts');

let failed = false;
const ok = m => console.log(`✅ ${m}`);
const bad = m => {
  failed = true;
  console.error(`❌ ${m}`);
};
const warn = m => console.warn(`⚠️  ${m}`);

function loadServiceAccount() {
  if (!(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim()) {
    bad('FIREBASE_SERVICE_ACCOUNT_JSON is not set in backend/.env');
    return null;
  }
  try {
    const parsed = loadFirebaseServiceAccount();
    if (!parsed.project_id || !parsed.private_key || !parsed.client_email) {
      bad('Service account JSON is missing project_id / private_key / client_email');
      return null;
    }
    return parsed;
  } catch (e) {
    bad(`Could not parse FIREBASE_SERVICE_ACCOUNT_JSON: ${e.message}`);
    console.error('   Paste the raw JSON on one line, or base64 the whole file.');
    return null;
  }
}

function readApplicationId() {
  try {
    const gradle = fs.readFileSync(APP_GRADLE, 'utf8');
    const m = gradle.match(/applicationId\s*=\s*"([^"]+)"/);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

function checkAndroidConfig(projectId) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(ANDROID_JSON, 'utf8'));
  } catch (_) {
    warn('android/app/google-services.json not found - skipping client checks');
    return;
  }

  const jsonProject = json?.project_info?.project_id;
  if (jsonProject === projectId) {
    ok(`google-services.json is the same project (${jsonProject})`);
  } else {
    bad(`Project mismatch: key is "${projectId}", google-services.json is "${jsonProject}"`);
    console.error('   Every send will fail with `SenderId mismatch`. Both must come');
    console.error('   from one Firebase project. See FCM_SETUP.md §0.');
  }

  const appId = readApplicationId();
  const packages = (json.client || [])
    .map(c => c?.client_info?.android_client_info?.package_name)
    .filter(Boolean);

  if (!appId) {
    warn('Could not read applicationId from android/app/build.gradle.kts');
    return;
  }
  if (packages.includes(appId)) {
    ok(`google-services.json has a client for ${appId}`);
  } else {
    bad(`google-services.json has no client for applicationId "${appId}"`);
    console.error(`   It contains: ${packages.join(', ') || '(none)'}`);
    console.error('   The Android build will fail with "No matching client found".');
    console.error('   Add that package as an Android app in the Firebase Console');
    console.error('   and re-download google-services.json.');
  }
}

(async () => {
  const serviceAccount = loadServiceAccount();
  if (!serviceAccount) process.exit(1);
  ok(`Service account parsed (project ${serviceAccount.project_id})`);

  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id,
    });
  } catch (e) {
    bad(`initializeApp failed: ${e.message}`);
    process.exit(1);
  }

  try {
    const token = await admin.app().options.credential.getAccessToken();
    if (token && token.access_token) {
      ok('Key minted an OAuth2 access token - FCM HTTP v1 is reachable');
    } else {
      bad('Credential returned no access token');
    }
  } catch (e) {
    bad(`Could not mint an access token: ${e.message}`);
    console.error('   Usual causes: the key was deleted/rotated, or the');
    console.error('   Firebase Cloud Messaging API (V1) is disabled for the project.');
  }

  checkAndroidConfig(serviceAccount.project_id);

  console.log(failed ? '\nFCM is NOT ready.' : '\nFCM is ready.');
  process.exit(failed ? 1 : 0);
})();
