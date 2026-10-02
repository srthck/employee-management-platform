/**
 * Compensation vocabulary and the default component catalogue.
 *
 * A component says WHAT it is (earning, deduction, employer contribution),
 * HOW its amount is derived, and HOW payroll concepts treat it. It never says
 * how the law computes statutory amounts: that lives in versioned compliance
 * rules (ComplianceRuleVersion) and is applied by complianceCalculationService.
 *
 * CTC is not gross and gross is not net:
 *   gross = recurring EARNING components
 *   net   = gross − employee deductions (statutory amounts come from the
 *           payroll engine; voluntary ones are not applied to pay yet)
 *   CTC   = gross + employer contributions (+ one-time earnings, annualised)
 */

export const COMPONENT_TYPES = Object.freeze(['EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION', 'BENEFIT']);
export const RECURRENCES = Object.freeze(['RECURRING', 'ONE_TIME']);

/**
 * Calculation methods. FORMULA is a declarative expression tree evaluated by
 * evaluateFormula below — never executable code.
 */
export const CALCULATION_METHODS = Object.freeze([
  'FIXED_AMOUNT',
  'PERCENT_OF_BASIC',
  'PERCENT_OF_GROSS',
  'PERCENT_OF_COMPONENT',
  'FORMULA',
  'STATUTORY',
]);

export const TAX_TREATMENTS = Object.freeze(['TAXABLE', 'EXEMPT', 'PARTIALLY_EXEMPT']);
export const WAGE_TREATMENTS = Object.freeze(['INCLUDED', 'EXCLUDED']);
export const CTC_TREATMENTS = Object.freeze(['INCLUDED', 'EXCLUDED']);
export const PAYSLIP_TREATMENTS = Object.freeze(['VISIBLE', 'HIDDEN']);

/**
 * What payroll does with a component today. Recorded on every component and
 * every compensation line, so nobody assumes money moves that does not.
 *
 *   GROSS_INPUT       part of the monthly gross the payroll engine calculates on
 *   STATUTORY_ENGINE  amount comes from versioned compliance rules at run time
 *   NET_DEDUCTION     deducted from net pay every month, on the earned amount
 *   EMPLOYER_COST     paid by the employer every month, on top of gross
 *   NOT_APPLIED_YET   recorded and counted in CTC, but payroll does not pay or
 *                     deduct it yet (one-time earnings and benefits, which a
 *                     monthly run does not pay: off-cycle pay is Wave 8)
 */
export const PAYROLL_APPLICATIONS = Object.freeze([
  'GROSS_INPUT', 'STATUTORY_ENGINE', 'NET_DEDUCTION', 'EMPLOYER_COST', 'NOT_APPLIED_YET',
]);

export const FORMULA_OPERATIONS = Object.freeze(['SUM', 'DIFFERENCE', 'PRODUCT', 'MIN', 'MAX', 'PERCENT']);
export const FORMULA_MAX_DEPTH = 5;

export const CHANGE_STATUSES = Object.freeze([
  'PROPOSED', 'SUBMITTED', 'APPROVED', 'SCHEDULED', 'EFFECTIVE', 'REJECTED', 'CANCELLED',
]);

/** Allowed status transitions for a compensation change request. */
const CHANGE_TRANSITIONS = Object.freeze({
  PROPOSED: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['SCHEDULED', 'EFFECTIVE', 'REJECTED', 'CANCELLED'],
  APPROVED: ['SCHEDULED', 'EFFECTIVE'],
  SCHEDULED: ['EFFECTIVE'],
  EFFECTIVE: [],
  REJECTED: [],
  CANCELLED: [],
});

export const canTransitionChange = (from, to) => (CHANGE_TRANSITIONS[from] || []).includes(to);

export const BASIC_CODE = 'BASIC';
export const COMPONENT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;

/**
 * A statutory nature is only a KEY: its syntax is checked here and nothing
 * else. What a nature means (included in a statutory wage or not) is decided
 * solely by the inclusion matrix of a compliance rule version, never by
 * application code. null means unclassified.
 */
export const STATUTORY_NATURE_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;
export const STATUTORY_NATURE_MESSAGE = 'A statutory nature is 2–40 characters: capitals, digits and underscores.';

/** Payroll application implied by a component's nature. */
export function payrollApplicationFor({ type, recurrence, statutory }) {
  if (statutory) return 'STATUTORY_ENGINE';
  // A monthly run pays what recurs monthly. One-time pay waits for Wave 8.
  if (recurrence !== 'RECURRING') return 'NOT_APPLIED_YET';
  if (type === 'EARNING') return 'GROSS_INPUT';
  if (type === 'DEDUCTION') return 'NET_DEDUCTION';
  if (type === 'EMPLOYER_CONTRIBUTION') return 'EMPLOYER_COST';
  return 'NOT_APPLIED_YET';
}

