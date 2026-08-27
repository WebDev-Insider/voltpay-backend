// Bill Hero: challenges become rows, and the claim phone number stops being
// plain text.
//
// Two things happen here and the order matters:
//
//   1. `bill_hero_challenges` is created and seeded with the two challenges
//      that were previously constants, so nothing that is already running
//      disappears. Existing claims are then pointed at whichever seeded row
//      matches the reward they paid out.
//   2. `phone` is encrypted into `phone_enc`. That leg cannot be SQL - the key
//      lives in the app - so it is a read/encrypt/write pass in JS between the
//      two DDL phases.
//
// Nothing is dropped until every row has been converted, and the drops are the
// last statements to run. Re-running is a no-op: the adds are IF NOT EXISTS,
// the seed is guarded, and the backfill only touches rows still missing a value.
//
// Prisma CLI cannot reach Neon from this machine (P1001 on IPv6), so the DDL
// goes over pg on DIRECT_URL, same as every other script in here.
require('dotenv').config();
const { Client } = require('pg');
const { encryptValue } = require('../src/helpers/pii.helper');

// The two challenges that used to be constants in billHero.controller.
const SEED = [
  {
    title: 'Airtime Hero',
    description: 'Buy airtime 10 times this week (min ₦100 each)',
    action_type: 'airtime',
    target: 10,
    reward_type: 'airtime',
    reward_value: 200,
    sort_order: 1,
  },
  {
    title: 'Data Hero',
    description: 'Buy data 7 times this week (min ₦100 each)',
    action_type: 'data',
    target: 7,
    reward_type: 'data',
    reward_value: 500,
    sort_order: 2,
  },
];

const PHASE_ONE = [
  `CREATE TABLE IF NOT EXISTS bill_hero_challenges (
     id           serial PRIMARY KEY,
     title        text NOT NULL,
     description  text,
     action_type  text NOT NULL,
     target       integer NOT NULL,
     reward_type  text NOT NULL,
     reward_value integer NOT NULL,
     active       boolean NOT NULL DEFAULT true,
     starts_at    timestamp(3),
     ends_at      timestamp(3),
     sort_order   integer NOT NULL DEFAULT 0,
     created_at   timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at   timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,

  `CREATE INDEX IF NOT EXISTS bill_hero_challenges_active_sort_order_idx
     ON bill_hero_challenges (active, sort_order)`,

  `ALTER TABLE bill_hero_claims ADD COLUMN IF NOT EXISTS challenge_id integer`,
  `ALTER TABLE bill_hero_claims ADD COLUMN IF NOT EXISTS reward_value integer`,
  `ALTER TABLE bill_hero_claims ADD COLUMN IF NOT EXISTS phone_enc text`,

  // The old column has to stop being mandatory before the new code, which never
  // writes it, is allowed to insert.
  `ALTER TABLE bill_hero_claims ALTER COLUMN phone DROP NOT NULL`,
];

// Run once the seed exists: every historic claim gets the challenge whose
// reward it matches, and the value it was worth at the time.
const BACKFILL_SQL = [
  `UPDATE bill_hero_claims c
      SET challenge_id = ch.id
     FROM bill_hero_challenges ch
    WHERE c.challenge_id IS NULL
      AND ch.action_type = c.reward_type
      AND ch.id = (SELECT MIN(id) FROM bill_hero_challenges WHERE action_type = c.reward_type)`,

  `UPDATE bill_hero_claims
      SET reward_value = CASE WHEN reward_type = 'airtime' THEN 200 ELSE 500 END
    WHERE reward_value IS NULL`,
];

const PHASE_TWO = [
  // Only safe now that every row has one. If any is still null this fails and
  // takes the transaction with it, which is the correct loud outcome.
  `ALTER TABLE bill_hero_claims ALTER COLUMN challenge_id SET NOT NULL`,
  `ALTER TABLE bill_hero_claims ALTER COLUMN reward_value SET NOT NULL`,
  `ALTER TABLE bill_hero_claims ALTER COLUMN phone_enc SET NOT NULL`,

  `ALTER TABLE bill_hero_claims
     ADD CONSTRAINT bill_hero_claims_challenge_id_fkey
     FOREIGN KEY (challenge_id) REFERENCES bill_hero_challenges (id) ON DELETE RESTRICT`,

  // One reward per user per challenge per week. The old key was on reward_type,
  // which two challenges paying the same rail would have collided on.
  `DROP INDEX IF EXISTS bill_hero_claims_user_id_week_key_reward_type_key`,
  `CREATE UNIQUE INDEX IF NOT EXISTS bill_hero_claims_user_id_week_key_challenge_id_key
     ON bill_hero_claims (user_id, week_key, challenge_id)`,
  `CREATE INDEX IF NOT EXISTS bill_hero_claims_challenge_id_status_idx
     ON bill_hero_claims (challenge_id, status)`,

  // Last statement in the whole script: the plain-text column goes.
  `ALTER TABLE bill_hero_claims DROP COLUMN IF EXISTS phone`,
];

async function run(client, statements) {
  for (const sql of statements) {
    await client.query(sql);
    console.log(`ok    ${sql.split('\n')[0].trim()}`);
  }
}

async function seedChallenges(client) {
  const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM bill_hero_challenges');
  if (rows[0].n > 0) {
    console.log(`skip  seed - ${rows[0].n} challenge(s) already exist`);

    return;
  }

  for (const c of SEED) {
    await client.query(
      `INSERT INTO bill_hero_challenges
         (title, description, action_type, target, reward_type, reward_value, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [c.title, c.description, c.action_type, c.target, c.reward_type, c.reward_value, c.sort_order],
    );
    console.log(`ok    seeded ${c.title}`);
  }
}

