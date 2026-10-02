# PayGuard Phase 12 — Remediation Report

**Date:** 2026-09-14
**Responds to:** `PAYGUARD_FORENSIC_AUDIT_REPORT.md` (2026-09-13)
**Evidence:** `npm test` in `backend/` — 7 suites, **450 tests, 0 failures** (MongoDB 8.0, Node 24)

This report maps every finding in the forensic audit to what changed and to the test that proves it. It also records defects the audit did not find, and places where the audit's reading of the code was inaccurate, so the next review starts from the real state of the system.

---

## 1. Headline results

| | Before | After |
|---|---|---|
| Critical findings open | 2 | 0 |
| High findings open | 5 | 0 |
| Payroll lifecycle runnable on a standalone MongoDB | No — every transaction failed | Yes (development fallback, loud warning); production refuses without a replica set |
| Phase 10 historical-isolation gate | 15+ failures (lifecycle could not finalize) | 104 / 104 |
| Backend tests | 424 (Phase 10 failing) | 450 passing |
| Endpoints that leaked data across companies | Employees, stats, employee accounts, audit logs, snapshot verify | None found; covered by HTTP tests |

---

## 2. Critical and high findings

| # | Audit finding | Status | What changed | Evidence |
|---|---|---|---|---|
| C1 | Employee hard delete | **Fixed** | `DELETE /api/employees/:id` archives: `isDeleted`, `deletedAt`, `deletedBy`, `deletionReason`, status → inactive, login deactivated and sessions revoked. Query middleware hides archived records by default. `POST /:id/restore` added. Email stays reserved while archived. | `test_phase12.js` → *archiving is a soft delete…*, *archiving an employee immediately ends their self-service access* |
| C2 | No audit on deletion | **Fixed** | `EMPLOYEE_DELETED` (mode `SOFT_DELETE`, reason) written in the same transaction. Create, update, restore and every login-account change are audited too. | same tests; audit event asserted with `companyId` |
| H1 | No rate limiting | **Fixed** | Login 5/min, registration 5/hour, payroll actions 30/min, baseline 600/min per IP. `TRUST_PROXY` setting so limits see real client IPs. Per-account lockout after 5 failures. | *repeated failed logins lock the account* |
| H2 | No object-level authorization | **Fixed** | Every employee, salary, account, payroll, snapshot, register, variance and audit query is scoped to the caller's company. Foreign IDs return **404, not 403**, so existence is not disclosed. | *another company cannot list, read, update, archive or see salary…* |
| H3 | Two current salary versions possible | **Fixed** | `isCurrent` flag kept in step by save and query hooks; partial unique index `unique_current_salary_per_employee`. | *the database refuses a second open-ended salary version* |
| H4 | Snapshot immutability app-level only | **Fixed (ORM level)** | Every Mongoose update/delete excludes `FINALIZED` snapshots from its filter; re-saving a snapshot is refused. Raw DB writes remain possible and are **detected** by the snapshot hash. | *finalized snapshots cannot be modified or deleted through the model*; Phase 10 STEP-25 |
| H5 | `$set: req.body` mass assignment | **Fixed** | Explicit field allowlist; protected fields rejected with 422; unknown fields ignored. | *profile updates reject protected fields…* |

## 3. Medium findings

| Audit finding | Status | What changed |
|---|---|---|
| Deep-equality assertions in tests | Already present | Phase 10 uses a recursive deep diff; it simply could not run before (see §4.1). |
| No logging aggregation | **Partly addressed** | Structured JSON logs with request IDs and redaction, ready for any log shipper. No vendor integration configured. |
| Hard-coded localhost CORS origins | **Fixed** | Local dev origins only outside production; `CORS_ORIGINS` for extra origins. |
| No backup / DR plan | **Open** | Still an operations task (see roadmap). |
| Manual crash recovery | **Fixed** | Stuck-run monitor fails PROCESSING runs with a stale heartbeat, audited as a `system` actor; safe with multiple instances. |
| No load test | **Open** | Eligibility now loads salaries in one query and caches PT rules per state; not load-tested. |
| Settings page without backend | Unchanged | Page shows real session data only; no false claims. |
| TDS deferral must be clear | **Improved** | Every payslip lists "TDS not deducted" and "attendance not applied" as explicit limitations. |
| Unverified: stack-trace leakage | **Fixed** | Stacks only in development; unexpected errors in production return a generic message plus request ID. |
| Unverified: error mapping | **Fixed** | Validation → 422, duplicate key → 409, bad JSON → 400, oversized body → 413, CORS → 403. |

