import axiosInstance from './axiosInstance';
import { postIdempotent } from './idempotency';

export const getCompany = () => axiosInstance.get('/company').then((r) => r.data);
export const updateCompanySettings = (payload) => axiosInstance.patch('/company/settings', payload).then((r) => r.data);
export const listCompanyUsers = () => axiosInstance.get('/company/users').then((r) => r.data);
export const createCompanyUser = (payload) => postIdempotent('/company/users', payload);
export const updateCompanyUser = (userId, payload) => axiosInstance.patch(`/company/users/${userId}`, payload).then((r) => r.data);
