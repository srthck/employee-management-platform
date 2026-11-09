import crypto from 'node:crypto';
import IdempotencyRecord from '../models/IdempotencyRecord.js';
import { createOperation } from '../services/idempotencyService.js';
import { runWithOperation } from '../utils/operationContext.js';
import logger from '../utils/logger.js';

/**
 * Idempotency-Key support for state-changing endpoints.
 *
 * A client that retries a request (double click, network timeout, reload)
 * sends the same Idempotency-Key. The first request executes; every retry
 * receives the stored response instead of executing again, so a retry can
 * never create a second payroll run, salary version or payment.
 *
 *   same key, same request, finished        → stored response replayed
 *                                             (header Idempotent-Replayed: true)
 *   same key, same request, still running   → 409 IDEMPOTENCY_REQUEST_IN_PROGRESS
 *   same key, different request             → 422 IDEMPOTENCY_KEY_REUSED
 *   an earlier attempt committed work but
 *   never finished                          → 409 IDEMPOTENCY_PRIOR_ATTEMPT_COMMITTED
 *   an earlier attempt's commit is unknown  → 409 IDEMPOTENCY_OUTCOME_UNKNOWN
 *
 * Keys are scoped per user. A 5xx releases the key only when the record shows
 * that nothing committed and no commit was left unconfirmed; otherwise a retry
 * could apply the operation twice. See docs/integrity/IDEMPOTENCY.md.
 *
 * Must run after authMiddleware.
 */

const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;
const LOCK_MS = 5 * 60 * 1000;

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonical(value[key]);
      return result;
    }, {});
  }
  return value;
};

const fingerprint = (req) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify({ method: req.method, url: req.originalUrl, body: canonical(req.body ?? {}) }))
    .digest('hex');

async function claim(req, key, requestHash) {
  const now = new Date();
  const lockToken = crypto.randomUUID();
  try {
    const created = await IdempotencyRecord.create({
      key,
      userId: req.user.id,
      companyId: req.user.companyId || null,
      method: req.method,
      path: req.originalUrl,
      requestHash,
      status: 'IN_PROGRESS',
      lockExpiresAt: new Date(now.getTime() + LOCK_MS),
      lockToken,
    });
    return { claimed: true, lockToken, operationId: created.operationId };
  } catch (err) {
    if (err.code !== 11000) throw err;
  }

  // Take over an abandoned lock, but only of an attempt with nothing committed: re-running one that committed would apply it twice.
  const takeover = await IdempotencyRecord.findOneAndUpdate(
    {
      userId: req.user.id,
      key,
      requestHash,
      status: 'IN_PROGRESS',
      lockExpiresAt: { $lt: now },
      committedTransactions: { $in: [0, null] },
    },
    { $set: { lockExpiresAt: new Date(now.getTime() + LOCK_MS), lockToken } },
    { new: true }
  ).lean();
  if (takeover) return { claimed: true, lockToken, operationId: takeover.operationId };

  const existing = await IdempotencyRecord.findOne({ userId: req.user.id, key }).lean();
  return { claimed: false, existing };
}

const inProgress = (res) => {
  res.set('Retry-After', '2');
  return res.status(409).json({
    success: false,
    code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
    message: 'A request with this Idempotency-Key is being processed. Retry shortly.',
  });
};

const refuseRetry = (res, code, message, existing) => res.status(409).json({
  success: false,
  code,
  message,
  ...(existing.operationId && { operationId: existing.operationId }),
});

function respondToExisting(res, existing, requestHash) {
  if (!existing) return inProgress(res); // expired between the insert and this read; let the client retry

  if (existing.requestHash !== requestHash) {
    return res.status(422).json({
      success: false,
      code: 'IDEMPOTENCY_KEY_REUSED',
      message: 'This Idempotency-Key was already used for a different request.',
    });
  }
  if (existing.status === 'COMPLETED') {
    res.set('Idempotent-Replayed', 'true');
    return res.status(existing.responseStatus).json(JSON.parse(existing.responseBody));
  }

  const finished = existing.status === 'UNKNOWN_COMMIT' || existing.lockExpiresAt <= new Date();
  if (finished && existing.committedTransactions > 0) {
    return refuseRetry(res, 'IDEMPOTENCY_PRIOR_ATTEMPT_COMMITTED',
      'An earlier attempt of this request saved changes but did not finish. It will not be run again: check the current state, and use a new request if more is needed.',
      existing);
  }
  if (existing.status === 'UNKNOWN_COMMIT') {
    return refuseRetry(res, 'IDEMPOTENCY_OUTCOME_UNKNOWN',
      'An earlier attempt of this request may have been saved; the database did not confirm it. It will not be run again: check the current state, and use a new request if it is still needed.',
      existing);
  }
  return inProgress(res);
}

/** What a finished attempt leaves behind, chosen from what it knows committed. */
function persistOutcome(req, key, lockToken, operation, status, body) {
  const attempt = { userId: req.user.id, key, lockToken };
  if (status < 500) {
    return IdempotencyRecord.updateOne(attempt, {
      $set: { status: 'COMPLETED', responseStatus: status, responseBody: JSON.stringify(body) },
    });
  }
  if (operation.outcomeUnknown) {
    // Bounded: an abandoned transaction can hold this record until the server discards it. If this write times out the
    // record stays IN_PROGRESS with nothing committed, and the lock outlives that transaction, so a later takeover is safe.
    return IdempotencyRecord.updateOne(attempt, { $set: { status: 'UNKNOWN_COMMIT', responseStatus: status } }, { maxTimeMS: 5000 });
  }
  if (operation.committed > 0) {
    return IdempotencyRecord.updateOne(attempt, { $set: { lockExpiresAt: new Date() } });
  }
  // The conditions re-check the durable record: only an attempt that really committed nothing frees its key.
  return IdempotencyRecord.deleteOne({ ...attempt, status: 'IN_PROGRESS', committedTransactions: { $in: [0, null] } });
}

export const idempotent = ({ required = false } = {}) => async (req, res, next) => {
  const key = req.get('Idempotency-Key');

  if (!key) {
    if (!required) return next();
    return res.status(428).json({
      success: false,
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: 'This action requires an Idempotency-Key header.',
    });
  }

  if (!KEY_PATTERN.test(key)) {
    return res.status(400).json({
      success: false,
      code: 'IDEMPOTENCY_KEY_INVALID',
      message: 'Idempotency-Key must be 8–128 characters of letters, digits, "_", "-", ":" or ".".',
    });
  }

  const requestHash = fingerprint(req);
  const { claimed, existing, lockToken, operationId } = await claim(req, key, requestHash);
  if (!claimed) return respondToExisting(res, existing, requestHash);

  const operation = createOperation({ userId: req.user.id, key, lockToken, operationId });

  const sendJson = res.json.bind(res);
  res.json = (body) => {
    operation.close();
    // Store before responding, so an immediate retry always sees the result.
    persistOutcome(req, key, lockToken, operation, res.statusCode, body)
      .catch((err) => logger.error('Failed to persist idempotency record', { error: err.message, key }))
      .finally(() => sendJson(body));
    return res;
  };

  return runWithOperation(operation, next);
};
