// Risk and compliance: the screens somebody has to be able to answer a
// regulator from.
//
//   security   - what the platform blocked, and who tripped it
//   kyc queue  - identification records waiting on a decision, oldest first
//   aml        - large and structured transaction reports, exportable, over
//                BOTH personal wallets and StaffPay company wallets
//
// All read-only. Nothing here changes a verification decision: that stays in
// the KYC flow itself, where the provider's match result is available and the
// audit trail already exists. This is the screen that finds the record, not the
// screen that rules on it.
//
// The AML thresholds are the CBN / NFIU reporting ones. They are configurable
// because they are policy, not physics, and the numbers move.

const prisma = require('../../database/prisma');

const { listEvents, summary: eventSummary } = require('../services/securityEvents.service');
const { limits: velocityLimits, isEnabled: velocityEnabled } = require('../helpers/velocity.helper');

function ok(res, remark, data) {
  return res.json({ remark, status: 'success', data });
}

function fail(res, code, message) {
  return res.status(code).json({ remark: 'error', status: 'error', message: [message], data: null });
}

function num(value, fallback = 0) {
  const n = Number(value?.toString?.() ?? value);
  return Number.isFinite(n) ? n : fallback;
}

function daysAgo(days) {
  return new Date(Date.now() - Number(days) * 86_400_000);
}

