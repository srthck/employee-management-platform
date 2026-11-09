/**
 * PayrollRunService — Payroll Run Orchestration.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CORRECTIONS APPLIED (Phase 8):
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
 *   C5. finalizePayrollRun requires READY_FOR_FINALIZATION.
 *
 *   C6. lastActivityAt heartbeat updated during calculation loop for
 *       crash-detection.
 *
 *   C7. Retry cleanup: on FAILED → PROCESSING, stale staging results from
 *       the previous attempt are deleted before re-processing.
 *
 *   C8. attendanceAdjustment = 'DEFERRED' is explicitly set and surfaced
 *       in all processing results. The word "attendance-adjusted" is never
 *       used to describe full-month gross.
 *
 * CORRECTIONS APPLIED (Phase 12 hardening):
 *
 *   H1. finalizePayrollRun (POST /payroll-runs/:id/finalize) previously moved
 *       READY_FOR_FINALIZATION → FINALIZED without materializing or verifying
 *       snapshots, violating the FINALIZED invariant. It now runs the full
 *       snapshot path (materialize → completeness + hash checks → finalize).
 *
 *   H2. All state transitions + their audit events run through
 *       runInTransaction (see utils/transaction.js).
 *
 *   H3. CANCELLED runs are no longer deleted when a period is re-run. The
 *       partial unique index excludes CANCELLED, so the history is kept.
 *
 *   H4. Eligibility loads salary structures in one query and caches PT rules
 *       per state (previously 2+ queries per employee).
 *
 *   H5. Employees hired after the period end are blocked (HIRED_AFTER_PERIOD).
 *       Archived (soft-deleted) employees are excluded by the Employee model.
 *
 *   H6. Exact rule parameters are frozen into ruleProvenance so every payslip
 *       line can be explained later without re-reading mutable rules.
 *
 *   H7. Stuck PROCESSING runs are recovered automatically by the stuck-run
 *       monitor (jobs/stuckRunMonitor.js) using a heartbeat-guarded update.
 *
 *   H8. A run owned by another company is reported as not found (404), so run
 *       IDs cannot be probed across tenants.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * STATE MACHINE (this service):
 *   DRAFT → PROCESSING → READY_FOR_FINALIZATION → FINALIZED
 *                      ↘ FAILED → PROCESSING (retry)
 *                                ↘ CANCELLED
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TRANSACTION STRATEGY:
 *   T1 — createPayrollRun: create PayrollRun + audit write, one transaction.
 *
 *   T2 — claimProcessing (DRAFT/FAILED → PROCESSING):
 *        Atomic conditional findOneAndUpdate. Single-document atomic.
 *
 *   T3 — markReadyForFinalization (PROCESSING → READY_FOR_FINALIZATION):
 *        Transaction: atomic state transition + audit, after completeness is
 *        verified. Staging result writes happen outside it (T-loop below).
 *
 *   T-loop — Per-employee staging result persistence:
 *        Intentionally outside any long-running transaction.
 *        Uses upsert(runId, employeeId, processingVersion) — idempotent.
 *        Crash mid-loop: run stays PROCESSING until recovered; retry cleans
 *        stale results and re-calculates all employees.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PT JURISDICTION POLICY:
 *   Source: salary.workState (set on SalaryStructure, required on revision).
 *   If null, empty, or falsy:   BLOCK with MISSING_PT_JURISDICTION.
 *   If no rule is seeded:       BLOCK with UNSUPPORTED_PT_JURISDICTION.
 *   NO DEFAULT STATE IS EVER USED.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PAY BASIS AND ATTENDANCE:
 *   Pay is prorated for employees who join or leave inside the period, using
 *   the company pay basis (payable days; see utils/payBasis.js). Statutory
 *   amounts are then calculated on what was earned, while ESI eligibility
 *   still follows the wage for the period.
 *   Attendance and loss of pay are NOT applied: there is no attendance
 *   subsystem yet, so paid days equal the days employed. Earned pay is
 *   therefore NOT attendance-adjusted salary, and is never described as such.
 *   attendanceAdjustment records which of the two applied to each result.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TDS:
 *   Explicitly deferred. tdsDeferred = true on all runs and staging results.
 *
 * COMPANY IDENTITY:
 *   companyId is resolved from the authenticated user by authMiddleware.
 */

import Company from '../models/Company.js';
import Employee from '../models/Employee.js';
import EmploymentRecord from '../models/EmploymentRecord.js';
import CompensationVersion from '../models/CompensationVersion.js';
import SalaryStructure from '../models/SalaryStructure.js';
import ComplianceRuleVersion from '../models/ComplianceRuleVersion.js';
import payrollRunRepository from '../repositories/payrollRunRepository.js';
import complianceCalculationService from './complianceCalculationService.js';
import payrollFinalizationService from './payrollFinalizationService.js';
import auditService from './auditService.js';
import { canTransition, PAYROLL_STATUS } from '../models/PayrollRun.js';
import { runInTransaction } from '../utils/transaction.js';
import { computePayPeriodDays, payrollBasisFrom, proratedAmount } from '../utils/payBasis.js';
import { roundToPaise as round2 } from '../utils/money.js';
import {
  deriveStatutoryBasesFromLines,
  deriveStatutoryBasesFromSalaryBuckets,
  deriveUnresolvedDriftBases,
  toStatutoryBasesDocument,
} from '../utils/statutoryBases.js';

