const prisma = require('../../database/prisma');
const { Prisma } = require('@prisma/client');

const { getBulkTransfer, createBulkTransfer, getTransferFee } = require('../funding/flutterwave.service');
const { decryptString } = require('../helpers/encryption.helper');
const { logStaffPayEvent } = require('./staffpayAudit.service');

function isAccelerateCommError(e) {
  return Boolean(e && (e.code === 'P6000' || e?.meta?.code === 'P6000'));
}

async function withDirectFallback(run) {
  try {
    return await run(prisma);
  } catch (e) {
    if (isAccelerateCommError(e) && prisma.$direct) {
      return await run(prisma.$direct);
    }
    throw e;
  }
}

function safeLast4(value) {
  const s = String(value || '').replace(/\s+/g, '');
  return s.slice(-4);
}

function minutesSinceMidnightInTz({ date, timeZone }) {
  const tz = String(timeZone || 'Africa/Lagos').trim() || 'Africa/Lagos';
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    const parts = fmt.formatToParts(date);
    const hh = Number(parts.find(p => p.type === 'hour')?.value);
    const mm = Number(parts.find(p => p.type === 'minute')?.value);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    return (hh * 60) + mm;
  } catch (_) {
    const d = date instanceof Date ? date : new Date(date);
    return (d.getHours() * 60) + d.getMinutes();
  }
}

function companyPayoutTimeReached(company) {
  const payout = String(company?.payout_time || '').trim();
  if (!payout) return true;
  const tz = String(company?.payout_timezone || 'Africa/Lagos').trim() || 'Africa/Lagos';
  const [hhRaw, mmRaw] = payout.split(':');
  const hh = Number(hhRaw);
  const mm = Number(mmRaw);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return true;
  const target = (hh * 60) + mm;
  const nowMin = minutesSinceMidnightInTz({ date: new Date(), timeZone: tz });
  if (nowMin == null) return false;
  return nowMin >= target;
}

function addDaysUtc(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d;
}

function staffPayVatRate() {
  const raw = String(process.env.STAFFPAY_VAT_RATE || '').trim();
  if (!raw) return 0.075;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0.075;
  return n;
}

function computeVoltPayHybridFee(amountDecimal) {
  const pct = 0.01;
  const min = new Prisma.Decimal('20.00');
  const cap = new Prisma.Decimal('200.00');
  let fee;
  try {
    fee = new Prisma.Decimal(amountDecimal).mul(new Prisma.Decimal(pct.toFixed(4)));
  } catch {
    fee = new Prisma.Decimal('0.00');
  }
  try {
    fee = new Prisma.Decimal(fee.toFixed(2));
  } catch (_) {}
  if (fee.lt(min)) return min;
  if (fee.gt(cap)) return cap;
  return fee;
}

function nextDueAtUtc(staff) {
  const freq = String(staff?.frequency || '').trim().toLowerCase();
  const start = new Date(staff?.start_date);
  if (Number.isNaN(start.getTime())) return null;

  const lastPaid = staff?.last_paid_at ? new Date(staff.last_paid_at) : null;
  if (!lastPaid || Number.isNaN(lastPaid.getTime())) {
    if (freq === 'monthly') {
      const day = staff?.payment_day != null && Number.isFinite(Number(staff.payment_day)) ? Math.max(1, Math.min(28, Number(staff.payment_day))) : 1;
      const y = start.getUTCFullYear();
      const m = start.getUTCMonth();
      const candidate = new Date(Date.UTC(y, m, day, 0, 0, 0, 0));
      if (candidate.getTime() < start.getTime()) {
        return new Date(Date.UTC(y, m + 1, day, 0, 0, 0, 0));
      }
      return candidate;
    }

    return start;
  }

  if (freq === 'weekly') {
    return addDaysUtc(lastPaid, 7);
  }

  if (freq === 'bi-weekly' || freq === 'biweekly') {
    return addDaysUtc(lastPaid, 14);
  }

  const day = staff?.payment_day != null && Number.isFinite(Number(staff.payment_day)) ? Math.max(1, Math.min(28, Number(staff.payment_day))) : 1;
  const y = lastPaid.getUTCFullYear();
  const m = lastPaid.getUTCMonth();
  return new Date(Date.UTC(y, m + 1, day, 0, 0, 0, 0));
}

