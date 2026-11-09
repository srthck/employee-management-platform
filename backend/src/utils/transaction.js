import { AsyncLocalStorage } from 'node:async_hooks';
import mongoose from 'mongoose';
import config from '../config/environment.js';
import logger from './logger.js';
import { currentOperation } from './operationContext.js';
import { auditChainContentionError, backoffDelayMs, isAuditChainConflict, sleep } from './auditErrors.js';

/**
 * Transaction helper — the single place that opens MongoDB transactions.
 *
 * Why this exists:
 *   Multi-document transactions only work on a replica set or sharded
 *   cluster. On a standalone mongod every `session.startTransaction()` write
 *   fails with "Transaction numbers are only allowed on a replica set member",
 *   which previously meant no payroll run could ever be finalized locally.
 *
 * Behaviour:
 *   - Replica set / mongos: run `work(session)` inside a real transaction,
 *     retrying on TransientTransactionError (write conflicts, audit chain
 *     collisions) with jittered exponential back-off until `maxAttempts` or the
 *     `maxWaitMs` deadline, and retrying the commit on UnknownTransactionCommitResult.
 *     A commit that stays unconfirmed is never reported as a failure that wrote nothing: durable evidence on the
 *     request's idempotency record settles it as committed, otherwise the caller gets 503 COMMIT_OUTCOME_UNKNOWN.
 *     Several writers racing for the audit chain's next position is normal under
 *     load; back-off lets them take turns instead of failing together. When the
 *     budget is spent on audit-chain collisions the outcome is the explicit,
 *     retryable 503 AUDIT_CHAIN_CONTENTION, never a raw duplicate-key error.
 *   - Standalone + REQUIRE_TRANSACTIONS=true (default in production): refuse
 *     with 503. Accounting writes are never silently made non-atomic.
 *   - Standalone + development/test: run `work(null)` without a session and
 *     log a one-time warning. Repositories and the audit service already accept
 *     a null session.
 */

const COMMIT_ATTEMPTS = 5;
const DEFAULT_MAX_ATTEMPTS = 40;
const DEFAULT_MAX_WAIT_MS = 15000;
const BACKOFF_BASE_MS = 2;
const BACKOFF_CAP_MS = 150;
let cachedCapability = null;
let warnedAboutFallback = false;

const hasLabel = (err, label) => {
  const labels = err?.errorLabels;
  if (!labels) return false;
  if (typeof labels.has === 'function') return labels.has(label);
  return Array.isArray(labels) && labels.includes(label);
};

const isRetryable = (err) =>
  hasLabel(err, 'TransientTransactionError') ||
  err?.code === 112 || // WriteConflict (including on the audit chain head document)
  isAuditChainConflict(err); // a conflict raised by the audit append itself: another writer advanced the head first

// The session of the transaction whose callback is currently running in this async context. It lets audit code
// refuse to open a SECOND, independent transaction from inside a business transaction (the second would commit or
// block independently of the first). null session = the development fallback (no real transactions).
const transactionContext = new AsyncLocalStorage();

/** True while the caller runs inside a runInTransaction callback (even when that callback received no session). */
export const inTransactionContext = () => transactionContext.getStore() !== undefined;

/**
 * True while the caller runs inside a transaction that was itself started from inside ANOTHER transaction's callback. Such an
 * inner transaction commits or blocks independently of the outer one; auditService refuses audited appends in it (it would
 * contend with its parent on the single audit chain head).
 */
export const inNestedTransactionContext = () => transactionContext.getStore()?.nested === true;

/**
 * The per-process TRANSACTION LANE: transactions of this process take turns (FIFO), each holding the lane for all of its
 * attempts. Why: every audited transaction advances ONE head document, and MongoDB fixes a transaction's snapshot at its
 * first operation, so any other transaction that commits a head advance during its lifetime makes it conflict and re-run its
 * whole callback. Measured with 100 concurrent audited transactions: ~19 callback executions per commit, 14-20% refused;
 * with the lane: exactly 1 execution per commit and none refused (docs/integrity/AUDIT-CHAIN-HEAD.md).
 *
 * It is a LIVENESS mechanism only. Safety never depends on it: the conditional head update arbitrates any two writers, in
 * this process or another (tests switch the lane off to exercise real contention). Transactions of OTHER processes still
 * contend on the head; the lane removes only the contention a process has with itself.
 *
 * Trade-off, stated: a long transaction in this process delays the others in this process (queue wait is bounded by
 * `maxQueueWaitMs`, after which the waiter fails with a retryable 503 TRANSACTION_LANE_BUSY and nothing is written).
 */
