import { verifySnapshotHash } from '../models/PayrollSnapshot.js';
import { roundToPaise as round2, formatRupees as inr, formatRatePercent as percent } from '../utils/money.js';

/**
 * payslipService — explainable payslips built only from a PayrollSnapshot.
 *
 * Every deduction line carries:
 *   - the amount
 *   - the formula that produced it, with the actual numbers substituted
 *   - the exact rule version it came from (type, id, jurisdiction, dates)
 *
 * Nothing is recalculated from current data: the explanation reads the
 * snapshot's frozen inputs, results and rule parameters. Snapshots created
 * before rule parameters were frozen still get an explanation; rates are then
 * derived from the stored amounts and flagged as derived.
 *
 * The payslip also re-checks its own arithmetic and verifies the snapshot
 * hash, so the reader can see the record is internally consistent and has not
 * been altered since it was written.
 */

const nearlyEqual = (a, b) => Math.abs(round2(a) - round2(b)) < 0.011;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const COMPONENT_LABELS = {
  basic: 'Basic',
  hra: 'House rent allowance',
  conveyanceAllowance: 'Conveyance allowance',
  medicalAllowance: 'Medical allowance',
  specialAllowance: 'Special allowance',
  otherAllowances: 'Other allowances',
};

const ROUNDING_NOTES = {
  NEAREST_RUPEE: ' (rounded to the nearest rupee)',
  CEIL_RUPEE: ' (rounded up to the next rupee)',
};

const provenanceFor = (snapshot, ruleType) =>
  (snapshot.complianceProvenance || []).find((p) => p.ruleType === ruleType) || null;

const ruleSource = (provenance) => (provenance
  ? {
      ruleType: provenance.ruleType,
      ruleId: String(provenance.ruleId),
      jurisdiction: provenance.jurisdiction,
      effectiveFrom: provenance.effectiveFrom,
      effectiveTo: provenance.effectiveTo || null,
      reference: provenance.sourceReference || null,
    }
  : null);

function explainEpf(snapshot, notes) {
  const epf = snapshot.payrollResults.epf || {};
  if (!epf.enrolled) {
    notes.push('Not enrolled for provident fund in this period.');
    return { deductions: [], employer: [] };
  }

  const inputs = snapshot.payrollInputs;
  const provenance = provenanceFor(snapshot, 'EPF');
  const params = provenance?.parameters || null;
  const source = ruleSource(provenance);
  const pfWage = inputs.pfWageOverride != null ? inputs.pfWageOverride : inputs.basicSalary;
  const prorated = inputs.prorationFactor != null && inputs.prorationFactor !== 1;
  const wageLabel = inputs.pfWageOverride != null
    ? 'PF wage override'
    : (prorated ? 'PF wage for the paid days' : 'basic');
  const rounding = ROUNDING_NOTES[params?.roundingMode] || '';

  const employeeRate = params?.employeeContributionRate
    ?? (epf.pfWageUsed ? epf.employeeEpf / epf.pfWageUsed : null);
  const employerRate = params?.employerContributionRate
    ?? (epf.pfWageUsed ? epf.employerEpf / epf.pfWageUsed : null);
  const wageText = params?.wageCapForContribution != null
    ? `min(${wageLabel} ${inr(pfWage)}, ceiling ${inr(params.wageCapForContribution)}) = ${inr(epf.pfWageUsed)}`
    : `PF wage ${inr(epf.pfWageUsed)}`;
  const rateText = (rate) => (rate != null ? percent(rate) : 'the statutory rate');

  return {
    deductions: [{
      code: 'EPF_EMPLOYEE',
      label: 'Provident fund (employee)',
      amount: epf.employeeEpf,
      formula: `${wageText} × ${rateText(employeeRate)} = ${inr(epf.employeeEpf)}${rounding}`,
      source,
      rateDerivedFromAmounts: !params,
    }],
    employer: [
      {
        code: 'EPF_EMPLOYER',
        label: 'Provident fund (employer)',
        amount: epf.employerEpf,
        formula: `${inr(epf.pfWageUsed)} × ${rateText(employerRate)} = ${inr(epf.employerEpf)}${rounding}`,
        source,
        rateDerivedFromAmounts: !params,
      },
      {
        code: 'EPS',
        label: 'of which pension scheme (EPS)',
        amount: epf.epsContribution,
        formula: params?.epsRate != null
          ? `${percent(params.epsRate)} of the PF wage (within the employer share) = ${inr(epf.epsContribution)}`
          : `Pension portion of the employer share = ${inr(epf.epsContribution)}`,
        source,
        includedInEmployerTotal: true,
      },
    ],
  };
}

