import express from 'express';
import { param, query, validationResult } from 'express-validator';
import authMiddleware, { requirePermission } from '../middleware/authMiddleware.js';
import { PERMISSIONS } from '../utils/permissions.js';
import { listAuditLogs, getEntityAuditHistory, verifyAuditChain } from '../controllers/auditController.js';

const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, message: 'Validation failed', errors: errors.array().map((e) => ({ field: e.path, message: e.msg })) });
  next();
};
const pagination = [query('limit').optional().isInt({ min: 1, max: 100 }).toInt(), query('skip').optional().isInt({ min: 0 }).toInt()];
const router = express.Router();
router.use(authMiddleware, requirePermission(PERMISSIONS.AUDIT_READ));
router.get('/logs', ...pagination, query('entityType').optional().isString().isLength({ max: 64 }), query('action').optional().isString().isLength({ max: 64 }), handleValidation, listAuditLogs);
router.get('/logs/entity/:entityType/:entityId', [...pagination, param('entityType').isString().isLength({ max: 64 }), param('entityId').isMongoId(), handleValidation], getEntityAuditHistory);
router.get('/verify', requirePermission(PERMISSIONS.AUDIT_VERIFY), verifyAuditChain);
export default router;
