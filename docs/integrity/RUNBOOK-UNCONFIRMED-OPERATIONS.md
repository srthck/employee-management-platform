# Runbook: operations whose outcome is unconfirmed

For operators and support. When to use it: a user reports, or the logs show, one of these responses:

| Response | Meaning |
|---|---|
| 503 `COMMIT_OUTCOME_UNKNOWN` | The database did not confirm whether a change was saved. It may have been. |
| 409 `IDEMPOTENCY_OUTCOME_UNKNOWN` | A retry of such a request. It was **not** run again. |
| 409 `IDEMPOTENCY_PRIOR_ATTEMPT_COMMITTED` | An earlier attempt saved some of its changes and then failed. It will not be run again. |

None of these means "nothing happened", and none of them is resolved automatically. Background: [AMBIGUOUS-COMMIT-RECOVERY.md](AMBIGUOUS-COMMIT-RECOVERY.md), [IDEMPOTENCY.md](IDEMPOTENCY.md).

## 1. Find the operation

The response carries an `operationId` (absent only for requests sent without an `Idempotency-Key`). Logs: `Commit outcome unknown` (error) or `Unconfirmed commit settled as committed from the operation record` (warning), with the transaction label and the `operationId`.

Read the record (read-only):

```js
db.idempotencyrecords.findOne({ operationId: '<operationId>' },
  { responseBody: 0 })
```

| Field | Use |
|---|---|
| `method`, `path`, `userId`, `companyId` | What was attempted, by whom, for which workspace |
| `status` | `UNKNOWN_COMMIT`, or `IN_PROGRESS` with an expired lock |
| `committedTransactions`, `commits[].label`, `commits[].at` | Which transactions are **known** to have committed, by label |
| `createdAt` | When the request started |

## 2. Decide what happened

`commits[]` is written inside each business transaction, so every entry there is a commit that happened. An unconfirmed transaction's absence from `commits[]` does **not** prove it failed: read again after a minute, because the commit may become visible late.

Then look at the business state the request would have changed (the run, the employee, the salary version …) and at the audit trail for that entity around `createdAt`. Each audited change and its event commit together, so an event that exists means the change exists.

| What you find | Conclusion |
|---|---|
| The change and its audit event are there | It was applied |
| Neither is there, more than a few minutes later | It was not applied |
| Anything else (only part of a multi-step request) | Partly applied: handle as a business correction, not a retry |

## 3. Act

- **Applied:** tell the user it worked. Nothing to repeat.
- **Not applied:** the user repeats the action with a **new** request (the application generates a new key). Do not edit or delete the old record: it is the evidence, and the key stays blocked by design.
- **Never** retry blindly: not with the same key (it is refused, by design), and not with a new key until step 2 has established that the original was **not** applied. A new key bypasses the operation record; only the business guards would then stand between a retry and a second effect.
- **Partly applied:** correct the business state through the normal application functions, so that each correction is audited.

Never change `status`, `committedTransactions` or `commits` by hand, and never delete these records to "unblock" a key. There is no supported tool to do either.

## Retention

`COMPLETED` records expire `IDEMPOTENCY_TTL_HOURS` (default 24) after they completed. Records that are `UNKNOWN_COMMIT`, or `IN_PROGRESS` with committed work, do **not** expire: deleting them would let a retry with the same key run the operation again. They hold no response body. Databases created before this rule carry older TTL indexes; follow "Deploying the retention change" in [IDEMPOTENCY.md](IDEMPOTENCY.md) (new code everywhere first, then `npm run migrate:dry-run`, then `npm run migrate`).

## Escalate when

- the same `operationId` shows commits you cannot match to any business change;
- `COMMIT_OUTCOME_UNKNOWN` appears repeatedly (it points at the database or the network: check replica-set health and write-concern errors);
- a request without an `operationId` is involved and its effect matters (there is no durable record to read).
