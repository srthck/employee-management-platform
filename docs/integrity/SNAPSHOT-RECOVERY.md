# Payroll snapshot recovery

## Safety position

The old purge path is not restored. [`payrollSnapshotRecoveryService.js`](../../backend/src/services/payrollSnapshotRecoveryService.js) is a **foundation**: it inspects, plans and writes an evidence file, and nothing else. `applySnapshotRecovery()` always throws 503 `SNAPSHOT_RECOVERY_APPLY_DISABLED`. No route, script or CLI calls this module. Historical finalized snapshots are never rewritten or deleted by it.

Tests: `backend/test_snapshot_recovery.js` (13).

## What the inspection checks today

A snapshot is `SAFE_ORPHAN_PENDING` only when **every** check below passes:

- it exists in the requested tenant and its `snapshotHash` matches its canonical payload;
- its status is `PENDING_FINALIZATION`, and `finalizedAt` and `finalizedBy` are absent;
- its run exists in the same tenant and period, and is `READY_FOR_FINALIZATION`, `FAILED` or `CANCELLED` (never `FINALIZED` or `DISBURSED`);
- it is the only snapshot for that run and employee;
- no finalization audit event names the snapshot or the run;
- the audit chain and the head verify.

Any finalization evidence (status, metadata, audit event or run state) makes it `FINALIZED`, whatever its status field says. That closes the classification half of F-03. Anything else that fails is `INCONSISTENT`, a missing snapshot is `MISSING_EVIDENCE`, and malformed identifiers are `INVESTIGATE`. Inspection and planning write nothing.

## Required before any apply exists (not implemented)

- The database supports real transactions, checked at the point of use.
- A maintenance fence that stops payroll writers for the run (F-02: the old purge read the run but never wrote it, so a concurrent `FAILED → PROCESSING` retry could slip through).
- The deletion and its audit event in one transaction, conditional on the lease fence **and** on the run and snapshot still matching the plan.
- A reconciliation step after the operation, and crash-consistency tests for each window between the evidence file, the database commit and the release.
- An independent review and a release decision.

## Leases

`SnapshotRecoveryLease` gives one owner per resource key, an owner token, a fence that rises on every takeover, and an expiry (1 s to 15 min). Takeover is possible only after expiry. Renewal, release and `assertRecoveryFence` all require the current owner token and fence and an unexpired lease, so a superseded owner can neither prove, renew nor release. Today nothing acts under a lease.

## Evidence file

`createRecoveryEvidence()` accepts only an eligible dry-run plan with its digest. It refuses paths that escape the approved directory and symlinked directories or files, creates the file exclusively with restrictive permissions, verifies the byte count, flushes it, and returns the content digest. The file and the database are not one transaction; any future apply must record the file's digest and reconcile both.

## Modes

| Mode | State |
|---|---|
| Inspect | Implemented; read-only |
| Plan (dry run) | Implemented; read-only, digest-bound |
| Evidence | Implemented; writes only the evidence file |
| Apply | **Disabled**: always refuses |
| Reconcile | **Not implemented** |
