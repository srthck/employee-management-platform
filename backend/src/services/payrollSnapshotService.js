/**
 * PayrollSnapshotService — Phase 9 Immutable Payroll Snapshot Engine.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CORE PRINCIPLE — HISTORICAL INPUT BOUNDARY:
 *
 *   This service MUST NOT call:
 *     - Employee.findById(...)         to reconstruct historical identity
 *     - SalaryStructure.findById(...)  to reconstruct historical salary
 *     - ComplianceRuleVersion.findValidForDate(...)  to re-resolve rules
 *
 *   All historical inputs were frozen into PayrollStagingResult during
 *   Phase 8 processing. Phase 9 reads those frozen fields directly.
 *
 *   STAGING IS THE HISTORICAL BOUNDARY.
 *   The snapshot represents "WHAT PAYROLL USED", not "WHAT THE DB SAYS NOW".
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SNAPSHOT MATERIALIZATION CONTRACT (Step 16 of correction spec):
 *
 *   snapshot.employeeSnapshot  == staging.employeeSnapshot
 *   snapshot.salarySnapshot    == staging.salarySnapshot
 *   snapshot.payrollInputs     == staging.payrollInputs
 *   snapshot.payrollResults    == derived from staging.epf/esi/pt/netPayBeforeTDS
 *   snapshot.complianceProvenance == staging.ruleProvenance
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT PHASE 9 IS ALLOWED TO READ:
 *   - PayrollStagingResult (the frozen historical boundary)
 *   - PayrollRun (for period metadata and ownership checks)
 *   - PayrollSnapshot (for idempotency / conflict detection)
 *
 * NOTHING ELSE for historical reconstruction.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TDS / ATTENDANCE:
 *   tdsStatus = 'DEFERRED', tdsAmount = null on every snapshot.
 *   Field name: netPayBeforeTDS — NOT "final net pay".
 *   attendanceAdjustment = 'DEFERRED' on every snapshot.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TRANSACTION STRATEGY:
 *   T-materialize (per employee, outside transaction):
 *     - Read staging result (frozen historical data)
 *     - Build snapshot payload directly from staging
 *     - Upsert snapshot (idempotent by payrollRunId + employeeId unique index)
 *
 *   T-finalize (short, atomic):
 *     - Pre-checks (counts, duplicates, hashes)
 *     - bulkMarkFinalized (snapshots → FINALIZED)
 *     - payrollRunRepository.finalize (run → FINALIZED)
 *     - auditService.log(PAYROLL_FINALIZED)
 *     - commit
 */

import mongoose from 'mongoose';
import payrollRunRepository from '../repositories/payrollRunRepository.js';
import payrollSnapshotRepository from '../repositories/payrollSnapshotRepository.js';
import auditService from './auditService.js';
import { computeSnapshotHash, verifySnapshotHash } from '../models/PayrollSnapshot.js';
import { PAYROLL_STATUS } from '../models/PayrollRun.js';

// ─── Snapshot payload builder ─────────────────────────────────────────────────

/**
 * Build a PayrollSnapshot payload entirely from durable staging data.
 *
 * CRITICAL: This function does NOT call Employee.findById, SalaryStructure.findById,
 * or ComplianceRuleVersion.findValidForDate. All values come from staging.
 *
 * @param {object} staging  - lean PayrollStagingResult document (with frozen inputs)
 * @param {object} run      - lean/full PayrollRun document
 * @returns {object}         - snapshot data ready for insertion
 */
