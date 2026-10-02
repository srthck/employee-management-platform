import mongoose from 'mongoose';
import { forbidQueryMutations, restrictDocumentChanges } from './guards.js';
import { DOCUMENT_TYPES, DOCUMENT_STATUSES } from '../utils/workforce.js';

/**
 * EmployeeDocument — a structured record of an employee document.
 *
 * Records what the document is, its validity dates, an optional SHA-256
 * fingerprint of the file, and its verification outcome. The file itself is
 * not stored by PayGuard yet; the fingerprint lets a later upload be matched
 * to the record that was verified.
 *
 * Workflow: SUBMITTED → VERIFIED | REJECTED, decided once by someone other
 * than the submitter (segregation of duties). A decided record is immutable;
 * a corrected document is submitted as a new record.
 */

const decisionFinal = () =>
  Object.assign(new Error('A verified or rejected document record cannot be changed. Submit a new record.'), {
    statusCode: 409,
    code: 'DOCUMENT_DECISION_FINAL',
  });

const employeeDocumentSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },

    documentType: { type: String, enum: DOCUMENT_TYPES, required: true },
    title: { type: String, trim: true, required: true, minlength: 2, maxlength: 120 },
    issuedOn: { type: Date, default: null },
    expiresOn: { type: Date, default: null },
    fileSha256: { type: String, lowercase: true, match: [/^[a-f0-9]{64}$/, 'fileSha256 must be a SHA-256 hex digest.'], default: null },
    notes: { type: String, trim: true, maxlength: 300, default: null },

    status: { type: String, enum: DOCUMENT_STATUSES, default: 'SUBMITTED' },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, required: true },
    submittedByEmail: { type: String, trim: true, lowercase: true, default: null },
    decision: {
      type: new mongoose.Schema(
        {
          by: { type: mongoose.Schema.Types.ObjectId, required: true },
          byEmail: { type: String, trim: true, lowercase: true, default: null },
          at: { type: Date, required: true },
          note: { type: String, trim: true, maxlength: 300, default: null },
        },
        { _id: false }
      ),
      default: null,
    },
  },
  { timestamps: true }
);

employeeDocumentSchema.index({ employeeId: 1, createdAt: -1 });
employeeDocumentSchema.index({ companyId: 1, status: 1 });

employeeDocumentSchema.pre('validate', function checkDates(next) {
  if (this.issuedOn && this.expiresOn && this.expiresOn < this.issuedOn) {
    return next(Object.assign(new Error('A document cannot expire before it is issued.'), { statusCode: 422 }));
  }
  return next();
});

restrictDocumentChanges(employeeDocumentSchema, {
  allowedPaths: () => ['status', 'decision'],
  canChange: (persisted) => persisted.status === 'SUBMITTED',
  makeError: decisionFinal,
});
forbidQueryMutations(employeeDocumentSchema, decisionFinal);

export default mongoose.model('EmployeeDocument', employeeDocumentSchema);
