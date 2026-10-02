import mongoose from 'mongoose';
import { forbidQueryMutations, restrictDocumentChanges } from './guards.js';
import {
  DEPARTMENTS,
  EMPLOYMENT_CHANGE_TYPES,
  EMPLOYMENT_TYPES,
  PROBATION_STATUSES,
  LIFECYCLE_STATUSES,
  EXIT_REASONS,
} from '../utils/workforce.js';

/**
 * EmploymentRecord — effective-dated employment history of one employee.
 *
 * Each document is ONE version of the employee's employment terms:
 * department, designation, manager, work location, employment type,
 * probation and lifecycle (active / exited). It is valid from effectiveFrom
 * until effectiveTo (null = current). A change closes the current version
 * and appends a new one, so "what was true on date D" has exactly one answer.
 *
 * Invariants (enforced here, not only in services):
 *   - at most one current version per employee (partial unique index)
 *   - closed versions are immutable; the current version may only be closed
 *   - no query updates or deletes
 *
 * The one sanctioned in-place edit: while the JOINING version is the only
 * version, corrections of department, position or hire date on the employee
 * record fix it in place (`$locals.allowJoiningCorrection`, audited by the
 * caller). Once any later version exists, joining terms are frozen.
 *
 * Employee.department / position / status remain a projection of the current
 * version, so existing screens and payroll snapshots keep working unchanged.
 */

const historyImmutable = () =>
  Object.assign(new Error('Employment history is append-only: recorded versions cannot be changed or deleted.'), {
    statusCode: 409,
    code: 'EMPLOYMENT_HISTORY_IMMUTABLE',
  });

const employmentRecordSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },

    // ─── Valid-time interval ───────────────────────────────────────────────
    effectiveFrom: { type: Date, required: true },
    effectiveTo: { type: Date, default: null },
    isCurrent: { type: Boolean, default: true },

    // ─── What changed and why ──────────────────────────────────────────────
    changeType: { type: String, enum: EMPLOYMENT_CHANGE_TYPES, required: true },
    reason: { type: String, trim: true, maxlength: 500, default: null },

    // ─── Employment terms in this version ─────────────────────────────────
    department: { type: String, enum: DEPARTMENTS, required: true },
    designation: { type: String, trim: true, required: true, minlength: 2, maxlength: 100 },
    managerEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    workLocation: {
      name: { type: String, trim: true, maxlength: 100, default: null },
      state: { type: String, trim: true, uppercase: true, maxlength: 20, default: null },
    },
    employmentType: { type: String, enum: EMPLOYMENT_TYPES, default: 'FULL_TIME' },
    probationStatus: { type: String, enum: PROBATION_STATUSES, default: 'NOT_APPLICABLE' },
    confirmationDate: { type: Date, default: null },
    lifecycleStatus: { type: String, enum: LIFECYCLE_STATUSES, default: 'ACTIVE' },
    exit: {
      lastWorkingDay: { type: Date, default: null },
      reason: { type: String, enum: EXIT_REASONS, default: undefined },
    },

    // ─── Who recorded it ───────────────────────────────────────────────────
    recordedBy: { type: mongoose.Schema.Types.ObjectId, required: true },
    recordedByEmail: { type: String, trim: true, lowercase: true, default: null },
  },
  { timestamps: true }
);

employmentRecordSchema.index({ employeeId: 1, effectiveFrom: -1 });
employmentRecordSchema.index({ companyId: 1, lifecycleStatus: 1, isCurrent: 1 });
employmentRecordSchema.index(
  { employeeId: 1 },
  { unique: true, partialFilterExpression: { isCurrent: true }, name: 'unique_current_employment_per_employee' }
);

employmentRecordSchema.pre('validate', function deriveCurrent(next) {
  this.isCurrent = this.effectiveTo == null;
  if (this.effectiveTo && this.effectiveTo < this.effectiveFrom) {
    return next(Object.assign(new Error('An employment version cannot end before it starts.'), { statusCode: 422 }));
  }
  return next();
});

restrictDocumentChanges(employmentRecordSchema, {
  allowedPaths: (doc) => (doc.$locals.allowJoiningCorrection
    ? ['effectiveTo', 'isCurrent', 'effectiveFrom', 'department', 'designation']
    : ['effectiveTo', 'isCurrent']),
  canChange: (persisted, doc) =>
    persisted.isCurrent === true && (!doc.$locals.allowJoiningCorrection || persisted.changeType === 'JOINING'),
  makeError: historyImmutable,
});
forbidQueryMutations(employmentRecordSchema, historyImmutable);

/** Version valid on `onDate` for one employee. */
employmentRecordSchema.statics.findValidForDate = function findValidForDate(employeeId, onDate) {
  return this.findOne({
    employeeId,
    effectiveFrom: { $lte: onDate },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: onDate } }],
  }).sort({ effectiveFrom: -1 });
};

export default mongoose.model('EmploymentRecord', employmentRecordSchema);
