/**
 * Clearing the "Recent failures" card on Bills / VTU.
 *
 * The rule that must not break: a clear is a MARK, never a delete. The alert
 * rows are admin_audit_log rows - the audit trail - and for an outbound rail
 * (airtime, data, bills) they are the only record a failure leaves. Each case
 * below pins one way a "clear" could quietly become a lost record or a hidden
 * failure:
 *
 *   1. nothing in admin_audit_log is deleted or updated;
 *   2. the mark is the id the admin had on screen, so a failure that landed
 *      while they were reading survives the clear;
 *   3. an id that is not an alert row is refused - a mark past the sequence
 *      would hide every future failure the moment it arrived;
 *   4. the mark only moves forward;
 *   5. an unreadable mark shows everything, and a clear refuses to guess;
 *   6. "Show cleared" ignores the mark, and the funding side never reads it;
 *   7. the audit trail records how far the feed was cleared.
 *
 * Prisma is faked in front of the service and the controller.
 */
const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);

// --- state ----------------------------------------------------------------
const state = {};

function alertRow(id, provider, minutesAgo) {
  return {
    id,
    actor: 'system',
    action: `alert.${provider}.vend`,
    target_type: 'alert',
    target_id: '7',
    ip: null,
    metadata: { severity: 'error', message: 'Vend failed', provider },
    created_at: new Date(Date.now() - minutesAgo * 60_000),
  };
}

function resetState() {
  state.audit = [
    alertRow(10, 'mysubwallet', 300),
    alertRow(11, 'mysubwallet', 120),
    alertRow(12, 'payvessel', 60),
    // The other feed in the same table. A clear must never count or hide it.
    {
      id: 13,
      actor: 'system',
      action: 'security.velocity.limit',
      target_type: 'security',
      target_id: '9',
      ip: null,
      metadata: { severity: 'warning', message: 'Velocity limit' },
      created_at: new Date(Date.now() - 30 * 60_000),
    },
    alertRow(14, 'mysubwallet', 5),
  ];
  state.funding = [];
  state.settings = new Map();
  state.settingsReadFails = false;
  state.auditWrites = [];
  state.upserts = [];
}

// --- fakes, installed before the modules are loaded ------------------------
function compare(value, cond) {
  if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
    if ('gt' in cond && !(value > cond.gt)) return false;
    if ('gte' in cond && !(value >= cond.gte)) return false;
    if ('lt' in cond && !(value < cond.lt)) return false;
    if ('lte' in cond && !(value <= cond.lte)) return false;
    if ('startsWith' in cond && !String(value).startsWith(cond.startsWith)) return false;
    return true;
  }
  return value === cond;
}

const matches = (row, where = {}) => Object.entries(where).every(([key, cond]) => compare(row[key], cond));

function sorted(rows, orderBy) {
  const [field, dir] = Object.entries(orderBy || { id: 'asc' })[0];
  return [...rows].sort((a, b) => (a[field] > b[field] ? 1 : a[field] < b[field] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
}

// Every mutating call is recorded, so "nothing was deleted" is an assertion
// rather than an assumption.
const refuseWrite = name => async args => {
  state.auditWrites.push({ name, args });
  return { count: 0 };
};

const adminAuditLog = {
  findFirst: async ({ where, orderBy } = {}) => sorted(state.audit.filter(r => matches(r, where)), orderBy)[0] || null,
  findMany: async ({ where, orderBy, skip = 0, take } = {}) => {
    const rows = sorted(state.audit.filter(r => matches(r, where)), orderBy);
    return rows.slice(skip, take ? skip + take : undefined);
  },
  count: async ({ where } = {}) => state.audit.filter(r => matches(r, where)).length,
  groupBy: async ({ where } = {}) => {
    const counts = new Map();
    for (const r of state.audit.filter(row => matches(row, where))) counts.set(r.action, (counts.get(r.action) || 0) + 1);
    return [...counts].map(([action, n]) => ({ action, _count: { _all: n } }));
  },
  create: refuseWrite('create'),
  update: refuseWrite('update'),
  updateMany: refuseWrite('updateMany'),
  delete: refuseWrite('delete'),
  deleteMany: refuseWrite('deleteMany'),
};

const appSetting = {
  findUnique: async ({ where }) => {
    if (state.settingsReadFails) throw new Error('connection reset');
    return state.settings.has(where.setting_key)
      ? { setting_key: where.setting_key, setting_value: state.settings.get(where.setting_key) }
      : null;
  },
  upsert: async ({ where, update, create }) => {
    state.upserts.push({ where, update, create });
    const value = state.settings.has(where.setting_key) ? update.setting_value : create.setting_value;
    state.settings.set(where.setting_key, value);
    return { setting_key: where.setting_key, setting_value: value };
  },
};

const fundingTransaction = {
  findMany: async () => state.funding.map(r => ({ ...r })),
};

const models = { adminAuditLog, appSetting, fundingTransaction };
const noop = async () => null;

const fakePrisma = new Proxy(
  { $transaction: async fn => fn(fakePrisma) },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop in models) return models[prop];
      if (typeof prop !== 'string' || prop.startsWith('$')) return undefined;
      return new Proxy({}, { get: () => noop });
    },
  },
);

