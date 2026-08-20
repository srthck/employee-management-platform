import mongoose from 'mongoose';

/**
 * PayrollStagingResult — durable pre-finalization employee payroll record.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PURPOSE:
 *   Bridges PROCESSING → READY_FOR_FINALIZATION.
 *   Written during Phase 8 payroll processing.
 *   Consumed (read-only) by Phase 9 snapshot materialization.
 *
 * ─── HISTORICAL INPUT FREEZE (CRITICAL) ─────────────────────────────────────
 *   Phase 9 MUST NOT reconstruct historical payroll inputs from current
 *   mutable documents (Employee, SalaryStructure, ComplianceRuleVersion).
 *   Those documents can change after staging is written.
 *
 *   Therefore this document freezes ALL payroll inputs AT THE TIME OF
 *   Phase 8 processing:
 *
 *   employeeSnapshot  — employee identity/employment state at processing time
 *   salarySnapshot    — salary component values at processing time
 *   payrollInputs     — inputs fed to complianceCalculationService
 *   payrollResults    — outputs of complianceCalculationService
 *   ruleProvenance    — exact rule versions used (type, ID, jurisdiction, dates)
 *
 *   Phase 9 copies these frozen fields directly into PayrollSnapshot.
 *   It does NOT call Employee.findById, SalaryStructure.findById, or
 *   ComplianceRuleVersion.findValidForDate to reconstruct historical inputs.
 *
 * ─── LIFECYCLE ───────────────────────────────────────────────────────────────
 *   1. processPayrollRun() resolves employee, salary, rules at payroll time.
 *   2. All inputs + results frozen into PayrollStagingResult.
 *   3. Run → READY_FOR_FINALIZATION.
 *   4. Phase 9 reads staging, copies frozen data into PayrollSnapshot.
 *   5. Phase 9 transitions run → FINALIZED.
 *   6. Staging results may be deleted after snapshot materialization.
 *
 * ─── RETRY SEMANTICS ─────────────────────────────────────────────────────────
 *   FAILED → PROCESSING retry: old processingVersion staging is deleted.
 *   Unique key: (runId, employeeId, processingVersion).
 */

// ─── Employee identity snapshot (frozen at payroll processing time) ──────────
const employeeSnapshotSchema = new mongoose.Schema(
  {
    // employeeId is stored at the top-level staging document.
    // These fields are the historical identity state.
    firstName:        { type: String, required: true },
    lastName:         { type: String, required: true },
    fullName:         { type: String, required: true },
    email:            { type: String, required: true },
    department:       { type: String },
    position:         { type: String },
    employmentStatus: { type: String },   // 'active' | 'on-leave' at payroll time
    hireDate:         { type: Date },
  },
  { _id: false }
);

// ─── Salary component snapshot (frozen at payroll processing time) ────────────
const salaryComponentSnapshotSchema = new mongoose.Schema(
  {
    basic:               { type: Number, default: 0 },
    hra:                 { type: Number, default: 0 },
    conveyanceAllowance: { type: Number, default: 0 },
    medicalAllowance:    { type: Number, default: 0 },
    specialAllowance:    { type: Number, default: 0 },
    otherAllowances:     { type: Number, default: 0 },
  },
  { _id: false }
);

// ─── Salary version snapshot (frozen at payroll processing time) ──────────────
const salarySnapshotSchema = new mongoose.Schema(
  {
    salaryStructureId: { type: mongoose.Schema.Types.ObjectId, required: true },
    effectiveFrom:     { type: Date, required: true },
    effectiveTo:       { type: Date, default: null },
    components:        { type: salaryComponentSnapshotSchema, required: true },
    grossMonthly:      { type: Number, required: true },
    currency:          { type: String, default: 'INR' },
    payFrequency:      { type: String, default: 'monthly' },
    workState:         { type: String, required: true },
    pfEnrolled:        { type: Boolean, default: true },
    esiEnrolled:       { type: Boolean, default: true },
    ptEnrolled:        { type: Boolean, default: true },
    pfWageOverride:    { type: Number, default: null },
  },
  { _id: false }
);

