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
 * RBAC mapping (current Admin model has roles: 'admin' | 'manager'):
 *   admin   — full access (create, process, finalize, cancel, view)
 *   manager — view only (list, get, preflight)
 *
 * Write endpoints (create, process, finalize, cancel) require 'admin' role.
 * Read endpoints (list, get, preflight) permit both 'admin' and 'manager'.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POST   /api/payroll-runs                  – Create DRAFT run (admin)
 * GET    /api/payroll-runs                  – List runs (admin, manager)
 * GET    /api/payroll-runs/:id              – Get single run (admin, manager)
 * POST   /api/payroll-runs/:id/preflight   – Preflight check (admin, manager)
 * POST   /api/payroll-runs/:id/process     – Process run (admin)
 * POST   /api/payroll-runs/:id/finalize    – Finalize run (admin)
 * POST   /api/payroll-runs/:id/cancel      – Cancel FAILED run (admin)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * INTENTIONALLY ABSENT:
 *   PUT /api/payroll-runs/:id              – NEVER expose. State machine owns status.
 *   PATCH /api/payroll-runs/:id/status     – NEVER expose. Use action endpoints.
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
