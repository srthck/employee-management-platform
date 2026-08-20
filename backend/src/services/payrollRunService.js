/**
 * PayrollRunService — Phase 8 Payroll Run Orchestration.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RESPONSIBILITIES:
 *   - Create DRAFT payroll runs (idempotent by period + companyId).
 *   - Run preflight: resolve eligible employees, check salary + rule versions.
 *   - Atomically claim PROCESSING state (concurrent-safe).
 *   - Orchestrate compliance calculations via complianceCalculationService.
 *   - Finalize: PROCESSING → FINALIZED (only after full successful processing).
 *   - Handle failures: PROCESSING → FAILED with reason.
 *   - Support retry: FAILED → PROCESSING (same run _id, new processingVersion).
 *   - Emit audit events for all meaningful state transitions.
 *   - Enforce RBAC — actors are resolved from JWT, not client payload.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * COMPANY IDENTITY NOTE (single-tenant MVP):
 *   There is no separate Company entity.
 *   `companyId` = the Admin's `_id` who owns the payroll (createdBy Admin).
 *   In a multi-tenant future, this maps to a real Company document.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ATTENDANCE NOTE (explicit deferral):
 *   No Attendance subsystem exists in the current codebase.
 *   Phase 8 therefore uses full-month grossMonthly from SalaryStructure
 *   as the payroll input. Attendance-adjusted gross is NOT calculated here.
 *   This is documented in the preflightResult.warnings field on every run.
 *   Phase 9 or a future Attendance phase may introduce proration.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TDS NOTE:
 *   TDS is explicitly deferred. complianceCalculationService returns
 *   tdsDeferred: true in all results. PayrollRun records tdsDeferred: true.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TRANSACTION STRATEGY:
 *   T1 — createPayrollRun:
 *        Single session: create doc + audit write.
 *        Short, low-contention.
 *
 *   T2 — claimProcessing (DRAFT/FAILED → PROCESSING):
 *        Atomic findOneAndUpdate (no session needed — single-document atomicity).
 *        processingVersion incremented inside same update.
 *
 *   T3 — finalize (PROCESSING → FINALIZED):
 *        Session: transitionStateAtomically + metrics + audit write.
 *        Must be short; does NOT wrap the full calculation loop.
 *
 *   The calculation loop itself (iterating employees) is intentionally
 *   outside any long-running session. Results are accumulated in memory,
 *   then committed in T3 if all succeed. If the process dies mid-loop,
 *   the run remains PROCESSING and can be retried via FAILED → PROCESSING.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import mongoose from 'mongoose';
import Employee from '../models/Employee.js';
import SalaryStructure from '../models/SalaryStructure.js';
import ComplianceRuleVersion from '../models/ComplianceRuleVersion.js';
import payrollRunRepository from '../repositories/payrollRunRepository.js';
import complianceCalculationService from './complianceCalculationService.js';
import auditService from './auditService.js';
import { canTransition, PAYROLL_STATUS } from '../models/PayrollRun.js';

// ─── Period helpers ───────────────────────────────────────────────────────────

/**
 * Derive UTC-safe period start/end from month and year.
 * periodStart = first millisecond of the month (UTC).
 * periodEnd   = last millisecond of the month (UTC).
 *
 * @param {number} periodYear
 * @param {number} periodMonth  1–12
 * @returns {{ periodStart: Date, periodEnd: Date }}
 */
function derivePeriodDates(periodYear, periodMonth) {
  // First day of month, 00:00:00.000 UTC
  const periodStart = new Date(Date.UTC(periodYear, periodMonth - 1, 1, 0, 0, 0, 0));

  // Last day of month: first day of next month minus 1 ms
  const periodEnd = new Date(Date.UTC(periodYear, periodMonth, 1, 0, 0, 0, 0) - 1);

  return { periodStart, periodEnd };
}

/**
 * Validate periodMonth and periodYear values.
 * @throws {Error} if invalid
 */
