/**
 * node test/paymentpoint.service.test.js
 *
 * PaymentPoint's wire layer with `fetch` faked: what each kind of answer is
 * classified as, and what the parser reads out of a body. The controller's
 * whole "did PaymentPoint open an account anyway?" decision rests on `kind`,
 * so every way a call can end is pinned here.
 */
const assert = require('assert');

process.env.PAYMENTPOINT_API_KEY = 'pp-key';
process.env.PAYMENTPOINT_SECRET_KEY = 'pp-secret';
delete process.env.PAYMENTPOINT_TIMEOUT_MS;
delete process.env.PAYMENTPOINT_CREATE_TIMEOUT_MS;

// What the next call answers: a function (url, init) => Response-ish | throws.
let answer = null;
const sent = [];
global.fetch = async (url, init) => {
  sent.push({ url, init });
  return answer(url, init);
};

const pp = require('../src/funding/paymentpoint.service');
const { paymentpointRequestOnce, createTimeoutMs, requestTimeoutMs } = pp.__test;

const respond = (status, body) => () => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

// Never answers - until the caller's AbortController fires.
const hang = () => (url, init) =>
  new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  });

async function failure(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('expected the call to throw');
}

const call = () => paymentpointRequestOnce('/api/v1/createVirtualAccount', { method: 'POST', body: { a: 1 }, timeoutMs: 1_000 });

