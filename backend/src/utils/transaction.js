import mongoose from 'mongoose';
import config from '../config/environment.js';
import logger from './logger.js';

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
 *     retrying on TransientTransactionError (write conflicts, audit sequence
 *     collisions) and retrying the commit on UnknownTransactionCommitResult.
 *   - Standalone + REQUIRE_TRANSACTIONS=true (default in production): refuse
 *     with 503. Accounting writes are never silently made non-atomic.
 *   - Standalone + development/test: run `work(null)` without a session and
 *     log a one-time warning. Repositories and the audit service already accept
 *     a null session.
 */

const MAX_ATTEMPTS = 5;
let cachedCapability = null;
let warnedAboutFallback = false;

const hasLabel = (err, label) => {
  const labels = err?.errorLabels;
  if (!labels) return false;
  if (typeof labels.has === 'function') return labels.has(label);
  return Array.isArray(labels) && labels.includes(label);
};

const isAuditSequenceCollision = (err) =>
  err?.code === 11000 && Boolean(err?.keyPattern?.sequenceNumber);

const isRetryable = (err) =>
  hasLabel(err, 'TransientTransactionError') ||
  err?.code === 112 || // WriteConflict
  isAuditSequenceCollision(err);

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
      if (attempt < MAX_ATTEMPTS && hasLabel(err, 'UnknownTransactionCommitResult')) continue;
      throw err;
    }
  }
}

/**
 * @template T
 * @param {(session: import('mongoose').ClientSession | null) => Promise<T>} work
 *   Must be safe to re-run: every attempt starts from a rolled-back state.
 * @param {{ label?: string }} [options]
 * @returns {Promise<T>}
 */
export async function runInTransaction(work, { label = 'transaction' } = {}) {
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
      if (attempt < MAX_ATTEMPTS && isRetryable(err)) {
        logger.debug('Retrying transaction', { label, attempt, code: err.code });
        continue;
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }
}
