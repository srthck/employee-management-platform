import express from 'express';
import { body, param, validationResult } from 'express-validator';
import authMiddleware, { requirePermission } from '../middleware/authMiddleware.js';
import { idempotent } from '../middleware/idempotency.js';
import { PERMISSIONS } from '../utils/permissions.js';
import { getCurrentSalary, getSalaryHistory, createSalaryRevision } from '../controllers/salaryController.js';

const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, message: 'Validation failed', errors: errors.array().map((e) => ({ field: e.path, message: e.msg })) });
  next();
};

const validateEmployee = [param('employeeId').isMongoId().withMessage('Invalid employee ID.')];
const nonNegative = (field) => body(field).optional().isFloat({ min: 0 }).withMessage(`${field} must be a non-negative number.`).toFloat();
const validateRevision = [
  ...validateEmployee,
  body('effectiveFrom').isISO8601().withMessage('effectiveFrom must be a valid date.'),
  body('components').isObject().withMessage('components is required.'),
  body('components.basic').isFloat({ min: 0 }).withMessage('components.basic is required and must be non-negative.').toFloat(),
  ...['hra', 'conveyanceAllowance', 'medicalAllowance', 'specialAllowance', 'otherAllowances'].map(nonNegative),
  body('currency').optional().isString().isLength({ min: 3, max: 3 }),
  body('payFrequency').optional().isIn(['monthly', 'semi-monthly', 'bi-weekly', 'weekly']),
  body('workState').isString().withMessage('workState is required (PT jurisdiction is never assumed).').trim().isLength({ min: 2, max: 20 }).withMessage('workState must be 2–20 characters.'),
  body('pfEnrolled').optional().isBoolean().toBoolean(),
  body('esiEnrolled').optional().isBoolean().toBoolean(),
  body('ptEnrolled').optional().isBoolean().toBoolean(),
  body('pfWageOverride').optional().isFloat({ min: 0 }).toFloat(),
  body('remarks').optional().isString().isLength({ max: 500 }).trim(),
];

// GET  /api/employees/:employeeId/salary/current   salary.read
// GET  /api/employees/:employeeId/salary           salary.read
// POST /api/employees/:employeeId/salary           salary.revise (Idempotency-Key supported)
const router = express.Router();
router.use(authMiddleware);
router.get('/:employeeId/salary/current', requirePermission(PERMISSIONS.SALARY_READ), validateEmployee, handleValidation, getCurrentSalary);
router.get('/:employeeId/salary', requirePermission(PERMISSIONS.SALARY_READ), validateEmployee, handleValidation, getSalaryHistory);
router.post('/:employeeId/salary', requirePermission(PERMISSIONS.SALARY_REVISE), idempotent(), validateRevision, handleValidation, createSalaryRevision);
export default router;
