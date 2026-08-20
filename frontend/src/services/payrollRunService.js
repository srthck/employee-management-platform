import axiosInstance from './axiosInstance';

export const listPayrollRuns = (params = {}) => axiosInstance.get('/payroll-runs', { params }).then((r) => r.data);
export const getPayrollRun = (id) => axiosInstance.get(`/payroll-runs/${id}`).then((r) => r.data);
export const createPayrollRun = (payload) => axiosInstance.post('/payroll-runs', payload).then((r) => r.data);
export const preflightPayrollRun = (id) => axiosInstance.post(`/payroll-runs/${id}/preflight`).then((r) => r.data);
export const processPayrollRun = (id, payload = {}) => axiosInstance.post(`/payroll-runs/${id}/process`, payload).then((r) => r.data);
export const finalizePayrollRun = (id) => axiosInstance.post(`/payroll-runs/${id}/finalize`).then((r) => r.data);
