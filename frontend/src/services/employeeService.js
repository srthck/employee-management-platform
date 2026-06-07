import axiosInstance from './axiosInstance';

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
export const createEmployee = async (data) => {
  const response = await axiosInstance.post('/employees', data);
  return response.data;
};

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
 * Delete an employee.
 * @param {string} id
 */
export const deleteEmployee = async (id) => {
  const response = await axiosInstance.delete(`/employees/${id}`);
  return response.data;
};
