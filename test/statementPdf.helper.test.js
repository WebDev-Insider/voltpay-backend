// A statement cell that does not fit its column used to be drawn at full width
// anyway - PDFKit only truncates inside its line wrapper, which a non-wrapping
// cell never enters - so a StaffPay payout reference printed straight through
// the Amount column next to it.
const assert = require('assert');
const PDFDocument = require('pdfkit');

const { fitText, COLUMNS, buildStatementPdf } = require('../src/helpers/statementPdf.helper');

const doc = new PDFDocument({ size: 'A4', margin: 36 });
doc.font('Helvetica').fontSize(8);

const CELL_PAD = 4;
const reference = COLUMNS.find(c => c.key === 'reference');
const inner = reference.width - CELL_PAD * 2;

// Left alone when it fits. The StaffPay payout reference is the case the column
// was widened for - it has to print in full, not merely stop overflowing.
for (const short of ['VP1A2B3C4D', 'staffpay_payout_1048576']) {
  assert.strictEqual(fitText(doc, short, inner), short, `"${short}" must be left alone`);
}

// Longer than any column can hold: cut, and visibly cut.
for (const long of ['budpay_trf_9f3c2a77e1b04d5a8c6e2f1908', 'x'.repeat(200)]) {
  const cut = fitText(doc, long, inner);
  assert.ok(doc.widthOfString(cut) <= inner, `"${long}" still overflows the Reference column`);
  assert.ok(cut.endsWith('...'), `"${long}" must show it was truncated`);
  assert.ok(cut.length < long.length, `"${long}" was not actually shortened`);
}

// Widths still add up to the printable width of A4 at a 36pt margin.
assert.strictEqual(COLUMNS.reduce((sum, c) => sum + c.width, 0), 523, 'columns must fill the page width exactly');

// And the document as a whole still renders with such a row in it.
buildStatementPdf({
  rows: [{
    id: 1,
    trx: 'staffpay_payout_1048576',
    trx_type: '-',
    amount: '150000.00',
    charge: '52.50',
    total_amount: '150052.50',
    remark: 'bank_transfer',
    other_data: { subtitle: 'Kuda Bank - ****4417', feedback: 'Successful' },
    details: 'August payroll',
    created_at: '2026-08-25T09:14:00.000Z',
  }],
  from: '2026-08-01',
  to: '2026-08-31',
  accountName: 'Test Account',
  accountEmail: 'test@example.com',
  accountMobile: '2348012345678',
  watParts: () => ({ date: '2026-08-25', time: '10:14:00' }),
  categoryFor: () => 'Transfer',
})
  .then(pdf => {
    assert.ok(Buffer.isBuffer(pdf) && pdf.length > 1000, 'statement PDF did not render');
    console.log('statementPdf.helper: OK');
  })
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
