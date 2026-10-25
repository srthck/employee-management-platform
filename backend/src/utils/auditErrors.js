/**
 * Shared vocabulary for audit-chain append failures and retry back-off.
 *
 * The audit chain has one writer-contended resource: the head document (docs/integrity/AUDIT-CHAIN-HEAD.md). Two
 * transactions cannot both advance it: the loser gets a WriteConflict (or a non-matching conditional update) and its
 * transaction is re-run from a fresh head, up to a bounded budget, after which the outcome is the explicit retryable 503
 * AUDIT_CHAIN_CONTENTION.
 *
 * A duplicate key from the audit collection's own unique indexes is a DIFFERENT event. Raised for a record the head had just
 * declared free, it means a writer outside the protocol wrote to the chain: auditService turns it into the non-retryable
 * AUDIT_CHAIN_HEAD_INCONSISTENT (retrying cannot help). isAuditChainCollision only IDENTIFIES such a duplicate key.
 */

export const AUDIT_CHAIN_CONTENTION = 'AUDIT_CHAIN_CONTENTION';

/**
 * True for a duplicate-key refusal raised by the audit collection's own unique indexes. Identified by the
 * collection named in the server's message AND the indexed key, never by free text alone: an unrelated duplicate
 * (another collection, or a user value that merely contains the words) is not an audit-chain event.
 */
export const isAuditChainCollision = (err) =>
  err?.code === 11000
  && /collection: [^\s]*\.auditlogs\b/.test(err?.message || '')
  && Boolean(err?.keyPattern?.sequenceNumber || err?.keyPattern?.previousHash || err?.keyPattern?.headVersion);

/** A transient transaction conflict (WriteConflict / TransientTransactionError). */
export const isTransientTransactionConflict = (err) => {
  const labels = err?.errorLabels;
  const labelled = labels && (typeof labels.has === 'function' ? labels.has('TransientTransactionError') : Array.isArray(labels) && labels.includes('TransientTransactionError'));
  return err?.code === 112 || Boolean(labelled);
};

/**
 * Inside a transaction the audit insert's refusal surfaces as a WriteConflict, not as E11000 (the other
 * writer has not committed yet). The audit service marks such a conflict so that, when the transaction's retry
 * budget is spent, the outcome can be the explicit AUDIT_CHAIN_CONTENTION instead of a bare driver error.
 */
export const markAuditChainConflict = (err) => { try { err.auditChainConflict = true; } catch { /* frozen error: leave it */ } return err; };
export const isAuditChainConflict = (err) => isAuditChainCollision(err) || err?.auditChainConflict === true;

/** Exponential back-off with full jitter: uniform in [1, min(cap, base * 2^(attempt-1))] ms. */
export const backoffDelayMs = (attempt, baseMs, capMs) =>
  Math.max(1, Math.floor(Math.random() * Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1))));

export const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The append could not be made before the deadline because other writers kept winning. Nothing was written. */
export const auditChainContentionError = (attempts, waitedMs, cause) => Object.assign(
  new Error(
    `The audit chain is busy: ${attempts} append attempt(s) over ${waitedMs} ms lost to concurrent writers. ` +
    'Nothing was written; retry the operation.'
  ),
  { statusCode: 503, code: AUDIT_CHAIN_CONTENTION, retryable: true, attempts, cause }
);

// ─── Errors of the transactional head protocol (see auditService and docs/integrity/AUDIT-CHAIN-HEAD.md) ───

/** An append was attempted without a caller-owned, active transaction. Programming error: nothing was written. */
export const auditSessionRequiredError = (detail) => Object.assign(
  new Error(`An audit append needs a session with an active transaction (${detail}). Pass the business transaction's session, or use auditService.logStandalone for an audit-only event. Nothing was written.`),
  { statusCode: 500, code: 'AUDIT_SESSION_REQUIRED', retryable: false }
);

/**
 * An audit append would run in a second, independent transaction nested inside another transaction's callback. It commits or
 * blocks separately from the outer transaction and contends with it on the one head document. Programming error: nothing was written.
 * @param {'standalone'|'nested-log'} kind logStandalone inside a callback, or log() with the session of a nested runInTransaction
 */
export const auditNestedTransactionError = (kind = 'standalone') => Object.assign(
  new Error(kind === 'nested-log'
    ? 'auditService.log was called with the session of a transaction that was started from inside another transaction callback. That inner transaction commits or blocks separately from the outer one and contends with it on the audit chain head (it stalls until its retry budget is spent, or its effects are committed twice when the outer callback re-runs). Run the audited work in the OUTER transaction by passing the outer session, or start the inner transaction outside the outer callback. Nothing was written.'
    : 'auditService.logStandalone was called inside a transaction callback. It would open a second, independent transaction that commits or blocks separately from the business transaction; pass the callback\'s session to auditService.log instead. Nothing was written.'),
  { statusCode: 500, code: 'AUDIT_NESTED_TRANSACTION', retryable: false }
);

/** The chain has no authoritative head (and may not create one here). Nothing was written. */
export const auditChainNotInitializedError = (detail) => Object.assign(
  new Error(`The audit chain head is not initialized (${detail}). An operator must run scripts/audit-chain-head.mjs before audited operations can proceed. Nothing was written.`),
  { statusCode: 503, code: 'AUDIT_CHAIN_NOT_INITIALIZED', retryable: false }
);

/** The head and the chain disagree (a writer bypassed the protocol, or raw edits). Retrying cannot help. Nothing was written. */
export const auditChainInconsistentError = (detail, cause) => Object.assign(
  new Error(`The audit chain head and the audit records disagree (${detail}). Appending is refused until an operator investigates; retrying will not help. Nothing was written.`),
  { statusCode: 503, code: 'AUDIT_CHAIN_HEAD_INCONSISTENT', retryable: false, cause }
);

/** The conditional head update did not match: another transaction advanced the head first. Retryable by the transaction helper. */
export const auditChainHeadConflictError = (detail) => markAuditChainConflict(Object.assign(
  new Error(`The audit chain head moved while this transaction was appending (${detail}).`),
  { code: 'AUDIT_CHAIN_HEAD_CONFLICT', retryable: true }
));
