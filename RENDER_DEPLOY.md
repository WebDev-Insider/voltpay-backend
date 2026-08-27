# Deploying the VoltPay API to Render (automatic StaffPay payroll)

The goal of this deploy is narrow and specific: **move the StaffPay scheduler off a
laptop and onto a process that is awake at 11:30 WAT on the 25th.** Everything
below serves that.

The Blueprint is `render.yaml` at the repo root. It is valid YAML and defines one
web service, `voltpay-api`, on `plan: starter`, `region: ohio`, `rootDir: backend`,
`numInstances: 1`.

---

## Two things that are broken today and are not fixed by `render.yaml`

Read these before anything else. The Blueprint solves "the process is not running".
It does not solve either of these, and each one on its own is enough to make payday
fail silently.

### 1. The remote is two months behind the code

Resolved 27 August 2026 — kept here because the failure mode is worth recognising.

An earlier version of this document said the backend was not in git at all. That was
read from the **monorepo** working tree (`Desktop/voltpay`), where `git ls-files`
returns 3 and `backend/` looks untracked. It is not untracked — it is a **separate
repository**. `backend/.git` exists, so the outer repo cannot see inside it and stages
the whole directory as a single gitlink:

```
git add -A --dry-run    ->  add 'backend/'      # one line, zero files
```

That is the trap. Committing the monorepo produces a tree with an **empty**
`backend/` directory, and Render clones it and finds nothing to build.

The backend has always had its own remote, and it is reachable and private:

```
origin  https://github.com/WebDev-Insider/voltpay-backend.git   (main)
```

The real problem was staleness: `main` sat at `9f259dc` from **2026-06-24** with 156
uncommitted local changes, 145 of them under `src/`. The remote had
`staffpayScheduler.service.js` but **not** `staffpayPayroll.service.js`, and none of
the KYC or PairGate work. Deploying it would have produced a service that boots, runs
a scheduler, and cannot pay anyone.

**This repo is the deploy source, which is why `render.yaml` lives here and has no
`rootDir`.** `server.js` is at the root of this repository. See the comment in
`render.yaml` before re-adding that line.

`.env` is excluded — `backend/.gitignore:61`, confirmed with
`git check-ignore -v .env`, and it has never been committed. Verify it again after
staging, because this is the one mistake a later commit cannot undo:

```bash
git add -A
git status --short | grep -i "\.env"    # must print nothing but .env.example
```

**Still outstanding: `user_data.json` is in this repository's history** and contains a
real user's name, email, mobile, address and wallet balance. The file is deleted as of
the deploy commit, so it ships no further, and the repo is private — but a deletion is
not a purge. Removing the blob needs `git filter-repo` and a force-push.

### 2. The Paystack payout float is empty

All three historical payroll runs failed with the same provider message:

> `Your balance is not enough to fulfil this request`

This is **Paystack's merchant-side error**, not a company-wallet problem. The StaffPay
wallet behaved correctly: it reserved, the transfer was rejected, and it refunded —
the company wallet is sitting at ₦1,500 as it should. What was empty is *VoltPay's own
Paystack balance*, which is where outbound transfers are actually drawn from.

`staffpayPayroll.service.js` recognises this class of failure explicitly:

```js
const MERCHANT_SIDE_FAILURE = [
  /balance is not enough/i, /insufficient (balance|funds)/i, ...
];
```

and rewrites it for the user as *"Payouts are temporarily unavailable. Your wallet was
not debited"* — which is honest, and also means **a business owner watching the app
will never see the real cause.** Only you can.

**Fund the Paystack balance before the next payday.** A running scheduler with an empty
float produces exactly the same outcome as no scheduler at all, just with more logs.

---

## What is actually due, and when

> **25 August 2026 passed with the scheduler still on the laptop.** That payday was
> not covered by this deploy and almost certainly did not run. Before relying on the
> September cycle, check `/api/admin/staffpay/scheduler` and the payroll history for
> the August cycle, and settle it manually if it is outstanding. Nothing was lost —
> a failed transfer refunds the StaffPay wallet — but nobody was paid either.

