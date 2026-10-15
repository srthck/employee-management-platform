/**
 * Shared vocabulary for audit-chain append failures and retry back-off.
 *
 * The audit chain has one writer-contended resource: "the next sequence number / the successor of the
 * current head". The database refuses a second record for it (unique sequenceNumber AND unique
 * previousHash). A refusal therefore means "another writer committed first", never "the data is bad",
 * and the right response is to wait a little and try again from the new head, until a deadline.
 */

export const AUDIT_CHAIN_CONTENTION = 'AUDIT_CHAIN_CONTENTION';
export const AUDIT_CHAIN_INDEX_UNAVAILABLE = 'AUDIT_CHAIN_INDEX_UNAVAILABLE';

/** True for a duplicate-key refusal of the chain's two uniqueness guards. */
export const isAuditChainCollision = (err) =>
  err?.code === 11000 && Boolean(
    err?.keyPattern?.sequenceNumber
    || err?.keyPattern?.previousHash
    || /sequenceNumber|previousHash/.test(err?.message || '')
  );

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

/** The chain's uniqueness guards are missing and cannot be restored, so appending is refused. Nothing was written. */
export const auditChainIndexError = (detail, cause) => Object.assign(
  new Error(`The audit chain cannot accept new records: ${detail} Appending is refused until an operator resolves it.`),
  { statusCode: 503, code: AUDIT_CHAIN_INDEX_UNAVAILABLE, retryable: false, cause }
);
