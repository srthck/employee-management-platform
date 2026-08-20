import AuditLog from '../models/AuditLog.js';
import mongoose from 'mongoose';
import crypto from 'crypto';

export const GENESIS_HASH = 'GENESIS';
const REDACTED = '[REDACTED]';
const SENSITIVE_KEYS = new Set(['password', 'passwordHash', 'jwt', 'token', 'refreshToken', 'secret', 'bankAccount', 'bankCredentials', 'privateKey']);

const normalize = (value) => {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof mongoose.Types.ObjectId || mongoose.isValidObjectId(value) && typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') return Object.keys(value).sort().reduce((result, key) => {
    result[key] = SENSITIVE_KEYS.has(key) ? REDACTED : normalize(value[key]);
    return result;
  }, {});
  return value;
};

export const canonicalize = (payload) => JSON.stringify(normalize(payload));
export const calculateAuditHash = (payload) => crypto.createHash('sha256').update(canonicalize(payload), 'utf8').digest('hex');
const hashPayload = (entry) => ({
  sequenceNumber: entry.sequenceNumber,
  action: entry.action,
  actorId: String(entry.actorId),
  actorEmail: entry.actorEmail || null,
  actorRole: entry.actorRole || null,
  entityType: entry.entityType,
  entityId: String(entry.entityId),
  previousStatus: entry.previousStatus || null,
  newStatus: entry.newStatus || null,
  meta: entry.meta || {},
  ipAddress: entry.ipAddress || null,
  createdAt: new Date(entry.createdAt).toISOString(),
  previousHash: entry.previousHash,
});

/**
 * AuditService — Phase 6 compatible audit event emitter.
 *
 * Responsibilities:
 * - Record tamper-evident audit events for meaningful system actions.
 * - Support optional MongoDB session so audit writes participate in transactions.
 * - Provide structured audit records: who, what, when, on what entity.
 *
 * Usage (outside transaction):
 *   await auditService.log({ action, actorId, actorEmail, actorRole,
 *                            entityType, entityId, meta });
 *
 * Usage (inside transaction):
 *   await auditService.log({ ... }, session);
 *
 * NEVER throw from this service in a way that silently suppresses the calling
 * operation. Callers are responsible for deciding whether an audit failure is
 * business-critical.
 */

const auditService = {
  /**
   * Emit a single audit event.
   *
   * @param {object} params
   * @param {string}   params.action         - Uppercase event name, e.g. 'PAYROLL_RUN_CREATED'
   * @param {string}   params.actorId        - MongoDB ObjectId string of the acting admin
   * @param {string}   [params.actorEmail]   - Actor email (denormalized for readable logs)
   * @param {string}   [params.actorRole]    - Actor role at time of action
   * @param {string}   params.entityType     - Uppercase entity name, e.g. 'PAYROLL_RUN'
   * @param {string}   params.entityId       - MongoDB ObjectId of affected entity
   * @param {string}   [params.previousStatus]
   * @param {string}   [params.newStatus]
   * @param {object}   [params.meta]         - Additional context (arbitrary key/value)
   * @param {string}   [params.ipAddress]
   * @param {import('mongoose').ClientSession} [session] - Optional transaction session
   * @returns {Promise<AuditLog>}
   */
  async log(params, session = null) {
    const {
      action,
      actorId,
      actorEmail,
      actorRole,
      entityType,
      entityId,
      previousStatus = null,
      newStatus = null,
      meta = {},
      ipAddress = null,
    } = params;

    const query = AuditLog.findOne().sort({ sequenceNumber: -1 });
    if (session) query.session(session);
    const latest = await query.lean();
    const createdAt = new Date();
    const sequenceNumber = latest ? latest.sequenceNumber + 1 : 1;
    const previousHash = latest ? latest.hash : GENESIS_HASH;
    const redactedMeta = normalize(meta);
    const logEntry = new AuditLog({
      sequenceNumber,
      action,
      actorId,
      actorEmail,
      actorRole,
      entityType,
      entityId,
      previousStatus,
      newStatus,
      meta: redactedMeta,
      ipAddress,
      previousHash,
      createdAt,
      updatedAt: createdAt,
    });

    logEntry.hash = calculateAuditHash(hashPayload(logEntry));

    const options = session ? { session } : {};
    await logEntry.save(options);
    return logEntry;
  },

  /**
   * Query audit logs for a specific entity (for explainability endpoints).
   *
   * @param {string} entityType
   * @param {string} entityId
   * @param {object} [opts]
   * @param {number} [opts.limit=50]
   * @returns {Promise<AuditLog[]>}
   */
  async getEntityHistory(entityType, entityId, opts = {}) {
    const { limit = 50 } = opts;
    return AuditLog.find({ entityType, entityId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
  },

  async list({ entityType, action, limit = 50, skip = 0 } = {}) {
    const filter = {};
    if (entityType) filter.entityType = entityType.toUpperCase();
    if (action) filter.action = action.toUpperCase();
    const [logs, total] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1 }).skip(Number(skip)).limit(Number(limit)).lean(),
      AuditLog.countDocuments(filter),
    ]);
    return { logs, total, limit: Number(limit), skip: Number(skip) };
  },

  async getEntityHistoryPage(entityType, entityId, opts = {}) {
    if (!mongoose.isValidObjectId(entityId)) {
      throw Object.assign(new Error('Entity history not found.'), { statusCode: 404 });
    }
    const logs = await this.getEntityHistory(entityType, entityId, opts);
    return { logs, total: logs.length };
  },

  async verifyAuditChain() {
    const records = await AuditLog.find().sort({ sequenceNumber: 1 }).lean();
    let expectedSequence = 1;
    let previousHash = GENESIS_HASH;
    for (const record of records) {
      if (record.sequenceNumber !== expectedSequence) {
        return { valid: false, checkedRecords: expectedSequence - 1, firstBrokenSequence: record.sequenceNumber, reason: 'Sequence continuity check failed.' };
      }
      if (record.previousHash !== previousHash) {
        return { valid: false, checkedRecords: expectedSequence - 1, firstBrokenSequence: record.sequenceNumber, reason: 'Previous hash linkage failed.' };
      }
      const recalculated = calculateAuditHash(hashPayload(record));
      if (record.hash !== recalculated) {
        return { valid: false, checkedRecords: expectedSequence - 1, firstBrokenSequence: record.sequenceNumber, reason: 'Stored hash does not match recalculated hash.' };
      }
      previousHash = record.hash;
      expectedSequence += 1;
    }
    return { valid: true, checkedRecords: records.length, firstBrokenSequence: null, reason: null };
  },

  async backfillLegacyChain() {
    const records = await AuditLog.find().sort({ createdAt: 1, _id: 1 }).lean();
    if (!records.some((record) => !record.sequenceNumber || !record.hash || !record.previousHash)) return 0;
    let previousHash = GENESIS_HASH;
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const sequenceNumber = index + 1;
      const values = { ...record, sequenceNumber, previousHash };
      const hash = calculateAuditHash(hashPayload(values));
      await AuditLog.updateOne({ _id: record._id }, { $set: { sequenceNumber, previousHash, hash } });
      previousHash = hash;
    }
    return records.length;
  },
};

export default auditService;
