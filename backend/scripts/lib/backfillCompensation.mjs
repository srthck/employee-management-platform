import Company from '../../src/models/Company.js';
import SalaryStructure from '../../src/models/SalaryStructure.js';
import CompensationVersion from '../../src/models/CompensationVersion.js';
import compensationComponentService from '../../src/services/compensationComponentService.js';
import { estimateStatutory, ctcTotals } from '../../src/services/compensationService.js';
import { evaluateCompensationLines } from '../../src/services/compensationEvaluator.js';
import { BASIC_CODE } from '../../src/utils/compensation.js';

/**
 * Wave 3 backfill.
 *
 * 1. Every company gets the default component catalogue.
 * 2. Every existing salary version gets the compensation version it would have
 *    produced today: the same components as fixed amounts, the same PF wage,
 *    and the statutory estimate under the rules valid on its effective date.
 *
 * Salary structures are never modified — compensation is added alongside them,
 * pointing at each one — so payroll and its history are untouched.
 *
 * Safe to re-run: salary versions that already have compensation are skipped.
 */

const LEGACY_LINES = [
  ['BASIC', 'basic'],
  ['HRA', 'hra'],
  ['CONVEYANCE', 'conveyanceAllowance'],
  ['MEDICAL', 'medicalAllowance'],
  ['SPECIAL', 'specialAllowance'],
  ['OTHER_ALLOWANCES', 'otherAllowances'],
];

export async function backfillCompensation({ dryRun, log, problems }) {
  const companies = await Company.find({}).select('_id ownerId').lean();
  const systemActor = { id: null, email: null, role: 'system' };

  for (const company of companies) {
    const actor = { ...systemActor, id: company.ownerId || company._id };
    const existing = await compensationComponentService.catalogueMap(company._id);
    if (existing.size === 0) {
      log(`compensationcomponents: seed the default catalogue for company ${company._id}`);
      if (!dryRun) await compensationComponentService.seedDefaults(company._id, actor);
    }
  }

  const alreadyBackfilled = new Set(
    (await CompensationVersion.find({}).select('salaryStructureId').lean())
      .map((version) => String(version.salaryStructureId))
  );

  const salaries = await SalaryStructure.find({}).sort({ employeeId: 1, effectiveFrom: 1 }).lean();
  const pending = salaries.filter((salary) => !alreadyBackfilled.has(String(salary._id)));
  if (pending.length === 0) return;

  log(`compensationversions: create compensation from existing salary versions (${pending.length})`);
  if (dryRun) return;

  const catalogues = new Map();
  const versionCounters = new Map();

  for (const salary of pending) {
    const companyId = salary.createdBy;
    if (!catalogues.has(String(companyId))) {
      catalogues.set(String(companyId), await compensationComponentService.catalogueMap(companyId));
    }
    const catalogue = catalogues.get(String(companyId));
    if (catalogue.size === 0) {
      problems.push(`compensationversions: company ${companyId} has no component catalogue; salary ${salary._id} skipped.`);
      continue;
    }

    const components = salary.components || {};
    const lines = LEGACY_LINES
      .filter(([code, field]) => code === BASIC_CODE || Number(components[field] || 0) > 0)
      .map(([componentCode, field]) => ({
        componentCode,
        calculationMethod: 'FIXED_AMOUNT',
        basis: { amount: Number(components[field] || 0) },
      }));

    try {
      const { lines: evaluated, totals: rawTotals, bases } = evaluateCompensationLines(lines, catalogue);
      const basic = Number(components.basic || 0);
      const pfWageBase = salary.pfWageOverride != null ? Number(salary.pfWageOverride) : bases.pfWageBase;
      const statutoryEstimate = await estimateStatutory({
        gross: rawTotals.monthlyGross,
        pfWageBase,
        pfEnrolled: salary.pfEnrolled,
        esiEnrolled: salary.esiEnrolled,
        ptEnrolled: salary.ptEnrolled,
        workState: salary.workState,
        onDate: salary.effectiveFrom,
        periodMonth: new Date(salary.effectiveFrom).getUTCMonth() + 1,
      });

      const key = String(salary.employeeId);
      const version = (versionCounters.get(key) ?? 0) + 1;
      versionCounters.set(key, version);

      await CompensationVersion.create({
        employeeId: salary.employeeId,
        companyId,
        version,
        effectiveFrom: salary.effectiveFrom,
        effectiveTo: salary.effectiveTo ?? null,
        lines: evaluated,
        totals: ctcTotals(rawTotals, statutoryEstimate),
        statutoryEstimate,
        workState: salary.workState,
        pfEnrolled: salary.pfEnrolled,
        esiEnrolled: salary.esiEnrolled,
        ptEnrolled: salary.ptEnrolled,
        pfWageBase,
        esiWageBase: bases.esiWageBase,
        ptWageBase: bases.ptWageBase,
        salaryStructureId: salary._id,
        source: 'MIGRATION',
        reason: 'Recorded from the existing salary version',
        recordedBy: companyId,
        recordedByEmail: null,
      });

      if (Math.abs(rawTotals.monthlyGross - Number(salary.grossMonthly)) > 0.011) {
        problems.push(
          `compensationversions: salary ${salary._id} gross ${salary.grossMonthly} does not match its components ${rawTotals.monthlyGross}.`
        );
      }
      if (basic <= 0) {
        problems.push(`compensationversions: salary ${salary._id} has no basic component.`);
      }
    } catch (err) {
      problems.push(`compensationversions: salary ${salary._id} could not be converted (${err.message}).`);
    }
  }
}
