import express from 'express';
import authMiddleware, { requirePermission } from '../middleware/authMiddleware.js';
import { payrollActionRateLimiter } from '../middleware/rateLimiter.js';
import { idempotent } from '../middleware/idempotency.js';
import { PERMISSIONS } from '../utils/permissions.js';
import { param, query, validationResult } from 'express-validator';
import {
  materializeSnapshots,
  finalizeRun,
  getRunSnapshots,
  getEmployeeSnapshot,
  getSnapshot,
  verifySnapshot,
  explainSnapshot,
} from '../controllers/payrollSnapshotController.js';

/**
 * PayrollSnapshot Routes (permission-based, see utils/permissions.js)
 *
 * ──────────────────────────────────────────────────────────────────────────
 * POST /api/payroll-runs/:runId/materialize       – Materialize snapshots   payroll.prepare
 * POST /api/payroll-runs/:runId/finalize-run      – Finalize run            payroll.finalize
 * GET  /api/payroll-runs/:runId/snapshots         – List run snapshots      payroll.read
 * GET  /api/payroll-runs/:runId/snapshots/:empId  – Employee snapshot       payroll.read
 * GET  /api/payroll-snapshots/:id                 – Get single snapshot     payroll.read
 * GET  /api/payroll-snapshots/:id/verify          – Verify hash integrity   payroll.read
 * GET  /api/payroll-snapshots/:id/explain         – Explained payslip       payroll.read
 * ──────────────────────────────────────────────────────────────────────────
 *
 * INTENTIONALLY ABSENT: any route that mutates or removes a snapshot.
 * Finalized snapshots are never changed.
 */

const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array().map(e => ({ field: e.param || e.path, message: e.msg })),
    });
  }
  next();
};

const P = PERMISSIONS;
const validateRunId     = [param('runId').isMongoId().withMessage('Invalid run ID.'), handleValidation];
const validateId        = [param('id').isMongoId().withMessage('Invalid snapshot ID.'), handleValidation];
const validateEmployeeId = [param('employeeId').isMongoId().withMessage('Invalid employee ID.'), handleValidation];
const validatePagination = [
  query('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
  query('skip').optional().isInt({ min: 0 }).toInt(),
  handleValidation,
];

// ─── Run-scoped routes (/api/payroll-runs/:runId/...) ─────────────────────────
export const runScopedRouter = express.Router({ mergeParams: true });
runScopedRouter.use(authMiddleware);

runScopedRouter.post(
  '/materialize',
  requirePermission(P.PAYROLL_PREPARE),
  payrollActionRateLimiter,
  validateRunId,
  materializeSnapshots
);

runScopedRouter.post(
  '/finalize-run',
  requirePermission(P.PAYROLL_FINALIZE),
  payrollActionRateLimiter,
  idempotent(),
  validateRunId,
  finalizeRun
);

runScopedRouter.get(
  '/snapshots',
  requirePermission(P.PAYROLL_READ),
  validateRunId,
  validatePagination,
  getRunSnapshots
);

runScopedRouter.get(
  '/snapshots/:employeeId',
  requirePermission(P.PAYROLL_READ),
  validateRunId,
  validateEmployeeId,
  getEmployeeSnapshot
);

// ─── Snapshot-scoped routes (/api/payroll-snapshots/:id/...) ─────────────────
export const snapshotRouter = express.Router();
snapshotRouter.use(authMiddleware);

snapshotRouter.get(
  '/:id',
  requirePermission(P.PAYROLL_READ),
  validateId,
  getSnapshot
);

snapshotRouter.get(
  '/:id/verify',
  requirePermission(P.PAYROLL_READ),
  validateId,
  verifySnapshot
);

snapshotRouter.get(
  '/:id/explain',
  requirePermission(P.PAYROLL_READ),
  validateId,
  explainSnapshot
);

export default { runScopedRouter, snapshotRouter };
