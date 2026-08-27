/**
 * node test/transactions.export.test.js
 *
 * No network, no database: covers the WAT day-boundary maths that decide which
 * transactions land inside an exported date range, and that the statement
 * renderer produces a real PDF.
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);

// Wrap PDFKit's text() before the renderer loads it, so every cell the
// statement draws can be measured against the box it was given. A single-line
// cell wider than its column is a column silently cut off with an ellipsis -
// the whole reason the table was re-laid out.
const PDFKit = require('pdfkit');
const overflowingCells = [];
const originalText = PDFKit.prototype.text;
PDFKit.prototype.text = function (text, x, y, options) {
  const o = options || {};
  if (typeof x === 'number' && o.width && !o.lineBreak) {
    const width = this.widthOfString(String(text));
    if (width > o.width + 0.5) overflowingCells.push(`${text} (${width.toFixed(1)}pt in ${o.width}pt)`);
  }
  return originalText.apply(this, arguments);
};

// Every page break must be one the renderer decided on. A break raised by the
// line wrapper means text was drawn past the bottom margin, which used to
// append a blank page per footer line.
let wrapperPageBreaks = 0;
const originalContinue = PDFKit.prototype.continueOnNewPage;
PDFKit.prototype.continueOnNewPage = function () {
  wrapperPageBreaks += 1;
  return originalContinue.apply(this, arguments);
};

const { watParts, watDayStart, watDayEnd } = require('../src/controllers/transactions.controller');
const { buildStatementPdf, money, compactDate } = require('../src/helpers/statementPdf.helper');

// --- WAT day boundaries -----------------------------------------------------
// Nigeria is UTC+1 all year, so local midnight is 23:00 UTC the day before.
assert.strictEqual(watDayStart('2026-08-05').toISOString(), '2026-08-04T23:00:00.000Z');
assert.strictEqual(watDayEnd('2026-08-05').toISOString(), '2026-08-05T22:59:59.999Z');

// Junk must be rejected rather than silently exporting the whole ledger.
assert.strictEqual(watDayStart('05/08/2026'), null);
assert.strictEqual(watDayStart(''), null);
assert.strictEqual(watDayStart(null), null);
assert.strictEqual(watDayEnd('2026-13-45'), null, 'an impossible date is not a range');

// A transaction at 00:30 WAT on the 5th belongs to the 5th, not the 4th.
const earlyMorning = new Date('2026-08-04T23:30:00.000Z');
assert.ok(earlyMorning >= watDayStart('2026-08-05') && earlyMorning <= watDayEnd('2026-08-05'));
assert.ok(earlyMorning > watDayEnd('2026-08-04'), 'and it is past the end of the 4th');

// --- WAT formatting ---------------------------------------------------------
assert.deepStrictEqual(watParts('2026-08-04T23:30:00.000Z'), { date: '2026-08-05', time: '00:30:00' });
assert.deepStrictEqual(watParts('2026-08-05T12:00:00.000Z'), { date: '2026-08-05', time: '13:00:00' });
assert.deepStrictEqual(watParts('not-a-date'), { date: '', time: '' });

// --- Money formatting -------------------------------------------------------
assert.strictEqual(money('1234.5'), '1,234.50');
assert.strictEqual(money(0), '0.00');
assert.strictEqual(money('not a number'), '0.00');

// --- Date formatting --------------------------------------------------------
assert.strictEqual(compactDate('2026-08-05'), '05 Aug 26');
assert.strictEqual(compactDate(''), '');

// --- Statement PDF ----------------------------------------------------------
(async () => {
  const rows = [
    {
      trx: 'TRX123456',
      trx_type: '-',
      amount: '5000',
      charge: '50',
      total_amount: '5050',
      remark: 'utility_bill',
      other_data: { subtitle: 'IKEDC prepaid meter', feedback: 'Successful' },
      details: 'Electricity',
      created_at: '2026-08-05T12:00:00.000Z',
    },
    {
      trx: 'TRX999999',
      trx_type: '+',
      amount: '20000',
      charge: '0',
      total_amount: '20000',
      remark: 'fund_account',
      other_data: { subtitle: 'Wallet Funding', feedback: 'Successful' },
      details: 'Wallet funding',
      created_at: '2026-08-06T08:30:00.000Z',
    },
  ];

  const pdf = await buildStatementPdf({
    rows,
    from: '2026-08-01',
    to: '2026-08-06',
    accountName: 'Ada Okafor',
    accountEmail: 'ada@example.com',
    accountMobile: '2348031234567',
    watParts,
    categoryFor: r => String(r),
  });

  assert.ok(Buffer.isBuffer(pdf), 'the renderer hands back bytes');
  assert.strictEqual(pdf.subarray(0, 5).toString(), '%PDF-', 'and they are a PDF');
  assert.ok(pdf.length > 1500, 'with actual content in it');

  // Long text and multi-page paging: a description longer than its column must
  // wrap, and nothing anywhere may be drawn wider than the cell holding it.
  const many = [];
  for (let i = 0; i < 60; i += 1) {
    many.push({
      ...rows[i % rows.length],
      trx: `TRX${100000 + i}`,
      other_data: {
        subtitle: 'Transfer to Chukwuemeka Oluwaseun Adebayo-Nwachukwu / Guaranty Trust Bank / 0123456789',
        feedback: i % 3 === 0 ? 'Pending' : 'Successful',
      },
      amount: '3000000',
      created_at: new Date(Date.UTC(2026, 7, 1 + (i % 28), i % 24, 30, 0)).toISOString(),
    });
  }

  const long = await buildStatementPdf({
    rows: many,
    from: '2026-08-01',
    to: '2026-08-28',
    accountName: 'Ada Chidinma Okafor',
    accountEmail: 'ada.okafor@example.com',
    accountMobile: '2348031234567',
    watParts,
    categoryFor: r => String(r),
  });
  assert.strictEqual(long.subarray(0, 5).toString(), '%PDF-');
  assert.ok(long.length > pdf.length, 'sixty rows spill past one page');
  assert.deepStrictEqual(overflowingCells, [], 'no cell is drawn wider than its column');
  assert.strictEqual(wrapperPageBreaks, 0, 'no page is added behind the renderer\'s back');

  // An empty range still produces a valid document rather than throwing.
  const empty = await buildStatementPdf({
    rows: [],
    from: '2026-08-01',
    to: '2026-08-06',
    accountName: 'Ada Okafor',
    watParts,
    categoryFor: r => String(r),
  });
  assert.strictEqual(empty.subarray(0, 5).toString(), '%PDF-');

  console.log('✅ transactions export tests passed');
})();
