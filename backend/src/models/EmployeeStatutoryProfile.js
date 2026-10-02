import mongoose from 'mongoose';
import { forbidQueryMutations, restrictDocumentChanges } from './guards.js';
import { encryptedValueSchema, stripSecrets } from './encryptedValue.js';

/**
 * EmployeeStatutoryProfile — versioned statutory identifiers of one employee.
 *
 * Kept OUT of the Employee document on purpose: payroll staging freezes the
 * whole Employee record into history, and statutory numbers must never be
 * copied into payroll snapshots, exports or ordinary employee APIs.
 *
 * Every identifier is stored as AES-256-GCM ciphertext bound to
 * "<companyId>:<employeeId>:statutory.<field>" plus its last four characters.
 * PAN also carries a company-scoped blind index, so the same PAN cannot be
 * registered to two current employees of one company (enforced by index).
 *
 * Versioning: an update closes the current version (isCurrent=false,
 * supersededAt) and appends version + 1. Earlier versions are immutable.
 */

const historyImmutable = () =>
  Object.assign(new Error('Statutory profile history is append-only.'), {
    statusCode: 409,
    code: 'STATUTORY_HISTORY_IMMUTABLE',
  });

const statutoryProfileSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    version: { type: Number, required: true, min: 1 },
    isCurrent: { type: Boolean, default: true },
    supersededAt: { type: Date, default: null },

    pan: { type: encryptedValueSchema, default: null },
    panBlindIndex: { type: String, default: null },
    uan: { type: encryptedValueSchema, default: null },
    esicNumber: { type: encryptedValueSchema, default: null },
    pfMemberId: { type: encryptedValueSchema, default: null },

    reason: { type: String, trim: true, maxlength: 300, default: null },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, required: true },
    recordedByEmail: { type: String, trim: true, lowercase: true, default: null },
  },
  {
    timestamps: true,
    toJSON: { transform: stripSecrets },
    toObject: { transform: stripSecrets },
  }
);

statutoryProfileSchema.index({ employeeId: 1, version: 1 }, { unique: true });
statutoryProfileSchema.index(
  { employeeId: 1 },
  { unique: true, partialFilterExpression: { isCurrent: true }, name: 'unique_current_statutory_profile' }
);
statutoryProfileSchema.index(
  { companyId: 1, panBlindIndex: 1 },
  {
    unique: true,
    partialFilterExpression: { isCurrent: true, panBlindIndex: { $type: 'string' } },
    name: 'unique_current_pan_per_company',
  }
);

restrictDocumentChanges(statutoryProfileSchema, {
  allowedPaths: () => ['isCurrent', 'supersededAt'],
  canChange: (persisted) => persisted.isCurrent === true,
  makeError: historyImmutable,
});
forbidQueryMutations(statutoryProfileSchema, historyImmutable);

export default mongoose.model('EmployeeStatutoryProfile', statutoryProfileSchema);
