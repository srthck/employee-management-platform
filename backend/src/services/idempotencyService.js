import crypto from 'node:crypto';
import IdempotencyRecord from '../models/IdempotencyRecord.js';
import logger from '../utils/logger.js';

/**
 * The durable side of one logical operation (one Idempotency-Key).
 *
 * Every transaction a request commits also updates the operation's record, inside that transaction and conditional on the
 * request's lock token. Two guarantees follow from the database, not from the process:
 *   evidence  the record says a transaction committed exactly when that transaction committed, so a crash or a lost commit
 *             reply can be told apart from "nothing happened";
 *   fencing   a request whose lock was taken over can no longer commit: its token no longer matches, so its transaction aborts.
 *
 * See docs/integrity/IDEMPOTENCY.md.
 */

const COMMIT_HISTORY_LIMIT = 100;
const EVIDENCE_POLL_MS = [0, 100, 200, 400, 800];
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const lockLostError = () =>
  Object.assign(
    new Error('This request lost its idempotency lock to a newer attempt. Nothing from this transaction was written.'),
    { statusCode: 409, code: 'IDEMPOTENCY_LOCK_LOST' }
  );

export function createOperation({ userId, key, lockToken, operationId }) {
  const operation = {
    operationId,
    committed: 0,
    outcomeUnknown: false,
    closed: false,

    /** Runs inside the business transaction, last, so it commits or aborts with it. Returns the transaction's marker. */
    async recordInTransaction(session, label) {
      if (operation.closed) return null;
      const marker = crypto.randomUUID();
      const recorded = await IdempotencyRecord.updateOne(
        { userId, key, lockToken, status: 'IN_PROGRESS' },
        {
          $inc: { committedTransactions: 1 },
          $push: { commits: { $each: [{ marker, label, at: new Date() }], $slice: -COMMIT_HISTORY_LIMIT } },
        },
        session ? { session } : {}
      );
      if (recorded.matchedCount !== 1) throw lockLostError();
      return marker;
    },

    /**
     * True only when durable evidence proves that transaction committed. Absence proves nothing: a majority read can run ahead
     * of the commit point, so this polls briefly, and a commit that appears later is still found by the retry through the record.
     */
    async isCommitted(marker) {
      for (const delayMs of EVIDENCE_POLL_MS) {
        await sleep(delayMs);
        try {
          const found = await IdempotencyRecord.exists({ userId, key, 'commits.marker': marker })
            .setOptions({ readConcern: { level: 'majority' } });
          if (found) return true;
        } catch (err) {
          logger.error('Could not read the operation record to settle a commit', { operationId, error: err.message });
        }
      }
      return false;
    },

    noteCommitted() { operation.committed += 1; },
    noteOutcomeUnknown() { operation.outcomeUnknown = true; },
    close() { operation.closed = true; },
  };
  return operation;
}

export default { createOperation };
