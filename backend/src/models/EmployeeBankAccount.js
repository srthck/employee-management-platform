import mongoose from 'mongoose';
import { forbidQueryMutations, restrictDocumentChanges } from './guards.js';
import { encryptedValueSchema, stripSecrets } from './encryptedValue.js';
import { IDENTIFIERS } from '../utils/indianIdentifiers.js';
import { BANK_ACCOUNT_TYPES } from '../utils/workforce.js';

/**
 * EmployeeBankAccount — versioned salary bank account of one employee.
 *
 * Adding an account closes the current one (isCurrent=false, supersededAt)
 * and appends a new version, so where salary was sent on any date stays
 * answerable. The account number is AES-256-GCM ciphertext bound to
 * "<companyId>:<employeeId>:bank.accountNumber" with its last four digits for
 * display, plus a company-scoped blind index that detects one account shared
 * by several employees (a classic payroll-fraud signal) without decrypting.
 *
 * Kept outside the Employee document so it is never frozen into payroll
 * snapshots or returned by ordinary employee APIs.
 */

const historyImmutable = () =>
  Object.assign(new Error('Bank account history is append-only.'), {
    statusCode: 409,
    code: 'BANK_ACCOUNT_HISTORY_IMMUTABLE',
  });

const bankAccountSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    version: { type: Number, required: true, min: 1 },
    isCurrent: { type: Boolean, default: true },
    supersededAt: { type: Date, default: null },
    effectiveFrom: { type: Date, required: true },

    accountHolderName: { type: String, trim: true, required: true, minlength: 2, maxlength: 100 },
    bankName: { type: String, trim: true, maxlength: 100, default: null },
    ifsc: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      match: [IDENTIFIERS.ifsc.pattern, `IFSC must be ${IDENTIFIERS.ifsc.format}.`],
    },
    accountType: { type: String, enum: BANK_ACCOUNT_TYPES, default: 'SAVINGS' },
    accountNumber: { type: encryptedValueSchema, required: true },
    accountNumberBlindIndex: { type: String, required: true },

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

bankAccountSchema.index({ employeeId: 1, version: 1 }, { unique: true });
bankAccountSchema.index(
  { employeeId: 1 },
  { unique: true, partialFilterExpression: { isCurrent: true }, name: 'unique_current_bank_account' }
);
bankAccountSchema.index({ companyId: 1, accountNumberBlindIndex: 1, isCurrent: 1 });

restrictDocumentChanges(bankAccountSchema, {
  allowedPaths: () => ['isCurrent', 'supersededAt'],
  canChange: (persisted) => persisted.isCurrent === true,
  makeError: historyImmutable,
});
forbidQueryMutations(bankAccountSchema, historyImmutable);

export default mongoose.model('EmployeeBankAccount', bankAccountSchema);
