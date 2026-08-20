/**
 * PayrollRunService — Phase 8 Corrected Payroll Run Orchestration.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CORRECTIONS APPLIED IN THIS PASS:
 *
 *   C1. READY_FOR_FINALIZATION state added between PROCESSING and FINALIZED.
 *       PROCESSING → FINALIZED direct transition is forbidden.
 *
 *   C2. Durable staging boundary: every employee's calculation result is
 *       written to PayrollStagingResult before the run advances to
 *       READY_FOR_FINALIZATION. Process crash cannot produce FINALIZED
 *       without evidence.
 *
 *   C3. Completeness verification before READY_FOR_FINALIZATION:
 *       durableCount == expectedSuccessful, zero duplicates.
 *
 *   C4. Silent Maharashtra fallback REMOVED. workState = null/empty/unsupported
 *       blocks the employee with MISSING_PT_JURISDICTION or
 *       UNSUPPORTED_PT_JURISDICTION. No default state is ever assumed.
 *
 *   C5. finalizePayrollRun (explicit endpoint) now requires the run to be in
 *       READY_FOR_FINALIZATION, not PROCESSING. Phase 9 will own the actual
 *       READY_FOR_FINALIZATION → FINALIZED transition.
 *
 *   C6. lastActivityAt heartbeat updated during calculation loop for
 *       crash-detection. Recovery documentation added.
 *
 *   C7. Retry cleanup: on FAILED → PROCESSING, stale staging results from
 *       the previous attempt are deleted before re-processing.
 *
 *   C8. attendanceAdjustment = 'DEFERRED' is explicitly set and surfaced
 *       in all processing results. The word "attendance-adjusted" is never
 *       used to describe full-month gross.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * COMPANY IDENTITY (single-tenant MVP):
 *   companyId = Admin._id of the authenticated actor.
 *   FUTURE: replace with real Company entity in multi-tenant architecture.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * STATE MACHINE (this service):
 *   DRAFT → PROCESSING → READY_FOR_FINALIZATION → (Phase 9) → FINALIZED
 *                      ↘ FAILED → PROCESSING (retry)
 *                                ↘ CANCELLED
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TRANSACTION STRATEGY:
 *   T1 — createPayrollRun:
 *        Session: create PayrollRun + audit write. Short, low-contention.
 *
 *   T2 — claimProcessing (DRAFT/FAILED → PROCESSING):
 *        Atomic findOneAndUpdate. Single-document atomic — no session needed.
 *        Old staging results deleted in the same logical step (not in a
 *        transaction, since deletion failure does not corrupt the run — it
 *        only affects cleanup; a unique index on (runId, employeeId, version)
 *        prevents duplicate staging writes anyway).
 *
 *   T3 — markReadyForFinalization (PROCESSING → READY_FOR_FINALIZATION):
 *        Session: completeness verified + atomic state transition + audit.
 *        Staging result writes happen outside this session (T-loop below).
 *        The session is short.
 *
 *   T-loop — Per-employee staging result persistence:
 *        Intentionally outside any long-running session.
 *        Uses upsert(runId, employeeId, processingVersion) — idempotent.
 *        Crash mid-loop: run stays PROCESSING; retry cleans stale results
 *        and re-calculates all employees.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PT JURISDICTION POLICY:
 *   Source: salary.workState (set on SalaryStructure, required field).
 *   If null, empty, or falsy:   BLOCK with MISSING_PT_JURISDICTION.
 *   If unsupported by Phase 7:  BLOCK with UNSUPPORTED_PT_JURISDICTION.
 *   NO DEFAULT STATE IS EVER USED.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PROCESS CRASH / RECOVERY:
 *   A run stuck in PROCESSING can be detected by:
 *     status = 'PROCESSING' AND lastActivityAt < (now - stuckThreshold)
 *   Recovery is MANUAL in Phase 8:
 *     An admin must observe the stuck run and call the /process endpoint
 *     again (which transitions PROCESSING → FAILED if the claim fails,
 *     then FAILED → PROCESSING on retry).
 *   Alternatively: use the recovery helper below that marks a stuck
 *   PROCESSING run as FAILED so it can be retried.
 *   No background worker is implemented in Phase 8.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ATTENDANCE:
 *   No Attendance subsystem exists. attendanceAdjustment = 'DEFERRED'.
 *   Full-month grossMonthly is used as the payroll gross input.
 *   This is NOT described as "attendance-adjusted salary".
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TDS:
 *   Explicitly deferred. tdsDeferred = true on all runs and staging results.
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

function derivePeriodDates(periodYear, periodMonth) {
  const periodStart = new Date(Date.UTC(periodYear, periodMonth - 1, 1, 0, 0, 0, 0));
  const periodEnd   = new Date(Date.UTC(periodYear, periodMonth,     1, 0, 0, 0, 0) - 1);
  return { periodStart, periodEnd };
}

function validatePeriodInput(periodMonth, periodYear) {
  const month = Number(periodMonth);
  const year  = Number(periodYear);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw Object.assign(
      new Error('Period month must be an integer between 1 and 12.'),
      { statusCode: 400 }
    );
  }
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw Object.assign(
      new Error('Period year must be an integer between 2000 and 2100.'),
      { statusCode: 400 }
    );
  }
}

// ─── PT jurisdiction validation ──────────────────────────────────────────────

/**
 * Validate and resolve the PT jurisdiction for an employee.
 *
 * CORRECTION C4: No silent fallback. If workState is absent or unsupported,
 * the caller must treat the employee as BLOCKED.
 *
 * @param {string|null|undefined} workState - From salary.workState
 * @param {Date} periodEnd
 * @returns {Promise<{ ptRule: object|null, blockReason: string|null }>}
 */
