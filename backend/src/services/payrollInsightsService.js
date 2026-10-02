import PayrollRun, { PAYROLL_STATUS } from '../models/PayrollRun.js';
import PayrollStagingResult from '../models/PayrollStagingResult.js';
import PayrollSnapshot from '../models/PayrollSnapshot.js';
import config from '../config/environment.js';

/**
 * payrollInsightsService — pre-finalization controls on a payroll run.
 *
 * Payroll register: company-level totals (gross, deductions by statute,
 * employer contributions, net, cost to company) and a department breakdown.
 *
 * Variance report — explains pay changes instead of just flagging them.
 * Every employee is compared with the most recent earlier finalized run. A pay
 * change is decomposed into components (gross, EPF, ESI, professional tax) and
 * each component delta is matched against the causes the frozen payroll data
 * can prove:
 *
 *   SALARY_REVISION           a different salary version was in effect
 *   EPF/ESI/PT_RULE_CHANGE    a different rule version or rule parameters
 *   PT_MONTH_SPECIFIC_AMOUNT  a month-specific professional tax amount applies
 *   *_ENROLMENT_CHANGE        statutory enrolment switched on or off
 *   WORK_STATE_CHANGE         the professional tax jurisdiction changed
 *
 * Classification:
 *   EXPECTED     every changed component has a proven cause        → info
 *   UNEXPLAINED  some change has no cause in the payroll inputs    → high,
 *                or critical when material; blocks finalization (company setting)
 *   INVALID      result cannot be paid (net pay ≤ 0)               → critical, never overridable
 *   REVIEW       needs a human look but proves nothing wrong       → warning / info
 *
 * Reads only frozen payroll data: staging results for a run that is
 * READY_FOR_FINALIZATION, finalized snapshots otherwise.
 */

const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const SEVERITY_ORDER = { critical: 0, high: 1, warning: 2, info: 3 };

const CAUSE_LABELS = {
  SALARY_REVISION: 'salary revision',
  EPF_RULE_CHANGE: 'EPF rule change',
  ESI_RULE_CHANGE: 'ESI rule change',
  PT_RULE_CHANGE: 'professional tax rule change',
  PT_MONTH_SPECIFIC_AMOUNT: 'month-specific professional tax amount',
  PF_ENROLMENT_CHANGE: 'PF enrolment change',
  ESI_ENROLMENT_CHANGE: 'ESI enrolment change',
  PT_ENROLMENT_CHANGE: 'professional tax enrolment change',
  WORK_STATE_CHANGE: 'work state change',
  COMPENSATION_CHANGE: 'compensation change',
  PRORATION_CHANGE: 'part-period pay (joining or exit)',
};

const COMPONENT_LABELS = {
  gross: 'gross',
  epfEmployee: 'PF',
  esiEmployee: 'ESI',
  professionalTax: 'professional tax',
  voluntaryDeductions: 'voluntary deductions',
};

const notFound = () => Object.assign(new Error('Payroll run not found.'), { statusCode: 404 });

const percentChange = (before, after) => (before ? round2(((after - before) / before) * 100) : null);

