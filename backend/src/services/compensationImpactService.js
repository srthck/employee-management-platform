import PayrollRun from '../models/PayrollRun.js';
import ComplianceRuleVersion from '../models/ComplianceRuleVersion.js';
import compensationComponentService from './compensationComponentService.js';
import { estimateStatutory, ctcTotals, notAppliedLines, versionView } from './compensationService.js';
import { evaluateCompensationLines, summarizeEvaluatedLines } from './compensationEvaluator.js';
import { roundToPaise as round2 } from '../utils/money.js';
import { httpError, startOfUtcDay, dateOnly, isValidDate } from './employeeScope.js';

/**
 * compensationImpactService — what a proposed pay change costs, before it is real.
 *
 * Deterministic: both sides are computed with the compliance rules valid on the
 * SAME effective date, so a delta shows the pay change and never a rule change.
 * The rule versions used are returned, so a preview can be reproduced exactly.
 *
 * It answers in money, not adjectives: monthly gross, employee deductions, net
 * pay before tax, employer contributions, monthly and annual CTC — each as
 * before, after and delta — plus the period the change first lands in and the
 * things a finance reviewer must know before approving.
 */

const amount = (before, after) => ({
  before: round2(before),
  after: round2(after),
  delta: round2(after - before),
});

const percentChange = (before, after) => (before > 0 ? round2(((after - before) / before) * 100) : null);

const note = (code, message) => ({ code, message });

/** One side of the comparison, evaluated under the rules of `onDate`. */
async function evaluateSide({
  lines, storedLines = null, workState, pfEnrolled, esiEnrolled, ptEnrolled, pfWageBaseOverride, onDate, catalogue,
}) {
  // A proposed side is evaluated from its requested lines. The BASELINE is a
  // stored version: its recorded lines, amounts and frozen treatments are used
  // as they were written, never re-evaluated against today's catalogue.
  const { lines: evaluated, totals: rawTotals, bases } = storedLines
    ? { lines: storedLines, ...summarizeEvaluatedLines(storedLines) }
    : evaluateCompensationLines(lines, catalogue);
  const pfWageBase = pfWageBaseOverride != null ? round2(pfWageBaseOverride) : bases.pfWageBase;
  const statutory = await estimateStatutory({
    gross: rawTotals.monthlyGross,
    pfWageBase,
    pfEnrolled,
    esiEnrolled,
    ptEnrolled,
    workState,
    onDate,
    periodMonth: onDate.getUTCMonth() + 1,
    // The same pure derivation payroll uses, over these frozen lines.
    lines: evaluated,
  });
  const totals = ctcTotals(rawTotals, statutory);
  return { lines: evaluated, totals, bases, pfWageBase, statutory };
}

/** The lines of an existing compensation version, in request form. */
const linesFromVersion = (version) => (version?.lines || []).map((line) => ({
  componentCode: line.componentCode,
  calculationMethod: line.calculationMethod,
  basis: {
    amount: line.basis?.amount ?? null,
    percentage: line.basis?.percentage ?? null,
    ofComponentCode: line.basis?.ofComponentCode ?? null,
    formula: line.basis?.formula ?? null,
  },
}));