---

## 4. Defects the audit did not find

These were found while verifying the audit against the code. Several were more serious than the audit's critical items.

1. **The payroll lifecycle could never complete on the configured database.** Local MongoDB is standalone, and every `startTransaction()` fails there, so no run could be created atomically or finalized. Phase 10 had been failing for this reason. *Fix:* `utils/transaction.js` detects capability, retries transient conflicts, refuses in production without a replica set, and degrades with a warning in development.
2. **Every employee endpoint returned every company's data.** List, get, update, delete and stats had no company filter, and registration is public, so any new sign-up could read and delete all employees in the database. (The audit rated object-level authorization "future multi-tenant risk".)
3. **`POST /payroll-runs/:id/finalize` bypassed snapshots.** It moved READY_FOR_FINALIZATION → FINALIZED without materializing or verifying payslips, breaking the core FINALIZED invariant, and it was the endpoint the frontend called. It now runs materialize → completeness, duplicate and hash checks → atomic finalize.
4. **A second salary revision was impossible.** The overlap check matched the open-ended current version for any later date, so every revision after the first returned 409.
5. **Concurrent audit writes failed the business operation.** Two writers read the same chain head; the loser hit the unique `sequenceNumber` index and returned 500 after the state change had already happened. Appends now retry; 25 concurrent writes produce one linear, verifiable chain.
6. **Silent Maharashtra default survived in the schema.** `SalaryStructure.workState` defaulted to `'MH'`, contradicting the documented "no default state" policy. Removed; the API requires `workState`.
7. **The state machine was enforced only in the service.** `transitionStateAtomically(run, 'FINALIZED', 'PROCESSING')` succeeded. Model hooks now enforce `ALLOWED_TRANSITIONS` on every query update and document save.
8. **Snapshot verification leaked across companies.** `GET /payroll-snapshots/:id/verify` had no ownership check.
9. **Employee login accounts were cross-tenant.** Any admin or manager could create, read or deactivate a login for another company's employee.
10. **Cancelled runs were deleted** when a period was re-run, destroying history; the partial unique index described in the model was never actually created.
11. **The `idempotencyKey` sparse index was never built** (declared twice with conflicting options).
12. **Search built a RegExp from raw user input** (pattern injection / ReDoS).
13. **Deactivated users kept access until their token expired**; role changes did not apply; logout left the token valid. Sessions are now re-validated against the database on every request, with "sign out on all devices".
14. **Login enabled account enumeration** (status revealed before the password check; no timing equalization).
15. **Frontend workflow errors:** "Process" was enabled for already-processed runs, there was no materialize or cancel/recover path, and the snapshot link pointed to a route that does not exist.
16. **A fresh install could not run payroll:** no way to create statutory rules. `npm run seed:compliance` added.

## 5. Corrections to the audit's reading of the code

| Audit statement | Actual state before this phase |
|---|---|
| "Rate limiting NOT FOUND" | A 5/min limiter existed on login; registration and payroll actions were unprotected. |
| "Any logged-in user can modify any employee's salary" | Role checks existed (`requireRole`); the real defect was the missing **company** scoping. |
| Audit sequence numbering "PROTECTED (unique index)" | The unique index turned concurrency into request failures after the business change (§4.5). |
| Concurrent finalization "DEFERRED TO PHASE 9" | Phase 9 finalization existed and was correct; the legacy endpoint bypassed it (§4.3). |
| Employee delete handler at line 289 | Correct. |
| PayrollRun partial unique index "NOT VERIFIED" | Not partial; the model created a full unique index, which is why tombstones were deleted. |

