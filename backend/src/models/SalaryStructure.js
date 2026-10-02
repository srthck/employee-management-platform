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
 * Database-level invariant — at most ONE open-ended version per employee:
 *   isCurrent mirrors (effectiveTo === null) and is maintained by hooks on
 *   save and on query updates. A partial unique index on
 *   { employeeId } where isCurrent = true makes a second open version
 *   impossible, even under concurrent revisions.
 *
 * PT jurisdiction:
 *   workState has NO default. A missing workState blocks the employee in
 *   payroll preflight (MISSING_PT_JURISDICTION) instead of silently applying
 *   one state's professional tax to everyone.
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

    // ─── Valid-time interval ────────────────────────────────────────────────
    effectiveFrom: {
      type: Date,
      required: [true, 'Effective from date is required'],
    },

    effectiveTo: {
      type: Date,
      default: null,
    },

    // Derived: true while effectiveTo is null. Backs the unique index below.
    isCurrent: {
      type: Boolean,
      default: true,
    },

    // ─── Salary components ──────────────────────────────────────────────────
    components: {
      type: salaryComponentSchema,
      required: [true, 'Salary components are required'],
    },

    // ─── Derived gross ──────────────────────────────────────────────────────
    // Stored for fast querying and consistency.
    // Automatically calculated from salary components.
    grossMonthly: {
      type: Number,
      required: [true, 'Gross monthly salary is required'],
      min: [0, 'Gross salary cannot be negative'],
    },

    // ─── Currency and pay frequency ─────────────────────────────────────────
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

    // ─── Work state / jurisdiction for PT resolution ────────────────────────
    // Intentionally no default: see "PT jurisdiction" above.
    workState: {
      type: String,
      trim: true,
      uppercase: true,
      default: null,
    },

    // ─── Statutory flags ────────────────────────────────────────────────────
    pfEnrolled: {
      type: Boolean,
      default: true,
    },

    esiEnrolled: {
      type: Boolean,
      default: true,
    },

    ptEnrolled: {
      type: Boolean,
      default: true,
    },

    // ─── PF-specific metadata ───────────────────────────────────────────────
    pfWageOverride: {
      type: Number,
      default: null,
      min: [0, 'PF wage override cannot be negative'],
    },

    // ─── Metadata ───────────────────────────────────────────────────────────
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

salaryStructureSchema.index({
  employeeId: 1,
  effectiveFrom: 1,
});

salaryStructureSchema.index({
  employeeId: 1,
  effectiveTo: 1,
});

salaryStructureSchema.index({
  employeeId: 1,
  effectiveTo: 1,
  effectiveFrom: -1,
});

salaryStructureSchema.index(
  { employeeId: 1 },
  {
    unique: true,
    partialFilterExpression: { isCurrent: true },
    name: 'unique_current_salary_per_employee',
  }
);

// ─── Gross salary calculation helper ─────────────────────────────────────────

function calculateGrossMonthly(components) {
  if (!components) {
    return 0;
  }

  return (
    (components.basic || 0) +
    (components.hra || 0) +
    (components.conveyanceAllowance || 0) +
    (components.medicalAllowance || 0) +
    (components.specialAllowance || 0) +
    (components.otherAllowances || 0)
  );
}

// ─── Pre-validation: compute grossMonthly and isCurrent ──────────────────────
//
// This keeps validation behavior intact and ensures derived fields are
// calculated before Mongoose validation runs.

salaryStructureSchema.pre('validate', function (next) {
  if (this.components) {
    this.grossMonthly = calculateGrossMonthly(this.components);
  }
  this.isCurrent = this.effectiveTo == null;

  next();
});

// ─── Pre-save: compute grossMonthly ──────────────────────────────────────────
//
// Phase 3 requires grossMonthly to be computed through a save hook as well.
// This also protects the stored value whenever a SalaryStructure document
// is created or saved.

salaryStructureSchema.pre('save', function (next) {
  if (this.components) {
    this.grossMonthly = calculateGrossMonthly(this.components);
  }
  this.isCurrent = this.effectiveTo == null;

  next();
});

// ─── Query updates: keep isCurrent in step with effectiveTo ──────────────────

salaryStructureSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function (next) {
  const update = this.getUpdate() || {};
  const set = update.$set || {};
  if (Object.prototype.hasOwnProperty.call(set, 'effectiveTo')) {
    this.set({ isCurrent: set.effectiveTo == null });
  } else if (Object.prototype.hasOwnProperty.call(update, 'effectiveTo')) {
    this.set({ isCurrent: update.effectiveTo == null });
  }
  next();
});

// ─── Static: resolve salary valid for a given date ────────────────────────────

/**
 * Find the salary structure that was valid on a specific date for an employee.
 *
 * @param {ObjectId|string} employeeId
 * @param {Date} onDate
 * @returns {Promise<SalaryStructureDocument|null>}
 */
salaryStructureSchema.statics.findValidForDate = function (
  employeeId,
  onDate
) {
  return this.findOne({
    employeeId,

    effectiveFrom: {
      $lte: onDate,
    },

    $or: [
      {
        effectiveTo: null,
      },
      {
        effectiveTo: {
          $gte: onDate,
        },
      },
    ],
  }).sort({
    effectiveFrom: -1,
  });
};

export default mongoose.model(
  'SalaryStructure',
  salaryStructureSchema
);
