# Audit-chain concurrency and pending-snapshot recovery

Status: **specification written before implementation** (2026-10-15), then updated with the implemented result.
**Phase 0 containment (integrity program, see `docs/integrity/CLAIMS-LEDGER.md`):** an independent adversarial audit of this change (commit `04c872b`) found statements in this document that are false or overstated. They are corrected below and marked *(corrected)*. Destructive recovery (`--apply`) is **disabled**: the recovery tool is now read-only. Startup no longer touches audit history. Where this document and the claims ledger differ, the ledger is authoritative.

**Phase 2 (transactional chain head), see `docs/integrity/AUDIT-CHAIN-HEAD.md`:** section 2.1 below describes the design of commit `04c872b` (unique indexes plus a cached, request-path index guard). That design is **superseded** for appends: linearity now comes from one head document advanced by a conditional update in the same transaction as the record, the request-path index creation/repair and its 10-second cache no longer exist, and the indexes are defence in depth together with a collection validator. Statements below about the guard, its cache and the in-process serialization of plain appends describe the old design. **Still in force:** an append that keeps losing the race is retried by `runInTransaction` for at most 40 attempts or 15 s and then fails with the explicit, retryable `503 AUDIT_CHAIN_CONTENTION` with nothing written (now caused by head conflicts rather than unique-index collisions); see section 3 of `AUDIT-CHAIN-HEAD.md`.

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

### 2.1 Audit chain *(design of 04c872b, superseded by Phase 2 — see AUDIT-CHAIN-HEAD.md)*

1. **Database-enforced single successor.** Keep the unique `sequenceNumber`; add a unique **partial** index on `previousHash` (`{previousHash: {$type: 'string'}}`): a predecessor can have exactly one successor even if sequence numbers were mis-assigned. Partial, so pre-chain legacy records without a hash cannot collide.
2. **Fail closed without the constraints.** Before appending, the service verifies (cached for up to `indexRecheckMs`, 10 s by default; a collision does **not** clear the cache *(corrected)*) that both unique indexes exist, matching each by key and uniqueness only: its `partialFilterExpression` is not compared, so an index with the right key and an ineffective filter is accepted *(known weakness, ledger F-01)*. If missing it tries to rebuild them; if that is impossible (a fork already exists) it **refuses to append** with `503 AUDIT_CHAIN_INDEX_UNAVAILABLE`. Nothing is written.
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
| `ORPHAN_PENDING` | `PENDING`, run `FAILED` or `CANCELLED`, hash valid | **classification only; there is no apply.** This class was the only one the withdrawn apply mode could purge; the predicate ignores finalization history and company/period/version agreement (ledger F-03), so even the classification is informational until it is rebuilt on positive proof |
| `PENDING_ON_ACTIVE_RUN` | `PENDING` under `DRAFT` or `PROCESSING` | investigate |
| `PENDING_UNDER_FINALIZED_RUN` | `PENDING` under `FINALIZED`/`DISBURSED` | investigate; **never finalized automatically** |
| `FINALIZED_UNDER_UNFINALIZED_RUN` | `FINALIZED` snapshot under a run not finalized | investigate |
| `HASH_INVALID` | stored hash differs from the recomputed hash, any status | investigate (possible tampering); never touched |
| `DUPLICATE_SNAPSHOT` | two snapshots for one run + employee | investigate |
| `RUN_MISSING` | snapshot whose run does not exist | investigate |
| `AUDIT_GAP` | snapshot without a creation event; finalized run without its finalization events | **report only** (historical; the script does not backfill or rewrite the chain) |
| `CHAIN_INVALID` | `verifyAuditChain` fails | report |

Never modified, in any mode (the tool contains no write operation): finalized snapshots, anything classed *investigate*, runs, staging results, existing audit records, the sequence of the audit chain.