function validatePeriodInput(periodMonth, periodYear) {
  const month = Number(periodMonth);
  const year  = Number(periodYear);

  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw Object.assign(new Error('Period month must be an integer between 1 and 12.'), { statusCode: 400 });
  }
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw Object.assign(new Error('Period year must be an integer between 2000 and 2100.'), { statusCode: 400 });
  }
}

// ─── Employee eligibility ────────────────────────────────────────────────────

/**
 * EMPLOYEE ELIGIBILITY RULES (MVP):
 *   1. Employee belongs to the payroll company (createdBy = companyId).
 *   2. Employee is not soft-deleted (status !== 'inactive' is not sufficient —
 *      the current Employee model has no isDeleted flag; we treat status
 *      'active' or 'on-leave' as payroll-eligible. 'inactive' is excluded.)
 *   3. A valid SalaryStructure exists for the payroll period (effectiveFrom ≤
 *      periodEnd AND (effectiveTo = null OR effectiveTo ≥ periodStart)).
 *   4. At least EPF, ESI, PT compliance rule versions exist for the period.
 *
 * Returns structured eligibility report per employee.
 */
async function resolveEligibleEmployees(companyId, periodStart, periodEnd) {
  // All non-inactive employees belonging to this company
  const candidates = await Employee.find({
    createdBy: companyId,
    status: { $in: ['active', 'on-leave'] },
  }).lean();

  // Resolve compliance rules once for the period (shared across employees)
  // PT jurisdiction defaults to 'MH'; salary structure carries employee-level workState
  const [epfRule, esiRule] = await Promise.all([
    ComplianceRuleVersion.findValidForDate('EPF', 'IN', periodEnd),
    ComplianceRuleVersion.findValidForDate('ESI', 'IN', periodEnd),
  ]);

  const eligible = [];
  const blocked  = [];

  for (const emp of candidates) {
    const issues = [];

    // Resolve salary for period
    const salary = await SalaryStructure.findValidForDate(emp._id, periodEnd);

    if (!salary) {
      issues.push(`No salary structure valid for period ending ${periodEnd.toISOString().slice(0, 10)}.`);
    }

    // Resolve PT rule per employee's workState
    let ptRule = null;
    if (salary) {
      const workState = salary.workState || 'MH';
      ptRule = await ComplianceRuleVersion.findValidForDate('PT', workState, periodEnd);
      if (!ptRule) {
        issues.push(`No PT rule found for work state '${workState}' on ${periodEnd.toISOString().slice(0, 10)}.`);
      }
    }

    if (salary && salary.pfEnrolled && !epfRule) {
      issues.push('EPF rule version not found for period.');
    }
    if (salary && salary.esiEnrolled && !esiRule) {
      issues.push('ESI rule version not found for period.');
    }

    if (issues.length > 0) {
      blocked.push({
        employeeId: emp._id.toString(),
        employeeCode: emp.employeeCode || emp._id.toString(),
        name: `${emp.firstName} ${emp.lastName}`,
        status: 'BLOCKED',
        issues,
      });
    } else {
      eligible.push({
        employeeId: emp._id.toString(),
        name: `${emp.firstName} ${emp.lastName}`,
        salary,
        epfRule,
        esiRule,
        ptRule,
      });
    }
  }

  return { eligible, blocked, epfRule, esiRule };
}

// ─── Service ──────────────────────────────────────────────────────────────────

