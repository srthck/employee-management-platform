import express from 'express';
import { body, param, validationResult } from 'express-validator';
import authMiddleware, { requirePermission } from '../middleware/authMiddleware.js';
import { idempotent } from '../middleware/idempotency.js';
import { PERMISSIONS, STAFF_ROLES } from '../utils/permissions.js';
import { PAYABLE_DAYS_BASES, PROFESSIONAL_TAX_BASES } from '../utils/payBasis.js';
import {
  getCompany,
  updateCompanySettings,
  listCompanyUsers,
  createCompanyUser,
  updateCompanyUser,
} from '../controllers/companyController.js';

/**
 * Company routes
 *
 * GET   /api/company                  company.read    settings + role catalogue
 * PATCH /api/company/settings         company.manage  name, approval modes, pay basis,
 *                                                     variance controls
 * GET   /api/company/users            company.manage
 * POST  /api/company/users            company.manage  (Idempotency-Key supported)
 * PATCH /api/company/users/:userId    company.manage  role / active status
 */

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

const P = PERMISSIONS;
const router = express.Router();
router.use(authMiddleware);

router.get('/', requirePermission(P.COMPANY_READ), getCompany);

router.patch(
  '/settings',
  requirePermission(P.COMPANY_MANAGE),
  body('name').optional().isString().trim().isLength({ min: 2, max: 120 }).withMessage('Company name must be 2–120 characters.'),
  body('settings').optional().isObject(),
  body('settings.approvalMode').optional().isIn(['single', 'maker_checker']).withMessage('approvalMode must be single or maker_checker.'),
  body('settings.varianceThresholdPercent').optional().isInt({ min: 1, max: 100 }).withMessage('varianceThresholdPercent must be 1–100.').toInt(),
  body('settings.blockFinalizationOnUnexplainedVariance').optional().isBoolean({ strict: true }).withMessage('blockFinalizationOnUnexplainedVariance must be true or false.'),
  body('settings.compensationApprovalMode').optional().isIn(['single', 'maker_checker'])
    .withMessage('compensationApprovalMode must be single or maker_checker.'),
  body('settings.payableDaysBasis').optional().isIn(PAYABLE_DAYS_BASES)
    .withMessage(`payableDaysBasis must be one of: ${PAYABLE_DAYS_BASES.join(', ')}.`),
  body('settings.fixedPayableDays').optional().isInt({ min: 20, max: 31 })
    .withMessage('fixedPayableDays must be 20-31.').toInt(),
  body('settings.weeklyOffDays').optional().isArray({ min: 0, max: 6 })
    .withMessage('weeklyOffDays must be a list of weekdays.'),
  body('settings.weeklyOffDays.*').optional().isInt({ min: 0, max: 6 })
    .withMessage('A weekly off day is 0 (Sunday) to 6 (Saturday).').toInt(),
  body('settings.professionalTaxBasis').optional().isIn(PROFESSIONAL_TAX_BASES)
    .withMessage(`professionalTaxBasis must be one of: ${PROFESSIONAL_TAX_BASES.join(', ')}.`),
  handleValidation,
  updateCompanySettings
);

router.get('/users', requirePermission(P.COMPANY_MANAGE), listCompanyUsers);

router.post(
  '/users',
  requirePermission(P.COMPANY_MANAGE),
  idempotent(),
  body('name').isString().trim().isLength({ min: 2, max: 50 }).withMessage('Name must be 2–50 characters.'),
  body('email').isEmail().withMessage('A valid email is required.').normalizeEmail(),
  body('role').isIn(STAFF_ROLES).withMessage(`Role must be one of: ${STAFF_ROLES.join(', ')}.`),
  body('password')
    .isString().withMessage('Password is required.')
    .isLength({ min: 8, max: 64 }).withMessage('Password must be 8–64 characters.')
    .matches(/[a-z]/).withMessage('Password must contain a lowercase letter.')
    .matches(/[A-Z]/).withMessage('Password must contain an uppercase letter.')
    .matches(/\d/).withMessage('Password must contain a digit.'),
  handleValidation,
  createCompanyUser
);

router.patch(
  '/users/:userId',
  requirePermission(P.COMPANY_MANAGE),
  param('userId').isMongoId().withMessage('Invalid user ID.'),
  body('role').optional().isIn(STAFF_ROLES).withMessage(`Role must be one of: ${STAFF_ROLES.join(', ')}.`),
  body('isActive').optional().isBoolean({ strict: true }).withMessage('isActive must be true or false.'),
  handleValidation,
  updateCompanyUser
);

export default router;