function buildSnapshotPayloadFromStaging(staging, run) {
  // ── 1. Employee snapshot — directly from staging (no current-state lookup) ──
  const employeeSnapshot = {
    employeeId:       staging.employeeId,
    firstName:        staging.employeeSnapshot.firstName,
    lastName:         staging.employeeSnapshot.lastName,
    fullName:         staging.employeeSnapshot.fullName,
    email:            staging.employeeSnapshot.email,
    department:       staging.employeeSnapshot.department,
    position:         staging.employeeSnapshot.position,
    employmentStatus: staging.employeeSnapshot.employmentStatus,
    hireDate:         staging.employeeSnapshot.hireDate,
  };

  // ── 2. Salary snapshot — directly from staging ──
  const salarySnapshot = {
    salaryStructureId: staging.salarySnapshot.salaryStructureId,
    effectiveFrom:     staging.salarySnapshot.effectiveFrom,
    effectiveTo:       staging.salarySnapshot.effectiveTo,
    components:        staging.salarySnapshot.components,
    grossMonthly:      staging.salarySnapshot.grossMonthly,
    currency:          staging.salarySnapshot.currency    || 'INR',
    payFrequency:      staging.salarySnapshot.payFrequency || 'monthly',
    workState:         staging.salarySnapshot.workState,
    pfEnrolled:        staging.salarySnapshot.pfEnrolled,
    esiEnrolled:       staging.salarySnapshot.esiEnrolled,
    ptEnrolled:        staging.salarySnapshot.ptEnrolled,
    pfWageOverride:    staging.salarySnapshot.pfWageOverride != null
                         ? staging.salarySnapshot.pfWageOverride
                         : null,
  };

  // ── 3. Compliance provenance — directly from staging.ruleProvenance ──────
  // Phase 9 does NOT re-query compliance rules.
  const complianceProvenance = (staging.ruleProvenance || []).map(p => ({
    ruleType:        p.ruleType,
    ruleId:          p.ruleId,
    jurisdiction:    p.jurisdiction,
    effectiveFrom:   p.effectiveFrom,
    effectiveTo:     p.effectiveTo,
    sourceReference: p.sourceReference,
  }));

  // ── 4. Payroll inputs — directly from staging.payrollInputs ──────────────
  const payrollInputs = {
    grossMonthly:         staging.payrollInputs.grossMonthly,
    basicSalary:          staging.payrollInputs.basicSalary,
    pfWageOverride:       staging.payrollInputs.pfWageOverride != null
                            ? staging.payrollInputs.pfWageOverride
                            : null,
    pfEnrolled:           staging.payrollInputs.pfEnrolled,
    esiEnrolled:          staging.payrollInputs.esiEnrolled,
    ptEnrolled:           staging.payrollInputs.ptEnrolled,
    workState:            staging.payrollInputs.workState,
    payrollDate:          staging.payrollInputs.payrollDate,
    attendanceAdjustment: 'DEFERRED',
  };

  // ── 5. Payroll results — from staging calculation outputs ─────────────────
  const epfEmployerContrib = (staging.epf && staging.epf.employerEpf) || 0;
  const esiEmployerContrib = (staging.esi && staging.esi.employerEsi) || 0;

  const payrollResults = {
    epf: staging.epf,
    esi: staging.esi,
    pt:  staging.pt,
    totalEmployeeDeductions: staging.totalEmployeeDeductions,
    employerTotalContribution: Math.round((epfEmployerContrib + esiEmployerContrib) * 100) / 100,
    // Honest field name: netPayBeforeTDS — NOT "final net pay"
    netPayBeforeTDS: staging.netPayBeforeTDS,
    tdsStatus:       'DEFERRED',
    tdsAmount:       null,
  };

  // ── 6. Assemble full snapshot payload ──────────────────────────────────────
  const runObj = run.toObject ? run.toObject() : run;
  const payload = {
    payrollRunId:      runObj._id,
    stagingResultId:   staging._id,
    companyId:         runObj.companyId,
    periodMonth:       runObj.periodMonth,
    periodYear:        runObj.periodYear,
    periodStart:       runObj.periodStart,
    periodEnd:         runObj.periodEnd,
    employeeSnapshot,
    salarySnapshot,
    complianceProvenance,
    payrollInputs,
    payrollResults,
    processingVersion: staging.processingVersion,
    snapshotStatus:    'PENDING_FINALIZATION',
  };

  // ── 7. Compute hash ──────────────────────────────────────────────────────
  payload.snapshotHash = computeSnapshotHash(payload);

  return payload;
}

