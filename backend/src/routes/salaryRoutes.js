import express from 'express';
import { body, param, validationResult } from 'express-validator';
import authMiddleware, { requireRole } from '../middleware/authMiddleware.js';
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
  body('workState').optional().isString().trim().isLength({ min: 2, max: 20 }),
  body('pfEnrolled').optional().isBoolean().toBoolean(),
  body('esiEnrolled').optional().isBoolean().toBoolean(),
  body('ptEnrolled').optional().isBoolean().toBoolean(),
  body('pfWageOverride').optional().isFloat({ min: 0 }).toFloat(),
  body('remarks').optional().isString().isLength({ max: 500 }).trim(),
];

const router = express.Router();
router.use(authMiddleware);
router.get('/:employeeId/salary/current', requireRole('admin', 'manager'), validateEmployee, handleValidation, getCurrentSalary);
router.get('/:employeeId/salary', requireRole('admin', 'manager'), validateEmployee, handleValidation, getSalaryHistory);
router.post('/:employeeId/salary', requireRole('admin'), validateRevision, handleValidation, createSalaryRevision);
export default router;
