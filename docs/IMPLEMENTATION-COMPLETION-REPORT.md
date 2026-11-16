# PayGuard implementation completion report

Date: 2026-11-01  
Branch: `main`  
HEAD: `b0e3656` (`Redesign the signed-in application around shared PayGuard tokens`)

## Executive summary

This implementation continuation preserved the existing audit-chain and payroll
architecture. It completed the source-level transactional changes for the
seven identified F-05 business/audit paths, added durable idempotency operation
identity and explicit ambiguous-commit resolution primitives, and added a
fail-closed snapshot-recovery inspection/evidence foundation. Destructive
snapshot recovery remains disabled. No finalized payroll snapshot, historical
audit record, or golden hash was rewritten.

The implementation campaign is **not production-ready**: replica-set
integration, mutation coverage, independent review, legal approval, and
territorial completeness remain outstanding.

## Phase status

| Phase | Status | Implementation result |
|---|---|---|
| Phase 2 audit-chain head | PARTIALLY IMPLEMENTED | Existing transactional head preserved; operational documentation and mutation reconciliation remain incomplete |
| Phase 3 F-04 idempotency | PARTIALLY IMPLEMENTED | Durable operation identity, unknown-commit state, resolver, and reopen gate added; endpoint-specific resolver integration remains |
| Phase 3 F-05 atomicity | IMPLEMENTED | Seven business/audit paths use shared transaction callbacks and sessions; database verification is deferred |
| Phase 4 snapshot recovery | PARTIALLY IMPLEMENTED | Positive-proof inspection, plan digest, leases, evidence file creation, and disabled apply exist; deletion/reconciliation orchestration is intentionally absent |
| Phase 1D statutory wage scaffold | IMPLEMENTED | Isolated exact-rational scaffold remains production-gated and unconnected |
| Legal register | BLOCKED | D1–D19 remain preserved; unresolved primary-source and counsel decisions remain |
| Gazette investigation | BLOCKED | Existing corpus is preserved; completeness is not established |
| Establishment/work assignment | IMPLEMENTED | Design-only domain document exists; no schema migration or activation was performed |
| Historical integrity | IMPLEMENTED | No finalized historical records or hashes were rewritten |

## Architecture changes

### Transactions and audit

The account-lockout, successful-login, logout-all, payroll-preflight,
processing-start, automatic stuck-run recovery, and `_failRun` paths now place
the business write and required `auditService.log(params, session)` call in
one `runInTransaction` callback. Cookies and other response effects occur
after the relevant transaction callback.

### Idempotency

`IdempotencyRecord` now stores a stable `operationId`, request digest, tenant
scope, response, and resolution evidence. The state machine includes
`IN_PROGRESS`, `COMPLETED`, `UNKNOWN_COMMIT`, `CONFIRMED_COMMITTED`, and
`CONFIRMED_ABORTED`. A 5xx response retains the marker. Same-key retries of
unknown operations receive `COMMIT_OUTCOME_UNKNOWN` and cannot automatically
rerun the handler.

`idempotencyService.js` provides a conditional, endpoint-specific evidence
resolver. It does not infer a result from an HTTP status and does not permit
reopening an operation without explicit confirmed-abort evidence.

### Snapshot recovery

`payrollSnapshotRecoveryService.js` verifies tenant, run, period, lifecycle,
duplicate, finalization-event, snapshot-hash, audit-chain, and head evidence.
Ambiguous evidence is not eligible. `SnapshotRecoveryLease` provides
database-backed owner tokens and monotonic fencing values. Evidence creation
uses exclusive file creation, path containment, symlink checks, restrictive
permissions, exact byte verification, and file flush.

`applySnapshotRecovery()` always refuses. Filesystem evidence and MongoDB
transactions are explicitly not treated as one atomic system.

## Files changed or added

### Source

- `backend/src/controllers/authController.js`
- `backend/src/middleware/idempotency.js`
- `backend/src/models/IdempotencyRecord.js`
- `backend/src/models/SnapshotRecoveryLease.js`
- `backend/src/services/idempotencyService.js`
- `backend/src/services/payrollRunService.js`
- `backend/src/services/payrollSnapshotRecoveryService.js`

### Documentation

- `docs/integrity/IDEMPOTENCY.md`
- `docs/integrity/AMBIGUOUS-COMMIT-RECOVERY.md`
- `docs/integrity/TRANSACTIONAL-ATOMICITY.md`
- `docs/integrity/SNAPSHOT-RECOVERY.md`
- `docs/integrity/CLAIMS-LEDGER.md`
- `docs/design/ESTABLISHMENT-WORK-ASSIGNMENT-DESIGN.md`
- `docs/legal/SEED-RULES-REVIEW.md`
- `docs/IMPLEMENTATION-COMPLETION-REPORT.md`

The existing seed-description change in
`backend/scripts/seed-compliance-rules.js` was preserved. The
byte-equivalent `backend/src/controllers/auditController.js` worktree status
was not reset. The zero-byte `advanced_databases` artifact was not modified.

## Legal and statutory status

The D1–D19 decision register remains open where primary evidence or approval
is absent. The ESI rounding investigation is preserved under the external
evidence directory and does not authorize changing production calculations.
The statutory-wage scaffold remains isolated, TEST-only for fixture
evaluation, and NO-GO for production legal determinations.

## Verification backlog

- Disposable MongoDB replica-set integration tests.
- F-04 resolver and F-05 persisted-state failure injection.
- Q03, Q16, Q17, and Q33 mutation evidence.
- Complete mutation ledger reconciliation.
- Full backend suite twice on the final source.
- Snapshot lease takeover, stale-owner, evidence-crash, and reconciliation tests.
- Historical golden-hash verification.
- Independent adversarial audit review.
- Gazette result reconciliation and territorial completeness evidence.
- Official General Clauses Act section 24 acquisition or documented blocker.

## Production restrictions

- Snapshot deletion/apply is disabled.
- Production statutory-wage activation is disabled.
- Unresolved legal interpretations cannot enable payroll calculation.
- Historical finalized snapshots and audit records must not be rewritten.
- Hash chaining is tamper-evident, not tamper-proof.

## Git state

No commit was created during this continuation. The worktree intentionally
contains the source, documentation, design, legal, and pre-existing user
changes listed above. The working tree must be reviewed and committed in
logical boundaries only after the deferred verification campaign.