async function createPayrollRunForCompany({ company, staffIds, title }) {
  const db = prisma.$direct || prisma;

  const staff = await db.staffPayStaff.findMany({
    where: {
      company_id: Number(company.id),
      is_active: true,
      ...(Array.isArray(staffIds) && staffIds.length ? { id: { in: staffIds.map(Number).filter(Boolean) } } : {}),
    },
    orderBy: { id: 'asc' },
  });

  if (!staff.length) return null;

  const totalSalary = staff.reduce((acc, s) => acc.plus(s.salary_amount || new Prisma.Decimal('0.00')), new Prisma.Decimal('0.00'));

  const vatRate = staffPayVatRate();
  const feeByStaffId = new Map();
  let flutterwaveFeeTotal = new Prisma.Decimal('0.00');
  let voltpayFeeTotal = new Prisma.Decimal('0.00');
  let vatTotal = new Prisma.Decimal('0.00');

  for (const s of staff) {
    const bankCode = String(s.bank_code || '').trim();
    const isGhanaBank = /^GH/i.test(bankCode);
    const currency = isGhanaBank ? 'GHS' : 'NGN';
    const amt = s.salary_amount || new Prisma.Decimal('0.00');

    let flwFee = new Prisma.Decimal('0.00');
    try {
      const { data } = await getTransferFee({ amount: Number(new Prisma.Decimal(amt).toString()), currency });
      const nFee = data?.fee != null && Number.isFinite(Number(data.fee)) ? Number(data.fee) : 0;
      flwFee = new Prisma.Decimal(nFee.toFixed(2));
    } catch (_) {
      flwFee = new Prisma.Decimal('0.00');
    }

    const voltFee = currency === 'NGN' ? computeVoltPayHybridFee(amt) : new Prisma.Decimal('0.00');
    let itemVat = currency === 'NGN' ? (new Prisma.Decimal(vatRate.toString()).mul(flwFee.plus(voltFee))) : new Prisma.Decimal('0.00');
    try {
      itemVat = new Prisma.Decimal(itemVat.toFixed(2));
    } catch (_) {}

    flutterwaveFeeTotal = flutterwaveFeeTotal.plus(flwFee);
    voltpayFeeTotal = voltpayFeeTotal.plus(voltFee);
    vatTotal = vatTotal.plus(itemVat);
    feeByStaffId.set(Number(s.id), { flutterwave_fee: flwFee, voltpay_fee: voltFee, vat: itemVat });
  }

  const totalDebit = totalSalary.plus(flutterwaveFeeTotal).plus(voltpayFeeTotal).plus(vatTotal);

  const payrollRun = await db.$transaction(async tx => {
    const reserved = await tx.staffPayWallet.updateMany({
      where: { company_id: Number(company.id), balance: { gte: totalDebit } },
      data: { balance: { decrement: totalDebit } },
    });

    if (!reserved?.count) {
      const err = new Error('Insufficient StaffPay wallet balance');
      err.statusCode = 400;
      throw err;
    }

    const run = await tx.staffPayPayrollRun.create({
      data: {
        company_id: Number(company.id),
        title,
        status: 'preparing',
        total_salary: totalSalary,
        flutterwave_fee_total: flutterwaveFeeTotal,
        voltpay_fee_total: voltpayFeeTotal,
        vat_total: vatTotal,
        total_debit: totalDebit,
        items: {
          createMany: {
            data: staff.map(s => ({
              staff_id: s.id,
              amount: s.salary_amount,
              flutterwave_fee: feeByStaffId.get(Number(s.id))?.flutterwave_fee || new Prisma.Decimal('0.00'),
              voltpay_fee: feeByStaffId.get(Number(s.id))?.voltpay_fee || new Prisma.Decimal('0.00'),
              vat: feeByStaffId.get(Number(s.id))?.vat || new Prisma.Decimal('0.00'),
              status: 'NEW',
            })),
          },
        },
      },
    });

    return run;
  }, { timeout: 15000, maxWait: 15000 });

  await logStaffPayEvent({
    userId: Number(company.owner_user_id),
    event: 'staffpay_payroll_run_initiated',
    metadata: { company_id: Number(company.id), payroll_run_id: payrollRun.id, total_salary: Number(totalSalary.toString()), mode: 'auto' },
  });

  let bulk;
  try {
    const bulk_data = staff.map(s => {
      const acct = decryptString(s.account_number_enc);
      const bankCode = String(s.bank_code || '').trim();
      const isGhanaBank = /^GH/i.test(bankCode);
      const currency = isGhanaBank ? 'GHS' : 'NGN';

      const item = {
        bank_code: bankCode,
        account_number: acct,
        amount: Number(new Prisma.Decimal(s.salary_amount || '0').toString()),
        currency,
        narration: 'Salary payment',
      };

      if (isGhanaBank) {
        const branch = String(s.bank_branch_code || '').trim();
        if (branch) {
          item.destination_branch_code = branch;
        }
      }

      return item;
    });

    bulk = await createBulkTransfer({ title, bulk_data });
  } catch (e) {
    console.error('StaffPay scheduler: auto payroll bulk transfer error:', {
      statusCode: e?.statusCode,
      message: e?.message,
      flutterwave: e?.flutterwave,
    });

    await db.$transaction([
      db.staffPayPayrollRun.update({ where: { id: payrollRun.id }, data: { status: 'failed' } }),
      db.staffPayWallet.update({ where: { company_id: Number(company.id) }, data: { balance: { increment: totalDebit } } }),
      db.staffPayPayrollItem.updateMany({ where: { payroll_run_id: payrollRun.id }, data: { status: 'FAILED', complete_message: e?.message || 'Bulk transfer failed' } }),
    ]);

    return null;
  }

  const batchId = bulk?.data?.id;
  await db.staffPayPayrollRun.update({
    where: { id: payrollRun.id },
    data: {
      status: 'queued',
      batch_id: batchId != null ? Number(batchId) : null,
    },
  });

  return payrollRun;
}

