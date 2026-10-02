import mongoose from 'mongoose';
import { PAYABLE_DAYS_BASES, PROFESSIONAL_TAX_BASES } from '../utils/payBasis.js';

/**
 * Company — the tenant boundary and home of company-wide payroll controls.
 *
 * Identity:
 *   A company's _id equals its founding admin's _id. Every existing reference
 *   (Employee.createdBy, PayrollRun.companyId, AuditLog.companyId, ...) already
 *   uses that value, so introducing the entity required no rewrite of history.
 *
 * Settings are the configurable controls around the payroll state machine:
 *   approvalMode
 *     single         the finalizer may be the same person who calculated
 *     maker_checker  the person who calculated a run cannot finalize it
 *   compensationApprovalMode
 *     single         a pay change may be applied directly by whoever may revise pay
 *     maker_checker  pay changes only through a compensation change approved by
 *                    someone other than the proposer; the direct path is closed
 *   varianceThresholdPercent
 *     pay changes at or above this percentage are material
 *   blockFinalizationOnUnexplainedVariance
 *     unexplained material pay changes block finalization unless a user with
 *     payroll.variance.override records a reason
 */

const settingsSchema = new mongoose.Schema(
  {
    approvalMode: {
      type: String,
      enum: ['single', 'maker_checker'],
      default: 'single',
    },
    compensationApprovalMode: {
      type: String,
      enum: ['single', 'maker_checker'],
      default: 'single',
    },
    // How many days a month pays for, and how paid days are counted for
    // someone who joins or leaves mid-period. See utils/payBasis.js.
    payableDaysBasis: {
      type: String,
      enum: PAYABLE_DAYS_BASES,
      default: 'CALENDAR_DAYS',
    },
    fixedPayableDays: {
      type: Number,
      min: [20, 'A fixed month must be at least 20 days'],
      max: [31, 'A fixed month cannot exceed 31 days'],
      default: 30,
    },
    weeklyOffDays: {
      type: [Number],
      default: [0],
    },
    // Which gross the professional tax slab is read from in a prorated month.
    professionalTaxBasis: {
      type: String,
      enum: PROFESSIONAL_TAX_BASES,
      default: 'EARNED_GROSS',
    },
    varianceThresholdPercent: {
      type: Number,
      min: [1, 'Variance threshold must be at least 1%'],
      max: [100, 'Variance threshold cannot exceed 100%'],
      default: 10,
    },
    blockFinalizationOnUnexplainedVariance: {
      type: Boolean,
      default: true,
    },
  },
  { _id: false }
);

const companySchema = new mongoose.Schema(
  {
    _id: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    name: {
      type: String,
      required: [true, 'Company name is required'],
      trim: true,
      minlength: [2, 'Company name must be at least 2 characters'],
      maxlength: [120, 'Company name cannot exceed 120 characters'],
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      required: true,
    },
    settings: {
      type: settingsSchema,
      default: () => ({}),
    },
  },
  { timestamps: true }
);

/**
 * Create the company for a workspace owner if it does not exist yet.
 * Safe to call repeatedly; used at registration and for pre-existing workspaces.
 */
companySchema.statics.ensureForOwner = async function ensureForOwner(owner, session = null) {
  const existing = await this.findById(owner._id).session(session);
  if (existing) return existing;
  const [company] = await this.create(
    [{ _id: owner._id, ownerId: owner._id, name: `${owner.name}'s company` }],
    { session }
  );
  return company;
};

export default mongoose.model('Company', companySchema);
