import AuditLog from '../models/AuditLog.js';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { getContext } from '../utils/requestContext.js';
import {
  auditChainContentionError, auditChainIndexError, backoffDelayMs, isAuditChainCollision, isTransientTransactionConflict, markAuditChainConflict, sleep,
} from '../utils/auditErrors.js';

export const GENESIS_HASH = 'GENESIS';
const REDACTED = '[REDACTED]';
const SENSITIVE_KEYS = new Set(['password', 'passwordHash', 'jwt', 'token', 'refreshToken', 'secret', 'bankAccount', 'bankCredentials', 'privateKey']);

/**
 * Append retry policy. A collision on the chain's uniqueness guards means another writer committed
 * first, so waiting and re-reading the head always makes system-wide progress; the caller gives up only
 * at the deadline, with an explicit, retryable 503 (nothing written). Tests may replace this object.
 */
const DEFAULT_APPEND_POLICY = Object.freeze({ maxWaitMs: 15000, baseDelayMs: 2, maxDelayMs: 150, indexRecheckMs: 10000 });

// The two database guards that make the chain linear. Matched by key and uniqueness, not by name.
const REQUIRED_CHAIN_INDEXES = Object.freeze([
  { label: 'unique sequenceNumber', key: { sequenceNumber: 1 }, spec: { name: 'sequenceNumber_1', unique: true } },
  {
    label: 'unique previousHash (one successor per predecessor)',
    key: { previousHash: 1 },
    spec: { name: 'previousHash_unique_successor', unique: true, partialFilterExpression: { previousHash: { $type: 'string' } } },
  },
]);

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

const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let indexGuardCheckedAt = 0;
let indexGuardInFlight = null;

// Plain (non-transactional) appends from this process take turns: they would only collide with each other.
// Cross-process and in-transaction contention is still resolved by the database guards and the back-off.
// A plain append never waits on anything except other plain appends, so this cannot deadlock, and its
// deadline starts when its own turn starts (time spent queued behind other appends is not "contention").
let plainAppendTail = Promise.resolve();
const takeTurn = (task) => {
  const run = plainAppendTail.then(task, task);
  plainAppendTail = run.catch(() => {});
  return run;
};

async function missingChainGuards() {
  let existing = [];
  try {
    existing = await AuditLog.collection.indexes();
  } catch (err) {
    if (err?.codeName !== 'NamespaceNotFound' && err?.code !== 26) throw err; // no collection yet: every guard is missing
  }
  return REQUIRED_CHAIN_INDEXES.filter((guard) => !existing.some((index) => index.unique && sameKey(index.key, guard.key)));
}

/**
 * Verify, and if possible restore, the database guards before appending. Fails CLOSED: when a guard is
 * missing and cannot be rebuilt (typically because the chain already forked, so the data violates it),
 * nothing is appended. Checked at most once per `indexRecheckMs`; every concurrent caller shares one check.
 */
async function ensureChainGuards(policy) {
  if (Date.now() - indexGuardCheckedAt < policy.indexRecheckMs) return;
  if (!indexGuardInFlight) {
    indexGuardInFlight = (async () => {
      let missing = await missingChainGuards();
      for (const guard of missing) {
        try {
          await AuditLog.collection.createIndex(guard.key, guard.spec);
        } catch (cause) {
          throw auditChainIndexError(`the ${guard.label} guard is missing and cannot be rebuilt (${cause.codeName || cause.code || cause.message}); the chain may already contain a fork.`, cause);
        }
      }
      missing = await missingChainGuards();
      if (missing.length > 0) throw auditChainIndexError(`the ${missing.map((g) => g.label).join(' and ')} guard is still missing after a rebuild attempt.`);
      indexGuardCheckedAt = Date.now();
    })().finally(() => { indexGuardInFlight = null; });
  }
  await indexGuardInFlight;
}

/**
 * AuditService — tamper-evident audit event emitter.
 *
 * Responsibilities:
 * - Record tamper-evident audit events for meaningful system actions.
 * - Support optional MongoDB session so audit writes participate in transactions.
 * - Provide structured audit records: who, what, when, on what entity, in which company.
 *
 * Concurrency (see docs/AUDIT-CHAIN-AND-SNAPSHOT-RECOVERY.md):
 *   Appending reads the chain head and inserts head+1. Two concurrent writers
 *   can read the same head; the database lets exactly one win, through TWO
 *   unique guards: sequenceNumber (one record per position) and previousHash
 *   (one successor per predecessor). Both are verified before appending and the
 *   append is refused (503) if they are missing and cannot be rebuilt.
 *   Outside a transaction the loser waits (exponential back-off, full jitter) and
 *   retries from the new head until a deadline; at the deadline the outcome is an
 *   explicit retryable 503 and nothing was written. Inside a transaction the
 *   collision aborts the transaction and runInTransaction retries the whole unit
 *   of work with the same policy. Either way the chain stays strictly linear.
 *   Inside a transaction the head is read from COMMITTED state (not the
 *   transaction snapshot), so the conflict window is read-to-commit, not the whole
 *   business transaction; the transaction's own earlier appends are included.
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
  /** Replaceable by tests; see DEFAULT_APPEND_POLICY. */
  appendPolicy: DEFAULT_APPEND_POLICY,

  /** Verify (and if possible restore) the chain's uniqueness guards now; throws 503 AUDIT_CHAIN_INDEX_UNAVAILABLE when impossible. */
  async assertChainIndexes() {
    indexGuardCheckedAt = 0;
    await ensureChainGuards(this.appendPolicy);
  },

  /** Read-only: which of the chain's uniqueness guards are missing right now (never creates anything). */
  async chainGuardStatus() {
    const missing = await missingChainGuards();
    return { ok: missing.length === 0, missing: missing.map((guard) => guard.label) };
  },

  /** Forget the cached guard check (tests, and operators after repairing indexes). */
  _resetIndexGuard() {
    indexGuardCheckedAt = 0;
  },

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

    const attempt = async () => {
      const policy = this.appendPolicy;
      await ensureChainGuards(policy);
      const startedAt = Date.now();
      for (let tries = 1; ; tries += 1) {
        try {
          return await this._append(entry, session);
        } catch (err) {
          // Inside a transaction the refusal has already aborted it: runInTransaction re-runs the whole unit of work.
          // A conflict raised by THIS insert is marked, so an exhausted retry budget is reported as audit contention.
          if (session && (isAuditChainCollision(err) || isTransientTransactionConflict(err))) throw markAuditChainConflict(err);
          if (!isAuditChainCollision(err)) throw err;
          const waited = Date.now() - startedAt;
          if (waited >= policy.maxWaitMs) throw auditChainContentionError(tries, waited, err);
          await sleep(backoffDelayMs(tries, policy.baseDelayMs, policy.maxDelayMs));
        }
      }
    };
    return session ? attempt() : takeTurn(attempt);
  },

  /**
   * The current chain head. Always includes what is committed NOW; inside a transaction it also includes
   * the transaction's own earlier appends. The higher sequence number wins, so two events logged in one
   * transaction chain correctly while another writer's newer commit is never hidden behind the
   * transaction's start-time snapshot.
   */
  async _readHead(session) {
    const committed = await AuditLog.findOne().sort({ sequenceNumber: -1 }).lean();
    if (!session) return committed;
    const own = await AuditLog.findOne().sort({ sequenceNumber: -1 }).session(session).lean();
    if (!own) return committed;
    if (!committed) return own;
    return own.sequenceNumber >= committed.sequenceNumber ? own : committed;
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

    const latest = await this._readHead(session);
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
