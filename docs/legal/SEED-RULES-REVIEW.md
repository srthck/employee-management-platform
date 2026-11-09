# Seed compliance rules — line-by-line source review

File reviewed: `backend/scripts/seed-compliance-rules.js` (values as of commit `b0e3656`, unchanged since). Review date 2026-10-27; EPF section revised 2026-11-09 for the Employees' Provident Funds Scheme, 2026 and S.O. 5109(E).

**This is an engineering review of what each seeded value claims and what supports it. It is not legal advice and it approves nothing.** The decision numbers (D-n) refer to the Phase 1D legal decision register and its 2026-11-06 addendum, kept with the programme evidence (outside the repository); every decision named here is **open** unless stated otherwise.

Classification vocabulary: **STATUTORY-VERIFIED** (value checked against a primary official source recorded in the evidence manifest), **LEGACY** (a pre-Code value carried forward without a Code-era decision), **PRODUCT** (a PayGuard configuration or practice, not a statement of law), **PLACEHOLDER** (a deliberately non-authoritative value), **UNVERIFIED**.

## What the seed is

Platform-level rule versions inserted once (idempotent on type + jurisdiction + effectiveFrom) so that a fresh installation can run the **legacy** payroll path. The seed is never read by the Phase 1D statutory-wage scaffold, and nothing here enables a Code-era calculation. Changing a description changes only rules inserted after the change; existing database rows keep their stored text (rules are versioned, never edited).

## EPF / IN, effectiveFrom 2014-09-01

> **Open conflict (D20).** S.O. 5109(E) of 17 September 2026 notifies ₹25,000 per month as the wage ceiling for the purposes of Chapter III of the Code, superseding ₹15,000, and para 18(3) of the Employees' Provident Funds Scheme, 2026 ties contributions to the notified ceiling. This rule caps at ₹15,000 with no end date. If ₹25,000 applies, the legacy path under-calculates each share by up to ₹1,200 per month for periods from that date. Not changed here: it needs counsel, then a new rule version.

| Line | Value | Source | Classification | Note |
|---|---|---|---|---|
| `employeeContributionRate: 0.12`, `employerContributionRate: 0.12` | 12 % | Para 18(2), Employees' Provident Funds Scheme, 2026 (G.S.R. 525(E), 29 Jun 2026) | **STATUTORY-VERIFIED (rate only)** | The ten per cent class of establishments is not modelled. The rule's `effectiveFrom` predates the Scheme |
| `wageCapForContribution: 15000` | ₹15,000/month | S.O. 2702(E), 29 May 2026; **superseded** by S.O. 5109(E) | **SUPERSEDED, see D20** | Correct only up to 16 Sep 2026 on the plain text |
| `epsRate: 0.0833`, `epsWageCeiling: 15000` | 8.33 % of ≤ ₹15,000 | Employees' Pension Scheme, 2026, para 4(2) as amended by G.S.R. 890(E), in force 17 Sep 2026 (ceiling) | STATUTORY-VERIFIED (ceiling from 17 Sep 2026); rate LEGACY | The rate was not re-checked against the 2026 Scheme |
| `roundingMode: 'NEAREST_RUPEE'` | to paise, then nearest rupee | Para 18(5): nearest rupee, fifty paise or more up | **STATUTORY for the rounding; sequence open (D21)** | The paise-first step gives ₹1 more than a literal reading for 0.48 % of wages with paise, and for no whole-rupee wage |
| description | was "EPF & MP Act 1952 …" | — | **corrected** | The 1952 Scheme is superseded; the new text states the conflict |

## ESI / IN, effectiveFrom 2019-07-01

| Line | Value | Claimed basis | Classification | Note |
|---|---|---|---|---|
| `employeeContributionRate: 0.0075`, `employerContributionRate: 0.0325` | 0.75 % / 3.25 % | Rule 19(1) of the Social Security (Central) Rules (G.S.R. 344(E)), as recorded in D12 | **STATUTORY-VERIFIED (rates only)** | The rates match the source-verified Rule 19 text. Effective date of the Code-era rule is not this row's `effectiveFrom` |
| `grossWageCeiling: 21000` | ₹21,000/month coverage ceiling | Pre-Code ESI notification | LEGACY | Status under the Code-era framework is open (D6); contribution-period continuation above the ceiling is not modelled (D5) |
| `roundingMode: 'CEIL_RUPEE'` | to paise, then up to the next rupee | ESIC practice | PRODUCT | **Differs from a literal reading of Rule 19** for ~0.5 % of wages (legacy ₹1 lower, never higher); D12 open. Quantified in the evidence `legal/esi-rounding/` |
| description | "ESI Act 1948 … contributions rounded up to the next rupee … the ₹25,000 ceiling for persons with disability" | — | **corrected** | Old text cited the repealed-and-saved Act as the basis, presented the rounding as the rule's, and asserted an unverified ₹25,000 disability ceiling |

## PT / MH, effectiveFrom 2000-01-01

| Line | Value | Claimed basis | Classification | Note |
|---|---|---|---|---|
| `ptSlabs` | ≤ ₹7,500 nil; ₹7,501–₹10,000 ₹175; > ₹10,000 ₹200 (₹300 in February) | Maharashtra State Tax on Professions, Trades, Callings and Employments Act, 1975 schedule | UNVERIFIED | No State instrument is in the evidence register (D18). Gender-specific thresholds are not modelled |
| `effectiveFrom` | 2000-01-01 | — | PLACEHOLDER | Already disclosed in the description |
| description | — | — | **corrected** | Now states that the slabs are configured, not verified |

## Production safety

None of the three rules is safe as a statement of current law for production statutory calculation. The legacy payroll path uses them as configured parameters; payslips already describe the rounding as "PayGuard rounding setting". Production Code-era calculation stays **NO-GO** (legal decision register; mandate Part I §4).

## Change made in this review

Only the three `description` strings in the seed were rewritten to state source and status accurately, including the open EPF ceiling conflict. No value, rate, ceiling, rounding mode, slab or effective date changed, and no stored rule version is modified.