Script: `scripts/reconcile-payroll-snapshots.mjs` — **read-only**.
* **The only mode is a dry run**: it reads, classifies and reports. The connection is opened with `autoIndex` and `autoCreate` off, so it also creates no collection and no index *(corrected: the first version created ten empty collections on an empty database; a test now proves it does not)*. `--report <file>` writes the report to a new file and never overwrites.
* **`--apply` is disabled and refused before any database access.** The script and its library contain no code that deletes or modifies a snapshot, a run, staging or an audit record (a test scans the sources for write-capable calls), and no flag, environment variable or exported function enables one. `purgeOrphans()` always refuses and lists every reason it can establish (disabled, invalid operator, missing or malformed scope, real transactions unavailable, chain or guards unverified).
* Arguments are parsed strictly: unknown, positional, duplicated, blank, valueless and malformed arguments are refused; `--company`/`--run` must be explicit 24-hex ids when given.
* The withdrawn implementation (commit `04c872b`) purged on a stale read of the run's status (write skew), ignored finalization history, trusted a caller-built scan, used an unfenced lease and could report a committed purge as failed. It returns only through the Phase 4 rebuild, which must pass the release gates of the integrity program before apply is restored.

## 4. Residual risks and limits

The audit chain is **tamper-evident, not tamper-proof**: anyone with raw database access can edit or delete records, drop an index, or rewrite the whole chain consistently. What the chain provides is *detection* of edits, removal or re-ordering of records **inside** the chain, and of forks, by `verifyAuditChain` *(corrected)*. It does **not** detect removal of the newest records (tail truncation): without an externally anchored head nothing proves the current tip is the historical tip. Forks are *prevented* by the database constraints below only while both unique indexes exist with their exact specification.

Unresolved races, crash windows and limits (none is hidden by the tests):

1. **Throughput ceiling of one global chain.** Appends are serialized by design. Measured on a single local replica set: 1000 concurrent plain appends from one process all succeed in about 4.6 s; around 300 *concurrent transactions*, each making business writes and an audit append, exceed the 15 s budget, and the overflow surfaces as `503 AUDIT_CHAIN_CONTENTION` (retryable, nothing written) rather than being lost. Sharding the chain was out of scope (it would change hash semantics).
2. **In-process serialization only.** Plain (non-transactional) appends from one process are queued; separate processes contend on the database and rely on the unique indexes plus retry. This was tested with four separate processes, not with a multi-node deployment.
3. **Index-drop window** *(removed by Phase 2: the head protocol no longer depends on index availability; the paragraph below is the old design)*. The guard checks both unique indexes at most every 10 s (`indexRecheckMs`); a collision does not trigger a check *(corrected)*. An index dropped at runtime is not noticed until the next check; if **both** guards are absent (or ineffective but accepted), concurrent writers **can and did** commit a fork and every caller was told success (reproduced by three independent audit lanes; either guard alone prevents it). A fork is then detectable by verification and blocks any rebuild of the index (appends are refused until an operator resolves it). This is a documented window, covered by a test that shows the guard is restored after the interval and trusted inside it.
4. **Development fallback** *(corrected in Phase 0)*. The non-transactional fallback now needs `REQUIRE_TRANSACTIONS=false` **and** `NODE_ENV` exactly `development` or `test` **and** a loopback-only `MONGO_URI`; otherwise it is ignored and logged, and readiness reports the policy. Destructive maintenance needs real transactions regardless. With the fallback active a snapshot and its event are not atomic; do not use it where the guarantees matter.
5. **Legacy audit gaps** already in a database (a snapshot without a creation event, a finalized run without its finalization events) are reported, never repaired; the tool does not backfill or re-sequence the chain. Audit records that predate the hash chain are **reported at startup and migrated only by the explicit command** `scripts/audit-chain-legacy-backfill.mjs` (dry run by default; apply bound to a reviewed plan digest and the database name; it only fills records that have no chain fields and refuses forks, gaps, malformed or mixed-order history). Startup never rewrites history *(corrected: it used to re-seal already-chained records)*.
6. **Reconciliation purge race** *(corrected; the tool is now read-only)*. The withdrawn apply re-read the run inside its transaction but never wrote it, so a concurrent `FAILED -> PROCESSING` retry committed without conflict and the purge still succeeded with a stale `runStatus` in its audit event. "The worst outcome is a skipped record" was false for run status.
7. **Maintenance lock** *(removed with apply)*. The lock was an unfenced, unrenewed 10-minute lease judged on the caller's clock; a fenced protocol is part of the Phase 4 rebuild.
8. **Evidence files** are written to a local directory chosen by the operator; keeping them is the operator's responsibility.
9. **Not covered:** multi-region/multi-node failure modes, clock skew between nodes for the lease, storage-level corruption. Any claim of legal or statutory compliance is outside this document.
