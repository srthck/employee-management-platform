import mongoose from 'mongoose';
import crypto from 'crypto';

/**
 * PayrollSnapshot — the immutable historical employee payroll record.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ARCHITECTURAL POSITION:
 *   PayrollStagingResult (Phase 8) → materialize → PayrollSnapshot (Phase 9)
 *                                                        ↓
 *                                              PayrollRun → FINALIZED
 *
 * ─── IMMUTABILITY CONTRACT ──────────────────────────────────────────────────
 *   Once snapshotStatus = 'FINALIZED':
 *     - No UPDATE is permitted through normal application operations.
 *     - No DELETE is permitted through normal application operations.
 *     - The payrollSnapshotRepository intentionally exposes NO updateSnapshot()
 *       or deleteSnapshot() methods.
 *     - The snapshotHash is stored so any out-of-band mutation is detectable.
 *
 * ─── HISTORICAL ISOLATION PRINCIPLE ────────────────────────────────────────
 *   The snapshot stores the state of the employee, salary, and rules AT THE
 *   TIME of payroll calculation. Later changes to:
 *     - Employee name, department, status
 *     - SalaryStructure (new revision)
 *     - ComplianceRuleVersion (new rule)
 *   must have ZERO effect on a finalized snapshot.
 *
 * ─── TWO-STATUS LIFECYCLE ───────────────────────────────────────────────────
 *   PENDING_FINALIZATION:
 *     Snapshot has been materialized from staging. PayrollRun is still
 *     READY_FOR_FINALIZATION. The snapshot content is correct but the
 *     payroll period is not yet officially closed. The snapshot should
 *     not be presented as a final financial record yet.
 *
 *   FINALIZED:
 *     PayrollRun has been transitioned to FINALIZED. The snapshot is now
 *     the permanent historical record. No mutations permitted.
 *
 * ─── WHAT THE SNAPSHOT STORES ───────────────────────────────────────────────
 *   1. employeeSnapshot     — historical employee identity at payroll time
 *   2. salarySnapshot       — historical salary component values (not just ID)
 *   3. complianceProvenance — exact rule versions + parameter values used
 *   4. payrollInputs        — inputs fed to the calculation
 *   5. payrollResults       — outputs of the calculation (EPF, ESI, PT, netPay)
 *   6. snapshotHash         — SHA-256 of canonical payload for tamper detection
 *
 * ─── TDS / ATTENDANCE HONESTY ───────────────────────────────────────────────
 *   tdsStatus = 'DEFERRED' — TDS was not calculated. tdsAmount = null.
 *   The result field is named netPayBeforeTDS, not "final net pay".
 *   attendanceAdjustment = 'DEFERRED' — full-month gross used, no proration.
 *
 * ─── COMPANY IDENTITY ────────────────────────────────────────────────────────
 *   CURRENT MVP: companyId = creating Admin's _id (single-tenant).
 *   FUTURE: real Company entity.
 */

// ─── Employee identity snapshot (frozen at payroll time) ─────────────────────
const employeeSnapshotSchema = new mongoose.Schema(
  {
    employeeId:   { type: mongoose.Schema.Types.ObjectId, required: true },
    firstName:    { type: String, required: true },
    lastName:     { type: String, required: true },
    fullName:     { type: String, required: true },
    email:        { type: String, required: true },
    department:   { type: String },
    position:     { type: String },
    employmentStatus: { type: String },  // active / on-leave at payroll time
    hireDate:     { type: Date },
  },
  { _id: false }
);

// ─── Salary component snapshot ───────────────────────────────────────────────
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

// ─── Salary version snapshot (frozen at payroll time) ────────────────────────
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

// ─── Compliance rule provenance (one per rule type) ───────────────────────────
const ruleProvenanceSchema = new mongoose.Schema(
  {
    ruleType:     { type: String, required: true },   // 'EPF' | 'ESI' | 'PT'
    ruleId:       { type: mongoose.Schema.Types.ObjectId, required: true },
    jurisdiction: { type: String, required: true },
    effectiveFrom: { type: Date, required: true },
    effectiveTo:   { type: Date, default: null },
    // Human-readable reference for audit reports
    sourceReference: { type: String },
  },
  { _id: false }
);

