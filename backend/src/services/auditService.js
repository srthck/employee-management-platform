import AuditLog from '../models/AuditLog.js';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { getContext } from '../utils/requestContext.js';

export const GENESIS_HASH = 'GENESIS';
const REDACTED = '[REDACTED]';
const SENSITIVE_KEYS = new Set(['password', 'passwordHash', 'jwt', 'token', 'refreshToken', 'secret', 'bankAccount', 'bankCredentials', 'privateKey']);
const MAX_APPEND_ATTEMPTS = 10;

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
const hashPayload = (entry) => {
  const payload = {
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
  };
  // Only hashed when present, so records written before tenant scoping
  // existed keep their original hashes.
  if (entry.companyId) payload.companyId = String(entry.companyId);
  return payload;
};

const isSequenceCollision = (err) =>
  err?.code === 11000 && Boolean(err?.keyPattern?.sequenceNumber || /sequenceNumber/.test(err?.message || ''));

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * AuditService — tamper-evident audit event emitter.
 *
 * Responsibilities:
 * - Record tamper-evident audit events for meaningful system actions.
 * - Support optional MongoDB session so audit writes participate in transactions.
 * - Provide structured audit records: who, what, when, on what entity, in which company.
 *
 * Concurrency:
 *   Appending reads the chain head and inserts head+1. Two concurrent writers
 *   can read the same head; the unique index on sequenceNumber lets exactly one
 *   win. Outside a transaction the loser re-reads the head and retries here.
 *   Inside a transaction the collision aborts the transaction and
 *   runInTransaction retries the whole unit of work. Either way the chain
 *   stays strictly linear and a business operation never fails merely because
 *   another event was logged at the same moment.
 *
 * Usage (outside transaction):
 *   await auditService.log({ action, actorId, actorEmail, actorRole,
 *                            entityType, entityId, meta });
 *
 * Usage (inside transaction):
 *   await auditService.log({ ... }, session);
 *
 * ipAddress and companyId default to the current request context.
 */

const auditService = {
  /**
   * Emit a single audit event.
   *
   * @param {object} params
   * @param {string}   params.action         - Uppercase event name, e.g. 'PAYROLL_RUN_CREATED'
   * @param {string}   params.actorId        - MongoDB ObjectId string of the acting user
   * @param {string}   [params.actorEmail]   - Actor email (denormalized for readable logs)
   * @param {string}   [params.actorRole]    - Actor role at time of action
   * @param {string}   params.entityType     - Uppercase entity name, e.g. 'PAYROLL_RUN'
   * @param {string}   params.entityId       - MongoDB ObjectId of affected entity
   * @param {string}   [params.companyId]    - Defaults to the request's company
   * @param {string}   [params.previousStatus]
   * @param {string}   [params.newStatus]
   * @param {object}   [params.meta]         - Additional context (arbitrary key/value)
   * @param {string}   [params.ipAddress]    - Defaults to the request's client IP
   * @param {import('mongoose').ClientSession} [session] - Optional transaction session
   * @returns {Promise<AuditLog>}
   */
  async log(params, session = null) {
    const context = getContext();
    const entry = {
      ...params,
      companyId: params.companyId ?? context.companyId ?? null,
      ipAddress: params.ipAddress ?? context.ipAddress ?? null,
    };

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this._append(entry, session);
      } catch (err) {
        if (!session && attempt < MAX_APPEND_ATTEMPTS && isSequenceCollision(err)) {
          await pause(Math.floor(Math.random() * 10 * attempt));
          continue;
        }
        throw err;
      }
    }
  },

  async _append(params, session) {
    const {
      action,
      actorId,
      actorEmail,
      actorRole,
      entityType,
      entityId,
      companyId = null,
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
      companyId,
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
   * @param {string} [opts.companyId] - restricts results to one company
   * @returns {Promise<AuditLog[]>}
   */
  async getEntityHistory(entityType, entityId, opts = {}) {
    const { limit = 50, companyId } = opts;
    const filter = { entityType: String(entityType).toUpperCase(), entityId };
    if (companyId) filter.companyId = companyId;
    return AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .lean();
  },

  async list({ companyId, entityType, action, limit = 50, skip = 0 } = {}) {
    const filter = {};
    if (companyId) filter.companyId = companyId;
    if (entityType) filter.entityType = String(entityType).toUpperCase();
    if (action) filter.action = String(action).toUpperCase();
    const [logs, total] = await Promise.all([
      AuditLog.find(filter).sort({ sequenceNumber: -1 }).skip(Number(skip)).limit(Number(limit)).lean(),
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

  /**
   * Walk the entire chain in sequence order with a cursor (constant memory)
   * and report the first break.
   */
  async verifyAuditChain() {
    const cursor = AuditLog.find().sort({ sequenceNumber: 1 }).lean().cursor();
    let expectedSequence = 1;
    let previousHash = GENESIS_HASH;
    try {
      for await (const record of cursor) {
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
    } finally {
      await cursor.close();
    }
    return { valid: true, checkedRecords: expectedSequence - 1, firstBrokenSequence: null, reason: null };
  },

  /**
   * One-time migration for audit records written before the hash chain
   * existed. Uses the raw collection because the model is append-only by
   * design; it only runs when unchained records are present.
   */
  async backfillLegacyChain() {
    const unchained = await AuditLog.exists({
      $or: [{ sequenceNumber: null }, { hash: null }, { previousHash: null }],
    });
    if (!unchained) return 0;
    const records = await AuditLog.find().sort({ createdAt: 1, _id: 1 }).lean();
    let previousHash = GENESIS_HASH;
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const sequenceNumber = index + 1;
      const values = { ...record, sequenceNumber, previousHash };
      const hash = calculateAuditHash(hashPayload(values));
      await AuditLog.collection.updateOne({ _id: record._id }, { $set: { sequenceNumber, previousHash, hash } });
      previousHash = hash;
    }
    return records.length;
  },
};

export default auditService;
