// Money operations: the screens that answer "is the money where it should be".
//
// Everything here is read-only except creditFunding, which is the one action
// that exists because reading is not enough - a customer whose transfer landed
// at the provider but never reached their wallet needs somebody to be able to
// finish it. That path is superadmin-only, idempotent, and audited.
//
// Four questions, four sections:
//   reconciliation - money that arrived at a provider and stopped
//   providers      - which rail is failing, and how badly
//   revenue        - what the platform earned, and on what
//   integrity      - does every wallet still add up
//
// PII rule as everywhere: ids, references and provider names. A funding row's
// raw_payload carries the payer's account name and number, so it is never
// returned whole - only the fields named below.

const prisma = require('../../database/prisma');
const { Prisma } = require('@prisma/client');

// Providers are reached through the registry, never imported one by one - the
// float readings and the switch below both have to cover whatever rails exist.
const bills = require('../funding/billsProvider');
const { applyBalanceDelta, isBalanceIntact } = require('../helpers/balance.helper');
const { logAdminAction } = require('../services/audit.service');
const { listEvents, summary: eventSummary } = require('../services/securityEvents.service');

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

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

function hoursAgo(hours) {
  return new Date(Date.now() - Number(hours) * 3_600_000);
}

function daysAgo(days) {
  return new Date(Date.now() - Number(days) * 86_400_000);
}

// `YYYY-MM-DD` from a date input. An end date has to become the END of that day
// or a same-day range matches nothing.
function dateRange(from, to) {
  const range = {};
  if (from) {
    const d = new Date(`${from}T00:00:00`);
    if (!Number.isNaN(d.getTime())) range.gte = d;
  }
  if (to) {
    const d = new Date(`${to}T23:59:59.999`);
    if (!Number.isNaN(d.getTime())) range.lte = d;
  }
  return Object.keys(range).length ? range : null;
}

// ---------------------------------------------------------------------------
// reconciliation
// ---------------------------------------------------------------------------

// A funding row's tx_ref names the rail that wrote it. Two of these prefixes are
// NOT payments and must never appear on this screen:
//
//   ppcust_ - a PaymentPoint virtual account REGISTRATION. One per user, status
//             'virtual_account', credited_at null forever by design. Counting
//             these as stuck credits would list every customer on the platform.
//   spva_   - the StaffPay company equivalent, same story.
//
// Getting this wrong is the difference between a queue somebody works and a
// screen nobody opens twice.
const REGISTRATION_PREFIXES = ['ppcust_', 'spva_'];
const REGISTRATION_STATUS = 'virtual_account';

const PROVIDER_BY_PREFIX = [
  { prefix: 'pp_', provider: 'paymentpoint' },
  { prefix: 'ppcust_', provider: 'paymentpoint' },
  { prefix: 'spfund_', provider: 'paystack' },
  { prefix: 'spva_', provider: 'paystack' },
  { prefix: 'flw_', provider: 'flutterwave' },
];

function providerOf(txRef) {
  const ref = String(txRef || '');
  const hit = PROVIDER_BY_PREFIX.find(p => ref.startsWith(p.prefix));
  return hit ? hit.provider : 'unknown';
}

// Anything that is not settled and not a registration row. The provider words
// differ per rail ('success' vs 'successful'), so settled is spelled out rather
// than inferred.
const SETTLED = ['successful', 'success'];

function stuckWhere({ minutes = 15, status = '', provider = '', from = '', to = '' } = {}) {
  const range = dateRange(from, to);

  const where = {
    // Registration rows carry their own status, so excluding the status is
    // enough - but the prefix guard stays as a second net in case a rail ever
    // writes one with a different word.
    status: status ? { equals: status } : { notIn: [...SETTLED, REGISTRATION_STATUS] },
    credited_at: null,
    NOT: REGISTRATION_PREFIXES.map(prefix => ({ tx_ref: { startsWith: prefix } })),
    ...(range ? { created_at: range } : { created_at: { lte: new Date(Date.now() - Number(minutes) * 60_000) } }),
  };

  return { where, provider: String(provider || '') };
}