// ─── Conflict detection ───────────────────────────────────────────────────────

function detectConflict(existingSnapshot, newPayload) {
  const newHash = computeSnapshotHash(newPayload);
  if (existingSnapshot.snapshotHash !== newHash) {
    return {
      conflict: true,
      reason:
        `SNAPSHOT_CONFLICT: existing hash (${existingSnapshot.snapshotHash.slice(0, 16)}…) ` +
        `≠ new payload hash (${newHash.slice(0, 16)}…). ` +
        `Employee: ${existingSnapshot.employeeSnapshot.fullName}. ` +
        `Human review required. Never silently overwrite financial history.`,
    };
  }
  return { conflict: false };
}

// ─── Service ──────────────────────────────────────────────────────────────────

const payrollSnapshotService = {

  // ───────────────────────────────────────────────────────────────────────────
  // MATERIALIZE
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Materialize PayrollSnapshots for a READY_FOR_FINALIZATION run.
   *
   * Idempotent: safe to call multiple times.
   *   - No snapshot: create PENDING_FINALIZATION from staging.
   *   - Identical snapshot exists: reuse (idempotent).
   *   - Conflicting snapshot exists: block with SNAPSHOT_CONFLICT.
   *
   * NOTE: This function ONLY reads PayrollStagingResult and PayrollRun.
   * It does NOT call Employee.findById, SalaryStructure.findById, or
   * ComplianceRuleVersion.findValidForDate.
   */
  async materializeSnapshots(runId, companyId, actor) {
    const run = await payrollRunRepository.findById(runId);
    if (!run) throw Object.assign(new Error('Payroll run not found.'), { statusCode: 404 });
    if (run.companyId.toString() !== companyId.toString()) {
      throw Object.assign(new Error('Run does not belong to your company.'), { statusCode: 403 });
    }
    if (run.status !== PAYROLL_STATUS.READY_FOR_FINALIZATION) {
      throw Object.assign(
        new Error(
          `Cannot materialize snapshots for a run in status '${run.status}'. ` +
          `Run must be READY_FOR_FINALIZATION.`
        ),
        { statusCode: 409 }
      );
    }

    const stagingResults = await payrollRunRepository.listStagingResults(
      runId,
      run.processingVersion
    );

    if (stagingResults.length === 0) {
      throw Object.assign(
        new Error('No staging results found. Cannot materialize snapshots.'),
        { statusCode: 422 }
      );
    }

    const runObj = run.toObject ? run.toObject() : run;
    const created   = [];
    const reused    = [];
    const conflicts = [];
    const errors    = [];

    for (const staging of stagingResults) {
      try {
        // Validate staging has the required frozen inputs
        if (!staging.employeeSnapshot || !staging.salarySnapshot || !staging.payrollInputs) {
          errors.push({
            employeeId: staging.employeeId.toString(),
            error: 'Staging result is missing required frozen inputs (employeeSnapshot, salarySnapshot, or payrollInputs). This staging result was created before the Phase 9 correction. Re-process the payroll run.',
          });
          continue;
        }

        const existing = await payrollSnapshotRepository.findByRunAndEmployee(
          runId,
          staging.employeeId
        );

        if (existing) {
          const newPayload = buildSnapshotPayloadFromStaging(staging, runObj);
          const { conflict, reason } = detectConflict(existing, newPayload);
          if (conflict) {
            conflicts.push({
              employeeId:   staging.employeeId.toString(),
              employeeName: staging.employeeSnapshot.fullName,
              reason,
            });
          } else {
            reused.push(existing._id.toString());
          }
          continue;
        }

        const payload  = buildSnapshotPayloadFromStaging(staging, runObj);
        const snapshot = await payrollSnapshotRepository.create(payload);

        await auditService.log({
          action:     'PAYROLL_SNAPSHOT_CREATED',
          actorId:    actor.id,
          actorEmail: actor.email,
          actorRole:  actor.role,
          entityType: 'PAYROLL_SNAPSHOT',
          entityId:   snapshot._id,
          meta: {
            payrollRunId: runId,
            employeeId:   staging.employeeId.toString(),
            periodMonth:  run.periodMonth,
            periodYear:   run.periodYear,
          },
        });

        created.push(snapshot._id.toString());

      } catch (err) {
        if (err.code === 11000) {
          errors.push({
            employeeId: staging.employeeId.toString(),
            error: 'Duplicate snapshot insert blocked by unique index.',
          });
        } else {
          errors.push({
            employeeId: staging.employeeId.toString(),
            error: err.message,
          });
        }
      }
    }

    return {
      runId,
      stagingCount:    stagingResults.length,
      created:         created.length,
      reused:          reused.length,
      conflicts:       conflicts.length,
      errors:          errors.length,
      conflictDetails: conflicts,
      errorDetails:    errors,
    };
  },

  // ───────────────────────────────────────────────────────────────────────────
  // FINALIZE
  // ───────────────────────────────────────────────────────────────────────────

  async finalizeRun(runId, companyId, actor) {
    const run = await payrollRunRepository.findById(runId);
    if (!run) throw Object.assign(new Error('Payroll run not found.'), { statusCode: 404 });
    if (run.companyId.toString() !== companyId.toString()) {
      throw Object.assign(new Error('Run does not belong to your company.'), { statusCode: 403 });
    }
    if (run.status !== PAYROLL_STATUS.READY_FOR_FINALIZATION) {
      throw Object.assign(
        new Error(
          `Cannot finalize a run in status '${run.status}'. ` +
          `Run must be READY_FOR_FINALIZATION.`
        ),
        { statusCode: 409 }
      );
    }

    const expectedCount = run.successfulEmployeeCount;

    // Staging completeness
    const stagingCount = await payrollRunRepository.countStagingResults(runId, run.processingVersion);
    if (stagingCount !== expectedCount) {
      throw Object.assign(
        new Error(
          `Finalization blocked: staging count mismatch. Expected ${expectedCount}, got ${stagingCount}.`
        ),
        { statusCode: 422 }
      );
    }

    // Snapshot completeness
    const snapshotCount = await payrollSnapshotRepository.countByRun(runId);
    if (snapshotCount !== expectedCount) {
      throw Object.assign(
        new Error(
          `Finalization blocked: snapshot count mismatch. Expected ${expectedCount}, got ${snapshotCount}. ` +
          `Run materializeSnapshots first.`
        ),
        { statusCode: 422 }
      );
    }

    // Duplicate check
    const duplicates = await payrollSnapshotRepository.findDuplicates(runId);
    if (duplicates.length > 0) {
      throw Object.assign(
        new Error(`Finalization blocked: duplicate snapshots for employees: ${duplicates.join(', ')}.`),
        { statusCode: 422 }
      );
    }

    // Hash integrity pass
    const allSnapshots = await payrollSnapshotRepository.findByRun(runId, { limit: 10000 });
    const hashFailures = [];
    for (const snap of allSnapshots) {
      const { valid, storedHash, computedHash } = verifySnapshotHash(snap);
      if (!valid) {
        hashFailures.push({
          snapshotId:   snap._id.toString(),
          employeeId:   snap.employeeSnapshot.employeeId.toString(),
          storedHash,
          computedHash,
        });
      }
    }
    if (hashFailures.length > 0) {
      throw Object.assign(
        new Error(
          `Finalization blocked: ${hashFailures.length} snapshot(s) have invalid hashes. ` +
          `Possible tampering. Human review required.`
        ),
        { statusCode: 422, hashFailures }
      );
    }

    // Short finalization transaction
    const session = await mongoose.startSession();
    let finalizedRun;
    try {
      session.startTransaction();

      const bulkResult = await payrollSnapshotRepository.bulkMarkFinalized(
        runId, actor.id, session
      );

      if (bulkResult.modifiedCount !== snapshotCount) {
        throw Object.assign(
          new Error(
            `Finalization transaction aborted: expected to finalize ${snapshotCount} snapshots ` +
            `but modified ${bulkResult.modifiedCount}. Possible concurrent finalization.`
          ),
          { statusCode: 409 }
        );
      }

      finalizedRun = await payrollRunRepository.finalize(
        runId,
        { finalizedBy: actor.id, resolvedRuleVersionIds: run.resolvedRuleVersionIds },
        { actorId: actor.id, actorEmail: actor.email, reason: 'Phase 9 finalization complete' },
        session
      );

      if (!finalizedRun) {
        throw Object.assign(
          new Error(
            'Finalization transaction aborted: PayrollRun was no longer READY_FOR_FINALIZATION ' +
            '(concurrent finalization attempt).'
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
          meta:           { snapshotCount, expectedCount, periodMonth: run.periodMonth, periodYear: run.periodYear },
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

    await auditService.log({
      action:     'PAYROLL_SNAPSHOT_FINALIZED',
      actorId:    actor.id,
      actorEmail: actor.email,
      actorRole:  actor.role,
      entityType: 'PAYROLL_RUN',
      entityId:   runId,
      meta:       { snapshotCount, periodMonth: run.periodMonth, periodYear: run.periodYear },
    });

    return { run: finalizedRun, snapshotCount };
  },

  // ───────────────────────────────────────────────────────────────────────────
  // VERIFY
  // ───────────────────────────────────────────────────────────────────────────

  async verifySnapshot(snapshotId) {
    const snap = await payrollSnapshotRepository.findById(snapshotId);
    if (!snap) throw Object.assign(new Error('Snapshot not found.'), { statusCode: 404 });

    const { valid, storedHash, computedHash } = verifySnapshotHash(snap);

    return {
      valid,
      snapshotId:     snap._id.toString(),
      payrollRunId:   snap.payrollRunId.toString(),
      employeeId:     snap.employeeSnapshot.employeeId.toString(),
      employeeName:   snap.employeeSnapshot.fullName,
      periodMonth:    snap.periodMonth,
      periodYear:     snap.periodYear,
      snapshotStatus: snap.snapshotStatus,
      storedHash,
      computedHash,
      reason: valid
        ? 'Snapshot hash matches stored content. No tampering detected.'
        : `INTEGRITY_FAILURE: stored hash (${storedHash.slice(0, 16)}…) ≠ ` +
          `computed hash (${computedHash.slice(0, 16)}…). Possible tampering. Human review required.`,
    };
  },

  // ───────────────────────────────────────────────────────────────────────────
  // READ
  // ───────────────────────────────────────────────────────────────────────────

  async getRunSnapshots(runId, companyId, opts = {}) {
    const run = await payrollRunRepository.findById(runId);
    if (!run) throw Object.assign(new Error('Payroll run not found.'), { statusCode: 404 });
    if (run.companyId.toString() !== companyId.toString()) {
      throw Object.assign(new Error('Run does not belong to your company.'), { statusCode: 403 });
    }
    const snapshots = await payrollSnapshotRepository.findByRun(runId, opts);
    const total     = await payrollSnapshotRepository.countByRun(runId);
    return { snapshots, total };
  },

  async getSnapshot(snapshotId, companyId) {
    const snap = await payrollSnapshotRepository.findById(snapshotId);
    if (!snap) throw Object.assign(new Error('Snapshot not found.'), { statusCode: 404 });
    if (snap.companyId.toString() !== companyId.toString()) {
      throw Object.assign(new Error('Snapshot does not belong to your company.'), { statusCode: 403 });
    }
    return snap;
  },

  async getEmployeeSnapshot(runId, employeeId, companyId) {
    const snap = await payrollSnapshotRepository.findByRunAndEmployee(runId, employeeId);
    if (!snap) throw Object.assign(new Error('Snapshot not found.'), { statusCode: 404 });
    if (snap.companyId.toString() !== companyId.toString()) {
      throw Object.assign(new Error('Snapshot does not belong to your company.'), { statusCode: 403 });
    }
    return snap;
  },
};

export default payrollSnapshotService;