const component = ({
  code, name, description, type, recurrence = 'RECURRING', calculationMethod = 'FIXED_AMOUNT',
  taxable = 'TAXABLE', pfWage = 'EXCLUDED', esiWage = 'INCLUDED', ptWage = 'INCLUDED',
  ctc = 'INCLUDED', payslip = 'VISIBLE', statutory = false, defaultBasis = null,
}) => ({
  code,
  name,
  description,
  type,
  recurrence,
  calculationMethod,
  statutory,
  defaultBasis,
  treatments: { taxable, pfWage, esiWage, ptWage, ctc, payslip },
  payrollApplication: payrollApplicationFor({ type, recurrence, statutory }),
});

/**
 * The catalogue every new company starts with.
 *
 * Wage treatments are chosen so a compensation version built from the classic
 * six components reproduces exactly what payroll calculates today: the PF wage
 * is basic, ESI and professional tax use gross.
 *
 * Special allowance: India's Supreme Court held in 2019 that allowances paid
 * universally to all employees form part of PF wages. PayGuard does not decide
 * that for a company — the default keeps the PF wage at basic, and marking any
 * component as PF wage changes the PF wage base deliberately and visibly.
 */
export const DEFAULT_COMPONENTS = Object.freeze([
  component({
    code: 'BASIC', name: 'Basic', type: 'EARNING', pfWage: 'INCLUDED',
    description: 'Base salary. The provident fund wage is built from components marked as PF wage.',
  }),
  component({
    code: 'HRA', name: 'House rent allowance', type: 'EARNING', taxable: 'PARTIALLY_EXEMPT',
    calculationMethod: 'PERCENT_OF_BASIC', defaultBasis: { percentage: 40 },
    description: 'House rent allowance. Its exemption is computed by the tax engine (not built yet).',
  }),
  component({ code: 'CONVEYANCE', name: 'Conveyance allowance', type: 'EARNING', description: 'Travel allowance paid monthly.' }),
  component({ code: 'MEDICAL', name: 'Medical allowance', type: 'EARNING', description: 'Medical allowance paid monthly.' }),
  component({
    code: 'SPECIAL', name: 'Special allowance', type: 'EARNING',
    description: 'Balancing allowance. Review its PF wage treatment against your own legal advice.',
  }),
  component({ code: 'OTHER_ALLOWANCES', name: 'Other allowances', type: 'EARNING', description: 'Any other recurring allowance.' }),
  component({ code: 'FUEL_ALLOWANCE', name: 'Fuel allowance', type: 'EARNING', description: 'Fuel paid as a recurring allowance.' }),
  component({ code: 'CAR_ALLOWANCE', name: 'Car allowance', type: 'EARNING', description: 'Car or motor vehicle allowance.' }),
  component({ code: 'MISC_ALLOWANCE', name: 'Miscellaneous allowance', type: 'EARNING', description: 'Miscellaneous recurring allowance.' }),
  component({
    code: 'BONUS', name: 'Bonus', type: 'EARNING', recurrence: 'ONE_TIME',
    description: 'One-time bonus. Counted in annual CTC; paid through an off-cycle run (not built yet).',
  }),
  component({
    code: 'VPF', name: 'Voluntary provident fund', type: 'DEDUCTION', ctc: 'EXCLUDED',
    calculationMethod: 'PERCENT_OF_BASIC', defaultBasis: { percentage: 0 },
    description: 'Voluntary provident fund contribution by the employee, above the statutory rate.',
  }),
  component({
    code: 'NPS_EMPLOYEE', name: 'NPS (employee)', type: 'DEDUCTION', ctc: 'EXCLUDED',
    description: 'Employee contribution to the National Pension System.',
  }),
  component({
    code: 'NPS_EMPLOYER', name: 'NPS (employer)', type: 'EMPLOYER_CONTRIBUTION',
    description: 'Employer contribution to the National Pension System. Part of CTC.',
  }),
  component({
    code: 'GRATUITY', name: 'Gratuity provision', type: 'EMPLOYER_CONTRIBUTION',
    calculationMethod: 'PERCENT_OF_BASIC', defaultBasis: { percentage: 4.81 },
    description: 'Gratuity provision carried in CTC. Payment happens on exit (not built yet).',
  }),
  component({
    code: 'PF_EMPLOYEE', name: 'Provident fund (employee)', type: 'DEDUCTION', statutory: true, ctc: 'EXCLUDED',
    calculationMethod: 'STATUTORY',
    description: 'Employee provident fund. The amount comes from the versioned EPF rule at payroll time.',
  }),
  component({
    code: 'PF_EMPLOYER', name: 'Provident fund (employer)', type: 'EMPLOYER_CONTRIBUTION', statutory: true,
    calculationMethod: 'STATUTORY',
    description: 'Employer provident fund including the pension (EPS) share. Part of CTC.',
  }),
  component({
    code: 'ESI_EMPLOYEE', name: 'Employee state insurance (employee)', type: 'DEDUCTION', statutory: true, ctc: 'EXCLUDED',
    calculationMethod: 'STATUTORY',
    description: 'Employee ESI contribution, applicable under the wage ceiling.',
  }),
  component({
    code: 'ESI_EMPLOYER', name: 'Employee state insurance (employer)', type: 'EMPLOYER_CONTRIBUTION', statutory: true,
    calculationMethod: 'STATUTORY',
    description: 'Employer ESI contribution. Part of CTC.',
  }),
  component({
    code: 'PROFESSIONAL_TAX', name: 'Professional tax', type: 'DEDUCTION', statutory: true, ctc: 'EXCLUDED',
    calculationMethod: 'STATUTORY',
    description: 'State professional tax, from the versioned slab rule for the work state.',
  }),
]);

