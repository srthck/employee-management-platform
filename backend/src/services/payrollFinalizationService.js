import Company from '../models/Company.js';
import { PAYROLL_STATUS } from '../models/PayrollRun.js';
import payrollRunRepository from '../repositories/payrollRunRepository.js';
import payrollSnapshotService from './payrollSnapshotService.js';
import payrollInsightsService from './payrollInsightsService.js';
import auditService from './auditService.js';
import config from '../config/environment.js';
import { hasPermission, PERMISSIONS } from '../utils/permissions.js';

/**
 * payrollFinalizationService — the control layer above the payroll state machine.
 *
 * The state machine (DRAFT → … → READY_FOR_FINALIZATION → FINALIZED) stays the
 * canonical record of where a run is. This layer decides whether a specific
 * person may move it to FINALIZED right now:
 *
 *   1. Ownership and state        the run belongs to the company and is ready
 *   2. Segregation of duties      under maker_checker, whoever calculated the
 *                                 run cannot finalize it
 *   3. Variance gate              unexplained or invalid pay results block
 *                                 finalization; unexplained ones may be
 *                                 overridden with a recorded reason by a user
 *                                 holding payroll.variance.override
 *   4. Snapshot path              materialize → completeness/hash checks →
 *                                 atomic finalization
 *
 * Who prepared, who approved, the variance summary and any override are stored
 * on the run and in the PAYROLL_FINALIZED audit event, in the same transaction
 * as the finalization itself.
 */

const OVERRIDE_REASON_MIN_LENGTH = 15;

const controlError = (message, statusCode, code, extra = {}) =>
  Object.assign(new Error(message), { statusCode, code, ...extra });

/** Actor who moved the run into READY_FOR_FINALIZATION most recently (the preparer). */
const preparerOf = (run) => {
  const transition = [...(run.transitions || [])]
    .reverse()
    .find((entry) => entry.toStatus === PAYROLL_STATUS.READY_FOR_FINALIZATION);
  return transition ? String(transition.actorId) : null;
};

const flagSummary = (flag) => ({
  code: flag.code,
  severity: flag.severity,
  classification: flag.classification,
  employeeId: flag.employeeId,
  employeeName: flag.employeeName,
  message: flag.message,
  overridable: flag.overridable,
});

