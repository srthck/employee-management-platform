import {
  BASIC_CODE,
  CALCULATION_METHODS,
  validateFormula,
  evaluateFormula,
} from '../utils/compensation.js';
import { httpError } from './employeeScope.js';
import { roundToPaise as round2, formatRupees as money } from '../utils/money.js';

/**
 * compensationEvaluator — turns requested component lines into amounts.
 *
 * Deterministic by construction:
 *   - lines are evaluated in dependency order (topological sort)
 *   - a cycle is refused, never resolved by guesswork
 *   - every amount is rounded to paise once, at the line
 *   - each line records its own lineage: method, base, rate, inputs, result
 *
 * PERCENT_OF_GROSS is defined precisely as a percentage of the gross formed by
 * the components that do not themselves depend on gross. Two such components
 * therefore never depend on each other, and the result cannot be ambiguous.
 */


const isGrossLine = (line) => line.type === 'EARNING' && line.recurrence === 'RECURRING';

/** Dependencies of one line on other component codes. */
function dependenciesOf(line, grossContributors) {
  switch (line.calculationMethod) {
    case 'PERCENT_OF_BASIC':
      return [BASIC_CODE];
    case 'PERCENT_OF_COMPONENT':
      return [line.basis.ofComponentCode];
    case 'PERCENT_OF_GROSS':
      return grossContributors;
    case 'FORMULA':
      return validateFormula(line.basis.formula, { knownCodes: new Set(grossContributors.concat(line.knownCodes)) });
    default:
      return [];
  }
}

/**
 * @param {Array} requestedLines [{ componentCode, calculationMethod?, basis }]
 * @param {Map} catalogue component code → current component definition
 * @returns {{ lines, totals, bases }}
 */
