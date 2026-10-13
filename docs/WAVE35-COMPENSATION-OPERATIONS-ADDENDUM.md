# Wave 3.5 addendum — what payroll applies

Status: **in progress. This is not a Wave 3.5 release report.** It records one semantic change that affects how the Wave 3 report should be read. A full Wave 3.5 report will follow when the wave is verified.

## What changed relative to Wave 3

Wave 3 reported voluntary deductions (VPF, NPS employee) and employer contributions other than PF and ESI (gratuity, NPS employer) as `NOT_APPLIED_YET`. Wave 3.5 made the **recurring** ones payroll-applied:

| Component kind | Wave 3 | Wave 3.5 `payrollApplication` | Effect in a payroll run |
|---|---|---|---|
| Recurring earning | `GROSS_INPUT` | `GROSS_INPUT` (unchanged) | part of gross |
| Statutory (PF, ESI, PT) | `STATUTORY_ENGINE` | `STATUTORY_ENGINE` (unchanged) | from versioned compliance rules |
| Recurring deduction (VPF, NPS employee) | `NOT_APPLIED_YET` | `NET_DEDUCTION` | deducted from net pay on the earned amount |
| Recurring employer contribution (gratuity, NPS employer) | `NOT_APPLIED_YET` | `EMPLOYER_COST` | employer cost on the payslip and register; not deducted from the employee |
| One-time component (bonus) | `NOT_APPLIED_YET` | `NOT_APPLIED_YET` (unchanged) | counted in CTC, not paid by the monthly run (off-cycle is Wave 8) |

## Stored history versus current reporting

These are two different things and are kept distinct:

- **Stored history is immutable.** Compensation versions written before Wave 3.5 still carry the `payrollApplication` value they were written with. Nothing was rewritten.
- **Reporting is current interpretation.** The impact preview and payroll readiness decide whether a line is "not applied" from the line's recurrence together with the stored flag (`notAppliedLines` in `compensationService.js`), not from the stored flag alone. A recurring VPF line stored as `NOT_APPLIED_YET` before Wave 3.5 is therefore no longer reported as unapplied, because payroll now pays it. So the same stored version can be described differently today than when it was written. Only the description changes; the stored data and every finalized snapshot do not.

## Tests

`test_wave3.js` previously expected gratuity and VPF to be reported as unapplied. Those assertions now expect them **not** to be reported, and use a one-time `BONUS` as the component that still is. The numeric assertions were not changed.

## Payslip ESI and Professional Tax explanations (Phase 1C.5)

The payslip explains what a snapshot **recorded**, and claims nothing it did not record. Nothing is recomputed, and no amount, total, check, rounding or stored hash changes: only the explanation text and some additive response fields.

- **Legacy calculation basis.** The ESI contribution basis and the Professional Tax slab basis that Phase 1C freezes on a snapshot are described as a *legacy calculation basis* (the wording "ESI wage" is not used, and a legacy basis is never called a statutory ESI wage). The calculation model is `PAYGUARD_LEGACY_CONFIGURED_RULE`: rates, the ceiling and the rounding setting come from the frozen company rule version, and none of it is a determination under the Code on Social Security, 2020.
- **Not recorded means not recorded.** A snapshot without `statutoryBases.esiContributionWage` reports its ESI basis as `NOT_RECORDED`; it is never assumed to have been the gross. The same holds for the PT basis unless the snapshot recorded either `statutoryBases.ptSlabWage` or the `professionalTaxBasis` setting.
- **A legacy zero is not an ineligibility finding.** When the legacy check calculated no ESI contribution, the note says what PayGuard compared and calculated, and states that it is not a determination of statutory coverage.
- **ESI and PT are separate.** The ESI note refers to the Code; the Professional Tax note describes a State levy under the applicable State law and does not cite the Code or section 2(88).
- **Rounding.** Legacy rounding is described as PayGuard's configured rounding setting (to paise, then up to the next whole rupee, or to the nearest rupee). It is not described as the rounding the Code or Rules require; that interpretation is a separate, unresolved question.

Response fields added to the ESI and PT lines (additive; every earlier field keeps its name): `calculationModel`, `basisAmount` (number or `null`), `basisSource` (`RECORDED_ON_SNAPSHOT`, `RECORDED_PT_BASIS_SETTING` or `NOT_RECORDED`), `basisDerivation` (the stored `statutoryBases.basisSource`, when recorded), `recordedGrossMonthly`; on ESI also `coverageCheck` and `roundingModel`; on PT also `ptBasisSetting`. The response-level `basisSource` says where `basisAmount` comes from; it is not the stored `statutoryBases.basisSource`, which says how the bases were derived.
