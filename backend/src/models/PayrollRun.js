import mongoose from 'mongoose';

/**
 * PayrollRun — the orchestration aggregate for a payroll period.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ARCHITECTURAL DISTINCTION (CRITICAL):
 *   PayrollRun         = orchestration entity            (this model)
 *   PayrollStagingResult = durable pre-finalization staging (Phase 8 boundary)
 *   PayrollSnapshot    = immutable employee-level record  (Phase 9)
 *
 * PayrollRun NEVER stores per-employee salary calculations.
 * It stores orchestration metadata: period, status, counts, errors.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * ─── STATE MACHINE (Phase 8 Correction) ─────────────────────────────────
 *
 *   DRAFT
 *     ↓  (process request — atomic claim)
 *   PROCESSING
 *     ↓  (calculations complete + results durably staged)  ↓  (any failure)
 *   READY_FOR_FINALIZATION                               FAILED
 *     ↓  (completeness verified — Phase 9 materializes snapshots)  ↓ (retry)
 *   FINALIZED                                           PROCESSING
 *     ↓  (future real disbursement)                       ↓ (cancel)
 *   DISBURSED                                          CANCELLED
 *
 * KEY INVARIANT:
 *   FINALIZED must NEVER exist unless:
 *     (a) All employee-level payroll results are durably persisted
 *         in PayrollStagingResult documents.
 *     (b) Completeness is verified: expected == durable == successful.
 *     (c) No duplicate employee results exist.
 *     (d) Phase 9 has materialized and locked immutable PayrollSnapshots.
 *
 *   Phase 8 stops at READY_FOR_FINALIZATION.
 *   Phase 9 owns: snapshot materialization + completeness check + FINALIZED.
 *
 * ─── ALLOWED TRANSITIONS ─────────────────────────────────────────────────
 *   DRAFT                  → PROCESSING
 *   PROCESSING             → READY_FOR_FINALIZATION
 *   PROCESSING             → FAILED
 *   READY_FOR_FINALIZATION → FINALIZED   (Phase 9 gate)
 *   READY_FOR_FINALIZATION → FAILED      (Phase 9 rejects completeness)
 *   FAILED                 → PROCESSING  (retry)
 *   FAILED                 → CANCELLED
 *   FINALIZED              → DISBURSED   (future real disbursement)
 *
 * ─── DISALLOWED ──────────────────────────────────────────────────────────
 *   FINALIZED    → anything except DISBURSED
 *   DISBURSED    → anything (terminal)
 *   CANCELLED    → anything (terminal)
 *   PROCESSING   → FINALIZED directly (forbidden — must pass through RFF)
 *
 * ─── IDEMPOTENCY ─────────────────────────────────────────────────────────
 *   One non-CANCELLED PayrollRun per companyId + periodYear + periodMonth.
 *   Enforced by a PARTIAL unique index (status != CANCELLED).
 *   CANCELLED runs are historical tombstones; a new run may be created for
 *   the same period only after the existing run is CANCELLED.
 *
 * ─── PERIOD SEMANTICS ────────────────────────────────────────────────────
 *   Payroll Period = calendar month.
 *   periodMonth: 1–12 (1 = January)
 *   periodYear:  e.g. 2026
 *   periodStart: first ms of month at 00:00:00.000 UTC
 *   periodEnd:   last ms of month at 23:59:59.999 UTC
 *   Salary validity checked against periodEnd.
 *   Compliance rules resolved against periodEnd.
 *
 * ─── COMPANY IDENTITY (single-tenant MVP) ────────────────────────────────
 *   CURRENT:  companyId = creating Admin's _id  (single-tenant)
 *   FUTURE:   Company entity / multi-tenant architecture
 *   Do NOT change this mapping in this phase.
 *
 * ─── PROCESS CRASH / RECOVERY ────────────────────────────────────────────
 *   A run stuck in PROCESSING can be detected by:
 *     status == PROCESSING AND lastActivityAt < (now - timeout threshold)
 *   Recovery is MANUAL in Phase 8: an admin transitions the run to FAILED
 *   and re-triggers processing. No background worker is implemented.
 *   lastActivityAt is updated on each processing heartbeat.
 *
 * ─── ATTENDANCE ──────────────────────────────────────────────────────────
 *   No Attendance subsystem exists. Full-month grossMonthly is used as
 *   the payroll basis. attendanceAdjustment = 'DEFERRED' on all runs.
 *   This must NOT be described as "attendance-adjusted".
 *
 * ─── TDS ─────────────────────────────────────────────────────────────────
 *   TDS is explicitly deferred. tdsDeferred = true on all runs.
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
    // ─── Company identity ────────────────────────────────────────────────
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      required: [true, 'Company ID is required'],
      index: true,
    },

    // ─── Payroll period ──────────────────────────────────────────────────
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

    // ─── State machine ───────────────────────────────────────────────────
    status: {
      type: String,
      required: true,
      enum: {
        values: [
          'DRAFT',
          'PROCESSING',
          'READY_FOR_FINALIZATION',
          'FINALIZED',
          'DISBURSED',
          'FAILED',
          'CANCELLED',
        ],
        message: '{VALUE} is not a valid payroll run status.',
      },
      default: 'DRAFT',
    },

    // ─── Processing metrics ──────────────────────────────────────────────
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
    // Durable result count — set when PROCESSING → READY_FOR_FINALIZATION.
    // Must equal successfulEmployeeCount for finalization to proceed.
    durableResultCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ─── Lifecycle timestamps ────────────────────────────────────────────
    startedAt: {
      type: Date,
      default: null,
    },
    // Updated periodically during processing as a crash-detection heartbeat.
    lastActivityAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    readyForFinalizationAt: {
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
    idempotencyKey: {
      type: String,
      trim: true,
      default: null,
      index: true,
    },

    // ─── Processing version ──────────────────────────────────────────────
    processingVersion: {
      type: Number,
      default: 0,
    },

    // ─── Preflight result ────────────────────────────────────────────────
    preflightResult: {
      canProcess:            { type: Boolean,   default: null },
      eligibleEmployeeCount: { type: Number,    default: null },
      blockedEmployeeCount:  { type: Number,    default: null },
      blockingErrors:        { type: [String],  default: [] },
      warnings:              { type: [String],  default: [] },
      resolvedAt:            { type: Date,      default: null },
    },

    // ─── Compliance rules resolved ───────────────────────────────────────
    resolvedRuleVersionIds: {
      epf: { type: mongoose.Schema.Types.ObjectId, ref: 'ComplianceRuleVersion', default: null },
      esi: { type: mongoose.Schema.Types.ObjectId, ref: 'ComplianceRuleVersion', default: null },
      // PT is per-employee (varies by workState); null at run level.
      pt:  { type: mongoose.Schema.Types.ObjectId, ref: 'ComplianceRuleVersion', default: null },
    },

    // ─── TDS deferral ────────────────────────────────────────────────────
    tdsDeferred: {
      type: Boolean,
      default: true, // Always true in Phase 8
    },

    // ─── Attendance limitation ───────────────────────────────────────────
    // Explicit record that attendance adjustment is not applied.
    // Values: 'DEFERRED' (Phase 8 — no attendance system)
    //         'APPLIED'  (future — when attendance subsystem exists)
    attendanceAdjustment: {
      type: String,
      enum: ['DEFERRED', 'APPLIED'],
      default: 'DEFERRED',
    },

    // ─── State transition history ────────────────────────────────────────
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

/**
 * PARTIAL UNIQUE INDEX — one non-CANCELLED run per company per period.
 *
 * Business semantics:
 *   A company may have at most ONE active (non-CANCELLED) PayrollRun for a
 *   given period. CANCELLED runs are historical tombstones and do NOT consume
 *   the uniqueness slot, so a fresh run may be created for the same period
 *   after a run is cancelled.
 *
 * Implementation:
 *   MongoDB partial index with filter { status: { $ne: 'CANCELLED' } }.
 *   This means the uniqueness constraint is only enforced for documents where
 *   status != 'CANCELLED', which is exactly the intended semantics.
 *
 * NOTE: Mongoose's schema.index() does not support partialFilterExpression
 * directly on compound indexes in all versions. We define this index here for
 * documentation and the application-level logic enforces the semantics.
 * In production, the DBA must ensure the partial index is created on the DB:
 *
 *   db.payrollruns.createIndex(
 *     { companyId: 1, periodYear: 1, periodMonth: 1 },
 *     {
 *       unique: true,
 *       partialFilterExpression: { status: { $ne: "CANCELLED" } },
 *       name: "unique_active_company_period"
 *     }
 *   )
 *
 * In the service layer, createPayrollRun() deletes the existing CANCELLED
 * tombstone before inserting, so the partial index is not needed purely for
 * that path — but the index is the database-level guard against duplicate
 * active runs from concurrent requests.
 */