/**
 * Money that reached a provider and stopped.
 *
 * The window matters: a funding row is `pending` for the seconds between the
 * webhook arriving and the transaction committing, so anything younger than
 * `minutes` is in flight rather than stuck. Default 15 minutes - long enough
 * that a retry has had its chance, short enough that a customer is still on
 * the phone about it.
 */
async function getReconciliation(req, res) {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const perPage = Math.min(Math.max(parseInt(req.query.perPage || '25', 10), 1), 100);
    const minutes = Math.max(parseInt(req.query.minutes || '15', 10), 0);

    const { where, provider } = stuckWhere({
      minutes,
      status: String(req.query.status || ''),
      provider: String(req.query.provider || ''),
      from: String(req.query.from || ''),
      to: String(req.query.to || ''),
    });

    const [total, rows, stuckSum, settledToday, failedToday] = await Promise.all([
      prisma.fundingTransaction.count({ where }),
      prisma.fundingTransaction.findMany({
        where,
        orderBy: { created_at: 'asc' }, // oldest first - this is a work queue
        skip: (page - 1) * perPage,
        take: perPage,
        select: {
          id: true,
          user_id: true,
          tx_ref: true,
          flutterwave_tx_id: true,
          amount: true,
          currency: true,
          status: true,
          created_at: true,
          updated_at: true,
        },
      }),
      prisma.fundingTransaction.aggregate({ where, _sum: { amount: true } }),
      prisma.fundingTransaction.count({
        where: { status: { in: SETTLED }, credited_at: { gte: hoursAgo(24) } },
      }),
      prisma.fundingTransaction.count({
        where: { status: 'error', created_at: { gte: hoursAgo(24) } },
      }),
    ]);

    // Provider is derived from the reference prefix, so it cannot be filtered
    // in SQL without a LIKE per rail. Filtering the page is correct here
    // because the page is already bounded and the counts above are reported
    // unfiltered and labelled as such.
    const items = rows
      .map(r => ({
        id: r.id,
        user_id: r.user_id,
        tx_ref: r.tx_ref,
        provider: providerOf(r.tx_ref),
        provider_tx_id: r.flutterwave_tx_id || null,
        amount: r.amount?.toString?.() ?? String(r.amount ?? '0'),
        currency: r.currency,
        status: r.status,
        created_at: r.created_at,
        updated_at: r.updated_at,
        stuck_minutes: Math.round((Date.now() - new Date(r.created_at).getTime()) / 60_000),
      }))
      .filter(r => !provider || r.provider === provider);

    return ok(res, 'admin_reconciliation', {
      items,
      summary: {
        stuck_count: total,
        stuck_amount: stuckSum._sum.amount?.toString?.() ?? '0',
        settled_24h: settledToday,
        failed_24h: failedToday,
        window_minutes: minutes,
      },
      pagination: { page, perPage, total, totalPages: Math.ceil(total / perPage) },
    });
  } catch (e) {
    console.error('adminOps.getReconciliation error', e);
    return fail(res, 500, 'Failed to load reconciliation');
  }
}

/**
 * Finish a credit by hand.
 *
 * Everything about this is copied from the PaymentPoint webhook path on
 * purpose - same claim-by-updateMany, same applyBalanceDelta, same ledger row -
 * because the whole point is that the wallet ends up in the state the webhook
 * would have left it in. The differences are the two that matter: it needs
 * superadmin, and it stamps who did it into the ledger row's meta so a credit
 * that was never actually received can be traced back to a person.
 *
 * Idempotent by the same mechanism as the webhook: `credited_at: null` in the
 * where clause. Two admins clicking at once credit once.
 */
