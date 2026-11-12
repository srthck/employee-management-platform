import express from 'express';
import { body, query } from 'express-validator';
import authMiddleware, { requirePermission } from '../middleware/authMiddleware.js';
import { payrollActionRateLimiter } from '../middleware/rateLimiter.js';
import { idempotent } from '../middleware/idempotency.js';
import { PERMISSIONS } from '../utils/permissions.js';
import {
  createPayrollRun,
  listPayrollRuns,
  getPayrollRun,
  getPayrollRegister,
  getVarianceReport,
  getFinalizationReadiness,
  runPreflight,
  processPayrollRun,
  finalizePayrollRun,
  cancelPayrollRun,
  recoverStuckRun,
} from '../controllers/payrollRunController.js';
import {
  validateCreatePayrollRun,
  validateRunId,
  validateListRuns,
  handleValidationErrors,
} from '../validators/payrollRunValidator.js';

/**
 * PayrollRun Routes
 *
 * All routes require authentication and are scoped to the caller's company.
 * Access is permission-based (utils/permissions.js):
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POST   /api/payroll-runs                             payroll.prepare
 * GET    /api/payroll-runs                             payroll.read
 * GET    /api/payroll-runs/:id                         payroll.read
 * GET    /api/payroll-runs/:id/register                payroll.read
 * GET    /api/payroll-runs/:id/variance                payroll.read
 * GET    /api/payroll-runs/:id/finalization-readiness  payroll.read
 * POST   /api/payroll-runs/:id/preflight               payroll.preflight
 * POST   /api/payroll-runs/:id/process                 payroll.prepare
 * POST   /api/payroll-runs/:id/finalize                payroll.finalize (+ override: payroll.variance.override)
 * POST   /api/payroll-runs/:id/cancel                  payroll.prepare
 * POST   /api/payroll-runs/:id/recover                 payroll.prepare
 * ─────────────────────────────────────────────────────────────────────────
 *
 * State-changing actions accept an Idempotency-Key header: retries replay the
 * original response instead of acting twice.
 *
 * INTENTIONALLY ABSENT:
 *   PUT  /api/payroll-runs/:id           — NEVER expose. State machine owns status.
 *   PATCH /api/payroll-runs/:id/status   — NEVER expose. Use action endpoints.
 *   POST /api/payroll-runs/:id/disburse  — Future phase only (real bank disbursement).
 */

const router = express.Router();
const P = PERMISSIONS;

// All payroll routes require authentication
router.use(authMiddleware);

const validateThreshold = [
  query('thresholdPercent').optional().isInt({ min: 1, max: 100 }).withMessage('thresholdPercent must be 1–100.').toInt(),
];

const validateFinalize = [
  body('override').optional({ nullable: true }).isObject().withMessage('override must be an object.'),
  body('override.reason').optional().isString().isLength({ max: 1000 }).withMessage('Override reason cannot exceed 1000 characters.'),
];

// ─── Write routes ─────────────────────────────────────────────────────────────
// Financially material and irreversible: a retry must never apply it twice, so the key is REQUIRED (428 without one).
router.post(
  '/',
  requirePermission(P.PAYROLL_PREPARE),
  idempotent({ required: true }),
  validateCreatePayrollRun,
  handleValidationErrors,
  createPayrollRun
);

router.post(
  '/:id/process',
  requirePermission(P.PAYROLL_PREPARE),
  payrollActionRateLimiter,
  idempotent({ required: true }),
  validateRunId,
  handleValidationErrors,
  processPayrollRun
);

router.post(
  '/:id/finalize',
  requirePermission(P.PAYROLL_FINALIZE),
  payrollActionRateLimiter,
  idempotent({ required: true }),
  validateRunId,
  validateFinalize,
  handleValidationErrors,
  finalizePayrollRun
);

router.post(
  '/:id/cancel',
  requirePermission(P.PAYROLL_PREPARE),
  payrollActionRateLimiter,
  idempotent({ required: true }),
  validateRunId,
  handleValidationErrors,
  cancelPayrollRun
);

// No key: recovery only moves a stuck PROCESSING run to FAILED, conditionally; repeating it changes nothing more.
router.post(
  '/:id/recover',
  requirePermission(P.PAYROLL_PREPARE),
  payrollActionRateLimiter,
  validateRunId,
  handleValidationErrors,
  recoverStuckRun
);

// ─── Read routes ──────────────────────────────────────────────────────────────
router.get(
  '/',
  requirePermission(P.PAYROLL_READ),
  validateListRuns,
  handleValidationErrors,
  listPayrollRuns
);

router.get(
  '/:id',
  requirePermission(P.PAYROLL_READ),
  validateRunId,
  handleValidationErrors,
  getPayrollRun
);

router.get(
  '/:id/register',
  requirePermission(P.PAYROLL_READ),
  validateRunId,
  handleValidationErrors,
  getPayrollRegister
);

router.get(
  '/:id/variance',
  requirePermission(P.PAYROLL_READ),
  validateRunId,
  validateThreshold,
  handleValidationErrors,
  getVarianceReport
);

router.get(
  '/:id/finalization-readiness',
  requirePermission(P.PAYROLL_READ),
  validateRunId,
  handleValidationErrors,
  getFinalizationReadiness
);

router.post(
  '/:id/preflight',
  requirePermission(P.PAYROLL_PREFLIGHT),
  validateRunId,
  handleValidationErrors,
  runPreflight
);

export default router;
