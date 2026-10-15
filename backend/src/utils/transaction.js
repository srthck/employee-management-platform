import mongoose from 'mongoose';
import config from '../config/environment.js';
import logger from './logger.js';
import { auditChainContentionError, backoffDelayMs, isAuditChainCollision, isAuditChainConflict, sleep } from './auditErrors.js';

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
  err?.code === 112 || // WriteConflict
  isAuditChainCollision(err); // sequenceNumber or previousHash: another writer took the position

export async function supportsTransactions() {
  if (cachedCapability !== null) return cachedCapability;
  const db = mongoose.connection.db;
  // Do not cache while disconnected; the answer is unknown, not "no".
  if (mongoose.connection.readyState !== 1 || !db) return false;
  try {
    const hello = await db.admin().command({ hello: 1 });
    cachedCapability = Boolean(hello.setName || hello.msg === 'isdbgrid');
  } catch {
    cachedCapability = false;
  }
  return cachedCapability;
}

export function resetTransactionCapabilityCache() {
  cachedCapability = null;
  warnedAboutFallback = false;
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
export async function runInTransaction(work, { label = 'transaction', maxAttempts = DEFAULT_MAX_ATTEMPTS, maxWaitMs = DEFAULT_MAX_WAIT_MS } = {}) {
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
    return work(null);
  }

  const startedAt = Date.now();
  for (let attempt = 1; ; attempt += 1) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction({
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      });
      const result = await work(session);
      await commitWithRetry(session);
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
