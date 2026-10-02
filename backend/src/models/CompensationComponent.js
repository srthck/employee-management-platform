import mongoose from 'mongoose';
import { forbidQueryMutations, restrictDocumentChanges } from './guards.js';
import {
  COMPONENT_TYPES,
  RECURRENCES,
  CALCULATION_METHODS,
  TAX_TREATMENTS,
  WAGE_TREATMENTS,
  CTC_TREATMENTS,
  PAYSLIP_TREATMENTS,
  PAYROLL_APPLICATIONS,
  COMPONENT_CODE_PATTERN,
} from '../utils/compensation.js';

/**
 * CompensationComponent — a company's catalogue of pay components.
 *
 * A component carries SEMANTICS, not law: what it is, how its amount is
 * derived, and how payroll concepts (PF wage, ESI wage, professional tax wage,
 * CTC, payslip) treat it. Statutory amounts are never computed from here; they
 * come from versioned ComplianceRuleVersion documents at payroll time.
 *
 * Definitions are versioned: changing semantics closes the current version and
 * appends a new one, so a compensation version can always name the exact
 * component definition it was built from.
 */

const historyImmutable = () =>
  Object.assign(new Error('Component definitions are append-only: recorded versions cannot be changed.'), {
    statusCode: 409,
    code: 'COMPONENT_HISTORY_IMMUTABLE',
  });

const treatmentsSchema = new mongoose.Schema(
  {
    taxable: { type: String, enum: TAX_TREATMENTS, default: 'TAXABLE' },
    pfWage: { type: String, enum: WAGE_TREATMENTS, default: 'EXCLUDED' },
    esiWage: { type: String, enum: WAGE_TREATMENTS, default: 'INCLUDED' },
    ptWage: { type: String, enum: WAGE_TREATMENTS, default: 'INCLUDED' },
    ctc: { type: String, enum: CTC_TREATMENTS, default: 'INCLUDED' },
    payslip: { type: String, enum: PAYSLIP_TREATMENTS, default: 'VISIBLE' },
  },
  { _id: false }
);

const compensationComponentSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    code: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      match: [COMPONENT_CODE_PATTERN, 'A component code is 2–40 characters: capitals, digits and underscores.'],
    },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 400, default: null },

    type: { type: String, enum: COMPONENT_TYPES, required: true },
    recurrence: { type: String, enum: RECURRENCES, default: 'RECURRING' },
    calculationMethod: { type: String, enum: CALCULATION_METHODS, default: 'FIXED_AMOUNT' },
    // Suggested basis when the component is added to an employee's pay.
    defaultBasis: { type: mongoose.Schema.Types.Mixed, default: null },

    treatments: { type: treatmentsSchema, default: () => ({}) },

    /** System-managed: the amount comes from a versioned compliance rule. */
    statutory: { type: Boolean, default: false },
    payrollApplication: { type: String, enum: PAYROLL_APPLICATIONS, required: true },
    isArchived: { type: Boolean, default: false },

    version: { type: Number, required: true, min: 1 },
    isCurrent: { type: Boolean, default: true },
    supersededAt: { type: Date, default: null },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, required: true },
    recordedByEmail: { type: String, trim: true, lowercase: true, default: null },
  },
  { timestamps: true }
);

compensationComponentSchema.index({ companyId: 1, code: 1, version: 1 }, { unique: true });
compensationComponentSchema.index(
  { companyId: 1, code: 1 },
  { unique: true, partialFilterExpression: { isCurrent: true }, name: 'unique_current_component_per_company' }
);

restrictDocumentChanges(compensationComponentSchema, {
  allowedPaths: () => ['isCurrent', 'supersededAt'],
  canChange: (persisted) => persisted.isCurrent === true,
  makeError: historyImmutable,
});
forbidQueryMutations(compensationComponentSchema, historyImmutable);

export default mongoose.model('CompensationComponent', compensationComponentSchema);