// Actor recorded for automatic (non-human) operations such as stuck-run recovery.
export const SYSTEM_ACTOR = Object.freeze({
  id: '000000000000000000000000',
  email: 'system@payguard.internal',
  role: 'system',
});

// Heartbeat every N employees keeps writes low while staying far below the
// stuck-run threshold.
const HEARTBEAT_EVERY = 25;

const conflict = (message) => Object.assign(new Error(message), { statusCode: 409 });

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

/** Plain JSON copy of rule parameters (Mongoose subdocuments included). */
const frozenParameters = (value) => (value == null ? null : JSON.parse(JSON.stringify(value)));

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

  // If ComplianceRuleVersion returns null, the jurisdiction is unsupported.
  const ptRule = await ComplianceRuleVersion.findValidForDate('PT', jurisdiction, periodEnd);

  if (!ptRule) {
    return {
      ptRule: null,
      blockReason: `UNSUPPORTED_PT_JURISDICTION: No PT rule found for work state '${jurisdiction}' on ${periodEnd.toISOString().slice(0, 10)}. Seed a PT rule version for this jurisdiction.`,
    };
  }

  return { ptRule, blockReason: null };
}

/** Per-run cache: one PT rule lookup per state instead of per employee. */
function createPtRuleResolver(periodEnd) {
  const cache = new Map();
  return (workState) => {
    const key = typeof workState === 'string' ? workState.trim().toUpperCase() : '';
    if (!cache.has(key)) cache.set(key, resolvePtRule(workState, periodEnd));
    return cache.get(key);
  };
}

// ─── Employee eligibility ────────────────────────────────────────────────────

/**
 * Resolve eligible and blocked employees for a payroll run.
 *
 * Eligibility rules:
 *   1. Employee.createdBy === companyId (belongs to this company).
 *   2. status in ['active', 'on-leave'] and not archived.
 *   3. Hired on or before the period end.
 *   4. Not exited before the period starts (EmploymentRecord exit).
 *   5. Valid SalaryStructure exists for periodEnd.
 *   6. salary.workState is non-empty and a supported PT jurisdiction.
 *   7. EPF rule exists if pfEnrolled.
 *   8. ESI rule exists if esiEnrolled.
 *
 * Shared with payroll readiness (payrollReadinessService), so what readiness
 * reports as BLOCKED is exactly what calculation excludes.
 *
 * @param {{ employeeIds?: Array }} [options] restrict to these employees
 * @returns {{ eligible: Array, blocked: Array, epfRule: object|null, esiRule: object|null }}
 */
