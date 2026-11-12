import express from 'express';
import { body, param, query, validationResult } from 'express-validator';
import authMiddleware, { requirePermission } from '../middleware/authMiddleware.js';
import { idempotent } from '../middleware/idempotency.js';
import { PERMISSIONS } from '../utils/permissions.js';
import { CHANGE_STATUSES } from '../utils/compensation.js';
import {
  listComponents,
  createComponent,
  updateComponent,
  archiveComponent,
  getCompensation,
  previewImpact,
  listEmployeeChanges,
  proposeChange,
  listChanges,
  getChange,
  submitChange,
  approveChange,
  rejectChange,
  cancelChange,
} from '../controllers/compensationController.js';

/**
 * Compensation routes.
 *
 * Employee-scoped (mounted at /api/employees):
 *   GET  /:employeeId/compensation                 compensation.read
 *   POST /:employeeId/compensation/impact-preview   compensation.propose   (reads only)
 *   GET  /:employeeId/compensation/changes          compensation.read
 *   POST /:employeeId/compensation/changes          compensation.propose   (Idempotency-Key)
 *
 * Company-scoped (mounted at /api/compensation):
 *   GET    /components                  compensation.read
 *   POST   /components                  compensation.component.manage      (Idempotency-Key)
 *   PATCH  /components/:code            compensation.component.manage
 *   DELETE /components/:code            compensation.component.manage      (archive)
 *   GET    /changes                     compensation.read
 *   GET    /changes/:changeId           compensation.read
 *   POST   /changes/:changeId/submit    compensation.propose
 *   POST   /changes/:changeId/approve   compensation.approve               (Idempotency-Key)
 *   POST   /changes/:changeId/reject    compensation.approve
 *   POST   /changes/:changeId/cancel    compensation.propose
 *
 * Approving is the step that moves money, so it carries idempotency: a retried
 * approval replays the first result instead of applying a second pay change.
 */

const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array().map((error) => ({ field: error.path, message: error.msg })),
    });
  }
  return next();
};

const P = PERMISSIONS;
const employeeParam = [param('employeeId').isMongoId().withMessage('Invalid employee ID.')];
const changeParam = [param('changeId').isMongoId().withMessage('Invalid change ID.')];
const componentCode = [param('code').isString().trim().isLength({ min: 2, max: 40 }).withMessage('Invalid component code.')];
const proposalBody = [
  body('effectiveFrom').isISO8601().withMessage('effectiveFrom must be a date.'),
  body('lines').isArray({ min: 1 }).withMessage('Propose at least the basic component.'),
  body('workState').optional({ nullable: true }).isString().trim().isLength({ min: 2, max: 20 }).withMessage('workState must be 2–20 characters.'),
  body('pfEnrolled').optional().isBoolean().toBoolean(),
  body('esiEnrolled').optional().isBoolean().toBoolean(),
  body('ptEnrolled').optional().isBoolean().toBoolean(),
];
const decisionNote = body('note').optional({ nullable: true }).isString().isLength({ max: 500 }).withMessage('A note cannot exceed 500 characters.');

// ─── Employee-scoped ─────────────────────────────────────────────────────────
export const employeeCompensationRouter = express.Router();
employeeCompensationRouter.use(authMiddleware);

employeeCompensationRouter.get(
  '/:employeeId/compensation',
  requirePermission(P.COMPENSATION_READ),
  employeeParam,
  handleValidation,
  getCompensation
);

employeeCompensationRouter.post(
  '/:employeeId/compensation/impact-preview',
  requirePermission(P.COMPENSATION_PROPOSE),
  [...employeeParam, ...proposalBody, body('reason').optional({ nullable: true }).isString()],
  handleValidation,
  previewImpact
);

employeeCompensationRouter.get(
  '/:employeeId/compensation/changes',
  requirePermission(P.COMPENSATION_READ),
  [...employeeParam, query('status').optional().isIn(CHANGE_STATUSES)],
  handleValidation,
  listEmployeeChanges
);

employeeCompensationRouter.post(
  '/:employeeId/compensation/changes',
  requirePermission(P.COMPENSATION_PROPOSE),
  idempotent({ required: true }),
  [...employeeParam, ...proposalBody, body('reason').isString().withMessage('A reason is required for a pay change.')],
  handleValidation,
  proposeChange
);

// ─── Company-scoped ──────────────────────────────────────────────────────────
const router = express.Router();
router.use(authMiddleware);

router.get('/components', requirePermission(P.COMPENSATION_READ), listComponents);
router.post(
  '/components',
  requirePermission(P.COMPENSATION_COMPONENT_MANAGE),
  idempotent(),
  [
    body('code').isString().trim().isLength({ min: 2, max: 40 }).withMessage('A component code is 2–40 characters.'),
    body('name').isString().trim().isLength({ min: 2, max: 80 }).withMessage('Name must be 2 to 80 characters.'),
  ],
  handleValidation,
  createComponent
);
router.patch('/components/:code', requirePermission(P.COMPENSATION_COMPONENT_MANAGE), componentCode, handleValidation, updateComponent);
router.delete('/components/:code', requirePermission(P.COMPENSATION_COMPONENT_MANAGE), componentCode, handleValidation, archiveComponent);

router.get(
  '/changes',
  requirePermission(P.COMPENSATION_READ),
  [
    query('status').optional().isIn(CHANGE_STATUSES),
    query('employeeId').optional().isMongoId(),
    query('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
  ],
  handleValidation,
  listChanges
);
router.get('/changes/:changeId', requirePermission(P.COMPENSATION_READ), changeParam, handleValidation, getChange);
router.post('/changes/:changeId/submit', requirePermission(P.COMPENSATION_PROPOSE), changeParam, handleValidation, submitChange);
router.post(
  '/changes/:changeId/approve',
  requirePermission(P.COMPENSATION_APPROVE),
  idempotent({ required: true }),
  [...changeParam, decisionNote],
  handleValidation,
  approveChange
);
router.post(
  '/changes/:changeId/reject',
  requirePermission(P.COMPENSATION_APPROVE),
  [...changeParam, body('note').isString().withMessage('Say why the change is rejected.')],
  handleValidation,
  rejectChange
);
router.post('/changes/:changeId/cancel', requirePermission(P.COMPENSATION_PROPOSE), changeParam, handleValidation, cancelChange);

export default router;
