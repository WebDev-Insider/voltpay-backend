/**
 * Self-check for the admin account stack: TOTP, tokens, password policy,
 * recovery codes and the response mapper.
 *
 * Run: node test/adminAccounts.test.js
 */

const assert = require('assert');
const crypto = require('crypto');

process.env.PII_HASH_KEY = crypto.randomBytes(32).toString('hex');
process.env.PII_ENC_KEY = crypto.randomBytes(32).toString('hex');
process.env.JWT_SECRET = 'customer-secret';
process.env.ADMIN_JWT_SECRET = 'admin-secret-and-different';

const totp = require('../src/helpers/totp.helper');
const account = require('../src/helpers/adminAccount.helper');
const { __test: mw } = require('../src/middlewares/adminAuth.middleware');

async function main() {
  // --- TOTP ------------------------------------------------------------
  // RFC 6238 vector: ASCII "12345678901234567890", SHA-1, T = 59s.
  const rfcSecret = totp.__test.base32Encode(Buffer.from('12345678901234567890', 'ascii'));
  assert.strictEqual(rfcSecret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'base32 of the RFC secret');
  assert.strictEqual(totp.__test.codeAt(rfcSecret, 1), '287082', 'RFC 6238 code at T=59');
  assert.strictEqual(totp.__test.codeAt(rfcSecret, 37037036), '081804', 'RFC 6238 code at T=1111111109');

  // Round trip through a random secret, which is the shape actually stored.
  const secret = totp.generateSecret();
  assert.strictEqual(totp.__test.base32Decode(secret).length, 20, '20 random bytes');

  const now = Date.now();
  assert.ok(totp.verifyToken(secret, totp.currentCode(secret, now), now), 'current code passes');
  // One step of clock drift either way is accepted, two is not.
  assert.ok(totp.verifyToken(secret, totp.currentCode(secret, now - 30_000), now), 'previous step accepted');
  assert.ok(totp.verifyToken(secret, totp.currentCode(secret, now + 30_000), now), 'next step accepted');
  assert.ok(!totp.verifyToken(secret, totp.currentCode(secret, now - 120_000), now), 'stale code rejected');

  assert.ok(!totp.verifyToken(secret, '12345', now), 'short code rejected');
  assert.ok(!totp.verifyToken(secret, 'abcdef', now), 'non-numeric code rejected');
  assert.ok(!totp.verifyToken('', '123456', now), 'missing secret rejected');
  // A corrupt secret column must fail, not throw an unhandled error.
  assert.ok(!totp.verifyToken('not base32!!!', '123456', now), 'corrupt secret rejected');

  const uri = totp.otpauthUri({ secret, account: 'ada' });
  assert.ok(uri.startsWith('otpauth://totp/'), 'otpauth uri');
  // A `+` here means form encoding leaked in and the issuer reads as
  // "VoltPay+Admin", which no longer matches the label prefix.
  assert.ok(!uri.includes('+'), 'issuer space encoded as %20, not +');
  assert.ok(uri.includes('issuer=VoltPay%20Admin'), 'issuer matches label prefix');

  // --- tokens ----------------------------------------------------------
  const token = account.signAdminToken({ id: 7, role: 'finance' }, 'sid-1');
  const payload = account.verifyAdminToken(token);
  assert.strictEqual(payload.sub, '7');
  assert.strictEqual(payload.sid, 'sid-1');

  // A half-authenticated 2FA challenge must not be usable as a session token.
  const challenge = account.signChallengeToken(7);
  assert.strictEqual(account.verifyAdminToken(challenge), null, 'challenge rejected as access token');
  assert.strictEqual(account.verifyAdminToken(challenge, account.CHALLENGE_TYP).sub, '7');
  assert.strictEqual(account.verifyAdminToken('garbage'), null, 'garbage rejected');

  // A customer token must never open the admin API.
  const customerToken = require('jsonwebtoken').sign({ sub: '7', typ: 'admin', sid: 'sid-1' }, process.env.JWT_SECRET);
  assert.strictEqual(account.verifyAdminToken(customerToken), null, 'customer secret does not sign admin tokens');

  // Same secret for both = no separation at all, so it is refused.
  process.env.ADMIN_JWT_SECRET = process.env.JWT_SECRET;
  assert.strictEqual(account.adminJwtSecret(), null, 'ADMIN_JWT_SECRET must differ from JWT_SECRET');
  process.env.ADMIN_JWT_SECRET = 'admin-secret-and-different';

  // --- password policy -------------------------------------------------
  assert.ok(account.validateAdminPassword('Short1!a'), 'under 12 chars rejected');
  assert.ok(account.validateAdminPassword('alllowercase123!'), 'no uppercase rejected');
  assert.ok(account.validateAdminPassword('NoSymbolsHere123'), 'no symbol rejected');
  assert.strictEqual(account.validateAdminPassword('Str0ng!Passw0rd'), '', 'valid password accepted');
  // The generated temporary password must satisfy the policy it is checked by.
  const generated = `Vp!${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}A1`;
  assert.strictEqual(account.validateAdminPassword(generated), '', 'generated temp password passes policy');

  assert.ok(account.isValidEmail('Ada@VoltPay.NG'), 'email normalised before validating');
  assert.ok(!account.isValidEmail('not-an-email'));

  // --- recovery codes --------------------------------------------------
  const { plain, hashed } = await account.generateRecoveryCodes();
  assert.strictEqual(plain.length, account.RECOVERY_CODE_COUNT);
  assert.strictEqual(new Set(plain).size, plain.length, 'codes are distinct');
  // Only hashes are stored: nothing in the stored array may equal a live code.
  for (const code of plain) assert.ok(!hashed.includes(code), 'plaintext code never stored');

  const remaining = await account.consumeRecoveryCode(hashed, plain[3]);
  assert.strictEqual(remaining.length, hashed.length - 1, 'used code removed');
  assert.strictEqual(await account.consumeRecoveryCode(remaining, plain[3]), null, 'code is single use');
  assert.strictEqual(await account.consumeRecoveryCode(hashed, 'NOPE'), null, 'wrong code rejected');
  assert.strictEqual(await account.consumeRecoveryCode(null, plain[0]), null, 'no codes stored');
  // Written on the card with a dash, typed back lowercase.
  const dashed = `${plain[0].slice(0, 5)}-${plain[0].slice(5)}`.toLowerCase();
  assert.ok(await account.consumeRecoveryCode(hashed, dashed), 'formatting is forgiven');

  // --- response mapper -------------------------------------------------
  const row = {
    id: 3,
    name: 'ada',
    email_enc: require('../src/helpers/pii.helper').encryptValue('ada@voltpay.ng'),
    email_idx: 'abc',
    password: 'b3v1$salt$digest',
    role: 'superadmin',
    status: 1,
    totp_secret_enc: 'iv:tag:ct',
    totp_enabled: true,
    recovery_codes: hashed,
    active_session_id: 'sid-1',
  };
  const shown = account.publicAdmin(row);
  assert.strictEqual(shown.email, 'ada@voltpay.ng', 'email decrypted for display');
  // Allowlist, not a blocklist: a field added to the model must be opted in.
  assert.deepStrictEqual(Object.keys(shown).sort(), [
    'created_at', 'email', 'id', 'last_login_at', 'must_change_password', 'name', 'role', 'status', 'totp_enabled',
  ]);
  const serialised = JSON.stringify(shown);
  for (const leak of ['b3v1', 'sid-1', 'iv:tag:ct', 'abc']) {
    assert.ok(!serialised.includes(leak), `publicAdmin must not leak ${leak}`);
  }

  // --- middleware ------------------------------------------------------
  assert.strictEqual(mw.bearerToken({ headers: { authorization: 'Bearer abc.def' } }), 'abc.def');
  assert.strictEqual(mw.bearerToken({ headers: { authorization: 'Basic abc' } }), '', 'only Bearer counts');
  assert.strictEqual(mw.bearerToken({ headers: {} }), '');

  process.env.ADMIN_API_SECRET = 'shared-key';
  assert.strictEqual(mw.resolveAdmin('shared-key').role, 'superadmin', 'shared secret still works');
  process.env.ADMIN_ALLOW_STATIC_KEYS = '0';
  assert.strictEqual(mw.resolveAdmin('shared-key'), null, 'static keys can be switched off');
  delete process.env.ADMIN_ALLOW_STATIC_KEYS;
  delete process.env.ADMIN_API_SECRET;

  console.log('✅ adminAccounts: all assertions passed');
}

main().catch(e => {
  console.error('❌', e);
  process.exit(1);
});