/**
 * Encrypt every claim phone that has not been converted yet.
 *
 * One row at a time rather than a batch: there are not many, and a partial
 * failure that leaves half the table converted is fine here - the WHERE clause
 * means a re-run picks up exactly where it stopped.
 */
async function encryptPhones(client) {
  const { rows: exists } = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'bill_hero_claims' AND column_name = 'phone'`,
  );

  if (!exists.length) {
    console.log('skip  phone already dropped');

    return;
  }

  const { rows } = await client.query(
    `SELECT id, phone FROM bill_hero_claims WHERE phone_enc IS NULL AND phone IS NOT NULL`,
  );

  for (const row of rows) {
    await client.query('UPDATE bill_hero_claims SET phone_enc = $1 WHERE id = $2', [
      encryptValue(String(row.phone)),
      row.id,
    ]);
  }

  console.log(`ok    encrypted ${rows.length} claim phone(s)`);

  // A row with neither is a claim that never captured a number. Give it an
  // empty ciphertext rather than blocking the NOT NULL below.
  const { rowCount } = await client.query(
    `SELECT id FROM bill_hero_claims WHERE phone_enc IS NULL`,
  );

  if (rowCount) {
    await client.query('UPDATE bill_hero_claims SET phone_enc = $1 WHERE phone_enc IS NULL', [
      encryptValue(''),
    ]);
    console.log(`ok    filled ${rowCount} claim(s) that had no phone at all`);
  }
}

(async () => {
  const client = new Client({ connectionString: process.env.DIRECT_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  await client.query('BEGIN');
  try {
    await run(client, PHASE_ONE);
    await seedChallenges(client);
    await run(client, BACKFILL_SQL);
    await encryptPhones(client);

    // Adding the same constraint twice is an error rather than a no-op, so it
    // is skipped when it is already there instead of guarding with IF NOT
    // EXISTS, which Postgres does not accept for ADD CONSTRAINT.
    const { rows: fk } = await client.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'bill_hero_claims_challenge_id_fkey'`,
    );

    await run(client, fk.length ? PHASE_TWO.filter(s => !s.includes('ADD CONSTRAINT')) : PHASE_TWO);

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }

  await client.end();
  console.log('done');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