async function resolvePtRule(workState, periodEnd) {
  // Missing jurisdiction
  if (!workState || typeof workState !== 'string' || workState.trim() === '') {
    return {
      ptRule: null,
      blockReason: 'MISSING_PT_JURISDICTION: workState is not set on salary structure.',
    };
  }

  const jurisdiction = workState.trim().toUpperCase();

  // Query Phase 7's ComplianceRuleVersion for this jurisdiction.
  // If it returns null, the jurisdiction is unsupported (no rule seeded).
  const ptRule = await ComplianceRuleVersion.findValidForDate('PT', jurisdiction, periodEnd);

  if (!ptRule) {
    return {
      ptRule: null,
      blockReason: `UNSUPPORTED_PT_JURISDICTION: No PT rule found for work state '${jurisdiction}' on ${periodEnd.toISOString().slice(0, 10)}. Ensure Phase 7 has seeded rules for this jurisdiction.`,
    };
  }

  return { ptRule, blockReason: null };
}

// ─── Employee eligibility ────────────────────────────────────────────────────

/**
 * Resolve eligible and blocked employees for a payroll run.
 *
 * Eligibility rules:
 *   1. Employee.createdBy === companyId (belongs to this company).
 *   2. status in ['active', 'on-leave'] (not inactive/soft-deleted).
 *   3. Valid SalaryStructure exists for periodEnd.
 *   4. salary.workState is non-empty and a supported PT jurisdiction.
 *   5. EPF rule exists if pfEnrolled.
 *   6. ESI rule exists if esiEnrolled.
 *
 * CORRECTION C4 applied: workState is never defaulted. Missing = BLOCKED.
 *
 * @returns {{ eligible: Array, blocked: Array, epfRule: object|null, esiRule: object|null }}
 */
