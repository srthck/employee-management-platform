import axiosInstance from './axiosInstance';

export const listRules = (params = {}) => axiosInstance.get('/compliance/rules', { params }).then((r) => r.data);
export const getRule = (id) => axiosInstance.get(`/compliance/rules/${id}`).then((r) => r.data);
