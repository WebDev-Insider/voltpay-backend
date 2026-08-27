const PDFDocument = require('pdfkit');

/**
 * Renders a transaction statement as a PDF.
 *
 * Kept on the server rather than in the app: the layout can be corrected
 * without shipping a release, and it reads the same rows the history endpoint
 * already returns, so the statement can never disagree with the list the user
 * is looking at.
 *
 * The naira sign is deliberately absent. PDFKit's built-in fonts encode
 * WinAnsi, which has no U+20A6, so it would draw as a blank box - every money
 * column is labelled "(NGN)" instead.
 *
 * The table primitives (`drawTable`, `drawSummaryCard`, `stampFooters`) are
 * exported so a second document can be laid out the same way.
 */

const PAGE_MARGIN = 36;
const BRAND = '#000000';
const MUTED = '#6B7280';
const LINE = '#E2E8F0';
const CREDIT = '#0F8A45';
const DEBIT = '#B4231C';
const PENDING = '#B45309';
const ZEBRA = '#F8FAFC';

const FONT_SIZE = 8;
const CELL_PAD = 4;
// Breathing room under every row. StaffPay pays one staff member per row, so a
// payroll run is a block of near-identical lines - without the gap they read as
// one paragraph.
const ROW_GAP = 4;
const HEADER_ROW_HEIGHT = 17;

// Widths add up to 523pt, the printable width of A4 at a 36pt margin. They are
// sized to the content they actually hold: the description is the only cell
// that wraps, so it keeps the slack, and Reference is wide enough for a
// provider reference (`staffpay_payout_...`, a BudPay ref) rather than only for
// a 10-character in-house trx.
const COLUMNS = [
  { key: 'date', label: 'Date', width: 58 },
  { key: 'time', label: 'Time', width: 36 },
  { key: 'description', label: 'Description', width: 148, wrap: true, maxLines: 2 },
  { key: 'reference', label: 'Reference', width: 113 },
  { key: 'amount', label: 'Amount (NGN)', width: 70, align: 'right' },
  { key: 'fee', label: 'Fee', width: 42, align: 'right' },
  { key: 'status', label: 'Status', width: 56 },
];

const TABLE_WIDTH = COLUMNS.reduce((sum, c) => sum + c.width, 0);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toNumber(value) {
  const n = Number.parseFloat(String(value ?? 0));
  return Number.isFinite(n) ? n : 0;
}

/** 1234.5 -> "1,234.50". Never prefixed with a symbol - see the file note. */
function money(value) {
  return toNumber(value).toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** "2026-08-05" -> "5 Aug 2026". */
function prettyDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return String(dateStr || '');
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** "2026-08-05" -> "05 Aug 26", the widest form that still fits the column. */
function compactDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return String(dateStr || '');
  return `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1].slice(2)}`;
}

/** Seconds never disambiguate anything here - the reference does that. */
function shortTime(timeStr) {
  return String(timeStr || '').slice(0, 5);
}

function cellText(cell) {
  if (cell && typeof cell === 'object') return String(cell.text ?? '');
  return String(cell ?? '');
}

/**
 * Cut a single-line cell down to what fits, with an ellipsis.
 *
 * PDFKit only honours `ellipsis` inside its line wrapper, and the wrapper only
 * runs when `lineBreak` is true. A non-wrapping cell therefore draws its full
 * string no matter how narrow the column is - which is how a long provider
 * reference ended up printed straight through the Amount column beside it.
 *
 * "..." rather than "…": the built-in fonts encode WinAnsi, and a character it
 * cannot represent is exactly the blank box this file avoids elsewhere.
 */
function fitText(doc, text, width) {
  const str = String(text ?? '');
  if (!str || doc.widthOfString(str) <= width) return str;

  let end = str.length;
  while (end > 0 && doc.widthOfString(`${str.slice(0, end)}...`) > width) end -= 1;
  return end > 0 ? `${str.slice(0, end)}...` : '';
}

/**
 * How tall a row has to be for its wrapping cells to fit, capped at the
 * column's `maxLines` so one pathological description cannot eat a page.
 */
function measureRow(doc, columns, cells) {
  doc.font('Helvetica').fontSize(FONT_SIZE);
  const lineHeight = doc.currentLineHeight();
  let lines = 1;

  for (const column of columns) {
    if (!column.wrap) continue;
    const width = column.width - CELL_PAD * 2;
    const height = doc.heightOfString(cellText(cells[column.key]), { width });
    const used = Math.max(1, Math.round(height / lineHeight));
    lines = Math.max(lines, Math.min(column.maxLines || 2, used));
  }

  return lines * lineHeight + CELL_PAD * 2 + ROW_GAP;
}

function widthOf(columns) {
  return columns.reduce((sum, c) => sum + c.width, 0);
}

