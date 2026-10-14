/**
 * Snapshot-shaped documents of every historical vintage, for the compatibility tests.
 *
 * `shapes(computeSnapshotHash)` returns { name: document }. The documents contain no hash; the tests
 * hash them with the repository's own computeSnapshotHash and compare against goldens captured at the
 * Phase 1C checkpoint (HEAD a6a8432), so any later movement of the canonical hash is caught.
 */

const id = (n) => n.toString(16).padStart(24, '0');
const SLABS = [{ upTo: 7500, monthlyTax: 0 }, { upTo: 10000, monthlyTax: 175 }, { upTo: null, monthlyTax: 200 }];
const ESI = { employeeContributionRate: 0.0075, employerContributionRate: 0.0325, grossWageCeiling: 21000, roundingMode: 'CEIL_RUPEE' };
const EPF = { employeeContributionRate: 0.12, employerContributionRate: 0.12, wageCapForContribution: 15000, epsRate: 0.0833, epsWageCeiling: 15000, voluntaryContributionAllowed: true, roundingMode: 'NEAREST_RUPEE' };

const base = (inputs = {}, results = {}, extra = {}) => {
  const payrollInputs = {
    grossMonthly: 20000, basicSalary: 12000, pfWageOverride: null, pfEnrolled: true, esiEnrolled: true, ptEnrolled: true,
    workState: 'MH', payrollDate: new Date('2026-03-31T00:00:00.000Z'), attendanceAdjustment: 'DEFERRED', ...inputs,
  };
  return {
    _id: id(9), payrollRunId: id(2), companyId: id(1), stagingResultId: id(3), snapshotStatus: 'FINALIZED',
    periodMonth: 3, periodYear: 2026, periodStart: new Date('2026-03-01T00:00:00.000Z'), periodEnd: new Date('2026-03-31T00:00:00.000Z'),
    processingVersion: 1,
    employeeSnapshot: { employeeId: id(4), fullName: 'Asha Verma', email: 'asha.verma@example.com', department: 'Engineering', position: 'Engineer', employmentStatus: 'active', hireDate: new Date('2024-01-15T00:00:00.000Z') },
    salarySnapshot: {
      salaryStructureId: id(5), effectiveFrom: new Date('2026-01-01T00:00:00.000Z'), effectiveTo: null,
      components: { basic: 12000, hra: 4800, conveyanceAllowance: 0, medicalAllowance: 0, specialAllowance: 3200, otherAllowances: 0 },
      grossMonthly: payrollInputs.grossMonthly, currency: 'INR', payFrequency: 'monthly', workState: 'MH', pfEnrolled: true, esiEnrolled: true, ptEnrolled: true, pfWageOverride: null,
    },
    complianceProvenance: [
      { ruleType: 'EPF', ruleId: id(6), jurisdiction: 'IN', effectiveFrom: new Date('2014-09-01T00:00:00.000Z'), effectiveTo: null, sourceReference: 'EPF', parameters: EPF },
      { ruleType: 'ESI', ruleId: id(7), jurisdiction: 'IN', effectiveFrom: new Date('2019-07-01T00:00:00.000Z'), effectiveTo: null, sourceReference: 'ESI', parameters: ESI },
      { ruleType: 'PT', ruleId: id(8), jurisdiction: 'MH', effectiveFrom: new Date('2000-01-01T00:00:00.000Z'), effectiveTo: null, sourceReference: 'MH PT', parameters: { slabs: SLABS } },
    ],
    payrollInputs,
    payrollResults: {
      epf: { enrolled: true, pfWageUsed: 12000, employeeEpf: 1440, employerEpf: 1440, epsContribution: 1000, totalEpf: 2880 },
      esi: { enrolled: true, applicable: true, employeeEsi: 150, employerEsi: 650, totalEsi: 800 },
      pt: { enrolled: true, applicable: true, pt: 200 },
      totalEmployeeDeductions: 1790, employerTotalContribution: 2090, netPayBeforeTDS: 18210, tdsStatus: 'DEFERRED', tdsAmount: null, ...results,
    },
    ...extra,
  };
};

const wave3Lines = [
  { componentCode: 'BASIC', name: 'Basic', type: 'EARNING', recurrence: 'RECURRING', amountMonthly: 12000, amountEarned: 12000 },
  { componentCode: 'HRA', name: 'House rent allowance', type: 'EARNING', recurrence: 'RECURRING', amountMonthly: 4800, amountEarned: 4800 },
  { componentCode: 'SPECIAL', name: 'Special allowance', type: 'EARNING', recurrence: 'RECURRING', amountMonthly: 3200, amountEarned: 3200 },
];
const compensation = (lines) => ({ compensationSnapshot: { compensationVersionId: id(10), version: 1, effectiveFrom: new Date('2026-01-01T00:00:00.000Z'), payBasis: 'MONTHLY', lines } });
const payBasis = { fullMonthlyGross: 20000, payableDays: 31, paidDays: 31, prorationFactor: 1, payableDaysBasis: 'CALENDAR_DAYS', professionalTaxBasis: 'EARNED_GROSS' };
const bases = { esiContributionWage: 20000, ptSlabWage: 20000, basisSource: 'COMPENSATION_LINES', lineRoundingResidual: 0, inclusionSource: { esiContribution: 'LEGACY_TREATMENT_FLAGS', ptSlab: 'LEGACY_TREATMENT_FLAGS' } };

export const shapes = () => ({
  preWave3: base(),
  wave3: base({}, {}, compensation(wave3Lines)),
  wave35: base(payBasis, {}, compensation(wave3Lines)),
  phase1c: base({ ...payBasis, statutoryBases: bases }, {}, compensation(wave3Lines)),
  phase1cDiffering: base({ ...payBasis, grossMonthly: 10400, fullMonthlyGross: 10400, basicSalary: 4000, statutoryBases: { ...bases, esiContributionWage: 7900, ptSlabWage: 8900 } },
    { epf: { enrolled: true, pfWageUsed: 4000, employeeEpf: 480, employerEpf: 480, epsContribution: 333, totalEpf: 960 }, esi: { enrolled: true, applicable: true, employeeEsi: 60, employerEsi: 257, totalEsi: 317 }, pt: { enrolled: true, applicable: true, pt: 175 }, totalEmployeeDeductions: 715, employerTotalContribution: 737, netPayBeforeTDS: 9685 },
    compensation(wave3Lines)),
  // The same record with the optional key present but undefined: the repository hashes that differently
  // from an absent key, and this scaffold must never write `undefined` as a stand-in for absence.
  preWave3WithUndefinedStatutoryBases: base({ statutoryBases: undefined }),
});
