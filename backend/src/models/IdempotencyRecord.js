import mongoose from 'mongoose';
import crypto from 'node:crypto';
import config from '../config/environment.js';

/**
 * IdempotencyRecord — one row per (user, Idempotency-Key).
 *
 * Lifecycle:
 *   IN_PROGRESS    inserted before the handler runs; the unique index makes the
 *                  insert the lock, so two concurrent identical requests cannot
 *                  both execute
 *   COMPLETED      the response (status + body) is stored and replayed for any
 *                  retry with the same key and the same request fingerprint
 *   UNKNOWN_COMMIT a commit of this operation could not be confirmed either
 *                  way; a retry never re-executes, it is told to check the state
 *
 * committedTransactions and commits are written INSIDE each business
 * transaction, so they say exactly what committed under this key even if the
 * process died before responding. A request that crashes with nothing committed
 * leaves IN_PROGRESS until lockExpiresAt; after that a retry may take over,
 * which replaces lockToken and so fences the earlier attempt. An attempt that
 * committed anything is never taken over. Records expire after
 * IDEMPOTENCY_TTL_HOURS.
 */

const idempotencyRecordSchema = new mongoose.Schema(
  {
    operationId: { type: String, required: true, default: () => crypto.randomUUID() },
    key: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, default: null },
    method: { type: String, required: true },
    path: { type: String, required: true },
    requestHash: { type: String, required: true },
    status: { type: String, enum: ['IN_PROGRESS', 'COMPLETED', 'UNKNOWN_COMMIT'], required: true },
    lockExpiresAt: { type: Date, required: true },
    // Identifies the attempt that holds the lock; replaced on takeover.
    lockToken: { type: String, default: null },
    committedTransactions: { type: Number, default: 0 },
    commits: {
      type: [{ _id: false, marker: String, label: String, at: Date }],
      default: [],
    },
    responseStatus: { type: Number, default: null },
    // Stored as a JSON string: response bodies are opaque to the database.
    responseBody: { type: String, default: null },
    createdAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false }
);

idempotencyRecordSchema.index({ userId: 1, key: 1 }, { unique: true, name: 'unique_idempotency_key_per_user' });
// Partial: records written before operationId existed do not have the field.
idempotencyRecordSchema.index(
  { operationId: 1 },
  { unique: true, name: 'unique_idempotency_operation', partialFilterExpression: { operationId: { $type: 'string' } } }
);
idempotencyRecordSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: config.idempotencyTtlHours * 3600, name: 'idempotency_ttl' }
);

export default mongoose.model('IdempotencyRecord', idempotencyRecordSchema);
