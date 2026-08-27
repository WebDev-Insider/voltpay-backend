// Identity verification table (individual KYC: the BVN, or a reviewed NIN slip).
//
// The rule this table serves has changed six times. The comment blocks below
// are a running log of that, in order, and each describes the era it introduced
// - only the LAST one is live. Today: an ArewaSmart BVN lookup (paid, ₦60 off
// the customer's wallet) OR a NIN slip an admin has looked at and approved, AND
// a bank account resolved into the same name. Two doors, then a second lock.
//
// The four earlier eras are history, not behaviour. Read them for why a column
// exists; do not read them for what passes. `nin_status` in particular is a
// fossil of the withdrawn automated NIN check and verifies nobody - the live
// NIN path is `nin_slip_status`, which is a different column on purpose.
//
// Prisma CLI cannot reach Neon from this machine (P1001 over IPv6), so the DDL
// goes over pg like the other apply-*-ddl scripts. Every statement is guarded,
// so re-running is a no-op.
//
// After this: `npx prisma generate` - until the client knows about the model,
// nobody can be verified and the gate treats every account as unverified.
require('dotenv').config();
const { Client } = require('pg');

const STATEMENTS = [
  // Every identity field is ciphertext. bvn_idx is the keyed blind index, and
  // its unique constraint is what stops one BVN from verifying two accounts -
  // enforced in SQL, not in the controller, so a race cannot slip past it.
  `CREATE TABLE IF NOT EXISTS kyc_verifications (
     id              serial PRIMARY KEY,
     user_id         integer NOT NULL,
     bvn_enc         text NOT NULL,
     bvn_idx         text NOT NULL,
     first_name_enc  text NOT NULL,
     middle_name_enc text,
     last_name_enc   text NOT NULL,
     phone_enc       text NOT NULL,
     dob_enc         text NOT NULL,
     gender          text NOT NULL,
     reference       text NOT NULL,
     callback_token  text NOT NULL,
     status          text NOT NULL DEFAULT 'pending',
     decline_reason  text,
     submitted_at    timestamp(3) NOT NULL DEFAULT now(),
     verified_at     timestamp(3),
     created_at      timestamp(3) NOT NULL DEFAULT now(),
     updated_at      timestamp(3) NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS kyc_verifications_user_id_key ON kyc_verifications (user_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS kyc_verifications_bvn_idx_key ON kyc_verifications (bvn_idx)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS kyc_verifications_reference_key ON kyc_verifications (reference)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS kyc_verifications_callback_token_key ON kyc_verifications (callback_token)`,
  `CREATE INDEX IF NOT EXISTS kyc_verifications_status_idx ON kyc_verifications (status)`,
  // NIN, added after the table shipped. Nullable for the same reason bvn_enc
  // became nullable below: each document is a route to the same result, so a
  // verified row may hold either one and not the other.
  `ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS nin_enc text`,
  `ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS nin_idx text`,
  `ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS nin_status text NOT NULL DEFAULT 'none'`,
  `ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS nin_decline_reason text`,
  `ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS nin_match jsonb`,
  `ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS nin_verified_at timestamp(3)`,
  // Same rule as the BVN: one NIN cannot verify two accounts. Postgres allows
  // many NULLs under a unique index, so the rows with no NIN yet are fine.
  `CREATE UNIQUE INDEX IF NOT EXISTS kyc_verifications_nin_idx_key ON kyc_verifications (nin_idx)`,
  `CREATE INDEX IF NOT EXISTS kyc_verifications_nin_status_idx ON kyc_verifications (nin_status)`,
  // BVN moved from BudPay (asynchronous, settled on a callback) to Payvessel
  // (synchronous). So: no callback token, no `pending` state, a match result to
  // store, and a failed attempt must not claim the unique index.
  `ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS bvn_match jsonb`,
  `ALTER TABLE kyc_verifications ALTER COLUMN bvn_idx DROP NOT NULL`,
  `ALTER TABLE kyc_verifications ALTER COLUMN callback_token DROP NOT NULL`,
  `ALTER TABLE kyc_verifications ALTER COLUMN status SET DEFAULT 'none'`,
  // Identity verification takes BVN *or* NIN, whichever the user holds. A
  // NIN-only account has no BVN to store, so the column cannot stay NOT NULL.
  `ALTER TABLE kyc_verifications ALTER COLUMN bvn_enc DROP NOT NULL`,
  // Deleting a user takes their BVN with them. The ledger survives on its own
  // rows - identity data has no reason to outlive the account.
  `DO $$ BEGIN
     ALTER TABLE kyc_verifications
       ADD CONSTRAINT kyc_verifications_user_id_fkey
       FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

  // ---------------------------------------------------------------------
  // Back to BudPay, and now two checks instead of one: a BVN (asynchronous
  // again, so `pending` and callback_token come back into use) and a bank
  // account in the same name. NIN is retired - its columns stay, because
  // dropping them would destroy identity records still inside their retention
  // period and would unverify the grandfathered NIN-only accounts below.
  // ---------------------------------------------------------------------
  `ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS account_number_enc text`,
  `ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS account_number_idx text`,
  `ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS account_name_enc text`,
  `ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS bank_code text`,
  `ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS bank_name text`,
  `ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS account_status text NOT NULL DEFAULT 'none'`,
  `ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS account_decline_reason text`,
  `ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS account_verified_at timestamp(3)`,
  // Same rule as the BVN: one real bank account cannot back two VoltPay
  // wallets. Enforced in SQL so a race cannot slip past the controller, and
  // NULL-tolerant so an unverified attempt never claims the number.
  `CREATE UNIQUE INDEX IF NOT EXISTS kyc_verifications_account_number_idx_key ON kyc_verifications (account_number_idx)`,
  `CREATE INDEX IF NOT EXISTS kyc_verifications_account_status_idx ON kyc_verifications (account_status)`,

  // The one statement in this file that is not idempotent on its own, so it is
  // tied to the creation of the column instead of to the script.
  //
  // Every account verified under the old BVN-or-NIN rule is unlocked right
  // now. Tightening the rule to BVN-and-account without this would freeze all
  // of them the moment the code deploys - a live wallet, holding real money,
  // locked by a rule change its owner was never told about. So they are marked
  // once, here, and the gate honours the mark forever.
  //
  // Guarded on the column not existing rather than on the value, because a
  // re-run must not catch users who have since verified a BVN under the new
  // rule but not yet added their bank account - grandfathering those would let
  // them skip the second check entirely.
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_name = 'kyc_verifications' AND column_name = 'grandfathered'
     ) THEN
       ALTER TABLE kyc_verifications ADD COLUMN grandfathered boolean NOT NULL DEFAULT false;
       UPDATE kyc_verifications
         SET grandfathered = true
         WHERE status = 'verified' OR nin_status = 'verified';
       RAISE NOTICE 'grandfathered % existing verification(s)', (
         SELECT count(*) FROM kyc_verifications WHERE grandfathered
       );
     END IF;
   END $$`,

  // --------------------------------------------------------- SUPERSEDED ---
  // Back to Payvessel, with both documents live - but only ONE required. A
  // verified BVN *or* a verified NIN, whichever the user holds, each scored
  // against the same VoltPay profile name.
  //
  // Superseded by the BVN-only section at the bottom of this file. Kept because
  // it is what put `grandfathered` on the table and what unlocked the rows that
  // still carry it.
  //
  // A BVN-and-NIN rule was written and then withdrawn before it ever locked
  // anybody: it doubled the provider spend per user (Payvessel bills each check
  // whether it passes or fails) to answer one question, and it made "we need to
  // know who you are" mean "you must already be banked", since a BVN needs a
  // bank account and a NIN does not.
  //
  // No DDL undoes any of that, because none of it lives in the schema. The gate
  // predicate reads `status` and `nin_status`, and only kycGate.rowIsVerified
  // decides how:
  //
  //   - the bank-account check is withdrawn. Its columns stay; nothing reads
  //     them for an access decision.
  //   - `grandfathered` was, at THIS point, redundant rather than ignored: it
  //     had been set exactly where `status = 'verified' OR nin_status =
  //     'verified'`, which was the predicate of this era, so every marked row
  //     passed on its own documents. That stopped being true one section down.
  //
  // Nothing is dropped. These columns hold identity records still inside their
  // retention period and are the evidence of what was checked, and when.
  // ---------------------------------------------------------------------

  // BudPay settled the BVN on a callback. That route is gone, so a submission
  // still in flight at the cutover can never be settled by anything - left as
  // `pending` it would sit in a state no code path can clear, and the app would
  // show "we are confirming your BVN" forever. Rolled to `failed` with a reason
  // the user can actually act on. Idempotent: a re-run matches no rows.
  `UPDATE kyc_verifications
      SET status = 'failed',
          decline_reason = 'Please submit your BVN again - our verification provider has changed.'
    WHERE status = 'pending'`,

  // ------------------------------------------------------------- CURRENT ---
  // NIN WITHDRAWN. Verification is a verified BVN and nothing else. The NIN
  // form, route and provider call are all gone; POST /kyc/nin/verify answers 410
  // so an installed APK gets an instruction instead of a mystery.
  //
  // There is NO DDL for this, and that is not an oversight - the rule has never
  // lived in the schema. `kycGate.rowIsVerified` reads `status` and stopped
  // reading `nin_status`, which is the entire change. The nin_* columns, their
  // unique index and their data all stay: identity records inside their
  // retention period, and the evidence behind a decision an auditor may ask
  // about.
  //
  // This one TIGHTENS the rule, so unlike every section above it can take a
  // wallet away. The exposure is exactly:
  //
  //   SELECT count(*) FROM kyc_verifications
  //    WHERE nin_status = 'verified' AND status <> 'verified';
  //
  // It returned 0 before the change - no account had ever been verified by NIN -
  // so nothing was frozen and no notification campaign was needed. Re-run it
  // before applying this to any environment that has been taking real users
  // since. Anything but 0 is a live wallet holding real money, about to be
  // locked by a rule change its owner was never told about; those accounts need
  // to be told to submit a BVN BEFORE the code ships, not after.
  //
  // `grandfathered` is now IGNORED rather than redundant. It marks a strictly
  // broader set than the live predicate, so a grandfathered NIN-only row does
  // NOT pass. Do not resurrect it as a shortcut.
  // ---------------------------------------------------------------------

  // ------------------------------------------- CURRENT: THE NIN SLIP PATH ---
  // A second way in, for the customer who has no BVN at all. They photograph
  // their NIN slip, a human being looks at it, and an admin approves or declines.
  //
  // THESE ARE NOT THE nin_* COLUMNS ABOVE. Those were the automated Payvessel
  // NIN number check, and they are withdrawn - `nin_status = 'verified'` still
  // verifies nobody. These are a reviewed document, and an approval here DOES
  // open the wallet (kycGate.rowIsVerified). Two trust models, two column sets,
  // on purpose: merged, an approval and a fossil would be the same value.
  //
  // This one LOOSENS the rule, so unlike the section above it cannot freeze
  // anybody - the worst case is a wallet that stays locked exactly as it is now.
  // No backfill, no exposure query, no campaign.
  `ALTER TABLE kyc_verifications
     ADD COLUMN IF NOT EXISTS nin_slip_url_enc        TEXT,
     ADD COLUMN IF NOT EXISTS nin_slip_number_enc     TEXT,
     ADD COLUMN IF NOT EXISTS nin_slip_number_idx     TEXT,
     ADD COLUMN IF NOT EXISTS nin_slip_status         TEXT NOT NULL DEFAULT 'none',
     ADD COLUMN IF NOT EXISTS nin_slip_decline_reason TEXT,
     ADD COLUMN IF NOT EXISTS nin_slip_reviewed_by    TEXT,
     ADD COLUMN IF NOT EXISTS nin_slip_reviewed_at    TIMESTAMP(3),
     ADD COLUMN IF NOT EXISTS nin_slip_submitted_at   TIMESTAMP(3)`,

  // The reviewer's own register check, run while a slip is open. Separate from
  // `nin_match` above, which is the fossil of the withdrawn automated check:
  // merged, a live verdict and a dead one would be the same value on every
  // screen that reads either.
  //
  // Holds LABELS ONLY - matched/not, a timestamp, who ran it. The lookup itself
  // returns a real person's name, date of birth and photograph, and none of that
  // is written here. Also loosens nothing and freezes nobody: a row without it
  // simply cannot be APPROVED until somebody runs the check.
  `ALTER TABLE kyc_verifications
     ADD COLUMN IF NOT EXISTS nin_slip_check JSONB`,

  // One account, one NIN. Partial so only rows that actually carry a number
  // participate: a plain UNIQUE would let the first NULL through and collide on
  // the second, which is every user who has not used this path.
  `CREATE UNIQUE INDEX IF NOT EXISTS kyc_verifications_nin_slip_number_idx_key
     ON kyc_verifications (nin_slip_number_idx)
   WHERE nin_slip_number_idx IS NOT NULL`,

  // The review queue's only read: pending slips, oldest first.
  `CREATE INDEX IF NOT EXISTS kyc_verifications_nin_slip_queue_idx
     ON kyc_verifications (nin_slip_status, nin_slip_submitted_at)`,

  // Revocation. An admin can take verification back off a verified user - a
  // forged slip, a fraud report that lands a week later. The revoke writes the
  // status column itself back to 'revoked', which fails rowIsVerified with no
  // special case; these columns only record who and why. Separate from
  // decline_reason on purpose: a decline is "never let in", a revoke is "taken
  // back", and one must not overwrite the record of the other.
  `ALTER TABLE kyc_verifications
     ADD COLUMN IF NOT EXISTS revoked_at    TIMESTAMP(3),
     ADD COLUMN IF NOT EXISTS revoked_by    TEXT,
     ADD COLUMN IF NOT EXISTS revoke_reason TEXT`,

  // ------------------------------ CURRENT: THE BVN BECOMES A LOOKUP, PAID ---
  // 2026-08-25. The BVN check moved from Payvessel to ArewaSmart, and that is
  // not a swap of one client for another - it changes what the table holds.
  //
  //   Payvessel was a MATCH api. The customer typed six identity fields, we sent
  //   them with the BVN, and it graded them. These columns held the CUSTOMER'S
  //   TRANSCRIPTION of their own document, which is why they could be NOT NULL:
  //   a form that refused to submit half-filled was the thing enforcing it.
  //
  //   ArewaSmart is a LOOKUP api. We send the BVN alone and it returns the
  //   register's record, so these columns now hold WHAT THE REGISTER SAID. There
  //   is no form behind them any more, and nothing to make the register answer a
  //   question it has no answer to.
  //
  // The BVN register carries a date of birth, a gender and a phone for
  // effectively everybody - but "effectively" is not "always", and the cost of
  // being wrong here is specific and bad: the customer has ALREADY BEEN CHARGED
  // ₦60 by the time we write this row, because the fee is owed on any completed
  // lookup. A NOT NULL violation at that point means we took their money, got a
  // valid answer from the register, and threw it away on a 500.
  //
  // So the five columns are relaxed. A null means "the register did not tell
  // us", never "not checked" - the verdict lives in `status`, and it always did.
  //
  // LOOSENING ONLY. Every existing row already has a value in all five, no row
  // changes, and nothing that reads them starts failing: kyc.controller's
  // identityFromRow() already treated a missing field as "ask the user", and
  // adminKyc reads every one of them through `reveal(x) || null`.
  //
  // Re-runnable: DROP NOT NULL on a column that is already nullable is a no-op.
  `ALTER TABLE kyc_verifications ALTER COLUMN first_name_enc DROP NOT NULL`,
  `ALTER TABLE kyc_verifications ALTER COLUMN last_name_enc  DROP NOT NULL`,
  `ALTER TABLE kyc_verifications ALTER COLUMN phone_enc      DROP NOT NULL`,
  `ALTER TABLE kyc_verifications ALTER COLUMN dob_enc        DROP NOT NULL`,
  `ALTER TABLE kyc_verifications ALTER COLUMN gender         DROP NOT NULL`,

  // No other DDL is needed for the provider change, and that is deliberate
  // rather than an oversight:
  //
  //   - `bvn_match` stays a jsonb column and keeps its name. What goes IN it
  //     changed completely - provider labels became counts, booleans and a
  //     reference, because a lookup api's response is the person and must never
  //     be stored raw - but that is a controller rule, not a schema one. Old
  //     rows still hold Payvessel's labels and are still readable; do not write
  //     code that assumes one shape without checking `provider`.
  //   - the ₦60 fee needs no column here. It is a wallet debit, so it lives
  //     where every other debit lives - a `wallet_transactions` row with
  //     `remark = 'kyc_bvn_verification'` - and the KYC row carries only the
  //     copy of the amount that was charged, inside `bvn_match.fee`. A second
  //     source of truth for money is a second thing to reconcile.
  //   - the fee is charged OUTSIDE the KYC gate on purpose. kycGate freezes a
  //     wallet at the unverified funding limit; if that guard sat in front of
  //     this debit a frozen user could never pay to thaw. `requireKyc` is
  //     route-level middleware and is deliberately absent from kyc.routes.js.
  // ---------------------------------------------------------------------
];

(async () => {
  const client = new Client({ connectionString: process.env.DIRECT_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  await client.query('BEGIN');
  try {
    for (const sql of STATEMENTS) {
      await client.query(sql);
      console.log(`ok    ${sql.split('\n')[0].trim()}`);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }

  await client.end();
  console.log('done - now run: npx prisma generate');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