async function creditFunding(req, res) {
  try {
    const txRef = String(req.params.ref || '').trim();
    if (!txRef) return fail(res, 400, 'Reference is required');

    const note = String(req.body?.note || '').trim();
    if (note.length < 8) return fail(res, 400, 'Give a reason of at least 8 characters - it goes in the audit log');

    const row = await prisma.fundingTransaction.findUnique({ where: { tx_ref: txRef } });
    if (!row) return fail(res, 404, 'Funding record not found');
    if (row.credited_at) return fail(res, 409, 'This payment has already been credited');
    if (REGISTRATION_PREFIXES.some(p => txRef.startsWith(p)) || row.status === REGISTRATION_STATUS) {
      return fail(res, 400, 'That is a virtual account registration, not a payment');
    }

    const amount = new Prisma.Decimal(row.amount?.toString?.() ?? '0');
    if (amount.lte(0)) return fail(res, 400, 'Nothing to credit - the recorded amount is zero');

    const user = await prisma.user.findUnique({ where: { id: Number(row.user_id) }, select: { id: true, status: true } });
    if (!user) return fail(res, 404, 'The account this payment belongs to no longer exists');

    const actor = req.admin?.name || 'admin';

    const credited = await prisma.$transaction(
      async tx => {
        const claimed = await tx.fundingTransaction.updateMany({
          where: { tx_ref: txRef, credited_at: null },
          data: { status: 'successful', credited_at: new Date() },
        });

        // Another request - or another admin - got there first.
        if (!claimed?.count) return false;

        await applyBalanceDelta(tx, 'user', row.user_id, amount);

        try {
          await tx.walletTransaction.create({
            data: {
              user_id: Number(row.user_id),
              trx: String(txRef),
              trx_type: '+',
              amount,
              charge: new Prisma.Decimal('0'),
              total_amount: amount,
              remark: 'fund_account',
              // Names nobody, so no protectText - same as the webhook path.
              details: 'Wallet funding',
              other_data: {
                title: 'Transfer to Wallet',
                subtitle: 'Wallet Funding',
                feedback: 'Successful',
                note: 'Manual credit',
                image_src: '',
              },
              // Ids only. `credited_by` is the admin handle, which is what the
              // audit log keys on - never an email.
              meta: {
                manual_credit: true,
                credited_by: String(actor).slice(0, 64),
                original_status: String(row.status || ''),
              },
            },
          });
        } catch (e) {
          // The ledger row may already exist from a half-finished webhook.
          if (e?.code !== 'P2002') throw e;
        }

        return true;
      },
      { maxWait: 10_000, timeout: 15_000 }
    );

    if (!credited) return fail(res, 409, 'This payment was credited by someone else just now');

    await logAdminAction({
      actor,
      action: 'funding.manual_credit',
      method: 'POST',
      path: req.originalUrl,
      targetType: 'funding',
      targetId: txRef,
      statusCode: 200,
      metadata: { user_id: Number(row.user_id), amount: amount.toString(), note: note.slice(0, 300) },
    });

    return ok(res, 'admin_funding_credited', { tx_ref: txRef, user_id: Number(row.user_id), amount: amount.toString() });
  } catch (e) {
    console.error('adminOps.creditFunding error', e);
    return fail(res, 500, 'Failed to credit this payment');
  }
}

// ---------------------------------------------------------------------------
// provider health
// ---------------------------------------------------------------------------

/**
 * Which rail is failing, and how badly.
 *
 * Two sources, because neither is complete on its own. Funding rows know about
 * money coming IN and nothing about a failed airtime vend; the persisted alert
 * feed knows about every failed provider call but only the failures. Reported
 * side by side rather than merged into one misleading "success rate".
 */