const inr = (n) => {
  const value = round2(n);
  const amount = Math.abs(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${value < 0 ? '−' : ''}₹${amount}`;
};

const rulesByType = (provenance = []) =>
  Object.fromEntries(provenance.map((p) => [p.ruleType, { ruleId: String(p.ruleId), parameters: p.parameters }]));

const lineFromStaging = (s) => ({
  employeeId: String(s.employeeId),
  name: s.employeeSnapshot.fullName,
  department: s.employeeSnapshot.department || 'Unassigned',
  hireDate: s.employeeSnapshot.hireDate || null,
  periodMonth: s.periodMonth,
  salaryStructureId: String(s.salarySnapshot.salaryStructureId),
  salaryEffectiveFrom: s.salarySnapshot.effectiveFrom,
  workState: s.payrollInputs.workState,
  pfEnrolled: Boolean(s.payrollInputs.pfEnrolled),
  esiEnrolled: Boolean(s.payrollInputs.esiEnrolled),
  ptEnrolled: Boolean(s.payrollInputs.ptEnrolled),
  rules: rulesByType(s.ruleProvenance),
  gross: s.payrollInputs.grossMonthly,
  epfEmployee: s.epf?.employeeEpf || 0,
  epfEmployer: s.epf?.employerEpf || 0,
  eps: s.epf?.epsContribution || 0,
  esiEmployee: s.esi?.employeeEsi || 0,
  esiEmployer: s.esi?.employerEsi || 0,
  pt: s.pt?.pt || 0,
  deductions: s.totalEmployeeDeductions,
  net: s.netPayBeforeTDS,
  voluntaryDeductions: s.voluntaryDeductionsTotal || 0,
  employerOther: s.employerOtherContributionTotal || 0,
  payableDays: s.payrollInputs.payableDays != null ? s.payrollInputs.payableDays : null,
  paidDays: s.payrollInputs.paidDays != null ? s.payrollInputs.paidDays : null,
  prorationFactor: s.payrollInputs.prorationFactor != null ? s.payrollInputs.prorationFactor : null,
  compensationVersionId: s.compensationSnapshot ? String(s.compensationSnapshot.compensationVersionId) : null,
});

const lineFromSnapshot = (s) => ({
  employeeId: String(s.employeeSnapshot.employeeId),
  name: s.employeeSnapshot.fullName,
  department: s.employeeSnapshot.department || 'Unassigned',
  hireDate: s.employeeSnapshot.hireDate || null,
  periodMonth: s.periodMonth,
  salaryStructureId: String(s.salarySnapshot.salaryStructureId),
  salaryEffectiveFrom: s.salarySnapshot.effectiveFrom,
  workState: s.payrollInputs.workState,
  pfEnrolled: Boolean(s.payrollInputs.pfEnrolled),
  esiEnrolled: Boolean(s.payrollInputs.esiEnrolled),
  ptEnrolled: Boolean(s.payrollInputs.ptEnrolled),
  rules: rulesByType(s.complianceProvenance),
  gross: s.payrollInputs.grossMonthly,
  epfEmployee: s.payrollResults.epf?.employeeEpf || 0,
  epfEmployer: s.payrollResults.epf?.employerEpf || 0,
  eps: s.payrollResults.epf?.epsContribution || 0,
  esiEmployee: s.payrollResults.esi?.employeeEsi || 0,
  esiEmployer: s.payrollResults.esi?.employerEsi || 0,
  pt: s.payrollResults.pt?.pt || 0,
  deductions: s.payrollResults.totalEmployeeDeductions,
  net: s.payrollResults.netPayBeforeTDS,
  voluntaryDeductions: s.payrollResults.voluntaryDeductionsTotal || 0,
  employerOther: s.payrollResults.employerOtherContributionTotal || 0,
  payableDays: s.payrollInputs.payableDays != null ? s.payrollInputs.payableDays : null,
  paidDays: s.payrollInputs.paidDays != null ? s.payrollInputs.paidDays : null,
  prorationFactor: s.payrollInputs.prorationFactor != null ? s.payrollInputs.prorationFactor : null,
  compensationVersionId: s.compensationSnapshot ? String(s.compensationSnapshot.compensationVersionId) : null,
});

async function loadOwnedRun(runId, companyId) {
  const run = await PayrollRun.findById(runId).lean();
  if (!run || String(run.companyId) !== String(companyId)) throw notFound();
  return run;
}

async function loadLines(run) {
  if ([PAYROLL_STATUS.FINALIZED, PAYROLL_STATUS.DISBURSED].includes(run.status)) {
    const snapshots = await PayrollSnapshot.find({ payrollRunId: run._id, snapshotStatus: 'FINALIZED' }).lean();
    return snapshots.map(lineFromSnapshot);
  }
  if (run.status === PAYROLL_STATUS.READY_FOR_FINALIZATION) {
    const staging = await PayrollStagingResult.find({ runId: run._id, processingVersion: run.processingVersion }).lean();
    return staging.map(lineFromStaging);
  }
  return null;
}

function summarize(lines) {
  const sum = (key) => round2(lines.reduce((total, line) => total + (line[key] || 0), 0));
  const statutoryEmployerContributions = round2(sum('epfEmployer') + sum('esiEmployer'));
  const employerOtherContributions = sum('employerOther');
  const employerContributions = round2(statutoryEmployerContributions + employerOtherContributions);
  return {
    headcount: lines.length,
    gross: sum('gross'),
    employeeDeductions: sum('deductions'),
    voluntaryDeductions: sum('voluntaryDeductions'),
    netPayBeforeTDS: sum('net'),
    employerContributions,
    statutoryEmployerContributions,
    employerOtherContributions,
    costToCompany: round2(sum('gross') + employerContributions),
    statutory: {
      epfEmployee: sum('epfEmployee'),
      epfEmployer: sum('epfEmployer'),
      epsWithinEmployer: sum('eps'),
      esiEmployee: sum('esiEmployee'),
      esiEmployer: sum('esiEmployer'),
      professionalTax: sum('pt'),
    },
  };
}

/** Same rule version with the same frozen parameters (parameters absent on legacy records are ignored). */
function sameRule(before, after) {
  if (!before && !after) return true;
  if (!before || !after || before.ruleId !== after.ruleId) return false;
  if (before.parameters === undefined || after.parameters === undefined) return true;
  return JSON.stringify(before.parameters) === JSON.stringify(after.parameters);
}

/** True when a month-specific PT amount applies to this line's slab and month. */
function ptMonthSpecificAmountApplies(line) {
  const slabs = line.rules.PT?.parameters?.slabs;
  if (!Array.isArray(slabs) || !line.periodMonth) return false;
  const sorted = [...slabs].sort((a, b) => {
    if (a.upTo === null) return 1;
    if (b.upTo === null) return -1;
    return a.upTo - b.upTo;
  });
  const slab = sorted.find((candidate) => candidate.upTo === null || line.gross <= candidate.upTo);
  return Boolean(slab?.monthOverrides?.some((entry) => entry.month === line.periodMonth));
}

/**
 * Decompose the change between two periods for one employee.
 * @returns {{ components: Array, unexplained: Array, causes: string[] }}
 */
function explainChange(before, after) {
  const salaryRevised = before.salaryStructureId !== after.salaryStructureId;
  // A different compensation version, or a different number of paid days,
  // proves why pay moved just as a salary revision does.
  // Two known versions that differ explain a pay change. A breakdown that is
  // merely missing on one side explains nothing, so it must not excuse one.
  const compensationChanged = Boolean(before.compensationVersionId) && Boolean(after.compensationVersionId)
    && before.compensationVersionId !== after.compensationVersionId;
  // A month being 30 or 31 days long is not a change in anyone's pay: compare
  // the share of the period that was paid, not the raw day counts.
  const beforeFactor = before.prorationFactor != null ? before.prorationFactor : 1;
  const afterFactor = after.prorationFactor != null ? after.prorationFactor : 1;
  const prorationChanged = beforeFactor !== afterFactor;
  const payCauses = [
    salaryRevised && 'SALARY_REVISION',
    compensationChanged && 'COMPENSATION_CHANGE',
    prorationChanged && 'PRORATION_CHANGE',
  ];
  const components = [];

  const record = (component, from, to, candidateCauses) => {
    const delta = round2(to - from);
    if (delta === 0) return;
    const explainedBy = candidateCauses.filter(Boolean);
    components.push({ component, before: from, after: to, delta, explainedBy, explained: explainedBy.length > 0 });
  };

  record('gross', before.gross, after.gross, payCauses);
  record('voluntaryDeductions', before.voluntaryDeductions || 0, after.voluntaryDeductions || 0, payCauses);
  record('epfEmployee', before.epfEmployee, after.epfEmployee, [
    ...payCauses,
    before.pfEnrolled !== after.pfEnrolled && 'PF_ENROLMENT_CHANGE',
    !sameRule(before.rules.EPF, after.rules.EPF) && 'EPF_RULE_CHANGE',
  ]);
  record('esiEmployee', before.esiEmployee, after.esiEmployee, [
    ...payCauses,
    before.esiEnrolled !== after.esiEnrolled && 'ESI_ENROLMENT_CHANGE',
    !sameRule(before.rules.ESI, after.rules.ESI) && 'ESI_RULE_CHANGE',
  ]);
  record('professionalTax', before.pt, after.pt, [
    ...payCauses,
    before.workState !== after.workState && 'WORK_STATE_CHANGE',
    before.ptEnrolled !== after.ptEnrolled && 'PT_ENROLMENT_CHANGE',
    !sameRule(before.rules.PT, after.rules.PT) && 'PT_RULE_CHANGE',
    (ptMonthSpecificAmountApplies(before) || ptMonthSpecificAmountApplies(after)) && 'PT_MONTH_SPECIFIC_AMOUNT',
  ]);

  // Net must equal gross minus these deductions; anything left over is unexplained by definition.
  const componentNetEffect = components.reduce(
    (total, c) => total + (c.component === 'gross' ? c.delta : -c.delta),
    0
  );
  const residual = round2(round2(after.net - before.net) - componentNetEffect);
  if (residual !== 0) {
    components.push({ component: 'unreconciled', before: before.net, after: after.net, delta: residual, explainedBy: [], explained: false });
  }

  const unexplained = components.filter((c) => !c.explained);
  const causes = [...new Set(components.flatMap((c) => c.explainedBy))];
  return { components, unexplained, causes };
}

const notReady = (run) => Object.assign(
  new Error(`Insights are available once the run has been processed. Current status: ${run.status}.`),
  { statusCode: 409 }
);

const payrollInsightsService = {
  async getRegister(runId, companyId) {
    const run = await loadOwnedRun(runId, companyId);
    const lines = await loadLines(run);
    if (!lines) throw notReady(run);

    const departments = new Map();
    for (const line of lines) {
      if (!departments.has(line.department)) departments.set(line.department, []);
      departments.get(line.department).push(line);
    }

    const publicLine = ({ rules, salaryStructureId, salaryEffectiveFrom, hireDate, periodMonth, ...line }) => line;

    return {
      runId: String(run._id),
      periodMonth: run.periodMonth,
      periodYear: run.periodYear,
      status: run.status,
      source: run.status === PAYROLL_STATUS.READY_FOR_FINALIZATION ? 'STAGING' : 'FINALIZED_SNAPSHOTS',
      totals: summarize(lines),
      byDepartment: [...departments.entries()]
        .map(([department, departmentLines]) => ({ department, ...summarize(departmentLines) }))
        .sort((a, b) => b.gross - a.gross),
      employees: lines.map(publicLine).sort((a, b) => a.name.localeCompare(b.name)),
    };
  },

  async getVarianceReport(runId, companyId, { thresholdPercent = config.varianceThresholdPercent } = {}) {
    const run = await loadOwnedRun(runId, companyId);
    const current = await loadLines(run);
    if (!current) throw notReady(run);

    const baselineRun = await PayrollRun.findOne({
      companyId: run.companyId,
      status: { $in: [PAYROLL_STATUS.FINALIZED, PAYROLL_STATUS.DISBURSED] },
      $or: [
        { periodYear: { $lt: run.periodYear } },
        { periodYear: run.periodYear, periodMonth: { $lt: run.periodMonth } },
      ],
    }).sort({ periodYear: -1, periodMonth: -1 }).lean();

    const previous = baselineRun ? await loadLines(baselineRun) : [];
    const previousById = new Map(previous.map((line) => [line.employeeId, line]));
    const currentIds = new Set(current.map((line) => line.employeeId));
    const flags = [];

    const flag = ({ severity, code, classification, line, message, blocking = false, overridable = true, ...details }) =>
      flags.push({
        severity,
        code,
        classification,
        blocking,
        overridable,
        employeeId: line.employeeId,
        employeeName: line.name,
        message,
        ...details,
      });

    for (const line of current) {
      // Results that can never be paid, whatever the history.
      if (line.net <= 0) {
        flag({
          severity: 'critical', code: 'NON_POSITIVE_NET_PAY', classification: 'INVALID', line,
          message: `Net pay is ${inr(line.net)}; this result cannot be paid.`,
          blocking: true, overridable: false, net: line.net,
        });
        continue;
      }
      if (line.gross > 0 && line.deductions / line.gross > 0.5) {
        flag({
          severity: 'warning', code: 'DEDUCTIONS_ABOVE_HALF_OF_GROSS', classification: 'REVIEW', line,
          message: `Deductions are ${round2((line.deductions / line.gross) * 100)}% of gross.`,
          gross: line.gross, deductions: line.deductions,
        });
      }

      if (!baselineRun) continue;
      const before = previousById.get(line.employeeId);

      if (!before) {
        const joinedAfterBaseline = line.hireDate && new Date(line.hireDate) > new Date(baselineRun.periodEnd);
        flag({
          severity: joinedAfterBaseline ? 'info' : 'warning',
          code: 'NEW_IN_PAYROLL',
          classification: joinedAfterBaseline ? 'EXPECTED' : 'REVIEW',
          line,
          message: joinedAfterBaseline
            ? 'Joined after the previous period.'
            : 'Employed during the previous period but not paid in it. Confirm arrears are not due.',
          gross: line.gross,
        });
        continue;
      }

      const { components, unexplained, causes } = explainChange(before, line);
      if (components.length === 0) continue;

      const netChangePercent = percentChange(before.net, line.net);
      const grossChangePercent = percentChange(before.gross, line.gross);
      const material = [netChangePercent, grossChangePercent]
        .some((value) => value !== null && Math.abs(value) >= thresholdPercent);
      const netText = `Net pay ${inr(before.net)} → ${inr(line.net)} (${netChangePercent > 0 ? '+' : ''}${netChangePercent ?? 0}%)`;

      if (unexplained.length === 0) {
        flag({
          severity: 'info', code: 'PAY_CHANGE_EXPECTED', classification: 'EXPECTED', line,
          message: `${netText}. Explained by ${causes.map((cause) => CAUSE_LABELS[cause]).join(', ')}.`,
          material, changePercent: netChangePercent, causes, components,
        });
      } else {
        const missing = unexplained
          .map((c) => `${COMPONENT_LABELS[c.component] || 'unreconciled amount'} ${c.delta > 0 ? '+' : ''}${inr(c.delta)}`)
          .join(', ');
        flag({
          severity: material ? 'critical' : 'high', code: 'PAY_CHANGE_UNEXPLAINED', classification: 'UNEXPLAINED', line,
          message: `${netText}. No salary revision, rule change, enrolment or work-state change accounts for: ${missing}.`,
          blocking: true, material, changePercent: netChangePercent, causes, components,
        });
      }
    }

    for (const before of previous) {
      if (!currentIds.has(before.employeeId)) {
        flag({
          severity: 'warning', code: 'MISSING_FROM_PAYROLL', classification: 'REVIEW', line: before,
          message: 'Paid in the previous finalized period but not in this run. Confirm an exit or a blocked record.',
          previousNet: before.net,
        });
      }
    }

    flags.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.employeeName.localeCompare(b.employeeName));

    const currentTotals = summarize(current);
    const baselineTotals = baselineRun ? summarize(previous) : null;
    const count = (predicate) => flags.filter(predicate).length;

    return {
      runId: String(run._id),
      periodMonth: run.periodMonth,
      periodYear: run.periodYear,
      thresholdPercent,
      baseline: baselineRun
        ? { runId: String(baselineRun._id), periodMonth: baselineRun.periodMonth, periodYear: baselineRun.periodYear }
        : null,
      totals: {
        current: currentTotals,
        baseline: baselineTotals,
        change: baselineTotals
          ? {
              headcount: currentTotals.headcount - baselineTotals.headcount,
              grossPercent: percentChange(baselineTotals.gross, currentTotals.gross),
              netPercent: percentChange(baselineTotals.netPayBeforeTDS, currentTotals.netPayBeforeTDS),
              costToCompanyPercent: percentChange(baselineTotals.costToCompany, currentTotals.costToCompany),
            }
          : null,
      },
      counts: {
        critical: count((f) => f.severity === 'critical'),
        high: count((f) => f.severity === 'high'),
        warning: count((f) => f.severity === 'warning'),
        info: count((f) => f.severity === 'info'),
        expected: count((f) => f.classification === 'EXPECTED'),
        unexplained: count((f) => f.classification === 'UNEXPLAINED'),
        blocking: count((f) => f.blocking),
      },
      flags,
      note: baselineRun ? null : 'No earlier finalized run exists; only single-period checks were applied.',
    };
  },
};

export default payrollInsightsService;
