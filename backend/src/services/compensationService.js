import SalaryStructure from '../models/SalaryStructure.js';
import CompensationVersion from '../models/CompensationVersion.js';
import ComplianceRuleVersion from '../models/ComplianceRuleVersion.js';
import PayrollRun from '../models/PayrollRun.js';
import complianceCalculationService from './complianceCalculationService.js';
import compensationComponentService from './compensationComponentService.js';
import { evaluateCompensationLines } from './compensationEvaluator.js';
import { roundToPaise as round2 } from '../utils/money.js';
import auditService from './auditService.js';
import { runInTransaction } from '../utils/transaction.js';
import { httpError, startOfUtcDay, dateOnly, isValidDate, loadCompanyEmployee } from './employeeScope.js';
import { BASIC_CODE, LEGACY_COMPONENT_BUCKETS } from '../utils/compensation.js';
import { deriveStatutoryBasesFromLines, toStatutoryBasesDocument, asFullMonthLines } from '../utils/statutoryBases.js';

/**
 * compensationService — the single write path for pay.
 *
 * Every pay change, whatever route it arrives by, writes two records in ONE
 * transaction:
 *
 *   CompensationVersion   the domain record: components, semantics, lineage,
 *                         CTC, and the statutory estimate behind it
 *   SalaryStructure       the payroll engine's input, unchanged in shape, so
 *                         payroll, its snapshots and its history keep working
 *
 * Both carry the same effective-dated interval, so "what was this person paid
 * on date D" has exactly one answer on either side.
 *
 * The statutory estimate stored on a version is an ESTIMATE for display, CTC
 * and impact previews, computed from the compliance rules valid on the
 * effective date and recorded with their rule ids. Payroll never reads it: a
 * run recomputes statutory amounts and freezes its own rule provenance.
 */

const MONTHS_PER_YEAR = 12;

const provenanceOf = (rule) => ({
  ruleType: rule.ruleType,
  ruleId: rule._id,
  jurisdiction: rule.jurisdiction,
  effectiveFrom: rule.effectiveFrom,
});

/**
 * Statutory amounts for a set of wages, using the rules valid on a date.
 * Missing rules are reported, never guessed.
 */
export async function estimateStatutory({
  gross, pfWageBase, pfEnrolled, esiEnrolled, ptEnrolled, workState, onDate, periodMonth, lines = null,
}) {
  // The ESI contribution wage and the PT slab wage come from the SAME pure
  // derivation payroll uses, over frozen lines, for one whole month (a preview
  // prorates nothing). Without lines there is no basis to derive, and the
  // estimate stays on gross as it always was.
  const bases = lines
    ? deriveStatutoryBasesFromLines({
      lines: asFullMonthLines(lines), earnedGross: gross, fullMonthlyGross: gross, ptBasis: 'EARNED_GROSS',
    })
    : null;

  const [epfRule, esiRule, ptRule] = await Promise.all([
    pfEnrolled ? ComplianceRuleVersion.findValidForDate('EPF', 'IN', onDate) : null,
    esiEnrolled ? ComplianceRuleVersion.findValidForDate('ESI', 'IN', onDate) : null,
    ptEnrolled && workState ? ComplianceRuleVersion.findValidForDate('PT', String(workState).toUpperCase(), onDate) : null,
  ]);

  const unavailableRules = [];
  if (pfEnrolled && !epfRule) unavailableRules.push('EPF');
  if (esiEnrolled && !esiRule) unavailableRules.push('ESI');
  if (ptEnrolled && !ptRule) unavailableRules.push('PT');

  const result = complianceCalculationService.calculate({
    grossMonthly: gross,
    basicSalary: pfWageBase,
    pfWageOverride: null,
    pfEnrolled: Boolean(pfEnrolled && epfRule),
    esiEnrolled: Boolean(esiEnrolled && esiRule),
    ptEnrolled: Boolean(ptEnrolled && ptRule),
    epfRule: epfRule ? epfRule.epfParams : null,
    esiRule: esiRule ? esiRule.esiParams : null,
    ptSlabs: ptRule ? ptRule.ptSlabs : [],
    periodMonth,
    esiContributionWage: bases ? bases.esiContributionWage : null,
    ptGross: bases ? bases.ptSlabWage : null,
  });

  return {
    computedAt: new Date(),
    ...(bases && { statutoryBases: toStatutoryBasesDocument(bases) }),
    pfWageBase: round2(pfWageBase),
    employeePf: result.epf.employeeEpf,
    employerPf: result.epf.employerEpf,
    eps: result.epf.epsContribution,
    employeeEsi: result.esi.employeeEsi,
    employerEsi: result.esi.employerEsi,
    esiApplicable: Boolean(result.esi.applicable),
    professionalTax: result.pt.pt,
    totalEmployeeDeductions: result.totalEmployeeDeductions,
    netPayBeforeTds: result.netPay,
    employerContributions: round2(result.epf.employerEpf + result.esi.employerEsi),
    ruleProvenance: [epfRule, esiRule, ptRule].filter(Boolean).map(provenanceOf),
    unavailableRules,
  };
}

