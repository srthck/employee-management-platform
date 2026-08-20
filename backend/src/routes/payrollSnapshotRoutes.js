import express from 'express';
import authMiddleware, { requireRole } from '../middleware/authMiddleware.js';
import { param, query, validationResult } from 'express-validator';
import {
  materializeSnapshots,
  finalizeRun,
  getRunSnapshots,
  getEmployeeSnapshot,
  getSnapshot,
  verifySnapshot,
} from '../controllers/payrollSnapshotController.js';

/**
 * PayrollSnapshot Routes
 *
 * RBAC (Admin roles: 'admin' | 'manager'):
 *   admin   — full access (materialize, finalize, read, verify)
 *   manager — read + verify only
 *
 * ──────────────────────────────────────────────────────────────────────────
 * POST /api/payroll-runs/:runId/materialize       – Materialize snapshots (admin)
 * POST /api/payroll-runs/:runId/finalize-run      – Finalize run (admin)
 * GET  /api/payroll-runs/:runId/snapshots         – List run snapshots (admin, manager)
 * GET  /api/payroll-runs/:runId/snapshots/:empId  – Employee snapshot (admin, manager)
 * GET  /api/payroll-snapshots/:id                 – Get single snapshot (admin, manager)
 * GET  /api/payroll-snapshots/:id/verify          – Verify hash integrity (admin, manager)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * INTENTIONALLY ABSENT:
 *   PUT  /api/payroll-snapshots/:id  — NO mutation of finalized snapshots.
 *   PATCH /api/payroll-snapshots/:id — NO mutation of finalized snapshots.
 *   DELETE /api/payroll-snapshots/:id — NO deletion of finalized snapshots.
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
  requireRole('admin'),
  validateRunId,
  materializeSnapshots
);

runScopedRouter.post(
  '/finalize-run',
  requireRole('admin'),
  validateRunId,
  finalizeRun
);

runScopedRouter.get(
  '/snapshots',
  requireRole('admin', 'manager'),
  validateRunId,
  validatePagination,
  getRunSnapshots
);

runScopedRouter.get(
  '/snapshots/:employeeId',
  requireRole('admin', 'manager'),
  validateRunId,
  validateEmployeeId,
  getEmployeeSnapshot
);

// ─── Snapshot-scoped routes (/api/payroll-snapshots/:id/...) ─────────────────
export const snapshotRouter = express.Router();
snapshotRouter.use(authMiddleware);

snapshotRouter.get(
  '/:id',
  requireRole('admin', 'manager'),
  validateId,
  getSnapshot
);

snapshotRouter.get(
  '/:id/verify',
  requireRole('admin', 'manager'),
  validateId,
  verifySnapshot
);

export default { runScopedRouter, snapshotRouter };
