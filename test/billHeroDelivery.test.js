/**
 * node test/billHeroDelivery.test.js
 *
 * Bill Hero reward delivery, finished with nobody involved. No network, no
 * Redis, no Postgres: a fake database, a stubbed provider and a pinned clock.
 *
 * The case this exists for: a reward the provider accepts as `pending` and
 * fails later. The webhook that would report it cannot be configured, and the
 * claim window is Saturday only - so a failure noticed late used to leave the
 * reward reading "Delivered" in the app, never arriving, with no way to claim
 * it again. Now:
 *
 *   1. an accepted reward stays "Processing" until confirmed, never
 *      "Delivered" on the provider's say-so;
 *   2. the sweep confirms it, or re-sends it on a fresh reference with backoff;
 *   3. when every send fails, it is handed back - claimable again for three
 *      days whatever the calendar says - and the customer is told;
 *   4. no path can send one reward twice at once.
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.NODE_ENV = 'test';

/* ------------------------------------------------------------ pinned clock */

// 2026-10-10 is a Saturday; 11:00Z is midday in Lagos, inside the claim window.
const SATURDAY_NOON = Date.UTC(2026, 9, 10, 11, 0, 0);
const MONDAY_NOON = Date.UTC(2026, 9, 12, 11, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

const RealDate = Date;
let clock = SATURDAY_NOON;
global.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [clock]));
  }
  static now() {
    return clock;
  }
};
const advance = ms => {
  clock += ms;
};

/* ---------------------------------------------------------- fake database */

const db = { claims: [], nextId: 1 };
let lastWrite = 0;

const clone = v => (v == null ? null : JSON.parse(JSON.stringify(v)));
// Rows come back with real Date objects, as Prisma returns them.
const row = r => (r ? { ...clone(r), updated_at: new Date(r.updated_at), claimed_at: new Date(r.claimed_at) } : null);
// Strictly increasing, so a stale read can never match a newer write.
const stamp = () => {
  lastWrite = Math.max(clock, lastWrite + 1);
  return lastWrite;
};
const P2002 = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

function matches(r, where = {}) {
  for (const [key, cond] of Object.entries(where)) {
    const value = r[key];
    if (key === 'updated_at') {
      if (cond && typeof cond === 'object' && 'gt' in cond) {
        if (!(value > new RealDate(cond.gt).getTime())) return false;
        continue;
      }
      if (new RealDate(cond).getTime() !== value) return false;
      continue;
    }
    if (key === 'provider_payload') {
      const got = cond.path.reduce((o, p) => (o == null ? undefined : o[p]), value);
      if (got !== cond.equals) return false;
      continue;
    }
    if (cond && typeof cond === 'object' && 'in' in cond) {
      if (!cond.in.includes(value)) return false;
      continue;
    }
    if ((value ?? null) !== (cond ?? null)) return false;
  }
  return true;
}

function apply(r, data) {
  Object.assign(r, clone(data), { updated_at: stamp() });
  if (data.claimed_at) r.claimed_at = new RealDate(data.claimed_at).getTime();
}

const fakePrisma = {
  billHeroClaim: {
    async findMany({ where, take } = {}) {
      return db.claims.filter(r => matches(r, where)).slice(0, take || 100).map(row);
    },
    async findFirst({ where } = {}) {
      return row(db.claims.find(r => matches(r, where)));
    },
    async create({ data }) {
      if (db.claims.some(r => r.user_id === data.user_id && r.week_key === data.week_key && r.challenge_id === data.challenge_id)) {
        throw P2002();
      }
      const r = { id: db.nextId++, created_at: clock, ...clone(data), updated_at: stamp() };
      r.claimed_at = new RealDate(data.claimed_at || clock).getTime();
      db.claims.push(r);
      return row(r);
    },
    async update({ where, data }) {
      const r = db.claims.find(c => c.id === where.id);
      apply(r, data);
      return row(r);
    },
    async updateMany({ where, data }) {
      const hits = db.claims.filter(r => matches(r, where));
      hits.forEach(r => apply(r, data));
      return { count: hits.length };
    },
  },
  user: {
    async findUnique() {
      return { id: 7, pin: 'hashed' };
    },
  },
  walletTransaction: {
    // Ten qualifying airtime recharges this week, so the challenge is complete.
    async findMany({ where }) {
      if (where.trx_type === '+') return [];
      return Array.from({ length: 10 }, (_, i) => ({ user_id: 7, trx: `air_${i}`, meta: { type: 'airtime' }, created_at: new RealDate(clock) }));
    },
  },
};