| | |
|---|---|
| Next automatic payday | **25 September 2026** |
| Payout time | **11:30 WAT** (company setting, not the `09:00` default) |
| Amount needed | **₦532.25** — ₦500 salary + ₦10 provider + ₦20 VoltPay fee + ₦2.25 VAT |
| StaffPay wallet | ₦1,500 — **covered** |
| Paystack float | **must be funded — this is the blocker** |

The payday window is forgiving. `companyPayoutTimeReached()` returns
`nowMin >= target`, so *any* tick from 11:30 WAT until midnight WAT will pay. The
service does not need to be up at exactly 11:30; it needs to be up sometime that day.
That is a deliberate design property, and it is why "the process is awake" is the
whole battle.

---

## Deploy

### Step 1 — push the backend

See blocker 1. Nothing else works until this is done.

### Step 2 — create the Blueprint

Render dashboard → **New → Blueprint** → pick the repository. It reads `render.yaml`
and proposes the `voltpay-api` service. Render will prompt for every `sync: false`
variable during creation — that is the whole point of that flag, and it is why no
credential appears in the committed file.

Build and start are already correct and need no dashboard edits:

- `buildCommand: npm ci` — `backend/package-lock.json` exists (188 KB), so `npm ci`
  is valid, and `postinstall` runs `prisma generate` automatically.
- `startCommand: npm start` → `node server.js`.

**Do not add `prisma migrate deploy` to the build.** This project has no
`prisma/migrations` directory — it uses `prisma db push` plus hand-written DDL scripts
(`scripts/apply-staffpay-scheduler-ddl.js`, `ddl:kyc`, `ddl:idempotency`). A migrate
step in the build would have nothing to apply. Schema changes stay a deliberate,
out-of-band action against Neon, which is the right posture for a production database
holding real balances.

### Step 3 — fill the secrets

31 variables are marked `sync: false`. Two need thought rather than copy-paste:

**`PUBLIC_BASE_URL`** currently points at an ngrok tunnel that will not exist in
production. Set it to the live Render URL, e.g. `https://voltpay-api.onrender.com`.
Paystack callbacks and virtual-account webhook URLs are built from this value, so a
stale one means inbound funding silently stops working.

**`PII_HASH_KEY` and `PII_ENC_KEY`** must be the *same values already in use*, 32 bytes
each and distinct from `JWT_SECRET`. These are not regenerable. `PII_HASH_KEY` keys the
blind indexes that every `*_idx` lookup depends on — deploy a different one and every
existing user becomes "user not found" on login. If it ever must change, the only
recovery is `node scripts/backfill-pii.js --reindex`.

Everything else is a straight copy from the working `.env`.

### Step 4 — repoint the webhooks

Once the service has a URL, update the Paystack dashboard (and Budpay / PaymentPoint /
Payvessel / Flutterwave, as configured) to the Render host. Transfer webhooks are the
*first* of four recovery layers for a payroll item —
`handleTransferEvent` → `syncPayrollRunById` polling → auto-retry with backoff →
`recoverStrandedRuns`. Payroll still reconciles without webhooks, because the polling
layer exists, but it reconciles minutes later instead of seconds later. Point them at
the new host anyway.

---

## Verify the scheduler is alive

Three checks, in increasing order of how much they prove.

**1. Boot log.** `server.js:397` calls `startStaffPayScheduler()`. On Render it will
start rather than refuse: `SERVERLESS_ENV_KEYS` is `VERCEL`,
`AWS_LAMBDA_FUNCTION_NAME`, `LAMBDA_TASK_ROOT`, `NETLIFY`, `K_SERVICE`, and Render sets
none of these. If you see *"StaffPay scheduler refused to start"*, the platform was
misdetected. If you see nothing at all, `STAFFPAY_SCHEDULER_ENABLED` is not `true`.

**2. Health.** `GET https://<host>/health` — also what Render's own health check hits.

**3. The one that matters:** `GET /api/admin/staffpay/scheduler` (admin auth required,
`admin.routes.js:98`). It returns:

```
healthy                    true when last_tick_age_seconds is under 3 tick intervals
last_tick_at
last_tick_age_seconds      should stay under ~60
instance                   MUST be a Render instance id, not DESKTOP-K6FACNA
autopay_enabled            must be true
companies_scanned_last_tick
runs_created_last_tick
auto_runs_24h
```

**`instance` is the field to watch.** Today the heartbeat reads
`DESKTOP-K6FACNA:13512` — the scheduler's last known home was the development laptop,
with a last tick roughly six hours stale. After deploy it must read a Render instance
id (`staffpayScheduler.service.js` prefers `RENDER_INSTANCE_ID`). If it still shows the
desktop, the laptop is winning the heartbeat and you have two schedulers competing.

**Then stop running the backend locally.** Two schedulers on the same Neon database
will not double-pay — the `staffpay_payroll_items_staff_id_cycle_key_key` unique index
on `(staff_id, cycle_key)` makes that physically impossible at the database level — but
they will overwrite each other's heartbeat, and you will lose the ability to tell
whether production is alive.

---

## Two settings not to change

**`plan: starter`, not `free`.** A free Render web service sleeps after ~15 minutes
with no HTTP traffic. A sleeping process has no timer. Payday passes in complete
silence — no payment, no error, no alert. That is the identical failure mode to leaving
the scheduler on a laptop, which is the problem this deploy exists to fix.

**`numInstances: 1`.** StaffPay itself would tolerate more; the cycle key guarantees it.
But `server.js` starts four other timers alongside the payroll scheduler — request-money
reminders, the Payvessel betting refund sweep, support-ticket auto-close, and spending
insight emails. Those are not obviously idempotent, and a second instance runs all of
them twice. This is also why the Blueprint defines one service rather than a web +
worker pair.

`autoDeploy: false` is set on purpose too: a push that redeploys mid-payroll at 11:29
on the 25th is not a plan. Deploy deliberately, and not on a payday.

---

## Pre-payday checklist — 25 September 2026

- [x] Backend committed and pushed; `.env` confirmed absent from the commit
- [ ] August cycle reconciled or paid manually (see the note above)
- [ ] Blueprint deployed, build green
- [ ] All 31 `sync: false` variables set; `PUBLIC_BASE_URL` is the Render URL
- [ ] `PII_HASH_KEY` / `PII_ENC_KEY` identical to the existing values
- [ ] Paystack webhook repointed to the Render host
- [ ] `/api/admin/staffpay/scheduler` → `healthy: true`, `autopay_enabled: true`
- [ ] `instance` shows a **Render** id, not `DESKTOP-K6FACNA`
- [ ] Local backend stopped
- [ ] **Paystack payout float funded** — comfortably above ₦532.25
- [ ] StaffPay wallet ≥ ₦532.25 (currently ₦1,500 ✓)
- [ ] Company KYB approved **and** subscription active — `decideAccess()` requires both
- [ ] No deploy scheduled for the 25th

### If the 25th passes with nothing paid

In order:

1. `/api/admin/staffpay/scheduler` — is `last_tick_age_seconds` small? If not, the
   process is not running.
2. `autopay_enabled` false → `STAFFPAY_AUTOPAY_ENABLED` is not set. This is the quiet
   one: the scheduler starts, syncs and retries perfectly, and never initiates a
   payday. Both flags are required.
3. `companies_scanned_last_tick: 0` → set `STAFFPAY_SCHEDULER_DEBUG=true` temporarily.
   It logs the per-company reason: *payout_time not reached*, *company not eligible*.
4. Company eligibility → KYB approved and subscription live, both.
5. Items exist but every one failed → read the failure. If it is
   *"balance is not enough"*, it is the Paystack float again, and no amount of retrying
   fixes it.

Nothing here loses money. A failed transfer refunds the StaffPay wallet, and an
indeterminate one (timeout, 5xx) is deliberately left `PENDING` and never refunded
until it is resolved, precisely so a network blip cannot pay a salary twice.
