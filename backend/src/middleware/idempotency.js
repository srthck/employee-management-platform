import crypto from 'node:crypto';
import IdempotencyRecord from '../models/IdempotencyRecord.js';
import logger from '../utils/logger.js';

/**
 * Idempotency-Key support for state-changing endpoints.
 *
 * A client that retries a request (double click, network timeout, reload)
 * sends the same Idempotency-Key. The first request executes; every retry
 * receives the stored response instead of executing again, so a retry can
 * never create a second payroll run, salary version or payment.
 *
 *   same key, same request, finished     → stored response replayed
 *                                          (header Idempotent-Replayed: true)
 *   same key, same request, still running → 409 IDEMPOTENCY_REQUEST_IN_PROGRESS
 *   same key, different request          → 422 IDEMPOTENCY_KEY_REUSED
 *
 * Keys are scoped per user. 5xx responses are not stored, so a request that
 * failed unexpectedly can be retried with the same key.
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
  try {
    await IdempotencyRecord.create({
      key,
      userId: req.user.id,
      companyId: req.user.companyId || null,
      method: req.method,
      path: req.originalUrl,
      requestHash,
      status: 'IN_PROGRESS',
      lockExpiresAt: new Date(now.getTime() + LOCK_MS),
    });
    return { claimed: true };
  } catch (err) {
    if (err.code !== 11000) throw err;
  }

  // Take over an abandoned IN_PROGRESS lock (the original request died).
  const takeover = await IdempotencyRecord.findOneAndUpdate(
    { userId: req.user.id, key, requestHash, status: 'IN_PROGRESS', lockExpiresAt: { $lt: now } },
    { $set: { lockExpiresAt: new Date(now.getTime() + LOCK_MS) } },
    { new: true }
  ).lean();
  if (takeover) return { claimed: true };

  const existing = await IdempotencyRecord.findOne({ userId: req.user.id, key }).lean();
  return { claimed: false, existing };
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
  const { claimed, existing } = await claim(req, key, requestHash);

  if (!claimed) {
    if (!existing) {
      // Expired between insert and read; let the client retry.
      return res.status(409).json({
        success: false,
        code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
        message: 'A request with this Idempotency-Key is being processed. Retry shortly.',
      });
    }
    if (existing.requestHash !== requestHash) {
      return res.status(422).json({
        success: false,
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'This Idempotency-Key was already used for a different request.',
      });
    }
    if (existing.status === 'IN_PROGRESS') {
      res.set('Retry-After', '2');
      return res.status(409).json({
        success: false,
        code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
        message: 'A request with this Idempotency-Key is being processed. Retry shortly.',
      });
    }
    res.set('Idempotent-Replayed', 'true');
    return res.status(existing.responseStatus).json(JSON.parse(existing.responseBody));
  }

  const sendJson = res.json.bind(res);
  res.json = (body) => {
    const status = res.statusCode;
    const persist = status >= 500
      ? IdempotencyRecord.deleteOne({ userId: req.user.id, key })
      : IdempotencyRecord.updateOne(
          { userId: req.user.id, key },
          { $set: { status: 'COMPLETED', responseStatus: status, responseBody: JSON.stringify(body) } }
        );

    // Store before responding, so an immediate retry always sees the result.
    persist
      .catch((err) => logger.error('Failed to persist idempotency record', { error: err.message, key }))
      .finally(() => sendJson(body));
    return res;
  };

  return next();
};
