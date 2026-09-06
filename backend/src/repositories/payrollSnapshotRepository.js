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
 *
 *   These methods are absent by design.
 *
 *   The ONLY writable methods after snapshot creation are:
 *     - markFinalized()
 *     - bulkMarkFinalized()
 *
 *   These only perform the controlled transition:
 *
 *     PENDING_FINALIZATION → FINALIZED
 *
 * ─── EXPOSED METHODS ────────────────────────────────────────────────────────
 *   create
 *   findById
 *   findByRunAndEmployee
 *   findByRun
 *   findByEmployee
 *   countByRun
 *   countFinalizedByRun
 *   findDuplicates
 *   markFinalized
 *   bulkMarkFinalized
 *
 * ─── EMPLOYEE SELF-SERVICE ─────────────────────────────────────────────────
 *   findByEmployee() supports an optional snapshotStatus filter.
 *
 *   This allows employee self-service to request:
 *
 *     snapshotStatus: 'FINALIZED'
 *
 *   so employees only see finalized payroll snapshots.
 */

const payrollSnapshotRepository = {
  /**
   * Create a new immutable payroll snapshot.
   *
   * New snapshots always begin as PENDING_FINALIZATION.
   */
  async create(data, session = null) {
    const snap = new PayrollSnapshot(data);

    await snap.save(session ? { session } : {});

    return snap;
  },

  /**
   * Find a snapshot by its MongoDB ID.
   */
  async findById(id, session = null) {
    const q = PayrollSnapshot.findById(id);

    if (session) {
      q.session(session);
    }

    return q.exec();
  },

  /**
   * Find one snapshot belonging to a specific payroll run
   * and employee.
   */
  async findByRunAndEmployee(payrollRunId, employeeId, session = null) {
    const q = PayrollSnapshot.findOne({
      payrollRunId,
      'employeeSnapshot.employeeId': new mongoose.Types.ObjectId(employeeId),
    });

    if (session) {
      q.session(session);
    }

    return q.exec();
  },

  /**
   * Find snapshots belonging to a payroll run.
   *
   * Optional snapshotStatus filter is supported.
   */
  async findByRun(payrollRunId, opts = {}) {
    const {
      snapshotStatus = null,
      limit = 50,
      skip = 0,
    } = opts;

    const filter = {
      payrollRunId,
    };

    if (snapshotStatus) {
      filter.snapshotStatus = snapshotStatus;
    }

    return PayrollSnapshot.find(filter)
      .sort({ 'employeeSnapshot.fullName': 1 })
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();
  },

  /**
   * Find payroll snapshot history for an employee.
   *
   * snapshotStatus is optional.
   *
   * Examples:
   *
   *   findByEmployee(employeeId)
   *
   *   findByEmployee(employeeId, {
   *     snapshotStatus: 'FINALIZED'
   *   })
   */
  async findByEmployee(employeeId, opts = {}) {
    const {
      snapshotStatus = null,
      limit = 12,
      skip = 0,
    } = opts;

    const filter = {
      'employeeSnapshot.employeeId': new mongoose.Types.ObjectId(employeeId),
    };

    if (snapshotStatus) {
      filter.snapshotStatus = snapshotStatus;
    }

    return PayrollSnapshot.find(filter)
      .sort({ periodYear: -1, periodMonth: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();
  },

  /**
   * Count snapshots belonging to a payroll run.
   *
   * Optional snapshotStatus filter is supported.
   */
  async countByRun(payrollRunId, snapshotStatus = null) {
    const filter = {
      payrollRunId,
    };

    if (snapshotStatus) {
      filter.snapshotStatus = snapshotStatus;
    }

    return PayrollSnapshot.countDocuments(filter);
  },

  /**
   * Count finalized snapshots belonging to a payroll run.
   */
  async countFinalizedByRun(payrollRunId) {
    return this.countByRun(payrollRunId, 'FINALIZED');
  },

  /**
   * Detect duplicate employee snapshots within a payroll run.
   */
  async findDuplicates(payrollRunId) {
    const results = await PayrollSnapshot.aggregate([
      {
        $match: {
          payrollRunId: new mongoose.Types.ObjectId(payrollRunId),
        },
      },
      {
        $group: {
          _id: '$employeeSnapshot.employeeId',
          count: { $sum: 1 },
        },
      },
      {
        $match: {
          count: { $gt: 1 },
        },
      },
    ]);

    return results.map((r) => r._id.toString());
  },

  /**
   * Finalize one snapshot.
   *
   * Only a PENDING_FINALIZATION snapshot can be finalized.
   */
  async markFinalized(snapshotId, finalizedBy, session = null) {
    const options = {
      new: true,
    };

    if (session) {
      options.session = session;
    }

    return PayrollSnapshot.findOneAndUpdate(
      {
        _id: snapshotId,
        snapshotStatus: 'PENDING_FINALIZATION',
      },
      {
        $set: {
          snapshotStatus: 'FINALIZED',
          finalizedAt: new Date(),
          finalizedBy,
        },
      },
      options
    ).exec();
  },

  /**
   * Finalize all pending snapshots belonging to a payroll run.
   *
   * Used by Phase 9 finalization transaction.
   */
  async bulkMarkFinalized(payrollRunId, finalizedBy, session) {
    return PayrollSnapshot.updateMany(
      {
        payrollRunId,
        snapshotStatus: 'PENDING_FINALIZATION',
      },
      {
        $set: {
          snapshotStatus: 'FINALIZED',
          finalizedAt: new Date(),
          finalizedBy,
        },
      },
      {
        session,
      }
    );
  },
};

export default payrollSnapshotRepository;