function envNumber(name, fallback) {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// security feed
// ---------------------------------------------------------------------------

/**
 * Everything the platform refused, in one list.
 *
 * Reads the persisted feed rather than Redis. The lockout counters in
 * loginLockout.helper live in Redis with a 10-minute expiry - by design, since
 * they are a control and not a record - so what is shown here is the durable
 * trail alerts.service writes alongside them. A lockout that has already
 * expired still appears, which is the point: the question on this screen is
 * "what happened", not "what is happening right now".
 */
async function listSecurity(req, res) {
  try {
    const [feed, day, week] = await Promise.all([
      listEvents({
        feed: 'security',
        page: req.query.page,
        perPage: req.query.perPage || 50,
        kind: String(req.query.kind || ''),
        // Both spellings. The dashboard's filter form posts `userId`, this read
        // `user_id`, and nothing in between normalises the two - so filtering by
        // account silently returned the whole unfiltered feed, which is the
        // worst way for a filter to fail: it looks like it worked, and reads as
        // if that one user tripped everything on the page.
        userId: req.query.user_id || req.query.userId || null,
        severity: String(req.query.severity || ''),
        from: String(req.query.from || ''),
        to: String(req.query.to || ''),
      }),
      eventSummary({ feed: 'security', hours: 24 }),
      eventSummary({ feed: 'security', hours: 24 * 7 }),
    ]);

    return ok(res, 'admin_security_events', {
      ...feed,
      summary: {
        last_24h: day.total,
        last_7d: week.total,
        by_kind: day.by_kind,
        last_at: day.last_at,
      },
      // The controls themselves, so an admin reading a spike of velocity trips
      // can see the ceiling that produced them without opening the env file.
      controls: {
        velocity_enabled: velocityEnabled(),
        ...velocityLimits(),
      },
    });
  } catch (e) {
    console.error('adminRisk.listSecurity error', e);
    return fail(res, 500, 'Failed to load security events');
  }
}

// ---------------------------------------------------------------------------
// KYC queue
// ---------------------------------------------------------------------------

// A record is "waiting" when a requirement is unresolved. Split out because the
// requirements fail independently - a user can be BVN-verified and still have
// no bank account on file, and that is a different conversation from one who
// has submitted nothing at all.
const PENDING_STATES = ['none', 'pending'];

/**
 * kycGate.rowIsVerified, expressed as a Prisma filter.
 *
 * There is no way to run the predicate itself inside a `count`, so this is the
 * one place the rule is written twice - and the only way that stays honest is
 * for the two to be edited together. Today: an identity document (a verified
 * BVN or a human-approved NIN slip) AND a name-matched bank account.
 *
 * `nin_status` is NOT in here. That column is the fossil of the withdrawn
 * automated NIN-number check; live rows still carry 'verified' in it and it
 * grants nothing. Adding it would report a population several times larger than
 * the one whose wallets are actually open.
 */
const IDENTITY_DONE = { OR: [{ status: 'verified' }, { nin_slip_status: 'approved' }] };
const VERIFIED = { AND: [IDENTITY_DONE, { account_status: 'verified' }] };

// Anything a provider or a reviewer actually refused. The fossil NIN column is
// kept in this one so historical declines stay findable, which is the whole
// reason those columns were not dropped.
const FAILED = {
  OR: [
    { status: 'failed' },
    { nin_slip_status: 'declined' },
    { account_status: 'failed' },
    { nin_status: 'failed' },
  ],
};

/**
 * Identification records that need a human, oldest first.
 *
 * No names, no numbers. The queue is a list of ids and ages - an admin opens
 * the user to see the record, which is where the reveal gate and its audit
 * entry live. Putting the identity on the list screen would mean every glance
 * at the queue decrypts a hundred people's details.
 */
async function listKycQueue(req, res) {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const perPage = Math.min(Math.max(parseInt(req.query.perPage || '25', 10), 1), 100);
    const filter = String(req.query.filter || 'waiting');

    // Started, not finished, nothing refused - the rows where the next move is
    // ours or the user's rather than a provider's.
    //
    // This used to OR `nin_status` against PENDING_STATES, which quietly turned
    // into "every row": the automated NIN route was withdrawn, so `nin_status`
    // sits at 'none' for everyone, and a fully verified user was being counted
    // as awaiting review. It reads the two LIVE columns instead, and excludes
    // anything already verified or already refused so the three buckets on the
    // compliance screen do not overlap.
    const waiting = {
      AND: [
        { NOT: VERIFIED },
        { NOT: FAILED },
        {
          OR: [
            { status: { in: PENDING_STATES } },
            { nin_slip_status: 'pending' },
            { account_status: { in: PENDING_STATES } },
          ],
        },
      ],
    };

    const where = filter === 'failed' ? FAILED : filter === 'verified' ? VERIFIED : waiting;

    const [total, rows, counts] = await Promise.all([
      prisma.kycVerification.count({ where }),
      prisma.kycVerification.findMany({
        where,
        orderBy: { submitted_at: 'asc' },
        skip: (page - 1) * perPage,
        take: perPage,
        select: {
          user_id: true,
          reference: true,
          status: true,
          nin_status: true,
          nin_slip_status: true,
          nin_slip_decline_reason: true,
          account_status: true,
          account_decline_reason: true,
          account_verified_at: true,
          decline_reason: true,
          nin_decline_reason: true,
          gender: true,
          submitted_at: true,
          verified_at: true,
          nin_verified_at: true,
        },
      }),
      Promise.all([
        prisma.kycVerification.count({ where: waiting }),
        prisma.kycVerification.count({ where: FAILED }),
        prisma.kycVerification.count({ where: VERIFIED }),
      ]),
    ]);

    // Still ids and statuses only - no name, no number, no account. The two new
    // fields are which HALF is outstanding, which is the question this queue is
    // opened to answer and is not identity.
    const items = rows.map(r => ({
      user_id: r.user_id,
      reference: r.reference,
      bvn_status: r.status,
      nin_slip_status: r.nin_slip_status || 'none',
      bank_status: r.account_status || 'none',
      // The fossil, kept so a historical decline is still visible on the row it
      // belongs to. It decides nothing.
      nin_status: r.nin_status || 'none',
      decline_reason:
        r.decline_reason || r.nin_slip_decline_reason || r.account_decline_reason || r.nin_decline_reason || null,
      gender: r.gender || null,
      submitted_at: r.submitted_at,
      // The moment the LAST requirement landed, since that is when the wallet
      // actually opened - a BVN cleared in March against a bank account added in
      // July is a July verification.
      verified_at:
        r.account_verified_at && (r.verified_at || r.nin_verified_at)
          ? new Date(
              Math.max(
                new Date(r.account_verified_at).getTime(),
                new Date(r.verified_at || r.nin_verified_at).getTime(),
              ),
            )
          : null,
      waiting_days: Math.floor((Date.now() - new Date(r.submitted_at).getTime()) / 86_400_000),
    }));

    return ok(res, 'admin_kyc_queue', {
      items,
      summary: { waiting: counts[0], failed: counts[1], verified: counts[2] },
      pagination: { page, perPage, total, totalPages: Math.ceil(total / perPage) },
    });
  } catch (e) {
    console.error('adminRisk.listKycQueue error', e);
    return fail(res, 500, 'Failed to load the KYC queue');
  }
}

