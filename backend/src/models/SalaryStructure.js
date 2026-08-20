import mongoose from 'mongoose';

/**
 * SalaryStructure — valid-time versioned salary record per employee.
 *
 * Design principles:
 * - Each document represents ONE salary version for an employee.
 * - effectiveFrom / effectiveTo define the valid-time interval.
 *   effectiveTo = null means "currently active / open-ended".
 * - When a salary revision occurs, the old record is closed (effectiveTo set)
 *   and a new record is created (effectiveFrom = revision date, effectiveTo = null).
 * - Salary components are stored explicitly (basic, hra, allowances, etc.)
 *   so future payroll calculations use consistent component breakdowns.
 * - The legacy flat `salary` field on Employee is NOT authoritative for payroll.
 *   SalaryStructure IS the authoritative source.
 *
 * Querying for a payroll period:
 *   Find the record where:
 *     employee = <id>
 *     effectiveFrom <= periodEnd
 *     (effectiveTo = null OR effectiveTo >= periodStart)
 */

const salaryComponentSchema = new mongoose.Schema(
  {
    basic: {
      type: Number,
      required: [true, 'Basic salary component is required'],
      min: [0, 'Basic salary cannot be negative'],
    },
    hra: {
      type: Number,
      default: 0,
      min: [0, 'HRA cannot be negative'],
    },
    conveyanceAllowance: {
      type: Number,
      default: 0,
      min: [0, 'Conveyance allowance cannot be negative'],
    },
    medicalAllowance: {
      type: Number,
      default: 0,
      min: [0, 'Medical allowance cannot be negative'],
    },
    specialAllowance: {
      type: Number,
      default: 0,
      min: [0, 'Special allowance cannot be negative'],
    },
    otherAllowances: {
      type: Number,
      default: 0,
      min: [0, 'Other allowances cannot be negative'],
    },
  },
  { _id: false }
);

const salaryStructureSchema = new mongoose.Schema(
  {
    // ─── Identity ───────────────────────────────────────────────────────────
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: [true, 'Employee ID is required'],
      index: true,
    },

    // ─── Valid-time interval ─────────────────────────────────────────────
    effectiveFrom: {
      type: Date,
      required: [true, 'Effective from date is required'],
    },
    effectiveTo: {
      type: Date,
      default: null, // null = currently active
    },

    // ─── Salary components ────────────────────────────────────────────────
    components: {
      type: salaryComponentSchema,
      required: [true, 'Salary components are required'],
    },

    // ─── Derived gross (stored for fast querying, computed on create/update) ─
    grossMonthly: {
      type: Number,
      required: [true, 'Gross monthly salary is required'],
      min: [0, 'Gross salary cannot be negative'],
    },

    // ─── Currency and pay frequency ──────────────────────────────────────
    currency: {
      type: String,
      default: 'INR',
      uppercase: true,
      trim: true,
    },
    payFrequency: {
      type: String,
      enum: ['monthly', 'semi-monthly', 'bi-weekly', 'weekly'],
      default: 'monthly',
    },

    // ─── Work state / jurisdiction for PT resolution ─────────────────────
    workState: {
      type: String,
      trim: true,
      uppercase: true,
      default: 'MH', // Maharashtra default; required for PT calculation
    },

    // ─── Statutory flags ─────────────────────────────────────────────────
    pfEnrolled: {
      type: Boolean,
      default: true,
    },
    esiEnrolled: {
      type: Boolean,
      default: true, // ESI eligibility is also driven by gross threshold
    },
    ptEnrolled: {
      type: Boolean,
      default: true,
    },

    // ─── PF-specific metadata ─────────────────────────────────────────────
    pfWageOverride: {
      // If set, PF is calculated on this wage instead of basic.
      // null = use basic from components.
      type: Number,
      default: null,
      min: [0, 'PF wage override cannot be negative'],
    },

    // ─── Metadata ─────────────────────────────────────────────────────────
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      required: true,
    },
    remarks: {
      type: String,
      trim: true,
      maxlength: [500, 'Remarks cannot exceed 500 characters'],
    },
  },
  {
    timestamps: true,
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────
// Primary query: find salary valid for a payroll period for an employee
salaryStructureSchema.index({ employeeId: 1, effectiveFrom: 1 });
salaryStructureSchema.index({ employeeId: 1, effectiveTo: 1 });
// Find current (open-ended) salary for an employee
salaryStructureSchema.index({ employeeId: 1, effectiveTo: 1, effectiveFrom: -1 });

// ─── Pre-save: compute grossMonthly from components ───────────────────────────
salaryStructureSchema.pre('save', function (next) {
  if (this.components) {
    this.grossMonthly =
      (this.components.basic || 0) +
      (this.components.hra || 0) +
      (this.components.conveyanceAllowance || 0) +
      (this.components.medicalAllowance || 0) +
      (this.components.specialAllowance || 0) +
      (this.components.otherAllowances || 0);
  }
  next();
});

// ─── Static: resolve salary valid for a given date ────────────────────────────
/**
 * Find the salary structure that was valid on a specific date for an employee.
 *
 * @param {ObjectId|string} employeeId
 * @param {Date} onDate - The date the salary must be valid for (e.g., period end)
 * @returns {Promise<SalaryStructureDocument|null>}
 */
salaryStructureSchema.statics.findValidForDate = function (employeeId, onDate) {
  return this.findOne({
    employeeId,
    effectiveFrom: { $lte: onDate },
    $or: [
      { effectiveTo: null },
      { effectiveTo: { $gte: onDate } },
    ],
  }).sort({ effectiveFrom: -1 }); // most recent effective version if overlap
};

export default mongoose.model('SalaryStructure', salaryStructureSchema);
