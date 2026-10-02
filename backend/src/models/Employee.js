import mongoose from 'mongoose';
import { EMAIL_PATTERN } from '../utils/email.js';

/**
 * Employee Schema
 *
 * Represents an employee record managed by administrators.
 *
 * Security Standards:
 * - Input validation at schema level (mirrors validator rules)
 * - Indexed fields for fast queries (email, department, status)
 * - Timestamps for audit trail
 *
 * Retention (soft delete):
 * - Employees are never physically deleted by the application. "Delete" marks
 *   the record archived (isDeleted/deletedAt/deletedBy/deletionReason) so
 *   payroll history, statutory filings and audit references stay resolvable
 *   for the legally required retention period.
 * - Every find/count/update query excludes archived records by default.
 *   A query that explicitly filters on `isDeleted` is respected as written,
 *   which is how archive views and restore operations reach archived rows.
 *
 * Tenancy:
 * - createdBy is the owning company. Email is unique per company, not
 *   globally, so two companies can each employ the same person.
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
      lowercase: true,
      trim: true,
      match: [EMAIL_PATTERN, 'Invalid email format'],
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
    // Legacy display field kept in sync with the current SalaryStructure gross.
    // NOT authoritative for payroll.
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
    // Optional company-assigned identifier (e.g. EMP-2026-001). Unique within a
    // company when present; employees without a code never collide.
    employeeCode: {
      type: String,
      trim: true,
      maxlength: [30, 'Employee code cannot exceed 30 characters'],
    },

    // ─── Retention / soft delete ──────────────────────────────────────────
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },
    deletionReason: {
      type: String,
      trim: true,
      maxlength: [500, 'Archive reason cannot exceed 500 characters'],
      default: null,
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
employeeSchema.index({ createdBy: 1, email: 1 }, { unique: true, name: 'unique_company_employee_email' });
employeeSchema.index(
  { createdBy: 1, employeeCode: 1 },
  {
    unique: true,
    name: 'unique_company_employee_code',
    partialFilterExpression: { employeeCode: { $type: 'string' } },
  }
);
employeeSchema.index({ createdBy: 1, isDeleted: 1, status: 1 });
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

// ─── Default exclusion of archived employees ─────────────────────────────────
employeeSchema.pre(
  ['find', 'findOne', 'countDocuments', 'findOneAndUpdate', 'updateOne', 'updateMany', 'distinct'],
  function excludeArchived(next) {
    const filter = this.getFilter();
    if (!Object.prototype.hasOwnProperty.call(filter, 'isDeleted')) {
      this.where({ isDeleted: { $ne: true } });
    }
    next();
  }
);

/**
 * Filter value that matches archived, active and legacy (field missing) rows.
 * A factory, not a shared constant: Mongoose casts query filters in place, so
 * a frozen object throws and a shared mutable one would leak between queries.
 */
export const anyArchiveState = () => ({ $in: [true, false, null] });

export default mongoose.model('Employee', employeeSchema);