/** CTC totals: gross + employer contributions, annualised with one-time pay. */
export function ctcTotals(totals, statutoryEstimate) {
  const monthlyCtc = round2(
    totals.monthlyGross + statutoryEstimate.employerContributions + totals.monthlyEmployerContributions
  );
  return {
    ...totals,
    monthlyCtc,
    annualCtc: round2(monthlyCtc * MONTHS_PER_YEAR + totals.oneTimeAnnualEarnings),
  };
}

/** Components recorded in compensation that payroll does not pay or deduct yet. */
export const notAppliedLines = (lines = []) =>
  // Compensation versions written before Wave 3.5 froze NOT_APPLIED_YET onto
  // recurring deductions and employer contributions that payroll now does pay.
  // History is never rewritten, so the recurrence decides, not the old flag.
  lines.filter((line) => line.payrollApplication === 'NOT_APPLIED_YET'
    && line.recurrence !== 'RECURRING'
    && line.amountMonthly > 0);

/** Legacy SalaryStructure component buckets from evaluated compensation lines. */
function projectSalaryComponents(lines) {
  const components = {
    basic: 0, hra: 0, conveyanceAllowance: 0, medicalAllowance: 0, specialAllowance: 0, otherAllowances: 0,
  };
  for (const line of lines) {
    if (line.type !== 'EARNING' || line.recurrence !== 'RECURRING') continue;
    const bucket = LEGACY_COMPONENT_BUCKETS[line.componentCode] || 'otherAllowances';
    components[bucket] = round2(components[bucket] + line.amountMonthly);
  }
  return components;
}

const lineView = (line) => ({
  componentCode: line.componentCode,
  name: line.name,
  type: line.type,
  recurrence: line.recurrence,
  calculationMethod: line.calculationMethod,
  basis: line.basis,
  treatments: line.treatments,
  statutoryNature: line.statutoryNature ?? null,
  payrollApplication: line.payrollApplication,
  amountMonthly: line.amountMonthly,
  lineage: line.lineage,
});

export const versionView = (version) => (version ? {
  id: String(version._id),
  version: version.version,
  effectiveFrom: version.effectiveFrom,
  effectiveTo: version.effectiveTo,
  isCurrent: version.isCurrent,
  source: version.source,
  reason: version.reason,
  changeRequestId: version.changeRequestId ? String(version.changeRequestId) : null,
  salaryStructureId: String(version.salaryStructureId),
  workState: version.workState,
  pfEnrolled: version.pfEnrolled,
  esiEnrolled: version.esiEnrolled,
  ptEnrolled: version.ptEnrolled,
  pfWageBase: version.pfWageBase,
  esiWageBase: version.esiWageBase,
  ptWageBase: version.ptWageBase,
  lines: (version.lines || []).map(lineView),
  totals: version.totals,
  statutoryEstimate: version.statutoryEstimate,
  notApplied: notAppliedLines(version.lines).map((line) => ({ componentCode: line.componentCode, name: line.name, amountMonthly: line.amountMonthly })),
  recordedByEmail: version.recordedByEmail,
  recordedAt: version.createdAt,
} : null);

/** Finalized periods a change cannot reach any more: arrears, not edits. */
export async function retroactiveWarnings(companyId, effectiveFrom) {
  const affected = await PayrollRun.find({
    companyId,
    status: { $in: ['FINALIZED', 'DISBURSED'] },
    periodEnd: { $gte: effectiveFrom },
  }).select('periodMonth periodYear status').sort({ periodYear: 1, periodMonth: 1 }).lean();

  if (affected.length === 0) return [];
  return [{
    code: 'RETROACTIVE_REVISION',
    message:
      `This revision is effective within ${affected.length} already finalized payroll period(s). ` +
      'Finalized payslips are immutable; pay the difference as arrears in an upcoming run.',
    periods: affected.map((run) => ({
      runId: String(run._id),
      periodMonth: run.periodMonth,
      periodYear: run.periodYear,
      status: run.status,
    })),
  }];
}

