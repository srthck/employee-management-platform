import express from 'express';
import authMiddleware, { requireRole } from '../middleware/authMiddleware.js';

import {
  getEmployees,
  getEmployeeStats,
  getEmployee,
  createEmployee,
  updateEmployee,
  deleteEmployee,
} from '../controllers/employeeController.js';

import {
  validateCreateEmployee,
  validateUpdateEmployee,
  validateEmployeeQuery,
  validateEmployeeId,
  handleValidationErrors,
} from '../validators/employeeValidator.js';

/**
 * Employee Routes
 *
 * All routes require authentication.
 *
 * RBAC:
 *   admin   → full employee management
 *   manager → employee viewing, creation and updating
 *
 * DELETE is restricted to admin.
 *
 * GET    /api/employees
 * GET    /api/employees/stats
 * GET    /api/employees/:id
 * POST   /api/employees
 * PUT    /api/employees/:id
 * DELETE /api/employees/:id
 */

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Authentication
// ─────────────────────────────────────────────────────────────────────────────

// All employee routes require a valid JWT.
router.use(authMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
// Read Operations
// Admin + Manager
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  '/stats',
  requireRole('admin', 'manager'),
  getEmployeeStats
);

router.get(
  '/',
  requireRole('admin', 'manager'),
  validateEmployeeQuery,
  handleValidationErrors,
  getEmployees
);

router.get(
  '/:id',
  requireRole('admin', 'manager'),
  validateEmployeeId,
  handleValidationErrors,
  getEmployee
);

// ─────────────────────────────────────────────────────────────────────────────
// Create / Update
// Admin + Manager
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  '/',
  requireRole('admin', 'manager'),
  validateCreateEmployee,
  handleValidationErrors,
  createEmployee
);

router.put(
  '/:id',
  requireRole('admin', 'manager'),
  validateEmployeeId,
  validateUpdateEmployee,
  handleValidationErrors,
  updateEmployee
);

// ─────────────────────────────────────────────────────────────────────────────
// Delete
// Admin only
// ─────────────────────────────────────────────────────────────────────────────

router.delete(
  '/:id',
  requireRole('admin'),
  validateEmployeeId,
  handleValidationErrors,
  deleteEmployee
);

export default router;