/* ------------------------------------------------------------ module stubs */

function stub(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const spy = { notes: [], alerts: [], sends: [] };

// What the provider answers next, per call. An Error is thrown.
const provider = { send: [], status: {} };

const adapter = {
  async buyAirtime({ number, amount, reference }) {
    spy.sends.push({ kind: 'airtime', number, amount, reference });
    const next = provider.send.length ? provider.send.shift() : { status: 'success' };
    if (next instanceof Error) throw next;
    return { ...next, 'request-id': reference };
  },
  async buyData({ planId, number, reference }) {
    spy.sends.push({ kind: 'data', planId, number, reference });
    const next = provider.send.length ? provider.send.shift() : { status: 'success' };
    if (next instanceof Error) throw next;
    return { ...next, 'request-id': reference };
  },
  async listDataPlansCached() {
    return [{ id: '19', name: '500MB (SME)', amount: 150 }];
  },
  parseVendResult(json) {
    return { reference: json['request-id'], status: json.status === 'success' ? 'successful' : 'processing', amount: 0 };
  },
  async getTransactionStatus(ref) {
    const answer = provider.status[ref];
    if (answer instanceof Error) throw answer;
    return { status: answer || 'processing', reference_code: ref };
  },
};

stub('../database/prisma', fakePrisma);
stub('../src/funding/billsProvider', {
  ADAPTERS: { mysubwallet: adapter },
  resolve: async () => ({ name: 'mysubwallet', provider: adapter }),
  adapterFor: () => adapter,
});
stub('../src/services/notify.service', {
  notifyUser: async note => {
    spy.notes.push(note);
    return true;
  },
});
stub('../src/services/alerts.service', { paymentFailure: p => spy.alerts.push(p) });
stub('../src/helpers/pii.helper', {
  verifySecret: async () => ({ ok: true }),
  revealUserFields: u => u,
  encryptValue: v => `enc:${v}`,
  decryptValue: v => String(v).replace(/^enc:/, ''),
});
stub('../src/helpers/billHeroAvailability.helper', {
  getConfig: async () => ({}),
  evaluate: () => ({ open: true, message: '' }),
  openAt: () => true,
  publicAvailability: () => ({ open: true }),
  requireBillHeroOpen: () => (req, res, next) => next(),
});

let challengeRewardValue = 200;
stub('../src/helpers/billHeroChallenge.helper', {
  listChallenges: async () => [
    { id: 1, action_type: 'airtime', reward_type: 'airtime', reward_value: challengeRewardValue, target: 10 },
  ],
  isRunning: () => true,
  progressFor: () => ({}),
  isCompleted: () => true,
  publicChallenge: c => ({ id: c.id }),
  rewardLabel: c => (c?.reward_type === 'airtime' ? `₦${Number(c?.reward_value) || 0} airtime` : `${c?.reward_value}MB data`),
});

const billHero = require('../src/controllers/billHero.controller');
const { nextDeliveryState, REWARD_DELIVERY: R } = billHero;

/* ---------------------------------------------------------------- helpers */

function respond(handler, req) {
  return new Promise(resolve => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body });
      },
    };
    handler(req, res);
  });
}

function reset() {
  db.claims = [];
  db.nextId = 1;
  // The write clock rewinds with the wall clock, or rows written after a reset
  // would be stamped in the future and read as too fresh to ask about.
  lastWrite = 0;
  spy.notes = [];
  spy.alerts = [];
  spy.sends = [];
  provider.send = [];
  provider.status = {};
  clock = SATURDAY_NOON;
}

const claimReq = (phone = '08031234567') => ({
  user: { id: 7 },
  body: { challenge_id: 1, phone, network: 'MTN', pin: '1234' },
  billHero: { config: {} },
});
const claimIt = phone => respond(billHero.claim, claimReq(phone));
const me = () => respond(billHero.me, { user: { id: 7 } });
const only = () => db.claims[0];
const payload = () => only().provider_payload;
const sweep = () => billHero.settleRewardDeliveries({ now: new Date() });
const ambiguous = () => Object.assign(new Error('This service is briefly unavailable. Please try again shortly.'), { statusCode: 504, ambiguous: true });
const refused = () => Object.assign(new Error('That phone number was not accepted for this network.'), { statusCode: 400, kind: 'input' });

