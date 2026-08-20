import mongoose from 'mongoose';
import PayrollRun from '../models/PayrollRun.js';

/**
 * payrollRunRepository — controlled persistence layer for PayrollRun documents.
 *
 * Responsibilities:
 * - All MongoDB operations on the payroll_runs collection live here.
 * - No business-state rules. Business logic belongs in PayrollRunService.
 * - All state-mutating operations accept an optional Mongoose session
 *   so they can participate in transactions.
 * - Atomic state transitions use findOneAndUpdate with matching conditions
 *   to prevent race conditions.
 */

const payrollRunRepository = {
  /**
   * Create a new PayrollRun document.
   *
   * @param {object} data - Partial PayrollRun fields
   * @param {import('mongoose').ClientSession} [session]
   * @returns {Promise<PayrollRun>}
   */
  async create(data, session = null) {
    const options = session ? { session } : {};
    // Use save() rather than Model.create() so we can pass session cleanly.
    const run = new PayrollRun(data);
    await run.save(options);
    return run;
  },

  /**
   * Find a PayrollRun by its MongoDB _id.
   *
   * @param {string|ObjectId} id
   * @param {import('mongoose').ClientSession} [session]
   * @returns {Promise<PayrollRun|null>}
   */
  async findById(id, session = null) {
    const query = PayrollRun.findById(id);
    if (session) query.session(session);
    return query.exec();
  },

  /**
   * Find a PayrollRun for a specific company and period.
   * Returns null if none exists.
   *
   * @param {string|ObjectId} companyId
   * @param {number} periodYear
   * @param {number} periodMonth
   * @param {import('mongoose').ClientSession} [session]
   * @returns {Promise<PayrollRun|null>}
   */
  async findByCompanyPeriod(companyId, periodYear, periodMonth, session = null) {
    const query = PayrollRun.findOne({ companyId, periodYear, periodMonth });
    if (session) query.session(session);
    return query.exec();
  },

  /**
   * ATOMIC state transition.
   *
   * Uses a conditional update: only transitions if the run is currently in
   * `fromStatus`. If another process already changed the status, the update
   * matches 0 documents and returns null — the caller must handle this.
   *
   * @param {string|ObjectId} runId
   * @param {string} fromStatus          - Expected current status
   * @param {string} toStatus            - Target status
   * @param {object} additionalFields    - Additional $set fields (e.g. startedAt)
   * @param {object} transitionEntry     - { actorId, actorEmail, reason } for history
   * @param {import('mongoose').ClientSession} [session]
   * @returns {Promise<PayrollRun|null>}  - Updated doc or null if condition not met
   */
  async transitionStateAtomically(
    runId,
    fromStatus,
    toStatus,
    additionalFields = {},
    transitionEntry = {},
    session = null
  ) {
    const update = {
      $set: { status: toStatus, ...additionalFields },
      $push: {
        transitions: {
          fromStatus,
          toStatus,
          actorId:    transitionEntry.actorId,
          actorEmail: transitionEntry.actorEmail || null,
          reason:     transitionEntry.reason || null,
          timestamp:  new Date(),
        },
      },
    };

    const options = { new: true };
    if (session) options.session = session;

    return PayrollRun.findOneAndUpdate(
      { _id: runId, status: fromStatus },
      update,
      options
    ).exec();
  },

  /**
   * Update processing metrics (employeeCount, processedCount, etc.).
   * Non-atomic batch update — called within a controlled processing block.
   *
   * @param {string|ObjectId} runId
   * @param {object} metrics - { employeeCount, processedEmployeeCount, successfulEmployeeCount, failedEmployeeCount }
   * @param {import('mongoose').ClientSession} [session]
   * @returns {Promise<PayrollRun|null>}
   */
  async updateProcessingMetrics(runId, metrics, session = null) {
    const options = { new: true };
    if (session) options.session = session;

    return PayrollRun.findByIdAndUpdate(
      runId,
      { $set: metrics },
      options
    ).exec();
  },

  /**
   * Store preflight result on the run.
   *
   * @param {string|ObjectId} runId
   * @param {object} preflightResult
   * @param {import('mongoose').ClientSession} [session]
   * @returns {Promise<PayrollRun|null>}
   */
  async updatePreflightResult(runId, preflightResult, session = null) {
    const options = { new: true };
    if (session) options.session = session;

    return PayrollRun.findByIdAndUpdate(
      runId,
      { $set: { preflightResult } },
      options
    ).exec();
  },

  /**
   * Mark run as FAILED with reason.
   *
   * @param {string|ObjectId} runId
   * @param {string} failureReason
   * @param {object} transitionEntry
   * @param {import('mongoose').ClientSession} [session]
   * @returns {Promise<PayrollRun|null>}
   */
  async markFailed(runId, failureReason, transitionEntry = {}, session = null) {
    return this.transitionStateAtomically(
      runId,
      'PROCESSING',
      'FAILED',
      { failureReason, failedAt: new Date(), completedAt: new Date() },
      transitionEntry,
      session
    );
  },

  /**
   * Finalize a run — transition PROCESSING → FINALIZED.
   *
   * @param {string|ObjectId} runId
   * @param {object} finalizationData - { finalizedBy, resolvedRuleVersionIds, metrics }
   * @param {object} transitionEntry
   * @param {import('mongoose').ClientSession} [session]
   * @returns {Promise<PayrollRun|null>}
   */
  async finalize(runId, finalizationData, transitionEntry = {}, session = null) {
    const {
      finalizedBy,
      resolvedRuleVersionIds = {},
      employeeCount,
      successfulEmployeeCount,
      failedEmployeeCount,
    } = finalizationData;

    return this.transitionStateAtomically(
      runId,
      'PROCESSING',
      'FINALIZED',
      {
        finalizedAt: new Date(),
        completedAt: new Date(),
        finalizedBy,
        resolvedRuleVersionIds,
        employeeCount,
        processedEmployeeCount: successfulEmployeeCount + failedEmployeeCount,
        successfulEmployeeCount,
        failedEmployeeCount,
      },
      transitionEntry,
      session
    );
  },

  /**
   * List PayrollRuns for a company, optionally filtered by status.
   *
   * @param {string|ObjectId} companyId
   * @param {object} [opts]
   * @param {string}   [opts.status]
   * @param {number}   [opts.limit=20]
   * @param {number}   [opts.skip=0]
   * @returns {Promise<PayrollRun[]>}
   */
  async listRuns(companyId, opts = {}) {
    const { status, limit = 20, skip = 0 } = opts;
    const filter = { companyId };
    if (status) filter.status = status;

    return PayrollRun.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();
  },

  /**
   * Count PayrollRuns for a company (optionally by status).
   *
   * @param {string|ObjectId} companyId
   * @param {string} [status]
   * @returns {Promise<number>}
   */
  async countRuns(companyId, status) {
    const filter = { companyId };
    if (status) filter.status = status;
    return PayrollRun.countDocuments(filter);
  },

  /**
   * Increment processingVersion atomically (used on each retry).
   *
   * @param {string|ObjectId} runId
   * @param {import('mongoose').ClientSession} [session]
   * @returns {Promise<PayrollRun|null>}
   */
  async incrementProcessingVersion(runId, session = null) {
    const options = { new: true };
    if (session) options.session = session;
    return PayrollRun.findByIdAndUpdate(
      runId,
      { $inc: { processingVersion: 1 } },
      options
    ).exec();
  },
};

export default payrollRunRepository;
