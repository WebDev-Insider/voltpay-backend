// Replay guard for the routes that move money.
//
// Nigerian mobile networks drop a request far more often than they drop a
// response, so the dangerous case is not "the app failed to send" - it is "the
// app sent, we charged, and the answer never arrived". The app cannot tell
// those apart, so it must be able to ask again without paying twice.
//
// The app stamps every money POST with `X-Idempotency-Key` (one key per
// payment attempt, reused on every retry of that same attempt). The first
// request through claims the key and its final response is stored against it;
// any later request carrying the same key is answered from the store instead
// of being executed.
//
// Postgres, not Redis: redis.service fails open by design (see CLAUDE.md), and
// a cache miss here would mean a second debit. A unique index is the only
// primitive that is safe under two taps racing on two instances.
const prisma = require('../../database/prisma');
const { blindIndex } = require('../helpers/pii.helper');

// A stored result is worth keeping only as long as a user might still be
// staring at a spinner. A day is generous; the cleanup below is opportunistic.
const RETENTION_MS = 24 * 60 * 60 * 1000;

function keyDigest(userId, name, key) {
  return blindIndex(`${userId}|${name}|${key}`, 'idempotency');
}

// The body minus the secrets. Two different payments must never share a key,
// so a reused key with a different payload is rejected rather than replayed.
// The PIN is excluded: it is not part of what identifies the payment, and it
// has no business being hashed into a long-lived row.
function fingerprint(body) {
  const copy = { ...(body || {}) };
  delete copy.pin;
  delete copy.password;
  delete copy.access_token;
  return blindIndex(JSON.stringify(copy), 'idempotency');
}

function available() {
  return Boolean(prisma?.idempotencyKey);
}

/**
 * @param {object} options
 * @param {string} options.name  route namespace, so one key cannot be replayed across endpoints
 */
function idempotency({ name }) {
  return async function idempotencyMiddleware(req, res, next) {
    const key = String(req.headers['x-idempotency-key'] || '').trim();

    // No key: an older build of the app, or a route hit by hand. The route's
    // own guards (pending-token consumption, balance reserve in the same
    // transaction) still apply, so this is the pre-existing behaviour rather
    // than a hole this middleware opened.
    if (!key) return next();
    if (key.length > 100) {
      return res.status(400).json({
        remark: 'validation_error', status: 'error',
        message: ['Invalid idempotency key'], data: null,
      });
    }
    // The table has not been created yet. Failing closed here would take
    // payments down on a deploy that ran ahead of the DDL, so this degrades to
    // the old behaviour and says so loudly.
    if (!available()) {
      console.warn('[idempotency] idempotency_keys model missing - run scripts/apply-idempotency-ddl.js');
      return next();
    }

    const userId = Number(req.user?.id || 0);
    if (!userId) return next();

    const digest = keyDigest(userId, name, key);
    const print = fingerprint(req.body);

    let claimed = false;
    try {
      await prisma.idempotencyKey.create({
        data: { key_idx: digest, user_id: userId, endpoint: name, fingerprint: print, status: 'in_flight' },
      });
      claimed = true;
    } catch (e) {
      if (e?.code !== 'P2002') throw e;
    }

    if (!claimed) {
      const existing = await prisma.idempotencyKey.findUnique({ where: { key_idx: digest } });

      // Lost the race but the row vanished (retention sweep): treat as fresh.
      if (!existing) return next();

      if (existing.fingerprint !== print) {
        return res.status(422).json({
          remark: 'idempotency_conflict', status: 'error',
          message: ['This payment reference was already used for a different payment.'], data: null,
        });
      }

      if (existing.status === 'completed') {
        // The original answer, byte for byte. A replayed success must not read
        // as a second success anywhere downstream, so the flag says which it is.
        const body = existing.response_body || {};
        return res.status(existing.response_status || 200).json({ ...body, replayed: true });
      }

      // Still running. The app parks the payment as pending and polls
      // /payment-status/:key rather than sending the charge again.
      return res.status(409).json({
        remark: 'payment_in_progress', status: 'error',
        message: ['This payment is still being processed. Check its status in a moment.'],
        data: { idempotency_key: key },
      });
    }

    // Capture the final response. Anything 5xx is released instead of stored -
    // a crash is not an outcome, and the user must be able to try again.
    const originalJson = res.json.bind(res);
    res.json = body => {
      const status = res.statusCode || 200;
      const write = status >= 500
        ? prisma.idempotencyKey.delete({ where: { key_idx: digest } })
        : prisma.idempotencyKey.update({
            where: { key_idx: digest },
            data: { status: 'completed', response_status: status, response_body: body ?? {} },
          });
      write.catch(e => console.error('[idempotency] store failed:', e.message));
      return originalJson(body);
    };

    // Opportunistic sweep, ~1 request in 50. No cron to own, and the table
    // stays small.
    if (Math.random() < 0.02) {
      prisma.idempotencyKey
        .deleteMany({ where: { created_at: { lt: new Date(Date.now() - RETENTION_MS) } } })
        .catch(() => {});
    }

    return next();
  };
}

/**
 * GET /payment-status/:key
 *
 * The other half of the contract. After a timeout the app knows only its own
 * key, and it must not re-send a charge to find out what happened - so it asks
 * here instead.
 *
 *   completed -> the stored response, with the outcome the server reached
 *   pending   -> claimed and still running
 *   unknown   -> never reached us, so nothing was debited
 */
async function paymentStatus(req, res) {
  const key = String(req.params.key || '').trim();
  const userId = Number(req.user?.id || 0);
  if (!key || !userId) {
    return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid reference'], data: null });
  }
  if (!available()) {
    return res.status(200).json({ remark: 'payment_status', status: 'success', message: ['Unknown'], data: { state: 'unknown' } });
  }

  // The endpoint namespace is part of the digest, so the key is looked up
  // against each money route in turn rather than stored raw.
  const names = ['bills_confirm', 'verify_pin_settle', 'send_money_store', 'request_money_approve', 'staffpay_payroll_run', 'staffpay_payroll_retry', 'betting_store'];
  let row = null;
  for (const name of names) {
    row = await prisma.idempotencyKey.findUnique({ where: { key_idx: keyDigest(userId, name, key) } });
    if (row) break;
  }

  if (!row) {
    return res.json({
      remark: 'payment_status', status: 'success',
      message: ['This payment never reached us. Nothing was deducted.'],
      data: { state: 'unknown' },
    });
  }
  if (row.status !== 'completed') {
    return res.json({
      remark: 'payment_status', status: 'success',
      message: ['Still processing.'], data: { state: 'pending' },
    });
  }

  const body = row.response_body || {};
  const ok = (body.status || '').toString().toLowerCase() === 'success';
  return res.json({
    remark: 'payment_status', status: 'success',
    message: Array.isArray(body.message) ? body.message : [String(body.message || '')],
    data: { state: 'completed', succeeded: ok, response_status: row.response_status, response: body },
  });
}

module.exports = idempotency;
module.exports.paymentStatus = paymentStatus;
module.exports.fingerprint = fingerprint;
module.exports.keyDigest = keyDigest;