// ---------------------------------------------------------------------------
// AML
// ---------------------------------------------------------------------------

// NFIU reporting thresholds, in naira. A single transaction at or above
// CTR_THRESHOLD is a Currency Transaction Report; a set of smaller ones that
// add up past the same line inside a day is the structuring pattern that a
// Suspicious Transaction Report is for.
//
// The structuring floor used to be hardcoded at `single / 2`, which quietly made
// the whole report dead weight: five movements of at least ₦2.5m is ₦12.5m in a
// day, and the daily line it has to clear to be worth reporting separately is
// ₦10m. Every structuring row was therefore already an aggregate row, so the
// section could not surface an account the one above it had not. The floor is
// its own setting now, defaulting to a fifth of the single line - five ₦1m
// movements is ₦5m, under the daily line, so the report can fire on its own.
//
// `structuring_independent` reports whether the CURRENT numbers still hold that
// property. It is surfaced rather than enforced: an operator may deliberately
// want a narrow band, and a report that silently re-tunes its own thresholds
// would be worse than one that says what it is doing.
function thresholds() {
  const single = envNumber('AML_SINGLE_THRESHOLD', 5_000_000);
  const daily = envNumber('AML_DAILY_THRESHOLD', 10_000_000);
  const structuring_count = envNumber('AML_STRUCTURING_COUNT', 5);

  // An absolute floor wins; otherwise a ratio of the single line, so moving the
  // CTR threshold moves the band with it.
  const ratio = Number(String(process.env.AML_STRUCTURING_FLOOR_RATIO ?? '').trim());
  const usableRatio = Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? ratio : 0.2;
  const structuring_floor = envNumber('AML_STRUCTURING_FLOOR', single * usableRatio);

  return {
    single,
    daily,
    structuring_count,
    structuring_floor,
    structuring_independent: structuring_floor * structuring_count < daily,
  };
}

// ---------------------------------------------------------------------------
// The rules, written once
// ---------------------------------------------------------------------------

// Every money source normalises to this before it is scored, so the three tests
// below are implemented once and cannot drift between a personal wallet and a
// StaffPay one:
//
//   { subject, ref, direction: 'in' | 'out', value: Number, at: Date, label }
//
// `subject` is whoever the report would be filed against - a user id for a
// personal wallet, a company id for StaffPay. `value` is what the account
// actually moved, GROSS of any fee, because a report is measured on what the
// customer transacted and not on what we credited them afterwards.

/**
 * Three reports off one pass over a set of movements.
 *
 * @param {Array} movements normalised movements, newest first
 * @param {object} t        thresholds()
 * @param {number} limit    rows to return per report
 * @param {string} subjectKey `user_id` or `company_id` - the column the caller's screen links on
 */