/**
 * ESI and PT explanations: what PayGuard recorded and calculated.
 *
 * Vocabulary (one meaning each, no substitution):
 *   calculationModel   the family of calculation that produced the stored amount. Every payslip
 *                      built from a stored snapshot is PAYGUARD_LEGACY_CONFIGURED_RULE: rates, the
 *                      ceiling and the rounding setting come from the frozen company rule version.
 *                      It is not a determination under the Code on Social Security, 2020.
 *   basisAmount        the amount the stored contribution is documented as calculated on, or null
 *                      when the snapshot did not record it.
 *   basisSource        where basisAmount comes from: RECORDED_ON_SNAPSHOT, RECORDED_PT_BASIS_SETTING
 *                      or NOT_RECORDED. (Not the stored statutoryBases.basisSource, which says how
 *                      the bases were derived; that is exposed as basisDerivation.)
 *
 * Nothing here is inferred from the absence of a field. A basis that the snapshot did not record is
 * reported as not recorded. Nothing is recomputed from live compensation, the catalogue or rules.
 */
const CALCULATION_MODEL = 'PAYGUARD_LEGACY_CONFIGURED_RULE';

const LEGACY_ROUNDING = {
  NEAREST_RUPEE: ' (PayGuard rounding setting: to paise, then to the nearest rupee)',
  CEIL_RUPEE: ' (PayGuard rounding setting: to paise, then up to the next whole rupee)',
};

const roundingModelFor = (params) => ({
  mode: params?.roundingMode || null,
  description: 'PayGuard\'s configured rounding step for this rule version. It is not a statement of the rounding the Code or Rules require.',
});

const ESI_NOT_A_DETERMINATION = 'it is not a determination of statutory coverage under the Code on Social Security, 2020.';

/**
 * The basis an ESI contribution was recorded as calculated on.
 *
 * statutoryBases.esiContributionWage is written by Phase 1C and later. A snapshot without it did not
 * record its basis, and that is all that can be said: it is never assumed to have been the gross.
 */
function esiBasisFor(snapshot) {
  const inputs = snapshot.payrollInputs;
  const bases = inputs.statutoryBases || null;
  const gross = inputs.grossMonthly;
  if (bases && typeof bases.esiContributionWage === 'number') {
    return {
      amount: bases.esiContributionWage,
      gross,
      source: 'RECORDED_ON_SNAPSHOT',
      derivation: bases.basisSource || null,
      flagsApplied: bases.inclusionSource?.esiContribution === 'LEGACY_TREATMENT_FLAGS',
    };
  }
  return { amount: null, gross, source: 'NOT_RECORDED', derivation: null, flagsApplied: false };
}

/**
 * The wage PayGuard compared with the configured ESI ceiling.
 *
 * Phase 1C and later compared the full-month gross (recorded as fullMonthlyGross) and mark their
 * snapshots with statutoryBases. For any other snapshot the compared wage was not recorded.
 */
function esiCoverageCheckFor(snapshot, ceiling) {
  const inputs = snapshot.payrollInputs;
  const marked = !!inputs.statutoryBases;
  const recordedFull = marked && inputs.fullMonthlyGross != null ? inputs.fullMonthlyGross : null;
  const esi = snapshot.payrollResults.esi || {};
  return {
    model: 'PAYGUARD_LEGACY_GROSS_VS_CONFIGURED_CEILING',
    comparedAmount: recordedFull != null ? round2(recordedFull) : null,
    comparedAmountSource: recordedFull != null ? 'RECORDED_FULL_MONTHLY_GROSS' : 'NOT_RECORDED',
    configuredCeiling: ceiling,
    legacyOutcome: esi.applicable ? 'CONTRIBUTION_CALCULATED' : 'NO_CONTRIBUTION_CALCULATED',
  };
}

