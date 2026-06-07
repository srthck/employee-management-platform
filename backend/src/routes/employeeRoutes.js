import express from 'express';
import authMiddleware from '../middleware/authMiddleware.js';
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
 * All routes require a valid JWT (authMiddleware).
 *
 * GET    /api/employees         – paginated list with search/filter
 * GET    /api/employees/stats   – dashboard statistics
 * GET    /api/employees/:id     – single employee
 * POST   /api/employees         – create employee
 * PUT    /api/employees/:id     – update employee
 * DELETE /api/employees/:id     – delete employee
 */

const router = express.Router();

// All employee routes are protected
router.use(authMiddleware);

router.get(
  '/stats',
  getEmployeeStats
);

router.get(
  '/',
  validateEmployeeQuery,
  handleValidationErrors,
  getEmployees
);

router.get(
  '/:id',
  validateEmployeeId,
  handleValidationErrors,
  getEmployee
);

router.post(
  '/',
  validateCreateEmployee,
  handleValidationErrors,
  createEmployee
);

router.put(
  '/:id',
  validateEmployeeId,
  validateUpdateEmployee,
  handleValidationErrors,
  updateEmployee
);

router.delete(
  '/:id',
  validateEmployeeId,
  handleValidationErrors,
  deleteEmployee
);

export default router;
