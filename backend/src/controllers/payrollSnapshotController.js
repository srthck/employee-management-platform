/**
 * payrollSnapshotController — HTTP layer for PayrollSnapshot operations.
 *
 * THIN layer: extract input, derive actor from the session, delegate to service.
 *
 * PROTECTED FIELDS (never accepted from client):
 *   snapshotStatus, finalizedAt, finalizedBy, snapshotHash, payrollRunId,
 *   employeeSnapshot, salarySnapshot, complianceProvenance, payrollResults.
 *
 * ROUTES:
 *   POST /api/payroll-runs/:runId/materialize     — materialize snapshots
 *   POST /api/payroll-runs/:runId/finalize-run    — verify + finalize
 *   GET  /api/payroll-runs/:runId/snapshots       — list run snapshots
 *   GET  /api/payroll-runs/:runId/snapshots/:empId — employee's snapshot
 *   GET  /api/payroll-snapshots/:id               — get single snapshot
 *   GET  /api/payroll-snapshots/:id/verify        — verify hash integrity
 *   GET  /api/payroll-snapshots/:id/explain       — explained payslip
 */

import payrollSnapshotService from '../services/payrollSnapshotService.js';
import payrollFinalizationService from '../services/payrollFinalizationService.js';
import payslipService from '../services/payslipService.js';

function actorFromRequest(req) {
  return { id: req.user.id, email: req.user.email, role: req.user.role };
}

function companyIdFromRequest(req) {
  return req.user.companyId || req.user.id;
}

// ─── POST /api/payroll-runs/:runId/materialize ────────────────────────────────
export const materializeSnapshots = async (req, res) => {
  const actor     = actorFromRequest(req);
  const companyId = companyIdFromRequest(req);

  const result = await payrollSnapshotService.materializeSnapshots(
    req.params.runId,
    companyId,
    actor
  );

  const hasConflicts = result.conflicts > 0;
  const hasErrors    = result.errors > 0;

  return res.status(hasConflicts || hasErrors ? 409 : 200).json({
    success: !hasConflicts && !hasErrors,
    message: hasConflicts
      ? 'Snapshot conflicts detected. Human review required.'
      : hasErrors
        ? 'Some snapshots failed to materialize.'
        : 'Snapshots materialized successfully.',
    data: result,
  });
};

// ─── POST /api/payroll-runs/:runId/finalize-run ───────────────────────────────
export const finalizeRun = async (req, res) => {
  const actor     = actorFromRequest(req);
  const companyId = companyIdFromRequest(req);

  // Same controls as POST /payroll-runs/:id/finalize: segregation of duties,
  // variance gate and override are enforced for every finalization path.
  const { run, snapshotCount } = await payrollFinalizationService.finalize(
    req.params.runId,
    companyId,
    actor,
    { override: req.body?.override || null }
  );

  return res.status(200).json({
    success: true,
    message: `Payroll run finalized. ${snapshotCount} snapshot(s) permanently locked.`,
    data: { run, snapshotCount },
  });
};

// ─── GET /api/payroll-runs/:runId/snapshots ───────────────────────────────────
export const getRunSnapshots = async (req, res) => {
  const companyId = companyIdFromRequest(req);
  const { limit, skip } = req.query;

  const { snapshots, total } = await payrollSnapshotService.getRunSnapshots(
    req.params.runId,
    companyId,
    {
      limit: limit ? Number(limit) : 50,
      skip:  skip  ? Number(skip)  : 0,
    }
  );

  return res.status(200).json({
    success: true,
    data: { snapshots, total },
  });
};

// ─── GET /api/payroll-runs/:runId/snapshots/:employeeId ───────────────────────
export const getEmployeeSnapshot = async (req, res) => {
  const companyId = companyIdFromRequest(req);

  const snapshot = await payrollSnapshotService.getEmployeeSnapshot(
    req.params.runId,
    req.params.employeeId,
    companyId
  );

  return res.status(200).json({
    success: true,
    data: { snapshot },
  });
};

// ─── GET /api/payroll-snapshots/:id ──────────────────────────────────────────
export const getSnapshot = async (req, res) => {
  const companyId = companyIdFromRequest(req);

  const snapshot = await payrollSnapshotService.getSnapshot(req.params.id, companyId);

  return res.status(200).json({
    success: true,
    data: { snapshot },
  });
};

// ─── GET /api/payroll-snapshots/:id/verify ────────────────────────────────────
export const verifySnapshot = async (req, res) => {
  const result = await payrollSnapshotService.verifySnapshot(req.params.id, companyIdFromRequest(req));

  return res.status(result.valid ? 200 : 409).json({
    success: result.valid,
    data: result,
  });
};

// ─── GET /api/payroll-snapshots/:id/explain ───────────────────────────────────
export const explainSnapshot = async (req, res) => {
  const snapshot = await payrollSnapshotService.getSnapshot(req.params.id, companyIdFromRequest(req));

  return res.status(200).json({
    success: true,
    data: { payslip: payslipService.buildPayslip(snapshot) },
  });
};
