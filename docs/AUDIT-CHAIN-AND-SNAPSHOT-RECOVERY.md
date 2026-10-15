# Audit-chain concurrency and pending-snapshot recovery

Status: **specification written before implementation** (2026-10-15), then updated with the implemented result.
Scope: `auditService`, `AuditLog`, `runInTransaction`, `payrollSnapshotService`, a new reconciliation script.
Out of scope and unchanged: payroll calculations, snapshot content and `snapshotHash` semantics, audit-record hash semantics, statutory wage logic (Phase 1D), the finalized-snapshot immutability hooks.

The audit chain is **tamper-evident, not tamper-proof**: anyone with raw database access can alter or delete records; `verifyAuditChain()` makes that detectable. Nothing here changes that claim.

## 1. Observed behaviour before the change

### 1.1 Audit append (code: `auditService._append`, `log`)

1. `findOne().sort({sequenceNumber:-1})` reads the head (inside the caller's transaction session if one is passed).
2. Compute `sequenceNumber = head+1`, `previousHash = head.hash`, `createdAt = now`, `hash = sha256(canonical payload)`.
3. `insert` the record. Database guard: unique index `sequenceNumber_1`.
4. Outside a transaction a collision (`E11000` on `sequenceNumber`) is retried up to 10 times with `random()*10*attempt` ms of pause. Inside a transaction there is no retry here: the transaction aborts and `runInTransaction` re-runs the whole unit of work (5 attempts, no pause).

### 1.2 Measured (probe against the unmodified code, replica set, MongoDB 8.0.12)

| Scenario | Observed |
|---|---|
| chain integrity under every run with the index present | **always valid** (safety holds) |
| 25 concurrent plain appends | 25/25 |
| 50 / 100 / 200 / 400 concurrent plain appends | 49 / 33 / 36 / 28 succeed; the rest fail with `E11000` after 10 attempts |
| 5 / 10 / 25 / 100 concurrent transactions each logging | 5 / 5 / 5 / 5 commit; the rest fail with `WriteConflict (112)` after 5 attempts |
| 4 processes x 60 plain appends | 13 / 14 / 20 / 29 succeed per process |
| unique index missing (failed or never completed build) | 50/50 appends **reported success**; the chain forked (a duplicate sequence number; one predecessor with two successors); `verifyAuditChain` reports it only afterwards; the index can no longer be rebuilt (`DuplicateKey`) |

**Root causes.** (a) Safety rests on a single unique index that nothing verifies exists, and the application never fails closed without it. (b) Liveness: every writer contends for the same next sequence number; the retry budget (10 attempts, <=90 ms; 5 attempts, no pause) is far smaller than the contention it must absorb. (c) Inside a transaction (`readConcern: snapshot`) the head is read *as of transaction start*, so **any** append that commits during the whole transaction forces a collision; the conflict window is the entire business transaction, not the append.

### 1.3 Payroll snapshot lifecycle (code: `payrollFinalizationService.finalize`, `payrollSnapshotService`)

```
finalize(run)
  1. read run, controls, variance report                      (no writes)
  2. materializeSnapshots: FOR EACH employee, sequentially
       a. snapshot.create(payload)        PENDING_FINALIZATION   (own write, NO transaction)
       b. auditService.log(PAYROLL_SNAPSHOT_CREATED)             (separate write, NO transaction)
  3. finalizeRun
       a. pre-checks (counts, duplicates, per-snapshot hash)     (reads)
       b. TRANSACTION: bulkMarkFinalized + run -> FINALIZED + audit PAYROLL_FINALIZED
       c. AFTER COMMIT: audit PAYROLL_SNAPSHOT_FINALIZED         (NO transaction)
  4. AFTER finalizeRun: audit PAYROLL_VARIANCE_OVERRIDDEN        (NO transaction)
```

Windows found in the code and reproduced by failure injection (`test_audit_hardening.js`, pre-fix run kept in the evidence directory):

| # | Window | Observed result |
|---|---|---|
| W1 | crash/failure between 2a and 2b | a persisted `PENDING` snapshot **without** its creation event; a retry finds it, calls it "reused", and **never writes the event** (reproduced: 3 snapshots, 2 events) |
| W2 | failure between two employees | partial set of pending snapshots; a retry completes it (idempotent by the unique `(run, employee)` index) |
| W3 | failure after the 3b commit, before 3c | run and snapshots are `FINALIZED`, `PAYROLL_FINALIZED` exists, the caller is told it **failed**, and `PAYROLL_SNAPSHOT_FINALIZED` is never written (a retry is refused with 409) (reproduced) |
| W4 | failure after 3 but before 4 | same shape: finalized, but the override event is lost; the override is also recorded inside the `PAYROLL_FINALIZED` meta, so the decision itself is not lost |
| W5 | duplicate/retried finalize | already correct: exactly one winner, losers 409/422 (existing tests; re-proved here with 8 contenders) |
| W6 | `REQUIRE_TRANSACTIONS=false` on a standalone server (development only) | step 3b is not atomic; documented, not changed (production refuses to run without transactions) |

Run state machine (unchanged): `DRAFT -> PROCESSING -> READY_FOR_FINALIZATION -> FINALIZED -> DISBURSED`; `PROCESSING|READY -> FAILED`; `FAILED -> PROCESSING|CANCELLED`. Snapshots: `PENDING_FINALIZATION -> FINALIZED` only; finalized ones are immutable through Mongoose (query hooks), and the repository exposes no update/delete.

No code path moves a run from `READY_FOR_FINALIZATION` to `FAILED`, so by the application's own transitions a pending snapshot should exist only under a `READY_FOR_FINALIZATION` run. The states below can still arise from restores, manual database work, future code, or the dev fallback, so they are classified rather than assumed away.

## 2. Decisions (implemented)

### 2.1 Audit chain

1. **Database-enforced single successor.** Keep the unique `sequenceNumber`; add a unique **partial** index on `previousHash` (`{previousHash: {$type: 'string'}}`): a predecessor can have exactly one successor even if sequence numbers were mis-assigned. Partial, so pre-chain legacy records without a hash cannot collide.
2. **Fail closed without the constraints.** Before appending, the service verifies (cached, re-checked on a short interval and after any collision) that both unique indexes exist. If missing it tries to rebuild them; if that is impossible (a fork already exists) it **refuses to append** with `503 AUDIT_CHAIN_INDEX_UNAVAILABLE`. Nothing is written.
3. **Explicit retry/failure semantics.** Collisions on either unique key are retried with exponential backoff and full jitter until a deadline (`appendPolicy`, default 15 s). Each collision means another writer committed, so the system as a whole always makes progress. When the deadline passes the outcome is `503 AUDIT_CHAIN_CONTENTION` (`retryable: true`); nothing is written. Any other database error is **not** retried and not disguised.
4. **Shorter conflict window inside transactions.** The head is read from committed state immediately before the insert (not from the transaction snapshot), with a per-session record of events already appended in that transaction, so two events in one transaction chain correctly and the window shrinks from "whole transaction" to "read-to-commit".
5. **Transaction retry** (`runInTransaction`): more attempts with jittered backoff and a deadline; collisions on `previousHash` count as retryable like `sequenceNumber`. Every retry re-runs the whole unit of work from a rolled-back state (documented contract), so business writes are never duplicated.

### 2.2 Snapshots

6. **Snapshot + creation event are one transaction** (per employee). Either both exist or neither; the unique index keeps materialization idempotent.
7. **Finalization is all-or-nothing including every audit event.** `PAYROLL_SNAPSHOT_FINALIZED` and any caller-supplied extra events (variance override) are written inside the finalization transaction.
8. A retried or duplicate finalize stays a 409 conflict (unchanged contract); it never rewrites anything.

## 3. Recovery policy

Classification of every snapshot and run (the reconciliation script reads only):

| Class | Condition | Action |
|---|---|---|
| `OK` | `FINALIZED` snapshot, run finalized, hash valid | never touched |
| `IN_FLIGHT` | `PENDING`, run `READY_FOR_FINALIZATION`, hash valid, equals the payload rebuilt from staging | **no action**: a person re-runs finalize (idempotent). A partially materialized run is the same class |
| `PENDING_STALE` | `PENDING`, run READY, hash valid, but differs from the rebuilt payload or staging is missing | **investigate** (finalization would block with `SNAPSHOT_CONFLICT`); never auto-changed |
| `ORPHAN_PENDING` | `PENDING`, run `FAILED` or `CANCELLED`, hash valid | **the only auto-recoverable class**: eligible for purge, apply mode + explicit `--purge-orphans` only |
| `PENDING_ON_ACTIVE_RUN` | `PENDING` under `DRAFT` or `PROCESSING` | investigate |
| `PENDING_UNDER_FINALIZED_RUN` | `PENDING` under `FINALIZED`/`DISBURSED` | investigate; **never finalized automatically** |
| `FINALIZED_UNDER_UNFINALIZED_RUN` | `FINALIZED` snapshot under a run not finalized | investigate |
| `HASH_INVALID` | stored hash differs from the recomputed hash, any status | investigate (possible tampering); never touched |
| `DUPLICATE_SNAPSHOT` | two snapshots for one run + employee | investigate |
| `RUN_MISSING` | snapshot whose run does not exist | investigate |
| `AUDIT_GAP` | snapshot without a creation event; finalized run without its finalization events | **report only** (historical; the script does not backfill or rewrite the chain) |
| `CHAIN_INVALID` | `verifyAuditChain` fails | report; **apply mode refuses to run** |

Never modified automatically, in any mode: finalized snapshots, anything classed *investigate*, runs, staging results, existing audit records, the sequence of the audit chain.

Script: `scripts/reconcile-payroll-snapshots.mjs`.
* **Default is a dry run**: no writes (not even the lock); structured JSON report with before-evidence.
* `--apply` alone changes nothing beyond what dry-run does for the non-purge classes; `--apply --purge-orphans` is required to purge.
* Preconditions for apply: audit chain valid and its unique indexes present; the maintenance lock acquired (a unique-key document with an expiring lease, so a second concurrent instance refuses).
* Each purge: (1) before-image of the full snapshot written and flushed to the evidence file; (2) **one transaction** that re-reads the snapshot and run, re-checks every eligibility condition (still `PENDING`, hash unchanged and valid, run still `FAILED`/`CANCELLED`), deletes with a conditional filter, and appends a `PAYROLL_SNAPSHOT_ORPHAN_PURGED` audit event; (3) after-evidence in the report. If any precondition no longer holds the record is skipped and reported.
* Idempotent: a second apply finds nothing eligible and writes nothing.

## 4. Residual risks and limits

The audit chain is **tamper-evident, not tamper-proof**: anyone with raw database access can edit or delete records, drop an index, or rewrite the whole chain consistently. What the chain provides is *detection* of edits, deletions, re-ordering and forks by `verifyAuditChain`, and *prevention of accidental forks by the application* through the database constraints below.

Unresolved races, crash windows and limits (none is hidden by the tests):

1. **Throughput ceiling of one global chain.** Appends are serialized by design. Measured on a single local replica set: 1000 concurrent plain appends from one process all succeed in about 4.6 s; around 300 *concurrent transactions*, each making business writes and an audit append, exceed the 15 s budget, and the overflow surfaces as `503 AUDIT_CHAIN_CONTENTION` (retryable, nothing written) rather than being lost. Sharding the chain was out of scope (it would change hash semantics).
2. **In-process serialization only.** Plain (non-transactional) appends from one process are queued; separate processes contend on the database and rely on the unique indexes plus retry. This was tested with four separate processes, not with a multi-node deployment.
3. **Index-drop window.** The guard checks both unique indexes at most every 10 s (`indexRecheckMs`) and after any collision. An index dropped at runtime is not noticed until the next check; during that window a second writer could in principle fork the chain. A fork is then detectable by verification and blocks any rebuild of the index (appends are refused until an operator resolves it). This is a documented window, covered by a test that shows the guard is restored after the interval and trusted inside it.
4. **Development fallback.** With `REQUIRE_TRANSACTIONS=false` (a development setting) a snapshot and its event are not atomic; do not use it where the guarantees matter.
5. **Legacy audit gaps** already in a database (a snapshot without a creation event, a finalized run without its finalization events) are reported, never repaired; the tool does not backfill or re-sequence the chain.
6. **Reconciliation purge race.** Between the in-transaction re-check and the commit another writer could change a purged orphan's status; the delete is conditional on the same filter, so the worst outcome is a skipped record. The purged data is derived (re-creatable from staging), a before-image is on disk, and an audit event records the purge.
7. **Maintenance lock.** A lease of 10 minutes without renewal: a crashed operator blocks another apply until it expires; a purge running longer than the lease (not realistic for the data sizes involved) could overlap a second apply, which the in-transaction checks would still make safe.
8. **Evidence files** are written to a local directory chosen by the operator; keeping them is the operator's responsibility.
9. **Not covered:** multi-region/multi-node failure modes, clock skew between nodes for the lease, storage-level corruption. Any claim of legal or statutory compliance is outside this document.
