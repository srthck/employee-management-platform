import express from 'express';
import { param, validationResult } from 'express-validator';
import authMiddleware, { requirePermission } from '../middleware/authMiddleware.js';
import { PERMISSIONS } from '../utils/permissions.js';
import { listMyPayslips, getMyPayslip } from '../controllers/meController.js';

/**
 * Employee self-service routes.
 *
 * GET /api/me/payslips      – own finalized payslips (employee)
 * GET /api/me/payslips/:id  – one explained payslip (employee)
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

const router = express.Router();
router.use(authMiddleware, requirePermission(PERMISSIONS.SELF_SERVICE));

router.get('/payslips', listMyPayslips);
router.get('/payslips/:id', param('id').isMongoId().withMessage('Invalid payslip ID.'), handleValidation, getMyPayslip);

export default router;