/** "Legacy calculation basis ₹X (...)", naming only what the snapshot recorded. */
function esiBasisSubject(basis) {
  const { amount, gross, flagsApplied } = basis;
  if (round2(amount) === round2(gross)) return `Legacy calculation basis ${inr(amount)} (recorded; equal to gross for this period)`;
  const outside = round2(gross - amount);
  if (outside > 0) {
    return `Legacy calculation basis ${inr(amount)} (gross for this period ${inr(gross)} less ${inr(outside)} not included in this basis` +
      `${flagsApplied ? ' by the company\'s compensation settings' : ''})`;
  }
  return `Legacy calculation basis ${inr(amount)} (the included lines, each rounded; gross for this period ${inr(gross)})`;
}

function explainEsi(snapshot, notes) {
  const esi = snapshot.payrollResults.esi || {};
  const basis = esiBasisFor(snapshot);
  const gross = basis.gross;
  if (!esi.enrolled) {
    notes.push('Not enrolled for ESI in this period.');
    return { deductions: [], employer: [] };
  }

  const provenance = provenanceFor(snapshot, 'ESI');
  const params = provenance?.parameters || null;
  const source = ruleSource(provenance);
  const ceiling = params?.grossWageCeiling != null ? params.grossWageCeiling : null;
  const coverageCheck = esiCoverageCheckFor(snapshot, ceiling);

  if (!esi.applicable) {
    const ceilingText = ceiling != null ? `the ESI ceiling of ${inr(ceiling)} configured in this company's rule` : 'the ESI ceiling configured in this company\'s rule';
    notes.push(
      coverageCheck.comparedAmount != null
        ? `PayGuard's legacy check compared full-month gross ${inr(coverageCheck.comparedAmount)} with ${ceilingText} and calculated no ESI contribution. This is PayGuard's legacy gross-based check; ${ESI_NOT_A_DETERMINATION}`
        : `PayGuard calculated no ESI contribution for this period. The wage it compared with ${ceilingText} was not recorded on this payroll record (recorded gross for this period ${inr(gross)}). This is PayGuard's legacy check; ${ESI_NOT_A_DETERMINATION}`
    );
    return { deductions: [], employer: [] };
  }

  const rounding = LEGACY_ROUNDING[params?.roundingMode] || '';
  const recorded = basis.amount != null;
  const employeeRate = params?.employeeContributionRate ?? (recorded && basis.amount ? esi.employeeEsi / basis.amount : null);
  const employerRate = params?.employerContributionRate ?? (recorded && basis.amount ? esi.employerEsi / basis.amount : null);
  const rateText = (rate) => (rate != null ? percent(rate) : 'the rate in the rule version');
  const subject = recorded ? esiBasisSubject(basis) : null;
  const formulaFor = (label, amount, rate) => (recorded
    ? `${subject} × ${rateText(rate)} = ${inr(amount)}${rounding}`
    : `${label} ${inr(amount)} as stored. The wage it was calculated on was not recorded on this payroll record ` +
      `(recorded gross for this period ${inr(gross)}; rate ${rateText(rate)}${params?.roundingMode ? `; rounding setting ${params.roundingMode}` : ''}).`);

  // Facts a reader or a client can check, alongside the text.
  const facts = {
    calculationModel: CALCULATION_MODEL,
    basisAmount: recorded ? round2(basis.amount) : null,
    basisSource: basis.source,
    basisDerivation: basis.derivation,
    recordedGrossMonthly: round2(gross),
    coverageCheck,
    roundingModel: roundingModelFor(params),
  };

  return {
    deductions: [{
      code: 'ESI_EMPLOYEE',
      label: 'Employee state insurance (employee)',
      amount: esi.employeeEsi,
      formula: formulaFor('ESI employee contribution', esi.employeeEsi, employeeRate),
      source,
      rateDerivedFromAmounts: !params,
      ...facts,
    }],
    employer: [{
      code: 'ESI_EMPLOYER',
      label: 'Employee state insurance (employer)',
      amount: esi.employerEsi,
      formula: formulaFor('ESI employer contribution', esi.employerEsi, employerRate),
      source,
      rateDerivedFromAmounts: !params,
      ...facts,
    }],
  };
}