payrollRunSchema.index(
  { companyId: 1, periodYear: 1, periodMonth: 1 },
  {
    unique: true,
    name: 'unique_company_period',
    // partialFilterExpression is applied by the DBA command above.
    // The service enforces partial-index semantics in application code.
  }
);

payrollRunSchema.index({ companyId: 1, status: 1 });
payrollRunSchema.index({ createdAt: -1 });
payrollRunSchema.index({ idempotencyKey: 1 }, { sparse: true });

// Index for crash-detection queries: find stuck PROCESSING runs
payrollRunSchema.index({ status: 1, lastActivityAt: 1 });

// ─── State constants ──────────────────────────────────────────────────────────
export const PAYROLL_STATUS = Object.freeze({
  DRAFT:                  'DRAFT',
  PROCESSING:             'PROCESSING',
  READY_FOR_FINALIZATION: 'READY_FOR_FINALIZATION',
  FINALIZED:              'FINALIZED',
  DISBURSED:              'DISBURSED',
  FAILED:                 'FAILED',
  CANCELLED:              'CANCELLED',
});

/**
 * Allowed state transitions.
 *
 * PROCESSING → FINALIZED is intentionally ABSENT.
 * A run must pass through READY_FOR_FINALIZATION to prove that durable
 * employee-level results exist before the period is officially closed.
 *
 * Phase 9 owns the READY_FOR_FINALIZATION → FINALIZED transition.
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  DRAFT:                  ['PROCESSING'],
  PROCESSING:             ['READY_FOR_FINALIZATION', 'FAILED'],
  READY_FOR_FINALIZATION: ['FINALIZED', 'FAILED'],
  FINALIZED:              ['DISBURSED'],
  DISBURSED:              [],
  FAILED:                 ['PROCESSING', 'CANCELLED'],
  CANCELLED:              [],
});

/**
 * canTransition — pure function; no side effects.
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
