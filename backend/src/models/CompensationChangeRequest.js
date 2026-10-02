import mongoose from 'mongoose';
import { CHANGE_STATUSES, canTransitionChange } from '../utils/compensation.js';

/**
 * CompensationChangeRequest — the controlled path a pay change travels.
 *
 *   PROPOSED → SUBMITTED → (SCHEDULED | EFFECTIVE)
 *                        ↘ REJECTED
 *   PROPOSED / SUBMITTED / SCHEDULED → CANCELLED
 *
 * A request carries who proposed it, why, when it takes effect, the exact
 * component lines requested, and the financial impact computed for it. On
 * approval the resulting compensation version is created and linked, and the
 * request becomes EFFECTIVE (or SCHEDULED when the date is in the future).
 *
 * Under maker-checker the approver must be a different person: enforced by the
 * service, recorded here as proposedBy and approvedBy.
 *
 * Transitions are enforced at the model layer, like the payroll state machine.
 */

const impactAmountSchema = new mongoose.Schema(
  { before: { type: Number, required: true }, after: { type: Number, required: true }, delta: { type: Number, required: true } },
  { _id: false }
);

const impactSchema = new mongoose.Schema(
  {
    computedAt: { type: Date, required: true },
    effectiveFrom: { type: Date, required: true },
    monthlyGross: { type: impactAmountSchema, required: true },
    monthlyEmployeeDeductions: { type: impactAmountSchema, required: true },
    monthlyNetPayBeforeTds: { type: impactAmountSchema, required: true },
    monthlyEmployerContributions: { type: impactAmountSchema, required: true },
    monthlyCtc: { type: impactAmountSchema, required: true },
    annualCtc: { type: impactAmountSchema, required: true },
    annualCtcChangePercent: { type: Number, default: null },
    affectedPeriod: { type: mongoose.Schema.Types.Mixed, default: null },
    notes: { type: [mongoose.Schema.Types.Mixed], default: [] },
    ruleProvenance: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { _id: false }
);

const compensationChangeRequestSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    status: { type: String, enum: CHANGE_STATUSES, default: 'PROPOSED' },

    effectiveFrom: { type: Date, required: true },
    reason: { type: String, trim: true, required: true, minlength: 5, maxlength: 500 },

    /** Requested component lines, exactly as proposed (validated, not yet applied). */
    proposedLines: { type: [mongoose.Schema.Types.Mixed], required: true },
    workState: { type: String, uppercase: true, trim: true, default: null },
    pfEnrolled: { type: Boolean, default: null },
    esiEnrolled: { type: Boolean, default: null },
    ptEnrolled: { type: Boolean, default: null },

    baselineVersionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    impact: { type: impactSchema, default: null },
    impactAtApproval: { type: impactSchema, default: null },

    proposedBy: { type: mongoose.Schema.Types.ObjectId, required: true },
    proposedByEmail: { type: String, trim: true, lowercase: true, default: null },
    submittedAt: { type: Date, default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    decidedByEmail: { type: String, trim: true, lowercase: true, default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, trim: true, maxlength: 500, default: null },
    approvalMode: { type: String, enum: ['single', 'maker_checker', null], default: null },

    resultingVersionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    effectiveAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

compensationChangeRequestSchema.index({ companyId: 1, status: 1, effectiveFrom: 1 });
compensationChangeRequestSchema.index({ employeeId: 1, createdAt: -1 });

compensationChangeRequestSchema.post('init', function rememberStatus() {
  this.$locals.previousStatus = this.status;
});

compensationChangeRequestSchema.pre('save', function enforceTransition(next) {
  if (this.isNew || !this.isModified('status')) return next();
  const from = this.$locals.previousStatus;
  if (from === this.status) return next();
  if (!canTransitionChange(from, this.status)) {
    return next(Object.assign(new Error(`A compensation change cannot go from ${from} to ${this.status}.`), {
      statusCode: 409,
      code: 'COMPENSATION_STATE_CONFLICT',
    }));
  }
  this.$locals.previousStatus = this.status;
  return next();
});

export default mongoose.model('CompensationChangeRequest', compensationChangeRequestSchema);
