import compensationService from '../services/compensationService.js';
import compensationComponentService from '../services/compensationComponentService.js';
import compensationChangeService from '../services/compensationChangeService.js';
import { actorFromRequest, companyIdFromRequest } from '../utils/tenant.js';
import { hasPermission, PERMISSIONS } from '../utils/permissions.js';

/**
 * Compensation control plane — component catalogue, employee compensation,
 * impact previews and the change workflow. Rules live in the services.
 */

const scope = (req) => [req.params.employeeId, companyIdFromRequest(req)];

// ─── Component catalogue ─────────────────────────────────────────────────────

export const listComponents = async (req, res) => {
  const data = await compensationComponentService.list(companyIdFromRequest(req), {
    includeArchived: req.query.includeArchived === 'true',
  });
  return res.status(200).json({ success: true, data });
};

export const createComponent = async (req, res) => {
  const component = await compensationComponentService.create(companyIdFromRequest(req), actorFromRequest(req), req.body);
  return res.status(201).json({ success: true, message: 'Component created.', data: { component } });
};

export const updateComponent = async (req, res) => {
  const component = await compensationComponentService.update(
    companyIdFromRequest(req), actorFromRequest(req), req.params.code, req.body
  );
  return res.status(200).json({ success: true, message: 'Component updated.', data: { component } });
};

export const archiveComponent = async (req, res) => {
  const component = await compensationComponentService.archive(
    companyIdFromRequest(req), actorFromRequest(req), req.params.code
  );
  return res.status(200).json({ success: true, message: 'Component archived.', data: { component } });
};

// ─── Employee compensation ───────────────────────────────────────────────────

export const getCompensation = async (req, res) => {
  const data = await compensationService.getCompensation(...scope(req));
  return res.status(200).json({ success: true, data });
};

export const previewImpact = async (req, res) => {
  const data = await compensationChangeService.previewImpact(...scope(req), req.body);
  return res.status(200).json({ success: true, data });
};

export const listEmployeeChanges = async (req, res) => {
  const data = await compensationChangeService.list(companyIdFromRequest(req), {
    employeeId: req.params.employeeId,
    status: req.query.status,
  });
  return res.status(200).json({ success: true, data });
};

export const proposeChange = async (req, res) => {
  const data = await compensationChangeService.propose(...scope(req), req.body, actorFromRequest(req));
  return res.status(201).json({ success: true, message: 'Compensation change proposed.', data });
};

// ─── Change workflow ─────────────────────────────────────────────────────────

export const listChanges = async (req, res) => {
  const data = await compensationChangeService.list(companyIdFromRequest(req), {
    status: req.query.status,
    employeeId: req.query.employeeId,
    limit: req.query.limit,
  });
  return res.status(200).json({ success: true, data });
};

export const getChange = async (req, res) => {
  const data = await compensationChangeService.get(req.params.changeId, companyIdFromRequest(req));
  return res.status(200).json({ success: true, data });
};

export const submitChange = async (req, res) => {
  const data = await compensationChangeService.submit(req.params.changeId, companyIdFromRequest(req), actorFromRequest(req));
  return res.status(200).json({ success: true, message: 'Compensation change submitted for approval.', data });
};

export const approveChange = async (req, res) => {
  const data = await compensationChangeService.approve(
    req.params.changeId, companyIdFromRequest(req), actorFromRequest(req), { note: req.body?.note }
  );
  const scheduled = data.change.status === 'SCHEDULED';
  return res.status(200).json({
    success: true,
    message: scheduled
      ? 'Compensation change approved and scheduled for its effective date.'
      : 'Compensation change approved and applied.',
    data,
  });
};

export const rejectChange = async (req, res) => {
  const data = await compensationChangeService.reject(
    req.params.changeId, companyIdFromRequest(req), actorFromRequest(req), { note: req.body?.note }
  );
  return res.status(200).json({ success: true, message: 'Compensation change rejected.', data });
};

export const cancelChange = async (req, res) => {
  const data = await compensationChangeService.cancel(
    req.params.changeId, companyIdFromRequest(req), actorFromRequest(req),
    { isApprover: hasPermission(req.user, PERMISSIONS.COMPENSATION_APPROVE) }
  );
  return res.status(200).json({ success: true, message: 'Compensation change cancelled.', data });
};
