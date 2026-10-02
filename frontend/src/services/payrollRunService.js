import axiosInstance from './axiosInstance';
import { postIdempotent } from './idempotency';

// Calculation and finalization touch every employee; allow longer than the
// default client timeout.
const LONG_RUNNING = { timeout: 120000 };

export const listPayrollRuns = (params = {}) => axiosInstance.get('/payroll-runs', { params }).then((r) => r.data);
export const getPayrollRun = (id) => axiosInstance.get(`/payroll-runs/${id}`).then((r) => r.data);
export const createPayrollRun = (payload) => postIdempotent('/payroll-runs', payload);
export const preflightPayrollRun = (id) => axiosInstance.post(`/payroll-runs/${id}/preflight`).then((r) => r.data);
export const processPayrollRun = (id, payload = {}) => postIdempotent(`/payroll-runs/${id}/process`, payload, LONG_RUNNING);
// Enforces segregation of duties and the variance gate, then materializes,
// verifies and locks snapshots. `payload.override = { reason }` records an override.
export const finalizePayrollRun = (id, payload = {}) => postIdempotent(`/payroll-runs/${id}/finalize`, payload, LONG_RUNNING);
export const cancelPayrollRun = (id) => postIdempotent(`/payroll-runs/${id}/cancel`);
export const recoverPayrollRun = (id) => axiosInstance.post(`/payroll-runs/${id}/recover`).then((r) => r.data);
export const getPayrollRegister = (id) => axiosInstance.get(`/payroll-runs/${id}/register`).then((r) => r.data);
export const getVarianceReport = (id, params = {}) => axiosInstance.get(`/payroll-runs/${id}/variance`, { params }).then((r) => r.data);
export const getFinalizationReadiness = (id) => axiosInstance.get(`/payroll-runs/${id}/finalization-readiness`).then((r) => r.data);
