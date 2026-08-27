/**
 * node test/appVersionGate.middleware.test.js
 *
 * No network, no database. The gate is the one piece of this system that can
 * refuse a request the user actually made, so what it is tested for is mostly
 * the cases where it must NOT refuse: a caller with no version, the endpoint
 * that releases a blocked user, rules with nowhere to download from, and any
 * error at all. Getting one of those wrong locks people out of a wallet with
 * their money in it, and the handset has no screen left to report it from.
 */
const assert = require('assert');
const crypto = require('crypto');

process.env.PII_HASH_KEY = crypto.randomBytes(32).toString('hex');
process.env.PII_ENC_KEY = crypto.randomBytes(32).toString('hex');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/db';
process.env.DIRECT_URL = process.env.DIRECT_URL || process.env.DATABASE_URL;

const AppUpdate = require('../src/helpers/appUpdate.helper');
const appVersionGate = require('../src/middlewares/appVersionGate.middleware');

const RETIRED = {
  latest_version: '1.0.5',
  min_version: '1.0.5',
  force_update: true,
  android_download_url: 'https://voltpay.example/voltpay-1.0.5.apk',
  update_page_url: '',
  message: 'Please update VoltPay to continue',
  is_active: true,
};

/** Swaps in a fixed rule set (or a thrower) for one call. */
function withSettings(settings, fn) {
  const original = AppUpdate.getUpdateSettings;
  AppUpdate.getUpdateSettings = typeof settings === 'function'
    ? settings
    : async () => settings;
  return fn().finally(() => {
    AppUpdate.getUpdateSettings = original;
  });
}

function fakeReq({ version, path = '/login' }) {
  const headers = {};
  if (version !== undefined) headers['x-app-version'] = version;
  return {
    path,
    get: name => headers[String(name).toLowerCase()],
  };
}

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

/** Runs the gate and reports whether it passed the request through. */
async function run(settings, reqOptions) {
  const req = fakeReq(reqOptions);
  const res = fakeRes();
  let passed = false;
  await withSettings(settings, () => appVersionGate(req, res, () => { passed = true; }));
  return { passed, res };
}

(async () => {
  /* the request is let through */

  // No X-App-Version at all: the admin dashboard, the web build, curl, every
  // webhook. Absent means "not a mobile build", never "unknown, so block".
  {
    const { passed, res } = await run(RETIRED, { version: undefined });
    assert.strictEqual(passed, true, 'a request with no version header must pass');
    assert.strictEqual(res.statusCode, null);
  }

  // An empty header is the same as no header.
  {
    const { passed } = await run(RETIRED, { version: '   ' });
    assert.strictEqual(passed, true, 'a blank version header must pass');
  }

  // The escape hatch. This is what the Update Required screen calls to find out
  // it may leave; gating it makes a mistyped minimum version permanent.
  {
    const { passed } = await run(RETIRED, { version: '1.0.0', path: '/app/version-check' });
    assert.strictEqual(passed, true, '/app/version-check must never be gated');
  }

  // Rules switched off entirely.
  {
    const { passed } = await run({ ...RETIRED, is_active: false }, { version: '1.0.0' });
    assert.strictEqual(passed, true, 'inactive rules block nobody');
  }

  // Rules on, force off: the user gets a soft prompt elsewhere, not a refusal.
  {
    const { passed } = await run({ ...RETIRED, force_update: false }, { version: '1.0.0' });
    assert.strictEqual(passed, true, 'force update off means no refusal');
  }

  // Already on the minimum.
  {
    const { passed } = await run(RETIRED, { version: '1.0.5' });
    assert.strictEqual(passed, true, 'a build at the minimum is allowed');
  }

  // Ahead of the minimum.
  {
    const { passed } = await run(RETIRED, { version: '1.1.0' });
    assert.strictEqual(passed, true, 'a build above the minimum is allowed');
  }

  // A version string we cannot parse is never treated as "older".
  {
    const { passed } = await run(RETIRED, { version: 'not-a-version' });
    assert.strictEqual(passed, true, 'an unparseable version cannot be judged, so it passes');
  }

  // Nothing to download. A block with no link is a screen whose only button
  // opens nothing and whose back gesture is disabled - a dead end.
  {
    const { passed } = await run(
      { ...RETIRED, android_download_url: '', update_page_url: '' },
      { version: '1.0.0' }
    );
    assert.strictEqual(passed, true, 'no download link means no block');
  }

  // Fails open, like every other read in this system.
  {
    const { passed } = await run(
      async () => { throw new Error('redis down'); },
      { version: '1.0.0' }
    );
    assert.strictEqual(passed, true, 'a failed settings read must not block anyone');
  }

  /* the request is refused */

  {
    const { passed, res } = await run(RETIRED, { version: '1.0.0' });
    assert.strictEqual(passed, false, 'a retired build must not reach the handler');
    assert.strictEqual(res.statusCode, 426, '426 collides with no existing client handler');
    assert.strictEqual(res.body.remark, 'update_required');
    assert.strictEqual(res.body.status, 'error');
    assert.deepStrictEqual(res.body.message, ['Please update VoltPay to continue']);

    // The body has to be the same shape as GET /app/version-check so the app
    // parses both with one model.
    const data = res.body.data;
    assert.strictEqual(data.update_required, true);
    assert.strictEqual(data.current_version, '1.0.0');
    assert.strictEqual(data.latest_version, '1.0.5');
    assert.strictEqual(data.min_version, '1.0.5');
    assert.strictEqual(data.download_url, RETIRED.android_download_url);
    assert.ok(data.message, 'the screen always has a sentence to show');
  }

  // The refusal reaches a protected route too, not just the public ones.
  {
    const { passed, res } = await run(RETIRED, { version: '1.0.0', path: '/send-money' });
    assert.strictEqual(passed, false, 'a retired build cannot move money');
    assert.strictEqual(res.statusCode, 426);
  }

  // A prerelease of the minimum ranks below it (semver 11), so it is retired.
  {
    const { passed, res } = await run(RETIRED, { version: '1.0.5-beta.1' });
    assert.strictEqual(passed, false, 'a prerelease ranks below the release');
    assert.strictEqual(res.statusCode, 426);
  }

  // The build number is metadata, not precedence - 1.0.5+2 is still 1.0.5.
  {
    const { passed } = await run(RETIRED, { version: '1.0.5+2' });
    assert.strictEqual(passed, true, 'the build number does not make a version older');
  }

  // When there is no APK link the web page is what the button opens.
  {
    const { res } = await run(
      { ...RETIRED, android_download_url: '', update_page_url: 'https://voltpay.example/update' },
      { version: '1.0.0' }
    );
    assert.strictEqual(res.statusCode, 426);
    assert.strictEqual(res.body.data.download_url, 'https://voltpay.example/update');
  }

  console.log('✅ appVersionGate.middleware tests passed');
})().catch(e => {
  console.error('❌', e.message);
  process.exit(1);
});