async function resolveEligibleEmployees(companyId, periodStart, periodEnd) {
  const candidates = await Employee.find({
    createdBy: companyId,
    status: { $in: ['active', 'on-leave'] },
  }).lean();

  // Nationwide rules resolved once (shared across all employees)
  const [epfRule, esiRule] = await Promise.all([
    ComplianceRuleVersion.findValidForDate('EPF', 'IN', periodEnd),
    ComplianceRuleVersion.findValidForDate('ESI', 'IN', periodEnd),
  ]);

  const eligible = [];
  const blocked  = [];

  for (const emp of candidates) {
    const issues = [];

    // ── Salary resolution ──
    const salary = await SalaryStructure.findValidForDate(emp._id, periodEnd);

    if (!salary) {
      issues.push(
        `No salary structure valid for period ending ${periodEnd.toISOString().slice(0, 10)}.`
      );
    }

    // ── PT jurisdiction resolution (CORRECTION C4) ──
    let ptRule = null;
    if (salary) {
      // NEVER default workState. Missing = BLOCKED.
      const { ptRule: resolved, blockReason } = await resolvePtRule(salary.workState, periodEnd);
      if (blockReason) {
        issues.push(blockReason);
      } else {
        ptRule = resolved;
      }
    }

    // ── EPF rule check ──
    if (salary && salary.pfEnrolled && !epfRule) {
      issues.push(
        `EPF rule version not found for jurisdiction 'IN' on ${periodEnd.toISOString().slice(0, 10)}.`
      );
    }

    // ── ESI rule check ──
    if (salary && salary.esiEnrolled && !esiRule) {
      issues.push(
        `ESI rule version not found for jurisdiction 'IN' on ${periodEnd.toISOString().slice(0, 10)}.`
      );
    }

    if (issues.length > 0) {
      blocked.push({
        employeeId:   emp._id.toString(),
        employeeCode: emp.employeeCode || emp._id.toString(),
        name:         `${emp.firstName} ${emp.lastName}`,
        status:       'BLOCKED',
        issues,
      });
    } else {
      // Build rule provenance for this employee now, while we have the resolved rule docs.
      // This allows the staging result to freeze exact rule metadata at processing time.
      const ruleProvenance = [];
      if (epfRule && salary.pfEnrolled) {
        ruleProvenance.push({
          ruleType:        'EPF',
          ruleId:          epfRule._id,
          jurisdiction:    epfRule.jurisdiction,
          effectiveFrom:   epfRule.effectiveFrom,
          effectiveTo:     epfRule.effectiveTo,
          sourceReference: epfRule.description ||
            `EPF-${epfRule.jurisdiction}-${epfRule.effectiveFrom.toISOString().slice(0, 10)}`,
        });
      }
      if (esiRule && salary.esiEnrolled) {
        ruleProvenance.push({
          ruleType:        'ESI',
          ruleId:          esiRule._id,
          jurisdiction:    esiRule.jurisdiction,
          effectiveFrom:   esiRule.effectiveFrom,
          effectiveTo:     esiRule.effectiveTo,
          sourceReference: esiRule.description ||
            `ESI-${esiRule.jurisdiction}-${esiRule.effectiveFrom.toISOString().slice(0, 10)}`,
        });
      }
      if (ptRule && salary.ptEnrolled) {
        ruleProvenance.push({
          ruleType:        'PT',
          ruleId:          ptRule._id,
          jurisdiction:    ptRule.jurisdiction,
          effectiveFrom:   ptRule.effectiveFrom,
          effectiveTo:     ptRule.effectiveTo,
          sourceReference: ptRule.description ||
            `PT-${ptRule.jurisdiction}-${ptRule.effectiveFrom.toISOString().slice(0, 10)}`,
        });
      }

      eligible.push({
        employeeId: emp._id.toString(),
        name:       `${emp.firstName} ${emp.lastName}`,
        employee:   emp,          // full lean document — for employeeSnapshot freeze
        salary,
        epfRule,
        esiRule,
        ptRule,
        ruleProvenance,           // pre-built provenance array — for ruleProvenance freeze
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

  async createPayrollRun({
    companyId, periodMonth, periodYear,
    actorId, actorEmail, actorRole, idempotencyKey,
  }) {
    validatePeriodInput(periodMonth, periodYear);

    const month = Number(periodMonth);
    const year  = Number(periodYear);
    const { periodStart, periodEnd } = derivePeriodDates(year, month);

    const existing = await payrollRunRepository.findByCompanyPeriod(companyId, year, month);

    if (existing) {
      if (existing.status !== PAYROLL_STATUS.CANCELLED) {
        return { run: existing, created: false, conflict: true };
      }
      // CANCELLED tombstone — delete it so the partial unique index slot is freed
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
          status:              PAYROLL_STATUS.DRAFT,
          createdBy:           actorId,
          idempotencyKey:      idempotencyKey || null,
          tdsDeferred:         true,
          attendanceAdjustment: 'DEFERRED',
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
          meta:       { periodMonth: month, periodYear: year, companyId },
        },
        session
      );

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
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
  // GET / LIST
  // ───────────────────────────────────────────────────────────────────────────

  async getPayrollRun(runId, companyId) {
    const run = await payrollRunRepository.findById(runId);
    if (!run) {
      throw Object.assign(new Error('Payroll run not found.'), { statusCode: 404 });
    }
    if (run.companyId.toString() !== companyId.toString()) {
      throw Object.assign(
        new Error('Payroll run does not belong to your company.'),
        { statusCode: 403 }
      );
    }
    return run;
  },

  async listPayrollRuns(companyId, opts = {}) {
    const runs  = await payrollRunRepository.listRuns(companyId, opts);
    const total = await payrollRunRepository.countRuns(companyId, opts.status);
    return { runs, total };
  },

  // ───────────────────────────────────────────────────────────────────────────
  // PREFLIGHT
  // ───────────────────────────────────────────────────────────────────────────

  async runPreflight(runId, companyId, actor) {
    const run = await this.getPayrollRun(runId, companyId);

    if (![PAYROLL_STATUS.DRAFT, PAYROLL_STATUS.FAILED].includes(run.status)) {
      throw Object.assign(
        new Error(
          `Preflight is only available for DRAFT or FAILED runs. Current status: ${run.status}`
        ),
        { statusCode: 409 }
      );
    }

    const blockingErrors = [];
    const warnings       = [];

    const { periodStart, periodEnd, periodMonth, periodYear } = run;

    const { eligible, blocked, epfRule, esiRule } =
      await resolveEligibleEmployees(companyId, periodStart, periodEnd);

    const totalCandidates = eligible.length + blocked.length;

    if (totalCandidates === 0) {
      blockingErrors.push('No active employees found for this company.');
    }
    if (blocked.length > 0) {
      const msg = `${blocked.length} employee(s) are blocked due to missing or unsupported data.`;
      if (eligible.length === 0) {
        blockingErrors.push(msg + ' No eligible employees remain.');
      } else {
        warnings.push(msg + ' They will be excluded from this run.');
      }
    }

    const ruleAvailability = {
      epf: epfRule ? { available: true, versionId: epfRule._id } : { available: false },
      esi: esiRule ? { available: true, versionId: esiRule._id } : { available: false },
    };

    // CORRECTION C8: explicit attendance deferral metadata
    warnings.push(
      'attendanceAdjustment=DEFERRED: No Attendance subsystem exists. ' +
      'Full-month grossMonthly from SalaryStructure is used as payroll gross input. ' +
      'This is NOT attendance-adjusted salary.'
    );
    warnings.push('TDS calculation is deferred (tdsDeferred=true) and will not appear in this run.');

    const canProcess = blockingErrors.length === 0;

    await payrollRunRepository.updatePreflightResult(runId, {
      canProcess,
      eligibleEmployeeCount: eligible.length,
      blockedEmployeeCount:  blocked.length,
      blockingErrors,
      warnings,
      resolvedAt: new Date(),
    });

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
      },
    });

    return {
      runId: run._id,
      periodMonth,
      periodYear,
      canProcess,
      eligibleEmployees: eligible.map(e => ({
        employeeId:   e.employeeId,
        name:         e.name,
        grossMonthly: e.salary.grossMonthly,
        workState:    e.salary.workState,
      })),
      blockedEmployees: blocked,
      blockingErrors,
      warnings,
      ruleAvailability,
      attendanceAdjustment: 'DEFERRED',
    };
  },

  // ───────────────────────────────────────────────────────────────────────────
  // PROCESS
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Process a payroll run.
   *
   * Corrected flow (C1, C2, C3, C4, C6, C7, C8):
   *   1. Load + own run.
   *   2. Validate state permits PROCESSING.
   *   3. Atomically claim PROCESSING.
   *   4. Clean up stale staging results from any prior attempt (C7).
   *   5. Re-resolve eligible employees (fresh read, no stale cache).
   *   6. Calculate each employee using Phase 7 complianceCalculationService.
   *   7. Durably persist each result as PayrollStagingResult (C2).
   *      Update lastActivityAt heartbeat after each write (C6).
   *   8. Verify completeness: durableCount == expected (C3).
   *   9. Check for duplicate staging results (C3).
   *  10. Transition PROCESSING → READY_FOR_FINALIZATION (C1).
   *      NOT directly to FINALIZED.
   *  11. Phase 9 will later: verify snapshots, then → FINALIZED.
   */
  async processPayrollRun(runId, companyId, actor, idempotencyKey = null) {
    const run = await this.getPayrollRun(runId, companyId);

    // Idempotency: return current run if already past PROCESSING with the same key
    if (idempotencyKey && run.idempotencyKey === idempotencyKey) {
      if ([
        PAYROLL_STATUS.PROCESSING,
        PAYROLL_STATUS.READY_FOR_FINALIZATION,
        PAYROLL_STATUS.FINALIZED,
        PAYROLL_STATUS.DISBURSED,
      ].includes(run.status)) {
        return { run, processingResult: null, idempotent: true };
      }
    }

    if (!canTransition(run.status, PAYROLL_STATUS.PROCESSING)) {
      throw Object.assign(
        new Error(
          `Cannot process a run in status '${run.status}'. Allowed from: DRAFT or FAILED.`
        ),
        { statusCode: 409 }
      );
    }

    // ── T2: Atomic DRAFT/FAILED → PROCESSING claim ────────────────────────
    const additionalFields = { startedAt: new Date() };
    if (idempotencyKey) additionalFields.idempotencyKey = idempotencyKey;

    const claimed = await payrollRunRepository.transitionStateAtomically(
      runId,
      run.status,
      PAYROLL_STATUS.PROCESSING,
      additionalFields,
      { actorId: actor.id, actorEmail: actor.email, reason: 'Processing started' }
    );

    if (!claimed) {
      const current = await payrollRunRepository.findById(runId);
      return { run: current, processingResult: null, concurrencyConflict: true };
    }

    // Increment processing version (new attempt = new version)
    const withVersion = await payrollRunRepository.incrementProcessingVersion(runId);
    const currentVersion = withVersion.processingVersion;

    // C7: Delete stale staging results from any prior failed attempt
    await payrollRunRepository.deleteStagingResults(runId, currentVersion - 1);

    await auditService.log({
      action:         'PAYROLL_PROCESSING_STARTED',
      actorId:        actor.id,
      actorEmail:     actor.email,
      actorRole:      actor.role,
      entityType:     'PAYROLL_RUN',
      entityId:       run._id,
      previousStatus: run.status,
      newStatus:      PAYROLL_STATUS.PROCESSING,
      meta:           { periodMonth: run.periodMonth, periodYear: run.periodYear, processingVersion: currentVersion },
    });

    // ── Resolve employees ─────────────────────────────────────────────────
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
      await this._failRun(
        runId,
        'No eligible employees found after eligibility resolution.',
        actor
      );
      throw Object.assign(
        new Error('Payroll processing failed: No eligible employees.'),
        { statusCode: 422 }
      );
    }

    // ── T-loop: Calculate + durably persist results ───────────────────────
    const calcErrors = [];
    let successCount = 0;

    for (const empData of eligible) {
      try {
        const { salary } = empData;

        const calcInput = {
          grossMonthly:   salary.grossMonthly,
          basicSalary:    salary.components.basic,
          pfWageOverride: salary.pfWageOverride != null ? salary.pfWageOverride : null,
          pfEnrolled:     salary.pfEnrolled,
          esiEnrolled:    salary.esiEnrolled,
          ptEnrolled:     salary.ptEnrolled,
          epfRule:        empData.epfRule ? empData.epfRule.epfParams : null,
          esiRule:        empData.esiRule ? empData.esiRule.esiParams : null,
          ptSlabs:        empData.ptRule  ? empData.ptRule.ptSlabs    : [],
        };

        // Reuse Phase 7 calculator — DO NOT duplicate statutory formulas
        const result = complianceCalculationService.calculate(calcInput);

        // C2: Durably persist result BEFORE advancing run state.
        // C9 (Phase 9 correction): freeze ALL historical inputs into staging
        // so Phase 9 never needs to read current Employee, SalaryStructure,
        // or ComplianceRuleVersion to reconstruct historical payroll state.
        await payrollRunRepository.upsertStagingResult({
          runId:             run._id,
          companyId,
          processingVersion: currentVersion,
          periodMonth:       run.periodMonth,
          periodYear:        run.periodYear,
          employeeId:        empData.employeeId,

          // ── FROZEN EMPLOYEE IDENTITY ──────────────────────────────────
          // Captured now. If the employee changes department/status/name
          // after this write, the staging record is unaffected.
          employeeSnapshot: {
            firstName:        empData.employee.firstName,
            lastName:         empData.employee.lastName,
            fullName:         `${empData.employee.firstName} ${empData.employee.lastName}`,
            email:            empData.employee.email,
            department:       empData.employee.department,
            position:         empData.employee.position,
            employmentStatus: empData.employee.status,
            hireDate:         empData.employee.hireDate,
          },

          // ── FROZEN SALARY SNAPSHOT ────────────────────────────────────
          // Captured now. New salary versions do not affect this record.
          salarySnapshot: {
            salaryStructureId: salary._id,
            effectiveFrom:     salary.effectiveFrom,
            effectiveTo:       salary.effectiveTo,
            components: {
              basic:               salary.components.basic,
              hra:                 salary.components.hra               || 0,
              conveyanceAllowance: salary.components.conveyanceAllowance || 0,
              medicalAllowance:    salary.components.medicalAllowance   || 0,
              specialAllowance:    salary.components.specialAllowance   || 0,
              otherAllowances:     salary.components.otherAllowances    || 0,
            },
            grossMonthly:   salary.grossMonthly,
            currency:       salary.currency    || 'INR',
            payFrequency:   salary.payFrequency || 'monthly',
            workState:      salary.workState,
            pfEnrolled:     salary.pfEnrolled,
            esiEnrolled:    salary.esiEnrolled,
            ptEnrolled:     salary.ptEnrolled,
            pfWageOverride: salary.pfWageOverride != null ? salary.pfWageOverride : null,
          },

          // ── FROZEN RULE PROVENANCE ────────────────────────────────────
          // Store ruleType, ruleId, jurisdiction, effectiveFrom, effectiveTo.
          // Phase 9 never re-queries rules by date.
          ruleProvenance: empData.ruleProvenance,

          // ── FROZEN PAYROLL INPUTS ─────────────────────────────────────
          payrollInputs: {
            grossMonthly:         salary.grossMonthly,
            basicSalary:          salary.components.basic,
            pfWageOverride:       salary.pfWageOverride != null ? salary.pfWageOverride : null,
            pfEnrolled:           salary.pfEnrolled,
            esiEnrolled:          salary.esiEnrolled,
            ptEnrolled:           salary.ptEnrolled,
            workState:            salary.workState,
            payrollDate:          run.periodEnd,
            attendanceAdjustment: 'DEFERRED',
          },

          // ── CALCULATION RESULTS ───────────────────────────────────────
          epf:               result.epf,
          esi:               result.esi,
          pt:                result.pt,
          tdsDeferred:       true,
          totalEmployeeDeductions: result.totalEmployeeDeductions,
          netPayBeforeTDS:         result.netPay,

          // Legacy IDs for completeness checks
          resolvedRuleVersionIds: {
            epf: empData.epfRule ? empData.epfRule._id : null,
            esi: empData.esiRule ? empData.esiRule._id : null,
            pt:  empData.ptRule  ? empData.ptRule._id  : null,
          },
        });

        successCount++;

        // C6: Heartbeat — allows detection of stuck PROCESSING runs
        await payrollRunRepository.touchActivity(runId);

      } catch (calcErr) {
        calcErrors.push({
          employeeId: empData.employeeId,
          name:       empData.name,
          error:      calcErr.message,
        });
      }
    }

    // Any calculation error = FAILED. Partial results must not proceed.
    if (calcErrors.length > 0) {
      const reason =
        `Calculation errors for ${calcErrors.length} employee(s): ` +
        calcErrors.map(e => `${e.name} — ${e.error}`).join('; ');
      await this._failRun(runId, reason, actor);
      throw Object.assign(
        new Error(`Payroll processing failed: ${reason}`),
        { statusCode: 422 }
      );
    }

    // ── C3: Completeness verification before READY_FOR_FINALIZATION ────────
    const durableCount = await payrollRunRepository.countStagingResults(runId, currentVersion);

    if (durableCount !== eligible.length) {
      const reason =
        `Durable result count mismatch: expected ${eligible.length}, got ${durableCount}. ` +
        `Cannot advance to READY_FOR_FINALIZATION.`;
      await this._failRun(runId, reason, actor);
      throw Object.assign(new Error(reason), { statusCode: 500 });
    }

    const duplicates = await payrollRunRepository.findDuplicateStagingResults(runId, currentVersion);
    if (duplicates.length > 0) {
      const reason =
        `Duplicate staging results detected for employees: ${duplicates.join(', ')}. ` +
        `Cannot advance to READY_FOR_FINALIZATION.`;
      await this._failRun(runId, reason, actor);
      throw Object.assign(new Error(reason), { statusCode: 500 });
    }

    // ── T3: PROCESSING → READY_FOR_FINALIZATION (C1) ──────────────────────
    const resolvedRuleVersionIds = {
      epf: epfRule ? epfRule._id : null,
      esi: esiRule ? esiRule._id : null,
      pt:  null,  // per-employee; in staging results
    };

    const session = await mongoose.startSession();
    let readyRun;
    try {
      session.startTransaction();

      readyRun = await payrollRunRepository.markReadyForFinalization(
        runId,
        {
          employeeCount:           eligible.length + blocked.length,
          successfulEmployeeCount: successCount,
          failedEmployeeCount:     blocked.length,
          durableResultCount:      durableCount,
          resolvedRuleVersionIds,
        },
        { actorId: actor.id, actorEmail: actor.email, reason: 'Calculations complete; results staged' },
        session
      );

      if (!readyRun) {
        throw Object.assign(
          new Error(
            'READY_FOR_FINALIZATION transition failed: run was not in PROCESSING state ' +
            '(possible concurrent modification).'
          ),
          { statusCode: 409 }
        );
      }

      await auditService.log(
        {
          action:         'PAYROLL_READY_FOR_FINALIZATION',
          actorId:        actor.id,
          actorEmail:     actor.email,
          actorRole:      actor.role,
          entityType:     'PAYROLL_RUN',
          entityId:       run._id,
          previousStatus: PAYROLL_STATUS.PROCESSING,
          newStatus:      PAYROLL_STATUS.READY_FOR_FINALIZATION,
          meta: {
            employeeCount:      eligible.length + blocked.length,
            successfulCount:    successCount,
            blockedCount:       blocked.length,
            durableResultCount: durableCount,
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

    return {
      run: readyRun,
      processingResult: {
        status:                  PAYROLL_STATUS.READY_FOR_FINALIZATION,
        employeeCount:           eligible.length + blocked.length,
        successfulEmployeeCount: successCount,
        blockedEmployeeCount:    blocked.length,
        durableResultCount:      durableCount,
        blocked,
        tdsDeferred:             true,
        // C8: explicit attendance metadata
        attendanceAdjustment:    'DEFERRED',
        attendanceNote:
          'attendanceAdjustment=DEFERRED. ' +
          'Full-month grossMonthly from SalaryStructure is the payroll gross. ' +
          'This is NOT attendance-adjusted salary.',
        phase9Note:
          'Run is READY_FOR_FINALIZATION. ' +
          'Phase 9 must verify PayrollStagingResults, materialize PayrollSnapshots, ' +
          'then transition to FINALIZED.',
      },
    };
  },

  // ───────────────────────────────────────────────────────────────────────────
  // FINALIZE (Phase 9 interface — READY_FOR_FINALIZATION → FINALIZED)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * CORRECTION C5: This endpoint now requires READY_FOR_FINALIZATION status.
   * Direct PROCESSING → FINALIZED is forbidden.
   *
   * In Phase 8, this method is intentionally limited: it transitions
   * READY_FOR_FINALIZATION → FINALIZED but is the Phase 9 entry point.
   * Phase 9 must have already verified PayrollSnapshot completeness before
   * calling this. Phase 8 does not verify snapshot completeness here —
   * that is Phase 9's responsibility.
   *
   * Phase 8 exposes this transition only after staging-result completeness
   * was already verified when entering READY_FOR_FINALIZATION.
   */
  async finalizePayrollRun(runId, companyId, actor) {
    const run = await this.getPayrollRun(runId, companyId);

    // CORRECTION C5: must be READY_FOR_FINALIZATION, not PROCESSING
    if (!canTransition(run.status, PAYROLL_STATUS.FINALIZED)) {
      throw Object.assign(
        new Error(
          `Cannot finalize a run in status '${run.status}'. ` +
          `Run must be in READY_FOR_FINALIZATION. ` +
          `Ensure processing has completed and all employee results are staged.`
        ),
        { statusCode: 409 }
      );
    }

    const session = await mongoose.startSession();
    let finalizedRun;
    try {
      session.startTransaction();

      finalizedRun = await payrollRunRepository.finalize(
        runId,
        { finalizedBy: actor.id, resolvedRuleVersionIds: run.resolvedRuleVersionIds },
        { actorId: actor.id, actorEmail: actor.email, reason: 'Finalization confirmed by Phase 9' },
        session
      );

      if (!finalizedRun) {
        throw Object.assign(
          new Error(
            'Finalization failed: run was not in READY_FOR_FINALIZATION state ' +
            '(possible concurrent finalization).'
          ),
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
          previousStatus: PAYROLL_STATUS.READY_FOR_FINALIZATION,
          newStatus:      PAYROLL_STATUS.FINALIZED,
          meta: {
            employeeCount:           run.employeeCount,
            successfulEmployeeCount: run.successfulEmployeeCount,
            durableResultCount:      run.durableResultCount,
            finalizedBy:             actor.id,
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

  // ───────────────────────────────────────────────────────────────────────────
  // CANCEL
  // ───────────────────────────────────────────────────────────────────────────

  async cancelPayrollRun(runId, companyId, actor) {
    const run = await this.getPayrollRun(runId, companyId);

    if (!canTransition(run.status, PAYROLL_STATUS.CANCELLED)) {
      throw Object.assign(
        new Error(
          `Cannot cancel a run in status '${run.status}'. Only FAILED runs can be cancelled.`
        ),
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

  // ───────────────────────────────────────────────────────────────────────────
  // RECOVERY (manual crash recovery for stuck PROCESSING runs)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Mark a stuck PROCESSING run as FAILED so it can be retried.
   *
   * PROCESS CRASH RECOVERY (documented, manual in Phase 8):
   *   A run may get stuck in PROCESSING if the server crashes during
   *   the calculation loop. Detection:
   *     status = 'PROCESSING' AND lastActivityAt < (now - stuckThresholdMs)
   *
   *   Recovery: an admin calls this endpoint. The run transitions to FAILED
   *   and may be retried via the /process endpoint.
   *
   *   Automatic recovery (heartbeat monitor, background job) is deferred
   *   to a future operations phase. No worker is implemented in Phase 8.
   *
   * @param {string} runId
   * @param {string} companyId
   * @param {object} actor
   * @param {number} [stuckThresholdMs=1800000]  default 30 minutes
   */
  async recoverStuckRun(runId, companyId, actor, stuckThresholdMs = 30 * 60 * 1000) {
    const run = await this.getPayrollRun(runId, companyId);

    if (run.status !== PAYROLL_STATUS.PROCESSING) {
      throw Object.assign(
        new Error(`Run is not in PROCESSING status. Current: ${run.status}`),
        { statusCode: 409 }
      );
    }

    const lastActivity = run.lastActivityAt || run.startedAt || run.createdAt;
    const stuckSince   = new Date(lastActivity).getTime();
    const now          = Date.now();

    if (now - stuckSince < stuckThresholdMs) {
      throw Object.assign(
        new Error(
          `Run does not appear stuck: last activity was ` +
          `${Math.round((now - stuckSince) / 1000)}s ago ` +
          `(threshold: ${stuckThresholdMs / 1000}s).`
        ),
        { statusCode: 409 }
      );
    }

    const failed = await payrollRunRepository.transitionStateAtomically(
      runId,
      PAYROLL_STATUS.PROCESSING,
      PAYROLL_STATUS.FAILED,
      {
        failureReason: `Recovered from stuck PROCESSING state. Last activity: ${lastActivity.toISOString()}`,
        failedAt:      new Date(),
        completedAt:   new Date(),
      },
      { actorId: actor.id, actorEmail: actor.email, reason: 'Manual crash recovery' }
    );

    if (!failed) {
      throw Object.assign(
        new Error('Recovery failed: run status changed concurrently.'),
        { statusCode: 409 }
      );
    }

    await auditService.log({
      action:         'PAYROLL_PROCESSING_FAILED',
      actorId:        actor.id,
      actorEmail:     actor.email,
      actorRole:      actor.role,
      entityType:     'PAYROLL_RUN',
      entityId:       runId,
      previousStatus: PAYROLL_STATUS.PROCESSING,
      newStatus:      PAYROLL_STATUS.FAILED,
      meta:           { reason: 'Manual crash recovery', lastActivityAt: lastActivity },
    });

    return failed;
  },

  // ───────────────────────────────────────────────────────────────────────────
  // PRIVATE HELPERS
  // ───────────────────────────────────────────────────────────────────────────

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
};

export default payrollRunService;