export const transactionLane = { enabled: true, maxQueueWaitMs: 60000 };
const laneQueue = [];
let laneBusy = false;
let laneHolder = null; // { label, since } of the transaction that holds the lane right now
function acquireLane(maxWaitMs, label) {
  if (!laneBusy) {
    laneBusy = true;
    laneHolder = { label, since: Date.now() };
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, timer: null, label };
    waiter.timer = setTimeout(() => {
      const index = laneQueue.indexOf(waiter);
      if (index >= 0) laneQueue.splice(index, 1);
      reject(Object.assign(new Error(`This process is running another transaction that has not finished after ${maxWaitMs} ms (${label}). Nothing was written; retry.`), { statusCode: 503, code: 'TRANSACTION_LANE_BUSY', retryable: true }));
    }, maxWaitMs);
    laneQueue.push(waiter);
  });
}
function releaseLane() {
  const next = laneQueue.shift();
  if (next) {
    clearTimeout(next.timer);
    laneHolder = { label: next.label, since: Date.now() };
    next.resolve(); // hand the lane over; it stays busy
  } else {
    laneBusy = false;
    laneHolder = null;
  }
}

/** Observability for readiness and operators: is the lane busy, who holds it and for how long, how many wait. */
export function transactionLaneStatus() {
  return {
    enabled: transactionLane.enabled,
    busy: laneBusy,
    queued: laneQueue.length,
    maxQueueWaitMs: transactionLane.maxQueueWaitMs,
    holder: laneHolder ? { label: laneHolder.label, heldMs: Date.now() - laneHolder.since } : null,
  };
}

export async function supportsTransactions() {
  if (cachedCapability !== null) return cachedCapability;
  const db = mongoose.connection.db;
  // Do not cache while disconnected; the answer is unknown, not "no".
  if (mongoose.connection.readyState !== 1 || !db) return false;
  try {
    const hello = await db.admin().command({ hello: 1 });
    cachedCapability = Boolean(hello.setName || hello.msg === 'isdbgrid');
  } catch {
    // A failed probe is UNKNOWN, not "no transactions". Caching it would make every transaction be refused (or, under the
    // development opt-out, silently run non-atomically) for the rest of the process after a single network blip.
    return false;
  }
  return cachedCapability;
}

/**
 * Destructive or irreversible maintenance must not depend on application configuration: even where a
 * development opt-out lets ordinary requests run without transactions, such a tool needs REAL
 * multi-document transactions or it refuses. Throws 503 TRANSACTIONS_UNAVAILABLE unless the connected
 * deployment is a replica set member or a mongos.
 */
export async function assertRealTransactions() {
  if (await supportsTransactions()) return;
  throw Object.assign(
    new Error('This operation requires real MongoDB transactions (a replica set or sharded cluster); the connected deployment does not support them. Application configuration cannot waive this.'),
    { statusCode: 503, code: 'TRANSACTIONS_UNAVAILABLE', retryable: false }
  );
}

export function resetTransactionCapabilityCache() {
  cachedCapability = null;
  warnedAboutFallback = false;
}

const commitOutcomeUnknownError = (label, cause, operationId) => Object.assign(
  new Error('The database did not confirm whether this change was saved. It may have been: check the current state before trying again.'),
  { statusCode: 503, code: 'COMMIT_OUTCOME_UNKNOWN', retryable: false, label, operationId: operationId || undefined, cause },
);

/**
 * A transaction started inside another one's callback commits on its own. Inside a keyed operation that commit would be
 * invisible to the operation record (only the outermost transaction writes it), so a failure after it could free the key and
 * a retry could apply it twice. No production path does this; refusing it keeps the at-most-once guarantee true.
 */