function drawRow(doc, y, columns, cells, { bold = false, color = null, zebra = false, height } = {}) {
  const rowHeight = height || (bold ? HEADER_ROW_HEIGHT : measureRow(doc, columns, cells));

  if (zebra) {
    doc.rect(PAGE_MARGIN, y, widthOf(columns), rowHeight).fill(ZEBRA);
  }

  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(FONT_SIZE);
  let x = PAGE_MARGIN;
  for (const column of columns) {
    const cell = cells[column.key];
    const tint = (cell && typeof cell === 'object' ? cell.color : null) || color || BRAND;
    const inner = column.width - CELL_PAD * 2;
    const text = column.wrap ? cellText(cell) : fitText(doc, cellText(cell), inner);
    doc.fillColor(tint).text(text, x + CELL_PAD, y + CELL_PAD, {
      width: inner,
      align: column.align || 'left',
      lineBreak: Boolean(column.wrap),
      height: column.wrap ? rowHeight - CELL_PAD * 2 - ROW_GAP : undefined,
      ellipsis: true,
    });
    x += column.width;
  }

  doc.fillColor(BRAND);
  return y + rowHeight;
}

function drawTableHead(doc, y, columns) {
  const cells = {};
  for (const column of columns) cells[column.key] = column.label;
  const next = drawRow(doc, y, columns, cells, { bold: true, color: MUTED, height: HEADER_ROW_HEIGHT });
  doc
    .moveTo(PAGE_MARGIN, next)
    .lineTo(PAGE_MARGIN + widthOf(columns), next)
    .strokeColor(LINE)
    .lineWidth(0.7)
    .stroke();
  return next + 2;
}

function drawSummaryCard(doc, y, entries) {
  const width = doc.page.width - PAGE_MARGIN * 2;
  const cardHeight = 46;
  doc.roundedRect(PAGE_MARGIN, y, width, cardHeight, 6).fillAndStroke(ZEBRA, LINE);

  const cellWidth = width / entries.length;
  entries.forEach((entry, index) => {
    const x = PAGE_MARGIN + cellWidth * index;
    if (index > 0) {
      doc.moveTo(x, y + 8).lineTo(x, y + cardHeight - 8).strokeColor(LINE).lineWidth(0.7).stroke();
    }
    doc.font('Helvetica').fontSize(7).fillColor(MUTED)
      .text(entry.label.toUpperCase(), x + 10, y + 11, { width: cellWidth - 20, lineBreak: false, ellipsis: true });
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(entry.color || BRAND)
      .text(entry.value, x + 10, y + 24, { width: cellWidth - 20, lineBreak: false, ellipsis: true });
  });

  doc.fillColor(BRAND);
  return y + cardHeight + 16;
}

/** Full masthead: brand, document title, period, then the account block. */
function drawHeader(doc, { from, to, accountName, accountEmail, accountMobile }) {
  const right = doc.page.width - PAGE_MARGIN * 2;
  let y = PAGE_MARGIN;

  doc.font('Helvetica-Bold').fontSize(19).fillColor(BRAND).text('VoltPay', PAGE_MARGIN, y);
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
    .text('by Jade Edge Technology', PAGE_MARGIN, y + 22);

  doc.font('Helvetica-Bold').fontSize(12).fillColor(BRAND)
    .text('Transaction Statement', PAGE_MARGIN, y + 2, { width: right, align: 'right' });
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
    .text(`${prettyDate(from)} - ${prettyDate(to)}`, PAGE_MARGIN, y + 19, { width: right, align: 'right' });

  y += 42;
  doc.moveTo(PAGE_MARGIN, y).lineTo(doc.page.width - PAGE_MARGIN, y).strokeColor(LINE).lineWidth(1).stroke();
  y += 12;

  // Name on the left, contact on the right: one line each, so a long name and a
  // long email cannot collide the way a stacked block did.
  doc.font('Helvetica').fontSize(7).fillColor(MUTED).text('ACCOUNT HOLDER', PAGE_MARGIN, y);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(BRAND)
    .text(accountName || '-', PAGE_MARGIN, y + 10, { width: right * 0.55, lineBreak: false, ellipsis: true });

  const contact = [accountEmail, accountMobile].filter(Boolean).join('  •  ');
  if (contact) {
    doc.font('Helvetica').fontSize(7).fillColor(MUTED)
      .text('CONTACT', PAGE_MARGIN, y, { width: right, align: 'right' });
    doc.font('Helvetica').fontSize(8.5).fillColor(BRAND)
      .text(contact, PAGE_MARGIN + right * 0.45, y + 11, { width: right * 0.55, align: 'right', lineBreak: false, ellipsis: true });
  }

  return y + 34;
}

/** Page 2 onwards: enough context to read a loose sheet, none of the masthead. */
function drawContinuationHeader(doc, { accountName, from, to }) {
  const right = doc.page.width - PAGE_MARGIN * 2;
  const y = PAGE_MARGIN;

  doc.font('Helvetica-Bold').fontSize(9).fillColor(BRAND)
    .text(`VoltPay Statement - ${accountName || '-'}`, PAGE_MARGIN, y, {
      width: right * 0.6,
      lineBreak: false,
      ellipsis: true,
    });
  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
    .text(`${prettyDate(from)} - ${prettyDate(to)} (continued)`, PAGE_MARGIN, y, { width: right, align: 'right' });

  const ruleY = y + 14;
  doc.moveTo(PAGE_MARGIN, ruleY).lineTo(doc.page.width - PAGE_MARGIN, ruleY).strokeColor(LINE).lineWidth(0.7).stroke();
  return ruleY + 10;
}

