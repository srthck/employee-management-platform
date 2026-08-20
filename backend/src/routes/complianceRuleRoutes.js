import express from 'express';
import { param, query, validationResult } from 'express-validator';
import authMiddleware, { requireRole } from '../middleware/authMiddleware.js';
import { listRules, getRule } from '../controllers/complianceRuleController.js';

const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, message: 'Validation failed', errors: errors.array().map((e) => ({ field: e.path, message: e.msg })) });
  next();
};
const router = express.Router();
router.use(authMiddleware, requireRole('admin', 'manager'));
router.get('/', query('ruleType').optional().isIn(['EPF', 'ESI', 'PT']), query('jurisdiction').optional().isString(), query('limit').optional().isInt({ min: 1, max: 100 }).toInt(), query('skip').optional().isInt({ min: 0 }).toInt(), handleValidation, listRules);
router.get('/:id', param('id').isMongoId(), handleValidation, getRule);
export default router;