export function evaluateCompensationLines(requestedLines, catalogue) {
  if (!Array.isArray(requestedLines) || requestedLines.length === 0) {
    throw httpError(422, 'VALIDATION_FAILED', 'Compensation needs at least the basic component.');
  }

  const errors = [];
  const seen = new Set();
  const prepared = [];

  for (const requested of requestedLines) {
    const code = String(requested.componentCode || '').trim().toUpperCase();
    const component = catalogue.get(code);

    if (!component) {
      errors.push({ field: code || 'componentCode', message: `${code || 'A component'} is not an active component in this company.` });
      continue;
    }
    if (seen.has(code)) {
      errors.push({ field: code, message: `${code} appears more than once.` });
      continue;
    }
    seen.add(code);

    if (component.statutory) {
      errors.push({ field: code, message: `${code} is statutory: its amount comes from compliance rules and cannot be set here.` });
      continue;
    }

    const calculationMethod = requested.calculationMethod ?? component.calculationMethod;
    if (!CALCULATION_METHODS.includes(calculationMethod) || calculationMethod === 'STATUTORY') {
      errors.push({ field: code, message: `${code} has an unsupported calculation method.` });
      continue;
    }

    const basis = requested.basis ?? {};
    if (calculationMethod === 'FIXED_AMOUNT' && (!Number.isFinite(basis.amount) || basis.amount < 0)) {
      errors.push({ field: `${code}.amount`, message: `${code} needs an amount of zero or more.` });
    }
    if (['PERCENT_OF_BASIC', 'PERCENT_OF_GROSS', 'PERCENT_OF_COMPONENT'].includes(calculationMethod)
      && (!Number.isFinite(basis.percentage) || basis.percentage < 0 || basis.percentage > 100)) {
      errors.push({ field: `${code}.percentage`, message: `${code} needs a percentage between 0 and 100.` });
    }
    if (calculationMethod === 'PERCENT_OF_COMPONENT') {
      const target = String(basis.ofComponentCode || '').toUpperCase();
      if (!target) errors.push({ field: `${code}.ofComponentCode`, message: `${code} needs the component it is a percentage of.` });
      else if (target === code) errors.push({ field: `${code}.ofComponentCode`, message: `${code} cannot be a percentage of itself.` });
    }
    if (calculationMethod === 'FORMULA' && !basis.formula) {
      errors.push({ field: `${code}.formula`, message: `${code} needs a formula.` });
    }

    prepared.push({
      componentCode: code,
      componentId: component._id,
      componentVersion: component.version,
      name: component.name,
      type: component.type,
      recurrence: component.recurrence,
      calculationMethod,
      basis: {
        amount: basis.amount ?? null,
        percentage: basis.percentage ?? null,
        ofComponentCode: basis.ofComponentCode ? String(basis.ofComponentCode).toUpperCase() : null,
        formula: basis.formula ?? null,
      },
      treatments: {
        taxable: component.treatments.taxable,
        pfWage: component.treatments.pfWage,
        esiWage: component.treatments.esiWage,
        ptWage: component.treatments.ptWage,
        ctc: component.treatments.ctc,
        payslip: component.treatments.payslip,
      },
      // Frozen onto the version line; absent/undefined on a catalogue entry is unclassified.
      statutoryNature: component.statutoryNature ?? null,
      payrollApplication: component.payrollApplication,
    });
  }

  if (!seen.has(BASIC_CODE)) {
    errors.push({ field: BASIC_CODE, message: 'Compensation must include the basic component.' });
  }
  if (errors.length > 0) throw httpError(422, 'VALIDATION_FAILED', 'Validation failed', { errors });

  const byCode = new Map(prepared.map((line) => [line.componentCode, line]));
  const knownCodes = [...byCode.keys()];
  const grossContributors = prepared
    .filter((line) => isGrossLine(line) && line.calculationMethod !== 'PERCENT_OF_GROSS')
    .map((line) => line.componentCode);

  // ── Dependency graph ───────────────────────────────────────────────────────
  const dependencies = new Map();
  for (const line of prepared) {
    let needs;
    try {
      needs = dependenciesOf({ ...line, knownCodes }, grossContributors);
    } catch (err) {
      throw httpError(422, 'VALIDATION_FAILED', 'Validation failed', {
        errors: [{ field: `${line.componentCode}.formula`, message: err.message }],
      });
    }
    const missing = needs.filter((code) => !byCode.has(code));
    if (missing.length > 0) {
      throw httpError(422, 'VALIDATION_FAILED', 'Validation failed', {
        errors: [{
          field: line.componentCode,
          message: `${line.componentCode} depends on ${missing.join(', ')}, which is not part of this compensation.`,
        }],
      });
    }
    dependencies.set(line.componentCode, needs);
  }

  // ── Topological order, refusing cycles ─────────────────────────────────────
  const order = [];
  const state = new Map(knownCodes.map((code) => [code, 'NEW']));
  const visit = (code, path) => {
    const mark = state.get(code);
    if (mark === 'DONE') return;
    if (mark === 'VISITING') {
      const cycle = [...path.slice(path.indexOf(code)), code].join(' → ');
      throw httpError(422, 'COMPONENT_DEPENDENCY_CYCLE', `These components depend on each other in a loop: ${cycle}.`);
    }
    state.set(code, 'VISITING');
    for (const dependency of dependencies.get(code)) visit(dependency, [...path, code]);
    state.set(code, 'DONE');
    order.push(code);
  };
  for (const code of knownCodes) visit(code, []);

  // ── Evaluate ───────────────────────────────────────────────────────────────
  const amounts = new Map();
  const amountOf = (code) => amounts.get(code) ?? 0;
  const evaluated = new Map();

  for (const code of order) {
    const line = byCode.get(code);
    const { basis } = line;
    let amount = 0;
    let lineage;

    switch (line.calculationMethod) {
      case 'FIXED_AMOUNT':
        amount = round2(basis.amount);
        lineage = { method: line.calculationMethod, explanation: `Fixed amount ${money(amount)}` };
        break;

      case 'PERCENT_OF_BASIC': {
        const base = amountOf(BASIC_CODE);
        amount = round2((base * basis.percentage) / 100);
        lineage = {
          method: line.calculationMethod,
          baseLabel: 'BASIC',
          baseAmount: base,
          rate: basis.percentage,
          inputs: [{ code: BASIC_CODE, amount: base }],
          explanation: `${basis.percentage}% of BASIC ${money(base)} = ${money(amount)}`,
        };
        break;
      }

      case 'PERCENT_OF_COMPONENT': {
        const base = amountOf(basis.ofComponentCode);
        amount = round2((base * basis.percentage) / 100);
        lineage = {
          method: line.calculationMethod,
          baseLabel: basis.ofComponentCode,
          baseAmount: base,
          rate: basis.percentage,
          inputs: [{ code: basis.ofComponentCode, amount: base }],
          explanation: `${basis.percentage}% of ${basis.ofComponentCode} ${money(base)} = ${money(amount)}`,
        };
        break;
      }

      case 'PERCENT_OF_GROSS': {
        const inputs = grossContributors.map((contributor) => ({ code: contributor, amount: amountOf(contributor) }));
        const base = round2(inputs.reduce((total, input) => total + input.amount, 0));
        amount = round2((base * basis.percentage) / 100);
        lineage = {
          method: line.calculationMethod,
          baseLabel: 'GROSS_OF_INDEPENDENT_COMPONENTS',
          baseAmount: base,
          rate: basis.percentage,
          inputs,
          explanation: `${basis.percentage}% of the gross it does not depend on (${inputs.map((i) => i.code).join(' + ')} = ${money(base)}) = ${money(amount)}`,
        };
        break;
      }

      case 'FORMULA': {
        const referenced = dependencies.get(code);
        const result = evaluateFormula(basis.formula, amountOf);
        amount = round2(result.amount);
        lineage = {
          method: line.calculationMethod,
          baseLabel: 'FORMULA',
          inputs: referenced.map((reference) => ({ code: reference, amount: amountOf(reference) })),
          explanation: `${result.text} = ${money(amount)}`,
        };
        break;
      }

      default:
        throw httpError(422, 'VALIDATION_FAILED', `Unsupported calculation method for ${code}.`);
    }

    if (amount < 0) {
      throw httpError(422, 'NEGATIVE_COMPONENT_AMOUNT', `${code} works out to a negative amount (${money(amount)}).`);
    }

    amounts.set(code, amount);
    evaluated.set(code, { ...line, amountMonthly: amount, lineage });
  }

  // Keep the caller's order for display; evaluation order is internal.
  const lines = prepared.map((line) => evaluated.get(line.componentCode));

  const { totals, bases } = summarizeEvaluatedLines(lines);

  if (totals.monthlyGross <= 0) {
    throw httpError(422, 'NON_POSITIVE_GROSS', 'Monthly gross must be more than zero.');
  }

  return { lines, totals, bases };
}

