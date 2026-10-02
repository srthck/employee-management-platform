# Wave 1.5 and Wave 2 — Foundation hardening and Employee 360

Status legend: **PASS** verified by an automated test or a recorded check · **FAIL** · **NOT VERIFIED** built or claimed but not proven here · **NOT BUILT** deliberately out of scope.

## Summary

Wave 1.5 removed the last difference between the verified test environment and the normal runtime. Development, tests, browser tests and production now all run on a MongoDB replica set with transactions required, and the server refuses to start otherwise.

Wave 2 makes the employee a central, versioned workforce object without enlarging the `Employee` document. Employment history, statutory identifiers, bank accounts and documents live in separate collections. Sensitive identifiers are encrypted, masked by default and revealed only through an audited, permission-gated action. A payroll readiness check answers "Can this employee safely enter the next payroll?" using the same eligibility decision payroll calculation uses.

Existing payroll foundations were not rewritten. The only change to payroll eligibility is additive: an employee whose last working day is before a period is blocked from that period.

## Wave 1.5 — Foundation hardening

| Item | Status | Evidence |
|---|---|---|
| Normal runtime on a transaction-capable MongoDB | PASS | `backend/.env` → `mongodb://127.0.0.1:27018/employee_management?replicaSet=rs0`; `/api/ready` returns `"transactions":"supported"` |
| `REQUIRE_TRANSACTIONS=true` by default in every environment | PASS | `test_wave15.js` checks development, test and production defaults; only an explicit non-production `false` opts out |
| Server refuses to start without transactions | PASS | Started against the standalone MongoDB (27017): startup aborted with an error, port never opened |
| Test and runtime transaction semantics identical | PASS | `npm test` runs every suite on the replica set; the three transaction tests that used to skip on standalone now fail instead of skipping |
| Modern email / TLD validation | PASS | Shared `EMAIL_PATTERN` in Admin, Employee and EmployeeAccount models; `.technology`, `.email`, `.museum` accepted, malformed addresses rejected (`test_wave15.js`), and the browser test registers with `@payguard.technology` |
| Existing data moved to the replica set without alteration | PASS | `npm run db:copy` copied 13 collections with matching counts; `test_wave15.js` proves documents are byte-identical and a non-empty target is refused |
| Demo and test artifacts cleaned | PASS | 6 demo accounts, 4 demo workspaces and their payroll data removed from the runtime database; real accounts untouched; audit records kept (the chain is global, so deleting entries would break verification). Leftover test databases dropped. Test suites now drop their databases on teardown (verified: none remain after a full run) |
| Critical frontend E2E coverage | PASS | Playwright suite (`frontend/e2e`): registration, maker-checker close with override, permission-gated screens, Employee 360 |
| 0 failed / 0 skipped | PASS | Backend: 486 passed, 0 failed, 0 skipped. Browser: 4 passed |

Also fixed during Wave 1.5: "Create payroll run" was shown to users without `payroll.prepare` (the API already refused them); it is now hidden.

The original standalone database on port 27017 was left untouched as a backup copy.

## Wave 2 — Workforce identity and Employee 360

### Data model

| Collection | Holds | Versioning | Sensitive |
|---|---|---|---|
| `employees` | Identity and a projection of current department, position and status (unchanged shape) | — | No |
| `employmentrecords` | Department, designation, manager, work location, employment type, probation, lifecycle and exit | Effective-dated: `effectiveFrom` / `effectiveTo`, one current version per employee | No |
| `employeestatutoryprofiles` | PAN, UAN, ESIC insurance number, PF member ID | Version number; superseded versions kept | Yes: encrypted |
| `employeebankaccounts` | Holder, bank, IFSC, account type, account number | Version number plus `effectiveFrom` | Yes: account number encrypted |
| `employeedocuments` | Type, title, validity dates, SHA-256 fingerprint, verification decision | Decision is final; corrections are new records | No |

Statutory and bank data are deliberately outside `employees`. Payroll staging freezes the whole employee document into history, so keeping them separate guarantees they are never copied into payroll snapshots. The test searches staging and snapshot records for ciphertext and plaintext and finds neither.

Model-layer guards (`models/guards.js`) reject query updates and deletes on all four new collections, and let an existing document change only the fields that close a version. This matches the existing guards on payroll snapshots and the audit log.

### Employment history rules

- Joining is recorded in the same transaction that creates the employee. The migration backfills older employees.
- A change closes the current version one millisecond before the new one starts and appends the new version, together with the Employee projection and the audit event, in one transaction.
- Changes are appended after the current version. Backdating before it, or rewriting a recorded version, is refused (`EFFECTIVE_DATE_NOT_AFTER_CURRENT`, `EMPLOYMENT_HISTORY_IMMUTABLE`).
- Only an exit can be scheduled ahead, by its last working day. Other changes must be recorded on or after the day they take effect, because the Employee projection used by payroll is updated at recording time.
- A manager must be a current employee of the same company, never the employee, and must not create a reporting cycle.
- An exit does **not** set the employee inactive. Payroll eligibility reads the exit record and excludes the employee from periods that start after the last working day, so an exit recorded late still pays the final period.
- Edits to department, position or hire date on the employee record stay consistent: while joining is the only version they correct it in place (audited with the previous values); afterwards they add a new version, and the hire date is locked.

### Sensitive-data controls

