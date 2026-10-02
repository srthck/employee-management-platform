import express from 'express';
import authMiddleware, { requirePermission } from '../middleware/authMiddleware.js';
import { idempotent } from '../middleware/idempotency.js';
import { PERMISSIONS } from '../utils/permissions.js';

import {
  getEmployees,
  getEmployeeStats,
  getEmployee,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  restoreEmployee,
} from '../controllers/employeeController.js';

import {
  validateCreateEmployee,
  validateUpdateEmployee,
  validateEmployeeQuery,
  validateEmployeeId,
  validateArchiveEmployee,
  handleValidationErrors,
} from '../validators/employeeValidator.js';

/**
 * Employee Routes
 *
 * All routes require authentication and are scoped to the caller's company.
 * Access is permission-based (utils/permissions.js):
 *
 * GET    /api/employees              employee.read
 * GET    /api/employees/stats        employee.read
 * GET    /api/employees/:id          employee.read
 * POST   /api/employees              employee.write   (Idempotency-Key supported)
 * PUT    /api/employees/:id          employee.write
 * DELETE /api/employees/:id          employee.archive (soft delete)
 * POST   /api/employees/:id/restore  employee.archive
 */

const router = express.Router();
const P = PERMISSIONS;

router.use(authMiddleware);

// ─── Read ─────────────────────────────────────────────────────────────────────

router.get(
  '/stats',
  requirePermission(P.EMPLOYEE_READ),
  getEmployeeStats
);

router.get(
  '/',
  requirePermission(P.EMPLOYEE_READ),
  validateEmployeeQuery,
  handleValidationErrors,
  getEmployees
);

router.get(
  '/:id',
  requirePermission(P.EMPLOYEE_READ),
  validateEmployeeId,
  handleValidationErrors,
  getEmployee
);

// ─── Create / Update ──────────────────────────────────────────────────────────

router.post(
  '/',
  requirePermission(P.EMPLOYEE_WRITE),
  idempotent(),
  validateCreateEmployee,
  handleValidationErrors,
  createEmployee
);

router.put(
  '/:id',
  requirePermission(P.EMPLOYEE_WRITE),
  validateEmployeeId,
  validateUpdateEmployee,
  handleValidationErrors,
  updateEmployee
);

// ─── Archive / Restore ────────────────────────────────────────────────────────

router.delete(
  '/:id',
  requirePermission(P.EMPLOYEE_ARCHIVE),
  validateEmployeeId,
  validateArchiveEmployee,
  handleValidationErrors,
  deleteEmployee
);

router.post(
  '/:id/restore',
  requirePermission(P.EMPLOYEE_ARCHIVE),
  validateEmployeeId,
  handleValidationErrors,
  restoreEmployee
);

export default router;