function scanMovements(movements, t, limit, subjectKey = 'user_id') {
  const large = [];
  // subject+day -> { subject, date, count, total, near_threshold }
  const perSubjectDay = new Map();

  for (const m of movements) {
    const day = new Date(m.at).toISOString().slice(0, 10);
    const key = `${m.subject}:${day}`;

    if (m.value >= t.single) {
      large.push({
        [subjectKey]: m.subject,
        trx: m.ref,
        direction: m.direction,
        amount: m.value.toFixed(2),
        remark: m.label,
        created_at: m.at,
      });
    }

    if (!perSubjectDay.has(key)) {
      perSubjectDay.set(key, { subject: m.subject, date: day, count: 0, total: 0, near_threshold: 0 });
    }
    const bucket = perSubjectDay.get(key);
    bucket.count += 1;
    bucket.total += m.value;
    // "Just under": at the configured floor and below the reporting line. Big
    // enough to be deliberate, small enough to stay off a CTR.
    if (m.value >= t.structuring_floor && m.value < t.single) bucket.near_threshold += 1;
  }

  const buckets = [...perSubjectDay.values()];

  const aggregate = buckets
    .filter(b => b.total >= t.daily)
    .map(b => ({ [subjectKey]: b.subject, date: b.date, count: b.count, total: b.total.toFixed(2) }))
    .sort((a, b) => Number(b.total) - Number(a.total));

  const structuring = buckets
    .filter(b => b.near_threshold >= t.structuring_count)
    .map(b => ({
      [subjectKey]: b.subject,
      date: b.date,
      near_threshold_count: b.near_threshold,
      total: b.total.toFixed(2),
    }))
    .sort((a, b) => b.near_threshold_count - a.near_threshold_count);

  // Distinct subjects, not a sum of the three lists. One ₦12m transfer is a
  // large row AND an aggregate row for its user-day, so adding the counts
  // reports one situation as two or three.
  const subjects = new Set();
  for (const r of large) subjects.add(r[subjectKey]);
  for (const r of aggregate) subjects.add(r[subjectKey]);
  for (const r of structuring) subjects.add(r[subjectKey]);

  return {
    large: large.slice(0, limit),
    large_count: large.length,
    aggregate: aggregate.slice(0, limit),
    aggregate_count: aggregate.length,
    structuring: structuring.slice(0, limit),
    structuring_count: structuring.length,
    subjects,
  };
}

// ---------------------------------------------------------------------------
// Collectors: one per place money moves
// ---------------------------------------------------------------------------

// How many ledger rows one scan may pull into memory. The read used to be
// unbounded, which on a growing ledger is an out-of-memory waiting for a
// 90-day window - and `wallet_transactions` has no index a bare `created_at`
// range can open, so it was a sequential scan and a sort as well. Bounded, and
// the bound is REPORTED: a compliance report that silently drops rows is worse
// than one that refuses to.
const SCAN_CAP = () => Math.min(envNumber('AML_SCAN_MAX_ROWS', 50_000), 200_000);

/**
 * Personal wallets.
 *
 * Direction decides which column is the gross figure, and it is not symmetric:
 *
 *   debit  `total_amount` = amount + our charge. What left the wallet.
 *   credit `amount` is NET of the provider's fee on a funding row, where
 *          `total_amount` carries the gross the customer actually paid in.
 *
 * Scoring a credit on `amount` let a fee carry a deposit under the line: pay in
 * ₦5,000,500 against a ₦1,000 settlement fee and ₦4,999,500 is credited, which
 * is under a ₦5,000,000 CTR threshold and was never reported. Taking the larger
 * of the two is a no-op on every row where no fee was deducted (a transfer
 * receipt writes both columns the same) and picks the gross where one was.
 */