/** Legacy SalaryStructure bucket for a component code; anything else is "other". */
export const LEGACY_COMPONENT_BUCKETS = Object.freeze({
  BASIC: 'basic',
  HRA: 'hra',
  CONVEYANCE: 'conveyanceAllowance',
  MEDICAL: 'medicalAllowance',
  SPECIAL: 'specialAllowance',
});

import { roundToPaise as round2 } from './money.js';

/**
 * Validate a declarative formula tree.
 *
 * Node shapes:
 *   { operation: 'SUM' | 'DIFFERENCE' | 'PRODUCT' | 'MIN' | 'MAX', operands: [node, ...] }
 *   { operation: 'PERCENT', percentage: 0–100, operands: [node] }
 *   { component: 'CODE' }
 *   { constant: number }
 *
 * @returns {string[]} component codes the formula depends on
 */
export function validateFormula(node, { knownCodes, depth = 0 } = {}) {
  if (depth > FORMULA_MAX_DEPTH) throw new Error(`A formula may not nest deeper than ${FORMULA_MAX_DEPTH} levels.`);
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('A formula node must be an object.');

  if (Object.prototype.hasOwnProperty.call(node, 'constant')) {
    if (!Number.isFinite(node.constant)) throw new Error('A formula constant must be a number.');
    return [];
  }
  if (Object.prototype.hasOwnProperty.call(node, 'component')) {
    if (typeof node.component !== 'string' || !COMPONENT_CODE_PATTERN.test(node.component)) {
      throw new Error('A formula component reference must be a component code.');
    }
    if (knownCodes && !knownCodes.has(node.component)) {
      throw new Error(`The formula references ${node.component}, which is not part of this compensation.`);
    }
    return [node.component];
  }

  if (!FORMULA_OPERATIONS.includes(node.operation)) {
    throw new Error(`A formula operation must be one of: ${FORMULA_OPERATIONS.join(', ')}.`);
  }
  if (!Array.isArray(node.operands) || node.operands.length === 0 || node.operands.length > 10) {
    throw new Error('A formula operation needs between 1 and 10 operands.');
  }
  if (node.operation === 'PERCENT') {
    if (!Number.isFinite(node.percentage) || node.percentage < 0 || node.percentage > 100) {
      throw new Error('A formula percentage must be between 0 and 100.');
    }
    if (node.operands.length !== 1) throw new Error('PERCENT takes exactly one operand.');
  }
  if (node.operation === 'DIFFERENCE' && node.operands.length !== 2) {
    throw new Error('DIFFERENCE takes exactly two operands.');
  }

  return node.operands.flatMap((operand) => validateFormula(operand, { knownCodes, depth: depth + 1 }));
}

/**
 * Evaluate a validated formula tree.
 *
 * @param {object} node
 * @param {(code: string) => number} resolve amount of a referenced component
 * @returns {{ amount: number, text: string }} the amount and a readable expression
 */
export function evaluateFormula(node, resolve) {
  if (Object.prototype.hasOwnProperty.call(node, 'constant')) {
    return { amount: round2(node.constant), text: String(round2(node.constant)) };
  }
  if (Object.prototype.hasOwnProperty.call(node, 'component')) {
    const amount = round2(resolve(node.component));
    return { amount, text: `${node.component} (${amount})` };
  }

  const parts = node.operands.map((operand) => evaluateFormula(operand, resolve));
  const values = parts.map((part) => part.amount);
  const joined = (separator) => parts.map((part) => part.text).join(separator);

  switch (node.operation) {
    case 'SUM':
      return { amount: round2(values.reduce((total, value) => total + value, 0)), text: `(${joined(' + ')})` };
    case 'DIFFERENCE':
      return { amount: round2(values[0] - values[1]), text: `(${joined(' − ')})` };
    case 'PRODUCT':
      return { amount: round2(values.reduce((total, value) => total * value, 1)), text: `(${joined(' × ')})` };
    case 'MIN':
      return { amount: round2(Math.min(...values)), text: `min(${joined(', ')})` };
    case 'MAX':
      return { amount: round2(Math.max(...values)), text: `max(${joined(', ')})` };
    case 'PERCENT':
      return { amount: round2((values[0] * node.percentage) / 100), text: `${node.percentage}% of ${parts[0].text}` };
    default:
      throw new Error(`Unsupported formula operation: ${node.operation}.`);
  }
}
