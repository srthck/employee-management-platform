import express from 'express';
import { param, query, validationResult } from 'express-validator';
import authMiddleware, { requireRole } from '../middleware/authMiddleware.js';
import { listAuditLogs, getEntityAuditHistory, verifyAuditChain } from '../controllers/auditController.js';

const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, message: 'Validation failed', errors: errors.array().map((e) => ({ field: e.path, message: e.msg })) });
  next();
};
const pagination = [query('limit').optional().isInt({ min: 1, max: 100 }).toInt(), query('skip').optional().isInt({ min: 0 }).toInt()];
const router = express.Router();
router.use(authMiddleware, requireRole('admin', 'manager'));
router.get('/logs', ...pagination, query('entityType').optional().isString(), query('action').optional().isString(), handleValidation, listAuditLogs);
router.get('/logs/entity/:entityType/:entityId', [...pagination, param('entityType').isString(), param('entityId').isMongoId(), handleValidation], getEntityAuditHistory);
router.get('/verify', verifyAuditChain);
export default router;
