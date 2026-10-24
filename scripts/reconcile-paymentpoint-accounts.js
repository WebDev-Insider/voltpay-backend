// PalmPay accounts PaymentPoint opened that VoltPay never recorded.
//
//   npm run funding:reconcile                                   pending attempts, and what each waits on
//   npm run funding:reconcile -- --file customers.csv           dry run: whose each exported account is
//   npm run funding:reconcile -- --file customers.csv --apply   link them, and tell each customer
//
// Before 2026-10-24 an account PaymentPoint finished after our 8s timeout - or
// answered in a shape we did not read - was never written down here. The
// customer read "not available", PaymentPoint kept a permanent account number,
// and nothing joined the two. No PaymentPoint API we know of lists accounts,
// so the source is its dashboard's customer / virtual-account export, as CSV
// or JSON (an array of rows, or saved createVirtualAccount answers).
//
// A row is linked on the webhook's own rule (placeCustomer in
// funding.controller): its customer id or account number on a row we hold, or
// its email AND phone both leading to one and the same user. Anything less is
// listed for a person, never guessed. A user whose account already shows keeps
// it. Linking tells the customer once; the 5-minute sweep and the webhook use
// the same functions, so running this twice changes nothing the second time.
//
// The export holds names, emails and phone numbers. It is read and dropped:
// this prints row numbers, user ids, the last four digits of an account number
// and an outcome - never any of those.
const fs = require('fs');
const path = require('path');

const pp = require('../src/funding/paymentpoint.service');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const fileFlag = args.indexOf('--file');
const file = args.find(a => a.startsWith('--file='))?.slice('--file='.length) || (fileFlag >= 0 ? args[fileFlag + 1] : null);

const preferBank = () => (process.env.PAYMENTPOINT_BANK_CODES || '20946').split(',')[0].trim();

// Loaded only when run, after .env: the parsers below are tested without them.
const db = () => require('../database/prisma');
const fundingController = () => require('../src/funding/funding.controller');

// Export headers, as they might be spelled, lower-cased with punctuation gone.
const COLUMNS = {
  accountNumber: ['accountnumber', 'accountno', 'virtualaccountnumber', 'virtualaccount', 'nuban', 'account'],
  customerId: ['customerid', 'customercode', 'customerref', 'customerreference'],
  email: ['email', 'customeremail', 'emailaddress'],
  phone: ['phone', 'phonenumber', 'customerphone', 'customerphonenumber', 'mobile', 'mobilenumber'],
  accountName: ['accountname', 'customername', 'name'],
  bankName: ['bankname', 'bank'],
  bankCode: ['bankcode'],
};

const norm = key => String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const last4 = number => (number ? `****${String(number).slice(-4)}` : '-');

function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delimiter = [',', ';', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some(v => v.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some(v => v.trim())) rows.push(row);

  const [header = [], ...body] = rows;
  return { headers: header.map(h => h.trim()), records: body.map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()]))) };
}