// ─── Payroll inputs snapshot ─────────────────────────────────────────────────
const payrollInputsSchema = new mongoose.Schema(
  {
    grossMonthly:         { type: Number, required: true },
    basicSalary:          { type: Number, required: true },
    pfWageOverride:       { type: Number, default: null },
    pfEnrolled:           { type: Boolean, required: true },
    esiEnrolled:          { type: Boolean, required: true },
    ptEnrolled:           { type: Boolean, required: true },
    workState:            { type: String, required: true },
    payrollDate:          { type: Date, required: true },   // periodEnd used for rule resolution
    attendanceAdjustment: { type: String, default: 'DEFERRED' },
  },
  { _id: false }
);

// ─── EPF result snapshot ─────────────────────────────────────────────────────
const epfResultSchema = new mongoose.Schema(
  {
    enrolled:        { type: Boolean, default: false },
    pfWageUsed:      { type: Number, default: 0 },
    employeeEpf:     { type: Number, default: 0 },
    employerEpf:     { type: Number, default: 0 },
    epsContribution: { type: Number, default: 0 },
    totalEpf:        { type: Number, default: 0 },
  },
  { _id: false }
);

// ─── ESI result snapshot ─────────────────────────────────────────────────────
const esiResultSchema = new mongoose.Schema(
  {
    enrolled:    { type: Boolean, default: false },
    applicable:  { type: Boolean, default: false },
    employeeEsi: { type: Number, default: 0 },
    employerEsi: { type: Number, default: 0 },
    totalEsi:    { type: Number, default: 0 },
  },
  { _id: false }
);

// ─── PT result snapshot ──────────────────────────────────────────────────────
const ptResultSchema = new mongoose.Schema(
  {
    enrolled:   { type: Boolean, default: false },
    applicable: { type: Boolean, default: false },
    pt:         { type: Number, default: 0 },
  },
  { _id: false }
);

// ─── Payroll results snapshot ────────────────────────────────────────────────
const payrollResultsSchema = new mongoose.Schema(
  {
    epf:                     { type: epfResultSchema, required: true },
    esi:                     { type: esiResultSchema, required: true },
    pt:                      { type: ptResultSchema,  required: true },
    totalEmployeeDeductions: { type: Number, required: true },
    employerTotalContribution: { type: Number, default: 0 },  // EPF employer + ESI employer
    // TDS is deferred. netPayBeforeTDS is the honest pre-TDS amount.
    netPayBeforeTDS:         { type: Number, required: true },
    // TDS fields — explicitly deferred
    tdsStatus:               { type: String, enum: ['DEFERRED', 'CALCULATED'], default: 'DEFERRED' },
    tdsAmount:               { type: Number, default: null },
  },
  { _id: false }
);

