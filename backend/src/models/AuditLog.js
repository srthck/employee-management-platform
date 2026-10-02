import mongoose from 'mongoose';

/**
 * AuditLog — tamper-evident record of system events.
 *
 * Design principles:
 * - Append-only. The schema refuses updates and deletes issued through
 *   Mongoose (see guards below). Raw database access can still modify
 *   records; the SHA-256 hash chain makes such modification DETECTABLE via
 *   auditService.verifyAuditChain(). This is tamper-evidence, not
 *   tamper-proofing, and is described that way everywhere.
 * - Each event captures: who, what, when, on which entity, in which company,
 *   from which IP, with what context.
 * - Sessions allow audit writes to participate in MongoDB transactions.
 * - The `meta` field is a flexible bag for event-specific additional data.
 *
 * Tenant scoping:
 * - companyId scopes read access. It is included in the hash payload whenever
 *   present, so re-assigning an event to another company breaks the chain.
 *   Events recorded before companyId existed have none and are hashed exactly
 *   as before, so the historical chain still verifies.
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

    // ─── Which company the event belongs to ───────────────────────────────
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
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
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────
auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ companyId: 1, createdAt: -1 });

// ─── Append-only guards ───────────────────────────────────────────────────────
const appendOnlyError = () =>
  Object.assign(new Error('Audit records are append-only and cannot be modified or deleted.'), {
    statusCode: 403,
  });

auditLogSchema.pre(
  [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'findOneAndReplace',
    'replaceOne',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
  ],
  { document: false, query: true },
  function rejectQueryMutation(next) {
    next(appendOnlyError());
  }
);

auditLogSchema.pre('deleteOne', { document: true, query: false }, function rejectDocumentDelete(next) {
  next(appendOnlyError());
});

auditLogSchema.pre('save', function rejectResave(next) {
  if (!this.isNew) return next(appendOnlyError());
  return next();
});

export default mongoose.model('AuditLog', auditLogSchema);