export async function resolveEligibleEmployees(companyId, periodStart, periodEnd, { employeeIds = null } = {}) {
  const filter = {
    createdBy: companyId,
    status: { $in: ['active', 'on-leave'] },
  };
  if (employeeIds) filter._id = { $in: employeeIds };
  const candidates = await Employee.find(filter).lean();
  const candidateIds = candidates.map((candidate) => candidate._id);

  // Nationwide rules, salary versions and exits resolved in four queries.
  const [epfRule, esiRule, salaries, exits, compensationVersions] = await Promise.all([
    ComplianceRuleVersion.findValidForDate('EPF', 'IN', periodEnd),
    ComplianceRuleVersion.findValidForDate('ESI', 'IN', periodEnd),
    SalaryStructure.find({
      employeeId: { $in: candidateIds },
      effectiveFrom: { $lte: periodEnd },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gte: periodEnd } }],
    }).sort({ effectiveFrom: -1 }).lean(),
    EmploymentRecord.find({
      employeeId: { $in: candidateIds },
      isCurrent: true,
      lifecycleStatus: 'EXITED',
    }).select('employeeId exit.lastWorkingDay').lean(),
    CompensationVersion.find({
      employeeId: { $in: candidateIds },
      effectiveFrom: { $lte: periodEnd },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gte: periodEnd } }],
    }).sort({ effectiveFrom: -1 }).lean(),
  ]);

  const lastWorkingDayByEmployee = new Map(
    exits
      .filter((record) => record.exit && record.exit.lastWorkingDay)
      .map((record) => [String(record.employeeId), record.exit.lastWorkingDay])
  );

  // Sorted newest first, so the first version seen per employee is the one in
  // force at periodEnd. Records written before compensation existed have none.
  const compensationByEmployee = new Map();
  for (const version of compensationVersions) {
    const key = String(version.employeeId);
    if (!compensationByEmployee.has(key)) compensationByEmployee.set(key, version);
  }

  // Sorted newest-first, so the first version seen per employee is the one
  // valid at periodEnd (same rule as SalaryStructure.findValidForDate).
  const salaryByEmployee = new Map();
  for (const version of salaries) {
    const key = String(version.employeeId);
    if (!salaryByEmployee.has(key)) salaryByEmployee.set(key, version);
  }

  const resolvePt = createPtRuleResolver(periodEnd);
  const periodEndLabel = periodEnd.toISOString().slice(0, 10);

  const eligible = [];
  const blocked  = [];

  for (const emp of candidates) {
    const issues = [];

    if (emp.hireDate && new Date(emp.hireDate) > periodEnd) {
      issues.push(
        `HIRED_AFTER_PERIOD: hire date ${new Date(emp.hireDate).toISOString().slice(0, 10)} is after the period end ${periodEndLabel}.`
      );
    }

    const lastWorkingDay = lastWorkingDayByEmployee.get(String(emp._id)) || null;
    // Employed for part of the period is payable (prorated); employed for none
    // of it is not.
    if (lastWorkingDay && new Date(lastWorkingDay) < periodStart) {
      issues.push(
        `EXITED_BEFORE_PERIOD: last working day ${new Date(lastWorkingDay).toISOString().slice(0, 10)} is before the period start ${periodStart.toISOString().slice(0, 10)}.`
      );
    }

    // ── Salary resolution ──
    const salary = salaryByEmployee.get(String(emp._id)) || null;

    if (!salary) {
      issues.push(`No salary structure valid for period ending ${periodEndLabel}.`);
    }

    // ── PT jurisdiction resolution (CORRECTION C4) ──
    let ptRule = null;
    if (salary) {
      // NEVER default workState. Missing = BLOCKED.
      const { ptRule: resolved, blockReason } = await resolvePt(salary.workState);
      if (blockReason) {
        issues.push(blockReason);
      } else {
        ptRule = resolved;
      }
    }

    // ── EPF rule check ──
    if (salary && salary.pfEnrolled && !epfRule) {
      issues.push(`EPF rule version not found for jurisdiction 'IN' on ${periodEndLabel}.`);
    }

    // ── ESI rule check ──
    if (salary && salary.esiEnrolled && !esiRule) {
      issues.push(`ESI rule version not found for jurisdiction 'IN' on ${periodEndLabel}.`);
    }

    if (issues.length > 0) {
      blocked.push({
        employeeId:   emp._id.toString(),
        employeeCode: emp.employeeCode || emp._id.toString(),
        name:         `${emp.firstName} ${emp.lastName}`,
        status:       'BLOCKED',
        issues,
      });
      continue;
    }

    // Freeze exact rule metadata AND parameters at processing time.
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
        parameters:      frozenParameters(epfRule.epfParams),
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
        parameters:      frozenParameters(esiRule.esiParams),
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
        parameters:      { slabs: frozenParameters(ptRule.ptSlabs) || [] },
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
      lastWorkingDay,           // for proration when the employee leaves mid-period
      compensation: compensationByEmployee.get(String(emp._id)) || null,
    });
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

    // Only a non-cancelled run occupies the period. A CANCELLED tombstone is
    // kept as history; the partial unique index ignores it.
    const existing = await payrollRunRepository.findByCompanyPeriod(companyId, year, month);
    if (existing) {
      return { run: existing, created: false, conflict: true };
    }

    try {
      const run = await runInTransaction(async (session) => {
        const created = await payrollRunRepository.create(
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
            entityId:   created._id,
            companyId,
            newStatus:  PAYROLL_STATUS.DRAFT,
            meta:       { periodMonth: month, periodYear: year, companyId },
          },
          session
        );

        return created;
      }, { label: 'payroll.create' });

      return { run, created: true, conflict: false };
    } catch (err) {
      if (err.code === 11000 && !err.keyPattern?.sequenceNumber) {
        const fresh = await payrollRunRepository.findByCompanyPeriod(companyId, year, month);
        return { run: fresh, created: false, conflict: true };
      }
      throw err;
    }
  },

  // ───────────────────────────────────────────────────────────────────────────
  // GET / LIST
  // ───────────────────────────────────────────────────────────────────────────

  async getPayrollRun(runId, companyId) {
    const run = await payrollRunRepository.findById(runId);
    // Another company's run is indistinguishable from a missing run.
    if (!run || run.companyId.toString() !== companyId.toString()) {
      throw Object.assign(new Error('Payroll run not found.'), { statusCode: 404 });
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
      throw conflict(
        `Preflight is only available for DRAFT or FAILED runs. Current status: ${run.status}`
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
      'Attendance and loss of pay are not applied: there is no attendance subsystem yet. ' +
      'Pay IS prorated for employees who join or leave inside the period, using the ' +
      'company pay basis (payable days).'
    );
    warnings.push('TDS calculation is deferred (tdsDeferred=true) and will not appear in this run.');

    const canProcess = blockingErrors.length === 0;

    await runInTransaction(async (session) => {
      await payrollRunRepository.updatePreflightResult(runId, {
        canProcess,
        eligibleEmployeeCount: eligible.length,
        blockedEmployeeCount:  blocked.length,
        blockingErrors,
        warnings,
        resolvedAt: new Date(),
      }, session);

      await auditService.log({
        action:     'PAYROLL_PREFLIGHT_COMPLETED',
        actorId:    actor.id,
        actorEmail: actor.email,
        actorRole:  actor.role,
        entityType: 'PAYROLL_RUN',
        entityId:   run._id,
        companyId,
        meta: {
          canProcess,
          eligibleEmployeeCount: eligible.length,
          blockedEmployeeCount:  blocked.length,
          blockingErrors,
        },
      }, session);
    }, { label: 'payroll.preflight' });

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
   * Flow:
   *   1. Load + own run.
   *   2. Validate state permits PROCESSING.
   *   3. Atomically claim PROCESSING.
   *   4. Clean up stale staging results from any prior attempt (C7).
   *   5. Re-resolve eligible employees (fresh read, no stale cache).
   *   6. Calculate each employee using complianceCalculationService.
   *   7. Durably persist each result as PayrollStagingResult (C2).
   *      Heartbeat lastActivityAt while looping (C6).
   *   8. Verify completeness: durableCount == expected (C3).
   *   9. Check for duplicate staging results (C3).
   *  10. Transition PROCESSING → READY_FOR_FINALIZATION (C1).
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
      throw conflict(
        `Cannot process a run in status '${run.status}'. Allowed from: DRAFT or FAILED.`
      );
    }

    // ── T2: Atomic DRAFT/FAILED → PROCESSING claim ────────────────────────
    const additionalFields = { startedAt: new Date() };
    if (idempotencyKey) additionalFields.idempotencyKey = idempotencyKey;

    const claimed = await runInTransaction(async (session) => {
      const transitioned = await payrollRunRepository.transitionStateAtomically(
        runId,
        run.status,
        PAYROLL_STATUS.PROCESSING,
        additionalFields,
        { actorId: actor.id, actorEmail: actor.email, reason: 'Processing started' },
        session
      );
      if (!transitioned) return null;

      const versioned = await payrollRunRepository.incrementProcessingVersion(runId, session);
      await payrollRunRepository.deleteStagingResults(runId, versioned.processingVersion - 1, session);
      await auditService.log({
        action:         'PAYROLL_PROCESSING_STARTED',
        actorId:        actor.id,
        actorEmail:     actor.email,
        actorRole:      actor.role,
        entityType:     'PAYROLL_RUN',
        entityId:       run._id,
        companyId,
        previousStatus: run.status,
        newStatus:      PAYROLL_STATUS.PROCESSING,
        meta: { periodMonth: run.periodMonth, periodYear: run.periodYear, processingVersion: versioned.processingVersion },
      }, session);
      return { transitioned, versioned };
    }, { label: 'payroll.processing-start' });

    if (!claimed) {
      const current = await payrollRunRepository.findById(runId);
      return { run: current, processingResult: null, concurrencyConflict: true };
    }

    // Increment processing version (new attempt = new version)
    const withVersion = claimed.versioned;
    const currentVersion = withVersion.processingVersion;

    // C7: Delete stale staging results from any prior failed attempt

    // ── Resolve employees ─────────────────────────────────────────────────
    let eligible, blocked, epfRule, esiRule;
    try {
      ({ eligible, blocked, epfRule, esiRule } = await resolveEligibleEmployees(
        companyId,
        run.periodStart,
        run.periodEnd
      ));
    } catch (err) {
      await this._failRun(runId, `Employee resolution failed: ${err.message}`, actor, companyId);
      throw Object.assign(
        new Error(`Payroll processing failed during employee resolution: ${err.message}`),
        { statusCode: 500 }
      );
    }

    if (eligible.length === 0) {
      await this._failRun(
        runId,
        'No eligible employees found after eligibility resolution.',
        actor,
        companyId
      );
      throw Object.assign(
        new Error('Payroll processing failed: No eligible employees.'),
        { statusCode: 422 }
      );
    }

    // The pay basis is a company policy: how many days the period pays for.
    const companyRecord = await Company.findById(companyId).select('settings').lean();
    const payrollBasis = payrollBasisFrom(companyRecord ? companyRecord.settings : {});

    // ── T-loop: Calculate + durably persist results ───────────────────────
    const calcErrors = [];
    let successCount = 0;
    let processed = 0;

    for (const empData of eligible) {
      processed += 1;
      try {
        const { salary } = empData;

        // ── Pay basis: the days this period pays for, and the days worked ──
        const period = computePayPeriodDays({
          periodStart: run.periodStart,
          periodEnd:   run.periodEnd,
          basis:       payrollBasis,
          hireDate:    empData.employee.hireDate,
          lastWorkingDay: empData.lastWorkingDay,
        });

        const fullMonthlyGross = salary.grossMonthly;
        const earnedBasic = proratedAmount(salary.components.basic, period.prorationFactor);
        const earnedPfWageOverride = salary.pfWageOverride != null
          ? proratedAmount(salary.pfWageOverride, period.prorationFactor)
          : null;
        const compensation = empData.compensation;

        // Earnings, voluntary deductions and employer contributions come from
        // the compensation version in force. Records written before
        // compensation existed fall back to the salary structure itself.
        const earnedLines = ((compensation && compensation.lines) || []).map((line) => ({
          componentCode: line.componentCode,
          name: line.name,
          type: line.type,
          recurrence: line.recurrence,
          payrollApplication: line.payrollApplication,
          amountMonthly: line.amountMonthly,
          // One-time components are not paid by a monthly run (Wave 8).
          amountEarned: line.recurrence === 'RECURRING'
            ? proratedAmount(line.amountMonthly, period.prorationFactor)
            : 0,
          explanation: (line.lineage && line.lineage.explanation) || null,
        }));

        const earnedGross = proratedAmount(fullMonthlyGross, period.prorationFactor);

        // The breakdown must add up to the gross being paid. When it does not,
        // compensation and its payroll projection have drifted apart; the run
        // pays the projection and does not freeze a breakdown that would
        // contradict it. The variance report surfaces the drift as a pay change
        // nothing explains.
        const compensationEarningsMonthly = round2(earnedLines
          .filter((line) => line.type === 'EARNING' && line.recurrence === 'RECURRING')
          .reduce((total, line) => total + line.amountMonthly, 0));
        const breakdownReconciles = Boolean(compensation)
          && Math.abs(compensationEarningsMonthly - fullMonthlyGross) < 0.01;
        const earnedPfWage = earnedPfWageOverride != null ? earnedPfWageOverride : earnedBasic;

        // ── Statutory wage bases (Wave 3.5) ──────────────────────────────────
        // The wage an ESI contribution and a PT slab are calculated ON, from the
        // same frozen, individually prorated and rounded lines used above. Gross
        // is not reused: it stays the net-pay base only.
        //   reconciled compensation  -> lines, by their frozen treatment flags
        //   no compensation at all   -> the salary buckets (the legacy path)
        //   compensation that has drifted from its projection -> the existing
        //     behaviour, unchanged and labelled; its policy is a later design
        const ptBasisSetting = payrollBasis.professionalTaxBasis;
        let derivedBases;
        if (breakdownReconciles) {
          const basisLines = compensation.lines.map((line, index) => ({
            componentCode: line.componentCode,
            type: line.type,
            recurrence: line.recurrence,
            treatments: line.treatments,
            amountMonthly: line.amountMonthly,
            amountEarned: earnedLines[index].amountEarned,
          }));
          derivedBases = deriveStatutoryBasesFromLines({
            lines: basisLines, earnedGross, fullMonthlyGross, ptBasis: ptBasisSetting,
          });
        } else if (compensation) {
          derivedBases = deriveUnresolvedDriftBases({ earnedGross, fullMonthlyGross, ptBasis: ptBasisSetting });
        } else {
          derivedBases = deriveStatutoryBasesFromSalaryBuckets({ earnedGross, fullMonthlyGross, ptBasis: ptBasisSetting });
        }

        const voluntaryDeductions = earnedLines
          .filter((line) => line.type === 'DEDUCTION' && line.recurrence === 'RECURRING' && line.amountEarned > 0)
          .map((line) => ({
            componentCode: line.componentCode,
            name: line.name,
            amount: line.amountEarned,
            explanation: line.explanation,
          }));
        const employerOtherContributions = earnedLines
          .filter((line) => ['EMPLOYER_CONTRIBUTION', 'BENEFIT'].includes(line.type)
            && line.recurrence === 'RECURRING' && line.amountEarned > 0)
          .map((line) => ({
            componentCode: line.componentCode,
            name: line.name,
            amount: line.amountEarned,
            explanation: line.explanation,
          }));

        const calcInput = {
          grossMonthly:   earnedGross,
          basicSalary:    earnedBasic,
          // The PF wage stays an explicit input: the engine is told the wage,
          // it never guesses it. Prorated like every other earned amount.
          pfWageOverride: earnedPfWageOverride,
          pfEnrolled:     salary.pfEnrolled,
          esiEnrolled:    salary.esiEnrolled,
          ptEnrolled:     salary.ptEnrolled,
          epfRule:        empData.epfRule ? empData.epfRule.epfParams : null,
          esiRule:        empData.esiRule ? empData.esiRule.esiParams : null,
          ptSlabs:        empData.ptRule  ? empData.ptRule.ptSlabs    : [],
          periodMonth:    run.periodMonth,
          // ESI eligibility follows the wage for the period; the contribution
          // is charged on what was actually earned.
          esiCeilingWage: fullMonthlyGross,
          // What the contribution is charged on, and what the PT slab is read from.
          // ESI coverage above is unchanged in this phase.
          esiContributionWage: derivedBases.esiContributionWage,
          ptGross: derivedBases.ptSlabWage,
        };

        // Reuse the Phase 7 calculator — DO NOT duplicate statutory formulas
        const result = complianceCalculationService.calculate(calcInput);

        const voluntaryTotal = round2(voluntaryDeductions.reduce((total, line) => total + line.amount, 0));
        const employerOtherTotal = round2(employerOtherContributions.reduce((total, line) => total + line.amount, 0));
        const totalEmployeeDeductions = round2(result.totalEmployeeDeductions + voluntaryTotal);
        const netPayBeforeTDS = round2(earnedGross - totalEmployeeDeductions);
        if (netPayBeforeTDS < 0) {
          throw new Error(
            'deductions ' + totalEmployeeDeductions + ' exceed earnings ' + earnedGross + ' for this period; ' +
            'reduce the voluntary deductions in compensation before running payroll'
          );
        }

        // C2: Durably persist result BEFORE advancing run state.
        // Freeze ALL historical inputs into staging so snapshot materialization
        // never reads current Employee, SalaryStructure, or ComplianceRuleVersion.
        await payrollRunRepository.upsertStagingResult({
          runId:             run._id,
          companyId,
          processingVersion: currentVersion,
          periodMonth:       run.periodMonth,
          periodYear:        run.periodYear,
          employeeId:        empData.employeeId,

          // ── FROZEN EMPLOYEE IDENTITY ──────────────────────────────────
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

          // ── FROZEN RULE PROVENANCE (ids, dates and parameters) ────────
          ruleProvenance: empData.ruleProvenance,

          // ── FROZEN PAYROLL INPUTS ─────────────────────────────────────
          payrollInputs: {
            // What the engine calculated on: earned amounts for this period.
            grossMonthly:         earnedGross,
            basicSalary:          earnedBasic,
            pfWageOverride:       earnedPfWageOverride,
            pfEnrolled:           salary.pfEnrolled,
            esiEnrolled:          salary.esiEnrolled,
            ptEnrolled:           salary.ptEnrolled,
            workState:            salary.workState,
            payrollDate:          run.periodEnd,
            attendanceAdjustment: period.prorated ? 'PRORATED_BY_EMPLOYMENT_DATES' : 'DEFERRED',
            fullMonthlyGross,
            payableDays:          period.payableDays,
            paidDays:             period.paidDays,
            prorationFactor:      period.prorationFactor,
            payableDaysBasis:     period.payableDaysBasis,
            professionalTaxBasis: payrollBasis.professionalTaxBasis,
            // Only what was actually derived, never an undefined key.
            statutoryBases: toStatutoryBasesDocument(derivedBases),
          },

          // ── CALCULATION RESULTS ───────────────────────────────────────
          epf:               result.epf,
          esi:               result.esi,
          pt:                result.pt,
          tdsDeferred:       true,
          // Statutory deductions plus what compensation says the employee pays.
          totalEmployeeDeductions: totalEmployeeDeductions,
          netPayBeforeTDS:         netPayBeforeTDS,
          ...(voluntaryDeductions.length > 0 && { voluntaryDeductions }),
          ...(employerOtherContributions.length > 0 && { employerOtherContributions }),
          ...(voluntaryTotal > 0 && { voluntaryDeductionsTotal: voluntaryTotal }),
          ...(employerOtherTotal > 0 && { employerOtherContributionTotal: employerOtherTotal }),
          ...(breakdownReconciles && {
            compensationSnapshot: {
              compensationVersionId: compensation._id,
              version: compensation.version,
              effectiveFrom: compensation.effectiveFrom,
              payBasis: 'MONTHLY',
              lines: earnedLines,
            },
          }),

          // Legacy IDs for completeness checks
          resolvedRuleVersionIds: {
            epf: empData.epfRule ? empData.epfRule._id : null,
            esi: empData.esiRule ? empData.esiRule._id : null,
            pt:  empData.ptRule  ? empData.ptRule._id  : null,
          },
        });

        successCount++;
      } catch (calcErr) {
        calcErrors.push({
          employeeId: empData.employeeId,
          name:       empData.name,
          error:      calcErr.message,
        });
      }

      // C6: Heartbeat — allows detection of stuck PROCESSING runs
      if (processed % HEARTBEAT_EVERY === 0 || processed === eligible.length) {
        await payrollRunRepository.touchActivity(runId);
      }
    }

    // Any calculation error = FAILED. Partial results must not proceed.
    if (calcErrors.length > 0) {
      const reason =
        `Calculation errors for ${calcErrors.length} employee(s): ` +
        calcErrors.map(e => `${e.name} — ${e.error}`).join('; ');
      await this._failRun(runId, reason, actor, companyId);
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
      await this._failRun(runId, reason, actor, companyId);
      throw Object.assign(new Error(reason), { statusCode: 500 });
    }

    const duplicates = await payrollRunRepository.findDuplicateStagingResults(runId, currentVersion);
    if (duplicates.length > 0) {
      const reason =
        `Duplicate staging results detected for employees: ${duplicates.join(', ')}. ` +
        `Cannot advance to READY_FOR_FINALIZATION.`;
      await this._failRun(runId, reason, actor, companyId);
      throw Object.assign(new Error(reason), { statusCode: 500 });
    }

    // ── T3: PROCESSING → READY_FOR_FINALIZATION (C1) ──────────────────────
    const resolvedRuleVersionIds = {
      epf: epfRule ? epfRule._id : null,
      esi: esiRule ? esiRule._id : null,
      pt:  null,  // per-employee; in staging results
    };

    const readyRun = await runInTransaction(async (session) => {
      const updated = await payrollRunRepository.markReadyForFinalization(
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

      if (!updated) {
        throw conflict(
          'READY_FOR_FINALIZATION transition failed: run was not in PROCESSING state ' +
          '(possible concurrent modification).'
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
          companyId,
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

      return updated;
    }, { label: 'payroll.readyForFinalization' });

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
          'Attendance and loss of pay are not applied (no attendance subsystem yet). ' +
          'Pay IS prorated for employees who join or leave inside the period, ' +
          'using the company pay basis.',
        nextStep:
          'Run is READY_FOR_FINALIZATION. Review the variance report, then finalize: ' +
          'snapshots are materialized, verified, and locked in one operation.',
      },
    };
  },

  // ───────────────────────────────────────────────────────────────────────────
  // FINALIZE (READY_FOR_FINALIZATION → FINALIZED)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * CORRECTION C5 + H1: requires READY_FOR_FINALIZATION, and goes through the
   * full snapshot path so FINALIZED can never exist without verified,
   * complete, locked snapshots:
   *   1. materialize snapshots from staging (idempotent)
   *   2. stop on any conflict or materialization error
   *   3. payrollSnapshotService.finalizeRun: staging/snapshot completeness,
   *      duplicate and hash checks, then the atomic finalization transaction
   */
  async finalizePayrollRun(runId, companyId, actor, options = {}) {
    const run = await this.getPayrollRun(runId, companyId);

    if (!canTransition(run.status, PAYROLL_STATUS.FINALIZED)) {
      throw conflict(
        `Cannot finalize a run in status '${run.status}'. ` +
        `Run must be in READY_FOR_FINALIZATION. ` +
        `Ensure processing has completed and all employee results are staged.`
      );
    }

    // Controls (segregation of duties, variance gate, override) and the
    // snapshot path live in payrollFinalizationService.
    const { run: finalizedRun } = await payrollFinalizationService.finalize(runId, companyId, actor, options);
    return finalizedRun;
  },

  // ───────────────────────────────────────────────────────────────────────────
  // CANCEL
  // ───────────────────────────────────────────────────────────────────────────

  async cancelPayrollRun(runId, companyId, actor) {
    const run = await this.getPayrollRun(runId, companyId);

    if (!canTransition(run.status, PAYROLL_STATUS.CANCELLED)) {
      throw conflict(
        `Cannot cancel a run in status '${run.status}'. Only FAILED runs can be cancelled.`
      );
    }

    return runInTransaction(async (session) => {
      const cancelled = await payrollRunRepository.transitionStateAtomically(
        runId,
        PAYROLL_STATUS.FAILED,
        PAYROLL_STATUS.CANCELLED,
        {},
        { actorId: actor.id, actorEmail: actor.email, reason: 'Manually cancelled' },
        session
      );

      if (!cancelled) {
        throw conflict('Cancellation failed: run status changed concurrently.');
      }

      await auditService.log({
        action:         'PAYROLL_RUN_CANCELLED',
        actorId:        actor.id,
        actorEmail:     actor.email,
        actorRole:      actor.role,
        entityType:     'PAYROLL_RUN',
        entityId:       runId,
        companyId,
        previousStatus: PAYROLL_STATUS.FAILED,
        newStatus:      PAYROLL_STATUS.CANCELLED,
        meta:           {},
      }, session);

      return cancelled;
    }, { label: 'payroll.cancel' });
  },

  // ───────────────────────────────────────────────────────────────────────────
  // RECOVERY (stuck PROCESSING runs)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Manually mark a stuck PROCESSING run as FAILED so it can be retried.
   *
   * Detection: status = 'PROCESSING' AND lastActivityAt < (now - threshold).
   * The automatic monitor (autoRecoverStuckRuns) does the same without a human.
   *
   * @param {string} runId
   * @param {string} companyId
   * @param {object} actor
   * @param {number} [stuckThresholdMs=1800000]  default 30 minutes
   */
  async recoverStuckRun(runId, companyId, actor, stuckThresholdMs = 30 * 60 * 1000) {
    const run = await this.getPayrollRun(runId, companyId);

    if (run.status !== PAYROLL_STATUS.PROCESSING) {
      throw conflict(`Run is not in PROCESSING status. Current: ${run.status}`);
    }

    const lastActivity = new Date(run.lastActivityAt || run.startedAt || run.createdAt);
    const stuckSince   = lastActivity.getTime();
    const now          = Date.now();

    if (now - stuckSince < stuckThresholdMs) {
      throw conflict(
        `Run does not appear stuck: last activity was ` +
        `${Math.round((now - stuckSince) / 1000)}s ago ` +
        `(threshold: ${stuckThresholdMs / 1000}s).`
      );
    }

    return runInTransaction(async (session) => {
      const failed = await payrollRunRepository.transitionStateAtomically(
        runId,
        PAYROLL_STATUS.PROCESSING,
        PAYROLL_STATUS.FAILED,
        {
          failureReason: `Recovered from stuck PROCESSING state. Last activity: ${lastActivity.toISOString()}`,
          failedAt:      new Date(),
          completedAt:   new Date(),
        },
        { actorId: actor.id, actorEmail: actor.email, reason: 'Manual crash recovery' },
        session
      );

      if (!failed) {
        throw conflict('Recovery failed: run status changed concurrently.');
      }

      await auditService.log({
        action:         'PAYROLL_PROCESSING_FAILED',
        actorId:        actor.id,
        actorEmail:     actor.email,
        actorRole:      actor.role,
        entityType:     'PAYROLL_RUN',
        entityId:       runId,
        companyId,
        previousStatus: PAYROLL_STATUS.PROCESSING,
        newStatus:      PAYROLL_STATUS.FAILED,
        meta:           { reason: 'Manual crash recovery', lastActivityAt: lastActivity },
      }, session);

      return failed;
    }, { label: 'payroll.recover' });
  },

  /**
   * Fail every PROCESSING run (any company) whose heartbeat is older than
   * thresholdMs. Safe to run from several server instances at once: each
   * update is conditional on the heartbeat still being stale.
   *
   * @returns {Promise<number>} number of runs recovered
   */
  async autoRecoverStuckRuns({ thresholdMs, now = Date.now() } = {}) {
    const cutoff = new Date(now - thresholdMs);
    const stuck = await payrollRunRepository.findStuckProcessingRuns(cutoff);
    let recovered = 0;

    for (const run of stuck) {
      const lastActivity = run.lastActivityAt || run.startedAt || run.createdAt;
      const failureReason =
        `AUTO_RECOVERED: no processing heartbeat since ${new Date(lastActivity).toISOString()}. ` +
        'Retry processing to recalculate every employee.';

      const failed = await runInTransaction(async (session) => {
        const transitioned = await payrollRunRepository.markStuckRunFailed(
          run._id,
          cutoff,
          failureReason,
          { actorId: SYSTEM_ACTOR.id, actorEmail: SYSTEM_ACTOR.email, reason: 'Automatic stuck-run recovery' },
          session
        );
        if (!transitioned) return null;

        await auditService.log({
          action:         'PAYROLL_PROCESSING_FAILED',
          actorId:         SYSTEM_ACTOR.id,
          actorEmail:      SYSTEM_ACTOR.email,
          actorRole:       SYSTEM_ACTOR.role,
          entityType:      'PAYROLL_RUN',
          entityId:        run._id,
          companyId:       run.companyId,
          previousStatus:  PAYROLL_STATUS.PROCESSING,
          newStatus:       PAYROLL_STATUS.FAILED,
          meta:            { reason: 'Automatic stuck-run recovery', lastActivityAt: lastActivity, thresholdMs },
        }, session);
        return transitioned;
      }, { label: 'payroll.auto-recover' });
      if (!failed) continue;

      recovered += 1;
    }

    return recovered;
  },

  // ───────────────────────────────────────────────────────────────────────────
  // PRIVATE HELPERS
  // ───────────────────────────────────────────────────────────────────────────

  async _failRun(runId, reason, actor, companyId = null) {
    return runInTransaction(async (session) => {
      const failed = await payrollRunRepository.markFailed(
        runId,
        reason,
        { actorId: actor.id, actorEmail: actor.email, reason },
        session
      );

      if (failed) {
        await auditService.log({
          action:         'PAYROLL_PROCESSING_FAILED',
          actorId:        actor.id,
          actorEmail:     actor.email,
          actorRole:      actor.role || 'system',
          entityType:     'PAYROLL_RUN',
          entityId:       runId,
          companyId:      companyId || failed.companyId,
          previousStatus: PAYROLL_STATUS.PROCESSING,
          newStatus:      PAYROLL_STATUS.FAILED,
          meta:           { failureReason: reason },
        }, session);
      }

      return failed;
    }, { label: 'payroll.fail-run' });
  },
};

export default payrollRunService;