/**
 * Write a new compensation version and its payroll projection.
 * Must run inside a transaction (the caller's session).
 */
export async function applyCompensation({
  employee, companyId, effectiveFrom, lines: requestedLines, workState,
  pfEnrolled = true, esiEnrolled = true, ptEnrolled = true,
  currency = 'INR', payFrequency = 'monthly', pfWageBaseOverride = null,
  reason = null, source, changeRequestId = null, actor, catalogue = null,
}, session) {
  const jurisdiction = typeof workState === 'string' ? workState.trim().toUpperCase() : '';
  if (!jurisdiction) {
    throw httpError(422, 'VALIDATION_FAILED', 'workState is required. Professional tax jurisdiction is never assumed.');
  }
  if (!isValidDate(effectiveFrom)) {
    throw httpError(422, 'VALIDATION_FAILED', 'effectiveFrom must be a valid date.');
  }
  const effectiveDate = new Date(effectiveFrom);

  const components = catalogue || await compensationComponentService.catalogueMap(companyId, session);
  const { lines, totals: rawTotals, bases } = evaluateCompensationLines(requestedLines, components);

  if (employee.hireDate && effectiveDate < startOfUtcDay(employee.hireDate)) {
    throw httpError(422, 'VALIDATION_FAILED', "Salary cannot take effect before the employee's hire date.");
  }

  // A CLOSED version that still covers the date would be rewritten by this
  // change; the open-ended current version is the one this change closes.
  const overlapping = await SalaryStructure.findOne({
    employeeId: employee._id,
    effectiveFrom: { $lte: effectiveDate },
    effectiveTo: { $gte: effectiveDate },
  }).session(session);
  if (overlapping) {
    throw httpError(409, 'SALARY_VERSION_OVERLAP', 'A salary version already covers the effective date.');
  }

  const currentSalary = await SalaryStructure.findOne({ employeeId: employee._id, effectiveTo: null })
    .sort({ effectiveFrom: -1 }).session(session);
  if (currentSalary && currentSalary.effectiveFrom >= effectiveDate) {
    throw httpError(422, 'EFFECTIVE_DATE_NOT_AFTER_CURRENT', 'New salary effective date must be after the current version.');
  }

  const pfWageBase = pfWageBaseOverride != null ? round2(pfWageBaseOverride) : bases.pfWageBase;
  const basicAmount = lines.find((line) => line.componentCode === BASIC_CODE)?.amountMonthly ?? 0;
  const statutoryEstimate = await estimateStatutory({
    gross: rawTotals.monthlyGross,
    pfWageBase,
    pfEnrolled,
    esiEnrolled,
    ptEnrolled,
    workState: jurisdiction,
    onDate: effectiveDate,
    periodMonth: effectiveDate.getUTCMonth() + 1,
    lines,
  });
  const totals = ctcTotals(rawTotals, statutoryEstimate);

  // ── Payroll input projection ───────────────────────────────────────────────
  if (currentSalary) {
    currentSalary.effectiveTo = new Date(effectiveDate.getTime() - 1);
    await currentSalary.save({ session });
  }
  const [salary] = await SalaryStructure.create([{
    employeeId: employee._id,
    effectiveFrom: effectiveDate,
    components: projectSalaryComponents(lines),
    currency,
    payFrequency,
    workState: jurisdiction,
    pfEnrolled,
    esiEnrolled,
    ptEnrolled,
    // The payroll engine's PF wage is basic unless overridden; compensation
    // decides the PF wage from component treatments.
    pfWageOverride: round2(pfWageBase) !== round2(basicAmount) ? round2(pfWageBase) : null,
    remarks: reason,
    createdBy: companyId,
  }], { session });

  if (round2(salary.grossMonthly) !== round2(totals.monthlyGross)) {
    throw httpError(500, 'COMPENSATION_PROJECTION_MISMATCH',
      'The payroll projection does not match the compensation gross. No change was saved.');
  }

  // ── Compensation version ───────────────────────────────────────────────────
  const currentVersion = await CompensationVersion.findOne({ employeeId: employee._id, isCurrent: true }).session(session);
  if (currentVersion) {
    currentVersion.effectiveTo = new Date(effectiveDate.getTime() - 1);
    await currentVersion.save({ session });
  }

  const [version] = await CompensationVersion.create([{
    employeeId: employee._id,
    companyId,
    version: (currentVersion?.version ?? 0) + 1,
    effectiveFrom: effectiveDate,
    effectiveTo: null,
    lines,
    totals,
    statutoryEstimate,
    workState: jurisdiction,
    pfEnrolled,
    esiEnrolled,
    ptEnrolled,
    pfWageBase,
    esiWageBase: bases.esiWageBase,
    ptWageBase: bases.ptWageBase,
    salaryStructureId: salary._id,
    source,
    changeRequestId,
    reason,
    recordedBy: actor.id,
    recordedByEmail: actor.email || null,
  }], { session });

  employee.salary = salary.grossMonthly;
  await employee.save({ session });

  await auditService.log({
    action: 'SALARY_VERSION_CREATED',
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    entityType: 'SALARY_STRUCTURE',
    entityId: salary._id,
    companyId,
    meta: {
      employeeId: String(employee._id),
      effectiveFrom: effectiveDate.toISOString(),
      previousVersionId: currentSalary ? String(currentSalary._id) : null,
      previousGrossMonthly: currentSalary ? currentSalary.grossMonthly : null,
      newGrossMonthly: salary.grossMonthly,
      workState: jurisdiction,
    },
  }, session);

  await auditService.log({
    action: 'COMPENSATION_VERSION_CREATED',
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    entityType: 'EMPLOYEE',
    entityId: employee._id,
    companyId,
    meta: {
      compensationVersion: version.version,
      effectiveFrom: dateOnly(effectiveDate),
      source,
      changeRequestId: changeRequestId ? String(changeRequestId) : null,
      components: lines.map((line) => ({ code: line.componentCode, amountMonthly: line.amountMonthly })),
      monthlyGross: totals.monthlyGross,
      monthlyCtc: totals.monthlyCtc,
      annualCtc: totals.annualCtc,
      previousVersionId: currentVersion ? String(currentVersion._id) : null,
    },
  }, session);

  return { salary, version };
}