/**
 * The basis the professional tax slab was read from.
 *
 * Recorded on the snapshot since Phase 1C (statutoryBases.ptSlabWage). Before that, a snapshot that
 * recorded the company's professionalTaxBasis setting names the basis through that recorded setting.
 * Anything else is not recorded.
 */
function ptBasisFor(snapshot) {
  const inputs = snapshot.payrollInputs;
  const gross = inputs.grossMonthly;
  const setting = inputs.professionalTaxBasis || null;
  const recorded = inputs.statutoryBases ? inputs.statutoryBases.ptSlabWage : undefined;
  if (typeof recorded === 'number') {
    return {
      amount: recorded, gross, setting, source: 'RECORDED_ON_SNAPSHOT',
      derivation: inputs.statutoryBases.basisSource || null,
      flagsApplied: inputs.statutoryBases.inclusionSource?.ptSlab === 'LEGACY_TREATMENT_FLAGS',
    };
  }
  if (setting === 'FULL_MONTHLY_GROSS' && inputs.fullMonthlyGross != null) {
    return { amount: inputs.fullMonthlyGross, gross, setting, source: 'RECORDED_PT_BASIS_SETTING', derivation: null, flagsApplied: false };
  }
  if (setting === 'EARNED_GROSS') {
    return { amount: gross, gross, setting, source: 'RECORDED_PT_BASIS_SETTING', derivation: null, flagsApplied: false };
  }
  return { amount: null, gross, setting, source: 'NOT_RECORDED', derivation: null, flagsApplied: false };
}

function ptBasisSubject(basis) {
  const { amount, gross, source, setting, flagsApplied } = basis;
  if (source === 'RECORDED_PT_BASIS_SETTING') {
    return `Legacy calculation basis ${inr(amount)} (${setting === 'FULL_MONTHLY_GROSS' ? 'full-month gross' : 'earned gross'}, per the recorded professional tax basis setting)`;
  }
  if (round2(amount) === round2(gross)) return `Legacy calculation basis ${inr(amount)} (recorded; equal to gross for this period)`;
  const outside = round2(gross - amount);
  return outside > 0
    ? `Legacy calculation basis ${inr(amount)} (gross for this period ${inr(gross)} less ${inr(outside)} not included in this basis` +
      `${flagsApplied ? ' by the company\'s compensation settings' : ''})`
    : `Legacy calculation basis ${inr(amount)} (the included lines, each rounded; gross for this period ${inr(gross)})`;
}

