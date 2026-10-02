import mongoose from 'mongoose';

/**
 * Component-level payroll records shared by staging results and snapshots.
 *
 * These fields are ADDITIVE and carry no defaults (arrays use
 * `default: undefined`). A payroll record written before Wave 3.5 therefore
 * materialises exactly as it was written, so its canonical payload — and its
 * SHA-256 hash — are unchanged and still verify.
 */

/** One named money line: a voluntary deduction or an employer contribution. */
export const payrollLineSchema = new mongoose.Schema(
  {
    componentCode: { type: String, required: true },
    name: { type: String, required: true },
    amount: { type: Number, required: true },
    explanation: { type: String },
  },
  { _id: false }
);

const compensationLineSchema = new mongoose.Schema(
  {
    componentCode: { type: String, required: true },
    name: { type: String, required: true },
    type: { type: String, required: true },
    payrollApplication: { type: String, required: true },
    amountMonthly: { type: Number, required: true },
    amountEarned: { type: Number, required: true },
    explanation: { type: String },
  },
  { _id: false }
);

/**
 * The compensation version this payroll result was calculated from, frozen
 * with both the monthly amount and the amount earned in this period. It is what
 * lets a payslip explain each earning line without reading current data.
 */
export const compensationSnapshotSchema = new mongoose.Schema(
  {
    compensationVersionId: { type: mongoose.Schema.Types.ObjectId, required: true },
    version: { type: Number, required: true },
    effectiveFrom: { type: Date },
    payBasis: { type: String, default: 'MONTHLY' },
    lines: { type: [compensationLineSchema], default: undefined },
  },
  { _id: false }
);
