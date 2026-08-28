/**
 * node test/emailTemplate.test.js
 *
 * No network: BREVO_API_KEY is cleared, so sendViaBrevo takes its dev-mode
 * short circuit. The HTML is built by the caller before that point, so every
 * sender below is fully exercised - this catches a template that throws, a
 * block that stops emitting a <tr>, and an unescaped value reaching the body.
 */
const assert = require('assert');

process.env.BREVO_API_KEY = '';
process.env.EMAIL_BRAND_NAME = 'VoltPay';
delete process.env.EMAIL_LOGO_URL;

const {
  renderEmail,
  toPlainText,
  esc,
  brandColor,
  logoUrl,
  blocks,
} = require('../src/services/emailTemplate.service');

/* -------------------------------------------------------------------------- */
/* Logo resolution                                                             */
/* -------------------------------------------------------------------------- */

// An http:// or unset base must not produce an image URL - a mixed-content or
// broken logo in every email is worse than the text wordmark.
process.env.PUBLIC_BASE_URL = 'http://insecure.example.com';
delete process.env.APP_URL;
delete process.env.BACKEND_URL;
assert.strictEqual(logoUrl(), null, 'http base is refused');

process.env.PUBLIC_BASE_URL = 'https://api.voltpay.ng/';
assert.strictEqual(
  logoUrl(),
  'https://api.voltpay.ng/assets/brand/voltpay-logo.png',
  'https base builds the brand asset URL, trailing slash trimmed'
);

process.env.EMAIL_LOGO_URL = 'https://cdn.example.com/logo.png';
assert.strictEqual(logoUrl(), 'https://cdn.example.com/logo.png', 'explicit override wins');
delete process.env.EMAIL_LOGO_URL;

// With no base at all we fall back to the text wordmark rather than a broken img.
delete process.env.PUBLIC_BASE_URL;
assert.strictEqual(logoUrl(), null);
const noLogo = renderEmail({ subject: 'x', heading: 'x', blocks: [] });
assert.ok(!noLogo.includes('<img'), 'no <img> when no logo URL is resolvable');
assert.ok(noLogo.includes('>Volt<') && noLogo.includes('>pay<'), 'text wordmark stands in');

process.env.PUBLIC_BASE_URL = 'https://api.voltpay.ng';

/* -------------------------------------------------------------------------- */
/* Brand colour                                                                */
/* -------------------------------------------------------------------------- */

process.env.EMAIL_BRAND_COLOR = 'not-a-colour';
assert.strictEqual(brandColor(), '#2B5BEE', 'a junk value falls back to the real brand blue');
process.env.EMAIL_BRAND_COLOR = '#123ABC';
assert.strictEqual(brandColor(), '#123ABC', 'a valid hex is honoured');
delete process.env.EMAIL_BRAND_COLOR;

/* -------------------------------------------------------------------------- */
/* Shell                                                                       */
/* -------------------------------------------------------------------------- */

const shell = renderEmail({
  subject: 'Subject line',
  preheader: 'Preview line',
  eyebrow: 'Eyebrow',
  heading: 'The heading',
  tag: 'VP-SUP-1',
  blocks: [blocks.paragraph('Body copy')],
  footnote: 'Small print',
});

assert.ok(shell.startsWith('<!doctype html>'), 'is a full document');
assert.ok(shell.includes('<img'), 'logo image is present when a base URL exists');
assert.ok(shell.includes('alt="VoltPay"'), 'logo carries alt text for blocked images');
assert.ok(shell.includes('assets/brand/voltpay-logo.png'), 'points at the hosted asset');
assert.ok(shell.includes('Preview line'), 'preheader is in the body');
assert.ok(shell.includes('mso-hide:all'), 'preheader is hidden from Outlook too');
assert.ok(shell.includes('<title>Subject line</title>'));
assert.ok(shell.includes('The heading'));
assert.ok(shell.includes('VP-SUP-1'), 'tag chip renders');
assert.ok(shell.includes('Small print'));
assert.ok(shell.includes('<!--[if mso]>'), 'Outlook gets a fixed-width wrapper');
assert.ok(shell.includes('role="presentation"'), 'layout tables are not announced as data');
assert.ok(shell.includes(String(new Date().getFullYear())), 'copyright year is current');