async function collectWalletMovements(since, cap) {
  const rows = await prisma.walletTransaction.findMany({
    where: { created_at: { gte: since } },
    select: { user_id: true, trx: true, trx_type: true, amount: true, total_amount: true, remark: true, created_at: true },
    orderBy: { created_at: 'desc' },
    // One over the cap, so a full page can be told from a truncated one.
    take: cap + 1,
  });

  const truncated = rows.length > cap;
  const used = truncated ? rows.slice(0, cap) : rows;

  const movements = used.map(row => ({
    subject: row.user_id,
    ref: row.trx,
    direction: row.trx_type === '-' ? 'out' : 'in',
    value: row.trx_type === '-' ? num(row.total_amount) : Math.max(num(row.amount), num(row.total_amount)),
    at: row.created_at,
    label: row.remark,
  }));

  return { movements, truncated, scanned: used.length };
}

/**
 * StaffPay, which the report could not see at all.
 *
 * Payroll runs on its own wallet and its own tables - `staffpay_wallets`,
 * `staffpay_funding_transactions`, `staffpay_payroll_runs/items` - none of which
 * are `wallet_transactions`. So the largest concentration of money on the
 * platform, a business funding tens of millions and disbursing it across a few
 * hundred accounts, produced no AML rows whatsoever. That is the exact shape
 * monitoring exists for.
 *
 * The subject is the COMPANY, not the person who pressed the button: a report is
 * filed against the account the money moved through.
 *
 * Two movement kinds:
 *   in   one credited funding of the payroll wallet
 *   out  one payroll RUN, totalled from the items that actually paid
 *
 * The run rather than the item is the unit on the way out. A single salary is
 * never near a reporting threshold, and a run is what a human would describe:
 * "this company disbursed ₦48m on the 25th". Totalled from SUCCESSFUL items
 * rather than from the run's `total_debit`, because a partial run refunds what
 * failed and `total_debit` is the reserve, not the disbursement.
 *
 * Dated on `paid_at`, never `updated_at` - the schema comment on that column
 * spells out why: `updated_at` moves every time a webhook or a sweep touches the
 * row, so a window filter would match the touch instead of the payment.
 */
async function collectStaffPayMovements(since, cap) {
  const [fundings, items] = await Promise.all([
    prisma.staffPayFundingTransaction.findMany({
      where: { status: 'successful', credited_at: { gte: since } },
      select: { company_id: true, tx_ref: true, amount: true, credited_at: true },
      orderBy: { credited_at: 'desc' },
      take: cap + 1,
    }),
    prisma.staffPayPayrollItem.findMany({
      where: { status: 'SUCCESSFUL', paid_at: { gte: since } },
      select: { payroll_run_id: true, amount: true, provider_fee: true, voltpay_fee: true, vat: true, paid_at: true },
      orderBy: { paid_at: 'desc' },
      take: cap + 1,
    }),
  ]);

  const truncated = fundings.length > cap || items.length > cap;
  const usedFundings = fundings.slice(0, cap);
  const usedItems = items.slice(0, cap);

  const movements = usedFundings.map(f => ({
    subject: f.company_id,
    ref: f.tx_ref,
    direction: 'in',
    value: num(f.amount),
    at: f.credited_at,
    label: 'staffpay_funding',
  }));

  // Roll the items up into their runs before scoring. Keyed by run AND day so a
  // run whose transfers landed across midnight is counted on the days it paid.
  const runTotals = new Map();
  for (const item of usedItems) {
    const day = new Date(item.paid_at).toISOString().slice(0, 10);
    const key = `${item.payroll_run_id}:${day}`;
    // What left the StaffPay wallet - the same convention as a personal debit,
    // where `total_amount` carries our charge alongside the amount.
    const cost = num(item.amount) + num(item.provider_fee) + num(item.voltpay_fee) + num(item.vat);

    if (!runTotals.has(key)) {
      runTotals.set(key, { run_id: item.payroll_run_id, day, total: 0, at: item.paid_at });
    }
    const bucket = runTotals.get(key);
    bucket.total += cost;
    // Newest wins - the list arrives descending, so the first one seen is it.
  }

  // One lookup for the company behind each run that actually paid.
  const runIds = [...new Set([...runTotals.values()].map(r => r.run_id))];
  const runs = runIds.length
    ? await prisma.staffPayPayrollRun.findMany({
        where: { id: { in: runIds } },
        select: { id: true, company_id: true },
      })
    : [];
  const companyOf = new Map(runs.map(r => [r.id, r.company_id]));

  for (const run of runTotals.values()) {
    const companyId = companyOf.get(run.run_id);
    if (companyId == null) continue;

    movements.push({
      subject: companyId,
      ref: `run_${run.run_id}`,
      direction: 'out',
      value: run.total,
      at: run.at,
      label: 'staffpay_payroll',
    });
  }

  return { movements, truncated, scanned: usedFundings.length + usedItems.length };
}

