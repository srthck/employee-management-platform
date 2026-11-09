# Ambiguous commits

MongoDB can report `UnknownTransactionCommitResult` after the server has applied a transaction, or when it never did. The error is not evidence of either. This document describes what PayGuard does then.

## What the code does

`commitResolvingOutcome` in [`utils/transaction.js`](../../backend/src/utils/transaction.js):

1. A commit failure **without** the `UnknownTransactionCommitResult` label is a definite failure. It is rethrown unchanged and the normal retry policy applies.
2. With the label, and with an operation attached to the request, it looks for this transaction's marker in the idempotency record using a majority read, polling briefly (0, 100, 200, 400 and 800 ms).
3. If the marker is found, the transaction committed. The request carries on as if the commit had returned.
4. If it is not found, the outcome stays unknown. The caller receives **503 `COMMIT_OUTCOME_UNKNOWN`** (`retryable: false`, with `operationId` when there is one), the operation is noted as unknown, and the callback is **not** re-run.

Absence proves nothing, which is why step 4 does not conclude "aborted": a majority read can run ahead of the commit point. The polling exists because a real fault showed exactly this. The one-shot read in the first version missed a commit that had been applied; the simulated test had passed it.

## What happens next

The record moves to `UNKNOWN_COMMIT` and a retry with the same key gets 409 `IDEMPOTENCY_OUTCOME_UNKNOWN`. If the marker later becomes visible, the same retry gets 409 `IDEMPOTENCY_PRIOR_ATTEMPT_COMMITTED` instead, because `committedTransactions` has become positive. In neither case is the handler run again.

The message tells the person to check the current state before trying again. That check is a human one: there is **no automatic resolver**, and `UNKNOWN_COMMIT` is never cleared by the system. An earlier design with an endpoint-specific resolver and `CONFIRMED_*` states was removed before it was wired to anything; the record itself is the evidence, and a general reconciliation procedure would need its own review.

## Evidence

Five tests in `backend/test_commit_ambiguity.js` run against a disposable `mongod` with `enableTestCommands=1`, using the `failCommand` failpoint on `commitTransaction`:

| Fault | Reality | Observed |
|---|---|---|
| `writeConcernError`, with a key | Applied; every reply is an error | Settled as committed from the marker; the request succeeds and a retry replays |
| `writeConcernError`, no key | Applied | 503 `COMMIT_OUTCOME_UNKNOWN`, and the change is in fact there |
| `closeConnection` | Never applied | 503 `COMMIT_OUTCOME_UNKNOWN`, no duplicate, and the key cannot be re-run while the outcome is open |
| Abandoned commit, then the server discards the transaction | Never applied | The operation record it held can be written again |
| `errorCode 112` with `TransientTransactionError` only | Refused (definite) | Retried as a whole; applied exactly once; never reported as unknown |

These are fault-injection results on one single-node replica set. They are not evidence about failover, a multi-node majority or a network partition.

## Operational limits

- The bounded write that records `UNKNOWN_COMMIT` can time out while an abandoned transaction still holds the document. The record then stays `IN_PROGRESS` with nothing committed, and the lock outlives that transaction (the server discards it first), so a later takeover is safe only because the lock period exceeds `transactionLifetimeLimitSeconds`. **If that server parameter is raised above the five-minute lock, this reasoning needs revisiting.**
- Only the outermost commit records; a nested transaction during a keyed request is refused (see IDEMPOTENCY.md).
- A commit the server definitely refuses (no `UnknownTransactionCommitResult` label, for example a transient write conflict) is not ambiguous: the transaction is retried as a whole. A real-fault test pins this.
- A request with no operation still gets the explicit 503, but nothing durable can settle it.
