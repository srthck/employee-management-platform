import axiosInstance from './axiosInstance';
import { postIdempotent } from './idempotency';

export const getCurrentSalary = (employeeId) => axiosInstance.get(`/employees/${employeeId}/salary/current`).then((r) => r.data);
export const getSalaryHistory = (employeeId) => axiosInstance.get(`/employees/${employeeId}/salary`).then((r) => r.data);
export const createSalaryRevision = (employeeId, payload) => postIdempotent(`/employees/${employeeId}/salary`, payload);