function stub(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stub('../database/prisma', fakePrisma);

const events = require('../src/services/securityEvents.service');
const ops = require('../src/controllers/adminOps.controller');
const adminAudit = require('../src/middlewares/adminAudit.middleware');
const adminRoutes = require('../src/routes/admin.routes');

const { afterIdWhere, parseClearMark, ALERT_CLEAR_KEY } = events.__test;

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function call(handler, { query = {}, body = {}, admin = { name: 'ops-ada', role: 'support' } } = {}) {
  const res = fakeRes();
  await handler({ query, body, admin, originalUrl: '/api/admin/providers/failures/clear' }, res);
  return res;
}

const ids = res => res.body.data.recent_failures.map(f => f.id);
const railsOf = res => Object.fromEntries(res.body.data.providers.map(p => [p.provider, p]));

(async () => {
  // --- the filters ------------------------------------------------------------
  // A missing or nonsense mark must filter nothing: a feed that cannot tell
  // where it was cleared shows everything.
  for (const nothing of [null, undefined, '', 0, -4, 'abc', 1.5]) {
    assert.deepStrictEqual(afterIdWhere(nothing), {}, `afterIdWhere(${JSON.stringify(nothing)}) must filter nothing`);
  }
  assert.deepStrictEqual(afterIdWhere(12), { id: { gt: 12 } });
  assert.deepStrictEqual(afterIdWhere('12'), { id: { gt: 12 } });

  assert.strictEqual(parseClearMark(null), null);
  assert.strictEqual(parseClearMark('{broken'), null);
  assert.strictEqual(parseClearMark('{"through_id":"x"}'), null);
  assert.strictEqual(parseClearMark('{"through_id":0}'), null);
  assert.deepStrictEqual(
    parseClearMark('{"through_id":12,"cleared_at":"2026-10-20T10:00:00.000Z","cleared_by":"ops-ada"}'),
    { through_id: 12, cleared_at: '2026-10-20T10:00:00.000Z', cleared_by: 'ops-ada' },
  );

  // --- before any clear, the whole alert feed shows ----------------------------
  resetState();
  {
    const res = await call(ops.getProviderHealth, { query: { hours: '24' } });

    assert.strictEqual(res.body.status, 'success');
    assert.strictEqual(res.body.data.cleared, null);
    assert.strictEqual(res.body.data.include_cleared, false);
    assert.deepStrictEqual(ids(res), [14, 12, 11, 10], 'the security row is a different feed');
    assert.strictEqual(res.body.data.total_failures, 4);
  }

  // --- cases 1 + 2: clear through what the admin saw ---------------------------
  // The page rendered up to #12; #14 landed while they were reading the card.
  resetState();
  {
    const res = await call(ops.clearProviderFailures, { body: { through_id: 12 } });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.status, 'success');
    assert.strictEqual(res.body.data.through_id, 12);
    assert.strictEqual(res.body.data.cleared, 3, 'alerts 10, 11 and 12 - never the security row');
    assert.strictEqual(res.body.data.cleared_by, 'ops-ada');
    assert.ok(res.body.data.cleared_at, 'the mark says when');

    assert.deepStrictEqual(state.auditWrites, [], 'a clear must not write to, update or delete from admin_audit_log');
    assert.strictEqual(state.audit.length, 5, 'every row is still there');

    const after = await call(ops.getProviderHealth, { query: { hours: '24' } });

    assert.deepStrictEqual(ids(after), [14], 'a failure that arrived after the page loaded survives the clear');
    assert.strictEqual(after.body.data.total_failures, 1);
    assert.strictEqual(after.body.data.cleared.through_id, 12);
    assert.strictEqual(after.body.data.cleared.cleared_by, 'ops-ada');

    const rails = railsOf(after);
    assert.strictEqual(rails.mysubwallet.failures, 1, 'rail counts start from the clear too');
    assert.ok(!rails.payvessel, 'a rail whose only failures were cleared drops off the table');

    // Case 6: "Show cleared" is the whole feed, as if nobody had cleared it.
    const all = await call(ops.getProviderHealth, { query: { hours: '24', include_cleared: '1' } });

    assert.deepStrictEqual(ids(all), [14, 12, 11, 10]);
    assert.strictEqual(all.body.data.total_failures, 4);
    assert.strictEqual(all.body.data.include_cleared, true);
    assert.strictEqual(all.body.data.cleared.through_id, 12, 'the mark is still reported, so the page can say who cleared');
    assert.strictEqual(railsOf(all).payvessel.failures, 1);
  }

  // --- case 6: the funding side never reads the mark ----------------------------
  // A stuck credit is a work queue. Clearing an alert must not hide one.
  resetState();
  state.funding = [
    { tx_ref: 'pp_stuck_1', status: 'pending', amount: '5000', credited_at: null, created_at: new Date(Date.now() - 30 * 60_000) },
  ];
  {
    const before = railsOf(await call(ops.getProviderHealth, { query: {} }));
    await call(ops.clearProviderFailures, { body: { through_id: 14 } });
    const after = railsOf(await call(ops.getProviderHealth, { query: {} }));

    assert.strictEqual(before.paymentpoint.inbound_stuck, 1);
    assert.strictEqual(after.paymentpoint.inbound_stuck, 1, 'a clear must never touch the awaiting-credit count');
    assert.strictEqual(after.paymentpoint.inbound_total, 1);
  }

  // --- case 4: forward only ----------------------------------------------------
  // Two admins, pages loaded a minute apart. The older page clears second.
  resetState();
  {
    await call(ops.clearProviderFailures, { body: { through_id: 14 } });
    const older = await call(ops.clearProviderFailures, { body: { through_id: 11 }, admin: { name: 'ops-bola', role: 'finance' } });

    assert.strictEqual(older.statusCode, 200, 'being beaten to it is not an error');
    assert.strictEqual(older.body.data.cleared, 0);
    assert.strictEqual(older.body.data.through_id, 14, 'an older page must not move the mark back');
    assert.strictEqual(older.body.data.cleared_by, 'ops-ada', 'the answer names the clear that stands');
    assert.strictEqual(state.upserts.length, 1, 'no second write');

    // The same page twice (a double click) is the same thing.
    const again = await call(ops.clearProviderFailures, { body: { through_id: 14 } });
    assert.strictEqual(again.body.data.cleared, 0);
    assert.strictEqual(state.upserts.length, 1);
  }

  // --- case 3: only a real alert row can be a mark -------------------------------
  resetState();
  for (const bad of [13 /* a security row */, 999 /* not written yet */, 'abc', -1, 0.5]) {
    const res = await call(ops.clearProviderFailures, { body: { through_id: bad } });

    assert.strictEqual(res.statusCode, 400, `through_id ${JSON.stringify(bad)} must be refused`);
    assert.strictEqual(res.body.status, 'error');
    assert.ok(Array.isArray(res.body.message), 'the standard error envelope');
  }
  assert.strictEqual(state.upserts.length, 0, 'a refused clear writes no mark');

  // --- no id: everything written so far ------------------------------------------
  resetState();
  {
    const res = await call(ops.clearProviderFailures, { body: {} });

    assert.strictEqual(res.body.data.through_id, 14);
    assert.strictEqual(res.body.data.cleared, 4);

    const stored = JSON.parse(state.settings.get(ALERT_CLEAR_KEY));
    assert.strictEqual(stored.through_id, 14);
    assert.strictEqual(stored.cleared_by, 'ops-ada');
  }

  // An empty feed has nothing to clear, and writes nothing.
  resetState();
  state.audit = state.audit.filter(r => r.target_type !== 'alert');
  {
    const res = await call(ops.clearProviderFailures, { body: {} });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.data.cleared, 0);
    assert.strictEqual(res.body.data.through_id, null);
    assert.strictEqual(state.upserts.length, 0);
  }

  // --- case 5: an unreadable mark shows everything ---------------------------------
  resetState();
  state.settings.set(ALERT_CLEAR_KEY, '{broken');
  {
    const res = await call(ops.getProviderHealth, { query: {} });

    assert.strictEqual(res.body.data.cleared, null);
    assert.deepStrictEqual(ids(res), [14, 12, 11, 10]);
  }

  resetState();
  state.settingsReadFails = true;
  {
    const quiet = console.error;
    console.error = () => {};
    try {
      const res = await call(ops.getProviderHealth, { query: {} });

      assert.strictEqual(res.statusCode, 200, 'a failed mark read must not take the page down');
      assert.deepStrictEqual(ids(res), [14, 12, 11, 10], 'and it must not hide anything');

      // But a clear will not decide "forward only" against a mark it could
      // not read.
      const clear = await call(ops.clearProviderFailures, { body: { through_id: 12 } });

      assert.strictEqual(clear.statusCode, 500);
      assert.strictEqual(state.upserts.length, 0);
    } finally {
      console.error = quiet;
    }
  }

  // --- case 7: the audit trail ------------------------------------------------------
  {
    const { values } = adminAudit.__test.safeBody({ through_id: 12 });
    assert.strictEqual(values.through_id, '12', 'the trail must say how far the feed was cleared');

    // Not 'alert': the audit row of a clear must never appear in the feed it cleared.
    const info = adminAudit.__test.describe({ method: 'POST', originalUrl: '/api/admin/providers/failures/clear' });
    assert.strictEqual(info.targetType, 'providers');
    assert.strictEqual(info.action, 'post.providers.failures.clear');
  }

  // --- the route ----------------------------------------------------------------------
  {
    const layer = adminRoutes.stack.find(l => l.route?.path === '/providers/failures/clear');

    assert.ok(layer, 'POST /providers/failures/clear must be mounted');
    assert.ok(layer.route.methods.post, 'and it must be a POST - a GET could be prefetched');
  }

  console.log('providerFailuresClear: all assertions passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