/**
 * Totals and wage bases of lines that are ALREADY evaluated: freshly evaluated
 * ones, or the frozen lines of a stored compensation version. Reads only what is
 * on the lines (amounts and their frozen treatments), never the catalogue, so a
 * stored version is summarised as it was recorded.
 */
export function summarizeEvaluatedLines(lines) {
  const sumWhere = (predicate) => round2(lines.filter(predicate).reduce((total, line) => total + line.amountMonthly, 0));
  const monthlyGross = sumWhere(isGrossLine);
  const bases = {
    pfWageBase: sumWhere((line) => isGrossLine(line) && line.treatments.pfWage === 'INCLUDED'),
    esiWageBase: sumWhere((line) => isGrossLine(line) && line.treatments.esiWage === 'INCLUDED'),
    ptWageBase: sumWhere((line) => isGrossLine(line) && line.treatments.ptWage === 'INCLUDED'),
  };

  const totals = {
    monthlyGross,
    monthlyVoluntaryDeductions: sumWhere((line) => line.type === 'DEDUCTION' && line.recurrence === 'RECURRING'),
    monthlyEmployerContributions: sumWhere(
      (line) => ['EMPLOYER_CONTRIBUTION', 'BENEFIT'].includes(line.type)
        && line.recurrence === 'RECURRING'
        && line.treatments.ctc === 'INCLUDED'
    ),
    oneTimeAnnualEarnings: sumWhere((line) => line.recurrence === 'ONE_TIME' && line.treatments.ctc === 'INCLUDED'),
  };

  return { totals, bases };
}

export { round2 as roundToPaise };
