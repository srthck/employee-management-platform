import mongoose from 'mongoose';

/**
 * AuditLog — tamper-evident record of system events.
 *
 * Design principles:
 * - Append-only. No update or delete operations should ever modify audit records.
 * - Each event captures: who, what, when, on which entity, with what context.
 * - Sessions allow audit writes to participate in MongoDB transactions.
 * - The `meta` field is a flexible bag for event-specific additional data.
 *
 * Phase 8 events emitted here:
 *   PAYROLL_RUN_CREATED
 *   PAYROLL_PREFLIGHT_COMPLETED
 *   PAYROLL_PROCESSING_STARTED
 *   PAYROLL_PROCESSING_FAILED
 *   PAYROLL_FINALIZED
 *   PAYROLL_DISBURSED  (future)
 */

const auditLogSchema = new mongoose.Schema(
  {
    sequenceNumber: {
      type: Number,
      required: true,
      unique: true,
      index: true,
    },
    // ─── What happened ────────────────────────────────────────────────────
    action: {
      type: String,
      required: [true, 'Audit action is required'],
      trim: true,
      uppercase: true,
      index: true,
    },

    // ─── Who did it ───────────────────────────────────────────────────────
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      required: [true, 'Actor ID is required'],
      index: true,
    },
    actorEmail: {
      type: String,
      trim: true,
      lowercase: true,
    },
    actorRole: {
      type: String,
      trim: true,
    },

    // ─── What entity was affected ─────────────────────────────────────────
    entityType: {
      type: String,
      required: [true, 'Entity type is required'],
      trim: true,
      uppercase: true,
      // e.g. 'PAYROLL_RUN', 'EMPLOYEE', 'SALARY_STRUCTURE'
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      required: [true, 'Entity ID is required'],
      index: true,
    },

    // ─── State transition (for state-machine events) ──────────────────────
    previousStatus: {
      type: String,
      default: null,
    },
    newStatus: {
      type: String,
      default: null,
    },

    // ─── Flexible context ─────────────────────────────────────────────────
    meta: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    // ─── IP / request context ─────────────────────────────────────────────
    ipAddress: {
      type: String,
      trim: true,
    },

    previousHash: {
      type: String,
      required: true,
    },
    hash: {
      type: String,
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
    // Audit logs are never updated — enforce at schema level
    // (application-level convention; MongoDB doesn't enforce read-only)
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────
auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: -1 });

export default mongoose.model('AuditLog', auditLogSchema);
