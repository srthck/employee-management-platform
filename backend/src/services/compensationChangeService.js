import mongoose from 'mongoose';
import Company from '../models/Company.js';
import CompensationChangeRequest from '../models/CompensationChangeRequest.js';
import CompensationVersion from '../models/CompensationVersion.js';
import compensationComponentService from './compensationComponentService.js';
import compensationImpactService from './compensationImpactService.js';
import { applyCompensation, retroactiveWarnings, versionView } from './compensationService.js';
import auditService from './auditService.js';
import { runInTransaction } from '../utils/transaction.js';
import { httpError, startOfUtcDay, dateOnly, isValidDate, loadCompanyEmployee } from './employeeScope.js';

/**
 * compensationChangeService — the controlled workflow a pay change travels.
 *
 *   propose  → PROPOSED    impact is computed and stored with the proposal
 *   submit   → SUBMITTED   locked for review
 *   approve  → EFFECTIVE   applied now, or SCHEDULED when dated ahead
 *   reject   → REJECTED    with a reason
 *   cancel   → CANCELLED   by the proposer or an approver, before approval
 *
 * Controls:
 *   - under maker-checker the approver cannot be the proposer
 *   - approval recomputes the impact and refuses if the compensation it was
 *     based on has changed since (BASELINE_CHANGED)
 *   - applying the change writes the compensation version and its payroll
 *     projection in the same transaction as the approval and the audit event
 */

const REASON_MIN = 5;
const REASON_MAX = 500;

const changeView = (request) => ({
  id: String(request._id),
  employeeId: String(request.employeeId),
  status: request.status,
  effectiveFrom: request.effectiveFrom,
  reason: request.reason,
  proposedLines: request.proposedLines,
  workState: request.workState,
  pfEnrolled: request.pfEnrolled,
  esiEnrolled: request.esiEnrolled,
  ptEnrolled: request.ptEnrolled,
  impact: request.impact,
  impactAtApproval: request.impactAtApproval,
  approvalMode: request.approvalMode,
  proposedByEmail: request.proposedByEmail,
  proposedAt: request.createdAt,
  submittedAt: request.submittedAt,
  decidedByEmail: request.decidedByEmail,
  decidedAt: request.decidedAt,
  decisionNote: request.decisionNote,
  resultingVersionId: request.resultingVersionId ? String(request.resultingVersionId) : null,
  effectiveAt: request.effectiveAt,
  baselineVersionId: request.baselineVersionId ? String(request.baselineVersionId) : null,
});

const approvalModeOf = async (companyId, session = null) => {
  const query = Company.findById(companyId).select('settings.compensationApprovalMode');
  if (session) query.session(session);
  const company = await query.lean();
  return company?.settings?.compensationApprovalMode || 'single';
};

const auditChange = (action, request, actor, meta, session) => auditService.log({
  action,
  actorId: actor.id,
  actorEmail: actor.email,
  actorRole: actor.role,
  entityType: 'COMPENSATION_CHANGE',
  entityId: request._id,
  companyId: request.companyId,
  previousStatus: meta.previousStatus ?? null,
  newStatus: request.status,
  meta: {
    employeeId: String(request.employeeId),
    effectiveFrom: dateOnly(request.effectiveFrom),
    ...meta,
    previousStatus: undefined,
  },
}, session);

function validateProposal(payload, { requireReason = true } = {}) {
  const errors = [];
  if (!isValidDate(payload.effectiveFrom)) errors.push({ field: 'effectiveFrom', message: 'effectiveFrom must be a valid date.' });
  const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
  // A preview is read-only, so it does not need a reason; a proposal does.
  if (requireReason && (reason.length < REASON_MIN || reason.length > REASON_MAX)) {
    errors.push({ field: 'reason', message: `A reason of ${REASON_MIN} to ${REASON_MAX} characters is required for a pay change.` });
  }
  if (!Array.isArray(payload.lines) || payload.lines.length === 0) {
    errors.push({ field: 'lines', message: 'Propose at least the basic component.' });
  }
  if (payload.workState !== undefined && payload.workState !== null && typeof payload.workState !== 'string') {
    errors.push({ field: 'workState', message: 'workState must be a state code.' });
  }
  if (errors.length > 0) throw httpError(422, 'VALIDATION_FAILED', 'Validation failed', { errors });
  return { reason, effectiveFrom: startOfUtcDay(payload.effectiveFrom) };
}