(async () => {
  /* ======================================================= state machine */

  {
    const at = new Date();
    const base = { provider_ref: 'bh_1', provider_payload: { delivery: 'pending', attempts: 1, reference: 'bh_1' } };

    const delivered = nextDeliveryState(base, 'delivered', { now: at });
    assert.strictEqual(delivered.status, 'claimed', 'only a confirmed reward reads "Delivered"');
    assert.strictEqual(delivered.provider_payload.delivery, 'delivered');

    const pending = nextDeliveryState(base, 'pending', { now: at });
    assert.strictEqual(pending.status, 'processing', 'accepted is not delivered');

    // Backoff by the send that just failed: 5 minutes, 30 minutes, 2 hours.
    const delays = [1, 2, 3].map(attempts => {
      const next = nextDeliveryState({ ...base, provider_payload: { ...base.provider_payload, attempts } }, 'failed', { now: at });
      assert.strictEqual(next.status, 'processing');
      assert.strictEqual(next.provider_payload.delivery, 'retrying');
      return new RealDate(next.provider_payload.next_attempt_at).getTime() - at.getTime();
    });
    assert.deepStrictEqual(delays, R.RETRY_DELAYS_MS);

    // The last send failing hands the reward back, claimable for three days.
    const last = nextDeliveryState({ ...base, provider_payload: { ...base.provider_payload, attempts: R.MAX_ATTEMPTS } }, 'failed', { now: at });
    assert.strictEqual(last.status, 'failed');
    assert.strictEqual(last.provider_payload.delivery, 'undeliverable');
    assert.strictEqual(new RealDate(last.provider_payload.reclaim_until).getTime() - at.getTime(), R.RECLAIM_GRACE_MS);
    assert.strictEqual(last.provider_payload.history.length, 1, 'each failed send is on record');

    assert.strictEqual(nextDeliveryState(base, 'lost', { now: at, final: true }).provider_payload.delivery, 'undeliverable');
  }

  /* ============================================================= claiming */

  // Delivered on the spot: "Delivered" straight away.
  reset();
  provider.send = [{ status: 'success' }];
  let out = await claimIt();
  assert.strictEqual(out.body.status, 'success');
  assert.strictEqual(out.body.message[0], 'Reward claimed successfully');
  assert.strictEqual(only().status, 'claimed');
  assert.strictEqual(payload().delivery, 'delivered');
  assert.strictEqual(spy.sends[0].number, '08031234567');

  // Accepted, not confirmed: "Processing" until the sweep knows - the bug this
  // fixes showed "Delivered" here and never looked again.
  reset();
  provider.send = [{ status: 'pending' }];
  out = await claimIt();
  assert.strictEqual(out.body.status, 'success');
  assert.ok(/on its way/.test(out.body.message[0]));
  assert.strictEqual(only().status, 'processing');
  assert.strictEqual(payload().delivery, 'pending');
  assert.ok(only().provider_ref.startsWith('bh_airtime_'), 'the reference was minted before the send');

  // The answer was lost even after the provider module asked: left as a send
  // in flight under its reference, for the sweep to finish.
  reset();
  provider.send = [ambiguous()];
  out = await claimIt();
  assert.strictEqual(out.body.status, 'success', 'not an error the customer has to act on');
  assert.ok(/being processed/.test(out.body.message[0]));
  assert.strictEqual(only().status, 'processing');
  assert.strictEqual(payload().delivery, 'sending');

  // Refused outright: the customer sees why, and can claim again now.
  reset();
  provider.send = [refused()];
  out = await claimIt();
  assert.strictEqual(out.status, 400);
  assert.strictEqual(only().status, 'failed');
  assert.strictEqual(payload().delivery, 'refused');
  assert.strictEqual(JSON.stringify(payload()).includes('0803'), false, 'no phone number in the stored failure');

  // Two taps: the second never sends.
  reset();
  provider.send = [{ status: 'pending' }];
  await claimIt();
  out = await claimIt();
  assert.strictEqual(out.body.remark, 'processing');
  assert.strictEqual(spy.sends.length, 1);

  /* ======================================================== the sweep */

  // Accepted, then confirmed.
  reset();
  provider.send = [{ status: 'pending' }];
  await claimIt();
  provider.status[only().provider_ref] = 'successful';
  advance(2 * MIN);
  let tally = await sweep();
  assert.strictEqual(tally.delivered, 1);
  assert.strictEqual(only().status, 'claimed', 'now, and only now, "Delivered"');

  // Accepted, then failed: re-sent automatically on a fresh reference, after
  // the backoff - and confirmed on the second try.
  reset();
  provider.send = [{ status: 'pending' }];
  await claimIt();
  const firstRef = only().provider_ref;
  provider.status[firstRef] = 'failed';
  advance(2 * MIN);
  await sweep();
  assert.strictEqual(only().status, 'processing', 'still the customer\'s reward, not a failure');
  assert.strictEqual(payload().delivery, 'retrying');
  assert.strictEqual(spy.sends.length, 1, 'not re-sent before its backoff');

  advance(R.RETRY_DELAYS_MS[0]);
  provider.send = [{ status: 'pending' }];
  tally = await sweep();
  assert.strictEqual(tally.resent, 1);
  assert.strictEqual(spy.sends.length, 2);
  assert.notStrictEqual(only().provider_ref, firstRef, 'a re-send is a new purchase under a new reference');
  assert.strictEqual(payload().attempts, 2);
  assert.strictEqual(spy.sends[1].number, '08031234567', 'to the same number');

  provider.status[only().provider_ref] = 'successful';
  advance(2 * MIN);
  await sweep();
  assert.strictEqual(only().status, 'claimed');
  assert.strictEqual(payload().history.length, 1, 'the failed first send stays on record');
  assert.strictEqual(spy.notes.length, 0, 'a reward that arrived needs no apology');

  // Every send fails: handed back, claimable again, and the customer is told.
  reset();
  provider.send = [{ status: 'pending' }];
  await claimIt();
  provider.status[only().provider_ref] = 'failed';
  advance(2 * MIN);
  await sweep();
  for (const delay of R.RETRY_DELAYS_MS) {
    advance(delay);
    provider.send = [refused()];
    await sweep();
  }
  assert.strictEqual(spy.sends.length, R.MAX_ATTEMPTS, 'the claim plus three re-sends, and no more');
  assert.strictEqual(only().status, 'failed');
  assert.strictEqual(payload().delivery, 'undeliverable');
  assert.strictEqual(spy.notes.length, 1, 'the customer is told');
  assert.ok(/claim it again/.test(spy.notes[0].message));
  assert.ok(spy.notes[0].message.includes('0803***4567'), 'the number is masked');
  assert.strictEqual(spy.notes[0].message.includes('08031234567'), false);
  assert.ok(spy.alerts.some(a => a.action === 'reward_undeliverable'), 'and so are we');

  // ...and it stays claimable after the Saturday window has shut.
  clock = MONDAY_NOON;
  let mine = await me();
  assert.strictEqual(mine.body.data.challenges[0].claimable, true, 'claimable on Monday, outside the window');

  challengeRewardValue = 500;
  provider.send = [{ status: 'success' }];
  out = await claimIt('08051112222');
  assert.strictEqual(out.body.status, 'success', 'claimed again on Monday with another number');
  assert.strictEqual(only().status, 'claimed');
  assert.strictEqual(spy.sends.at(-1).number, '08051112222');
  assert.strictEqual(spy.sends.at(-1).amount, 200, 'at the value it was earned at, not the challenge\'s new one');
  assert.strictEqual(payload().attempts, 1, 'a fresh round of sends for the new number');
  challengeRewardValue = 200;

  // Past the grace, Monday is just Monday.
  reset();
  db.claims.push({
    id: 1, user_id: 7, challenge_id: 1, week_key: '2026-W41', reward_type: 'airtime', reward_value: 200,
    phone_enc: 'enc:08031234567', network: 'MTN', status: 'failed', provider: 'mysubwallet', provider_ref: 'bh_old',
    provider_payload: { delivery: 'undeliverable', reclaim_until: new RealDate(MONDAY_NOON - HOUR).toISOString() },
    created_at: SATURDAY_NOON, claimed_at: SATURDAY_NOON, updated_at: SATURDAY_NOON,
  });
  clock = MONDAY_NOON;
  mine = await me();
  assert.strictEqual(mine.body.data.challenges[0].claimable, false);
  out = await claimIt();
  assert.strictEqual(out.body.remark, 'not_claim_time');

  // A send cut off mid-request, then unknown to the provider: it never landed,
  // so it is sent again - but only once it has been quiet long enough.
  reset();
  provider.send = [ambiguous()];
  await claimIt();
  provider.status[only().provider_ref] = 'not_found';
  advance(R.SEND_STALE_MS - MIN);
  assert.strictEqual((await sweep()).checked, 1);
  assert.strictEqual(payload().delivery, 'sending', 'not touched while its own request may still be running');
  advance(2 * MIN);
  await sweep();
  assert.strictEqual(payload().delivery, 'retrying', 'lost, so re-sent - it cannot double');

  // ...or a cut-off send the provider did accept.
  reset();
  provider.send = [ambiguous()];
  await claimIt();
  provider.status[only().provider_ref] = 'processing';
  advance(R.SEND_STALE_MS + MIN);
  await sweep();
  assert.strictEqual(payload().delivery, 'pending');

  // Accepted and unresolved for an hour: said out loud. For a day: handed back.
  reset();
  provider.send = [{ status: 'pending' }];
  await claimIt();
  advance(HOUR + MIN);
  tally = await sweep();
  assert.strictEqual(tally.stuck, 1);
  assert.ok(spy.alerts.some(a => a.action === 'reward_stuck'));
  advance(R.UNRESOLVED_HANDBACK_MS);
  await sweep();
  assert.strictEqual(only().status, 'failed');
  assert.strictEqual(payload().delivery, 'undeliverable');
  assert.strictEqual(spy.notes.length, 1);

  // The provider is down while we ask: nothing changes, it is asked again.
  reset();
  provider.send = [{ status: 'pending' }];
  await claimIt();
  provider.status[only().provider_ref] = new Error('down');
  advance(2 * MIN);
  await sweep();
  assert.strictEqual(payload().delivery, 'pending');

  // Two sweeps racing on one due re-send - two instances, the same pass: one
  // sends, the other finds the row already moved and stands down.
  reset();
  provider.send = [{ status: 'pending' }];
  await claimIt();
  provider.status[only().provider_ref] = 'failed';
  advance(2 * MIN);
  await sweep();
  advance(R.RETRY_DELAYS_MS[0]);
  const [stale] = await fakePrisma.billHeroClaim.findMany({});
  provider.send = [{ status: 'pending' }, { status: 'pending' }];
  const outcomes = await Promise.all([
    billHero.settleRewardDeliveries({ now: new Date() }),
    billHero.settleRewardDeliveries({ now: new Date() }),
  ]);
  assert.strictEqual(spy.sends.length, 2, 'the claim and exactly one re-send');
  assert.strictEqual(outcomes.reduce((n, t) => n + t.resent, 0), 1);
  assert.ok(stale, 'sanity: there was a row to race over');

  /* ===================================== a provider report, if one comes */

  reset();
  provider.send = [{ status: 'pending' }];
  await claimIt();
  let ref = only().provider_ref;
  assert.strictEqual(await billHero.settleRewardFromProvider({ reference: ref, status: 'failed', gateway: 'mysubwallet' }), true);
  assert.strictEqual(only().status, 'processing', 'a reported failure is re-sent, not just reopened');
  assert.strictEqual(payload().delivery, 'retrying');
  assert.strictEqual(
    await billHero.settleRewardFromProvider({ reference: ref, status: 'failed', gateway: 'mysubwallet' }),
    false,
    'a duplicate report about the same failed send changes nothing'
  );

  reset();
  provider.send = [{ status: 'pending' }];
  await claimIt();
  ref = only().provider_ref;
  await billHero.settleRewardFromProvider({ reference: ref, status: 'successful', gateway: 'mysubwallet' });
  assert.strictEqual(only().status, 'claimed');

  console.log('✅ billHero reward delivery tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