function pick(flat, names) {
  for (const n of names) {
    const v = flat[n];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return '';
}

/** One export row as { customerId, account, contact }, from either a flat row or a saved API answer. */
function toRecord(obj) {
  const flat = {};
  for (const [k, v] of Object.entries(obj || {})) if (v == null || typeof v !== 'object') flat[norm(k)] = v;
  const synthetic = {
    customer_id: pick(flat, COLUMNS.customerId),
    customer: { email: pick(flat, COLUMNS.email), phone: pick(flat, COLUMNS.phone) },
    bankAccounts: [
      {
        accountNumber: pick(flat, COLUMNS.accountNumber),
        accountName: pick(flat, COLUMNS.accountName),
        bankName: pick(flat, COLUMNS.bankName),
        bankCode: pick(flat, COLUMNS.bankCode),
      },
    ],
  };
  const structured = pp.extractVirtualAccount(obj, { preferBankCode: preferBank() });
  const fromFlat = pp.extractVirtualAccount(synthetic, { preferBankCode: preferBank() });
  const nested = obj?.data && typeof obj.data === 'object' ? obj.data : obj;
  const c1 = pp.customerContact(nested);
  const c2 = pp.customerContact(synthetic);
  return {
    customerId: structured.customerId || fromFlat.customerId,
    account: structured.account || fromFlat.account,
    contact: { email: c1.email || c2.email, phone: c1.phone || c2.phone },
  };
}

function readExport(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  if (/\.json$/i.test(filePath) || /^\s*[[{]/.test(text)) {
    const json = JSON.parse(text);
    const list = Array.isArray(json)
      ? json
      : ['data', 'customers', 'accounts', 'items', 'results'].map(k => json?.[k]).find(Array.isArray) || [json];
    return { headers: null, records: list };
  }
  return parseCsv(text);
}

const WHY = {
  linked: 'linked - the customer has been told',
  would_link: 'would link',
  already_linked: 'already linked',
  has_other_account: 'skipped - this user already shows a different account',
  unmatched: 'unmatched - no single VoltPay user has both this email and phone',
  conflict: 'conflict - these details lead to more than one VoltPay user',
  invalid: 'skipped - no 10-digit account number in this row',
};

async function reconcileFile(filePath) {
  const { headers, records } = readExport(filePath);
  if (headers && !headers.some(h => COLUMNS.accountNumber.includes(norm(h)))) {
    // Header names are the export's labels, not customer data.
    console.error(`No account number column found. Columns seen: ${headers.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n${apply ? 'APPLYING' : 'DRY RUN'}: ${records.length} row(s) from ${path.basename(filePath)}\n`);
  const counts = {};
  // CSV rows are numbered as a spreadsheet shows them, under the header line.
  const firstRow = headers ? 2 : 1;
  for (const [i, obj] of records.entries()) {
    const record = toRecord(obj);
    const result = await fundingController().linkProviderAccount(record, { apply });
    counts[result.outcome] = (counts[result.outcome] || 0) + 1;
    const who = result.userId ? `user ${result.userId}` : '-';
    const via = result.via ? ` (${result.via})` : '';
    console.log(`  row ${String(i + firstRow).padEnd(5)} ${who.padEnd(11)} ${last4(record.account?.accountNumber).padEnd(9)} ${WHY[result.outcome] || result.outcome}${via}`);
  }

  console.log(`\n${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join('   ')}`);
  if (!apply && counts.would_link) console.log('\nRun again with --apply to link the "would link" rows and notify those customers.');
}

async function listPending() {
  const funding = fundingController();
  const rows = await db().fundingTransaction.findMany({
    where: { status: funding.REGISTRATION_STATUS, raw_payload: { path: ['state'], equals: 'pending' } },
    orderBy: { id: 'asc' },
    take: 500,
  });
  const pending = rows.filter(funding.isPendingRow);
  console.log(`\nPENDING ACCOUNT REQUESTS: ${pending.length}`);
  for (const row of pending) {
    const p = row.raw_payload || {};
    const hours = ((Date.now() - new Date(p.requested_at || row.created_at).getTime()) / 3_600_000).toFixed(1);
    const view = funding.pendingView(row);
    console.log(
      `  #${row.id}  user ${row.user_id}  ${String(p.last_outcome || 'sending').padEnd(18)} ${hours}h  sends ${p.sends ?? '-'}` +
        `  customer id ${p.customer_id ? 'known' : 'unknown'}  ${view.can_retry ? 'customer can retry' : `retry in ${view.retry_in_seconds}s`}`,
    );
  }
  if (pending.some(r => r.raw_payload?.last_outcome === 'exists_at_provider')) {
    console.log("\n'exists_at_provider' rows need PaymentPoint's export: npm run funding:reconcile -- --file <export> --apply");
  }
}

async function main() {
  require('dotenv').config();
  if (file && apply) {
    // Linking pushes "your account number is ready"; without Firebase it is stored, not sent.
    try {
      require('../src/services/firebase.service').initFirebase();
    } catch (e) {
      console.warn('note  Firebase not initialised - notifications are stored, not pushed:', e?.message);
    }
  }

  if (file) await reconcileFile(file);
  else await listPending();

  await db().$disconnect().catch(() => {});
  process.exit(process.exitCode || 0);
}

if (require.main === module) {
  main().catch(e => {
    console.error('FAILED:', e.message);
    process.exit(1);
  });
}

module.exports = { parseCsv, toRecord, readExport };
