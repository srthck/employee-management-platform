# Transactional business and audit atomicity

## Required invariant

For a state transition that requires an audit event, the business write,
transition metadata, audit record, and audit-chain-head advance execute in the
same MongoDB transaction and use the same `ClientSession`. A failed audit
append therefore aborts the business transition, and an aborted business
transaction cannot leave its required event behind.

## Implemented paths

This boundary applies to:

1. authentication account lockout;
2. successful login state reset;
3. logout-all token-version increment;
4. payroll preflight result persistence;
5. payroll processing claim, processing-version increment, and stale staging
   cleanup;
6. automatic stuck-run recovery;
7. payroll `_failRun`.

Each callback is passed through `runInTransaction`. The audit append uses
`auditService.log(params, session)`, not `logStandalone`.

## Retry safety

`runInTransaction` retries only transaction conflicts according to MongoDB
transaction labels and the audit-chain contention policy. Callback work must
be database-only and replay-safe. No email, cookie, payment, filesystem, or
other irreversible external side effect occurs inside these callbacks.

Login cookies are issued only after the transaction commits. Logout-all clears
the cookie only after the token-version transition and audit event commit.

## Error semantics

An audit failure is surfaced to the caller and aborts the enclosing transaction; it is never turned into a success. When the database does not confirm a commit, the caller receives 503 `COMMIT_OUTCOME_UNKNOWN` unless the operation record proves the commit (see [AMBIGUOUS-COMMIT-RECOVERY.md](AMBIGUOUS-COMMIT-RECOVERY.md)).

Three call sites remain `logStandalone`: `SENSITIVE_FIELD_REVEALED` in `bankAccountService`, `SENSITIVE_FIELD_INTEGRITY_FAILED` in `employeeScope`, and `SENSITIVE_FIELD_REVEALED` in `statutoryProfileService`. Each records a read or a failure, with no business write that must be atomic with it. The census in `test_audit_chain_head.js` pins every file's count.

## Nested transactions

A `runInTransaction` started inside another one's callback is a separate, independent transaction. An audited append inside one is refused (`AUDIT_NESTED_TRANSACTION`). During a keyed request a nested transaction is refused altogether (`IDEMPOTENCY_NESTED_TRANSACTION`), because its commit could not be recorded in the operation record; see [IDEMPOTENCY.md](IDEMPOTENCY.md).

## Evidence

`backend/test_atomicity.js` group A: a real audit outage (the head is removed, so every append is refused) for six sites, and a simulated refusal for one event, named in its test.
