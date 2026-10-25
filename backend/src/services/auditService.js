import AuditLog from '../models/AuditLog.js';
import AuditChainHead from '../models/AuditChainHead.js';
import mongoose from 'mongoose';
import crypto from 'crypto';
import config from '../config/environment.js';
import { getContext } from '../utils/requestContext.js';
import { runInTransaction, inTransactionContext, inNestedTransactionContext, supportsTransactions } from '../utils/transaction.js';
import { isLoopbackHost } from '../config/transactionPolicy.js';
import {
  auditChainHeadConflictError, auditChainInconsistentError, auditChainNotInitializedError, auditNestedTransactionError, auditSessionRequiredError,
  backoffDelayMs, isAuditChainCollision, isAuditChainConflict, isTransientTransactionConflict, markAuditChainConflict, sleep,
} from '../utils/auditErrors.js';
import { AUDIT_COLLECTION, HEAD_ID, evaluateIndexes, evaluateValidator } from './auditChainSpec.js';

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

// Records that predate the hash chain: lacking any of the three chain fields (null matches missing too).
const unchainedFilter = () => ({ $or: [{ sequenceNumber: null }, { hash: null }, { previousHash: null }] });
const MAX_BACKFILL_FINDINGS = 200;

const heads = () => AuditChainHead.collection;
const DEGRADED_MAX_ATTEMPTS = 60;

/** Development/test only: an EMPTY chain may create its own genesis head. Anywhere else the head comes from the explicit initialization. An allow-list: an unknown mode never bootstraps. */
const bootstrapAllowed = (mode) => mode === 'relaxed';

/**
 * True only when EVERY host this process is connected to is a loopback address, i.e. a local development/test database.
 * The environment label (NODE_ENV) is a string anyone can mistype; a head must never be invented on a shared or remote
 * database because of one. Unknown or unresolved hosts count as not loopback (fail closed).
 */
const connectedToLoopbackOnly = () => {
  try {
    const hosts = mongoose.connection.getClient().options.hosts;
    return Array.isArray(hosts) && hosts.length > 0 && hosts.every((entry) => typeof entry?.host === 'string' && isLoopbackHost(entry.host.toLowerCase()));
  } catch {
    return false;
  }
};

/**
 * AuditService — tamper-evident audit event emitter.
 *
 * THE APPEND PROTOCOL (docs/integrity/AUDIT-CHAIN-HEAD.md; the Phase 1 model `head-cas`):
 *   One authoritative head document {sequence n, hash h, version v}. An append is one MongoDB transaction that
 *     1. reads the head,
 *     2. builds the record with the existing canonical hash (sequence n+1, previousHash h),
 *     3. advances the head with an update that matches ONLY {sequence n, hash h, version v} and sets
 *        {n+1, h', v+1} (exactly one document must match),
 *     4. inserts the record (carrying headVersion = v+1),
 *     5. commits with the caller's business writes.
 *   Two transactions cannot both advance the same head, so the chain cannot fork for any writer that follows the
 *   protocol, whatever the state of the unique indexes (those, and a collection validator, are defence in depth and
 *   block writers that do not know the protocol). Several events in one transaction extend each other because the
 *   head is read inside the transaction and sees the transaction's own earlier advance.
 *
 *   log(params, session)   the session MUST be a caller-owned session with an active transaction; otherwise
 *                          AUDIT_SESSION_REQUIRED and nothing is written. There is no silent independent commit.
 *   logStandalone(params)  an audit-only event with no business mutation: opens and owns its transaction. Refused
 *                          (AUDIT_NESTED_TRANSACTION) from inside a runInTransaction callback.
 *
 * ipAddress and companyId default to the current request context.
 */

