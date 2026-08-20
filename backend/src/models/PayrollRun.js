import mongoose from 'mongoose';

/**
 * PayrollRun — the orchestration aggregate for a payroll period.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ARCHITECTURAL DISTINCTION (CRITICAL):
 *   PayrollRun   = orchestration entity   (this model)
 *   PayrollSnapshot = immutable employee-level payroll record (Phase 9)
 *
 * PayrollRun NEVER stores per-employee salary calculations.
 * It stores orchestration metadata: period, status, counts, errors.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * STATE MACHINE:
 *
 *   DRAFT
 *     ↓  (process request)
 *   PROCESSING
 *     ↓  (all employees processed successfully)    ↓  (failure)
 *   FINALIZED                                     FAILED
 *     ↓  (future disbursement phase)                ↓  (retry)
 *   DISBURSED                                    PROCESSING
 *                                                  (CANCELLED is a terminal
 *                                                   state from FAILED only)
 *
 * ALLOWED TRANSITIONS:
 *   DRAFT        → PROCESSING
 *   PROCESSING   → FINALIZED
 *   PROCESSING   → FAILED
 *   FAILED       → PROCESSING  (retry)
 *   FAILED       → CANCELLED
 *   FINALIZED    → DISBURSED   (future phase)
 *
 * DISALLOWED:
 *   FINALIZED    → anything except DISBURSED
 *   DISBURSED    → anything
 *   CANCELLED    → anything
 *
 * STATE TRANSITIONS ARE SERVICE-CONTROLLED. No client payload sets status directly.
 *
 * IDEMPOTENCY:
 *   A company can have at most ONE active (non-CANCELLED) PayrollRun per
 *   periodYear + periodMonth. The unique compound index enforces this.
 *   A failed run is retried (same _id), not replaced with a new document.
 *
 * PERIOD SEMANTICS:
 *   Payroll Period = calendar month.
 *   periodMonth: 1–12 (1 = January)
 *   periodYear:  e.g. 2026
 *   periodStart: first day of month at 00:00:00 UTC
 *   periodEnd:   last day of month at 23:59:59.999 UTC
 *   Salary validity is checked against periodEnd (the "as of" date).
 *   Compliance rules are resolved against periodEnd.
 *
 * COMPANY IDENTITY:
 *   companyId currently maps to the creating Admin's _id (single-tenant MVP).
 *   In a multi-tenant future, this is the Company entity _id.
 */

// ─── State transition audit sub-document ────────────────────────────────────
const transitionSchema = new mongoose.Schema(
  {
    fromStatus: { type: String, required: true },
    toStatus:   { type: String, required: true },
    actorId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
    actorEmail: { type: String },
    reason:     { type: String, trim: true },
    timestamp:  { type: Date, default: () => new Date() },
  },
  { _id: false }
);

