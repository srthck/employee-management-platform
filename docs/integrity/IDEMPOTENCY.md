# Idempotency

How a retried state-changing request is prevented from applying twice. For what happens when the database does not confirm a commit, see [AMBIGUOUS-COMMIT-RECOVERY.md](AMBIGUOUS-COMMIT-RECOVERY.md).

Code: [`middleware/idempotency.js`](../../backend/src/middleware/idempotency.js), [`services/idempotencyService.js`](../../backend/src/services/idempotencyService.js), [`utils/transaction.js`](../../backend/src/utils/transaction.js), [`models/IdempotencyRecord.js`](../../backend/src/models/IdempotencyRecord.js). Tests: `backend/test_atomicity.js` group B, `backend/test_commit_ambiguity.js`.

## Contract

Routes using `idempotent()` accept an `Idempotency-Key` header; keys are scoped per user. The request fingerprint is the method, original URL and key-sorted JSON body.

| Situation | Response |
|---|---|
| New key | The handler runs |
| Same key, same request, finished with a status below 500 | The stored response, with `Idempotent-Replayed: true` |
| Same key, different request | 422 `IDEMPOTENCY_KEY_REUSED` |
| Same key, still running | 409 `IDEMPOTENCY_REQUEST_IN_PROGRESS`, with `Retry-After` |
| An earlier attempt committed work and did not finish | 409 `IDEMPOTENCY_PRIOR_ATTEMPT_COMMITTED`, with `operationId` |
| An earlier attempt's commit is unconfirmed | 409 `IDEMPOTENCY_OUTCOME_UNKNOWN`, with `operationId` |
| A 5xx with nothing committed and nothing unconfirmed | The key is released and a retry runs normally |

The handler is never re-run in the two 409 cases that name an earlier attempt: the client must look at the current state and, if more is needed, make a new request with a new key.

A request without a key on an optional route has no operation record. It keeps all the transaction guarantees, and a lost commit reply still returns `COMMIT_OUTCOME_UNKNOWN`, but there is no `operationId` and no retry protection.

## Evidence and fencing

The record is updated **inside each business transaction**, as its last write, and conditional on the attempt's `lockToken`. Both guarantees below therefore come from the database rather than from the process:

- **Evidence.** The record says a transaction committed exactly when it did. `committedTransactions` and `commits[]` (a per-transaction marker, its label and a time) survive a crash or a lost reply, so "committed" can be told apart from "nothing happened". `commits` keeps the last 100 entries; `committedTransactions` keeps the full count.
- **Fencing.** A takeover replaces `lockToken`. A superseded attempt then matches no record, throws 409 `IDEMPOTENCY_LOCK_LOST`, and its transaction aborts, so a slow attempt cannot commit alongside its replacement.

## State machine

```text
             claim
  (none) ----------> IN_PROGRESS ---- response below 500 ----------> COMPLETED
    ^                 |  |  ^
    |                 |  |  | takeover: lock expired AND committedTransactions = 0
    | 5xx, nothing    |  |  +--(new lockToken)
    | committed       |  |
    +-----------------+  +--- commit unconfirmed, 5xx -------------> UNKNOWN_COMMIT
                         |
                         +--- committed > 0, 5xx ---> IN_PROGRESS, lock expired now
                                                      (never re-run; retry gets 409)
```

`COMPLETED` and `UNKNOWN_COMMIT` are terminal for that key. No code path re-opens `UNKNOWN_COMMIT` and none clears it automatically.

## A multi-transaction request

A request can commit several transactions and then fail. The first commit makes the operation partly applied, and running it again would apply that part twice, so a later 5xx does not release the key. This is why the release condition re-reads the durable counter rather than trusting the process.

## Nested transactions and work after the response

- Only the outermost transaction writes the operation record. A transaction started inside another one's callback commits on its own, so its commit would be invisible to the record: during a keyed request it is therefore **refused** with 500 `IDEMPOTENCY_NESTED_TRANSACTION`, and the enclosing transaction aborts. A full-suite trace (2026-11-09) found no production path that nests; the only nested transactions were the three that tests create on purpose.
- Once the handler has responded, the operation is closed. A transaction the handler runs afterwards commits on its own and is not attributed to the operation.

## Limits

- The middleware stores the outcome when the handler calls `res.json`. A handler that responds some other way, or a process that dies, leaves the record to lock expiry (five minutes) and then to the rules above.
- Writes outside `runInTransaction` are not covered by the marker. In the fallback where a test or development deployment has transactions disabled, the record is updated separately and the evidence guarantee does not hold; production requires transactions.
- The fingerprint covers the URL and body. It does not cover the headers or the identity of the tenant beyond the user.

## Retention

`COMPLETED` records expire `IDEMPOTENCY_TTL_HOURS` (default 24) after they were created, through the partial TTL index `idempotency_ttl_completed`. Every other record is kept: `UNKNOWN_COMMIT`, an `IN_PROGRESS` attempt that committed work, and an abandoned attempt that committed nothing. If the first two expired, their key would be free again and a retry could run the operation a second time; they hold no response body. Before this rule, the index `idempotency_ttl` expired **every** record after 24 hours, which limited "never re-run" to one day. `npm run migrate` drops that index on an existing database (`migrate:dry-run` shows it first); dropping it removes no record. Tested against the real TTL monitor of a disposable server (`test_commit_ambiguity.js`). Operators: [RUNBOOK-UNCONFIRMED-OPERATIONS.md](RUNBOOK-UNCONFIRMED-OPERATIONS.md).