async function syncPayrollRunById(runId) {
  const run = await withDirectFallback(p => p.staffPayPayrollRun.findUnique({
    where: { id: Number(runId) },
    include: { company: true, items: { include: { staff: true } } },
  }));

  if (!run || !run.batch_id) return null;

  const { data: transfers } = await getBulkTransfer({ batch_id: String(run.batch_id) });
  const transferList = Array.isArray(transfers) ? transfers : [];

  const itemsByStaffId = new Map((run.items || []).map(i => [Number(i.staff_id), i]));

  let feeTotal = new Prisma.Decimal('0.00');
  let vatTotal = new Prisma.Decimal('0.00');
  let voltpayFeeTotal = new Prisma.Decimal('0.00');
  const vatRate = staffPayVatRate();

  for (const t of transferList) {
    const bank_code = String(t?.bank_code || '').trim();
    const acct = String(t?.account_number || '').trim();
    const last4 = safeLast4(acct);

    const staff = (run.items || []).map(i => i.staff).find(s => String(s.bank_code) === bank_code && String(s.account_number_last4) === last4);
    if (!staff) continue;

    const item = itemsByStaffId.get(Number(staff.id));
    if (!item) continue;

    const fee = t?.fee != null && Number.isFinite(Number(t.fee)) ? new Prisma.Decimal(Number(t.fee).toFixed(2)) : new Prisma.Decimal('0.00');
    feeTotal = feeTotal.plus(fee);

    const existingVoltFee = item?.voltpay_fee != null ? new Prisma.Decimal(item.voltpay_fee) : new Prisma.Decimal('0.00');
    voltpayFeeTotal = voltpayFeeTotal.plus(existingVoltFee);
    const bankCode = String(staff?.bank_code || '').trim();
    const isGhanaBank = /^GH/i.test(bankCode);
    const itemVat = isGhanaBank ? new Prisma.Decimal('0.00') : new Prisma.Decimal(vatRate.toString()).mul(fee.plus(existingVoltFee));
    const itemVat2 = (() => {
      try {
        return new Prisma.Decimal(itemVat.toFixed(2));
      } catch {
        return itemVat;
      }
    })();
    vatTotal = vatTotal.plus(itemVat2);

    await withDirectFallback(p => p.staffPayPayrollItem.update({
      where: { id: item.id },
      data: {
        flutterwave_transfer_id: t?.id != null ? Number(t.id) : null,
        reference: t?.reference ? String(t.reference) : null,
        status: t?.status ? String(t.status) : item.status,
        complete_message: t?.complete_message ? String(t.complete_message) : (t?.completeMessage ? String(t.completeMessage) : null),
        flutterwave_fee: fee,
        vat: itemVat2,
        raw_payload: t,
      },
    }));
  }

  const oldTotalDebit = run.total_debit != null
    ? new Prisma.Decimal(run.total_debit)
    : new Prisma.Decimal(run.total_salary || '0');
  const totalDebit = new Prisma.Decimal(run.total_salary || '0').plus(feeTotal).plus(voltpayFeeTotal).plus(vatTotal);
  const delta = totalDebit.minus(oldTotalDebit);

  await withDirectFallback(p => p.$transaction(async tx => {
    await tx.staffPayPayrollRun.update({
      where: { id: run.id },
      data: { flutterwave_fee_total: feeTotal, voltpay_fee_total: voltpayFeeTotal, vat_total: vatTotal, total_debit: totalDebit },
    });

    if (!delta.isZero()) {
      if (delta.gt(new Prisma.Decimal('0.00'))) {
        await tx.staffPayWallet.upsert({
          where: { company_id: run.company_id },
          update: { balance: { decrement: delta } },
          create: { company_id: run.company_id, balance: new Prisma.Decimal('0.00').minus(delta) },
        });
      } else {
        await tx.staffPayWallet.upsert({
          where: { company_id: run.company_id },
          update: { balance: { increment: delta.abs() } },
          create: { company_id: run.company_id, balance: delta.abs() },
        });
      }
    }
  }, { timeout: 15000, maxWait: 15000 }));

  const refreshed = await withDirectFallback(p => p.staffPayPayrollRun.findUnique({
    where: { id: run.id },
    include: { items: true },
  }));

  const statuses = (refreshed?.items || []).map(i => String(i.status || '').toUpperCase());
  const hasPending = statuses.some(s => s === 'NEW' || s === 'PENDING');
  const hasFailed = statuses.some(s => s === 'FAILED');
  const allSuccessful = statuses.length > 0 && statuses.every(s => s === 'SUCCESSFUL');

  const newStatus = allSuccessful ? 'successful' : (hasPending ? 'processing' : (hasFailed ? 'failed' : 'processing'));

  const updatedRun = await withDirectFallback(p => p.staffPayPayrollRun.update({
    where: { id: run.id },
    data: { status: newStatus },
    include: { company: true },
  }));

  if (newStatus === 'successful') {
    try {
      const staffIds = Array.from(new Set((refreshed?.items || []).map(i => Number(i.staff_id)).filter(Boolean)));
      if (staffIds.length) {
        await withDirectFallback(p => p.staffPayStaff.updateMany({
          where: { id: { in: staffIds } },
          data: { last_paid_at: new Date() },
        }));
      }
    } catch (_) {}
  }

  const ownerId = updatedRun?.company?.owner_user_id;
  if (ownerId) {
    await logStaffPayEvent({
      userId: ownerId,
      event: 'staffpay_payroll_run_synced',
      metadata: { company_id: updatedRun.company_id, payroll_run_id: updatedRun.id, status: newStatus },
    });
  }

  return { payroll_run_id: updatedRun.id, status: newStatus };
}

