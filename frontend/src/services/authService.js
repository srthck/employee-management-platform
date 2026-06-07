import axiosInstance from './axiosInstance';

/**
 * Auth Service
 *
 * Centralized functions for all authentication API calls.
 * All calls go through the shared axiosInstance (token injection handled there).
 *
 * Functions:
 * - register(name, email, password, confirmPassword)
 * - login(email, password)
 * - getCurrentUser()
 */

/**
 * Register a new admin account.
 * @returns {{ user, token }}
 */
export const register = async ({ name, email, password, confirmPassword }) => {
  const response = await axiosInstance.post('/auth/register', {
    name,
    email,
    password,
    confirmPassword,
  });
  return response.data;
};

/**
 * Login with email and password.
 * @returns {{ user, token }}
 */
export const login = async ({ email, password }) => {
  const response = await axiosInstance.post('/auth/login', { email, password });
  return response.data;
};

/**
 * Fetch the current authenticated user (requires valid token in localStorage).
 * @returns {{ user }}
 */
export const getCurrentUser = async () => {
  const response = await axiosInstance.get('/auth/me');
  return response.data;
};
