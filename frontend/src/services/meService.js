import axiosInstance from './axiosInstance';

/**
 * Employee self-service: the signed-in employee's own finalized payslips.
 */
export const listMyPayslips = () => axiosInstance.get('/me/payslips').then((r) => r.data);
export const getMyPayslip = (id) => axiosInstance.get(`/me/payslips/${id}`).then((r) => r.data);
