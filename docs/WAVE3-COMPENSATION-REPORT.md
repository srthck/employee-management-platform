# Wave 3 — Compensation control plane

Status legend: **PASS** verified by an automated test or a recorded check · **FAIL** · **NOT VERIFIED** built or claimed but not proven here · **NOT BUILT** deliberately out of scope.

## What changed

Compensation is now a domain, not a row of salary fields. A company has a catalogue of components that carry semantics; an employee has effective-dated compensation versions built from those components; each amount records how it was derived; and a pay change travels a controlled workflow with a financial impact preview before anyone approves it.

The payroll engine was not rewritten. `SalaryStructure` remains its input and keeps its exact shape, so payroll, its frozen snapshots and its history are untouched. Every pay change now writes the compensation version **and** that projection in one transaction, so there is a single write path and the two can never disagree.

```
CompensationComponent (catalogue: what a component IS)
        │
        ▼
CompensationVersion (per employee, effective-dated, with lineage and CTC)
        │  projected in the same transaction
        ▼
SalaryStructure  ─────▶ payroll engine ─────▶ staging ─────▶ immutable snapshot
        ▲
ComplianceRuleVersion (what the LAW does with it — never stored in a component)
```

## Model

| Collection | Holds | Versioning |
|---|---|---|
| `compensationcomponents` | code, type, recurrence, calculation method, tax / PF / ESI / PT / CTC / payslip treatment, and what payroll does with it | Definition versions; append-only |
| `compensationversions` | the employee's components with amounts, per-line lineage, wage bases, totals, CTC and a statutory estimate | Effective-dated, one current per employee, append-only |
| `compensationchangerequests` | the workflow: proposal, impact, approval, decision, resulting version | State machine enforced at the model layer |

**CTC is not gross and gross is not net.** Gross is the recurring earnings. Net is gross less employee deductions (statutory ones computed by the payroll engine). CTC is gross plus employer contributions, annualised with one-time pay.

**Components carry semantics, never law.** Statutory components (PF, ESI, professional tax) are seeded as system-managed: their amounts always come from versioned compliance rules, and they cannot be edited, archived or assigned an amount. Assigning one to an employee is refused.

## Calculation

Methods: `FIXED_AMOUNT`, `PERCENT_OF_BASIC`, `PERCENT_OF_GROSS`, `PERCENT_OF_COMPONENT`, `FORMULA`.

- `FORMULA` is a declarative expression tree (`SUM`, `DIFFERENCE`, `PRODUCT`, `MIN`, `MAX`, `PERCENT` over component references and constants), validated and depth-limited. There is no executable code anywhere in a component definition.
- Lines are evaluated in dependency order by topological sort. A loop is refused with the cycle named (`COMPONENT_DEPENDENCY_CYCLE`), never resolved by guesswork.
- `PERCENT_OF_GROSS` is defined precisely as a percentage of the gross formed by the components that do not themselves depend on gross, so the result can never be ambiguous.
- Every line stores its own lineage: method, base label, base amount, rate, the inputs it used, and a readable explanation such as `40% of BASIC ₹30,000.00 = ₹12,000.00`.

Component treatments reach payroll where payroll can honour them today: components marked as PF wage form the PF wage base, projected onto the engine's `pfWageOverride`. Marking a component outside the ESI or professional tax wage is recorded but **not** applied yet — payroll still calculates those on gross, and the impact preview says so.

## Change workflow

```
PROPOSED → SUBMITTED → EFFECTIVE (or SCHEDULED, until its date)
                    ↘ REJECTED
PROPOSED / SUBMITTED → CANCELLED
```

- Company setting `compensationApprovalMode`. Under `maker_checker` the approver cannot be the proposer, and the direct salary endpoint is closed (`COMPENSATION_APPROVAL_REQUIRED`), so pay can only change through an approved request.
- Approval recomputes the impact and refuses if the compensation the proposal was based on has changed since (`BASELINE_CHANGED`).
- Approval applies the change: compensation version, payroll projection, request state and audit events, all in one transaction.
- A future-dated approval is `SCHEDULED`: the version and projection are written immediately with the future date, so payroll is already correct; a job moves the request to `EFFECTIVE` on the day.
- Approving carries an `Idempotency-Key`: a retried approval replays the first result instead of applying a second pay change.

## Impact preview

Both sides are computed under the compliance rules valid on the **same** effective date, so a delta shows the pay change and never a rule change. The rule versions used are returned with the preview.

Reported as before / after / change: monthly gross, employee deductions, net pay before tax, employer contributions, monthly CTC, annual CTC (with percentage). Plus the first payroll period the change lands in and its run status.

Reviewer notes raised automatically: `RETROACTIVE_PERIODS`, `MID_PERIOD_EFFECTIVE`, `GROSS_REDUCED`, `ESI_ELIGIBILITY_CHANGED`, `PF_WAGE_ABOVE_CEILING`, `PROFESSIONAL_TAX_SLAB_CHANGED`, `COMPONENTS_NOT_APPLIED_IN_PAYROLL`, `ESI_WAGE_BASE_NOT_APPLIED`, `STATUTORY_RULES_UNAVAILABLE`.

## Honesty about what payroll actually pays

