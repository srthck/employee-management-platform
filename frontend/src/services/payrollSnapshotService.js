import axiosInstance from './axiosInstance';

export const getSnapshot = (id) => axiosInstance.get(`/payroll-snapshots/${id}`).then((r) => r.data);
export const verifySnapshot = (id) => axiosInstance.get(`/payroll-snapshots/${id}/verify`).then((r) => r.data);
export const getRunSnapshots = (runId) => axiosInstance.get(`/payroll-runs/${runId}/snapshots`).then((r) => r.data);