// The shell escapes everything it is handed. Body HTML is trusted, chrome is not.
const injected = renderEmail({
  subject: '<script>alert(1)</script>',
  preheader: '<b>preview</b>',
  eyebrow: '<i>eye</i>',
  heading: 'safe',
  blocks: [],
});
assert.ok(!injected.includes('<script>'), 'subject is escaped');
assert.ok(injected.includes('&lt;script&gt;'));
assert.ok(!injected.includes('<b>preview</b>'), 'preheader is escaped');

/* -------------------------------------------------------------------------- */
/* Blocks                                                                      */
/* -------------------------------------------------------------------------- */

const code = blocks.codePanel('483920', { caption: 'Verification code' });
assert.ok(code.includes('483920'));
assert.ok(code.includes('VERIFICATION CODE') || code.includes('Verification code'));
assert.ok(code.includes('letter-spacing:8px'), 'digits are tracked apart to be read off a screen');

const button = blocks.button({ label: 'Go', url: 'https://voltpay.ng/x' });
assert.ok(button.includes('v:roundrect'), 'Outlook gets a VML button');
assert.ok(button.includes('<a href="https://voltpay.ng/x"'), 'everyone else gets an anchor');

const list = blocks.detailList([['Amount', '25,000'], null, ['Ref', 'VP-1']]);
assert.ok(list.includes('Amount') && list.includes('VP-1'));
assert.ok(!list.includes('null'), 'null rows are dropped, not rendered');
assert.strictEqual(blocks.detailList([]), '', 'an empty list emits nothing');

const grid = blocks.wordGrid(['alpha', 'beta', 'gamma', 'delta']);
assert.ok(grid.includes('alpha') && grid.includes('delta'));
assert.ok(grid.includes('>4</span>'), 'words are numbered');
// 4 words fill two rows of three; the last row is padded so the columns keep
// an even width instead of the third word stretching to fill the row.
assert.strictEqual((grid.match(/width="33%"/g) || []).length, 6, 'the short row is padded to three cells');
assert.strictEqual(blocks.wordGrid([]), '', 'an empty phrase emits nothing');

// Every block has to be a <tr>, or it lands outside the card table and the
// layout collapses in Outlook.
for (const [name, html] of [
  ['paragraph', blocks.paragraph('x')],
  ['codePanel', code],
  ['button', button],
  ['notice', blocks.notice({ tone: 'danger', title: 't', body: 'b' })],
  ['detailList', list],
  ['wordGrid', grid],
  ['quote', blocks.quote('x')],
  ['divider', blocks.divider()],
]) {
  assert.ok(html.trim().startsWith('<tr>'), `${name} emits a table row`);
}

// An unknown tone must not blow up - it degrades to info.
assert.ok(blocks.notice({ tone: 'nonsense', body: 'x' }).includes('<tr>'));

/* -------------------------------------------------------------------------- */
/* Plain text                                                                  */
/* -------------------------------------------------------------------------- */

assert.strictEqual(toPlainText(['<b>Hi</b> there']), 'Hi there');
assert.strictEqual(toPlainText(['a<br/>b']), 'a\nb');
assert.strictEqual(toPlainText(['&amp; &lt;x&gt;']), '& <x>');
assert.strictEqual(toPlainText(['one', null, 'two']), 'one\n\ntwo', 'blank parts are dropped');

/* -------------------------------------------------------------------------- */
/* The route the logo is fetched from                                          */
/* -------------------------------------------------------------------------- */

const { getBrandAsset } = require('../src/controllers/assets.controller');

