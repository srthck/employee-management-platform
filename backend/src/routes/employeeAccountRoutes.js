import express from 'express';

import authMiddleware, {
  requireRole,
} from '../middleware/authMiddleware.js';

import {
  createEmployeeAccount,
  getEmployeeAccount,
  updateEmployeeAccountStatus,
} from '../controllers/employeeAccountController.js';

const router = express.Router();

/*
 * Every employee-account operation requires authentication.
 */
router.use(authMiddleware);

/*
 * Create an employee login account.
 * Only Admin and Manager can do this.
 */
router.post(
  '/',
  requireRole('admin', 'manager'),
  createEmployeeAccount
);

/*
 * View an employee's login-account status.
 * Only Admin and Manager can view this.
 */
router.get(
  '/:employeeId',
  requireRole('admin', 'manager'),
  getEmployeeAccount
);

/*
 * Activate/deactivate an employee's login account.
 * Only Admin and Manager can do this.
 */
router.patch(
  '/:employeeId/status',
  requireRole('admin', 'manager'),
  updateEmployeeAccountStatus
);

export default router;