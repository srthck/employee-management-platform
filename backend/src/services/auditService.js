import AuditLog from '../models/AuditLog.js';

/**
 * AuditService — Phase 6 compatible audit event emitter.
 *
 * Responsibilities:
 * - Record tamper-evident audit events for meaningful system actions.
 * - Support optional MongoDB session so audit writes participate in transactions.
 * - Provide structured audit records: who, what, when, on what entity.
 *
 * Usage (outside transaction):
 *   await auditService.log({ action, actorId, actorEmail, actorRole,
 *                            entityType, entityId, meta });
 *
 * Usage (inside transaction):
 *   await auditService.log({ ... }, session);
 *
 * NEVER throw from this service in a way that silently suppresses the calling
 * operation. Callers are responsible for deciding whether an audit failure is
 * business-critical.
 */

const auditService = {
  /**
   * Emit a single audit event.
   *
   * @param {object} params
   * @param {string}   params.action         - Uppercase event name, e.g. 'PAYROLL_RUN_CREATED'
   * @param {string}   params.actorId        - MongoDB ObjectId string of the acting admin
   * @param {string}   [params.actorEmail]   - Actor email (denormalized for readable logs)
   * @param {string}   [params.actorRole]    - Actor role at time of action
   * @param {string}   params.entityType     - Uppercase entity name, e.g. 'PAYROLL_RUN'
   * @param {string}   params.entityId       - MongoDB ObjectId of affected entity
   * @param {string}   [params.previousStatus]
   * @param {string}   [params.newStatus]
   * @param {object}   [params.meta]         - Additional context (arbitrary key/value)
   * @param {string}   [params.ipAddress]
   * @param {import('mongoose').ClientSession} [session] - Optional transaction session
   * @returns {Promise<AuditLog>}
   */
  async log(params, session = null) {
    const {
      action,
      actorId,
      actorEmail,
      actorRole,
      entityType,
      entityId,
      previousStatus = null,
      newStatus = null,
      meta = {},
      ipAddress = null,
    } = params;

    const logEntry = new AuditLog({
      action,
      actorId,
      actorEmail,
      actorRole,
      entityType,
      entityId,
      previousStatus,
      newStatus,
      meta,
      ipAddress,
    });

    const options = session ? { session } : {};
    await logEntry.save(options);
    return logEntry;
  },

  /**
   * Query audit logs for a specific entity (for explainability endpoints).
   *
   * @param {string} entityType
   * @param {string} entityId
   * @param {object} [opts]
   * @param {number} [opts.limit=50]
   * @returns {Promise<AuditLog[]>}
   */
  async getEntityHistory(entityType, entityId, opts = {}) {
    const { limit = 50 } = opts;
    return AuditLog.find({ entityType, entityId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
  },
};

export default auditService;