const compensationService = {
  estimateStatutory,
  applyCompensation,

  /** Current, scheduled and historical compensation for one employee. */
  async getCompensation(employeeId, companyId) {
    const employee = await loadCompanyEmployee(employeeId, companyId, { lean: true });
    const versions = await CompensationVersion.find({ employeeId: employee._id }).sort({ effectiveFrom: -1 }).lean();
    const now = new Date();

    const current = versions.find((version) => version.effectiveFrom <= now && (!version.effectiveTo || version.effectiveTo >= now)) || null;
    const scheduled = versions.filter((version) => version.effectiveFrom > now);

    return {
      current: versionView(current),
      scheduled: scheduled.map(versionView),
      history: versions.map(versionView),
    };
  },

  /** Compensation as it stood on a date (used by impact previews). */
  async versionOn(employeeId, onDate, session = null) {
    const query = CompensationVersion.findValidForDate(employeeId, onDate);
    if (session) query.session(session);
    return query.lean();
  },

  /**
   * The direct salary revision path (POST /api/employees/:id/salary).
   * Keeps its response and audit trail, and now also records a compensation
   * version built from the classic components.
   */
  async applyDirectRevision(employeeId, companyId, payload, actor) {
    const {
      effectiveFrom, components = {}, currency, payFrequency, workState,
      pfEnrolled = true, esiEnrolled = true, ptEnrolled = true, pfWageOverride, remarks,
    } = payload;

    if (typeof components.basic !== 'number') {
      throw httpError(422, 'VALIDATION_FAILED', 'components.basic is required.');
    }

    const lines = Object.entries({
      BASIC: components.basic,
      HRA: components.hra,
      CONVEYANCE: components.conveyanceAllowance,
      MEDICAL: components.medicalAllowance,
      SPECIAL: components.specialAllowance,
      OTHER_ALLOWANCES: components.otherAllowances,
    })
      .filter(([code, amount]) => code === BASIC_CODE || (Number.isFinite(amount) && amount > 0))
      .map(([componentCode, amount]) => ({
        componentCode,
        calculationMethod: 'FIXED_AMOUNT',
        basis: { amount: Number(amount || 0) },
      }));

    const { salary } = await runInTransaction(async (session) => {
      const employee = await loadCompanyEmployee(employeeId, companyId, { session });
      return applyCompensation({
        employee,
        companyId,
        effectiveFrom,
        lines,
        workState,
        pfEnrolled,
        esiEnrolled,
        ptEnrolled,
        currency,
        payFrequency,
        pfWageBaseOverride: pfWageOverride != null ? pfWageOverride : null,
        reason: remarks || null,
        source: 'DIRECT_REVISION',
        actor,
      }, session);
    }, { label: 'salary.revision' });

    const warnings = await retroactiveWarnings(companyId, new Date(effectiveFrom));
    return { salary: salary.toObject(), warnings };
  },
};

export default compensationService;
