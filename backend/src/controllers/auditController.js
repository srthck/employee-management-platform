import auditService from '../services/auditService.js';

export const listAuditLogs = async (req, res) => {
  const result = await auditService.list(req.query);
  return res.status(200).json({ success: true, data: result });
};

export const getEntityAuditHistory = async (req, res) => {
  const result = await auditService.getEntityHistoryPage(req.params.entityType, req.params.entityId, req.query);
  return res.status(200).json({ success: true, data: result });
};
