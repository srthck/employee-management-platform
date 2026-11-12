import express from 'express';
import { body, param, query, validationResult } from 'express-validator';
import authMiddleware, { requirePermission } from '../middleware/authMiddleware.js';
import { idempotent } from '../middleware/idempotency.js';
import { sensitiveRevealRateLimiter } from '../middleware/rateLimiter.js';
import { PERMISSIONS } from '../utils/permissions.js';
import { EMPLOYMENT_CHANGE_TYPES } from '../utils/workforce.js';
import {
  getEmployment,
  recordEmploymentChange,
  getStatutoryProfile,
  updateStatutoryProfile,
  revealStatutoryField,
  getBankAccounts,
  addBankAccount,
  revealBankAccountNumber,
  getDocuments,
  submitDocument,
  decideDocument,
  getEmployeeReadiness,
  getCompanyReadiness,
} from '../controllers/employeeProfileController.js';

/**
 * Employee 360 routes (mounted at /api/employees)
 *
 * GET  /:employeeId/employment                          employee.read
 * POST /:employeeId/employment                          employee.write            (Idempotency-Key)
 * GET  /:employeeId/statutory                           employee.read             masked
 * POST /:employeeId/statutory                           employee.statutory.write  (Idempotency-Key)
 * POST /:employeeId/statutory/reveal                    sensitive.read            audited
 * GET  /:employeeId/bank-accounts                       employee.read             masked
 * POST /:employeeId/bank-accounts                       employee.bank.write       (Idempotency-Key)
 * POST /:employeeId/bank-accounts/:accountId/reveal     sensitive.read            audited
 * GET  /:employeeId/documents                           employee.read
 * POST /:employeeId/documents                           employee.document.write   (Idempotency-Key)
 * POST /:employeeId/documents/:documentId/decision      employee.document.verify  (Idempotency-Key)
 * GET  /:employeeId/payroll-readiness                   employee.read
 *
 * Reveal endpoints are never idempotent-replayable: idempotency records store
 * response bodies, and a decrypted value must not be persisted anywhere.
 *
 * Company-wide readiness is exported as readinessRouter (/api/payroll-readiness).
 */

const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array().map((e) => ({ field: e.path, message: e.msg })),
    });
  }
  return next();
};

const P = PERMISSIONS;
const employee = [param('employeeId').isMongoId().withMessage('Invalid employee ID.')];
const optionalText = (field, max) => body(field).optional({ nullable: true }).isString().withMessage(`${field} must be text.`).isLength({ max }).withMessage(`${field} cannot exceed ${max} characters.`);
const revealReason = body('reason')
  .isString().withMessage('A reason is required to reveal sensitive data.')
  .trim()
  .isLength({ min: 10, max: 300 }).withMessage('A reason of 10 to 300 characters is required to reveal sensitive data.');
const period = [
  query('periodYear').optional().isInt({ min: 2000, max: 2100 }).withMessage('periodYear must be between 2000 and 2100.').toInt(),
  query('periodMonth').optional().isInt({ min: 1, max: 12 }).withMessage('periodMonth must be between 1 and 12.').toInt(),
];

const router = express.Router();
router.use(authMiddleware);

// ─── Employment history ─────────────────────────────────────────────────────
router.get('/:employeeId/employment', requirePermission(P.EMPLOYEE_READ), employee, handleValidation, getEmployment);
router.post(
  '/:employeeId/employment',
  requirePermission(P.EMPLOYEE_WRITE),
  idempotent(),
  [
    ...employee,
    body('changeType').isIn(EMPLOYMENT_CHANGE_TYPES.filter((type) => type !== 'JOINING')).withMessage('Unsupported change type.'),
    body('effectiveFrom').optional({ nullable: true }).isISO8601().withMessage('effectiveFrom must be a date.'),
    body('changes').optional().isObject().withMessage('changes must be an object.'),
    body('exit').optional().isObject().withMessage('exit must be an object.'),
    optionalText('reason', 500),
  ],
  handleValidation,
  recordEmploymentChange
);

// ─── Statutory profile ──────────────────────────────────────────────────────
router.get('/:employeeId/statutory', requirePermission(P.EMPLOYEE_READ), employee, handleValidation, getStatutoryProfile);
router.post(
  '/:employeeId/statutory',
  requirePermission(P.EMPLOYEE_STATUTORY_WRITE),
  idempotent(),
  [...employee, optionalText('reason', 300)],
  handleValidation,
  updateStatutoryProfile
);
router.post(
  '/:employeeId/statutory/reveal',
  sensitiveRevealRateLimiter,
  requirePermission(P.SENSITIVE_READ),
  [...employee, body('field').isIn(['pan', 'uan', 'esicNumber', 'pfMemberId']).withMessage('Unknown statutory field.'), revealReason],
  handleValidation,
  revealStatutoryField
);

// ─── Bank accounts ──────────────────────────────────────────────────────────
router.get('/:employeeId/bank-accounts', requirePermission(P.EMPLOYEE_READ), employee, handleValidation, getBankAccounts);
router.post(
  '/:employeeId/bank-accounts',
  requirePermission(P.EMPLOYEE_BANK_WRITE),
  idempotent({ required: true }), // a payment destination: required
  [...employee, optionalText('reason', 300), body('effectiveFrom').optional({ nullable: true }).isISO8601().withMessage('effectiveFrom must be a date.')],
  handleValidation,
  addBankAccount
);
router.post(
  '/:employeeId/bank-accounts/:accountId/reveal',
  sensitiveRevealRateLimiter,
  requirePermission(P.SENSITIVE_READ),
  [...employee, param('accountId').isMongoId().withMessage('Invalid bank account ID.'), revealReason],
  handleValidation,
  revealBankAccountNumber
);

// ─── Documents ──────────────────────────────────────────────────────────────
router.get('/:employeeId/documents', requirePermission(P.EMPLOYEE_READ), employee, handleValidation, getDocuments);
router.post(
  '/:employeeId/documents',
  requirePermission(P.EMPLOYEE_DOCUMENT_WRITE),
  idempotent(),
  [...employee, optionalText('notes', 300)],
  handleValidation,
  submitDocument
);
router.post(
  '/:employeeId/documents/:documentId/decision',
  requirePermission(P.EMPLOYEE_DOCUMENT_VERIFY),
  idempotent(),
  [
    ...employee,
    param('documentId').isMongoId().withMessage('Invalid document ID.'),
    body('decision').isIn(['VERIFIED', 'REJECTED']).withMessage('decision must be VERIFIED or REJECTED.'),
    optionalText('note', 300),
  ],
  handleValidation,
  decideDocument
);

// ─── Payroll readiness ──────────────────────────────────────────────────────
router.get('/:employeeId/payroll-readiness', requirePermission(P.EMPLOYEE_READ), [...employee, ...period], handleValidation, getEmployeeReadiness);

export const readinessRouter = express.Router();
readinessRouter.use(authMiddleware);
readinessRouter.get('/', requirePermission(P.PAYROLL_READ), period, handleValidation, getCompanyReadiness);

export default router;