function explainPt(snapshot, notes) {
  const pt = snapshot.payrollResults.pt || {};
  const basis = ptBasisFor(snapshot);
  const { amount, gross } = basis;
  const recorded = amount != null;
  const state = snapshot.payrollInputs.workState;
  if (!pt.enrolled) {
    notes.push('Not enrolled for professional tax in this period.');
    return [];
  }

  const provenance = provenanceFor(snapshot, 'PT');
  const slabs = provenance?.parameters?.slabs;
  const monthName = MONTHS[snapshot.periodMonth - 1];

  let formula = `Professional tax for ${state}: ${inr(pt.pt)} as stored. The wage the state slab was read from was not recorded ` +
    `on this payroll record (recorded gross for this period ${inr(gross)}).`;
  if (recorded) {
    formula = `Professional tax for ${state}: ${inr(pt.pt)}`;
    if (Array.isArray(slabs) && slabs.length > 0) {
      const sorted = [...slabs].sort((a, b) => {
        if (a.upTo === null) return 1;
        if (b.upTo === null) return -1;
        return a.upTo - b.upTo;
      });
      const index = sorted.findIndex((slab) => slab.upTo === null || amount <= slab.upTo);
      if (index >= 0) {
        const slab = sorted[index];
        const lower = index === 0 ? null : sorted[index - 1].upTo;
        const range = slab.upTo === null
          ? `above ${inr(lower)}`
          : lower === null ? `up to ${inr(slab.upTo)}` : `${inr(lower)} – ${inr(slab.upTo)}`;
        const override = (slab.monthOverrides || []).find((entry) => entry.month === snapshot.periodMonth);
        formula = `${ptBasisSubject(basis)} falls in the ${state} slab ${range} → ${inr(pt.pt)}` +
          (override ? ` (${monthName} amount)` : '');
      }
    }
  }

  if (!pt.applicable) {
    notes.push(
      recorded
        ? `PayGuard's configured ${state} slab calculation produced ${inr(0)} on a legacy calculation basis of ${inr(amount)}. ` +
          'Professional tax is a State levy under the applicable State law; this payslip records PayGuard\'s configured slab result and is not a determination of liability.'
        : `PayGuard's configured ${state} slab calculation produced ${inr(0)}; the wage the slab was read from was not recorded on this payroll record ` +
          `(recorded gross for this period ${inr(gross)}). Professional tax is a State levy under the applicable State law; this payslip records PayGuard's configured slab result and is not a determination of liability.`
    );
    return [];
  }

  return [{
    code: 'PT',
    label: 'Professional tax',
    amount: pt.pt,
    formula,
    source: ruleSource(provenance),
    calculationModel: CALCULATION_MODEL,
    basisAmount: recorded ? round2(amount) : null,
    basisSource: basis.source,
    basisDerivation: basis.derivation,
    ptBasisSetting: basis.setting,
    recordedGrossMonthly: round2(gross),
  }];
}

