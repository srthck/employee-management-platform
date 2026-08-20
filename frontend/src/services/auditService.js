import axiosInstance from './axiosInstance';

export const listAuditLogs = (params = {}) => axiosInstance.get('/audit/logs', { params }).then((r) => r.data);
export const getEntityHistory = (entityType, entityId, params = {}) => axiosInstance.get(`/audit/logs/entity/${entityType}/${entityId}`, { params }).then((r) => r.data);
