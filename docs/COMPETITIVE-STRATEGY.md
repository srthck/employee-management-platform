# PayGuard — Competitive Position and Roadmap

**Date:** 2026-09-14
**Purpose:** Decide where PayGuard can credibly beat established payroll products, and what must be built before it can compete at all.

---

## 1. The honest starting point

Established payroll products win on **coverage**: income tax, attendance, payouts, statutory filings, benefits, many countries, and years of edge cases. PayGuard has none of those yet. Competing feature-for-feature is a multi-year effort.

PayGuard does have something most payroll products are not built around: **every finalized payslip is an immutable, hash-verified record that carries the exact rule versions and parameters it used, backed by a tamper-evident audit chain.** The strategy is to turn that architecture into visible customer value — trust, explainability and error prevention — while closing the coverage gaps in priority order.

## 2. What the market complains about

Research from review aggregators and comparison sites (2026). Vendor-authored comparisons are marked; treat them as directional.

| Recurring complaint | Seen in | Source |
|---|---|---|
| Slow or unreachable support | Gusto, Rippling, Keka (weekend gaps, unescalated tickets), Zoho ("stuck on errors with no reachable help") | [SelectHub](https://www.selecthub.com/payroll-software/gusto-vs-rippling/), [HROne (vendor)](https://hrone.cloud/blog/razorpayx-payroll-alternatives/) |
| Botched pay runs and buggy updates | Rippling (notably international/Canadian payroll) | [SelectHub](https://www.selecthub.com/payroll-software/gusto-vs-rippling/) |
| TDS revision and reporting configuration problems | greytHR | [Capterra reviews](https://www.capterra.com/p/150850/greytHR/reviews?page=2), [HROne (vendor)](https://hrone.cloud/blog/razorpayx-payroll-alternatives/) |
| Customization limits force policy changes | India payroll suites generally | [HROne (vendor)](https://hrone.cloud/blog/razorpayx-payroll-alternatives/) |
| Error detection before money moves | ADP markets anomaly detection as a differentiator over Rippling | [SelectHub](https://www.selecthub.com/payroll-software/gusto-vs-rippling/) |

Regulatory pressure in India: the Code on Wages' uniform wage definition (effective 21 Nov 2025) requires basic + DA + retaining allowance to be at least 50% of remuneration, increasing PF wages for many structures ([Teamed](https://www.teamed.global/insights/india-labour-codes-2026-50-basic-pay-rule-explained), [TopSource Worldwide](https://topsourceworldwide.com/insights/new-wage-code-2026-the-impact-on-payroll-processing-in-india/), [Business Today](https://www.businesstoday.in/personal-finance/news/story/myth-busted-how-your-salary-has-changed-under-new-labour-codes-vs-epf-scheme-2026-542371-2026-07-11)). Structures built for the old rules produce wrong PF wages unless the payroll system checks this.

**Reading of the evidence:** customers do not primarily complain about missing features; they complain about **wrong pay they cannot diagnose and cannot get help with**. That is the gap PayGuard's architecture is suited to.

## 3. Where PayGuard can be better

| Pain | PayGuard answer | Status |
|---|---|---|
| "Why is my pay different?" tickets | Every payslip line shows its formula, numbers, rule version and rounding. Employees and admins see the same explanation. | **Built** |
| Wrong pay discovered after payday | Variance review before finalizing: net change without salary change, gross swings, missing/new employees, enrolment changes. High-severity flags must be acknowledged. | **Built** |
| Silent retroactive errors | Salary revisions inside a finalized period warn that arrears are due. | **Built** (arrears calculation: roadmap) |
| "Did someone change this?" | Hash-verified payslips, tamper-evident audit chain, verification in the UI. | **Built** |
| Botched runs after crashes or updates | Durable staging, idempotent materialization, atomic finalization, automatic stuck-run recovery, frozen historical inputs. | **Built** |
| Rule changes rewriting history | Rules are versioned by effective date; finalized payslips keep their rule parameters. | **Built** |
| Vendors overselling | Payslips state what is not included (TDS, attendance). | **Built** |
| Support that cannot explain pay | Support reads the same explanation trace, so answers come from the record, not from guesswork. | Enabled by the above; support tooling: roadmap |

## 4. Roadmap

Priorities are ordered by "cannot sell without it" first, then by how strongly each item compounds the trust advantage.

### P0 — required to run real Indian payroll

1. **Income tax (TDS):** new and old regimes, investment declarations and proofs, monthly projection, Form 16 / 24Q. The biggest complaint area for incumbents; build it explainable from day one.
2. **Attendance and loss of pay:** proration for mid-month joiners and leavers, LOP days, a versioned attendance input frozen into staging.
3. **Arrears and full-and-final settlement:** calculate arrears from the retroactive-revision warning; leave encashment, gratuity, notice recovery.
4. **Labour Code wage check:** flag structures where allowances exceed 50% of remuneration and compute the PF wage accordingly, as a versioned rule.
5. **Statutory outputs:** EPF ECR file, ESI contribution file, PT and LWF returns; more states' PT, including gender-based exemptions.
6. **Payouts:** bank transfer files (and later payout API integration) generated only from finalized snapshots, with reconciliation back to each payslip.
7. **Payslip PDFs and delivery** with the verification hash printed on the document.

### P1 — enterprise readiness

- Maker-checker finalization (a different admin must approve), configurable approval chains.
- Company entity with multiple legal entities, fine-grained roles, SSO (SAML/OIDC) and MFA.
- Field-level encryption for PAN, bank and identity numbers; data-retention policies.
- Accounting journal export (Tally, Zoho Books, NetSuite), webhooks and a public API.
- Job queue for calculation so runs of tens of thousands of employees do not tie up HTTP requests.
- Support console that shows an employee's explanation trace and period-to-period diff.

### P2 — differentiation at scale

- "Why did my pay change?" answered automatically from the snapshot diff and explanation traces (an assistant grounded only in the record, never generating numbers).
- External anchoring of audit chain heads so tampering is provable to a third party.
- Multi-country payroll using the same versioned-rule and snapshot model.

### Platform and assurance (runs alongside P0)

- CI pipeline running the full suite against a single-node replica set; frontend and accessibility tests.
- Docker Compose with a replica set for local development; infrastructure as code for production.
- Backups with point-in-time restore and tested recovery drills.
- OpenTelemetry tracing and alerting on failed runs and broken audit chains.
- Load test at 10k+ employees per run; external penetration test; SOC 2 Type II / ISO 27001 programme.

## 5. How to measure progress

| Metric | Why |
|---|---|
| Payroll corrections after finalization per 1,000 payslips | Direct measure of "pay right the first time". |
| Pay-related support tickets per 1,000 employees | Tests whether explanations actually remove questions. |
| Share of high-severity variance flags that led to a change before finalizing | Tests whether the review catches real errors. |
| Time from run creation to finalization | Guards against the review step becoming friction. |
| Audit chain and snapshot verification failures | Must stay at zero. |