const nestedOperationTransactionError = (label, operationId) => Object.assign(
  new Error('A transaction cannot be started inside another transaction during this request. Nothing from it was written.'),
  { statusCode: 500, code: 'IDEMPOTENCY_NESTED_TRANSACTION', label, operationId: operationId || undefined },
);

/** Commit, settling an unconfirmed outcome from the operation's durable record when there is one. */
async function commitResolvingOutcome(session, label, operation, marker) {
  try {
    await commitWithRetry(session);
  } catch (err) {
    if (!hasLabel(err, 'UnknownTransactionCommitResult')) throw err;
    if (marker && await operation.isCommitted(marker)) {
      logger.warn('Unconfirmed commit settled as committed from the operation record', { label, operationId: operation.operationId });
      return;
    }
    operation?.noteOutcomeUnknown();
    logger.error('Commit outcome unknown', { label, operationId: operation?.operationId, error: err.message });
    throw commitOutcomeUnknownError(label, err, operation?.operationId);
  }
}

async function commitWithRetry(session) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await session.commitTransaction();
      return;
    } catch (err) {
      if (attempt < COMMIT_ATTEMPTS && hasLabel(err, 'UnknownTransactionCommitResult')) continue;
      throw err;
    }
  }
}

/**
 * @template T
 * @param {(session: import('mongoose').ClientSession | null) => Promise<T>} work
 *   Must be safe to re-run: every attempt starts from a rolled-back state.
 * @param {{ label?: string, maxAttempts?: number, maxWaitMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function runInTransaction(work, options = {}) {
  const { label = 'transaction', lane = true } = options;
  const holder = transactionContext.getStore();
  const nested = holder !== undefined; // started from inside another transaction's callback
  // A transaction started from inside another one (which already holds the lane) must not wait for it: that would deadlock.
  const takeLane = lane && transactionLane.enabled && !holder?.lane;
  if (takeLane && (await supportsTransactions())) {
    await acquireLane(transactionLane.maxQueueWaitMs, label);
    try {
      return await runAttempts(work, options, true, nested);
    } finally {
      releaseLane();
    }
  }
  return runAttempts(work, options, Boolean(holder?.lane), nested);
}

async function runAttempts(work, { label = 'transaction', maxAttempts = DEFAULT_MAX_ATTEMPTS, maxWaitMs = DEFAULT_MAX_WAIT_MS } = {}, holdsLane = false, nested = false) {
  // Only the outermost transaction writes the operation record, so a nested one inside a keyed operation is refused.
  if (nested && currentOperation()) throw nestedOperationTransactionError(label, currentOperation().operationId);
  const operation = nested ? undefined : currentOperation();
  if (!(await supportsTransactions())) {
    if (config.requireTransactions) {
      throw Object.assign(
        new Error(
          'This operation requires MongoDB transactions. Connect to a replica set ' +
          '(a single-node replica set is sufficient) or set REQUIRE_TRANSACTIONS=false for local development.'
        ),
        { statusCode: 503 }
      );
    }
    if (!warnedAboutFallback) {
      warnedAboutFallback = true;
      logger.warn('MongoDB transactions unavailable; running without atomicity (development only)', { label });
    }
    const result = await transactionContext.run({ session: null, lane: holdsLane, nested }, () => work(null));
    if (operation) { await operation.recordInTransaction(null, label); operation.noteCommitted(); }
    return result;
  }

  const startedAt = Date.now();
  for (let attempt = 1; ; attempt += 1) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction({
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      });
      const result = await transactionContext.run({ session, lane: holdsLane, nested }, () => work(session));
      const marker = operation ? await operation.recordInTransaction(session, label) : null;
      await commitResolvingOutcome(session, label, operation, marker);
      operation?.noteCommitted();
      return result;
    } catch (err) {
      if (session.inTransaction()) {
        await session.abortTransaction().catch(() => {});
      }
      if (isRetryable(err)) {
        const waited = Date.now() - startedAt;
        if (attempt < maxAttempts && waited < maxWaitMs) {
          logger.debug('Retrying transaction', { label, attempt, code: err.code });
          await sleep(backoffDelayMs(attempt, BACKOFF_BASE_MS, BACKOFF_CAP_MS));
          continue;
        }
        if (isAuditChainConflict(err)) throw auditChainContentionError(attempt, waited, err);
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }
}
