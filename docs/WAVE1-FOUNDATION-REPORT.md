# PayGuard Wave 1 — Financial Foundation Report

**Date:** 2026-09-15
**Scope:** Wave 1 of the "Workforce Financial OS" plan (financial foundation hardening), plus variance classification and maker-checker, which the plan identified as flaws in the controls already shipped.

Wave 1 was treated as a gate: no HR breadth (attendance, leave, TDS) is built until the payroll core's guarantees are proven on a transaction-capable database.

---

## 1. Evidence

| Check | Result |
|---|---|
| Full suite on a MongoDB **replica set**, `REQUIRE_TRANSACTIONS=true` (`npm run test:replset`) | **466 / 466 passed, 0 skipped** |
| Full suite on standalone MongoDB (`npm test`) | 463 passed, 3 skipped — the transaction-only tests skip by design |
| Rollback: failure injected after snapshots are marked FINALIZED | Run stays READY_FOR_FINALIZATION, 0 finalized snapshots, 0 audit events |
| Race: 4 simultaneous finalizations of one run | Exactly 1 succeeds; 1 `PAYROLL_FINALIZED` event; audit chain valid |
| Rollback: failure injected during registration | No admin and no company left behind |
| CI | `.github/workflows/ci.yml` runs every suite on a MongoDB 8 replica set with transactions required, and builds the frontend |

The earlier status "production financial atomicity: NOT VERIFIED" is now **verified in automated tests on a replica set**. It still depends on the production database being a replica set; the server refuses to start in production without one.

## 2. What was built

### 2.1 Transactions you can prove
- `scripts/test-with-replica-set.mjs` runs all suites against a replica set with transactions required.
- `scripts/start-replica-set.ps1` starts a separate single-node replica set on port 27018 without touching an existing MongoDB service.
- `test_phase13.js` includes rollback and race tests that only pass with real transactions.

### 2.2 Company entity
A `Company` document is the tenant boundary and holds payroll controls. Its `_id` equals the founding admin's `_id`, so every existing reference stayed valid; `npm run migrate` creates companies for workspaces that predate it. Registration creates the owner, company and audit event in one transaction.

### 2.3 Permission-based access control
Routes declare the capability they need, never a role. Roles are bundles defined in one place (`backend/src/utils/permissions.js`).

| Permission | Admin | Payroll admin | Payroll approver | HR manager | Auditor | Employee |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| company.read | ✓ | ✓ | ✓ | ✓ | ✓ | |
| company.manage | ✓ | | | | | |
| employee.read | ✓ | ✓ | ✓ | ✓ | ✓ | |
| employee.write | ✓ | | | ✓ | | |
| employee.archive | ✓ | | | | | |
| employee_account.manage | ✓ | | | ✓ | | |
| salary.read | ✓ | ✓ | ✓ | ✓ | ✓ | |
| salary.revise | ✓ | ✓ | | | | |
| payroll.read | ✓ | ✓ | ✓ | ✓ | ✓ | |
| payroll.preflight | ✓ | ✓ | ✓ | ✓ | | |
| payroll.prepare (create, calculate, cancel, recover) | ✓ | ✓ | | | | |
| payroll.finalize | ✓ | | ✓ | | | |
| payroll.variance.override | ✓ | | ✓ | | | |
| compliance.read | ✓ | ✓ | ✓ | ✓ | ✓ | |
| audit.read | ✓ | ✓ | ✓ | ✓ | ✓ | |
| audit.verify | ✓ | | ✓ | ✓ | ✓ | |
| sensitive.read | ✓ | | | | | |
| self.service | | | | | | ✓ |

Staff user management (`/api/company/users`): admins add users with a role, change roles, and deactivate users. Nobody can change their own role or status, the last active administrator is protected, and every change revokes the affected user's sessions immediately and is audited with before/after values.

### 2.4 Finalization controls (a layer above the state machine)
The state machine (DRAFT → PROCESSING → READY_FOR_FINALIZATION → FINALIZED) is unchanged. `payrollFinalizationService` decides whether a specific person may finalize now, and both finalization endpoints go through it:

1. **Segregation of duties.** Company setting `approvalMode`: `single` or `maker_checker`. Under maker-checker, whoever calculated the run cannot finalize it (`403 SEGREGATION_OF_DUTIES`).
2. **Variance gate.** Unexplained pay changes block finalization (`409 VARIANCE_UNEXPLAINED`) unless a user with `payroll.variance.override` records a reason of at least 15 characters. Results that cannot be paid (net pay ≤ 0) block with no override (`409 PAYROLL_RESULT_INVALID`).
3. **Approval record.** Preparer, approver, approval mode, variance summary and any override are written to the run and to the `PAYROLL_FINALIZED` audit event in the same transaction as finalization.

`GET /api/payroll-runs/:id/finalization-readiness` evaluates every control for the current user without side effects; the UI uses it to explain what is blocking.

### 2.5 Variance classification
The previous report flagged March 2026 as high severity because net pay changed, although the cause was Maharashtra's February professional tax amount. The report now explains changes instead of just flagging them. Each employee's change is broken into components (gross, PF, ESI, professional tax), and each component is matched to a cause the frozen payroll data can prove:

| Cause | Proven by |
|---|---|
| Salary revision | a different salary version was in effect |
| EPF / ESI / PT rule change | a different rule version or different frozen rule parameters |
| Month-specific PT amount | the employee's PT slab has an amount for that month |
| Enrolment change | PF, ESI or PT enrolment switched on or off |
| Work state change | the professional tax jurisdiction changed |

