import auditService from '../services/auditService.js';
import { companyIdFromRequest } from '../utils/tenant.js';

export const listAuditLogs = async (req, res) => {
  const result = await auditService.list({ ...req.query, companyId: companyIdFromRequest(req) });
  return res.status(200).json({ success: true, data: result });
};

export const getEntityAuditHistory = async (req, res) => {
  const result = await auditService.getEntityHistoryPage(req.params.entityType, req.params.entityId, {
    ...req.query,
    companyId: companyIdFromRequest(req),
  });
  return res.status(200).json({ success: true, data: result });
};

// The chain is platform-wide; the response only carries validity and counts,
// never another company's events.
export const verifyAuditChain = async (req, res) => {
  const result = await auditService.verifyAuditChain();
  return res.status(result.valid ? 200 : 409).json({ success: result.valid, data: result });
};