const payrollFinalizationService = {
  async getControls(companyId) {
    const company = await Company.findById(companyId).lean();
    const settings = company?.settings || {};
    return {
      approvalMode: settings.approvalMode || 'single',
      varianceThresholdPercent: settings.varianceThresholdPercent ?? config.varianceThresholdPercent,
      blockFinalizationOnUnexplainedVariance: settings.blockFinalizationOnUnexplainedVariance ?? true,
    };
  },

  async _loadReadyRun(runId, companyId) {
    const run = await payrollRunRepository.findById(runId);
    if (!run || String(run.companyId) !== String(companyId)) {
      throw controlError('Payroll run not found.', 404, 'NOT_FOUND');
    }
    return run;
  },

  /**
   * Evaluate every control for this actor without changing anything.
   * The UI uses this to explain why finalization is or is not available.
   */
  async getReadiness(runId, companyId, actor) {
    const run = await this._loadReadyRun(runId, companyId);
    const controls = await this.getControls(companyId);
    const preparedBy = preparerOf(run);
    const blockers = [];

    if (run.status !== PAYROLL_STATUS.READY_FOR_FINALIZATION) {
      blockers.push({ code: 'PAYROLL_STATE_CONFLICT', message: `Run is ${run.status}, not READY_FOR_FINALIZATION.` });
    }
    if (!hasPermission(actor, PERMISSIONS.PAYROLL_FINALIZE)) {
      blockers.push({ code: 'FORBIDDEN', message: 'You do not have permission to finalize payroll.' });
    }
    if (controls.approvalMode === 'maker_checker' && preparedBy && preparedBy === String(actor.id)) {
      blockers.push({ code: 'SEGREGATION_OF_DUTIES', message: 'You calculated this run; a different approver must finalize it.' });
    }

    let blockingFlags = [];
    if (run.status === PAYROLL_STATUS.READY_FOR_FINALIZATION) {
      const report = await payrollInsightsService.getVarianceReport(runId, companyId, {
        thresholdPercent: controls.varianceThresholdPercent,
      });
      blockingFlags = report.flags.filter((f) => f.blocking).map(flagSummary);
    }

    const invalid = blockingFlags.filter((f) => !f.overridable);
    const overridable = blockingFlags.filter((f) => f.overridable);
    if (invalid.length > 0) {
      blockers.push({ code: 'PAYROLL_RESULT_INVALID', message: `${invalid.length} result(s) cannot be paid and must be corrected.` });
    }
    const requiresOverride = controls.blockFinalizationOnUnexplainedVariance && overridable.length > 0;

    return {
      runId: String(run._id),
      status: run.status,
      controls,
      preparedBy,
      blockingFlags,
      blockers,
      requiresOverride,
      canOverride: hasPermission(actor, PERMISSIONS.PAYROLL_VARIANCE_OVERRIDE),
      canFinalize: blockers.length === 0 && (!requiresOverride || hasPermission(actor, PERMISSIONS.PAYROLL_VARIANCE_OVERRIDE)),
    };
  },

  /**
   * @param {{ override?: { reason: string } | null }} options
   * @returns {Promise<{ run: object, snapshotCount: number }>}
   */
  async finalize(runId, companyId, actor, { override = null } = {}) {
    const run = await this._loadReadyRun(runId, companyId);

    if (run.status !== PAYROLL_STATUS.READY_FOR_FINALIZATION) {
      throw controlError(
        `Cannot finalize a run in status '${run.status}'. Run must be READY_FOR_FINALIZATION.`,
        409,
        'PAYROLL_STATE_CONFLICT'
      );
    }

    const controls = await this.getControls(companyId);
    const preparedBy = preparerOf(run);

    if (controls.approvalMode === 'maker_checker' && preparedBy && preparedBy === String(actor.id)) {
      throw controlError(
        'Maker-checker is enabled: the person who calculated this run cannot finalize it. A different approver must finalize.',
        403,
        'SEGREGATION_OF_DUTIES'
      );
    }

    const report = await payrollInsightsService.getVarianceReport(runId, companyId, {
      thresholdPercent: controls.varianceThresholdPercent,
    });
    const blockingFlags = report.flags.filter((f) => f.blocking);
    const invalid = blockingFlags.filter((f) => !f.overridable);
    const overridable = blockingFlags.filter((f) => f.overridable);

    if (invalid.length > 0) {
      throw controlError(
        `Finalization blocked: ${invalid.length} pay result(s) cannot be paid. Correct the inputs and recalculate.`,
        409,
        'PAYROLL_RESULT_INVALID',
        { blockingFlags: invalid.map(flagSummary) }
      );
    }

    let overrideRecord = null;
    if (controls.blockFinalizationOnUnexplainedVariance && overridable.length > 0) {
      if (!override) {
        throw controlError(
          `Finalization blocked: ${overridable.length} unexplained pay change(s) need review. Correct them and recalculate, or record an override.`,
          409,
          'VARIANCE_UNEXPLAINED',
          { blockingFlags: overridable.map(flagSummary) }
        );
      }
      if (!hasPermission(actor, PERMISSIONS.PAYROLL_VARIANCE_OVERRIDE)) {
        throw controlError('Overriding a variance block requires the payroll.variance.override permission.', 403, 'FORBIDDEN');
      }
      const reason = typeof override.reason === 'string' ? override.reason.trim() : '';
      if (reason.length < OVERRIDE_REASON_MIN_LENGTH) {
        throw controlError(
          `An override needs a reason of at least ${OVERRIDE_REASON_MIN_LENGTH} characters.`,
          422,
          'OVERRIDE_REASON_REQUIRED'
        );
      }
      overrideRecord = {
        reason,
        by: String(actor.id),
        byEmail: actor.email,
        at: new Date(),
        flags: overridable.map(flagSummary),
      };
    }

    const materialization = await payrollSnapshotService.materializeSnapshots(runId, companyId, actor);
    if (materialization.conflicts > 0 || materialization.errors > 0) {
      throw controlError(
        `Finalization blocked: ${materialization.conflicts} snapshot conflict(s) and ` +
        `${materialization.errors} materialization error(s). Human review required.`,
        409,
        'SNAPSHOT_CONFLICT',
        { details: materialization }
      );
    }

    const finalizationControls = {
      approvalMode: controls.approvalMode,
      preparedBy,
      approvedBy: String(actor.id),
      variance: {
        baselineRunId: report.baseline?.runId || null,
        thresholdPercent: report.thresholdPercent,
        counts: report.counts,
      },
      override: overrideRecord,
    };

    // The override event is written inside the finalization transaction (all-or-nothing with it).
    const extraAuditEvents = overrideRecord
      ? [{
        action: 'PAYROLL_VARIANCE_OVERRIDDEN',
        actorId: actor.id,
        actorEmail: actor.email,
        actorRole: actor.role,
        entityType: 'PAYROLL_RUN',
        entityId: runId,
        companyId,
        meta: { reason: overrideRecord.reason, flags: overrideRecord.flags },
      }]
      : [];

    return payrollSnapshotService.finalizeRun(runId, companyId, actor, { finalizationControls, extraAuditEvents });
  },
};

export default payrollFinalizationService;