function startStaffPayScheduler(options = {}) {
  const enabledRaw = String(process.env.STAFFPAY_SCHEDULER_ENABLED || '').trim().toLowerCase();
  const enabled = enabledRaw === 'true' || enabledRaw === '1';
  if (!enabled) return null;

  const debugRaw = String(process.env.STAFFPAY_SCHEDULER_DEBUG || '').trim().toLowerCase();
  const debug = debugRaw === 'true' || debugRaw === '1';

  if (!prisma.staffPayPayrollRun || !prisma.staffPayPayrollItem) {
    console.log('ℹ️  StaffPay scheduler enabled but Prisma StaffPay models are unavailable. Run prisma generate + migrate/db push and restart the server.');
    return null;
  }

  const intervalMs = Number(options.intervalMs || process.env.STAFFPAY_SYNC_INTERVAL_MS || 60_000);
  const limit = Number(options.limit || process.env.STAFFPAY_SYNC_BATCH_LIMIT || 10);

  const autoPayEnabledRaw = String(process.env.STAFFPAY_AUTOPAY_ENABLED || '').trim().toLowerCase();
  const autoPayEnabled = autoPayEnabledRaw === 'true' || autoPayEnabledRaw === '1';
  const autoPayIntervalMs = Number(options.autoPayIntervalMs || process.env.STAFFPAY_AUTOPAY_INTERVAL_MS || intervalMs);
  let lastAutoPayAt = 0;

  console.log('⏱️  StaffPay scheduler started', {
    enabled: true,
    debug,
    tick_interval_ms: intervalMs,
    sync_batch_limit: limit,
    autopay_enabled: autoPayEnabled,
    autopay_interval_ms: autoPayIntervalMs,
  });

  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      if (autoPayEnabled && now - lastAutoPayAt >= autoPayIntervalMs) {
        lastAutoPayAt = now;
        try {
          const companies = await withDirectFallback(p => p.staffPayCompany.findMany({
            where: { auto_pay_enabled: true },
            select: { id: true, owner_user_id: true, name: true, payout_time: true, payout_timezone: true },
            take: 50,
            orderBy: { id: 'asc' },
          }));

          for (const c of companies || []) {
            try {
              if (!companyPayoutTimeReached(c)) {
                if (debug) {
                  const payout = String(c?.payout_time || '').trim();
                  const tz = String(c?.payout_timezone || 'Africa/Lagos').trim() || 'Africa/Lagos';
                  const nowMin = minutesSinceMidnightInTz({ date: new Date(), timeZone: tz });
                  const [hhRaw, mmRaw] = payout.split(':');
                  const target = (Number(hhRaw) * 60) + Number(mmRaw);
                  console.log('StaffPay scheduler: payout_time not reached', {
                    company_id: c?.id,
                    payout_time: c?.payout_time,
                    payout_timezone: c?.payout_timezone,
                    now_minutes: nowMin,
                    target_minutes: Number.isFinite(target) ? target : null,
                  });
                }
                continue;
              }

              const hasActiveRun = await withDirectFallback(p => p.staffPayPayrollRun.findFirst({
                where: {
                  company_id: Number(c.id),
                  status: { in: ['preparing', 'queued', 'processing'] },
                },
                select: { id: true },
              }));
              if (hasActiveRun) continue;

              const staff = await withDirectFallback(p => p.staffPayStaff.findMany({
                where: { company_id: Number(c.id), is_active: true },
                select: { id: true, frequency: true, payment_day: true, start_date: true, last_paid_at: true },
                take: 300,
                orderBy: { id: 'asc' },
              }));

              const dueIds = [];
              const nowDate = new Date();
              for (const s of staff || []) {
                const dueAt = nextDueAtUtc(s);
                if (!dueAt) continue;
                if (dueAt.getTime() <= nowDate.getTime()) {
                  dueIds.push(Number(s.id));
                }
              }

              if (!dueIds.length) continue;

              if (debug) {
                console.log('StaffPay scheduler: due staff detected', {
                  company_id: c?.id,
                  due_staff_count: dueIds.length,
                });
              }

              const title = `Auto staff salary payout (${new Date().toISOString().slice(0, 10)})`;
              await createPayrollRunForCompany({ company: c, staffIds: dueIds, title });
            } catch (e) {
              console.error('StaffPay scheduler: auto payroll company tick error:', c?.id, e?.message || e);
            }
          }
        } catch (e) {
          console.error('StaffPay scheduler: auto payroll tick error:', e?.message || e);
        }
      }

      const runs = await withDirectFallback(p => p.staffPayPayrollRun.findMany({
        where: {
          batch_id: { not: null },
          status: { in: ['queued', 'processing'] },
        },
        orderBy: { id: 'asc' },
        take: limit,
        select: { id: true },
      }));

      for (const r of runs || []) {
        try {
          await syncPayrollRunById(r.id);
        } catch (e) {
          console.error('StaffPay scheduler: sync run failed', r?.id, e?.message || e);
        }
      }
    } catch (e) {
      console.error('StaffPay scheduler tick error:', e?.message || e);
    } finally {
      running = false;
    }
  };

  tick().catch(() => null);
  const timer = setInterval(() => tick().catch(() => null), intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();

  return {
    stop: () => clearInterval(timer),
  };
}

module.exports = {
  startStaffPayScheduler,
  syncPayrollRunById,
};