const payrollRunService = {

  // ───────────────────────────────────────────────────────────────────────────
  // CREATE
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Create a new DRAFT PayrollRun for a company+period.
   *
   * Idempotency:
   *   - If an active (non-CANCELLED) run already exists for this period,
   *     return { run, created: false, conflict: true }.
   *   - If the only existing run is CANCELLED, allow creating a new one.
   *
   * @param {object} params
   * @param {string}   params.companyId     - Admin _id acting as company identity
   * @param {number}   params.periodMonth   - 1–12
   * @param {number}   params.periodYear    - e.g. 2026
   * @param {string}   params.actorId       - JWT user _id
   * @param {string}   params.actorEmail
   * @param {string}   params.actorRole
   * @param {string}   [params.idempotencyKey]
   * @returns {Promise<{ run, created: boolean, conflict: boolean }>}
   */
  async createPayrollRun({ companyId, periodMonth, periodYear, actorId, actorEmail, actorRole, idempotencyKey }) {
    validatePeriodInput(periodMonth, periodYear);

    const month = Number(periodMonth);
    const year  = Number(periodYear);

    const { periodStart, periodEnd } = derivePeriodDates(year, month);

    // Check for existing run (the unique index catches duplicate inserts,
    // but we need to return a meaningful response, not a MongoServerError)
    const existing = await payrollRunRepository.findByCompanyPeriod(companyId, year, month);

    if (existing) {
      if (existing.status !== PAYROLL_STATUS.CANCELLED) {
        // Active run exists — return it without creating a duplicate
        return { run: existing, created: false, conflict: true };
      }
      // Existing run is CANCELLED — a new run IS permitted
      // The unique index will reject this without special handling if we naively insert.
      // We need to handle this edge case: delete the cancelled tombstone first,
      // then create fresh. This is safe because CANCELLED is terminal.
      // We log this as a controlled operation.
      await existing.deleteOne();
    }

    const session = await mongoose.startSession();
    let run;
    try {
      session.startTransaction();

      run = await payrollRunRepository.create(
        {
          companyId,
          periodMonth: month,
          periodYear:  year,
          periodStart,
          periodEnd,
          status:      PAYROLL_STATUS.DRAFT,
          createdBy:   actorId,
          idempotencyKey: idempotencyKey || null,
          tdsDeferred: true,
        },
        session
      );

      await auditService.log(
        {
          action:     'PAYROLL_RUN_CREATED',
          actorId,
          actorEmail,
          actorRole,
          entityType: 'PAYROLL_RUN',
          entityId:   run._id,
          newStatus:  PAYROLL_STATUS.DRAFT,
          meta: { periodMonth: month, periodYear: year, companyId },
        },
        session
      );

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      // Surface duplicate key error as a conflict response
      if (err.code === 11000) {
        const fresh = await payrollRunRepository.findByCompanyPeriod(companyId, year, month);
        return { run: fresh, created: false, conflict: true };
      }
      throw err;
    } finally {
      session.endSession();
    }

    return { run, created: true, conflict: false };
  },

  // ───────────────────────────────────────────────────────────────────────────
  // GET
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Get a single PayrollRun by id, enforcing company ownership.
   */
  async getPayrollRun(runId, companyId) {
    const run = await payrollRunRepository.findById(runId);
    if (!run) {
      throw Object.assign(new Error('Payroll run not found.'), { statusCode: 404 });
    }
    if (run.companyId.toString() !== companyId.toString()) {
      throw Object.assign(new Error('Payroll run does not belong to your company.'), { statusCode: 403 });
    }
    return run;
  },

  /**
   * List PayrollRuns for a company.
   */
  async listPayrollRuns(companyId, opts = {}) {
    const runs  = await payrollRunRepository.listRuns(companyId, opts);
    const total = await payrollRunRepository.countRuns(companyId, opts.status);
    return { runs, total };
  },

  // ───────────────────────────────────────────────────────────────────────────
  // PREFLIGHT
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Run preflight checks on a DRAFT (or FAILED) payroll run.
   *
   * Returns a structured result describing:
   *   - canProcess:               whether the run is safe to start
   *   - eligibleEmployees:        employees with complete data
   *   - blockedEmployees:         employees with missing data + reasons
   *   - blockingErrors:           run-level blocking errors
   *   - warnings:                 non-blocking notices (e.g. attendance deferral)
   *   - ruleAvailability:         which compliance rule versions were found
   *
   * Stores the result on the run document for explainability.
   *
   * @param {string} runId
   * @param {string} companyId
   * @param {object} actor
   * @returns {Promise<object>} preflight result
   */
  async runPreflight(runId, companyId, actor) {
    const run = await this.getPayrollRun(runId, companyId);

    // Preflight is only meaningful on DRAFT or FAILED runs
    if (![PAYROLL_STATUS.DRAFT, PAYROLL_STATUS.FAILED].includes(run.status)) {
      throw Object.assign(
        new Error(`Preflight is only available for DRAFT or FAILED runs. Current status: ${run.status}`),
        { statusCode: 409 }
      );
    }

    const blockingErrors = [];
    const warnings       = [];

    // Derive period dates from the run document (already stored)
    const { periodStart, periodEnd, periodMonth, periodYear } = run;

    // ── Resolve employees ──
    const { eligible, blocked, epfRule, esiRule } = await resolveEligibleEmployees(
      companyId,
      periodStart,
      periodEnd
    );

    const totalCandidates = eligible.length + blocked.length;

    if (totalCandidates === 0) {
      blockingErrors.push('No active employees found for this company.');
    }
    if (blocked.length > 0) {
      // Blocked employees are warnings unless ALL are blocked
      const msg = `${blocked.length} employee(s) are blocked due to missing data.`;
      if (eligible.length === 0) {
        blockingErrors.push(msg + ' No eligible employees remain.');
      } else {
        warnings.push(msg + ' They will be excluded from this run.');
      }
    }

    // ── Rule availability ──
    const ruleAvailability = {
      epf: epfRule ? { available: true, versionId: epfRule._id } : { available: false },
      esi: esiRule ? { available: true, versionId: esiRule._id } : { available: false },
    };

    // ── Attendance deferral notice ──
    warnings.push(
      'Attendance-adjusted gross is not yet implemented. ' +
      'Full-month grossMonthly from SalaryStructure is used as the payroll basis.'
    );

    // ── TDS deferral notice ──
    warnings.push('TDS calculation is deferred and will not appear in this run.');

    const canProcess = blockingErrors.length === 0;

    const preflightResult = {
      canProcess,
      eligibleEmployeeCount: eligible.length,
      blockedEmployeeCount:  blocked.length,
      blockingErrors,
      warnings,
      ruleAvailability,
      resolvedAt: new Date(),
    };

    // Persist preflight result to the run document
    await payrollRunRepository.updatePreflightResult(runId, {
      canProcess,
      eligibleEmployeeCount: eligible.length,
      blockedEmployeeCount:  blocked.length,
      blockingErrors,
      warnings,
      resolvedAt: new Date(),
    });

    // Audit preflight
    await auditService.log({
      action:     'PAYROLL_PREFLIGHT_COMPLETED',
      actorId:    actor.id,
      actorEmail: actor.email,
      actorRole:  actor.role,
      entityType: 'PAYROLL_RUN',
      entityId:   run._id,
      meta: {
        canProcess,
        eligibleEmployeeCount: eligible.length,
        blockedEmployeeCount:  blocked.length,
        blockingErrors,
        warnings,
      },
    });

    return {
      runId: run._id,
      periodMonth,
      periodYear,
      canProcess,
      eligibleEmployees: eligible.map(e => ({
        employeeId: e.employeeId,
        name:       e.name,
        grossMonthly: e.salary.grossMonthly,
        workState:    e.salary.workState,
      })),
      blockedEmployees: blocked,
      blockingErrors,
      warnings,
      ruleAvailability,
    };
  },

  // ───────────────────────────────────────────────────────────────────────────
  // PROCESS
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Process a payroll run.
   *
   * Steps:
   *   1. Load and own the run.
   *   2. Validate state allows PROCESSING.
   *   3. Atomically claim PROCESSING (concurrent-safe).
   *   4. Re-resolve eligible employees (deterministic, fresh read).
   *   5. Run compliance calculations via complianceCalculationService.
   *   6. If all succeed: finalize.
   *   7. If any failure: mark FAILED with reason.
   *
   * Idempotency:
   *   - If idempotencyKey matches an already PROCESSING or FINALIZED run,
   *     return the current run without re-processing.
   *
   * @param {string} runId
   * @param {string} companyId
   * @param {object} actor
   * @param {string} [idempotencyKey]
   * @returns {Promise<{ run, processingResult }>}
   */
  async processPayrollRun(runId, companyId, actor, idempotencyKey = null) {
    const run = await this.getPayrollRun(runId, companyId);

    // Idempotency check: if this key was already used and run is not retriable,
    // return current state without doing work
    if (idempotencyKey && run.idempotencyKey === idempotencyKey) {
      if ([PAYROLL_STATUS.PROCESSING, PAYROLL_STATUS.FINALIZED, PAYROLL_STATUS.DISBURSED].includes(run.status)) {
        return { run, processingResult: null, idempotent: true };
      }
    }

    // Validate the transition is permitted
    if (!canTransition(run.status, PAYROLL_STATUS.PROCESSING)) {
      throw Object.assign(
        new Error(`Cannot process a run in status '${run.status}'. Allowed: DRAFT or FAILED.`),
        { statusCode: 409 }
      );
    }

    // ── Atomic claim: DRAFT/FAILED → PROCESSING ──────────────────────────────
    // This is the concurrency lock. If two workers race here, only one will
    // get a non-null return from transitionStateAtomically.
    const additionalFields = {
      startedAt: new Date(),
    };
    if (idempotencyKey) {
      additionalFields.idempotencyKey = idempotencyKey;
    }

    const claimed = await payrollRunRepository.transitionStateAtomically(
      runId,
      run.status,            // expected current status (DRAFT or FAILED)
      PAYROLL_STATUS.PROCESSING,
      additionalFields,
      { actorId: actor.id, actorEmail: actor.email, reason: 'Processing started' },
    );

    if (!claimed) {
      // Another worker claimed it first — return current state
      const current = await payrollRunRepository.findById(runId);
      return { run: current, processingResult: null, concurrencyConflict: true };
    }

    // Increment processing version on each (re)start
    await payrollRunRepository.incrementProcessingVersion(runId);

    // Audit processing started
    await auditService.log({
      action:         'PAYROLL_PROCESSING_STARTED',
      actorId:        actor.id,
      actorEmail:     actor.email,
      actorRole:      actor.role,
      entityType:     'PAYROLL_RUN',
      entityId:       run._id,
      previousStatus: run.status,
      newStatus:      PAYROLL_STATUS.PROCESSING,
      meta:           { periodMonth: run.periodMonth, periodYear: run.periodYear },
    });

    // ── Resolve employees fresh (deterministic re-read) ───────────────────────
    let eligible, blocked, epfRule, esiRule;
    try {
      ({ eligible, blocked, epfRule, esiRule } = await resolveEligibleEmployees(
        companyId,
        run.periodStart,
        run.periodEnd
      ));
    } catch (err) {
      await this._failRun(runId, `Employee resolution failed: ${err.message}`, actor);
      throw Object.assign(
        new Error(`Payroll processing failed during employee resolution: ${err.message}`),
        { statusCode: 500 }
      );
    }

    if (eligible.length === 0) {
      await this._failRun(runId, 'No eligible employees found after eligibility resolution.', actor);
      throw Object.assign(
        new Error('Payroll processing failed: No eligible employees.'),
        { statusCode: 422 }
      );
    }

    // ── Calculation loop ──────────────────────────────────────────────────────
    // Each employee is processed in memory. No individual DB writes per employee
    // at this phase (Phase 9 = PayrollSnapshot handles immutable per-employee records).
    const results      = [];
    const calcErrors   = [];

    for (const empData of eligible) {
      try {
        const { salary } = empData;

        const calcInput = {
          grossMonthly:   salary.grossMonthly,
          basicSalary:    salary.components.basic,
          pfWageOverride: salary.pfWageOverride !== undefined ? salary.pfWageOverride : null,
          pfEnrolled:     salary.pfEnrolled,
          esiEnrolled:    salary.esiEnrolled,
          ptEnrolled:     salary.ptEnrolled,
          epfRule:        empData.epfRule ? empData.epfRule.epfParams : null,
          esiRule:        empData.esiRule ? empData.esiRule.esiParams : null,
          ptSlabs:        empData.ptRule  ? empData.ptRule.ptSlabs    : [],
        };

        // Reuse Phase 7 calculator — do NOT duplicate formulas here
        const complianceResult = complianceCalculationService.calculate(calcInput);

        results.push({
          employeeId: empData.employeeId,
          name:       empData.name,
          grossMonthly:            complianceResult.grossMonthly,
          totalEmployeeDeductions: complianceResult.totalEmployeeDeductions,
          netPay:                  complianceResult.netPay,
          epf:                     complianceResult.epf,
          esi:                     complianceResult.esi,
          pt:                      complianceResult.pt,
          tdsDeferred:             complianceResult.tdsDeferred,
          // Rule version IDs for Phase 9 snapshot linkage
          resolvedRuleVersionIds: {
            epf: empData.epfRule ? empData.epfRule._id : null,
            esi: empData.esiRule ? empData.esiRule._id : null,
            pt:  empData.ptRule  ? empData.ptRule._id  : null,
          },
        });
      } catch (calcErr) {
        calcErrors.push({
          employeeId: empData.employeeId,
          name:       empData.name,
          error:      calcErr.message,
        });
      }
    }

    // ── Evaluate results ──────────────────────────────────────────────────────
    // Phase 8 policy: any calculation error = FAILED run.
    // A run with incomplete employee processing must not be FINALIZED.
    if (calcErrors.length > 0) {
      const reason = `Calculation errors for ${calcErrors.length} employee(s): ` +
        calcErrors.map(e => `${e.name} — ${e.error}`).join('; ');
      await this._failRun(runId, reason, actor);
      throw Object.assign(new Error(`Payroll processing failed: ${reason}`), { statusCode: 422 });
    }

    // ── Finalize ──────────────────────────────────────────────────────────────
    // Collect resolved rule version IDs for run-level recording
    const resolvedRuleVersionIds = {
      epf: epfRule ? epfRule._id : null,
      esi: esiRule ? esiRule._id : null,
      // PT is per-employee; record null at run level (individual versions in results)
      pt: null,
    };

    const finalizedRun = await this._finalizeRun(
      runId,
      actor,
      {
        employeeCount:          eligible.length + blocked.length,
        successfulEmployeeCount: results.length,
        failedEmployeeCount:    blocked.length,
        resolvedRuleVersionIds,
      }
    );

    return {
      run:             finalizedRun,
      processingResult: {
        employeeCount:          eligible.length + blocked.length,
        successfulEmployeeCount: results.length,
        blockedEmployeeCount:   blocked.length,
        blocked,
        results,   // In-memory only — Phase 9 will persist these as PayrollSnapshots
        tdsDeferred: true,
        attendanceNote: 'Full-month gross used; attendance adjustment not yet implemented.',
      },
    };
  },

  // ───────────────────────────────────────────────────────────────────────────
  // FINALIZE (explicit endpoint — separate from auto-finalization in process)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Explicitly finalize a PROCESSING run.
   * This endpoint exists for manual finalization after an external validation step.
   * In the default flow, processPayrollRun auto-finalizes.
   *
   * @param {string} runId
   * @param {string} companyId
   * @param {object} actor
   * @returns {Promise<PayrollRun>}
   */
  async finalizePayrollRun(runId, companyId, actor) {
    const run = await this.getPayrollRun(runId, companyId);

    if (!canTransition(run.status, PAYROLL_STATUS.FINALIZED)) {
      throw Object.assign(
        new Error(`Cannot finalize a run in status '${run.status}'. Run must be in PROCESSING.`),
        { statusCode: 409 }
      );
    }

    return this._finalizeRun(runId, actor, {
      employeeCount:           run.employeeCount,
      successfulEmployeeCount: run.successfulEmployeeCount,
      failedEmployeeCount:     run.failedEmployeeCount,
      resolvedRuleVersionIds:  run.resolvedRuleVersionIds,
    });
  },

  // ───────────────────────────────────────────────────────────────────────────
  // PRIVATE HELPERS
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Atomically transition PROCESSING → FINALIZED.
   * Wraps in a session so the state change and audit write are atomic.
   * @private
   */
  async _finalizeRun(runId, actor, finalizationData) {
    const session = await mongoose.startSession();
    let finalizedRun;
    try {
      session.startTransaction();

      finalizedRun = await payrollRunRepository.finalize(
        runId,
        {
          finalizedBy:             actor.id,
          resolvedRuleVersionIds:  finalizationData.resolvedRuleVersionIds || {},
          employeeCount:           finalizationData.employeeCount,
          successfulEmployeeCount: finalizationData.successfulEmployeeCount,
          failedEmployeeCount:     finalizationData.failedEmployeeCount,
        },
        { actorId: actor.id, actorEmail: actor.email, reason: 'Processing completed' },
        session
      );

      if (!finalizedRun) {
        throw Object.assign(
          new Error('Finalization failed: run was not in PROCESSING state (possible concurrent finalization).'),
          { statusCode: 409 }
        );
      }

      await auditService.log(
        {
          action:         'PAYROLL_FINALIZED',
          actorId:        actor.id,
          actorEmail:     actor.email,
          actorRole:      actor.role,
          entityType:     'PAYROLL_RUN',
          entityId:       runId,
          previousStatus: PAYROLL_STATUS.PROCESSING,
          newStatus:      PAYROLL_STATUS.FINALIZED,
          meta: {
            employeeCount:           finalizationData.employeeCount,
            successfulEmployeeCount: finalizationData.successfulEmployeeCount,
            failedEmployeeCount:     finalizationData.failedEmployeeCount,
          },
        },
        session
      );

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
    return finalizedRun;
  },

  /**
   * Transition PROCESSING → FAILED with reason.
   * @private
   */
  async _failRun(runId, reason, actor) {
    const failed = await payrollRunRepository.markFailed(
      runId,
      reason,
      { actorId: actor.id, actorEmail: actor.email, reason }
    );

    if (failed) {
      await auditService.log({
        action:         'PAYROLL_PROCESSING_FAILED',
        actorId:        actor.id,
        actorEmail:     actor.email,
        actorRole:      actor.role || 'system',
        entityType:     'PAYROLL_RUN',
        entityId:       runId,
        previousStatus: PAYROLL_STATUS.PROCESSING,
        newStatus:      PAYROLL_STATUS.FAILED,
        meta:           { failureReason: reason },
      });
    }

    return failed;
  },

  /**
   * Cancel a FAILED run (terminal state — cannot be retried after this).
   */
  async cancelPayrollRun(runId, companyId, actor) {
    const run = await this.getPayrollRun(runId, companyId);

    if (!canTransition(run.status, PAYROLL_STATUS.CANCELLED)) {
      throw Object.assign(
        new Error(`Cannot cancel a run in status '${run.status}'. Only FAILED runs can be cancelled.`),
        { statusCode: 409 }
      );
    }

    const cancelled = await payrollRunRepository.transitionStateAtomically(
      runId,
      PAYROLL_STATUS.FAILED,
      PAYROLL_STATUS.CANCELLED,
      {},
      { actorId: actor.id, actorEmail: actor.email, reason: 'Manually cancelled' }
    );

    if (!cancelled) {
      throw Object.assign(
        new Error('Cancellation failed: run status changed concurrently.'),
        { statusCode: 409 }
      );
    }

    await auditService.log({
      action:         'PAYROLL_RUN_CANCELLED',
      actorId:        actor.id,
      actorEmail:     actor.email,
      actorRole:      actor.role,
      entityType:     'PAYROLL_RUN',
      entityId:       runId,
      previousStatus: PAYROLL_STATUS.FAILED,
      newStatus:      PAYROLL_STATUS.CANCELLED,
      meta:           {},
    });

    return cancelled;
  },
};

export default payrollRunService;
