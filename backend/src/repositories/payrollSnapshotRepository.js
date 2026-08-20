import mongoose from 'mongoose';
import PayrollSnapshot from '../models/PayrollSnapshot.js';

/**
 * payrollSnapshotRepository — controlled persistence for PayrollSnapshot.
 *
 * ─── IMMUTABILITY CONTRACT ─────────────────────────────────────────────────
 *   This repository intentionally does NOT expose:
 *     - updateSnapshot()
 *     - deleteSnapshot()
 *     - replaceSnapshot()
 *   These methods are absent by design. A finalized snapshot has no ordinary
 *   mutation path. Future correction/versioning will be introduced explicitly
 *   if required, with its own controlled architecture.
 *
 *   The ONLY writable method after snapshot creation is:
 *     - markFinalized() — changes snapshotStatus from PENDING_FINALIZATION
 *       to FINALIZED, and records finalizedAt + finalizedBy.
 *       This is the ONE legitimate post-creation mutation.
 *
 * ─── EXPOSED METHODS ────────────────────────────────────────────────────────
 *   create           — insert a new PENDING_FINALIZATION snapshot
 *   findById         — read by _id
 *   findByRunAndEmployee — read one snapshot for a run+employee
 *   findByRun        — paginated list for a run
 *   findByEmployee   — paginated history for an employee
 *   countByRun       — count snapshots for a run (completeness check)
 *   countFinalizedByRun — count FINALIZED snapshots for a run
 *   findDuplicates   — detect duplicate employee snapshots in a run
 *   markFinalized    — PENDING_FINALIZATION → FINALIZED (short transaction)
 *   bulkMarkFinalized — batch finalization within a transaction
 */

const payrollSnapshotRepository = {

  /**
   * Create a new PENDING_FINALIZATION snapshot.
   * Uses insertOne via save() so unique index violations surface cleanly.
   *
   * @param {object} data - Snapshot fields (including snapshotHash)
   * @param {ClientSession} [session]
   * @returns {Promise<PayrollSnapshot>}
   */
  async create(data, session = null) {
    const snap = new PayrollSnapshot(data);
    await snap.save(session ? { session } : {});
    return snap;
  },

  /**
   * Find a snapshot by _id.
   */
  async findById(id, session = null) {
    const q = PayrollSnapshot.findById(id);
    if (session) q.session(session);
    return q.exec();
  },

  /**
   * Find the single snapshot for a specific run + employee combination.
   * Returns null if none exists.
   */
  async findByRunAndEmployee(payrollRunId, employeeId, session = null) {
    const q = PayrollSnapshot.findOne({
      payrollRunId,
      'employeeSnapshot.employeeId': new mongoose.Types.ObjectId(employeeId),
    });
    if (session) q.session(session);
    return q.exec();
  },

  /**
   * List all snapshots for a run (paginated).
   *
   * @param {string|ObjectId} payrollRunId
   * @param {object} [opts]
   * @param {string}  [opts.snapshotStatus]
   * @param {number}  [opts.limit=50]
   * @param {number}  [opts.skip=0]
   * @returns {Promise<PayrollSnapshot[]>}
   */
  async findByRun(payrollRunId, opts = {}) {
    const { snapshotStatus, limit = 50, skip = 0 } = opts;
    const filter = { payrollRunId };
    if (snapshotStatus) filter.snapshotStatus = snapshotStatus;

    return PayrollSnapshot.find(filter)
      .sort({ 'employeeSnapshot.fullName': 1 })
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();
  },

  /**
   * List snapshots for an employee (payslip history), paginated.
   *
   * @param {string|ObjectId} employeeId
   * @param {object} [opts]
   * @param {number}  [opts.limit=12]
   * @param {number}  [opts.skip=0]
   */
  async findByEmployee(employeeId, opts = {}) {
    const { limit = 12, skip = 0 } = opts;
    return PayrollSnapshot.find({
      'employeeSnapshot.employeeId': new mongoose.Types.ObjectId(employeeId),
    })
      .sort({ periodYear: -1, periodMonth: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();
  },

  /**
   * Count all snapshots for a run (optionally by status).
   */
  async countByRun(payrollRunId, snapshotStatus = null) {
    const filter = { payrollRunId };
    if (snapshotStatus) filter.snapshotStatus = snapshotStatus;
    return PayrollSnapshot.countDocuments(filter);
  },

  /**
   * Count FINALIZED snapshots for a run.
   */
  async countFinalizedByRun(payrollRunId) {
    return this.countByRun(payrollRunId, 'FINALIZED');
  },

  /**
   * Detect duplicate employee snapshots in a run (should return empty array).
   * @returns {Promise<string[]>} employeeIds that appear more than once
   */
  async findDuplicates(payrollRunId) {
    const results = await PayrollSnapshot.aggregate([
      { $match: { payrollRunId: new mongoose.Types.ObjectId(payrollRunId) } },
      { $group: { _id: '$employeeSnapshot.employeeId', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ]);
    return results.map(r => r._id.toString());
  },

  /**
   * Mark a single snapshot as FINALIZED.
   * Only transitions from PENDING_FINALIZATION → FINALIZED.
   * Uses atomic conditional update for safety.
   *
   * @param {string|ObjectId} snapshotId
   * @param {string|ObjectId} finalizedBy - actor _id
   * @param {ClientSession} [session]
   * @returns {Promise<PayrollSnapshot|null>} - null if already finalized or not found
   */
  async markFinalized(snapshotId, finalizedBy, session = null) {
    const options = { new: true };
    if (session) options.session = session;

    return PayrollSnapshot.findOneAndUpdate(
      { _id: snapshotId, snapshotStatus: 'PENDING_FINALIZATION' },
      { $set: { snapshotStatus: 'FINALIZED', finalizedAt: new Date(), finalizedBy } },
      options
    ).exec();
  },

  /**
   * Bulk mark all PENDING_FINALIZATION snapshots for a run as FINALIZED.
   * Used inside the finalization transaction.
   *
   * @param {string|ObjectId} payrollRunId
   * @param {string|ObjectId} finalizedBy
   * @param {ClientSession} session - REQUIRED (called inside transaction)
   * @returns {Promise<{ modifiedCount: number }>}
   */
  async bulkMarkFinalized(payrollRunId, finalizedBy, session) {
    return PayrollSnapshot.updateMany(
      { payrollRunId, snapshotStatus: 'PENDING_FINALIZATION' },
      { $set: { snapshotStatus: 'FINALIZED', finalizedAt: new Date(), finalizedBy } },
      { session }
    );
  },
};

export default payrollSnapshotRepository;