async function getProviderHealth(req, res) {
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours || '24', 10), 1), 24 * 30);
    const since = hoursAgo(hours);

    const [fundingRows, alerts, alertSummary] = await Promise.all([
      prisma.fundingTransaction.findMany({
        where: { created_at: { gte: since }, status: { not: REGISTRATION_STATUS } },
        select: { tx_ref: true, status: true, amount: true, credited_at: true, created_at: true },
      }),
      listEvents({ feed: 'alert', perPage: 100, from: '', to: '' }),
      eventSummary({ feed: 'alert', hours }),
    ]);

    // Fold the funding rows into one bucket per rail.
    const rails = new Map();
    const bucket = name => {
      if (!rails.has(name)) {
        rails.set(name, { provider: name, inbound_total: 0, inbound_settled: 0, inbound_stuck: 0, inbound_amount: 0, failures: 0, last_failure_at: null });
      }
      return rails.get(name);
    };

    for (const row of fundingRows) {
      const b = bucket(providerOf(row.tx_ref));
      b.inbound_total += 1;
      if (row.credited_at) {
        b.inbound_settled += 1;
        b.inbound_amount += num(row.amount);
      } else if (new Date(row.created_at).getTime() < Date.now() - 15 * 60_000) {
        b.inbound_stuck += 1;
      }
    }

    // Failures come from the alert feed, keyed `<provider>.<action>`.
    for (const entry of alertSummary.by_kind || []) {
      const provider = String(entry.kind || '').split('.')[0];
      if (!provider) continue;
      bucket(provider).failures += entry.count;
    }

    for (const event of alerts.items || []) {
      const provider = String(event.metadata?.provider || event.kind.split('.')[0] || '');
      if (!provider) continue;
      const b = bucket(provider);
      if (!b.last_failure_at || new Date(event.created_at) > new Date(b.last_failure_at)) {
        b.last_failure_at = event.created_at;
      }
    }

    const providers = [...rails.values()]
      .map(b => ({
        ...b,
        inbound_amount: b.inbound_amount.toFixed(2),
        // Only meaningful where there is inbound traffic; null renders as "-"
        // rather than as a misleading 0%.
        settle_rate: b.inbound_total ? Math.round((b.inbound_settled / b.inbound_total) * 1000) / 10 : null,
      }))
      .sort((a, b) => b.failures - a.failures || b.inbound_total - a.inbound_total);

    return ok(res, 'admin_provider_health', {
      window_hours: hours,
      providers,
      recent_failures: (alerts.items || []).slice(0, 25),
      total_failures: alertSummary.total,
    });
  } catch (e) {
    console.error('adminOps.getProviderHealth error', e);
    return fail(res, 500, 'Failed to load provider health');
  }
}

// ---------------------------------------------------------------------------
// revenue
// ---------------------------------------------------------------------------

// `charge` means two different things depending on direction, and adding them
// together would report a number that is not revenue:
//
//   on a debit  - VoltPay's fee on a transfer or a bill. Income.
//   on a credit - the provider's settlement fee on money coming in, already
//                 deducted before the wallet was credited. Not income.
//
// Reported as two lines, never as one total.
const DEBIT = '-';
const CREDIT = '+';

async function getRevenue(req, res) {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '30', 10), 1), 365);
    const since = daysAgo(days);
    const where = { created_at: { gte: since } };

    const [feeRows, fundingFeeRows, byRemark, volume] = await Promise.all([
      prisma.walletTransaction.aggregate({
        where: { ...where, trx_type: DEBIT },
        _sum: { charge: true, total_amount: true },
        _count: { _all: true },
      }),
      prisma.walletTransaction.aggregate({
        where: { ...where, trx_type: CREDIT },
        _sum: { charge: true, amount: true },
        _count: { _all: true },
      }),
      prisma.walletTransaction.groupBy({
        by: ['remark'],
        where: { ...where, trx_type: DEBIT },
        _sum: { charge: true, total_amount: true },
        _count: { _all: true },
      }),
      // Daily series. Pulled as rows and folded in JS rather than with a raw
      // date_trunc: the window is bounded, and keeping it in Prisma means the
      // query still works if the database moves.
      prisma.walletTransaction.findMany({
        where,
        select: { created_at: true, trx_type: true, charge: true, amount: true, total_amount: true },
        orderBy: { created_at: 'asc' },
      }),
    ]);

    const dayKey = d => new Date(d).toISOString().slice(0, 10);
    const series = new Map();

    for (const row of volume) {
      const key = dayKey(row.created_at);
      if (!series.has(key)) series.set(key, { date: key, fees: 0, debit_volume: 0, credit_volume: 0, count: 0 });
      const s = series.get(key);
      s.count += 1;
      if (row.trx_type === DEBIT) {
        s.fees += num(row.charge);
        s.debit_volume += num(row.total_amount);
      } else {
        s.credit_volume += num(row.amount);
      }
    }

    const daily = [...series.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(s => ({ ...s, fees: s.fees.toFixed(2), debit_volume: s.debit_volume.toFixed(2), credit_volume: s.credit_volume.toFixed(2) }));

    const by_service = byRemark
      .map(r => ({
        remark: r.remark,
        fees: num(r._sum.charge).toFixed(2),
        volume: num(r._sum.total_amount).toFixed(2),
        count: Number(r._count?._all || 0),
      }))
      .sort((a, b) => Number(b.fees) - Number(a.fees));

    return ok(res, 'admin_revenue', {
      days,
      fees_collected: num(feeRows._sum.charge).toFixed(2),
      debit_volume: num(feeRows._sum.total_amount).toFixed(2),
      debit_count: Number(feeRows._count?._all || 0),
      funding_fees: num(fundingFeeRows._sum.charge).toFixed(2),
      credit_volume: num(fundingFeeRows._sum.amount).toFixed(2),
      credit_count: Number(fundingFeeRows._count?._all || 0),
      by_service,
      daily,
    });
  } catch (e) {
    console.error('adminOps.getRevenue error', e);
    return fail(res, 500, 'Failed to load revenue');
  }
}