A residual check confirms net pay equals gross minus the explained deductions; anything left over is unexplained by definition.

| Classification | Meaning | Severity | Blocks |
|---|---|---|---|
| EXPECTED | every changed component has a proven cause | info | no |
| UNEXPLAINED | some change has no cause in payroll inputs (e.g. a salary edited in place in the database) | critical if material, else high | yes (company setting), overridable |
| INVALID | net pay ≤ 0 | critical | yes, never overridable |
| REVIEW | new or missing employee, deductions above half of gross | warning / info | no |

"Material" uses the company's `varianceThresholdPercent`.

### 2.6 Idempotency
Every money-affecting POST accepts an `Idempotency-Key` header: create/calculate/finalize/cancel payroll run, finalize-run, create employee, salary revision, employee login account and company user.

| Situation | Response |
|---|---|
| Same key, same request, finished | Original response replayed, header `Idempotent-Replayed: true` |
| Same key, same request, still running | `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` |
| Same key, different request | `422 IDEMPOTENCY_KEY_REUSED` |

Keys are per user and stored for `IDEMPOTENCY_TTL_HOURS` (default 24). The insert of the record is the lock, so concurrent duplicates execute once. The frontend generates one key per user action and retries network failures with the same key.

### 2.7 Error model
Every failed response carries a machine-readable `code` and the `requestId`, whichever layer produced it:

```json
{ "success": false, "code": "VARIANCE_UNEXPLAINED", "message": "…", "requestId": "…" }
```

Specific codes: `VALIDATION_FAILED`, `UNAUTHENTICATED`, `FORBIDDEN` (with `missingPermissions`), `NOT_FOUND`, `RATE_LIMITED`, `EMAIL_IN_USE`, `SELF_MODIFICATION`, `LAST_ADMIN`, `INVALID_ROLE`, `PAYROLL_STATE_CONFLICT`, `SEGREGATION_OF_DUTIES`, `VARIANCE_UNEXPLAINED`, `PAYROLL_RESULT_INVALID`, `OVERRIDE_REASON_REQUIRED`, `SNAPSHOT_CONFLICT`, `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_KEY_INVALID`, `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_REQUEST_IN_PROGRESS`. Otherwise a stable default is derived from the HTTP status.

### 2.8 Sensitive-data encryption (infrastructure)
`backend/src/utils/fieldEncryption.js` provides:
- AES-256-GCM with a random IV per value;
- **context binding**: a ciphertext moved to another employee or field fails to decrypt;
- tamper detection;
- key rotation with key ids;
- a blind index (HMAC) for exact-match lookups such as duplicate PAN detection;
- masking helpers.

Keys come only from the environment.

**Honest status:** no sensitive field (PAN, bank account, UAN) exists in the data model yet, so nothing is encrypted today. Wave 2 introduces those fields and must store them through this utility, gated by `sensitive.read`.

## 3. Frontend
- **Routes and navigation:** guarded by permissions, not roles. Payroll administrators, approvers and auditors each see what they can use.
- **Payroll run page:** calculate/finalize buttons follow permissions. Readiness blockers are explained, including maker-checker. The variance table shows classification and a per-component breakdown with causes. The finalize dialog asks for an override reason when needed and shows the approval record afterwards.
- **Settings:** company name, approval mode, materiality threshold, block-on-unexplained toggle, and team management (add user, change role, deactivate).
- **Registration:** optional company name.

## 4. Upgrading an existing database

```bash
cd backend
npm run migrate:dry-run
npm run migrate
```

Adds company records for existing workspaces and builds the Company and idempotency indexes.

## 5. What Wave 1 did not do

| Item | Status |
|---|---|
| Production MongoDB as a replica set, with backups and point-in-time restore | Required before real payroll; infrastructure, not code |
| MFA / SSO | Not started (Wave 1 covered sessions, lockout, revocation) |
| Encrypted sensitive fields | Utility ready; fields arrive in Wave 2 |
| Attendance, leave, TDS, payments | Waves 3–7, deliberately not started |
| Frontend automated tests | Not started; UI verified manually in a browser |
| Load testing | Not started |

## 6. Next: Wave 2 — workforce foundation
Employee profile v2 (employment versions, organization units, designations, locations), statutory profile (PAN, UAN, ESIC number, PT state) and bank accounts stored with field encryption, masked by default, revealed only with `sensitive.read` and audited on reveal, plus structured employee documents.

## Sources consulted
- [Keka — Approval workflow (maker-checker) for payroll finalisation](https://help.keka.com/hc/en-us/articles/41388353533073-Approval-Workflow-Maker-Checker-for-Payroll-Finalisation)
- [Syssero — Workday payroll audits and machine learning](https://syssero.com/insights/workday-audits-and-machine-learning-support-a-proactive-ams/)
- [Zalaris — AI payroll anomaly detection explained](https://zalaris.com/resources/blog/ai-powered-payroll-anomaly-detection-what-is-it-and-how-can-it-be-safely-implemented)
- [PwC — Payroll controls for Workday](https://www.pwc.com/us/en/technology/alliances/workday-implementation-partners/security-controls/confident-compliance-with-payroll-controls-workday.html)
- [Stripe — Designing robust and predictable APIs with idempotency](https://stripe.com/blog/idempotency)
