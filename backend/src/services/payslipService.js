import { verifySnapshotHash } from '../models/PayrollSnapshot.js';

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

const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const inr = (n) => `₹${round2(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const percent = (rate) => `${Number((Number(rate) * 100).toFixed(4))}%`;
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

function explainEsi(snapshot, notes) {
  const esi = snapshot.payrollResults.esi || {};
  const gross = snapshot.payrollInputs.grossMonthly;
  if (!esi.enrolled) {
    notes.push('Not enrolled for ESI in this period.');
    return { deductions: [], employer: [] };
  }

  const provenance = provenanceFor(snapshot, 'ESI');
  const params = provenance?.parameters || null;
  const source = ruleSource(provenance);

  if (!esi.applicable) {
    notes.push(
      `Gross ${inr(gross)} is above the ESI wage ceiling` +
      `${params?.grossWageCeiling != null ? ` of ${inr(params.grossWageCeiling)}` : ''}; no ESI contribution applies.`
    );
    return { deductions: [], employer: [] };
  }

  const rounding = ROUNDING_NOTES[params?.roundingMode] || '';
  const employeeRate = params?.employeeContributionRate ?? (gross ? esi.employeeEsi / gross : null);
  const employerRate = params?.employerContributionRate ?? (gross ? esi.employerEsi / gross : null);
  const rateText = (rate) => (rate != null ? percent(rate) : 'the statutory rate');

  return {
    deductions: [{
      code: 'ESI_EMPLOYEE',
      label: 'Employee state insurance (employee)',
      amount: esi.employeeEsi,
      formula: `Gross ${inr(gross)} × ${rateText(employeeRate)} = ${inr(esi.employeeEsi)}${rounding}`,
      source,
      rateDerivedFromAmounts: !params,
    }],
    employer: [{
      code: 'ESI_EMPLOYER',
      label: 'Employee state insurance (employer)',
      amount: esi.employerEsi,
      formula: `Gross ${inr(gross)} × ${rateText(employerRate)} = ${inr(esi.employerEsi)}${rounding}`,
      source,
      rateDerivedFromAmounts: !params,
    }],
  };
}

function explainPt(snapshot, notes) {
  const pt = snapshot.payrollResults.pt || {};
  const gross = snapshot.payrollInputs.grossMonthly;
  const state = snapshot.payrollInputs.workState;
  if (!pt.enrolled) {
    notes.push('Not enrolled for professional tax in this period.');
    return [];
  }

  const provenance = provenanceFor(snapshot, 'PT');
  const slabs = provenance?.parameters?.slabs;
  const monthName = MONTHS[snapshot.periodMonth - 1];

  let formula = `Professional tax for ${state}: ${inr(pt.pt)}`;
  if (Array.isArray(slabs) && slabs.length > 0) {
    const sorted = [...slabs].sort((a, b) => {
      if (a.upTo === null) return 1;
      if (b.upTo === null) return -1;
      return a.upTo - b.upTo;
    });
    const index = sorted.findIndex((slab) => slab.upTo === null || gross <= slab.upTo);
    if (index >= 0) {
      const slab = sorted[index];
      const lower = index === 0 ? null : sorted[index - 1].upTo;
      const range = slab.upTo === null
        ? `above ${inr(lower)}`
        : lower === null ? `up to ${inr(slab.upTo)}` : `${inr(lower)} – ${inr(slab.upTo)}`;
      const override = (slab.monthOverrides || []).find((entry) => entry.month === snapshot.periodMonth);
      formula = `Gross ${inr(gross)} falls in the ${state} slab ${range} → ${inr(pt.pt)}` +
        (override ? ` (${monthName} amount)` : '');
    }
  }

  if (!pt.applicable) {
    notes.push(`No professional tax is due for ${state} at this gross.`);
    return [];
  }

  return [{
    code: 'PT',
    label: 'Professional tax',
    amount: pt.pt,
    formula,
    source: ruleSource(provenance),
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
