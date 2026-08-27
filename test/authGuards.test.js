/**
 * node test/authGuards.test.js
 *
 * The controls that stand in front of an unauthenticated login. All three fail
 * silently - they keep answering 200 while protecting nothing - so each one is
 * pinned here against the specific way it was broken.
 *
 *   1. The per-account lockout must count one account as one account. The login
 *      lookup accepts 0803xxxxxxx, 803xxxxxxx and 234803xxxxxxx as the same
 *      user, so a lock keyed on what was typed handed that user three separate
 *      budgets - nine PIN guesses instead of three, no second IP needed.
 *   2. The rate limiter must bucket one identity as one identity. Its digest
 *      runs under the 'ratelimit' domain, which does no digit stripping, so
 *      punctuation alone minted a fresh window: the limit was unbounded.
 *   3. Every unauthenticated route that can end in a session or an email must
 *      carry a limiter, and POST /authorization must not issue a token to a
 *      caller that proved nothing.
 *
 * Runs with no Redis, so the lockout and the limiter both exercise their
 * in-process fallback - the path that must still count when Upstash is down.
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.ALLOW_MOCK_OTP;

const { canonicalMobile, blindIndex } = require('../src/helpers/pii.helper');
const LoginLockout = require('../src/helpers/loginLockout.helper');
const rateLimit = require('../src/middlewares/rateLimit.middleware');

// Every way one Nigerian number reaches us. buildMobileWhereForCountry resolves
// all of these to a single account, so every control has to as well.
const ONE_ACCOUNT = [
  '08031234567',
  '8031234567',
  '2348031234567',
  '+2348031234567',
  '+234 803 123 4567',
  '0803 123 4567',
  '0803-123-4567',
  '0803  1234567',
];

async function main() {
  // --- 1. canonical identity ---------------------------------------------
  const canon = new Set(ONE_ACCOUNT.map(m => canonicalMobile('NG', m)));
  assert.strictEqual(canon.size, 1, 'every typed form of one NG number must canonicalize to one string');
  assert.strictEqual([...canon][0], '8031234567', 'the shared last ten digits are the canonical form');

  // Collapsing must not go too far: two real accounts must stay two.
  assert.notStrictEqual(canonicalMobile('NG', '08031234567'), canonicalMobile('NG', '08099999999'));
  // A short number is not padded or truncated into somebody else's.
  assert.strictEqual(canonicalMobile('NG', '12345'), '12345');
  assert.strictEqual(canonicalMobile('NG', ''), '');
  assert.strictEqual(canonicalMobile('NG', null), '');
  // Non-NG keeps its digits: those are looked up as a single exact variant, so
  // trimming to ten would merge different countries' subscribers.
  assert.strictEqual(canonicalMobile('US', '+1 (415) 555-0100'), '14155550100');
  assert.notStrictEqual(canonicalMobile('US', '14155550100'), canonicalMobile('US', '14155550199'));

  // --- 2. the lockout counts an account, not a spelling ------------------
  const lockKeys = new Set(ONE_ACCOUNT.map(m => LoginLockout.lockKey('NG', m)));
  assert.strictEqual(lockKeys.size, 1, 'one account must have exactly one lock key');

  const key = LoginLockout.lockKey('NG', '08031234567');
  assert.notStrictEqual(key, LoginLockout.lockKey('NG', '08099999999'), 'different accounts, different locks');
  assert.notStrictEqual(key, LoginLockout.lockKey('GH', '08031234567'), 'country is part of the key');
  assert.strictEqual(LoginLockout.lockKey('NG', ''), '', 'no number, no key');

  // The key reaches Redis and a long-lived Map, so it must not be a phone book.
  for (const form of ONE_ACCOUNT) {
    const k = LoginLockout.lockKey('NG', form);
    assert.ok(!k.includes('8031234567'), 'a lock key must never contain the number');
    assert.ok(!k.includes('080312'), 'not even a fragment of it');
  }

  // Behaviour: burn the three attempts using one spelling, then confirm the
  // account is frozen when the next guess arrives spelled differently. This is
  // the regression - it used to sail straight through with a fresh budget.
  const victim = '08055500001';
  for (let i = 0; i < LoginLockout.MAX_FAILURES; i++) {
    await LoginLockout.registerFailure(LoginLockout.lockKey('NG', victim));
  }
  assert.ok(
    (await LoginLockout.getLockRemainingSeconds(LoginLockout.lockKey('NG', victim))) > 0,
    'three failures must lock the account'
  );
  for (const retyped of ['8055500001', '2348055500001', '+234 805 550 0001', '0805-550-0001']) {
    const left = await LoginLockout.getLockRemainingSeconds(LoginLockout.lockKey('NG', retyped));
    assert.ok(left > 0, `re-typing the number as ${retyped} must not escape the lock`);
  }
  // A bystander is untouched by someone else's lockout.
  assert.strictEqual(await LoginLockout.getLockRemainingSeconds(LoginLockout.lockKey('NG', '08055500002')), 0);

  // Only a correct login clears it, and it clears for every spelling at once.
  await LoginLockout.clearFailures(LoginLockout.lockKey('NG', '2348055500001'));
  assert.strictEqual(await LoginLockout.getLockRemainingSeconds(LoginLockout.lockKey('NG', victim)), 0);

  // --- 3. the limiter buckets an identity, not a spelling ----------------
  const run = async (mw, body, ip = '1.2.3.4') => {
    let outcome = 'allowed';
    const res = {
      set() {},
      status(code) { if (code === 429) outcome = 'blocked'; return this; },
      json() { return this; },
    };
    await mw({ body, headers: {}, ip }, res, () => {});
    return outcome;
  };

  const mobileLimit = rateLimit({ name: 't_mobile', windowMs: 60_000, max: 3, field: 'mobile_number' });
  const results = [];
  for (const form of ONE_ACCOUNT) {
    results.push(await run(mobileLimit, { mobile_number: form, country: 'NG' }));
  }
  assert.strictEqual(results.filter(r => r === 'allowed').length, 3, 'max=3 means three requests, however the number is typed');
  assert.strictEqual(results.filter(r => r === 'blocked').length, ONE_ACCOUNT.length - 3);

  // ...but the bucket is still per account, so one person hitting the limit
  // cannot lock everyone else out from behind the same carrier NAT.
  assert.strictEqual(
    await run(mobileLimit, { mobile_number: '08099999999', country: 'NG' }),
    'allowed',
    'a different account from the same IP keeps its own window'
  );

  // Email fields: case and padding are the same address to findBasicByEmail, so
  // they must be the same bucket here.
  const emailLimit = rateLimit({ name: 't_email', windowMs: 60_000, max: 2, field: 'email' });
  assert.strictEqual(await run(emailLimit, { email: 'User@Example.com' }), 'allowed');
  assert.strictEqual(await run(emailLimit, { email: '  user@example.com  ' }), 'allowed');
  assert.strictEqual(await run(emailLimit, { email: 'USER@EXAMPLE.COM' }), 'blocked', 'case must not mint a new window');
  assert.strictEqual(await run(emailLimit, { email: 'someone.else@example.com' }), 'allowed');

  // Two IPs, one account: the limiter is per IP by design (the lockout above is
  // the per-account control), so this must still be allowed.
  assert.strictEqual(
    await run(mobileLimit, { mobile_number: '08031234567', country: 'NG' }, '9.9.9.9'),
    'allowed'
  );

  // --- 4. route wiring ----------------------------------------------------
  const layersOf = router => router.stack
    .filter(l => l.route)
    .map(l => ({
      path: l.route.path,
      methods: Object.keys(l.route.methods),
      handles: l.route.stack.map(s => s.handle),
      names: l.route.stack.map(s => s.name || 'anonymous'),
    }));

  const passwordLayers = layersOf(require('../src/routes/password.routes'));
  assert.strictEqual(passwordLayers.length, 3, 'password.routes gained or lost a route - check it is limited');
  for (const layer of passwordLayers) {
    assert.ok(
      layer.names.includes('rateLimitMiddleware'),
      `${layer.path} is unauthenticated and must carry a rate limiter`
    );
  }

  // verify-code and reset guess at the same six-digit code, so they share one
  // window on purpose. Two limiter instances would be two counters, which is
  // twice the guesses against that code for free.
  const verify = passwordLayers.find(l => l.path === '/password/verify-code');
  const reset = passwordLayers.find(l => l.path === '/password/reset');
  assert.ok(verify && reset, 'both code routes must exist');
  assert.strictEqual(
    verify.handles[0],
    reset.handles[0],
    'verify-code and reset must share ONE limiter instance, not one each'
  );

  const authLayers = layersOf(require('../src/routes/auth.routes'));
  // Every unauthenticated route here either issues a session or sends a code.
  for (const path of [
    '/login',
    '/register',
    '/authentication',
    '/authorization',
    '/login/device-otp',
    '/login/recovery',
    '/login/biometric',
  ]) {
    const layer = authLayers.find(l => l.path === path && l.methods.includes('post'));
    assert.ok(layer, `POST ${path} is missing from auth.routes`);
    assert.ok(layer.names.includes('rateLimitMiddleware'), `POST ${path} must carry a rate limiter`);
  }

  // --- 5. /authorization must not hand out a session for nothing ---------
  // The old code fell through to a `console.log` when firebase_token was absent
  // and then signed a real access token, so knowing a phone number was enough
  // to take the account. The guard runs before any database work, which is what
  // makes it testable without one.
  const AuthController = require('../src/controllers/auth.controller');

  const call = async (body, env = {}) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    let status = 200;
    let payload = null;
    const res = {
      set() { return this; },
      status(c) { status = c; return this; },
      json(p) { payload = p; return this; },
    };
    try {
      await AuthController.postAuthorization({ body, headers: {} }, res);
    } finally {
      process.env = saved;
    }
    return { status, payload };
  };

  const noToken = await call({ mobile_number: '08031234567', country: 'NG', otp: '000000' });
  assert.strictEqual(noToken.status, 401, 'no firebase_token must be rejected');
  assert.strictEqual(noToken.payload.remark, 'verification_failed');
  assert.ok(!noToken.payload.data, 'a rejected request must carry no access token');

  // The escape hatch must not exist in production, however the env is set.
  const prodMock = await call(
    { mobile_number: '08031234567', country: 'NG', otp: '000000' },
    { ALLOW_MOCK_OTP: 'true', NODE_ENV: 'production' }
  );
  assert.strictEqual(prodMock.status, 401, 'ALLOW_MOCK_OTP must be inert in production');
  assert.ok(!prodMock.payload.data);

  // Missing fields are still a 400, not a 500 - unchanged by the guard.
  const missing = await call({ country: 'NG' });
  assert.strictEqual(missing.status, 400);
  assert.strictEqual(missing.payload.remark, 'validation_error');

  console.log('✅ authGuards tests passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