// ---------------------------------------------------------------------------
// integrity
// ---------------------------------------------------------------------------

// The ledger convention, which is what makes the drift check meaningful:
//
//   credit ('+') moves the balance by `amount`      - total_amount is the gross
//                                                     the payer sent, including
//                                                     the provider's fee
//   debit  ('-') moves the balance by `total_amount` - amount + our charge
//
// So: balance == SUM(credit.amount) - SUM(debit.total_amount). Anything else is
// either a row written outside applyBalanceDelta or an opening balance that
// predates the ledger.
const SCAN_CAP = 20_000;

/**
 * Two independent checks, deliberately not merged.
 *
 * The MAC check asks "was this row edited outside the application?" - it is
 * cheap, exact, and the one that catches a direct UPDATE against the database.
 * The drift check asks "does the ledger explain the balance?" - it is broader
 * and catches a money path that forgot to write a ledger row. A row can fail
 * one and pass the other, and which one it fails tells you where to look.
 */
async function getIntegrity(req, res) {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '5000', 10), 100), SCAN_CAP);
    const batchSize = 1000;

    let scanned = 0;
    let unstamped = 0;
    const failures = [];
    let cursor = undefined;

    // Batched keyset scan. A findMany over every user would hold the whole
    // table in memory on a box that also has to serve payments.
    while (scanned < limit) {
      const take = Math.min(batchSize, limit - scanned);
      const batch = await prisma.user.findMany({
        where: { status: { not: 3 } },
        select: { id: true, balance: true, balance_mac: true },
        orderBy: { id: 'asc' },
        take,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });

      if (!batch.length) break;

      for (const row of batch) {
        scanned += 1;
        if (!row.balance_mac) {
          // Predates the backfill. Not a failure - but a wallet with no MAC is
          // a wallet nothing is checking, so it is counted and shown.
          unstamped += 1;
          continue;
        }
        if (!isBalanceIntact('user', row)) {
          failures.push({ user_id: row.id, balance: row.balance?.toString?.() ?? '0', reason: 'mac_mismatch' });
        }
      }

      cursor = batch[batch.length - 1].id;
      if (batch.length < take) break;
    }

    const totalUsers = await prisma.user.count({ where: { status: { not: 3 } } });

    return ok(res, 'admin_integrity', {
      mac: {
        scanned,
        total_users: totalUsers,
        complete: scanned >= totalUsers,
        unstamped,
        failed: failures.length,
        failures: failures.slice(0, 100),
      },
    });
  } catch (e) {
    console.error('adminOps.getIntegrity error', e);
    return fail(res, 500, 'Failed to run the integrity check');
  }
}

/**
 * Ledger-vs-balance drift. Separate endpoint because it is a full aggregate
 * over wallet_transactions and has no business running every time somebody
 * opens the page - the screen asks for it on a click.
 */
