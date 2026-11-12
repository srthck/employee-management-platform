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

A request without a key on an optional route has no operation record (the nine financially material routes refuse it; see Required keys). It keeps all the transaction guarantees, and a lost commit reply still returns `COMMIT_OUTCOME_UNKNOWN`, but there is no `operationId` and no retry protection.

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

`COMPLETED` records expire `IDEMPOTENCY_TTL_HOURS` (default 24) **after they completed** (`completedAt`), through the partial TTL index `idempotency_ttl_completed_at`. Every other record is kept: `UNKNOWN_COMMIT`, an `IN_PROGRESS` attempt that committed work, and an abandoned attempt that committed nothing. If the first two expired, their key would be free again and a retry could run the operation a second time; they hold no response body.

Retention counts from completion, not creation, because an abandoned attempt can be taken over long after it was created: counting from `createdAt` would let that record expire moments after it completed, and a lost-response retry seconds later would run the operation again.

**What retention does not cover.** After a `COMPLETED` record expires, a request with the same key is a new request. That is the documented contract (a key protects retries for 24 hours after success). For the financially material routes, which require a key, a business-level guard independently stops a second effect: one run per period (partial unique index), conditional state transitions for process / finalize / cancel / finalize-run, `EFFECTIVE_DATE_NOT_AFTER_CURRENT` and `SALARY_VERSION_OVERLAP` for salary revisions, the approval state machine and `BASELINE_CHANGED` for compensation, `NO_CHANGE` for an identical bank account. A repeated compensation **proposal** creates a second proposal; no money moves until one is approved, and approving the second then fails on `BASELINE_CHANGED`. Tested end to end in `test_phase12.js` (repeats with fresh keys).

History: the Wave 1 index `idempotency_ttl` expired **every** record 24 hours after creation, which limited "never re-run" to one day; the interim `idempotency_ttl_completed` (commit `30ebb7c`) counted from creation. Tested against the real TTL monitor of a disposable server (`test_commit_ambiguity.js`). Operators: [RUNBOOK-UNCONFIRMED-OPERATIONS.md](RUNBOOK-UNCONFIRMED-OPERATIONS.md).

## Required keys

Nine routes **require** an `Idempotency-Key` and answer 428 `IDEMPOTENCY_KEY_REQUIRED` without one: payroll run create, process, finalize, cancel, snapshot finalize-run, salary revision, compensation proposal, compensation approval, and adding a bank account. Each is financially material and irreversible, and each already had a first-party caller that sends a key (`frontend/src/services`, `postIdempotent`), except finalize-run, which has no caller. Preflight, recover and materialize take no key: repeating them changes nothing more. The other routes keep an optional key. The inventory is pinned by `test_idempotency_policy.js`. **API change for other clients:** a script or integration calling those nine routes must now send a key.

## Deploying the retention change

Every application instance builds its schema's indexes when it connects (Mongoose `autoIndex`) and drops none.

1. Deploy the new code to **every** instance and stop all old ones. An old instance that starts again re-creates `idempotency_ttl`.
2. `npm run migrate:dry-run`: it lists the indexes it would drop and the number of `COMPLETED` records that would get `completedAt`.
3. `npm run migrate`: drops `idempotency_ttl` and `idempotency_ttl_completed`, sets `completedAt = createdAt` on older `COMPLETED` records (so they keep the retention they had), and builds `idempotency_ttl_completed_at`. It removes no document and a second run does nothing.

Until step 3, the old index keeps expiring every record after 24 hours, which is the behaviour before this change, not worse. `migrate.js` also runs the earlier data steps (payroll-run indexes, employee backfills, compensation backfill and others, listed in its header); they are re-runnable, but they change application data, so run the dry run first and review it.

**Rollback.** Old code re-creates `idempotency_ttl` on startup, which restores the one-day limit; the new index stays and is harmless to old code, and so does the `completedAt` field. There is no automatic way back once records the old index would have deleted have been kept; nothing needs one.