Every component and every compensation line carries `payrollApplication`:

| Value | Meaning |
|---|---|
| `GROSS_INPUT` | part of the monthly gross the payroll engine calculates on |
| `STATUTORY_ENGINE` | the amount comes from versioned compliance rules at run time |
| `NOT_APPLIED_YET` | recorded and counted in CTC, but payroll does not pay or deduct it yet |

One-time earnings (bonus), voluntary deductions (VPF, NPS employee) and employer contributions other than PF and ESI (gratuity, NPS employer) are `NOT_APPLIED_YET`. The UI labels them, the impact preview names them, and payroll readiness raises `COMPENSATION_COMPONENTS_NOT_APPLIED`. Nobody can assume money moves that does not.

> **Subsequent Wave 3.5 changes.** The paragraph above records the state as delivered in Wave 3 and is kept as the historical record. Wave 3.5 later made recurring voluntary deductions and recurring employer contributions payroll-applied, so they are no longer `NOT_APPLIED_YET`; one-time components such as a bonus still are. See [WAVE35-COMPENSATION-OPERATIONS-ADDENDUM.md](WAVE35-COMPENSATION-OPERATIONS-ADDENDUM.md).

## Permissions added

| Duty | Administrator | HR manager | Payroll administrator | Payroll approver | Auditor |
|---|---|---|---|---|---|
| See compensation (`compensation.read`) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Propose a change (`compensation.propose`) | ✓ | ✓ | ✓ | — | — |
| Approve a change (`compensation.approve`) | ✓ | — | — | ✓ | — |
| Manage the catalogue (`compensation.component.manage`) | ✓ | — | ✓ | — | — |

## Verification

Evidence: `backend/test_wave3.js` (19 tests), the full backend suite, and `frontend/e2e/compensation.spec.js`.

| Acceptance bar | Status | Evidence |
|---|---|---|
| Existing tests still pass | PASS | Full suite: 505 passed (486 before Wave 3 + 19 new), 0 failed |
| New compensation tests pass | PASS | 19/19 in `test_wave3.js` |
| 0 skipped | PASS | Suite reports `skipped 0` |
| Historical isolation | PASS | July payroll finalized, then compensation changed: snapshots byte-for-byte identical, payslip integrity still verifies |
| Effective-dated compensation | PASS | Versions close at the instant before the next begins; `findValidForDate` returns the right version per date; a future-dated change leaves earlier periods on the old pay |
| Component semantics | PASS | Catalogue treatments asserted; marking special allowance as PF wage moved the PF wage base to ₹14,000 and payroll deducted ₹1,680, exactly what the estimate predicted |
| Compensation change approval | PASS | Full workflow tested, including rejection with a reason and cancellation before approval |
| Maker-checker enforced | PASS | The proposer's own approval is refused (`SEGREGATION_OF_DUTIES`); the direct salary path returns `COMPENSATION_APPROVAL_REQUIRED` |
| Impact preview deterministic | PASS | Same inputs produce identical amounts; a preview writes nothing |
| Payroll integration does not corrupt runs | PASS | Payroll processed from the projection; staging inputs and amounts match the compensation estimate; every compensation version has a matching projection with the same gross, employee, date and work state |
| Transaction rollback | PASS | An injected audit failure during approval left no version, no salary change, and the request still approvable |
| Idempotency | PASS | A retried approval with the same key replayed and created one version |
| Tenant isolation | PASS | Another company's employee, change and catalogue are 404 or empty |
| Audit chain valid | PASS | Verified after every Wave 3 action |
| Browser workflow | PASS | Propose with impact → send for approval → approve by a second person → new pay in effect with its lineage |
| No console errors or failed requests | PASS | The browser tests collect page errors and 5xx responses; both empty |
| Migration | PASS | Seeds each company's catalogue and converts existing salary versions; idempotent on re-run |
| Load and performance | NOT VERIFIED | No load tests. Evaluation is O(components) per employee with one dependency sort |

Two defects were found by the browser test and fixed: tall dialogs could not reach their own submit button (dialogs now scroll), and the "Send for approval" button only created a draft (it now proposes and submits, and also approves when the company does not require a second person).

## Not built (deliberately)

- **Income tax (TDS)** — tax treatments are recorded, nothing is calculated (Wave 6).
- **Retro pay and arrears** — a change effective inside a finalized period is reported, never applied backwards (Wave 8).
- **Payments** — nothing here moves money (Wave 7).
- **Proration** — a change effective mid-period pays the whole month at the new rate; the preview and readiness say so (Wave 4).
- **Off-cycle and bonus runs** — one-time components are carried in CTC only (Wave 8).
- **Reimbursements, loans and advances** — representable as components, not paid by payroll (later waves).
- **ESI and professional tax wage bases from component treatments** — recorded, but payroll still uses gross.
- **Editing a formula in the UI** — formulas are accepted through the API and preserved; the dialog keeps them as recorded.

## Running it

```powershell
cd backend
npm run db:start      # replica set on 27018
npm run migrate       # seeds catalogues, converts existing salary versions
npm test              # 505 tests, transactions required
cd ../frontend
npm run test:e2e      # 5 browser tests, disposable payguard_e2e database
```