/**
 * Three reports, over both places money moves.
 *
 *   large       - one movement over the single-transaction threshold
 *   aggregate   - one account over the daily threshold across many movements
 *   structuring - many movements just under the line, same account, same day
 *
 * Run twice: once over personal wallets, keyed on user id, and once over
 * StaffPay, keyed on company id. Same rules both times - `scanMovements` is the
 * only place they are written.
 *
 * Ids only. A report is filed against an account, and the identity behind it is
 * pulled at filing time by someone who has the authority to - not decrypted a
 * hundred at a time so a screen can render.
 */
async function getAmlReport(req, res) {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '30', 10), 1), 365);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '200', 10), 1), 1000);
    const t = thresholds();
    const since = daysAgo(days);
    const cap = SCAN_CAP();

    const [wallet, staffpay] = await Promise.all([
      collectWalletMovements(since, cap),
      collectStaffPayMovements(since, cap),
    ]);

    const walletReport = scanMovements(wallet.movements, t, limit, 'user_id');
    const staffpayReport = scanMovements(staffpay.movements, t, limit, 'company_id');

    // Distinct accounts with something to look at, across both sources. The
    // headline used to add the three report counts together, which reports one
    // ₦12m transfer as two flags - it is a large movement and an aggregate day
    // for the same person.
    const flagged_accounts = walletReport.subjects.size + staffpayReport.subjects.size;

    const strip = ({ subjects, ...rest }) => rest;

    return ok(res, 'admin_aml_report', {
      days,
      thresholds: t,
      scanned: wallet.scanned + staffpay.scanned,
      flagged_accounts,
      // Truncation is surfaced, never swallowed. `orderBy created_at desc` plus
      // a cap means the rows dropped are the OLDEST in the window, so a
      // truncated 90-day report is really a report on the most recent activity -
      // the screen has to be able to say so.
      truncated: wallet.truncated || staffpay.truncated,
      scan_cap: cap,
      // Personal wallets stay at the top level: this is the shape the compliance
      // screen has always read.
      ...strip(walletReport),
      staffpay: strip(staffpayReport),
    });
  } catch (e) {
    console.error('adminRisk.getAmlReport error', e);
    return fail(res, 500, 'Failed to build the AML report');
  }
}

// CSV rather than a PDF: this goes into a spreadsheet on somebody's desk, gets
// a column added, and is sent on. Anything cleverer gets converted to CSV by
// the recipient anyway.
function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, columns) {
  const head = columns.join(',');
  const body = rows.map(r => columns.map(c => csvEscape(r[c])).join(',')).join('\n');
  return `${head}\n${body}\n`;
}

const EXPORT_COLUMNS = ['date', 'source', 'account_type', 'account_id', 'reference', 'direction', 'amount', 'charge', 'total', 'category'];

/**
 * The same report as a file. Streams the underlying rows for a window rather
 * than the derived buckets - a compliance officer wants the rows to work from,
 * and the derivation is on the screen they came from.
 *
 * Covers both money sources, because a flag the officer can see on screen but
 * cannot export is a flag they cannot file. `source` and `account_type` are
 * there so the two never silently merge: `account_id` 12 is a different subject
 * depending on whether it is a user or a company.
 */