(async () => {
  /* ---- budgets ---------------------------------------------------------- */
  assert.strictEqual(requestTimeoutMs(), 8_000);
  assert.strictEqual(createTimeoutMs(), 60_000, 'a NIN-backed create gets far longer than a read');
  process.env.PAYMENTPOINT_CREATE_TIMEOUT_MS = '45000';
  assert.strictEqual(createTimeoutMs(), 45_000);
  process.env.PAYMENTPOINT_CREATE_TIMEOUT_MS = '5';
  assert.strictEqual(createTimeoutMs(), 1_000, 'never below a second');
  delete process.env.PAYMENTPOINT_CREATE_TIMEOUT_MS;

  /* ---- acceptances ------------------------------------------------------- */
  for (const status of ['success', 'Success', true, '00', 'pending', 'processing']) {
    answer = respond(200, { status, customer: { customer_id: 'C1' } });
    const json = await call();
    assert.strictEqual(json.customer.customer_id, 'C1', `status ${JSON.stringify(status)} is an acceptance`);
  }
  answer = respond(201, { customer: { customer_id: 'C1' } });
  assert.ok(await call(), 'no status word at all, on a 2xx, is an acceptance');

  const headers = sent.at(-1).init.headers;
  assert.strictEqual(headers.Authorization, 'Bearer pp-secret');
  assert.strictEqual(headers['api-key'], 'pp-key');

  /* ---- refusals and their kinds ---------------------------------------- */
  answer = respond(200, { status: 'error', message: 'Invalid NIN' });
  let e = await failure(call());
  assert.strictEqual(e.kind, 'declined');
  assert.strictEqual(e.statusCode, 200);
  assert.strictEqual(e.message, 'Invalid NIN');

  answer = respond(200, { status: false, message: 'Failed' });
  assert.strictEqual((await failure(call())).kind, 'declined');

  // Laravel's shape: the useful sentence is under `errors`.
  answer = respond(422, { message: 'The given data was invalid.', errors: { email: ['The email has already been taken.'] } });
  e = await failure(call());
  assert.strictEqual(e.kind, 'http');
  assert.strictEqual(e.statusCode, 422);
  assert.deepStrictEqual(e.providerErrors, ['The email has already been taken.']);
  assert.ok(pp.isDuplicateWording(e.message, ...e.providerErrors));

  // A 2xx that is not JSON - their unknown routes, a proxy page - is unreadable.
  answer = respond(200, '<!doctype html><html><body>Welcome</body></html>');
  e = await failure(call());
  assert.strictEqual(e.kind, 'unreadable');
  answer = respond(200, '');
  assert.strictEqual((await failure(call())).kind, 'unreadable');

  // A non-2xx HTML page never becomes the message.
  answer = respond(502, '<html><body>Bad Gateway</body></html>');
  e = await failure(call());
  assert.strictEqual(e.kind, 'http');
  assert.strictEqual(e.statusCode, 502);
  assert.ok(!e.message.includes('<'));

  /* ---- transport -------------------------------------------------------- */
  answer = () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  };
  e = await failure(call());
  assert.strictEqual(e.kind, 'unreachable', 'refused before a byte left: nothing can have happened');

  answer = () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  };
  e = await failure(call());
  assert.strictEqual(e.kind, 'network', 'reset after sending: it may have happened');

  answer = hang();
  const started = Date.now();
  e = await failure(call());
  assert.strictEqual(e.kind, 'timeout');
  assert.strictEqual(e.statusCode, 504);
  assert.ok(Date.now() - started >= 900, 'the budget is the one passed in');

  // Headers arrive, then the body stalls: still a timeout, not a hang.
  answer = (url, init) => ({
    ok: true,
    status: 200,
    text: () =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
  });
  e = await failure(call());
  assert.strictEqual(e.kind, 'timeout');

  /* ---- our own configuration -------------------------------------------- */
  delete process.env.PAYMENTPOINT_SECRET_KEY;
  e = await failure(call());
  assert.strictEqual(e.kind, 'config');
  process.env.PAYMENTPOINT_SECRET_KEY = 'pp-secret';

  e = await failure(pp.createVirtualAccount({ email: 'a@b.c', name: 'A', phoneNumber: '0803', bankCode: ['20946'], businessId: 'b', idType: 'nin' }));
  assert.strictEqual(e.kind, 'config', 'a request we never sent is never ambiguous');

  // createVirtualAccount sends the NIN as PaymentPoint's id fields.
  answer = respond(200, { status: 'success' });
  await pp.createVirtualAccount({ email: 'a@b.c', name: 'A', phoneNumber: '08031234567', bankCode: ['20946'], businessId: 'b', idType: 'nin', idNumber: '12345678901' });
  const body = JSON.parse(sent.at(-1).init.body);
  assert.strictEqual(body.idType, 'nin');
  assert.strictEqual(body.idNumber, '12345678901');

  /* ---- extractVirtualAccount -------------------------------------------- */
  const documented = {
    status: 'success',
    customer: { customer_id: 'CUS1', customer_email: 'x@example.com' },
    bankAccounts: [{ bankCode: '20946', bankName: 'PalmPay', accountNumber: '6600000001', accountName: 'VoltPay-Ada', Reserved_Account_Id: 'R1' }],
  };
  let found = pp.extractVirtualAccount(documented, { preferBankCode: '20946' });
  assert.strictEqual(found.customerId, 'CUS1');
  assert.deepStrictEqual(found.account, { accountNumber: '6600000001', accountName: 'VoltPay-Ada', bankName: 'PalmPay', bankCode: '20946' });

  found = pp.extractVirtualAccount({ data: { customer: { id: 77 }, account: { account_no: '66 0000 0002' } } });
  assert.strictEqual(found.customerId, '77');
  assert.strictEqual(found.account.accountNumber, '6600000002', 'spaces in a number are formatting');

  found = pp.extractVirtualAccount({ customer_id: 'C3', bankAccounts: [{ bankName: 'Opay', accountNumber: '7700000003' }, { bankName: 'PalmPay', accountNumber: '6600000003' }] });
  assert.strictEqual(found.account.accountNumber, '6600000003', 'PalmPay first when more than one comes back');
  assert.strictEqual(found.accounts, 2);

  for (const junk of [null, 'oops', [], { bankAccounts: 'nope' }, { bankAccounts: [{ accountNumber: 'R123' }] }, { bankAccounts: [{ accountNumber: '660000000' }] }]) {
    assert.strictEqual(pp.extractVirtualAccount(junk).account, null, JSON.stringify(junk));
  }
  assert.strictEqual(pp.extractVirtualAccount({ customer: { customer_id: 'bad id; drop' } }).customerId, '', 'a customer id becomes a key, so only a safe one is read');
  assert.strictEqual(pp.extractVirtualAccount({ bank: { name: 'PalmPay' }, accountNumber: '6600000004' }).account.bankName, '', 'an object is not a bank name');

  /* ---- the payment side never reads the sender ------------------------- */
  const payment = { amount: 100, sender: { account_number: '0123456789', name: 'Sender' }, receiver: { account_number: '6600000005', name: 'VoltPay-Ada' } };
  assert.deepStrictEqual(pp.receiverAccount(payment), { accountNumber: '6600000005', accountName: 'VoltPay-Ada', bankName: '', bankCode: '' });
  assert.strictEqual(pp.receiverAccount({ sender: { account_number: '0123456789' } }), null);
  assert.deepStrictEqual(pp.customerContact({ customer: { email: 'a@b.c', phone_number: '08031234567' } }), { email: 'a@b.c', phone: '08031234567' });

  /* ---- describeShape: names, never values -------------------------------- */
  const shape = pp.describeShape({ ...documented, data: { secret: 'value' } });
  assert.deepStrictEqual(shape.keys, ['status', 'customer', 'bankAccounts', 'data']);
  assert.deepStrictEqual(shape.customer_keys, ['customer_id', 'customer_email']);
  assert.strictEqual(shape.accounts, 1);
  const printed = JSON.stringify(shape);
  for (const value of ['x@example.com', '6600000001', 'VoltPay-Ada', 'CUS1', 'value']) {
    assert.ok(!printed.includes(value), `describeShape leaked ${value}`);
  }
  assert.deepStrictEqual(pp.describeShape('<html>'), { type: 'string' });

  /* ---- isDuplicateWording ------------------------------------------------ */
  for (const yes of ['Customer already exists', 'The email has already been taken.', 'Duplicate customer', 'This NIN has already been used', 'Customer already has a virtual account']) {
    assert.ok(pp.isDuplicateWording(yes), yes);
  }
  for (const no of ['Customer does not exist', 'Invalid NIN', 'Your request has already been received', '', null]) {
    assert.ok(!pp.isDuplicateWording(no), String(no));
  }

  console.log('paymentpoint.service.test.js passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
