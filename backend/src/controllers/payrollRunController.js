/**
 * PayrollRunController — HTTP layer for PayrollRun orchestration.
 *
 * This controller is THIN:
 *   - Extract validated input from req.
 *   - Derive actor from req.user (JWT — never trust client-supplied actor fields).
 *   - Derive companyId from req.user.id (single-tenant: Admin _id = company identity).
 *   - Delegate ALL business logic to payrollRunService.
 *   - Return structured HTTP responses.
 *
 * PROTECTED FIELDS: status, finalizedBy, startedAt, completedAt, etc. are
 * NEVER read from req.body. They come only from the service/state machine.
 *
 * ROUTES (registered in payrollRunRoutes.js):
 *   POST   /api/payroll-runs                      – Create DRAFT run
 *   GET    /api/payroll-runs                      – List runs for company
 *   GET    /api/payroll-runs/:id                  – Get single run
 *   POST   /api/payroll-runs/:id/preflight        – Run preflight checks
 *   POST   /api/payroll-runs/:id/process          – Process (DRAFT/FAILED → PROCESSING → READY_FOR_FINALIZATION)
 *   POST   /api/payroll-runs/:id/finalize         – READY_FOR_FINALIZATION → FINALIZED (Phase 9 gate)
 *   POST   /api/payroll-runs/:id/cancel           – FAILED → CANCELLED
 *   POST   /api/payroll-runs/:id/recover          – Recover stuck PROCESSING run → FAILED
 */

import payrollRunService from '../services/payrollRunService.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive actor from JWT-authenticated request.
 * NEVER accept actorId, actorEmail, actorRole from req.body.
 */
function actorFromRequest(req) {
  return {
    id:    req.user.id,
    email: req.user.email,
    role:  req.user.role,
    name:  req.user.name,
  };
}

/**
 * Single-tenant: companyId is the Admin's _id from the JWT.
 */
function companyIdFromRequest(req) {
  return req.user.id;
}

// ─── POST /api/payroll-runs ───────────────────────────────────────────────────
/**
 * Create a new DRAFT PayrollRun.
 *
 * Body: { periodMonth, periodYear, idempotencyKey? }
 *
 * 201 – Created
 * 200 – Existing active run returned (idempotent)
 * 400 – Validation error
 * 409 – Conflict (active run already exists and is not the same idempotency key)
 */
export const createPayrollRun = async (req, res) => {
  const actor     = actorFromRequest(req);
  const companyId = companyIdFromRequest(req);

  const { periodMonth, periodYear, idempotencyKey } = req.body;

  const { run, created, conflict } = await payrollRunService.createPayrollRun({
    companyId,
    periodMonth: Number(periodMonth),
    periodYear:  Number(periodYear),
    actorId:     actor.id,
    actorEmail:  actor.email,
    actorRole:   actor.role,
    idempotencyKey: idempotencyKey || null,
  });

  if (conflict) {
    // An active run already exists for this period — surface it cleanly
    return res.status(409).json({
      success: false,
      message: `A payroll run already exists for ${periodYear}-${String(periodMonth).padStart(2, '0')}. Use the existing run or cancel it before creating a new one.`,
      data: { run },
    });
  }

  return res.status(created ? 201 : 200).json({
    success: true,
    message: created ? 'Payroll run created.' : 'Existing payroll run returned.',
    data: { run },
  });
};

// ─── GET /api/payroll-runs ────────────────────────────────────────────────────
export const listPayrollRuns = async (req, res) => {
  const companyId = companyIdFromRequest(req);
  const { status, limit, skip } = req.query;

  const { runs, total } = await payrollRunService.listPayrollRuns(companyId, {
    status: status || undefined,
    limit:  limit  ? Number(limit)  : 20,
    skip:   skip   ? Number(skip)   : 0,
  });

  return res.status(200).json({
    success: true,
    data: {
      runs,
      total,
      limit:  limit  ? Number(limit)  : 20,
      skip:   skip   ? Number(skip)   : 0,
    },
  });
};

