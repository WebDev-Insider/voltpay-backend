/**
 * node test/platformFixes.test.js
 *
 * Three defects found while building CAC Registration, each pinned against the
 * way it was broken:
 *
 *   1. A push tap opened nothing. The app routes a tap on `data.type`, but
 *      notifyUser only sent the caller's `data` - and Airtime to Cash put its
 *      type in the argument, not the data. Every A2C tap fell through.
 *   2. A refused upload was a 500. Multer's "file too large" and the filters'
 *      "wrong type" reached the global handler as crashes, so a customer who
 *      picked a 7MB photo was told "Internal server error".
 *   3. The StaffPay funding callback page put its query string into HTML as is:
 *      reflected script on the API's own origin.
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

function stub(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const pushes = [];
stub('../database/prisma', {
  pushNotification: { create: async ({ data }) => ({ id: 1, ...data }) },
});
stub('../src/services/fcm.service', { sendToUser: async (userId, message) => pushes.push({ userId, ...message }) });
stub('../src/services/notificationWs.service', { broadcastToUserIds: () => {} });

const { notifyUser } = require('../src/services/notify.service');
const { uploadErrorMessage, bodyErrorReply } = require('../src/middlewares/upload.middleware');

(async () => {
  /* ------------------------------------------------ 1. a tap has a type */

  // Airtime to Cash's shape: type in the argument, ids in the data.
  await notifyUser({ userId: 7, subject: 'Airtime converted', message: 'm', type: 'airtime_cash', data: { conversion_id: 12 } });
  assert.deepStrictEqual(pushes[0].data, { type: 'airtime_cash', conversion_id: 12 }, 'the push carries the type the app routes on');

  // A caller's own type in `data` wins; one with no type at all says so.
  await notifyUser({ userId: 7, subject: 's', message: 'm', type: 'general', data: { type: 'scheduled_topup', schedule_id: 3 } });
  assert.strictEqual(pushes[1].data.type, 'scheduled_topup');
  await notifyUser({ userId: 7, subject: 's', message: 'm' });
  assert.strictEqual(pushes[2].data.type, 'general');

  // `pushData` is sent exactly as given - money requests and support depend on it.
  await notifyUser({ userId: 7, subject: 's', message: 'm', type: 'money_request', data: { id: 1 }, pushData: { type: 'money_request', sender: 'Ada' } });
  assert.deepStrictEqual(pushes[3].data, { type: 'money_request', sender: 'Ada' });

  /* ------------------------------------- 2. a refused upload is a 400 */

  assert.ok(/too large/.test(uploadErrorMessage({ name: 'MulterError', code: 'LIMIT_FILE_SIZE' })));
  assert.ok(/does not take/.test(uploadErrorMessage({ name: 'MulterError', code: 'LIMIT_UNEXPECTED_FILE' })));
  assert.ok(uploadErrorMessage({ name: 'MulterError', code: 'SOMETHING_NEW' }), 'any multer refusal is the caller\'s');
  assert.strictEqual(
    uploadErrorMessage(Object.assign(new Error('That file type is not allowed.'), { code: 'UPLOAD_FILE_TYPE' })),
    'That file type is not allowed.',
  );
  // Anything else is still a real error, for the 500 path and the alert.
  assert.strictEqual(uploadErrorMessage(new Error('database is down')), null);
  assert.strictEqual(uploadErrorMessage(null), null);

  // The body parsers' refusals are the caller's too. A hang-up mid-upload (seen
  // on POST /virtual-card/create, 1,417 of 107,197 bytes) is quiet - no alert,
  // no answer to a closed socket - and a too-large or malformed body is a 4xx.
  const aborted = Object.assign(new Error('request aborted'), { type: 'request.aborted', code: 'ECONNABORTED', expected: 107197, received: 1417 });
  assert.strictEqual(bodyErrorReply(aborted).quiet, true);
  assert.strictEqual(bodyErrorReply({ type: 'entity.too.large', status: 413 }).status, 413);
  assert.strictEqual(bodyErrorReply({ type: 'entity.parse.failed', status: 400 }).status, 400);
  assert.strictEqual(bodyErrorReply({ type: 'entity.parse.failed' }).quiet, undefined, 'a malformed body is answered, not swallowed');
  // Only the parser's own types - an unrelated error that carries a `type` is
  // still a real error.
  assert.strictEqual(bodyErrorReply(Object.assign(new Error('x'), { type: 'something.else' })), null);
  assert.strictEqual(bodyErrorReply(new Error('database is down')), null);
  assert.strictEqual(bodyErrorReply(null), null);

  // The filters really do tag their refusals - run one.
  const { uploadSingleImage } = require('../src/middlewares/upload.middleware');
  const { Readable } = require('stream');
  const boundary = 'x-test-boundary';
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="notes.txt"\r\n` +
      `Content-Type: text/plain\r\n\r\nhello\r\n--${boundary}--\r\n`,
  );
  const req = Object.assign(Readable.from([body]), {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) },
  });
  const refused = await new Promise(resolve => uploadSingleImage(req, {}, err => resolve(err)));
  assert.strictEqual(refused?.code, 'UPLOAD_FILE_TYPE', 'a text file on an image route is a tagged refusal');
  assert.ok(uploadErrorMessage(refused));

  /* ------------------------------ 3. the callback page escapes its URL */

  const { walletFundingCallback } = require('../src/controllers/staffpay.controller');
  const html = await new Promise(resolve => {
    walletFundingCallback(
      { query: { status: '<img src=x onerror=alert(1)>', tx_ref: '"><script>alert(document.cookie)</script>' } },
      { setHeader() {}, status() { return this; }, send: resolve },
    );
  });
  assert.ok(!html.includes('<script>alert'), 'no script survives');
  assert.ok(!html.includes('<img src=x'), 'no markup survives');
  assert.ok(html.includes('&lt;script&gt;'), 'the value is still shown, escaped');

  console.log('✅ platform fixes tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