// ─── Compliance rule provenance (frozen at payroll processing time) ───────────
const ruleProvenanceSchema = new mongoose.Schema(
  {
    ruleType:        { type: String, required: true },   // 'EPF' | 'ESI' | 'PT'
    ruleId:          { type: mongoose.Schema.Types.ObjectId, required: true },
    jurisdiction:    { type: String, required: true },
    effectiveFrom:   { type: Date, required: true },
    effectiveTo:     { type: Date, default: null },
    sourceReference: { type: String },
  },
  { _id: false }
);

// ─── Payroll inputs snapshot (frozen at payroll processing time) ──────────────
const payrollInputsSchema = new mongoose.Schema(
  {
    grossMonthly:         { type: Number, required: true },
    basicSalary:          { type: Number, required: true },
    pfWageOverride:       { type: Number, default: null },
    pfEnrolled:           { type: Boolean, required: true },
    esiEnrolled:          { type: Boolean, required: true },
    ptEnrolled:           { type: Boolean, required: true },
    workState:            { type: String, required: true },
    payrollDate:          { type: Date,    required: true },   // periodEnd
    attendanceAdjustment: { type: String, default: 'DEFERRED' },
  },
  { _id: false }
);

// ─── Main schema ──────────────────────────────────────────────────────────────
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

    // ─── Payroll period (denormalized for query convenience) ─────────────
    periodMonth: { type: Number, required: true, min: 1, max: 12 },
    periodYear:  { type: Number, required: true, min: 2000, max: 2100 },

    // ─── Employee identity pointer ────────────────────────────────────────
    // employeeId is the reference; employeeSnapshot is the frozen historical state.
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: [true, 'Employee ID is required'],
    },

    // ─── FROZEN HISTORICAL INPUTS ─────────────────────────────────────────
    // These are captured AT PAYROLL PROCESSING TIME and must never be
    // re-derived from current mutable documents during Phase 9.

    // Employee identity as it was during payroll processing
    employeeSnapshot: {
      type: employeeSnapshotSchema,
      required: [true, 'Employee snapshot is required'],
    },

    // Salary version as it was during payroll processing
    salarySnapshot: {
      type: salarySnapshotSchema,
      required: [true, 'Salary snapshot is required'],
    },

    // Exact compliance rule versions used + their provenance
    ruleProvenance: {
      type: [ruleProvenanceSchema],
      default: [],
    },

    // Inputs fed to complianceCalculationService
    payrollInputs: {
      type: payrollInputsSchema,
      required: [true, 'Payroll inputs are required'],
    },

    // ─── CALCULATION RESULTS ─────────────────────────────────────────────
    // Outputs of complianceCalculationService.calculate()

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

    tdsDeferred: {
      type: Boolean,
      default: true,
    },

    totalEmployeeDeductions: {
      type: Number,
      required: [true, 'Total employee deductions is required'],
      min: 0,
    },

    // Honest field name: pre-TDS net pay. TDS is deferred.
    netPayBeforeTDS: {
      type: Number,
      required: [true, 'Net pay before TDS is required'],
      min: 0,
    },

    // ─── LEGACY: resolvedRuleVersionIds (kept for backward compatibility) ─
    // Prefer ruleProvenance array above which contains full provenance.
    // These IDs are still used for completeness checks.
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

payrollStagingResultSchema.index({ runId: 1 });

payrollStagingResultSchema.index(
  { runId: 1, employeeId: 1, processingVersion: 1 },
  {
    unique: true,
    name: 'unique_staging_result_per_run_employee_version',
  }
);

payrollStagingResultSchema.index({ runId: 1, processingVersion: 1 });

export default mongoose.model('PayrollStagingResult', payrollStagingResultSchema);
