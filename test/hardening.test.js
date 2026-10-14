/**
 * The four security-checklist gaps, covered where they can break silently.
 *
 * What must not break:
 *   1. Retry classification. Retrying a declined purchase because the message
 *      said "failed" would vend twice; not retrying a timeout wastes the whole
 *      point. The line between the two is `isTransient`.
 *   2. The retry ceiling. An unbounded loop against a provider that is down is
 *      the outage, not the cure.
 *   3. Audit redaction. The middleware sees a body containing a PIN. What it
 *      writes must name the field and never carry the value.
 *   4. The deletion grace window, and the payroll retry backoff growing.
 *
 * Run with: node test/hardening.test.js
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);
delete process.env.ALERT_WEBHOOK_URL; // no outbound posts from a test run

const { withRetry, isTransient, delayFor, MAX_ALLOWED_RETRIES } = require('../src/helpers/retry.helper');
const { __test: auditTest } = require('../src/middlewares/adminAudit.middleware');
const { __test: alertTest } = require('../src/services/alerts.service');

// --- what counts as transient --------------------------------------------
assert.strictEqual(isTransient(Object.assign(new Error('x'), { statusCode: 504 })), true, 'gateway timeout retries');
assert.strictEqual(isTransient(Object.assign(new Error('x'), { statusCode: 429 })), true, 'rate limit retries');
assert.strictEqual(isTransient(Object.assign(new Error('x'), { statusCode: 502 })), true);
assert.strictEqual(isTransient(Object.assign(new Error('Invalid meter number'), { statusCode: 400 })), false, 'a bad request repeats identically');
assert.strictEqual(isTransient(Object.assign(new Error('Unauthorized'), { statusCode: 401 })), false);
assert.strictEqual(
  isTransient(Object.assign(new Error('Transaction failed'), { statusCode: 400 })),
  false,
  'a declined vend says "failed" - a permanent status code must win over the message',
);
assert.strictEqual(isTransient(Object.assign(new Error('boom'), { name: 'AbortError' })), true, 'our own timeout retries');
assert.strictEqual(isTransient(Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' })), true);
assert.strictEqual(isTransient(new Error('fetch failed')), true, 'undici network failure');
assert.strictEqual(isTransient(null), false);

// --- backoff grows, is bounded, and is never instant ----------------------
{
  const first = delayFor(0, 300, 4000);
  const third = delayFor(2, 300, 4000);
  assert.ok(first >= 150 && first <= 300, `first delay in half-window range, got ${first}`);
  assert.ok(third >= 600 && third <= 1200, `third delay has grown, got ${third}`);
  assert.ok(delayFor(10, 300, 4000) <= 4000, 'the cap holds');
  assert.ok(delayFor(0, 300, 4000) > 0, 'jitter never produces an instant retry');
}

// --- withRetry: attempts, ceiling, and giving up --------------------------
(async () => {
  let calls = 0;
  const value = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error('down'), { statusCode: 503 });
    return 'ok';
  }, { retries: 3, baseMs: 1, maxMs: 2 });
  assert.strictEqual(value, 'ok');
  assert.strictEqual(calls, 3, 'retried until it succeeded');

  calls = 0;
  await assert.rejects(
    () => withRetry(async () => {
      calls += 1;
      throw Object.assign(new Error('still down'), { statusCode: 503 });
    }, { retries: 2, baseMs: 1, maxMs: 2 }),
    /still down/,
    'the last error surfaces once the ceiling is hit',
  );
  assert.strictEqual(calls, 3, 'one attempt plus two retries, and no more');

  calls = 0;
  await assert.rejects(
    () => withRetry(async () => {
      calls += 1;
      throw Object.assign(new Error('Invalid meter number'), { statusCode: 400 });
    }, { retries: 3, baseMs: 1 }),
    /Invalid meter/,
  );
  assert.strictEqual(calls, 1, 'a permanent failure is never repeated');

  calls = 0;
  await assert.rejects(
    () => withRetry(async () => {
      calls += 1;
      throw Object.assign(new Error('down'), { statusCode: 503 });
    }, { retries: 99, baseMs: 1, maxMs: 2 }),
  );
  assert.strictEqual(calls, MAX_ALLOWED_RETRIES + 1, 'the hard cap overrides a caller asking for 99');

  // --- audit redaction ----------------------------------------------------
  {
    const body = { pin: '1234', status: 0, password: 'hunter2', role: 'admin', note: 'blocked for fraud' };
    const safe = auditTest.safeBody(body);

    assert.deepStrictEqual(safe.values, { status: '0', role: 'admin' }, 'only allowlisted admin-authored scalars are kept');
    assert.ok(!('pin' in safe.values), 'a PIN value never reaches the audit row');
    assert.ok(!('password' in safe.values));
    assert.ok(safe.fields.includes('pin'), 'the field name is recorded, so "did they reset a PIN" is answerable');
    assert.strictEqual(JSON.stringify(safe).includes('1234'), false, 'no secret anywhere in the payload');
    assert.strictEqual(JSON.stringify(safe).includes('hunter2'), false);

    const described = auditTest.describe({ method: 'PATCH', originalUrl: '/api/admin/users/12/status?x=1' });
    assert.strictEqual(described.targetType, 'users');
    assert.strictEqual(described.targetId, '12');
    assert.strictEqual(described.action, 'patch.users.status');
    assert.strictEqual(described.path, '/api/admin/users/12/status', 'the query string is dropped - it can carry a search term');

    const deletion = auditTest.describe({ method: 'DELETE', originalUrl: '/api/admin/users/7' });
    assert.strictEqual(deletion.action, 'delete.users');
    assert.strictEqual(deletion.targetId, '7');
  }

  // --- alert throttling ---------------------------------------------------
  {
    alertTest.throttle.clear();

    const a = alertTest.throttleKey('payment.mysubwallet.airtime', 'Insufficient funds for 08031234567');
    const b = alertTest.throttleKey('payment.mysubwallet.airtime', 'Insufficient funds for 09098765432');
    assert.strictEqual(a, b, 'the same failure for two customers shares one bucket');
    assert.strictEqual(a.includes('0803'), false, 'no phone number in the throttle key');

    assert.strictEqual(alertTest.takeSlot(a).send, true, 'first one goes out');
    assert.strictEqual(alertTest.takeSlot(a).send, false, 'the duplicate is suppressed');
    assert.strictEqual(alertTest.takeSlot(a).suppressed, 2, 'suppressed ones are counted, not lost');
    assert.strictEqual(alertTest.takeSlot('other:thing').send, true, 'an unrelated failure is not suppressed');
    alertTest.throttle.clear();
  }

  // --- payroll retry backoff and ceiling ----------------------------------
  {
    delete process.env.STAFFPAY_MAX_AUTO_RETRIES;
    delete process.env.STAFFPAY_RETRY_BASE_MS;
    const { retryBackoffMs, maxAutoRetries } = require('../src/services/staffpayPayroll.service');

    assert.strictEqual(maxAutoRetries(), 3, 'three unattended attempts, then a human');
    assert.strictEqual(retryBackoffMs(0), 5 * 60_000);
    assert.strictEqual(retryBackoffMs(1), 20 * 60_000);
    assert.strictEqual(retryBackoffMs(2), 80 * 60_000);
    assert.ok(retryBackoffMs(20) <= 6 * 60 * 60_000, 'the wait is capped at six hours');
  }

  // --- deletion grace window ----------------------------------------------
  {
    const { __test: accountTest } = require('../src/controllers/account.controller');

    process.env.ACCOUNT_DELETION_GRACE_DAYS = '7';
    const from = new Date('2026-08-10T09:00:00.000Z');
    assert.strictEqual(accountTest.deletionGraceDays(), 7);
    assert.strictEqual(accountTest.deletionDueAt(from).toISOString(), '2026-08-17T09:00:00.000Z');

    process.env.ACCOUNT_DELETION_GRACE_DAYS = 'not-a-number';
    assert.strictEqual(accountTest.deletionGraceDays(), 30, 'a broken env falls back to the safe default, never to 0');

    process.env.ACCOUNT_DELETION_GRACE_DAYS = '0';
    assert.strictEqual(accountTest.deletionGraceDays(), 0, 'but an explicit 0 is honoured');
    delete process.env.ACCOUNT_DELETION_GRACE_DAYS;
  }

  // --- CORS allowlist -------------------------------------------------------
  {
    const { parseOrigins, corsOrigin } = require('../src/helpers/cors.helper');
    const decide = origins => origin => {
      let allowed;
      corsOrigin(origins)(origin, (_err, ok) => { allowed = ok; });
      return allowed;
    };

    assert.deepStrictEqual(
      parseOrigins(' https://admin.voltpay.ng/ , https://app.voltpay.ng ,, '),
      ['https://admin.voltpay.ng', 'https://app.voltpay.ng'],
      'trailing slashes and blanks must not create origins nothing can match'
    );

    const strict = decide('https://admin.voltpay.ng');
    assert.strictEqual(strict('https://admin.voltpay.ng'), true);
    assert.strictEqual(strict('https://admin.voltpay.ng/'), true, 'a trailing slash is the same origin');
    assert.strictEqual(strict('https://evil.example'), false);
    assert.strictEqual(strict('https://admin.voltpay.ng.evil.example'), false, 'suffix must not pass as a prefix match');
    assert.strictEqual(strict(undefined), true, 'the mobile app and provider webhooks send no Origin');

    assert.strictEqual(decide('')('https://evil.example'), true, 'unset allows everything - dev only, and the reason step 4 of the deploy list exists');
  }

  console.log('✅ hardening.test.js passed');
  process.exit(0);
})().catch(e => {
  console.error('❌', e);
  process.exit(1);
});