---

## 6. New capabilities delivered

| Capability | Endpoint / location | Why it matters |
|---|---|---|
| Explainable payslips | `GET /api/payroll-snapshots/:id/explain`, `GET /api/me/payslips/:id` | Every deduction shows the formula with real numbers, the exact rule version, rounding, and month-specific rules. The payslip re-checks its own arithmetic and verifies its hash. |
| Frozen rule parameters | `ruleProvenance[].parameters` | A payslip from years ago can be explained without trusting today's rule tables. |
| Variance / anomaly review | `GET /api/payroll-runs/:id/variance` | Before locking a period: new/missing employees, gross or net swings, **net pay changing without a salary change**, enrolment and work-state changes, non-positive net pay. The UI requires acknowledging high-severity flags before finalizing. |
| Payroll register | `GET /api/payroll-runs/:id/register` | Gross, net, cost to company, statutory totals, department breakdown. |
| Retroactive revision warning | `POST /api/employees/:id/salary` → `warnings` | A revision effective inside a finalized period says arrears are due, instead of silently leaving the employee underpaid. |
| Employee self-service | `/api/me/payslips`, `/my/payslips` | Employees see only their own finalized, verified payslips. |
| Statutory rounding & month rules | `roundingMode`, `epsWageCeiling`, `monthOverrides` | EPF nearest-rupee, ESIC round-up, Maharashtra February PT — all versioned with the rule. |
| Automatic stuck-run recovery | `jobs/stuckRunMonitor.js` | No human needed after a crash mid-calculation. |
| Operations | `/api/ready`, request IDs, structured logs, graceful shutdown, `npm run migrate[:dry-run]` | Deployable behind a load balancer and upgradable from an existing database. |

---

## 7. Self-assessed scorecard

These are the author's scores against the audit's categories, backed by the tests above. **They are not an independent audit**; the next review should re-score.

| Category | Audit | Now | Remaining gap to 10 |
|---|---|---|---|
| Architecture | 7 | 8.5 | Single process does calculation inline in the HTTP request; no job queue for very large runs. |
| Database integrity | 5 | 9 | Guards are ORM-level; raw DB access is detectable, not preventable (needs DB-user permissions + change streams). |
| Payroll correctness | 8 | 8.5 | Correct within scope; no proration, LOP, arrears computation, or TDS. |
| Compliance architecture | 8 | 8.5 | EPF/ESI/PT only; ESI contribution-period continuity, gender-based PT exemptions and LWF not modelled; no statutory filings. |
| Security | 6 | 8 | No MFA/SSO, no field-level encryption, CSRF relies on SameSite=Strict, no penetration test. |
| Auditability | 7 | 9 | Chain verification is on demand; no external anchoring of chain heads. |
| Concurrency | 6 | 8.5 | Proven for audit appends and state transitions; no load test at scale. |
| Testing | 6 | 8 | Strong backend integration coverage; no frontend tests, no CI pipeline, no replica-set test job. |
| Frontend | 7 | 8 | Correct workflow and new screens; no automated UI tests or accessibility audit. |
| Product completeness | 6 | 6.5 | TDS, attendance/LOP, payouts, filings, payslip PDFs (see `COMPETITIVE-STRATEGY.md`). |
| FinTech credibility | 5 | 8 | Claims now match behaviour; needs SOC 2 / ISO 27001 path and third-party review. |

**Go / no-go:** the audit's four "must fix before next phase" conditions are met. The platform is ready for the next phase of product work. Payroll cannot run in production until TDS and attendance are built and a replica-set deployment with backups is in place.

---

## 8. Upgrading an existing database

```bash
cd backend
npm run migrate:dry-run   # report changes; exits 1 if data needs review
npm run migrate           # apply
npm run seed:compliance   # only if statutory rules are missing
```

The migration never rewrites audit records. Events recorded before `companyId` existed keep verifying, but they do not appear in the company-scoped audit API.
