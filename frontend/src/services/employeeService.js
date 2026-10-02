import axiosInstance from './axiosInstance';
import { postIdempotent } from './idempotency';

/**
 * Employee Service
 *
 * All CRUD operations for employee records.
 * Relies on axiosInstance which automatically injects the JWT Bearer token.
 */

/**
 * Fetch paginated / filtered employee list.
 * @param {Object} params - { page, limit, search, department, status, sortBy, sortOrder }
 */
export const getEmployees = async (params = {}) => {
  const response = await axiosInstance.get('/employees', { params });
  return response.data;
};

/**
 * Fetch dashboard statistics.
 */
export const getEmployeeStats = async () => {
  const response = await axiosInstance.get('/employees/stats');
  return response.data;
};

/**
 * Fetch a single employee by ID.
 * @param {string} id
 */
export const getEmployee = async (id) => {
  const response = await axiosInstance.get(`/employees/${id}`);
  return response.data;
};

/**
 * Create a new employee.
 * @param {Object} data - Employee fields
 */
export const createEmployee = (data) => postIdempotent('/employees', data);

/**
 * Update an existing employee.
 * @param {string} id
 * @param {Object} data - Fields to update
 */
export const updateEmployee = async (id, data) => {
  const response = await axiosInstance.put(`/employees/${id}`, data);
  return response.data;
};

/**
 * Archive an employee (soft delete). The record and payroll history are kept.
 * @param {string} id
 * @param {string} [reason]
 */
export const deleteEmployee = async (id, reason) => {
  const response = await axiosInstance.delete(`/employees/${id}`, {
    data: reason ? { reason } : {},
  });
  return response.data;
};

/**
 * Restore an archived employee (restored as inactive).
 * @param {string} id
 */
export const restoreEmployee = async (id) => {
  const response = await axiosInstance.post(`/employees/${id}/restore`);
  return response.data;
};