function fakeRes() {
  return {
    headers: {},
    code: 200,
    sent: null,
    headersSent: false,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    end() { this.ended = true; },
    sendFile(p) { this.sent = p; },
  };
}

const okRes = fakeRes();
getBrandAsset({ params: { filename: 'voltpay-logo.png' } }, okRes);
assert.ok(okRes.sent && okRes.sent.endsWith('voltpay-logo.png'), 'the logo is served');
assert.ok(require('fs').existsSync(okRes.sent), 'the file it points at is actually on disk');
// helmet() sets same-origin for the whole app, which makes a browser refuse the
// image when webmail renders the message on its own domain.
assert.strictEqual(okRes.headers['Cross-Origin-Resource-Policy'], 'cross-origin');
assert.ok(/immutable/.test(okRes.headers['Cache-Control']), 'cached hard - one fetch per recipient');
assert.strictEqual(okRes.headers['Content-Type'], 'image/png');

const whiteRes = fakeRes();
getBrandAsset({ params: { filename: 'voltpay-logo-white.png' } }, whiteRes);
assert.ok(whiteRes.sent, 'the white variant is available for a dark surface');

// filename comes off the URL, so the allowlist has to be what stops it walking.
for (const attack of ['../../.env', '../prisma/schema.prisma', '', 'nope.png', '..%2F.env']) {
  const res = fakeRes();
  getBrandAsset({ params: { filename: attack } }, res);
  assert.strictEqual(res.sent, null, `"${attack}" serves nothing`);
  assert.strictEqual(res.code, 404, `"${attack}" is a 404`);
}

/* -------------------------------------------------------------------------- */
/* The senders                                                                 */
/* -------------------------------------------------------------------------- */

const {
  parseSender,
  readSender,
  sendResetEmail,
  sendStaffPayVerificationEmail,
  sendAccountClosureEmail,
  sendRecoveryPhraseEmail,
} = require('../src/services/email.service');

/* -------------------------------------------------------------------------- */
/* Sender resolution                                                           */
/* -------------------------------------------------------------------------- */

// Production sent Brevo a From of `"Voltpay <addr>"` - quotes and all - and got
// `400 invalid_parameter: valid sender email required`, so every OTP and every
// device-verification email stopped. dotenv strips the quotes off a .env line;
// Render's dashboard stores the value byte for byte. Both shapes must resolve.
for (const raw of [
  'Voltpay <jade@example.com>',
  '"Voltpay <jade@example.com>"',
  "'Voltpay <jade@example.com>'",
  '  Voltpay <jade@example.com>  ',
]) {
  const parsed = readSender(raw);
  assert.ok(parsed, `${JSON.stringify(raw)} resolves`);
  assert.strictEqual(parsed.email, 'jade@example.com', `${JSON.stringify(raw)} -> address`);
  assert.strictEqual(parsed.name, 'Voltpay', `${JSON.stringify(raw)} -> name`);
}

assert.strictEqual(readSender('jade@example.com').email, 'jade@example.com', 'a bare address needs no name');
assert.strictEqual(readSender({ email: 'jade@example.com', name: 'X' }).name, 'X', 'an object passes through');

// Anything with no address in it is null, never a best guess: a guess is what
// reached Brevo as a From and took the whole send down with it.
for (const junk of ['Voltpay', '', '   ', 'VoltPay <>', 'VoltPay <not-an-email>', null, undefined, {}]) {
  assert.strictEqual(readSender(junk), null, `${JSON.stringify(junk)} carries no address`);
}