function stampFooters(doc, generatedAt) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);

    // Inside the bottom margin, not below it: PDFKit's line wrapper treats a
    // baseline past `page.maxY()` as an overflow and "continues on a new page",
    // which used to append one blank page per footer line.
    const y = doc.page.height - PAGE_MARGIN - 10;
    doc.font('Helvetica').fontSize(7).fillColor(MUTED);
    doc.text(
      `Computer-generated statement - no signature required. Generated ${generatedAt} WAT.`,
      PAGE_MARGIN,
      y,
      { width: 400, height: 10, lineBreak: false, ellipsis: true },
    );
    doc.text(`Page ${i + 1} of ${range.count}`, PAGE_MARGIN, y, {
      width: doc.page.width - PAGE_MARGIN * 2,
      height: 10,
      align: 'right',
      lineBreak: false,
    });
  }
  doc.fillColor(BRAND);
}

/**
 * Rows, paginated. `renderRow(row, index)` hands back the cell map; the table
 * measures it, breaks the page when it will not fit, and repeats the head.
 */
function drawTable(doc, y, { columns, rows, renderRow, onNewPage }) {
  let cursor = drawTableHead(doc, y, columns);

  rows.forEach((row, index) => {
    const cells = renderRow(row, index);
    const height = measureRow(doc, columns, cells);
    // Stop above the footer band cleared by `stampFooters`.
    const bottomLimit = doc.page.height - PAGE_MARGIN - 20;

    if (cursor + height > bottomLimit) {
      doc.addPage();
      cursor = drawTableHead(doc, onNewPage ? onNewPage(doc) : PAGE_MARGIN, columns);
    }

    cursor = drawRow(doc, cursor, columns, cells, { height, zebra: index % 2 === 1 });
  });

  return cursor;
}

const STATUS_COLORS = {
  successful: CREDIT,
  success: CREDIT,
  completed: CREDIT,
  pending: PENDING,
  processing: PENDING,
  failed: DEBIT,
  cancelled: DEBIT,
  reversed: DEBIT,
};

function titleCase(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

/**
 * @param {object} input
 * @param {Array} input.rows  Newest-first ledger rows, as `collectTransactions` returns them.
 * @param {function} input.watParts  (iso) => { date, time } in Nigerian wall-clock time.
 * @returns {Promise<Buffer>} the finished PDF.
 */
function buildStatementPdf({ rows, from, to, accountName, accountEmail, accountMobile, watParts, categoryFor }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true });
      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      let credits = 0;
      let debits = 0;
      for (const row of rows) {
        if (String(row.trx_type) === '+') credits += toNumber(row.amount);
        else debits += toNumber(row.total_amount || row.amount);
      }

      let y = drawHeader(doc, { from, to, accountName, accountEmail, accountMobile });
      y = drawSummaryCard(doc, y, [
        { label: 'Transactions', value: String(rows.length) },
        { label: 'Money in (NGN)', value: money(credits), color: CREDIT },
        { label: 'Money out (NGN)', value: money(debits), color: DEBIT },
        { label: 'Net (NGN)', value: money(credits - debits), color: credits - debits < 0 ? DEBIT : BRAND },
      ]);

      if (rows.length === 0) {
        drawTableHead(doc, y, COLUMNS);
        doc.font('Helvetica').fontSize(9).fillColor(MUTED)
          .text('No transactions in this period.', PAGE_MARGIN, y + 30, { width: TABLE_WIDTH, align: 'center' });
      } else {
        drawTable(doc, y, {
          columns: COLUMNS,
          rows,
          onNewPage: d => drawContinuationHeader(d, { accountName, from, to }),
          renderRow: row => {
            const when = watParts(row.created_at);
            const isCredit = String(row.trx_type) === '+';
            const description = String(row.other_data?.subtitle || row.details || '').trim();
            const status = titleCase(row.other_data?.feedback || 'Successful');

            return {
              date: compactDate(when.date),
              time: shortTime(when.time),
              description: description || categoryFor(row.remark),
              reference: String(row.trx || ''),
              amount: {
                text: `${isCredit ? '+' : '-'}${money(row.amount)}`,
                color: isCredit ? CREDIT : DEBIT,
              },
              fee: toNumber(row.charge) > 0 ? money(row.charge) : '-',
              status: { text: status, color: STATUS_COLORS[status.toLowerCase()] || BRAND },
            };
          },
        });
      }

      stampFooters(doc, new Date(Date.now() + 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 16));
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = {
  buildStatementPdf,
  money,
  prettyDate,
  compactDate,
  fitText,
  COLUMNS,
  // Layout primitives, for any other document that needs the same look.
  drawTable,
  drawTableHead,
  drawSummaryCard,
  stampFooters,
  PAGE_MARGIN,
};
