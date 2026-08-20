# Phase 11 Frontend API Inventory

Inventory captured on 2026-08-20 from the current backend route modules and controllers. Frontend pages must use only the READY contracts below.

## READY

| Capability | Endpoint | Method | Auth / role | Response shape | Status |
|---|---|---:|---|---|---|
| Health | `/api/health` | GET | Public | `{ status, timestamp, uptime, environment }` | READY |
| Login | `/api/auth/login` | POST | Public | `data: { user, token }` | READY |
| Register | `/api/auth/register` | POST | Public | `data: { user, token }` | READY |
| Current user | `/api/auth/me` | GET | Bearer JWT | `data: { user }` | READY |
| Employee list | `/api/employees` | GET | Authenticated | `data: { employees, pagination }` | READY |
| Employee stats | `/api/employees/stats` | GET | Authenticated | `data: { stats }` | READY |
| Employee detail | `/api/employees/:id` | GET | Authenticated | `data: { employee }` | READY |
| Employee create | `/api/employees` | POST | Authenticated | `data: { employee }` | READY |
| Employee update | `/api/employees/:id` | PUT | Authenticated | `data: { employee }` | READY, legacy profile fields only |
| Employee deactivate | `/api/employees/:id` | DELETE | Authenticated | `{ success, message }` | READY |
| Payroll run create | `/api/payroll-runs` | POST | Admin | `data: { run }` | READY |
| Payroll run list | `/api/payroll-runs` | GET | Admin / manager | `data: { runs, total, limit, skip }` | READY |
| Payroll run detail | `/api/payroll-runs/:id` | GET | Admin / manager | `data: { run }` | READY |
| Payroll preflight | `/api/payroll-runs/:id/preflight` | POST | Admin / manager | `data: { canProcess, eligibleEmployees, blockedEmployees, blockingErrors, warnings, ruleAvailability, attendanceAdjustment }` | READY |
| Payroll processing | `/api/payroll-runs/:id/process` | POST | Admin | `data: { run, processingResult }` | READY |
| Payroll finalization | `/api/payroll-runs/:id/finalize` | POST | Admin | `data: { run }` | READY, server remains authoritative |
| Run snapshots | `/api/payroll-runs/:runId/snapshots` | GET | Admin / manager | `data: { snapshots, total }` | READY |
| Snapshot detail | `/api/payroll-snapshots/:id` | GET | Admin / manager | `data: { snapshot }` | READY |
| Snapshot verification | `/api/payroll-snapshots/:id/verify` | GET | Admin / manager | `data: { valid, ...verificationFields }` | READY |

## BACKEND API REQUIRED

| Screen / capability | Required endpoint | Method | Required response | Current status |
|---|---|---:|---|---|
| Salary History | `/api/employees/:id/salary-structures` | GET | Effective-dated salary versions and components | No route exists |
| Salary Revision | `/api/employees/:id/salary-structures` | POST | Created salary version and authoritative gross | No route exists |
| Compliance Rules | `/api/compliance-rules` | GET | Version, type, jurisdiction, effective dates, source, parameters | No route exists |
| Audit Trail | `/api/audit-logs` | GET | Paginated events with actor, entity, action, hashes | No route exists |
| Audit Verification | `/api/audit-logs/verify` | GET or POST | Validity, records checked, broken sequence, reason | No route exists |
| Reports | Report-specific endpoint | GET/POST | Real report payload or downloadable artifact | No route exists |
| Secure authentication | Cookie-based auth contract | POST/GET | HttpOnly, Secure, SameSite cookie session | Backend currently returns bearer token |

## Explicit Limitations

- The backend employee `salary` field has no currency or payroll-version semantics. The frontend does not present it as authoritative payroll gross.
- Salary structures and compliance rules are internal models used by payroll processing, but they are not independently queryable from the frontend.
- Audit events are written internally through `auditService`; no HTTP read or verification route exists.
- Phase 10 historical-integrity approval remains blocked by the transaction-capable MongoDB replica-set requirement. The UI makes no production or transaction guarantee.
- TDS and attendance adjustment remain explicitly deferred by the backend payroll model.