const auditService = {
  /** Test seam: 'strict' | 'relaxed' | null (null = from configuration). */
  _modeOverride: null,

  /** 'strict' (production, unrecognized environments, or AUDIT_CHAIN_STRICT=true): the head must have been initialized by the operator. 'relaxed' (development/test): an empty chain bootstraps itself. */
  protocolMode() {
    const mode = this._modeOverride || (config.auditChainStrict ? 'strict' : 'relaxed');
    if (mode !== 'strict' && mode !== 'relaxed') throw new Error(`unknown audit chain protocol mode ${JSON.stringify(mode)}`);
    return mode;
  },

  /**
   * Append one event inside the caller's transaction.
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
   * @param {import('mongoose').ClientSession} session - REQUIRED: a session with an active transaction
   * @returns {Promise<AuditLog>}
   */
  async log(params, session = null) {
    const context = getContext();
    const entry = {
      ...params,
      companyId: params.companyId ?? context.companyId ?? null,
      ipAddress: params.ipAddress ?? context.ipAddress ?? null,
    };

    if (!session) {
      // The development fallback (no real transactions at all) is the ONLY case without a session, and only when the
      // transaction policy allows it. With real transactions available a missing session is a bug, never a quiet commit.
      if (config.requireTransactions || (await supportsTransactions())) throw auditSessionRequiredError('no session was passed');
      return this._appendWithoutTransactions(entry);
    }
    if (typeof session.inTransaction !== 'function' || !session.inTransaction()) throw auditSessionRequiredError('the session has no active transaction');
    // An audited append inside a transaction that was itself started from inside another transaction's callback would be a
    // second, independent transaction contending with its parent on the one head document (stall until the retry budget is
    // spent, or the inner effects committed twice when the parent re-runs). Refused, like logStandalone.
    if (inNestedTransactionContext()) throw auditNestedTransactionError('nested-log');

    try {
      return await this._append(entry, session);
    } catch (err) {
      // A conflict raised by THIS append is marked, so an exhausted retry budget is reported as audit contention.
      if (isTransientTransactionConflict(err) || isAuditChainConflict(err)) throw markAuditChainConflict(err);
      throw err;
    }
  },

  /**
   * An audit-only event with no business mutation to be atomic with. Opens and owns its transaction (retried by
   * runInTransaction). NOT for use inside a transaction callback: that would be a second, independent transaction.
   */
  async logStandalone(params, options = {}) {
    if (inTransactionContext()) throw auditNestedTransactionError();
    return runInTransaction((session) => this.log(params, session), { label: 'audit.standalone', ...options });
  },

  /** The head to extend, read inside the transaction (so it includes this transaction's own earlier advances). */
  async _loadHead(session) {
    const head = await heads().findOne({ _id: HEAD_ID }, { session });
    if (head) return head;
    if (!bootstrapAllowed(this.protocolMode())) throw auditChainNotInitializedError('there is no head document');
    if (!connectedToLoopbackOnly()) throw auditChainNotInitializedError('there is no head document, and the relaxed protocol only creates one on a loopback (local development/test) database');
    const existing = await AuditLog.collection.countDocuments({}, { session, limit: 1 });
    if (existing > 0) throw auditChainNotInitializedError('the chain has records but no head document');
    const genesis = {
      _id: HEAD_ID, scope: 'global', formatVersion: 1, sequence: 0, hash: GENESIS_HASH, version: 1,
      baseline: { sequence: 0, hash: GENESIS_HASH, source: 'auto-bootstrap-empty', at: new Date(), operator: null, planDigest: null, commit: null },
    };
    try {
      await heads().insertOne(genesis, { session });
    } catch (error) {
      if (error?.code === 11000) throw auditChainHeadConflictError('another transaction created the head first');
      throw error;
    }
    return genesis;
  },

  _build(entry, head) {
    const {
      action, actorId, actorEmail, actorRole, entityType, entityId, companyId = null,
      previousStatus = null, newStatus = null, meta = {}, ipAddress = null,
    } = entry;
    const createdAt = new Date();
    const logEntry = new AuditLog({
      sequenceNumber: head.sequence + 1,
      action,
      actorId,
      actorEmail,
      actorRole,
      companyId,
      entityType,
      entityId,
      previousStatus,
      newStatus,
      meta: normalize(meta),
      ipAddress,
      previousHash: head.hash,
      headVersion: head.version + 1,
      createdAt,
      updatedAt: createdAt,
    });
    logEntry.hash = calculateAuditHash(hashPayload(logEntry));
    return logEntry;
  },

  async _append(entry, session) {
    const head = await this._loadHead(session);
    const logEntry = this._build(entry, head);

    // Advance the head: matches only the exact state this transaction read. A concurrent committed advance makes the
    // server raise WriteConflict; a stale match (should not happen inside one snapshot) matches nothing. Either way
    // the whole transaction is retried from a fresh head.
    const advanced = await heads().updateOne(
      { _id: HEAD_ID, sequence: head.sequence, hash: head.hash, version: head.version },
      { $set: { sequence: logEntry.sequenceNumber, hash: logEntry.hash }, $inc: { version: 1 } },
      { session },
    );
    if (advanced.matchedCount !== 1 || advanced.modifiedCount !== 1) {
      throw auditChainHeadConflictError(`the conditional head update matched ${advanced.matchedCount} document(s)`);
    }
    try {
      await logEntry.save({ session });
    } catch (error) {
      // The head said this position was free; a unique index says it is taken. A writer outside the protocol wrote
      // to the chain. That is not contention and retrying cannot fix it.
      if (isAuditChainCollision(error)) throw auditChainInconsistentError('a unique index refused a record at a position the head said was free', error);
      throw error;
    }
    return logEntry;
  },

  /** Development/test fallback WITHOUT real transactions: NOT atomic. The head advance and the insert are two writes; a failed insert reverts the head best-effort. */
  async _appendWithoutTransactions(entry) {
    for (let attempt = 1; ; attempt += 1) {
      let head;
      try {
        head = await this._loadHead(undefined);
      } catch (error) {
        // Two first appends on an empty chain race to create the head (no snapshot to turn the loser into a WriteConflict
        // here, so it sees a duplicate key). The loser takes another turn from the head the winner created.
        if (!isAuditChainConflict(error) || attempt >= DEGRADED_MAX_ATTEMPTS) throw error;
        await sleep(backoffDelayMs(attempt, 2, 100));
        continue;
      }
      const logEntry = this._build(entry, head);
      const advanced = await heads().updateOne(
        { _id: HEAD_ID, sequence: head.sequence, hash: head.hash, version: head.version },
        { $set: { sequence: logEntry.sequenceNumber, hash: logEntry.hash }, $inc: { version: 1 } },
      );
      if (advanced.matchedCount !== 1) {
        if (attempt >= DEGRADED_MAX_ATTEMPTS) throw auditChainHeadConflictError('retries exhausted without real transactions');
        await sleep(backoffDelayMs(attempt, 2, 100));
        continue;
      }
      try {
        await logEntry.save();
        return logEntry;
      } catch (error) {
        await heads().updateOne(
          { _id: HEAD_ID, version: head.version + 1, hash: logEntry.hash },
          { $set: { sequence: head.sequence, hash: head.hash }, $inc: { version: -1 } },
        ).catch(() => {});
        if (isAuditChainCollision(error)) throw auditChainInconsistentError('a unique index refused a record at a position the head said was free', error);
        throw error;
      }
    }
  },

  /**
   * READ-ONLY. Does the head agree with the last committed record? Reads both in one snapshot (when transactions
   * exist) so a concurrent append cannot make a healthy chain look broken.
   * @returns {{ ok: boolean, code: string|null, reason: string|null, head: object|null, tail: object|null }}
   */
  async verifyHead() {
    const read = async (session) => ({
      head: await heads().findOne({ _id: HEAD_ID }, { session }),
      tail: await AuditLog.collection.find({}, { session, sort: { sequenceNumber: -1 }, limit: 1, projection: { sequenceNumber: 1, hash: 1, headVersion: 1 } }).next(),
    });
    let snapshot;
    if (await supportsTransactions()) {
      const session = await mongoose.startSession();
      try {
        session.startTransaction({ readConcern: { level: 'snapshot' } });
        snapshot = await read(session);
        await session.commitTransaction();
      } finally {
        await session.endSession();
      }
    } else {
      snapshot = await read(undefined);
    }
    const { head, tail } = snapshot;
    const result = (ok, code, reason) => ({ ok, code, reason, head, tail });
    if (!head) return result(false, 'HEAD_MISSING', 'there is no head document');
    if (!tail) {
      return head.sequence === 0 && head.hash === GENESIS_HASH && head.version === 1
        ? result(true, null, null)
        : result(false, 'HEAD_AHEAD_OF_CHAIN', `the chain is empty but the head says sequence ${head.sequence}, version ${head.version}`);
    }
    if (head.sequence !== tail.sequenceNumber) return result(false, 'HEAD_SEQUENCE_MISMATCH', `head sequence ${head.sequence} but the last record is ${tail.sequenceNumber}`);
    if (head.hash !== tail.hash) return result(false, 'HEAD_HASH_MISMATCH', `head hash ${head.hash} but the last record's hash is ${tail.hash}`);
    if (tail.headVersion !== undefined) {
      if (head.version !== tail.headVersion) return result(false, 'HEAD_VERSION_MISMATCH', `head version ${head.version} but the last record carries headVersion ${tail.headVersion}`);
    } else if (head.version !== 1 || head.baseline?.sequence !== tail.sequenceNumber) {
      return result(false, 'HEAD_VERSION_MISMATCH', `no record carries a headVersion yet, but the head is at version ${head.version} (baseline sequence ${head.baseline?.sequence})`);
    }
    return result(true, null, null);
  },

  /** READ-ONLY. Is an index build running on the audit collection right now? 'UNAVAILABLE' (not 'NONE') when the database user may not ask. */
  async indexBuildState() {
    try {
      const ns = `${mongoose.connection.name}.${AUDIT_COLLECTION}`;
      const operations = await mongoose.connection.getClient().db('admin')
        .aggregate([{ $currentOp: { allUsers: true } }, { $match: { ns, 'command.createIndexes': { $exists: true } } }])
        .toArray();
      return { state: operations.length > 0 ? 'RUNNING' : 'NONE', detail: null };
    } catch (error) {
      return { state: 'UNAVAILABLE', detail: error.message };
    }
  },

  /** READ-ONLY. The three unique indexes and the validator, judged against the exact specification (auditChainSpec). */
  async databaseShape() {
    let live = [];
    try {
      live = await AuditLog.collection.indexes();
    } catch (err) {
      if (err?.codeName !== 'NamespaceNotFound' && err?.code !== 26) throw err;
    }
    const info = await mongoose.connection.db.listCollections({ name: AUDIT_COLLECTION }).toArray();
    return { indexes: evaluateIndexes(live), validator: evaluateValidator(info[0]?.options) };
  },

  /** READ-ONLY. Compatibility view used by the reconciliation report: which required indexes are not effective. */
  async chainGuardStatus() {
    const { indexes } = await this.databaseShape();
    const missing = indexes.filter((index) => index.status !== 'OK').map((index) => `${index.label}${index.status === 'INCOMPATIBLE' ? ` (incompatible: ${index.detail})` : ''}`);
    return { ok: missing.length === 0, missing };
  },

  /**
   * READ-ONLY. Everything an operator or a readiness probe needs: head consistency, exact index specifications,
   * the validator and a running index build. `ok` is false only for ERRORS; in relaxed mode (development/test) a
   * missing index or validator and a not-yet-created head on an empty chain are warnings, never errors.
   */
  async protocolStatus({ checkBuilds = true } = {}) {
    const mode = this.protocolMode();
    const issues = [];
    const add = (severity, code, detail) => issues.push({ severity, code, detail });
    const shape = await this.databaseShape();
    for (const index of shape.indexes) {
      if (index.status === 'INCOMPATIBLE') add('error', 'INDEX_INCOMPATIBLE', `${index.label}: ${index.detail}`);
      else if (index.status === 'MISSING') add(mode === 'strict' ? 'error' : 'warning', 'INDEX_MISSING', index.label);
    }
    if (shape.validator.status === 'INCOMPATIBLE') add('error', 'VALIDATOR_INCOMPATIBLE', shape.validator.detail);
    else if (shape.validator.status === 'MISSING') add(mode === 'strict' ? 'error' : 'warning', 'VALIDATOR_MISSING', 'the collection validator that blocks writers outside the protocol is not set');
    const head = await this.verifyHead();
    if (!head.ok) {
      const emptyChain = head.code === 'HEAD_MISSING' && (await AuditLog.collection.countDocuments({}, { limit: 1 })) === 0;
      if (emptyChain && mode === 'relaxed' && connectedToLoopbackOnly()) add('warning', 'HEAD_NOT_YET_CREATED', 'the chain is empty; the head is created by the first audited event');
      else add('error', head.code, head.reason);
    }
    const build = checkBuilds ? await this.indexBuildState() : { state: 'SKIPPED', detail: null };
    if (build.state === 'RUNNING') add('error', 'INDEX_BUILD_RUNNING', 'an index build on the audit collection has not finished');
    else if (build.state === 'UNAVAILABLE') add('warning', 'INDEX_BUILD_UNOBSERVABLE', `cannot observe running index builds (${build.detail}); an unfinished build looks like a finished index`);
    return { ok: !issues.some((i) => i.severity === 'error'), mode, issues, indexes: shape.indexes, validator: shape.validator, head: { ok: head.ok, code: head.code, reason: head.reason, sequence: head.head?.sequence ?? null, version: head.head?.version ?? null }, build };
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
   * READ-ONLY. How many audit records predate the hash chain (lack any of sequenceNumber / previousHash /
   * hash)? Used by startup to WARN; startup never changes audit history.
   */
  async legacyChainStatus() {
    return { unchainedRecords: await AuditLog.countDocuments(unchainedFilter()) };
  },

  /**
   * READ-ONLY. Plan the one-time migration of audit records written before the hash chain existed.
   *
   * The plan only ever FILLS records that have none of the three chain fields. It never changes a record
   * that is already chained, so no stored hash of existing history can change. It REFUSES (ok:false) when
   * the history is not safely extendable:
   *   - the chained records do not form a valid chain from genesis (fork, duplicate, gap, bad link/hash);
   *   - a record is partially chained or cannot be hashed (missing/invalid fields);
   *   - an unchained record sorts before the chain's tail (filling it would require re-sealing chained
   *     records, i.e. rewriting history).
   * Output: every record that would change (before/after), the tail the new records would extend, and a
   * digest of exactly that plan so an apply can be bound to what was reviewed.
   */
  async planLegacyBackfill() {
    const findings = [];
    const finding = (code, detail, record) => {
      if (findings.length < MAX_BACKFILL_FINDINGS) findings.push({ code, detail, recordId: record ? String(record._id) : null, sequenceNumber: record?.sequenceNumber ?? null });
    };
    if (await heads().findOne({ _id: HEAD_ID }, { projection: { _id: 1 } })) {
      finding('HEAD_ALREADY_INITIALIZED', 'the chain head exists: records filled in now would bypass it. Legacy records must be migrated BEFORE the head is initialized', null);
    }

    // Pass 1: the chained records must form a valid chain from genesis (same rules as verifyAuditChain).
    let expectedSequence = 1;
    let previousHash = GENESIS_HASH;
    let tail = null;
    let chained = 0;
    const chainedCursor = AuditLog.find({ sequenceNumber: { $ne: null }, hash: { $ne: null }, previousHash: { $ne: null } }).sort({ sequenceNumber: 1 }).lean().cursor();
    try {
      for await (const record of chainedCursor) {
        chained += 1;
        if (record.sequenceNumber !== expectedSequence) { finding('CHAIN_GAP_OR_DUPLICATE', `expected sequence ${expectedSequence}, found ${record.sequenceNumber}`, record); break; }
        if (record.previousHash !== previousHash) { finding('CHAIN_LINK_BROKEN', 'previousHash does not match the preceding record', record); break; }
        let recalculated;
        try { recalculated = calculateAuditHash(hashPayload(record)); } catch (error) { finding('CHAIN_RECORD_MALFORMED', `hash cannot be recalculated: ${error.message}`, record); break; }
        if (record.hash !== recalculated) { finding('CHAIN_HASH_MISMATCH', 'stored hash does not match the recalculated hash', record); break; }
        previousHash = record.hash;
        expectedSequence += 1;
        tail = record;
      }
    } finally {
      await chainedCursor.close();
    }

    // Pass 2: records without chain fields, in the order the chain will take them.
    const changes = [];
    let examined = 0;
    // (createdAt, _id) ascending: the order the original chain would have taken these records in.
    const sortsAfter = (record, other) => {
      const delta = new Date(record.createdAt).getTime() - new Date(other.createdAt).getTime();
      return delta !== 0 ? delta > 0 : String(record._id) > String(other._id);
    };
    const legacyCursor = AuditLog.find(unchainedFilter()).sort({ createdAt: 1, _id: 1 }).lean().cursor();
    try {
      for await (const record of legacyCursor) {
        examined += 1;
        if ([record.sequenceNumber, record.hash, record.previousHash].some((value) => value !== null && value !== undefined)) {
          finding('PARTIALLY_CHAINED', 'some, but not all, chain fields are set', record);
          continue;
        }
        const createdAt = record.createdAt instanceof Date ? record.createdAt : null;
        if (!createdAt || Number.isNaN(createdAt.getTime()) || !record.action || !record.actorId || !record.entityType || !record.entityId) {
          finding('RECORD_MALFORMED', 'createdAt, action, actorId, entityType or entityId is missing or invalid', record);
          continue;
        }
        if (tail && changes.length === 0 && !sortsAfter(record, tail)) {
          finding('UNCHAINED_BEFORE_CHAIN_TAIL', 'sorts at or before the chain tail: filling it would require re-sealing chained records', record);
          continue;
        }
        const sequenceNumber = expectedSequence + changes.length;
        const prior = changes.length > 0 ? changes[changes.length - 1].hash : previousHash;
        let hash;
        try { hash = calculateAuditHash(hashPayload({ ...record, sequenceNumber, previousHash: prior })); } catch (error) { finding('RECORD_MALFORMED', `hash cannot be calculated: ${error.message}`, record); continue; }
        changes.push({ id: record._id, recordId: String(record._id), action: record.action, createdAt: createdAt.toISOString(), sequenceNumber, previousHash: prior, hash });
      }
    } finally {
      await legacyCursor.close();
    }

    const tailSummary = tail ? { sequenceNumber: tail.sequenceNumber, hash: tail.hash } : null;
    const digest = crypto.createHash('sha256').update(JSON.stringify({
      tail: tailSummary,
      changes: changes.map((change) => [change.recordId, change.sequenceNumber, change.previousHash, change.hash]),
    })).digest('hex');
    return { ok: findings.length === 0, findings, counts: { chained, unchained: examined, wouldChange: changes.length }, tail: tailSummary, changes, digest };
  },

  /**
   * The ONLY writer of legacy chain fields. Runs the same preflight as planLegacyBackfill and refuses
   * unless the plan is acceptable AND its digest equals the one the operator reviewed. Each record is
   * filled with a conditional update that matches only a record that is still completely unchained, one
   * record at a time in chain order, so an interruption leaves a valid chained prefix and a re-run
   * continues from it. Nothing already chained is ever modified. Uses the raw collection because the model
   * is append-only by design. Never called at startup: run it from scripts/audit-chain-legacy-backfill.mjs
   * with writers drained.
   */
  async applyLegacyBackfill({ expectedDigest } = {}) {
    const plan = await this.planLegacyBackfill();
    if (!plan.ok) {
      throw Object.assign(new Error(`Legacy audit backfill refused: ${plan.findings.map((f) => f.code).join(', ')}.`), { code: 'LEGACY_BACKFILL_REFUSED', findings: plan.findings });
    }
    if (!expectedDigest || expectedDigest !== plan.digest) {
      throw Object.assign(new Error('Legacy audit backfill refused: the plan digest does not match the reviewed plan (the data changed, or no digest was given).'), { code: 'LEGACY_BACKFILL_DIGEST_MISMATCH', digest: plan.digest });
    }
    let applied = 0;
    for (const change of plan.changes) {
      let result;
      try {
        result = await AuditLog.collection.updateOne(
          { _id: change.id, $and: [{ sequenceNumber: null }, { hash: null }, { previousHash: null }] },
          { $set: { sequenceNumber: change.sequenceNumber, previousHash: change.previousHash, hash: change.hash } },
        );
      } catch (error) {
        throw Object.assign(error, { applied, stoppedAt: change.recordId });
      }
      if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
        throw Object.assign(new Error(`Legacy audit backfill stopped: record ${change.recordId} changed while the migration ran.`), { code: 'LEGACY_BACKFILL_CONFLICT', applied, stoppedAt: change.recordId });
      }
      applied += 1;
    }
    return { applied, digest: plan.digest, verification: await this.verifyAuditChain() };
  },
};

export default auditService;
