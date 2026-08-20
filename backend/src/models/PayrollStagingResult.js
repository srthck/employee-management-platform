import mongoose from 'mongoose';

/**
 * PayrollStagingResult — durable pre-finalization employee payroll result.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *   This document bridges PROCESSING → READY_FOR_FINALIZATION.
 *
 *   Once a PayrollStagingResult is written to the database for every eligible
 *   employee in a run, the run transitions to READY_FOR_FINALIZATION.
 *   This guarantees that a process crash after calculation but before
 *   finalization does NOT silently produce a FINALIZED run without evidence.
 *
 * ─── THIS IS NOT A PAYROLLSNAPSHOT ──────────────────────────────────────────
 *   PayrollStagingResult is:
 *     - Mutable until Phase 9 materializes the immutable PayrollSnapshot.
 *     - NOT the final immutable employee financial record.
 *     - Subject to deletion/replacement if the run is retried (FAILED→PROCESSING).
 *     - A handoff boundary for Phase 9 to consume.
 *
 *   PayrollSnapshot (Phase 9) is:
 *     - Immutable once written.
 *     - The canonical employee payroll record.
 *     - Referenced by payslips, ECR, bank files, audit reconciliation.
 *
 * ─── LIFECYCLE ───────────────────────────────────────────────────────────────
 *   1. payrollRunService.processPayrollRun() calculates all employees.
 *   2. Each employee result is persisted as a PayrollStagingResult.
 *   3. If all writes succeed: run → READY_FOR_FINALIZATION.
 *   4. If any write fails: run → FAILED (staging results cleaned up on retry).
 *   5. Phase 9 reads all staging results for the run, verifies completeness,
 *      materializes immutable PayrollSnapshots, then transitions run → FINALIZED.
 *   6. Phase 9 may delete staging results after snapshot materialization.
 *
 * ─── RETRY SEMANTICS ─────────────────────────────────────────────────────────
 *   When a FAILED run is retried (FAILED → PROCESSING), all existing
 *   PayrollStagingResult documents for that runId are deleted before
 *   re-processing. This prevents stale/duplicate staging results.
 *
 * ─── COMPLETENESS INVARIANT ──────────────────────────────────────────────────
 *   Before READY_FOR_FINALIZATION:
 *     count({ runId }) == run.successfulEmployeeCount
 *     count({ runId, employeeId }) == 1 for every eligible employee
 *     (no duplicates, no missing)
 */

const payrollStagingResultSchema = new mongoose.Schema(
  {
    // ─── Run linkage ────────────────────────────────────────────────────
    runId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PayrollRun',
      required: [true, 'Run ID is required'],
      index: true,
    },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      required: [true, 'Company ID is required'],
      index: true,
    },
    processingVersion: {
      type: Number,
      required: [true, 'Processing version is required'],
    },

    // ─── Payroll period (denormalized for query convenience) ────────────
    periodMonth: { type: Number, required: true, min: 1, max: 12 },
    periodYear:  { type: Number, required: true, min: 2000, max: 2100 },

    // ─── Employee identity ───────────────────────────────────────────────
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: [true, 'Employee ID is required'],
    },
    employeeName: {
      type: String,
      trim: true,
    },

    // ─── Salary inputs (what was used — for Phase 9 snapshot integrity) ─
    salaryStructureId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SalaryStructure',
      required: [true, 'Salary structure ID is required'],
    },
    grossMonthly: {
      type: Number,
      required: [true, 'Gross monthly is required'],
      min: 0,
    },

    // ─── Attendance input ────────────────────────────────────────────────
    // Explicit record that attendance adjustment was NOT applied.
    // 'DEFERRED' = full-month gross used, no attendance proration.
    attendanceAdjustment: {
      type: String,
      enum: ['DEFERRED', 'APPLIED'],
      default: 'DEFERRED',
    },

    // ─── Compliance calculation results ─────────────────────────────────
    epf: {
      enrolled:        { type: Boolean, default: false },
      pfWageUsed:      { type: Number,  default: 0 },
      employeeEpf:     { type: Number,  default: 0 },
      employerEpf:     { type: Number,  default: 0 },
      epsContribution: { type: Number,  default: 0 },
      totalEpf:        { type: Number,  default: 0 },
    },
    esi: {
      enrolled:    { type: Boolean, default: false },
      applicable:  { type: Boolean, default: false },
      employeeEsi: { type: Number,  default: 0 },
      employerEsi: { type: Number,  default: 0 },
      totalEsi:    { type: Number,  default: 0 },
    },
    pt: {
      enrolled:   { type: Boolean, default: false },
      applicable: { type: Boolean, default: false },
      pt:         { type: Number,  default: 0 },
    },

    // ─── TDS (explicitly deferred) ────────────────────────────────────
    tdsDeferred: {
      type: Boolean,
      default: true,
    },

    // ─── Net pay ─────────────────────────────────────────────────────────
    totalEmployeeDeductions: {
      type: Number,
      required: [true, 'Total employee deductions is required'],
      min: 0,
    },
    netPay: {
      type: Number,
      required: [true, 'Net pay is required'],
      min: 0,
    },

    // ─── Rule version IDs (for Phase 9 audit linkage) ────────────────────
    resolvedRuleVersionIds: {
      epf: { type: mongoose.Schema.Types.ObjectId, ref: 'ComplianceRuleVersion', default: null },
      esi: { type: mongoose.Schema.Types.ObjectId, ref: 'ComplianceRuleVersion', default: null },
      pt:  { type: mongoose.Schema.Types.ObjectId, ref: 'ComplianceRuleVersion', default: null },
    },
  },
  {
    timestamps: true,
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

// Primary query: all staging results for a run
payrollStagingResultSchema.index({ runId: 1 });

// Uniqueness per run per employee per processing version:
// prevents duplicate staging results for the same employee in the same run attempt.
payrollStagingResultSchema.index(
  { runId: 1, employeeId: 1, processingVersion: 1 },
  {
    unique: true,
    name: 'unique_staging_result_per_run_employee_version',
  }
);

// Query for completeness check: count by runId + processingVersion
payrollStagingResultSchema.index({ runId: 1, processingVersion: 1 });

export default mongoose.model('PayrollStagingResult', payrollStagingResultSchema);