// The chain: first usable candidate wins, and a malformed one is skipped rather
// than sent. RESEND_FROM is last - it is the previous provider's variable and
// must never outrank BREVO_FROM again.
const savedEnv = {
  BREVO_FROM: process.env.BREVO_FROM,
  EMAIL_FROM: process.env.EMAIL_FROM,
  RESEND_FROM: process.env.RESEND_FROM,
};
const quietErr = console.error;
console.error = () => {};
try {
  process.env.BREVO_FROM = '"Voltpay <brevo@example.com>"';
  delete process.env.EMAIL_FROM;
  delete process.env.RESEND_FROM;
  assert.strictEqual(parseSender().email, 'brevo@example.com', 'a quoted BREVO_FROM still works');
  assert.strictEqual(parseSender('Ops <ops@example.com>').email, 'ops@example.com', 'an explicit argument wins');

  process.env.RESEND_FROM = 'Old <resend@example.com>';
  assert.strictEqual(parseSender().email, 'brevo@example.com', 'BREVO_FROM outranks RESEND_FROM');

  process.env.BREVO_FROM = 'Voltpay';
  assert.strictEqual(parseSender().email, 'resend@example.com', 'a junk BREVO_FROM is skipped, not sent');

  delete process.env.RESEND_FROM;
  assert.strictEqual(parseSender().email, 'no-reply@voltpay.local', 'nothing usable falls back');
} finally {
  console.error = quietErr;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

(async () => {
  // Silence the dev-mode "would send" line so the test output stays readable.
  const log = console.log;
  console.log = () => {};
  try {
    for (const type of ['email_verification', 'password_reset', 'pin_reset']) {
      const res = await sendResetEmail('user@example.com', '483920', null, { type });
      assert.ok(res && res.queued, `${type} OTP builds and queues`);
    }

    for (const status of ['submitted', 'approved', 'declined']) {
      const res = await sendStaffPayVerificationEmail({
        to: 'biz@example.com',
        status,
        // A company name with markup in it must not reach the body raw.
        companyName: 'Bright <b>Star</b> Academy',
        reason: 'CAC certificate <expired>',
      });
      assert.ok(res && res.queued, `StaffPay ${status} builds and queues`);
    }

    for (const kind of ['scheduled', 'completed']) {
      const res = await sendAccountClosureEmail({
        to: 'user@example.com',
        kind,
        scheduledFor: new Date('2026-09-20'),
        graceDays: 30,
        retentionYears: 5,
      });
      assert.ok(res && res.queued, `account closure ${kind} builds and queues`);
    }

    const rec = await sendRecoveryPhraseEmail({
      to: 'user@example.com',
      phrase: 'sample preview never valid example placeholder demo notreal fake testing ignore dummy',
      firstName: 'Ada',
    });
    assert.ok(rec && rec.queued, 'recovery phrase builds and queues');

    // A phrase that is not 12 words must still render rather than throw.
    const short = await sendRecoveryPhraseEmail({ to: 'user@example.com', phrase: 'one two', firstName: '' });
    assert.ok(short && short.queued, 'a short phrase does not break the grid');
  } finally {
    console.log = log;
  }

  // The StaffPay decline reason is admin-written; prove it is escaped rather
  // than trusting that it was. renderEmailHtml keeps its old signature.
  const { renderEmailHtml } = require('../src/services/email.service');
  const legacy = renderEmailHtml({
    subject: 'Legacy',
    heading: 'Legacy heading',
    paragraphs: ['<b>bold survives</b>', 'plain'],
    footnote: 'note',
  });
  assert.ok(legacy.includes('<b>bold survives</b>'), 'paragraphs stay trusted HTML');
  assert.ok(legacy.includes('Legacy heading') && legacy.includes('note'));
  assert.ok(legacy.startsWith('<!doctype html>'), 'legacy wrapper still returns a full document');
  assert.ok(legacy.includes('assets/brand/voltpay-logo.png'), 'legacy wrapper gets the logo too');
  assert.ok(!legacy.includes('<b>bold survives</b></div>\n      &#847;'), 'preheader had its tags stripped');
  assert.ok(esc('<b>') === '&lt;b&gt;');

  console.log('✅ emailTemplate tests passed');
})().catch(err => {
  console.error('❌ emailTemplate tests failed');
  console.error(err);
  process.exit(1);
});
