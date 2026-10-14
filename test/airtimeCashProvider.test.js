/**
 * node test/airtimeCashProvider.test.js
 *
 * MySubWallet's POST /api/cash - the three Airtime to Cash steps - with `fetch`
 * stubbed. No network, no Redis, no database.
 *
 * What it pins, in order of what a mistake would cost:
 *
 *   - step 3 whose answer was lost is requeried by the request-id we sent, and
 *     one their requery has never heard of comes back AMBIGUOUS - never as a
 *     decline the caller would read as "nothing happened";
 *   - "insufficient balance" on this path is the customer's line, not our
 *     float: no outage wording, no ops page;
 *   - our own account's KYC tier, and our key, are outages - never a reason the
 *     customer is asked to fix;
 *   - a phone format their validator names by digit count is retried once in
 *     the other form, and only on step 1, where a refusal sent nothing;
 *   - each step goes out in the shape their API takes.
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);
process.env.MYSUBWALLET_API_KEY = 'msw_live_key';
process.env.MYSUBWALLET_RECOVERY_DELAY_MS = '0';
process.env.PROVIDER_MAX_RETRIES = '1';
process.env.PROVIDER_RETRY_BASE_MS = '1';
process.env.PROVIDER_RETRY_MAX_MS = '5';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.NODE_ENV = 'test';

let calls = [];
let cashReply = () => ({ status: 200, body: { status: 'success', data: 'tok-1' } });
let requeryReply = () => ({ status: 404, body: { status: 'fail', message: 'Transaction not found' } });

function networkError() {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  });
}

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const call = {
    method: String(opts.method || 'GET').toUpperCase(),
    path: u.pathname,
    body: opts.body ? JSON.parse(opts.body) : null,
  };
  calls.push(call);

  let out;
  if (call.method === 'POST' && call.path === '/api/cash') out = await cashReply(call);
  else if (call.method === 'GET' && call.path.startsWith('/api/requery/')) out = await requeryReply(call);
  else throw new Error(`unrouted ${call.method} ${call.path}`);

  const text = typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
  return { status: out.status || 200, headers: { get: () => null }, text: async () => text };
};

const msw = require('../src/funding/mysubwallet.service');
const t = msw.__test;

const cashCalls = () => calls.filter(c => c.path === '/api/cash');

async function rejects(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

(async () => {
  /* ---------------------------------------------------------- step 1 */

  calls = [];
  const started = await msw.startAirtimeCash({ network: 'MTN', phone: '+234 803 123 4567' });
  assert.strictEqual(started.token, 'tok-1');
  assert.strictEqual(started.phoneFormat, 'local');
  assert.deepStrictEqual(cashCalls()[0].body, { step: 1, network: 1, phone: '08031234567' }, 'MTN is network 1, phone local');

  await msw.startAirtimeCash({ network: 'airtel', phone: '08021234567' });
  assert.strictEqual(cashCalls()[1].body.network, 2, 'Airtel is network 2');

  // Glo and 9mobile are refused before anything is sent.
  calls = [];
  const glo = await rejects(msw.startAirtimeCash({ network: 'GLO', phone: '08051234567' }));
  assert.strictEqual(glo.statusCode, 400);
  assert.strictEqual(cashCalls().length, 0, 'an unsupported network costs no call');

  // Their validator names the format it wants: one retry in the other form.
  calls = [];
  cashReply = call =>
    String(call.body.phone).startsWith('234')
      ? { status: 200, body: { status: 'success', data: { data: 'tok-intl' } } }
      : { status: 403, body: { status: 'fail', message: 'The phone must be 13 digits.' } };
  const intl = await msw.startAirtimeCash({ network: 'MTN', phone: '08031234567' });
  assert.strictEqual(intl.token, 'tok-intl', 'a token nested in an object is still found');
  assert.strictEqual(intl.phoneFormat, 'international');
  assert.deepStrictEqual(cashCalls().map(c => c.body.phone), ['08031234567', '2348031234567']);

  // ...and the form that worked is the next first try.
  calls = [];
  await msw.startAirtimeCash({ network: 'MTN', phone: '08031234567' });
  assert.deepStrictEqual(cashCalls().map(c => c.body.phone), ['2348031234567'], 'learned format is tried first');

  // A refusal that is not about the format is not retried.
  calls = [];
  cashReply = () => ({ status: 403, body: { status: 'fail', message: 'This number does not belong to the selected network' } });
  const wrongLine = await rejects(msw.startAirtimeCash({ network: 'MTN', phone: '08031234567', format: 'local' }));
  assert.strictEqual(cashCalls().length, 1);
  assert.strictEqual(wrongLine.kind, 'input');
  assert.match(wrongLine.message, /phone number was not accepted/i);

  // Accepted with no token: a contract change, our incident.
  cashReply = () => ({ status: 200, body: { status: 'success', message: 'OTP sent' } });
  const noToken = await rejects(msw.startAirtimeCash({ network: 'MTN', phone: '08031234567' }));
  assert.ok(noToken.misconfigured, 'no token is a misconfiguration');
  assert.strictEqual(noToken.statusCode, 502);

  // Our KYC tier is never the customer's problem.
  cashReply = () => ({ status: 403, body: { status: 'fail', message: 'Upgrade your account to Tier 2 to use airtime to cash' } });
  const tier = await rejects(msw.startAirtimeCash({ network: 'MTN', phone: '08031234567' }));
  assert.ok(tier.misconfigured);
  assert.strictEqual(tier.statusCode, 503);
  assert.strictEqual(tier.message, t.UNAVAILABLE);

  // A bad key stays an outage.
  cashReply = () => ({ status: 403, body: { status: 'fail', message: 'Invalid API KEY or user account not active' } });
  const key = await rejects(msw.startAirtimeCash({ network: 'MTN', phone: '08031234567' }));
  assert.ok(key.misconfigured);

  /* ---------------------------------------------------------- step 2 */

  calls = [];
  cashReply = () => ({ status: 200, body: { status: 'success', data: 'tok-2' } });
  const verified = await msw.verifyAirtimeCashOtp({ network: 'MTN', phone: '08031234567', format: 'local', otp: '123456', token: 'tok-1' });
  assert.strictEqual(verified.token, 'tok-2');
  assert.deepStrictEqual(cashCalls()[0].body, { step: 2, network: 1, phone: '08031234567', otp: '123456', data: 'tok-1' });

  // No new token: the old one carries on to step 3.
  cashReply = () => ({ status: 200, body: { status: 'success', message: 'OTP verified' } });
  assert.strictEqual((await msw.verifyAirtimeCashOtp({ network: 'MTN', phone: '08031234567', otp: '123456', token: 'tok-1' })).token, 'tok-1');

  cashReply = () => ({ status: 403, body: { status: 'fail', message: 'Invalid OTP supplied' } });
  const badOtp = await rejects(msw.verifyAirtimeCashOtp({ network: 'MTN', phone: '08031234567', otp: '000000', token: 'tok-1' }));
  assert.strictEqual(badOtp.kind, 'input');
  assert.match(badOtp.message, /code was not accepted/i);

  cashReply = () => ({ status: 403, body: { status: 'fail', message: 'Verification token expired' } });
  const expired = await rejects(msw.verifyAirtimeCashOtp({ network: 'MTN', phone: '08031234567', otp: '123456', token: 'tok-1' }));
  assert.ok(expired.sessionExpired, 'a lapsed token means starting again');

  /* ---------------------------------------------------------- step 3 */

  calls = [];
  cashReply = () => ({ status: 200, body: { status: 'success', message: 'Airtime converted. Your wallet has been credited.', newbal: 111000 } });
  const done = await msw.completeAirtimeCash({
    network: 'MTN',
    phone: '08031234567',
    format: 'local',
    token: 'tok-2',
    sharePin: '4321',
    amount: 5000,
    reference: 'A2C-REF1',
  });
  assert.strictEqual(done.status, 'successful');
  assert.strictEqual(done.credited, null, 'newbal is our float, never read as the credit');
  assert.deepStrictEqual(cashCalls()[0].body, {
    step: 3,
    network: 1,
    phone: '08031234567',
    data: 'tok-2',
    share_pin: '4321',
    amount: 5000,
    'request-id': 'A2C-REF1',
  });

  // A whole-naira rule, refused before anything is sent.
  calls = [];
  await rejects(msw.completeAirtimeCash({ network: 'MTN', phone: '08031234567', token: 'x', sharePin: '4321', amount: 1000.5, reference: 'R' }));
  assert.strictEqual(cashCalls().length, 0);

  // "Insufficient balance" is the line's airtime, not our float.
  cashReply = () => ({ status: 403, body: { status: 'fail', message: 'Insufficient balance' } });
  const short = await rejects(msw.completeAirtimeCash({ network: 'MTN', phone: '08031234567', token: 'x', sharePin: '4321', amount: 5000, reference: 'R2' }));
  assert.ok(!short.floatExhausted, 'must not page ops about our float');
  assert.ok(short.lineBalance);
  assert.strictEqual(short.statusCode, 400);
  assert.match(short.message, /does not have enough airtime/i);

  cashReply = () => ({ status: 403, body: { status: 'fail', message: 'Incorrect transfer PIN' } });
  const pin = await rejects(msw.completeAirtimeCash({ network: 'MTN', phone: '08031234567', token: 'x', sharePin: '4321', amount: 5000, reference: 'R3' }));
  assert.ok(pin.wrongPin);
  assert.match(pin.message, /Share & Sell PIN/);

  // Lost answer, requery says delivered: reported as if the answer had arrived.
  calls = [];
  cashReply = () => {
    throw networkError();
  };
  requeryReply = () => ({ status: 200, body: { status: 'success', data: { 'request-id': 'A2C-REF4', transaction_status: 'success' } } });
  const recovered = await msw.completeAirtimeCash({ network: 'MTN', phone: '08031234567', token: 'x', sharePin: '4321', amount: 5000, reference: 'A2C-REF4' });
  assert.strictEqual(recovered.status, 'successful');
  assert.ok(recovered.recovered);
  assert.strictEqual(cashCalls().length, 1, 'a step 3 is never sent twice');
  assert.ok(calls.some(c => c.path === '/api/requery/A2C-REF4'), 'asked about by our request-id');

  // Lost answer, requery has never heard of it: AMBIGUOUS, not a decline.
  calls = [];
  requeryReply = () => ({ status: 404, body: { status: 'fail', message: 'Transaction not found' } });
  const unknown = await rejects(msw.completeAirtimeCash({ network: 'MTN', phone: '08031234567', token: 'x', sharePin: '4321', amount: 5000, reference: 'A2C-REF5' }));
  assert.ok(unknown.ambiguous, 'not found on this path is unknown, never a refusal');
  assert.strictEqual(cashCalls().length, 1);

  // Lost answer, requery says a bare "Failed": not proof that nothing moved on
  // this path, so it is kept as unknown rather than rolled back (2026-10-12).
  requeryReply = () => ({ status: 200, body: { status: 'success', data: { transaction_status: 'failed', message: 'Failed' } } });
  const failed = await rejects(msw.completeAirtimeCash({ network: 'MTN', phone: '08031234567', token: 'x', sharePin: '4321', amount: 5000, reference: 'A2C-REF6' }));
  assert.ok(failed.ambiguous, 'a vague failure is an unknown on the cash path, never a decline');
  assert.ok(failed.unclassified);

  /* ---------------- 2026-10-12: the accepted step 3 that was filed as a refusal */

  // The live answer, verbatim, under a non-success status - HTTP 200 "fail" or
  // a 4xx, both seen as possible. It is an acceptance, and comes back as one.
  for (const reply of [
    { status: 200, body: { status: 'fail', message: 'Checking transaction... We will notify you once it is successful.' } },
    { status: 400, body: { message: 'Checking transaction... We will notify you once it is successful.' } },
  ]) {
    calls = [];
    cashReply = () => reply;
    const accepted = await msw.completeAirtimeCash({ network: 'AIRTEL', phone: '08021234567', token: 'x', sharePin: '4321', amount: 1000, reference: 'A2C-LIVE8' });
    assert.strictEqual(accepted.status, 'processing', 'accepted and still working - never a refusal');
    assert.strictEqual(accepted.accepted, true);
    assert.match(accepted.message, /Checking transaction/);
    assert.strictEqual(accepted.http_status, reply.status, 'their HTTP status is kept for diagnosis');
    assert.strictEqual(cashCalls().length, 1);
  }

  // A refusal whose words prove nothing either way is an unknown, not a "no".
  cashReply = () => ({ status: 403, body: { status: 'fail', message: 'Something went wrong' } });
  const vague = await rejects(msw.completeAirtimeCash({ network: 'MTN', phone: '08031234567', token: 'x', sharePin: '4321', amount: 5000, reference: 'R7' }));
  assert.ok(vague.ambiguous && vague.unclassified, '"went wrong" is not proof the transfer never ran');
  assert.strictEqual(vague.httpStatus, 403);

  // ...while every refusal that names a check made before the transfer still
  // reads as one: validator, limit, the line, a lapsed session, our own key.
  for (const message of ['The amount field must be at least 100.', 'Invalid phone number', 'Verification token expired', 'Service is under maintenance']) {
    cashReply = () => ({ status: 403, body: { status: 'fail', message } });
    const clear = await rejects(msw.completeAirtimeCash({ network: 'MTN', phone: '08031234567', token: 'x', sharePin: '4321', amount: 5000, reference: 'R8' }));
    assert.ok(!clear.ambiguous, `"${message}" proves nothing moved`);
  }

  // Conversions #9 and #10 (2026-10-12): the line had used its one Airtel
  // transfer for the day. Refused before anything moved - a decline, never an
  // unknown - and worded by us. Their validator answered 422 to a probe the
  // same day, so the status is tried both ways.
  const usedToday =
    'This Airtel line has already converted airtime today. Airtel allows only one transfer per line per day — please try again tomorrow, or use another line.';
  for (const status of [422, 403]) {
    calls = [];
    cashReply = () => ({ status, body: { status: 'fail', message: usedToday } });
    const daily = await rejects(msw.completeAirtimeCash({ network: 'AIRTEL', phone: '08021234567', token: 'x', sharePin: '4321', amount: 1000, reference: 'A2C-LIVE9' }));
    assert.ok(!daily.ambiguous && !daily.unclassified, `HTTP ${status}: the line limit moved nothing`);
    assert.ok(daily.dailyLimit);
    assert.strictEqual(daily.statusCode, 400);
    assert.match(daily.message, /limit for today/);
    assert.ok(!/Airtel allows/.test(daily.message), 'our words for the customer, theirs kept for operators');
    assert.strictEqual(daily.providerMessage, usedToday);
    assert.strictEqual(cashCalls().length, 1, 'never retried');
  }
  assert.ok(msw.isClearCashDecline({ providerMessage: usedToday }), 'a stored copy reads as a refusal too');
  assert.ok(!msw.isCashPendingWording(usedToday));

  // Step 3 waits longer than a vend: the live conversion outran the 30s limit.
  assert.ok(Number(process.env.MYSUBWALLET_CASH_TIMEOUT_MS || 90_000) > Number(process.env.MYSUBWALLET_TIMEOUT_MS || 30_000));

  /* -------------------------------------------------------- the helpers */

  assert.strictEqual(t.cashToken({ data: 'abc' }), 'abc');
  assert.strictEqual(t.cashToken({ data: { token: 'def' } }), 'def');
  assert.strictEqual(t.cashToken({ token: 'ghi' }), 'ghi');
  assert.strictEqual(t.cashToken({ status: 'success' }), '');
  assert.strictEqual(t.cashCredited({ amount: 5000 }), null, '`amount` may be the airtime, so it is not the credit');
  assert.strictEqual(t.cashCredited({ credited: '3750.00' }), 3750);
  assert.strictEqual(t.formatNamedBy({ kind: 'input', providerMessage: 'The phone must be 11 digits.' }), 'local');
  assert.strictEqual(t.formatNamedBy({ kind: 'input', ambiguous: true, providerMessage: '13 digits' }), '');

  console.log('✅ airtimeCash provider tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
