import axiosInstance from './axiosInstance';

export const getSnapshot = (id) => axiosInstance.get(`/payroll-snapshots/${id}`).then((r) => r.data);
export const verifySnapshot = (id) => axiosInstance.get(`/payroll-snapshots/${id}/verify`).then((r) => r.data);
export const explainSnapshot = (id) => axiosInstance.get(`/payroll-snapshots/${id}/explain`).then((r) => r.data);
export const getRunSnapshots = (runId, params = {}) => axiosInstance.get(`/payroll-runs/${runId}/snapshots`, { params }).then((r) => r.data);