// ─── Main schema ─────────────────────────────────────────────────────────────
const payrollRunSchema = new mongoose.Schema(
  {
    // ─── Company identity ───────────────────────────────────────────────
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      required: [true, 'Company ID is required'],
      index: true,
    },

    // ─── Payroll period ─────────────────────────────────────────────────
    periodMonth: {
      type: Number,
      required: [true, 'Period month is required'],
      min: [1, 'Period month must be between 1 and 12'],
      max: [12, 'Period month must be between 1 and 12'],
    },
    periodYear: {
      type: Number,
      required: [true, 'Period year is required'],
      min: [2000, 'Period year must be 2000 or later'],
      max: [2100, 'Period year must be 2100 or earlier'],
    },
    periodStart: {
      type: Date,
      required: [true, 'Period start date is required'],
    },
    periodEnd: {
      type: Date,
      required: [true, 'Period end date is required'],
    },

    // ─── State machine ──────────────────────────────────────────────────
    status: {
      type: String,
      required: true,
      enum: {
        values: ['DRAFT', 'PROCESSING', 'FINALIZED', 'DISBURSED', 'FAILED', 'CANCELLED'],
        message: '{VALUE} is not a valid payroll run status.',
      },
      default: 'DRAFT',
    },

    // ─── Processing metrics ─────────────────────────────────────────────
    employeeCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    processedEmployeeCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    successfulEmployeeCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    failedEmployeeCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ─── Lifecycle timestamps ────────────────────────────────────────────
    startedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    finalizedAt: {
      type: Date,
      default: null,
    },
    disbursedAt: {
      type: Date,
      default: null,
    },

    // ─── Responsible actors ──────────────────────────────────────────────
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      required: [true, 'Created by is required'],
    },
    finalizedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },
    disbursedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },

    // ─── Failure metadata ────────────────────────────────────────────────
    failureReason: {
      type: String,
      trim: true,
      default: null,
    },
    failedAt: {
      type: Date,
      default: null,
    },

    // ─── Idempotency ─────────────────────────────────────────────────────
    // Client-supplied idempotency key for process/create requests.
    // If a request with the same key arrives while the run is PROCESSING
    // or already FINALIZED, the current run is returned instead of re-processing.
    idempotencyKey: {
      type: String,
      trim: true,
      default: null,
      index: true,
    },

    // ─── Processing version / audit ──────────────────────────────────────
    // Incremented each time processing is (re)started.
    // Allows detection of stale references.
    processingVersion: {
      type: Number,
      default: 0,
    },

    // ─── Explainability metadata ─────────────────────────────────────────
    // Set during preflight and processing. Not employee-level detail (Phase 9).
    preflightResult: {
      canProcess: { type: Boolean, default: null },
      eligibleEmployeeCount: { type: Number, default: null },
      blockedEmployeeCount: { type: Number, default: null },
      blockingErrors: { type: [String], default: [] },
      warnings: { type: [String], default: [] },
      resolvedAt: { type: Date, default: null },
    },

    // ─── Compliance rules resolved ───────────────────────────────────────
    // Stored so the run can report which rule versions were active.
    resolvedRuleVersionIds: {
      epf: { type: mongoose.Schema.Types.ObjectId, ref: 'ComplianceRuleVersion', default: null },
      esi: { type: mongoose.Schema.Types.ObjectId, ref: 'ComplianceRuleVersion', default: null },
      pt:  { type: mongoose.Schema.Types.ObjectId, ref: 'ComplianceRuleVersion', default: null },
    },

    // ─── TDS deferral flag ────────────────────────────────────────────────
    // Explicitly records that TDS was deferred in this run.
    tdsDeferred: {
      type: Boolean,
      default: true, // Always true in Phase 8
    },

    // ─── State transition audit trail ────────────────────────────────────
    transitions: {
      type: [transitionSchema],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────
// CRITICAL: One active payroll run per company per period.
// "Active" = not CANCELLED. We cannot unique-index a conditional, so we use
// the unique compound index and enforce the CANCELLED carve-out in the service layer.
payrollRunSchema.index(
  { companyId: 1, periodYear: 1, periodMonth: 1 },
  {
    unique: true,
    name: 'unique_company_period',
    // Note: This prevents any second run for same company+period.
    // The service allows CANCELLED runs by treating them as tombstones and
    // allowing a fresh run only if the existing one is CANCELLED.
  }
);
payrollRunSchema.index({ companyId: 1, status: 1 });
payrollRunSchema.index({ createdAt: -1 });
payrollRunSchema.index({ idempotencyKey: 1 }, { sparse: true });

// ─── Allowed state transitions map ───────────────────────────────────────────
export const PAYROLL_STATUS = Object.freeze({
  DRAFT:      'DRAFT',
  PROCESSING: 'PROCESSING',
  FINALIZED:  'FINALIZED',
  DISBURSED:  'DISBURSED',
  FAILED:     'FAILED',
  CANCELLED:  'CANCELLED',
});

export const ALLOWED_TRANSITIONS = Object.freeze({
  DRAFT:      ['PROCESSING'],
  PROCESSING: ['FINALIZED', 'FAILED'],
  FAILED:     ['PROCESSING', 'CANCELLED'],
  FINALIZED:  ['DISBURSED'],
  DISBURSED:  [],
  CANCELLED:  [],
});

/**
 * canTransition — pure function; used by service and tests.
 *
 * @param {string} from - current status
 * @param {string} to   - desired status
 * @returns {boolean}
 */
export function canTransition(from, to) {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

export default mongoose.model('PayrollRun', payrollRunSchema);