const compensationImpactService = {
  linesFromVersion,

  /**
   * Compare a proposed compensation against the one in force on the effective
   * date. Pure: reads data, writes nothing.
   */
  async preview({
    companyId, employee, baselineVersion, effectiveFrom, lines,
    workState, pfEnrolled = true, esiEnrolled = true, ptEnrolled = true, catalogue = null,
  }) {
    if (!isValidDate(effectiveFrom)) throw httpError(422, 'VALIDATION_FAILED', 'effectiveFrom must be a valid date.');
    const onDate = startOfUtcDay(effectiveFrom);
    const components = catalogue || await compensationComponentService.catalogueMap(companyId);

    const after = await evaluateSide({
      lines, workState, pfEnrolled, esiEnrolled, ptEnrolled, pfWageBaseOverride: null, onDate, catalogue: components,
    });

    const before = baselineVersion
      ? await evaluateSide({
        storedLines: (baselineVersion.lines || []).map((line) => (line.toObject ? line.toObject() : line)),
        workState: baselineVersion.workState,
        pfEnrolled: baselineVersion.pfEnrolled,
        esiEnrolled: baselineVersion.esiEnrolled,
        ptEnrolled: baselineVersion.ptEnrolled,
        pfWageBaseOverride: baselineVersion.pfWageBase,
        onDate,
        catalogue: components,
      })
      : null;

    const zero = {
      totals: { monthlyGross: 0, monthlyCtc: 0, annualCtc: 0, monthlyEmployerContributions: 0, monthlyVoluntaryDeductions: 0, oneTimeAnnualEarnings: 0 },
      statutory: { totalEmployeeDeductions: 0, netPayBeforeTds: 0, employerContributions: 0, esiApplicable: false, professionalTax: 0, employeePf: 0 },
      bases: { esiWageBase: 0 },
      pfWageBase: 0,
    };
    const baseline = before || zero;

    const employerBefore = round2(baseline.statutory.employerContributions + baseline.totals.monthlyEmployerContributions);
    const employerAfter = round2(after.statutory.employerContributions + after.totals.monthlyEmployerContributions);

    const impact = {
      computedAt: new Date(),
      effectiveFrom: onDate,
      monthlyGross: amount(baseline.totals.monthlyGross, after.totals.monthlyGross),
      monthlyEmployeeDeductions: amount(baseline.statutory.totalEmployeeDeductions, after.statutory.totalEmployeeDeductions),
      monthlyNetPayBeforeTds: amount(baseline.statutory.netPayBeforeTds, after.statutory.netPayBeforeTds),
      monthlyEmployerContributions: amount(employerBefore, employerAfter),
      monthlyCtc: amount(baseline.totals.monthlyCtc, after.totals.monthlyCtc),
      annualCtc: amount(baseline.totals.annualCtc, after.totals.annualCtc),
      annualCtcChangePercent: percentChange(baseline.totals.annualCtc, after.totals.annualCtc),
      affectedPeriod: null,
      notes: [],
      ruleProvenance: after.statutory.ruleProvenance,
    };

    // ── The period this change first lands in ──────────────────────────────
    const periodYear = onDate.getUTCFullYear();
    const periodMonth = onDate.getUTCMonth() + 1;
    const existingRun = await PayrollRun.findOne({ companyId, periodYear, periodMonth, status: { $ne: 'CANCELLED' } })
      .select('status periodStart periodEnd').lean();
    impact.affectedPeriod = {
      periodMonth,
      periodYear,
      runStatus: existingRun ? existingRun.status : 'NOT_CREATED',
      alreadyFinalized: Boolean(existingRun && ['FINALIZED', 'DISBURSED'].includes(existingRun.status)),
    };

    // ── What a reviewer must know ──────────────────────────────────────────
    const finalized = await PayrollRun.find({
      companyId,
      status: { $in: ['FINALIZED', 'DISBURSED'] },
      periodEnd: { $gte: onDate },
    }).select('periodMonth periodYear').sort({ periodYear: 1, periodMonth: 1 }).lean();
    if (finalized.length > 0) {
      impact.notes.push(note('RETROACTIVE_PERIODS',
        `${finalized.length} finalized payroll period(s) start on or after this date. Their payslips never change; the difference has to be paid as arrears in a later run (not built yet).`));
    }

    if (onDate.getUTCDate() !== 1) {
      impact.notes.push(note('MID_PERIOD_EFFECTIVE',
        `This takes effect on ${dateOnly(onDate)}, inside a payroll period. That whole month is calculated at the new rate: pay is prorated for joining and exit, but not for a compensation change inside a period.`));
    }

    if (impact.monthlyGross.delta < 0) {
      impact.notes.push(note('GROSS_REDUCED', 'This reduces monthly gross pay. Check the employee has agreed in writing.'));
    }

    if (before && baseline.statutory.esiApplicable !== after.statutory.esiApplicable) {
      impact.notes.push(note('ESI_ELIGIBILITY_CHANGED', after.statutory.esiApplicable
        ? 'The employee comes under the ESI wage ceiling after this change: ESI now applies.'
        : 'Gross rises above the ESI wage ceiling: ESI stops applying from this period.'));
    }

    const epfRule = await ComplianceRuleVersion.findValidForDate('EPF', 'IN', onDate);
    const pfCeiling = epfRule?.epfParams?.wageCapForContribution;
    if (pfEnrolled && pfCeiling != null && after.pfWageBase > pfCeiling) {
      impact.notes.push(note('PF_WAGE_ABOVE_CEILING',
        `The PF wage base (${round2(after.pfWageBase)}) is above the statutory ceiling (${pfCeiling}), so provident fund does not rise with this change.`));
    }

    if (before && round2(baseline.statutory.professionalTax) !== round2(after.statutory.professionalTax)) {
      impact.notes.push(note('PROFESSIONAL_TAX_SLAB_CHANGED',
        `Professional tax moves from ${round2(baseline.statutory.professionalTax)} to ${round2(after.statutory.professionalTax)} for this work state.`));
    }

    const notApplied = notAppliedLines(after.lines);
    if (notApplied.length > 0) {
      impact.notes.push(note('COMPONENTS_NOT_APPLIED_IN_PAYROLL',
        `${notApplied.map((line) => line.name).join(', ')} count towards CTC but payroll does not pay or deduct them yet.`));
    }

    // ESI and professional tax are calculated on their own wage, not on gross. Say
    // so whenever that wage differs, with the figures payroll will use.
    const afterBases = after.statutory.statutoryBases;
    if (afterBases && round2(afterBases.esiContributionWage) !== round2(after.totals.monthlyGross)) {
      impact.notes.push(note('ESI_WAGE_DIFFERS_FROM_GROSS',
        `Some components are outside the ESI wage: ESI is calculated on ${round2(afterBases.esiContributionWage)}, not on the gross of ${round2(after.totals.monthlyGross)}.`));
    }
    if (afterBases && round2(afterBases.ptSlabWage) !== round2(after.totals.monthlyGross)) {
      impact.notes.push(note('PT_WAGE_DIFFERS_FROM_GROSS',
        `Some components are outside the professional tax wage: the slab is read from ${round2(afterBases.ptSlabWage)}, not from the gross of ${round2(after.totals.monthlyGross)}.`));
    }

    if (after.statutory.unavailableRules.length > 0) {
      impact.notes.push(note('STATUTORY_RULES_UNAVAILABLE',
        `No ${after.statutory.unavailableRules.join(', ')} rule version is in force on this date, so that amount is shown as zero.`));
    }

    return {
      impact,
      proposed: {
        lines: after.lines.map((line) => ({
          componentCode: line.componentCode,
          name: line.name,
          type: line.type,
          recurrence: line.recurrence,
          calculationMethod: line.calculationMethod,
          amountMonthly: line.amountMonthly,
          payrollApplication: line.payrollApplication,
          lineage: line.lineage,
        })),
        totals: after.totals,
        statutoryEstimate: after.statutory,
        pfWageBase: after.pfWageBase,
      },
      baseline: baselineVersion ? versionView(baselineVersion) : null,
    };
  },
};

export default compensationImpactService;
