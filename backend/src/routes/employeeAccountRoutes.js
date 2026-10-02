import express from 'express';
import { body, param, validationResult } from 'express-validator';

import authMiddleware, {
  requirePermission,
} from '../middleware/authMiddleware.js';
import { idempotent } from '../middleware/idempotency.js';
import { PERMISSIONS } from '../utils/permissions.js';

import {
  createEmployeeAccount,
  getEmployeeAccount,
  updateEmployeeAccountStatus,
} from '../controllers/employeeAccountController.js';

const router = express.Router();

const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array().map((e) => ({ field: e.path, message: e.msg })),
    });
  }
  return next();
};

const validateEmployeeParam = param('employeeId').isMongoId().withMessage('Invalid employee ID.');

/*
 * Every employee-account operation requires authentication and the
 * employee_account.manage permission.
 */
router.use(authMiddleware, requirePermission(PERMISSIONS.EMPLOYEE_ACCOUNT_MANAGE));

/*
 * Create an employee login account.
 */
router.post(
  '/',
  idempotent(),
  body('employeeId').isMongoId().withMessage('A valid employeeId is required.'),
  body('password')
    .isString().withMessage('Password is required.')
    .isLength({ min: 8, max: 64 }).withMessage('Password must be 8–64 characters.')
    .matches(/[a-z]/).withMessage('Password must contain a lowercase letter.')
    .matches(/[A-Z]/).withMessage('Password must contain an uppercase letter.')
    .matches(/\d/).withMessage('Password must contain a digit.'),
  handleValidation,
  createEmployeeAccount
);

/*
 * View an employee's login-account status.
 */
router.get(
  '/:employeeId',
  validateEmployeeParam,
  handleValidation,
  getEmployeeAccount
);

/*
 * Activate/deactivate an employee's login account.
 */
router.patch(
  '/:employeeId/status',
  validateEmployeeParam,
  body('isActive').isBoolean({ strict: true }).withMessage('isActive must be true or false.'),
  handleValidation,
  updateEmployeeAccountStatus
);

export default router;