// ─── GET /api/payroll-runs/:id ────────────────────────────────────────────────
export const getPayrollRun = async (req, res) => {
  const companyId = companyIdFromRequest(req);
  const run = await payrollRunService.getPayrollRun(req.params.id, companyId);

  return res.status(200).json({
    success: true,
    data: { run },
  });
};

// ─── POST /api/payroll-runs/:id/preflight ─────────────────────────────────────
/**
 * Run preflight checks on a DRAFT or FAILED run.
 *
 * Returns:
 *   canProcess, eligibleEmployees, blockedEmployees,
 *   blockingErrors, warnings, ruleAvailability
 */
export const runPreflight = async (req, res) => {
  const actor     = actorFromRequest(req);
  const companyId = companyIdFromRequest(req);

  const result = await payrollRunService.runPreflight(req.params.id, companyId, actor);

  return res.status(200).json({
    success: true,
    data: result,
  });
};

// ─── POST /api/payroll-runs/:id/process ───────────────────────────────────────
/**
 * Process the payroll run.
 *   DRAFT   → PROCESSING → FINALIZED  (happy path)
 *   FAILED  → PROCESSING → FINALIZED  (retry)
 *
 * Optional body: { idempotencyKey }
 *
 * 200 – Finalized (or idempotent return)
 * 409 – Invalid state or concurrent conflict
 */
export const processPayrollRun = async (req, res) => {
  const actor            = actorFromRequest(req);
  const companyId        = companyIdFromRequest(req);
  const { idempotencyKey } = req.body || {};

  const { run, processingResult, idempotent, concurrencyConflict } =
    await payrollRunService.processPayrollRun(
      req.params.id,
      companyId,
      actor,
      idempotencyKey || null
    );

  if (idempotent) {
    return res.status(200).json({
      success: true,
      message: 'Idempotent: run already processed with this key.',
      data: { run },
    });
  }

  if (concurrencyConflict) {
    return res.status(409).json({
      success: false,
      message: 'Payroll run is already being processed by another request.',
      data: { run },
    });
  }

  return res.status(200).json({
    success: true,
    message: 'Payroll run processed and finalized successfully.',
    data: {
      run,
      processingResult,
    },
  });
};

// ─── POST /api/payroll-runs/:id/finalize ──────────────────────────────────────
/**
 * Explicitly finalize a PROCESSING run.
 * (In the default flow, processPayrollRun auto-finalizes.)
 */
export const finalizePayrollRun = async (req, res) => {
  const actor     = actorFromRequest(req);
  const companyId = companyIdFromRequest(req);

  const run = await payrollRunService.finalizePayrollRun(req.params.id, companyId, actor);

  return res.status(200).json({
    success: true,
    message: 'Payroll run finalized.',
    data: { run },
  });
};

// ─── POST /api/payroll-runs/:id/cancel ────────────────────────────────────────
/**
 * Cancel a FAILED run (makes it CANCELLED — terminal, cannot retry after this).
 */
export const cancelPayrollRun = async (req, res) => {
  const actor     = actorFromRequest(req);
  const companyId = companyIdFromRequest(req);

  const run = await payrollRunService.cancelPayrollRun(req.params.id, companyId, actor);

  return res.status(200).json({
    success: true,
    message: 'Payroll run cancelled.',
    data: { run },
  });
};

// ─── POST /api/payroll-runs/:id/recover ────────────────────────────────────────
/**
 * Recover a stuck PROCESSING run → FAILED so it can be retried.
 *
 * Only succeeds if lastActivityAt is older than the stuckThreshold (default 30 min).
 * Optional body: { stuckThresholdMs }
 */
export const recoverStuckRun = async (req, res) => {
  const actor            = actorFromRequest(req);
  const companyId        = companyIdFromRequest(req);
  const { stuckThresholdMs } = req.body || {};

  const run = await payrollRunService.recoverStuckRun(
    req.params.id,
    companyId,
    actor,
    stuckThresholdMs ? Number(stuckThresholdMs) : undefined
  );

  return res.status(200).json({
    success: true,
    message: 'Stuck payroll run recovered to FAILED state. You may now retry processing.',
    data: { run },
  });
};