// ─── Main PayrollSnapshot schema ─────────────────────────────────────────────
const payrollSnapshotSchema = new mongoose.Schema(
  {
    // ─── Run linkage ────────────────────────────────────────────────────
    payrollRunId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PayrollRun',
      required: [true, 'Payroll run ID is required'],
      index: true,
    },
    stagingResultId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PayrollStagingResult',
      required: [true, 'Staging result ID is required'],
    },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      required: [true, 'Company ID is required'],
      index: true,
    },

    // ─── Payroll period ──────────────────────────────────────────────────
    periodMonth: {
      type: Number,
      required: true,
      min: 1,
      max: 12,
    },
    periodYear: {
      type: Number,
      required: true,
      min: 2000,
      max: 2100,
    },
    periodStart: {
      type: Date,
      required: true,
    },
    periodEnd: {
      type: Date,
      required: true,
    },

    // ─── Historical employee identity snapshot ───────────────────────────
    employeeSnapshot: {
      type: employeeSnapshotSchema,
      required: [true, 'Employee snapshot is required'],
    },

    // ─── Historical salary snapshot ──────────────────────────────────────
    salarySnapshot: {
      type: salarySnapshotSchema,
      required: [true, 'Salary snapshot is required'],
    },

    // ─── Historical compliance rule provenance ───────────────────────────
    complianceProvenance: {
      type: [ruleProvenanceSchema],
      default: [],
    },

    // ─── Payroll inputs used ────────────────────────────────────────────
    payrollInputs: {
      type: payrollInputsSchema,
      required: [true, 'Payroll inputs are required'],
    },

    // ─── Payroll calculation results ────────────────────────────────────
    payrollResults: {
      type: payrollResultsSchema,
      required: [true, 'Payroll results are required'],
    },

    // ─── Processing version that produced this snapshot ─────────────────
    processingVersion: {
      type: Number,
      required: true,
    },

    // ─── Snapshot lifecycle ──────────────────────────────────────────────
    snapshotStatus: {
      type: String,
      enum: {
        values: ['PENDING_FINALIZATION', 'FINALIZED'],
        message: '{VALUE} is not a valid snapshot status.',
      },
      default: 'PENDING_FINALIZATION',
    },
    finalizedAt: {
      type: Date,
      default: null,
    },
    finalizedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },

    // ─── Integrity hash ──────────────────────────────────────────────────
    // SHA-256 of the canonical snapshot payload.
    // Allows detection of out-of-band mutations.
    // NOT a replacement for the Phase 6 audit chain.
    snapshotHash: {
      type: String,
      required: [true, 'Snapshot hash is required'],
    },
  },
  {
    timestamps: true,
    // Intentional: updatedAt is tracked but the application layer must
    // refuse mutations after finalization. updatedAt is excluded from the
    // canonical hash payload so a legitimate system update (e.g. snapshotStatus
    // change from PENDING to FINALIZED) does not invalidate the hash.
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

// CRITICAL: One snapshot per run per employee (immutability invariant)
payrollSnapshotSchema.index(
  { payrollRunId: 1, 'employeeSnapshot.employeeId': 1 },
  {
    unique: true,
    name: 'unique_snapshot_per_run_employee',
  }
);

// Query: all snapshots for a run
payrollSnapshotSchema.index({ payrollRunId: 1, snapshotStatus: 1 });

// Query: all snapshots for an employee (payslip history)
payrollSnapshotSchema.index({ 'employeeSnapshot.employeeId': 1, periodYear: -1, periodMonth: -1 });

// Query: all snapshots for a company
payrollSnapshotSchema.index({ companyId: 1, periodYear: -1, periodMonth: -1 });

// ─── Canonical payload builder ────────────────────────────────────────────────

/**
 * Build a deterministic canonical representation of the financially meaningful
 * snapshot fields for SHA-256 hashing.
 *
 * Rules:
 * - Object keys sorted alphabetically at all levels.
 * - Dates serialized as ISO strings.
 * - ObjectIds serialized as strings.
 * - Nulls preserved as-is.
 * - Non-financial metadata (snapshotStatus, finalizedAt, updatedAt, createdAt)
 *   is intentionally EXCLUDED — these can change legitimately.
 *
 * @param {object} doc - Partial snapshot data (plain object, not Mongoose doc)
 * @returns {string} - JSON string (deterministic)
 */
function buildCanonicalPayload(doc) {
  const normalize = (val) => {
    if (val === null || val === undefined) return null;
    if (val instanceof Date)              return val.toISOString();
    if (typeof val === 'object' && val.toString && /^[0-9a-f]{24}$/.test(val.toString())) {
      return val.toString();  // ObjectId
    }
    if (Array.isArray(val)) {
      return val.map(normalize);
    }
    if (typeof val === 'object') {
      return Object.keys(val)
        .sort()
        .reduce((acc, k) => { acc[k] = normalize(val[k]); return acc; }, {});
    }
    return val;
  };

  const financial = {
    companyId:           doc.companyId,
    complianceProvenance: doc.complianceProvenance,
    employeeSnapshot:    doc.employeeSnapshot,
    payrollInputs:       doc.payrollInputs,
    payrollResults:      doc.payrollResults,
    payrollRunId:        doc.payrollRunId,
    periodEnd:           doc.periodEnd,
    periodMonth:         doc.periodMonth,
    periodStart:         doc.periodStart,
    periodYear:          doc.periodYear,
    processingVersion:   doc.processingVersion,
    salarySnapshot:      doc.salarySnapshot,
    stagingResultId:     doc.stagingResultId,
  };

  return JSON.stringify(normalize(financial));
}

/**
 * Compute SHA-256 hash of the canonical snapshot payload.
 *
 * @param {object} doc - Plain snapshot data
 * @returns {string} - hex-encoded SHA-256
 */
export function computeSnapshotHash(doc) {
  const canonical = buildCanonicalPayload(doc);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Verify a stored snapshot's hash against its current stored content.
 *
 * @param {object} snapshot - Mongoose document (lean or full)
 * @returns {{ valid: boolean, storedHash: string, computedHash: string }}
 */
export function verifySnapshotHash(snapshot) {
  const doc = snapshot.toObject ? snapshot.toObject() : snapshot;
  const computedHash = computeSnapshotHash(doc);
  const valid = computedHash === doc.snapshotHash;
  return {
    valid,
    storedHash:   doc.snapshotHash,
    computedHash,
  };
}

export default mongoose.model('PayrollSnapshot', payrollSnapshotSchema);