| Requirement | Status | How |
|---|---|---|
| Encrypted at rest | PASS | AES-256-GCM, random IV, context bound to `company:employee:field`; the model rejects any value that is not ciphertext |
| Masked by default | PASS | Last four characters stored beside the ciphertext; every read API returns masked values only |
| Permission-controlled | PASS | Reveal needs `sensitive.read` (administrator, payroll administrator); HR managers and auditors see masked values |
| Explicit, reasoned reveal | PASS | `POST …/reveal` with a 10–300 character reason; rate limited; `Cache-Control: no-store` |
| Reveal audited | PASS | `SENSITIVE_FIELD_REVEALED` (field, reason, actor) is written **before** the value is returned |
| Never in ordinary APIs | PASS | Employee list and detail responses contain no statutory or bank data (tested) |
| Never plaintext in audit or logs | PASS | Test captures all console output and reads every audit record and stored idempotent response: no identifier appears |
| Tamper detection | PASS | Ciphertext copied to another employee fails verification, returns no value and is audited as `SENSITIVE_FIELD_INTEGRITY_FAILED` |
| Duplicate PAN within a company | PASS | Company-scoped blind index plus unique partial index; a different company may hold the same PAN |
| Shared bank account detection | PASS | Company-scoped blind index; flagged on save and in readiness without decrypting |
| Startup refuses missing or broken keys | PASS | `assertFieldEncryptionConfigured()` in `server.js`; the E2E run proved it by refusing a mismatched active key |
| Key rotation | PASS (Wave 1 test) | Multiple key IDs; old values remain readable |
| Key custody (KMS / HSM) | NOT BUILT | Keys come from environment variables; production should load them from a secret manager |

Aadhaar is intentionally not collected.

### Segregation of duties added

| Duty | Administrator | HR manager | Payroll administrator | Payroll approver | Auditor |
|---|---|---|---|---|---|
| Record employment changes (`employee.write`) | ✓ | ✓ | — | — | — |
| Update statutory identifiers (`employee.statutory.write`) | ✓ | ✓ | ✓ | — | — |
| Change salary bank account (`employee.bank.write`) | ✓ | ✓ | — | — | — |
| Record documents (`employee.document.write`) | ✓ | ✓ | ✓ | — | — |
| Verify documents (`employee.document.verify`, never own) | ✓ | ✓ | — | — | — |
| Reveal sensitive values (`sensitive.read`) | ✓ | — | ✓ | — | — |

Whoever prepares payroll cannot change where salary is paid.

### Payroll readiness

`GET /api/payroll-readiness` (company) and `GET /api/employees/:id/payroll-readiness` (one employee). The default period is the month after the latest finalized run, otherwise the current month.

- **BLOCKED**: exactly the employees payroll calculation would exclude, because both use `resolveEligibleEmployees`. Codes: `NO_SALARY_VERSION`, `MISSING_PT_JURISDICTION`, `UNSUPPORTED_PT_JURISDICTION`, `EPF_RULE_MISSING`, `ESI_RULE_MISSING`, `HIRED_AFTER_PERIOD`, `EXITED_BEFORE_PERIOD`, `NOT_ACTIVE`. The test compares readiness with payroll preflight for the same period and gets the same set.
- **WARNING**: calculable but needs attention. Codes: `EXIT_WITHIN_PERIOD`, `PAN_MISSING`, `UAN_MISSING` (PF enrolled), `ESIC_NUMBER_MISSING` (ESI applies under the wage ceiling), `BANK_ACCOUNT_MISSING`, `BANK_ACCOUNT_RECENTLY_CHANGED` (within 30 days of period end), `BANK_ACCOUNT_SHARED`, `DOCUMENT_EXPIRED`.
- **READY**: nothing found.

The Employees list shows a readiness column and a company summary; Employee 360 shows the reasons.

### Verification

| Area | Status | Evidence |
|---|---|---|
| Employment history, manager rules, projection consistency | PASS | `test_wave2.js` |
| Statutory encryption, masking, uniqueness, versioning | PASS | `test_wave2.js` |
| Reveal permission, reason, audit-first, no leakage, tamper detection | PASS | `test_wave2.js`; browser: payroll administrator reveal, auditor sees no reveal |
| Bank versioning, masking, shared-account flag, segregation of duties | PASS | `test_wave2.js`; browser: payroll administrator has no bank action |
| Documents: verification by another person, final decisions | PASS | `test_wave2.js`; browser: HR records, owner verifies |
| Readiness states and parity with preflight | PASS | `test_wave2.js`; browser: WARNING → READY after data is completed |
| Historical isolation | PASS | Finalized snapshots are byte-for-byte identical after later employment, statutory, bank and profile changes |
| Transactions | PASS | Employment change rolls back entirely when its audit write fails (replica set, transactions required) |
| Migration | PASS | Backfill tested and idempotent; applied to the development database (2 employees) |
| Tenant isolation | PASS | Another company's employee, account or readiness returns 404 |
| Audit chain | PASS | Verifies after every Wave 2 action |
| Load and performance | NOT VERIFIED | No load tests. Readiness runs a fixed number of queries per request, independent of headcount |

## Not built (known gaps)

- Document file storage: only a browser-computed SHA-256 fingerprint is recorded.
- Future-dated employment changes other than exit; the projection updates at recording time.
- Approval workflow for bank account changes. It is flagged in readiness today and belongs with payments (Wave 7).
- Exit proration and full and final settlement (Wave 4 and Wave 8).
- Employee self-service view of their own masked identifiers and bank account.
- Two-factor authentication, SSO and a managed key service.

## Running it

```powershell
cd backend
npm run db:start        # single-node replica set on 27018
npm run migrate         # backfills employment history, builds indexes
npm test                # 486 tests, transactions required
cd ../frontend
npm run test:e2e        # browser tests on a disposable payguard_e2e database
```

`FIELD_ENCRYPTION_KEYS` and `FIELD_BLIND_INDEX_KEY` are required; see `backend/.env.example`.