async function getIntegrityDrift(req, res) {
  try {
    const tolerance = Math.abs(Number(req.query.tolerance || '0.01')) || 0.01;
    const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10), 1), 500);

    const [credits, debits] = await Promise.all([
      prisma.walletTransaction.groupBy({ by: ['user_id'], where: { trx_type: CREDIT }, _sum: { amount: true } }),
      prisma.walletTransaction.groupBy({ by: ['user_id'], where: { trx_type: DEBIT }, _sum: { total_amount: true } }),
    ]);

    const expected = new Map();
    for (const c of credits) expected.set(c.user_id, num(c._sum.amount));
    for (const d of debits) expected.set(d.user_id, (expected.get(d.user_id) || 0) - num(d._sum.total_amount));

    const userIds = [...expected.keys()];
    const rows = await prisma.user.findMany({
      where: { id: { in: userIds }, status: { not: 3 } },
      select: { id: true, balance: true },
    });

    const drifted = [];
    for (const row of rows) {
      const actual = num(row.balance);
      const should = expected.get(row.id) || 0;
      const delta = Math.round((actual - should) * 100) / 100;
      if (Math.abs(delta) > tolerance) {
        drifted.push({ user_id: row.id, balance: actual.toFixed(2), ledger_expected: should.toFixed(2), drift: delta.toFixed(2) });
      }
    }

    drifted.sort((a, b) => Math.abs(Number(b.drift)) - Math.abs(Number(a.drift)));

    const totalDrift = drifted.reduce((sum, d) => sum + Number(d.drift), 0);

    return ok(res, 'admin_integrity_drift', {
      checked: rows.length,
      drifted_count: drifted.length,
      // A net near zero across many rows usually means an opening balance
      // predating the ledger, not a leak. A large one-sided total does not.
      net_drift: totalDrift.toFixed(2),
      tolerance,
      items: drifted.slice(0, limit),
    });
  } catch (e) {
    console.error('adminOps.getIntegrityDrift error', e);
    return fail(res, 500, 'Failed to run the drift check');
  }
}

// ---------------------------------------------------------------------------
// Provider floats
// ---------------------------------------------------------------------------

/**
 * How much vending capacity is left on one rail, and where to add more.
 *
 * Bills are prepaid: airtime, data, TV and electricity all draw on a float held
 * with the provider, not on the customer's wallet. An empty float fails every
 * purchase on that rail while every customer wallet is perfectly funded, so
 * this number is an outage countdown rather than an accounting figure.
 *
 * Every registered provider's float is read, and the one that matters is
 * whichever the switch is currently on - with a second provider registered, a
 * healthy float on one says nothing about a platform vending through the
 * other. Never throws: an unreachable provider is a value on the screen, not a
 * failed request, or one dead upstream would blank the card for the rest.
 *
 * The funding account is returned even when the provider cannot be reached,
 * which is the whole reason it is served from our own environment rather than
 * read from their API. The moment you most need to transfer money to them is
 * the moment their API is down.
 */
async function readFloat(name) {
  const adapter = bills.adapterFor(name);
  const label = bills.PROVIDER_LABELS[name] || name;
  const configured = bills.isProviderConfigured(name);

  const base = {
    name,
    label,
    funding_account: adapter.getFundingAccount(),
    thresholds: adapter.floatThresholds(),
    configured,
    currency: 'NGN',
    retrieved_at: null,
  };

  if (!configured) {
    return {
      ...base,
      reachable: false,
      balance: null,
      verdict: 'unknown',
      error: `${label} has no API credentials configured, so the float cannot be read.`,
    };
  }

  // CashBuddy publishes no balance for the wallet its bills are paid from. Said
  // plainly rather than shown as "unreachable", which would send the responder
  // looking for an outage that is not there.
  if (adapter.FLOAT_READABLE === false) {
    return {
      ...base,
      reachable: false,
      balance: null,
      verdict: 'unknown',
      error: `${label} does not publish this balance over its API. Check it on the ${label} dashboard.`,
    };
  }

  try {
    const wallet = await adapter.getWalletBalance();

    return {
      ...base,
      reachable: true,
      balance: wallet.balance,
      currency: wallet.currency || 'NGN',
      retrieved_at: wallet.retrieved_at || null,
      verdict: adapter.floatVerdict(wallet.balance),
      error: null,
    };
  } catch (e) {
    // Reference only - the message can quote a provider response, and this one
    // is rendered on a screen rather than only logged.
    console.error('adminOps.readFloat error', { provider: name, reason: String(e?.message || e).slice(0, 160) });

    return {
      ...base,
      reachable: false,
      balance: null,
      verdict: 'unknown',
      error: `Could not reach ${label} to read the float.`,
    };
  }
}

/**
 * Every provider's float, side by side.
 *
 * In parallel and independently: one rail being down must not delay or hide the
 * other, which is exactly the situation an admin opens this screen to resolve.
 * `active_services` names the rails currently routed to each provider, so the
 * screen can say "this float is critical *and* it is carrying data and TV"
 * rather than leaving that join to the reader.
 */
