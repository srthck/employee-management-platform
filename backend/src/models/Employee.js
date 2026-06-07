import mongoose from 'mongoose';

/**
 * Employee Schema
 *
 * Represents an employee record managed by administrators.
 *
 * Security Standards:
 * - Input validation at schema level (mirrors validator rules)
 * - Indexed fields for fast queries (email, department, status)
 * - Timestamps for audit trail
 * - Soft delete via isActive flag
 */

const employeeSchema = new mongoose.Schema(
  {
    // ─── Personal Information ──────────────────────────────────────────────
    firstName: {
      type: String,
      required: [true, 'First name is required'],
      trim: true,
      minlength: [2, 'First name must be at least 2 characters'],
      maxlength: [50, 'First name cannot exceed 50 characters'],
    },
    lastName: {
      type: String,
      required: [true, 'Last name is required'],
      trim: true,
      minlength: [2, 'Last name must be at least 2 characters'],
      maxlength: [50, 'Last name cannot exceed 50 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [
        /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/,
        'Invalid email format',
      ],
    },
    phone: {
      type: String,
      trim: true,
      match: [/^[\+]?[\d\s\-\(\)]{7,20}$/, 'Invalid phone number format'],
    },

    // ─── Employment Information ────────────────────────────────────────────
    department: {
      type: String,
      required: [true, 'Department is required'],
      trim: true,
      enum: {
        values: [
          'Engineering',
          'Marketing',
          'Sales',
          'Human Resources',
          'Finance',
          'Operations',
          'Design',
          'Legal',
          'Customer Support',
          'Other',
        ],
        message: '{VALUE} is not a valid department',
      },
    },
    position: {
      type: String,
      required: [true, 'Position is required'],
      trim: true,
      minlength: [2, 'Position must be at least 2 characters'],
      maxlength: [100, 'Position cannot exceed 100 characters'],
    },
    salary: {
      type: Number,
      required: [true, 'Salary is required'],
      min: [0, 'Salary cannot be negative'],
      max: [10000000, 'Salary exceeds maximum allowed value'],
    },
    hireDate: {
      type: Date,
      required: [true, 'Hire date is required'],
    },
    status: {
      type: String,
      enum: {
        values: ['active', 'inactive', 'on-leave'],
        message: '{VALUE} is not a valid status',
      },
      default: 'active',
    },

    // ─── Address (optional) ───────────────────────────────────────────────
    address: {
      street: { type: String, trim: true, maxlength: 100 },
      city: { type: String, trim: true, maxlength: 50 },
      state: { type: String, trim: true, maxlength: 50 },
      zipCode: { type: String, trim: true, maxlength: 20 },
      country: { type: String, trim: true, maxlength: 50 },
    },

    // ─── Metadata ─────────────────────────────────────────────────────────
    notes: {
      type: String,
      trim: true,
      maxlength: [500, 'Notes cannot exceed 500 characters'],
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      required: true,
    },
  },
  {
    timestamps: true,
    // Virtual for full name
    virtuals: {
      fullName: {
        get() {
          return `${this.firstName} ${this.lastName}`;
        },
      },
    },
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ─── Indexes ────────────────────────────────────────────────────────────────
employeeSchema.index({ email: 1 }, { unique: true });
employeeSchema.index({ department: 1 });
employeeSchema.index({ status: 1 });
employeeSchema.index({ createdAt: -1 });
// Text search index for name/position/department
employeeSchema.index({
  firstName: 'text',
  lastName: 'text',
  email: 'text',
  position: 'text',
  department: 'text',
});

export default mongoose.model('Employee', employeeSchema);
