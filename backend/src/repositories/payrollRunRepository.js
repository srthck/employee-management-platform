import mongoose from 'mongoose';
import PayrollRun from '../models/PayrollRun.js';
import PayrollStagingResult from '../models/PayrollStagingResult.js';

/**
 * payrollRunRepository — controlled persistence for PayrollRun + PayrollStagingResult.
 *
 * Responsibilities:
 * - All MongoDB operations on payroll_runs and payroll_staging_results.
 * - No business-state rules. Business logic lives in PayrollRunService.
 * - Atomic state transitions use findOneAndUpdate with matching conditions.
 * - Staging result operations support the PROCESSING → READY_FOR_FINALIZATION boundary.
 */

const payrollRunRepository = {

  // ─── PayrollRun CRUD ──────────────────────────────────────────────────────

  async create(data, session = null) {
    const run = new PayrollRun(data);
    await run.save(session ? { session } : {});
    return run;
  },

  async findById(id, session = null) {
    const q = PayrollRun.findById(id);
    if (session) q.session(session);
    return q.exec();
  },

  async findByCompanyPeriod(companyId, periodYear, periodMonth, session = null) {
    const q = PayrollRun.findOne({ companyId, periodYear, periodMonth });
    if (session) q.session(session);
    return q.exec();
  },

  /**
   * ATOMIC state transition.
   * Succeeds only if current status === fromStatus (race-condition safe).
   * Returns null if status no longer matches (another worker won the race).
   */
  async transitionStateAtomically(
    runId,
    fromStatus,
    toStatus,
    additionalFields = {},
    transitionEntry  = {},
    session = null
  ) {
    const update = {
      $set: { status: toStatus, lastActivityAt: new Date(), ...additionalFields },
      $push: {
        transitions: {
          fromStatus,
          toStatus,
          actorId:    transitionEntry.actorId,
          actorEmail: transitionEntry.actorEmail || null,
          reason:     transitionEntry.reason     || null,
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

  async updateProcessingMetrics(runId, metrics, session = null) {
    const options = { new: true };
    if (session) options.session = session;
    return PayrollRun.findByIdAndUpdate(runId, { $set: metrics }, options).exec();
  },

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
   * Update lastActivityAt heartbeat during long calculation loops.
   * Allows crash-detection: runs with lastActivityAt older than threshold
   * while in PROCESSING status may require manual recovery.
   */
  async touchActivity(runId, session = null) {
    const options = { new: false }; // don't need the updated doc
    if (session) options.session = session;
    return PayrollRun.findByIdAndUpdate(
      runId,
      { $set: { lastActivityAt: new Date() } },
      options
    ).exec();
  },

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
   * Transition PROCESSING → READY_FOR_FINALIZATION.
   * Called only after all staging results are durably written and verified.
   */
  async markReadyForFinalization(runId, data, transitionEntry = {}, session = null) {
    const {
      employeeCount,
      successfulEmployeeCount,
      failedEmployeeCount,
      durableResultCount,
      resolvedRuleVersionIds = {},
    } = data;

    return this.transitionStateAtomically(
      runId,
      'PROCESSING',
      'READY_FOR_FINALIZATION',
      {
        readyForFinalizationAt:  new Date(),
        completedAt:             new Date(),
        employeeCount,
        processedEmployeeCount:  successfulEmployeeCount,
        successfulEmployeeCount,
        failedEmployeeCount,
        durableResultCount,
        resolvedRuleVersionIds,
      },
      transitionEntry,
      session
    );
  },

  /**
   * Transition READY_FOR_FINALIZATION → FINALIZED.
   * Owned by Phase 9. Exposed here so the repository layer is complete.
   * Phase 9 calls this after verifying snapshot completeness.
   */
  async finalize(runId, finalizationData, transitionEntry = {}, session = null) {
    const { finalizedBy, resolvedRuleVersionIds = {} } = finalizationData;

    return this.transitionStateAtomically(
      runId,
      'READY_FOR_FINALIZATION',
      'FINALIZED',
      {
        finalizedAt: new Date(),
        finalizedBy,
        resolvedRuleVersionIds,
      },
      transitionEntry,
      session
    );
  },

  async listRuns(companyId, opts = {}) {
    const { status, limit = 20, skip = 0 } = opts;
    const filter = { companyId };
    if (status) filter.status = status;
    return PayrollRun.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean().exec();
  },

  async countRuns(companyId, status) {
    const filter = { companyId };
    if (status) filter.status = status;
    return PayrollRun.countDocuments(filter);
  },

  async incrementProcessingVersion(runId, session = null) {
    const options = { new: true };
    if (session) options.session = session;
    return PayrollRun.findByIdAndUpdate(runId, { $inc: { processingVersion: 1 } }, options).exec();
  },

  // ─── PayrollStagingResult operations ─────────────────────────────────────

  /**
   * Persist a single employee's calculation result as a durable staging record.
   *
   * Uses upsert on (runId, employeeId, processingVersion) so that if the
   * process crashes and retries, a clean write replaces any partial result.
   */
  async upsertStagingResult(data, session = null) {
    const filter = {
      runId:             data.runId,
      employeeId:        data.employeeId,
      processingVersion: data.processingVersion,
    };
    const options = { upsert: true, new: true, setDefaultsOnInsert: true };
    if (session) options.session = session;

    return PayrollStagingResult.findOneAndUpdate(
      filter,
      { $set: data },
      options
    ).exec();
  },

  /**
   * Count durable staging results for a run at a specific processing version.
   * Used for completeness verification before READY_FOR_FINALIZATION.
   */
  async countStagingResults(runId, processingVersion) {
    return PayrollStagingResult.countDocuments({ runId, processingVersion });
  },

  /**
   * Detect duplicate employee staging results (should be 0 after processing).
   * Returns employee IDs that appear more than once.
   */
  async findDuplicateStagingResults(runId, processingVersion) {
    const results = await PayrollStagingResult.aggregate([
      { $match: { runId: new mongoose.Types.ObjectId(runId), processingVersion } },
      { $group: { _id: '$employeeId', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ]);
    return results.map(r => r._id.toString());
  },

  /**
   * Delete all staging results for a run at a specific processing version.
   * Called at the start of a retry (FAILED → PROCESSING) to clean stale results.
   */
  async deleteStagingResults(runId, processingVersion, session = null) {
    const options = session ? { session } : {};
    return PayrollStagingResult.deleteMany({ runId, processingVersion }, options);
  },

  /**
   * List all staging results for a run (for Phase 9 consumption).
   */
  async listStagingResults(runId, processingVersion) {
    return PayrollStagingResult.find({ runId, processingVersion }).lean().exec();
  },
};

export default payrollRunRepository;
