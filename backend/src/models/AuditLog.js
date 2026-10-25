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
    // The version of the chain head produced by the transition that appended this record (see AuditChainHead).
    // NOT part of the hash payload. Records written before the head protocol do not have it; every new record does,
    // and the collection validator refuses a new record that lacks it (blocks writers that do not know the protocol).
    headVersion: {
      type: Number,
      min: 1,
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

// ─── Chain-integrity indexes: DEFENCE IN DEPTH ────────────────────────────────────────────────
// Linearity of the chain comes from the transactional head protocol in auditService (one head document advanced by
// compare-and-set in the same transaction as the record). These three unique indexes and the collection validator
// (src/services/auditChainSpec.js is the exact specification) are a second, independent barrier, and the validator
// is what blocks writers that do not know the protocol.
//   sequenceNumber (declared on the field above): one record per position.
//   previousHash: a predecessor has exactly ONE successor. PARTIAL, so records written before chaining existed
//                 (no previousHash) do not collide with each other.
//   headVersion: one record per head transition. PARTIAL, so records written before the head protocol do not collide.
// The names and options below are compared against the live database by auditChainSpec.evaluateIndexes().
auditLogSchema.index(
  { previousHash: 1 },
  {
    unique: true,
    name: 'previousHash_unique_successor',
    partialFilterExpression: { previousHash: { $type: 'string' } },
  }
);
auditLogSchema.index(
  { headVersion: 1 },
  {
    unique: true,
    name: 'headVersion_unique_transition',
    partialFilterExpression: { headVersion: { $type: 'number' } },
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