const payslipService = {
  /**
   * Build a fully explained payslip from a PayrollSnapshot (document or lean).
   */
  buildPayslip(snapshotDoc) {
    const snapshot = snapshotDoc.toObject ? snapshotDoc.toObject() : snapshotDoc;
    const results = snapshot.payrollResults;
    const salary = snapshot.salarySnapshot;
    const gross = snapshot.payrollInputs.grossMonthly;
    const notes = [];

    const inputs = snapshot.payrollInputs;
    const compensation = snapshot.compensationSnapshot || null;
    const factor = inputs.prorationFactor != null ? inputs.prorationFactor : 1;
    const isProrated = factor !== 1;
    const prorationText = isProrated ? ` × ${inputs.paidDays}/${inputs.payableDays} paid days` : '';

    // Earnings come from the compensation version frozen with this payslip.
    // Payslips written before compensation existed fall back to the salary
    // components frozen in the snapshot.
    const earnings = compensation && compensation.lines && compensation.lines.length > 0
      ? compensation.lines
        .filter((line) => line.type === 'EARNING' && line.amountEarned > 0)
        .map((line) => ({
          code: line.componentCode,
          label: line.name,
          amount: line.amountEarned,
          formula: isProrated
            ? `${inr(line.amountMonthly)}${prorationText} = ${inr(line.amountEarned)}`
            : (line.explanation || null),
        }))
      : Object.entries(COMPONENT_LABELS)
        .map(([key, label]) => ({
          code: key.toUpperCase(),
          label,
          amount: round2((salary.components?.[key] || 0) * factor),
        }))
        .filter((line) => line.amount > 0);

    const epf = explainEpf(snapshot, notes);
    const esi = explainEsi(snapshot, notes);
    const ptLines = explainPt(snapshot, notes);

    // Voluntary deductions and other employer contributions come from the
    // employee's compensation, not from a statutory rule.
    const voluntaryLines = (results.voluntaryDeductions || []).map((line) => ({
      code: line.componentCode,
      label: line.name,
      amount: line.amount,
      formula: line.explanation
        ? `${line.explanation}${prorationText}`
        : `Agreed deduction of ${inr(line.amount)}`,
      source: null,
      fromCompensation: true,
    }));
    const employerOtherLines = (results.employerOtherContributions || []).map((line) => ({
      code: line.componentCode,
      label: line.name,
      amount: line.amount,
      formula: line.explanation
        ? `${line.explanation}${prorationText}`
        : `Employer contribution of ${inr(line.amount)}`,
      source: null,
      fromCompensation: true,
    }));

    const deductions = [...epf.deductions, ...esi.deductions, ...ptLines, ...voluntaryLines];
    const employerContributions = [...epf.employer, ...esi.employer, ...employerOtherLines];

    const earningsTotal = round2(earnings.reduce((sum, line) => sum + line.amount, 0));
    const deductionsTotal = round2(deductions.reduce((sum, line) => sum + line.amount, 0));

    const limitations = [];
    if (results.tdsStatus !== 'CALCULATED') {
      limitations.push('Income tax (TDS) has not been deducted. Net pay shown is before TDS.');
    }
    if (isProrated) {
      limitations.push(
        `Pay is prorated: ${inputs.paidDays} of ${inputs.payableDays} payable days, ` +
        'because employment started or ended inside this period.'
      );
    }
    if (snapshot.payrollInputs.attendanceAdjustment !== 'APPLIED') {
      limitations.push('Attendance and loss of pay are not applied; every employed day in the period is paid.');
    }

    const integrity = verifySnapshotHash(snapshot);

    return {
      id: String(snapshot._id),
      payrollRunId: String(snapshot.payrollRunId),
      status: snapshot.snapshotStatus,
      period: {
        month: snapshot.periodMonth,
        year: snapshot.periodYear,
        label: `${MONTHS[snapshot.periodMonth - 1]} ${snapshot.periodYear}`,
        start: snapshot.periodStart,
        end: snapshot.periodEnd,
      },
      employee: {
        id: String(snapshot.employeeSnapshot.employeeId),
        name: snapshot.employeeSnapshot.fullName,
        email: snapshot.employeeSnapshot.email,
        department: snapshot.employeeSnapshot.department,
        position: snapshot.employeeSnapshot.position,
        workState: snapshot.payrollInputs.workState,
      },
      currency: salary.currency || 'INR',
      payPeriodDays: inputs.payableDays != null
        ? {
          payableDays: inputs.payableDays,
          paidDays: inputs.paidDays,
          basis: inputs.payableDaysBasis,
          prorated: isProrated,
        }
        : null,
      fullMonthlyGross: inputs.fullMonthlyGross != null ? inputs.fullMonthlyGross : null,
      earnings,
      deductions,
      employerContributions,
      totals: {
        gross,
        totalDeductions: results.totalEmployeeDeductions,
        netPayBeforeTDS: results.netPayBeforeTDS,
        netPayFormula: `${inr(gross)} − ${inr(results.totalEmployeeDeductions)} = ${inr(results.netPayBeforeTDS)}`,
        voluntaryDeductions: results.voluntaryDeductionsTotal || 0,
        employerContributions: round2(
          (results.employerTotalContribution || 0) + (results.employerOtherContributionTotal || 0)
        ),
        statutoryEmployerContributions: results.employerTotalContribution || 0,
        costToCompany: round2(
          gross + (results.employerTotalContribution || 0) + (results.employerOtherContributionTotal || 0)
        ),
      },
      checks: {
        earningsMatchGross: nearlyEqual(earningsTotal, gross),
        deductionsMatchTotal: nearlyEqual(deductionsTotal, results.totalEmployeeDeductions),
        netPayMatchesFormula: nearlyEqual(gross - results.totalEmployeeDeductions, results.netPayBeforeTDS),
      },
      integrity: {
        verified: integrity.valid,
        snapshotHash: integrity.storedHash,
      },
      notes,
      limitations,
      finalizedAt: snapshot.finalizedAt || null,
    };
  },
};

export default payslipService;