async function getBillsFloats(req, res) {
  try {
    const names = Object.keys(bills.ADAPTERS);
    const [floats, routing] = await Promise.all([
      Promise.all(names.map(readFloat)),
      bills.listProviders(),
    ]);

    const servicesByProvider = new Map(names.map(name => [name, []]));
    for (const row of routing.services) {
      servicesByProvider.get(row.provider)?.push(row.service);
    }

    return ok(res, 'bills_floats', {
      providers: floats.map(f => ({ ...f, active_services: servicesByProvider.get(f.name) || [] })),
    });
  } catch (e) {
    console.error('adminOps.getBillsFloats error', e);
    return fail(res, 500, 'Failed to read the provider floats');
  }
}

// ---------------------------------------------------------------------------
// Provider switch
// ---------------------------------------------------------------------------

/**
 * Which provider each bills rail is currently vending through.
 *
 * Four independent switches - airtime, data, TV, electricity - because the
 * reason to move is usually per-rail: one provider's data plans are cheaper
 * while the other's electricity is more reliable. Each rail lists every
 * provider with whether it may serve it and why not, and every provider its
 * credential status by env var name (never a value).
 */
async function getBillsProviders(req, res) {
  try {
    return ok(res, 'bills_providers', await bills.listProviders());
  } catch (e) {
    console.error('adminOps.getBillsProviders error', e);
    return fail(res, 500, 'Failed to load the bills providers');
  }
}

/**
 * Point one rail at a provider.
 *
 * Takes effect within `BILLS_PROVIDER_TTL_SECONDS` of the write - the switch is
 * cached, and the cache key is dropped here, so in practice it is immediate.
 *
 * It does not disturb money already in flight. A quote pins the provider it was
 * priced against, and `bills.confirm` expires a pending quote whose rail has
 * moved rather than sending a plan id to an upstream that never issued it. Rows
 * already vending settle against the gateway stamped in their own `meta`, so a
 * switch never orphans a pending bill.
 *
 * There is no automatic failover by design: a vend that times out may already
 * have been delivered, so re-sending it to the other provider risks charging a
 * customer once and vending twice. A failure refunds and alerts; a human decides
 * whether the rail moves.
 */
async function updateBillsProvider(req, res) {
  const service = String(req.params.service || '').trim().toLowerCase();
  const provider = String(req.body?.provider ?? '').trim().toLowerCase();

  if (!provider) return fail(res, 400, '`provider` is required');

  try {
    const result = await bills.setProvider(service, provider);
    const label = bills.PROVIDER_LABELS[result.provider] || result.provider;

    // The middleware audits this route already; this is the operator-facing
    // line, and the one that appears next to the vend logs when a switch is
    // being blamed for something.
    console.log('adminOps.updateBillsProvider:', { service: result.service, provider: result.provider });

    return ok(res, 'bills_provider_updated', {
      ...result,
      label,
      message: `${bills.SERVICES[result.service]} now vends through ${label}`,
    });
  } catch (e) {
    // All five are an admin choosing something that cannot work, not a fault:
    // an unknown rail, an unknown provider, one this rail may not use (the
    // electricity ban on ClubKonnect, CashBuddy anywhere but airtime), one
    // whose keys are absent, or one that refused the keys it was sent (a wrong
    // key, or this server's IP not whitelisted with them).
    if (
      e?.code === 'UNKNOWN_SERVICE' ||
      e?.code === 'UNKNOWN_PROVIDER' ||
      e?.code === 'PROVIDER_NOT_ALLOWED' ||
      e?.code === 'PROVIDER_NOT_CONFIGURED' ||
      e?.code === 'PROVIDER_REJECTED_CREDENTIALS'
    ) {
      return fail(res, 400, e.message);
    }
    console.error('adminOps.updateBillsProvider error', e);
    return fail(res, 500, 'Failed to switch the provider');
  }
}

module.exports = {
  getReconciliation,
  creditFunding,
  getProviderHealth,
  getBillsFloats,
  getBillsProviders,
  updateBillsProvider,
  getRevenue,
  getIntegrity,
  getIntegrityDrift,
  __test: { providerOf, stuckWhere, dateRange, REGISTRATION_PREFIXES },
};
