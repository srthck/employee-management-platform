import express from 'express';
import authMiddleware, { requireRole } from '../middleware/authMiddleware.js';
import {
  createPayrollRun,
  listPayrollRuns,
  getPayrollRun,
  runPreflight,
  processPayrollRun,
  finalizePayrollRun,
  cancelPayrollRun,
  recoverStuckRun,
} from '../controllers/payrollRunController.js';
import {
  validateCreatePayrollRun,
  validateRunId,
  validateListRuns,
  handleValidationErrors,
} from '../validators/payrollRunValidator.js';

/**
 * PayrollRun Routes
 *
 * All routes require valid JWT (authMiddleware).
 *
 * RBAC (current Admin model roles: 'admin' | 'manager'):
 *   admin   — full access (create, process, finalize, cancel, recover, view)
 *   manager — read only (list, get, preflight)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POST   /api/payroll-runs                  – Create DRAFT run (admin)
 * GET    /api/payroll-runs                  – List runs (admin, manager)
 * GET    /api/payroll-runs/:id              – Get single run (admin, manager)
 * POST   /api/payroll-runs/:id/preflight    – Preflight check (admin, manager)
 * POST   /api/payroll-runs/:id/process      – DRAFT/FAILED → PROCESSING → READY_FOR_FINALIZATION (admin)
 * POST   /api/payroll-runs/:id/finalize     – READY_FOR_FINALIZATION → FINALIZED (admin / Phase 9 gate)
 * POST   /api/payroll-runs/:id/cancel       – FAILED → CANCELLED (admin)
 * POST   /api/payroll-runs/:id/recover      – Recover stuck PROCESSING run → FAILED (admin)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * INTENTIONALLY ABSENT:
 *   PUT  /api/payroll-runs/:id           — NEVER expose. State machine owns status.
 *   PATCH /api/payroll-runs/:id/status   — NEVER expose. Use action endpoints.
 *   POST /api/payroll-runs/:id/disburse  — Future phase only (real bank disbursement).
 */

const router = express.Router();

// All payroll routes require authentication
router.use(authMiddleware);

// ─── Write routes (admin only) ────────────────────────────────────────────────
router.post(
  '/',
  requireRole('admin'),
  validateCreatePayrollRun,
  handleValidationErrors,
  createPayrollRun
);

router.post(
  '/:id/process',
  requireRole('admin'),
  validateRunId,
  handleValidationErrors,
  processPayrollRun
);

router.post(
  '/:id/finalize',
  requireRole('admin'),
  validateRunId,
  handleValidationErrors,
  finalizePayrollRun
);

router.post(
  '/:id/cancel',
  requireRole('admin'),
  validateRunId,
  handleValidationErrors,
  cancelPayrollRun
);

router.post(
  '/:id/recover',
  requireRole('admin'),
  validateRunId,
  handleValidationErrors,
  recoverStuckRun
);

// ─── Read routes (admin + manager) ───────────────────────────────────────────
router.get(
  '/',
  requireRole('admin', 'manager'),
  validateListRuns,
  handleValidationErrors,
  listPayrollRuns
);

router.get(
  '/:id',
  requireRole('admin', 'manager'),
  validateRunId,
  handleValidationErrors,
  getPayrollRun
);

router.post(
  '/:id/preflight',
  requireRole('admin', 'manager'),
  validateRunId,
  handleValidationErrors,
  runPreflight
);

export default router;