async function exportTransactions(req, res) {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '30', 10), 1), 365);
    const cap = Math.min(Math.max(parseInt(req.query.limit || '10000', 10), 1), 50_000);
    const min = Math.max(Number(req.query.min || '0'), 0);
    const since = daysAgo(days);

    const [wallet, staffFunding, staffItems] = await Promise.all([
      prisma.walletTransaction.findMany({
        where: { created_at: { gte: since } },
        select: { user_id: true, trx: true, trx_type: true, amount: true, charge: true, total_amount: true, remark: true, created_at: true },
        orderBy: { created_at: 'desc' },
        take: cap,
      }),
      prisma.staffPayFundingTransaction.findMany({
        where: { status: 'successful', credited_at: { gte: since } },
        select: { company_id: true, tx_ref: true, amount: true, credited_at: true },
        orderBy: { credited_at: 'desc' },
        take: cap,
      }),
      prisma.staffPayPayrollItem.findMany({
        where: { status: 'SUCCESSFUL', paid_at: { gte: since } },
        select: { payroll_run_id: true, amount: true, provider_fee: true, voltpay_fee: true, vat: true, paid_at: true, reference: true },
        orderBy: { paid_at: 'desc' },
        take: cap,
      }),
    ]);

    const runIds = [...new Set(staffItems.map(i => i.payroll_run_id))];
    const runs = runIds.length
      ? await prisma.staffPayPayrollRun.findMany({ where: { id: { in: runIds } }, select: { id: true, company_id: true } })
      : [];
    const companyOf = new Map(runs.map(r => [r.id, r.company_id]));

    // No `details` and no `other_data`: both carry a counterparty name, and a
    // CSV is the single easiest thing in this codebase to email to the wrong
    // person. Ids and figures only - and on the StaffPay side that means no
    // staff name and no resolved account name either.
    const mapped = [
      ...wallet.map(r => ({
        date: new Date(r.created_at).toISOString(),
        source: 'wallet',
        account_type: 'user',
        account_id: r.user_id,
        reference: r.trx,
        direction: r.trx_type === '-' ? 'out' : 'in',
        amount: num(r.amount).toFixed(2),
        charge: num(r.charge).toFixed(2),
        total: num(r.total_amount).toFixed(2),
        category: r.remark,
      })),
      ...staffFunding.map(f => ({
        date: new Date(f.credited_at).toISOString(),
        source: 'staffpay',
        account_type: 'company',
        account_id: f.company_id,
        reference: f.tx_ref,
        direction: 'in',
        amount: num(f.amount).toFixed(2),
        charge: '0.00',
        total: num(f.amount).toFixed(2),
        category: 'staffpay_funding',
      })),
      ...staffItems
        .filter(i => companyOf.has(i.payroll_run_id))
        .map(i => {
          const charge = num(i.provider_fee) + num(i.voltpay_fee) + num(i.vat);

          return {
            date: new Date(i.paid_at).toISOString(),
            source: 'staffpay',
            account_type: 'company',
            account_id: companyOf.get(i.payroll_run_id),
            reference: i.reference || `run_${i.payroll_run_id}`,
            direction: 'out',
            amount: num(i.amount).toFixed(2),
            charge: charge.toFixed(2),
            total: (num(i.amount) + charge).toFixed(2),
            category: 'staffpay_payroll',
          };
        }),
    ]
      .filter(r => !min || Number(r.total) >= min)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    const csv = toCsv(mapped, EXPORT_COLUMNS);
    const filename = `voltpay-transactions-${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csv);
  } catch (e) {
    console.error('adminRisk.exportTransactions error', e);
    return fail(res, 500, 'Failed to export');
  }
}

module.exports = {
  listSecurity,
  listKycQueue,
  getAmlReport,
  exportTransactions,
  __test: { thresholds, toCsv, csvEscape, scanMovements, EXPORT_COLUMNS },
};
