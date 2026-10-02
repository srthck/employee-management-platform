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
} from '../utils/compensation.js';

/**
 * CompensationVersion — one employee's complete compensation, effective-dated.
 *
 * Every line records the component definition it came from, the method and
 * basis used, and the lineage of its own amount (base, rate, inputs, result),
 * so any rupee can be explained later without re-deriving it.
 *
 * Relationship to payroll:
 *   A compensation version is projected, in the same transaction, onto a
 *   SalaryStructure version (salaryStructureId), which stays the payroll
 *   engine's input. Payroll therefore keeps its existing behaviour and its
 *   frozen snapshots; compensation adds the domain around it.
 *
 * statutoryEstimate is an ESTIMATE for display, CTC and impact previews, made
 * with the compliance rules valid at the time and recorded with their ids.
 * Payroll never reads it: a run recomputes statutory amounts from the rule
 * versions it freezes into its own snapshots.
 */

const historyImmutable = () =>
  Object.assign(new Error('Compensation history is append-only: recorded versions cannot be changed.'), {
    statusCode: 409,
    code: 'COMPENSATION_HISTORY_IMMUTABLE',
  });

const lineageInputSchema = new mongoose.Schema(
  { code: { type: String, required: true }, amount: { type: Number, required: true } },
  { _id: false }
);

const lineageSchema = new mongoose.Schema(
  {
    method: { type: String, required: true },
    baseLabel: { type: String, default: null },
    baseAmount: { type: Number, default: null },
    rate: { type: Number, default: null },
    inputs: { type: [lineageInputSchema], default: [] },
    explanation: { type: String, required: true },
  },
  { _id: false }
);

const basisSchema = new mongoose.Schema(
  {
    amount: { type: Number, default: null, min: 0 },
    percentage: { type: Number, default: null, min: 0, max: 100 },
    ofComponentCode: { type: String, default: null },
    formula: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const treatmentsSchema = new mongoose.Schema(
  {
    taxable: { type: String, enum: TAX_TREATMENTS, required: true },
    pfWage: { type: String, enum: WAGE_TREATMENTS, required: true },
    esiWage: { type: String, enum: WAGE_TREATMENTS, required: true },
    ptWage: { type: String, enum: WAGE_TREATMENTS, required: true },
    ctc: { type: String, enum: CTC_TREATMENTS, required: true },
    payslip: { type: String, enum: PAYSLIP_TREATMENTS, required: true },
  },
  { _id: false }
);

const lineSchema = new mongoose.Schema(
  {
    componentCode: { type: String, required: true },
    componentId: { type: mongoose.Schema.Types.ObjectId, required: true },
    componentVersion: { type: Number, required: true },
    name: { type: String, required: true },
    type: { type: String, enum: COMPONENT_TYPES, required: true },
    recurrence: { type: String, enum: RECURRENCES, required: true },
    calculationMethod: { type: String, enum: CALCULATION_METHODS, required: true },
    basis: { type: basisSchema, default: () => ({}) },
    treatments: { type: treatmentsSchema, required: true },
    payrollApplication: { type: String, enum: PAYROLL_APPLICATIONS, required: true },
    amountMonthly: { type: Number, required: true, min: 0 },
    lineage: { type: lineageSchema, required: true },
  },
  { _id: false }
);

const totalsSchema = new mongoose.Schema(
  {
    monthlyGross: { type: Number, required: true },
    monthlyVoluntaryDeductions: { type: Number, default: 0 },
    monthlyEmployerContributions: { type: Number, default: 0 },
    oneTimeAnnualEarnings: { type: Number, default: 0 },
    monthlyCtc: { type: Number, required: true },
    annualCtc: { type: Number, required: true },
  },
  { _id: false }
);

const ruleProvenanceSchema = new mongoose.Schema(
  {
    ruleType: { type: String, required: true },
    ruleId: { type: mongoose.Schema.Types.ObjectId, required: true },
    jurisdiction: { type: String, required: true },
    effectiveFrom: { type: Date, required: true },
  },
  { _id: false }
);

const statutoryEstimateSchema = new mongoose.Schema(
  {
    computedAt: { type: Date, required: true },
    pfWageBase: { type: Number, default: 0 },
    employeePf: { type: Number, default: 0 },
    employerPf: { type: Number, default: 0 },
    eps: { type: Number, default: 0 },
    employeeEsi: { type: Number, default: 0 },
    employerEsi: { type: Number, default: 0 },
    esiApplicable: { type: Boolean, default: false },
    professionalTax: { type: Number, default: 0 },
    totalEmployeeDeductions: { type: Number, default: 0 },
    netPayBeforeTds: { type: Number, default: 0 },
    employerContributions: { type: Number, default: 0 },
    ruleProvenance: { type: [ruleProvenanceSchema], default: [] },
    unavailableRules: { type: [String], default: [] },
  },
  { _id: false }
);

const compensationVersionSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    version: { type: Number, required: true, min: 1 },

    // Valid-time interval, mirroring the projected SalaryStructure version.
    effectiveFrom: { type: Date, required: true },
    effectiveTo: { type: Date, default: null },
    isCurrent: { type: Boolean, default: true },

    lines: { type: [lineSchema], required: true },
    totals: { type: totalsSchema, required: true },
    statutoryEstimate: { type: statutoryEstimateSchema, default: null },

    // Payroll inputs this version implies.
    workState: { type: String, required: true, uppercase: true, trim: true },
    pfEnrolled: { type: Boolean, default: true },
    esiEnrolled: { type: Boolean, default: true },
    ptEnrolled: { type: Boolean, default: true },
    pfWageBase: { type: Number, required: true },
    esiWageBase: { type: Number, required: true },
    ptWageBase: { type: Number, required: true },

    // Projection into the payroll engine's input.
    salaryStructureId: { type: mongoose.Schema.Types.ObjectId, required: true },

    source: { type: String, enum: ['DIRECT_REVISION', 'CHANGE_REQUEST', 'MIGRATION'], required: true },
    changeRequestId: { type: mongoose.Schema.Types.ObjectId, default: null },
    reason: { type: String, trim: true, maxlength: 500, default: null },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, required: true },
    recordedByEmail: { type: String, trim: true, lowercase: true, default: null },
  },
  { timestamps: true }
);

compensationVersionSchema.index({ employeeId: 1, effectiveFrom: -1 });
compensationVersionSchema.index({ employeeId: 1, version: 1 }, { unique: true });
compensationVersionSchema.index(
  { employeeId: 1 },
  { unique: true, partialFilterExpression: { isCurrent: true }, name: 'unique_current_compensation_per_employee' }
);
compensationVersionSchema.index({ companyId: 1, effectiveFrom: -1 });
compensationVersionSchema.index({ salaryStructureId: 1 });

compensationVersionSchema.pre('validate', function deriveCurrent(next) {
  this.isCurrent = this.effectiveTo == null;
  next();
});

restrictDocumentChanges(compensationVersionSchema, {
  allowedPaths: () => ['effectiveTo', 'isCurrent'],
  canChange: (persisted) => persisted.isCurrent === true,
  makeError: historyImmutable,
});
forbidQueryMutations(compensationVersionSchema, historyImmutable);

/** The compensation version valid on a date. */
compensationVersionSchema.statics.findValidForDate = function findValidForDate(employeeId, onDate) {
  return this.findOne({
    employeeId,
    effectiveFrom: { $lte: onDate },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: onDate } }],
  }).sort({ effectiveFrom: -1 });
};

export default mongoose.model('CompensationVersion', compensationVersionSchema);
