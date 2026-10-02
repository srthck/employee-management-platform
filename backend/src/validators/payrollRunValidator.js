import { body, param, query, validationResult } from 'express-validator';

/**
 * payrollRunValidator — express-validator chains for PayrollRun endpoints.
 *
 * PROTECTED FIELDS (never accepted from client):
 *   status, finalizedBy, startedAt, completedAt, finalizedAt, disbursedAt,
 *   employeeCount, processedEmployeeCount, successfulEmployeeCount, failedEmployeeCount.
 *
 * These are always derived server-side from the state machine and actual processing.
 */

// ─── Create PayrollRun ────────────────────────────────────────────────────────
export const validateCreatePayrollRun = [
  body('periodMonth')
    .notEmpty().withMessage('periodMonth is required')
    .isInt({ min: 1, max: 12 }).withMessage('periodMonth must be an integer between 1 and 12')
    .toInt(),

  body('periodYear')
    .notEmpty().withMessage('periodYear is required')
    .isInt({ min: 2000, max: 2100 }).withMessage('periodYear must be an integer between 2000 and 2100')
    .toInt(),

  body('idempotencyKey')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 128 }).withMessage('idempotencyKey cannot exceed 128 characters'),

  // Explicitly reject protected fields
  body('status').not().exists().withMessage('status cannot be set by the client.'),
  body('finalizedBy').not().exists().withMessage('finalizedBy cannot be set by the client.'),
  body('companyId').not().exists().withMessage('companyId is derived from authentication.'),
];

// ─── MongoDB ID param ─────────────────────────────────────────────────────────
export const validateRunId = [
  param('id').isMongoId().withMessage('Invalid payroll run ID format.'),
];

// ─── List query params ────────────────────────────────────────────────────────
export const validateListRuns = [
  query('status')
    .optional()
    .isIn(['DRAFT', 'PROCESSING', 'READY_FOR_FINALIZATION', 'FINALIZED', 'DISBURSED', 'FAILED', 'CANCELLED'])
    .withMessage('Invalid status filter.'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 }).withMessage('limit must be 1–100')
    .toInt(),
  query('skip')
    .optional()
    .isInt({ min: 0 }).withMessage('skip must be >= 0')
    .toInt(),
];

// ─── Shared error handler ─────────────────────────────────────────────────────
export const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array().map((err) => ({
        field: err.param || err.path,
        message: err.msg,
      })),
    });
  }
  next();
};
