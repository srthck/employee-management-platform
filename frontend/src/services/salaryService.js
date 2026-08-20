import axiosInstance from './axiosInstance';

export const getCurrentSalary = (employeeId) => axiosInstance.get(`/employees/${employeeId}/salary/current`).then((r) => r.data);
export const getSalaryHistory = (employeeId) => axiosInstance.get(`/employees/${employeeId}/salary`).then((r) => r.data);
export const createSalaryRevision = (employeeId, payload) => axiosInstance.post(`/employees/${employeeId}/salary`, payload).then((r) => r.data);