/** Everything a preview or an application needs, resolved consistently. */
async function resolveContext(employeeId, companyId, payload, session = null) {
  const employee = await loadCompanyEmployee(employeeId, companyId, { session });
  const baseline = await CompensationVersion.findValidForDate(employee._id, startOfUtcDay(payload.effectiveFrom))
    .session(session)
    .lean();

  const workState = payload.workState ?? baseline?.workState ?? null;
  if (!workState) {
    throw httpError(422, 'VALIDATION_FAILED', 'workState is required. Professional tax jurisdiction is never assumed.');
  }

  return {
    employee,
    baseline,
    workState: String(workState).toUpperCase(),
    pfEnrolled: payload.pfEnrolled ?? baseline?.pfEnrolled ?? true,
    esiEnrolled: payload.esiEnrolled ?? baseline?.esiEnrolled ?? true,
    ptEnrolled: payload.ptEnrolled ?? baseline?.ptEnrolled ?? true,
  };
}

const compensationChangeService = {
  /** Impact of a proposal without creating anything. */
  async previewImpact(employeeId, companyId, payload) {
    validateProposal(payload, { requireReason: false });
    const context = await resolveContext(employeeId, companyId, payload);
    const catalogue = await compensationComponentService.catalogueMap(companyId);
    const preview = await compensationImpactService.preview({
      companyId,
      employee: context.employee,
      baselineVersion: context.baseline,
      effectiveFrom: payload.effectiveFrom,
      lines: payload.lines,
      workState: context.workState,
      pfEnrolled: context.pfEnrolled,
      esiEnrolled: context.esiEnrolled,
      ptEnrolled: context.ptEnrolled,
      catalogue,
    });
    return preview;
  },

  async propose(employeeId, companyId, payload, actor) {
    const { reason, effectiveFrom } = validateProposal(payload);
    const context = await resolveContext(employeeId, companyId, payload);
    const preview = await this.previewImpact(employeeId, companyId, payload);

    const request = await runInTransaction(async (session) => {
      const [created] = await CompensationChangeRequest.create([{
        companyId,
        employeeId: context.employee._id,
        status: 'PROPOSED',
        effectiveFrom,
        reason,
        proposedLines: payload.lines,
        workState: context.workState,
        pfEnrolled: context.pfEnrolled,
        esiEnrolled: context.esiEnrolled,
        ptEnrolled: context.ptEnrolled,
        baselineVersionId: context.baseline?._id ?? null,
        impact: preview.impact,
        proposedBy: actor.id,
        proposedByEmail: actor.email || null,
      }], { session });

      await auditChange('COMPENSATION_CHANGE_PROPOSED', created, actor, {
        monthlyCtcDelta: preview.impact.monthlyCtc.delta,
        annualCtcDelta: preview.impact.annualCtc.delta,
      }, session);
      return created;
    }, { label: 'compensation.change.propose' });

    return { change: changeView(request), impact: preview.impact, proposed: preview.proposed, baseline: preview.baseline };
  },

  async submit(changeId, companyId, actor) {
    const request = await runInTransaction(async (session) => {
      const found = await this._load(changeId, companyId, session);
      if (found.status !== 'PROPOSED') {
        throw httpError(409, 'COMPENSATION_STATE_CONFLICT', `Only a proposed change can be submitted. This one is ${found.status}.`);
      }
      const previousStatus = found.status;
      found.status = 'SUBMITTED';
      found.submittedAt = new Date();
      await found.save({ session });
      await auditChange('COMPENSATION_CHANGE_SUBMITTED', found, actor, { previousStatus }, session);
      return found;
    }, { label: 'compensation.change.submit' });

    return { change: changeView(request) };
  },

  /** Approve and apply: the pay change becomes real here, or on its future date. */
  async approve(changeId, companyId, actor, { note = null } = {}) {
    const { request, version } = await runInTransaction(async (session) => {
      const found = await this._load(changeId, companyId, session);
      if (found.status !== 'SUBMITTED') {
        throw httpError(409, 'COMPENSATION_STATE_CONFLICT', `Only a submitted change can be approved. This one is ${found.status}.`);
      }

      const approvalMode = await approvalModeOf(companyId, session);
      if (approvalMode === 'maker_checker' && String(found.proposedBy) === String(actor.id)) {
        throw httpError(403, 'SEGREGATION_OF_DUTIES',
          'Under maker-checker, the person who proposed a pay change cannot approve it.');
      }

      const employee = await loadCompanyEmployee(found.employeeId, companyId, { session });
      const baseline = await CompensationVersion.findValidForDate(employee._id, found.effectiveFrom).session(session).lean();
      if (String(baseline?._id || '') !== String(found.baselineVersionId || '')) {
        throw httpError(409, 'BASELINE_CHANGED',
          'The compensation this change was based on has changed since it was proposed. Propose it again against the current compensation.');
      }

      const catalogue = await compensationComponentService.catalogueMap(companyId, session);
      const preview = await compensationImpactService.preview({
        companyId,
        employee,
        baselineVersion: baseline,
        effectiveFrom: found.effectiveFrom,
        lines: found.proposedLines,
        workState: found.workState,
        pfEnrolled: found.pfEnrolled,
        esiEnrolled: found.esiEnrolled,
        ptEnrolled: found.ptEnrolled,
        catalogue,
      });

      const applied = await applyCompensation({
        employee,
        companyId,
        effectiveFrom: found.effectiveFrom,
        lines: found.proposedLines,
        workState: found.workState,
        pfEnrolled: found.pfEnrolled,
        esiEnrolled: found.esiEnrolled,
        ptEnrolled: found.ptEnrolled,
        reason: found.reason,
        source: 'CHANGE_REQUEST',
        changeRequestId: found._id,
        actor,
        catalogue,
      }, session);

      const previousStatus = found.status;
      const takesEffectNow = found.effectiveFrom <= new Date();
      found.status = takesEffectNow ? 'EFFECTIVE' : 'SCHEDULED';
      found.approvalMode = approvalMode;
      found.decidedBy = actor.id;
      found.decidedByEmail = actor.email || null;
      found.decidedAt = new Date();
      found.decisionNote = note ? String(note).trim().slice(0, REASON_MAX) : null;
      found.impactAtApproval = preview.impact;
      found.resultingVersionId = applied.version._id;
      found.effectiveAt = takesEffectNow ? new Date() : null;
      await found.save({ session });

      await auditChange('COMPENSATION_CHANGE_APPROVED', found, actor, {
        previousStatus,
        approvalMode,
        proposedByEmail: found.proposedByEmail,
        compensationVersion: applied.version.version,
        monthlyCtcBefore: preview.impact.monthlyCtc.before,
        monthlyCtcAfter: preview.impact.monthlyCtc.after,
        annualCtcDelta: preview.impact.annualCtc.delta,
        note: found.decisionNote,
      }, session);

      return { request: found, version: applied.version };
    }, { label: 'compensation.change.approve' });

    const warnings = await retroactiveWarnings(companyId, request.effectiveFrom);
    return { change: changeView(request), version: versionView(version.toObject ? version.toObject() : version), warnings };
  },

  async reject(changeId, companyId, actor, { note }) {
    const trimmed = typeof note === 'string' ? note.trim() : '';
    if (trimmed.length < REASON_MIN) {
      throw httpError(422, 'REJECTION_REASON_REQUIRED', `Say why the change is rejected (at least ${REASON_MIN} characters).`);
    }

    const request = await runInTransaction(async (session) => {
      const found = await this._load(changeId, companyId, session);
      if (!['PROPOSED', 'SUBMITTED'].includes(found.status)) {
        throw httpError(409, 'COMPENSATION_STATE_CONFLICT', `A ${found.status} change cannot be rejected.`);
      }
      const previousStatus = found.status;
      found.status = 'REJECTED';
      found.decidedBy = actor.id;
      found.decidedByEmail = actor.email || null;
      found.decidedAt = new Date();
      found.decisionNote = trimmed.slice(0, REASON_MAX);
      await found.save({ session });
      await auditChange('COMPENSATION_CHANGE_REJECTED', found, actor, { previousStatus, note: found.decisionNote }, session);
      return found;
    }, { label: 'compensation.change.reject' });

    return { change: changeView(request) };
  },

  async cancel(changeId, companyId, actor, { isApprover = false } = {}) {
    const request = await runInTransaction(async (session) => {
      const found = await this._load(changeId, companyId, session);
      if (!['PROPOSED', 'SUBMITTED'].includes(found.status)) {
        throw httpError(409, 'COMPENSATION_STATE_CONFLICT',
          `A ${found.status} change cannot be cancelled. Propose another change instead.`);
      }
      if (String(found.proposedBy) !== String(actor.id) && !isApprover) {
        throw httpError(403, 'FORBIDDEN', 'Only the person who proposed this change, or an approver, can cancel it.');
      }
      const previousStatus = found.status;
      found.status = 'CANCELLED';
      found.cancelledAt = new Date();
      await found.save({ session });
      await auditChange('COMPENSATION_CHANGE_CANCELLED', found, actor, { previousStatus }, session);
      return found;
    }, { label: 'compensation.change.cancel' });

    return { change: changeView(request) };
  },

  async list(companyId, { status = null, employeeId = null, limit = 50 } = {}) {
    await this.activateDue({ companyId });
    const filter = { companyId };
    if (status) filter.status = status;
    if (employeeId) {
      if (!mongoose.isValidObjectId(employeeId)) throw httpError(400, 'BAD_REQUEST', 'Invalid employee ID.');
      filter.employeeId = employeeId;
    }
    const requests = await CompensationChangeRequest.find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 50, 200))
      .lean();
    return { changes: requests.map(changeView) };
  },

  async get(changeId, companyId) {
    const request = await this._load(changeId, companyId);
    return { change: changeView(request.toObject ? request.toObject() : request) };
  },

  /**
   * Move approved future-dated changes to EFFECTIVE once their date arrives.
   * Bookkeeping only: the compensation version and its payroll projection were
   * written at approval, so payroll is already correct either way.
   */
  async activateDue({ companyId = null, now = new Date() } = {}) {
    const filter = { status: 'SCHEDULED', effectiveFrom: { $lte: now } };
    if (companyId) filter.companyId = companyId;
    const due = await CompensationChangeRequest.find(filter).select('_id').lean();
    let activated = 0;

    for (const { _id } of due) {
      // eslint-disable-next-line no-await-in-loop
      await runInTransaction(async (session) => {
        const request = await CompensationChangeRequest.findOne({ _id, status: 'SCHEDULED' }).session(session);
        if (!request) return;
        request.status = 'EFFECTIVE';
        request.effectiveAt = now;
        await request.save({ session });
        await auditService.log({
          action: 'COMPENSATION_CHANGE_EFFECTIVE',
          actorId: request.decidedBy || request.proposedBy,
          actorEmail: request.decidedByEmail || request.proposedByEmail,
          actorRole: 'system',
          entityType: 'COMPENSATION_CHANGE',
          entityId: request._id,
          companyId: request.companyId,
          previousStatus: 'SCHEDULED',
          newStatus: 'EFFECTIVE',
          meta: { employeeId: String(request.employeeId), effectiveFrom: dateOnly(request.effectiveFrom) },
        }, session);
        activated += 1;
      }, { label: 'compensation.change.activate' });
    }
    return activated;
  },

  async _load(changeId, companyId, session = null) {
    if (!mongoose.isValidObjectId(changeId)) throw httpError(400, 'BAD_REQUEST', 'Invalid change ID.');
    const query = CompensationChangeRequest.findOne({ _id: changeId, companyId });
    if (session) query.session(session);
    const request = await query;
    if (!request) throw httpError(404, 'NOT_FOUND', 'Compensation change not found.');
    return request;
  },
};

export default compensationChangeService;
