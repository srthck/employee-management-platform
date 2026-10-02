import mongoose from 'mongoose';
import config from '../config/environment.js';

/**
 * IdempotencyRecord — one row per (user, Idempotency-Key).
 *
 * Lifecycle:
 *   IN_PROGRESS  inserted before the handler runs; the unique index makes the
 *                insert the lock, so two concurrent identical requests cannot
 *                both execute
 *   COMPLETED    the response (status + body) is stored and replayed for any
 *                retry with the same key and the same request fingerprint
 *
 * A request that crashes without responding leaves IN_PROGRESS until
 * lockExpiresAt; after that a retry may take over. Records expire after
 * IDEMPOTENCY_TTL_HOURS.
 */

const idempotencyRecordSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, default: null },
    method: { type: String, required: true },
    path: { type: String, required: true },
    requestHash: { type: String, required: true },
    status: { type: String, enum: ['IN_PROGRESS', 'COMPLETED'], required: true },
    lockExpiresAt: { type: Date, required: true },
    responseStatus: { type: Number, default: null },
    // Stored as a JSON string: response bodies are opaque to the database.
    responseBody: { type: String, default: null },
    createdAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false }
);

idempotencyRecordSchema.index({ userId: 1, key: 1 }, { unique: true, name: 'unique_idempotency_key_per_user' });
idempotencyRecordSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: config.idempotencyTtlHours * 3600, name: 'idempotency_ttl' }
);

export default mongoose.model('IdempotencyRecord', idempotencyRecordSchema);
