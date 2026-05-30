import apiClient from './api';

/**
 * Authentication Service
 * 
 * Centralized API calls for authentication
 * Handles communication with backend auth endpoints
 * 
 * Production standards:
 * - Single source of truth for API calls
 * - Consistent error handling
 * - Easy to test/mock
 */

export const authService = {
  /**
   * Register new user
   */
  register: async (name, email, password, confirmPassword) => {
    try {
      const response = await apiClient.post('/auth/register', {
        name,
        email,
        password,
        confirmPassword,
      });
      return response.data;
    } catch (error) {
      throw error.response?.data || error;
    }
  },

  /**
   * Login user
   */
  login: async (email, password) => {
    try {
      const response = await apiClient.post('/auth/login', {
        email,
        password,
      });
      return response.data;
    } catch (error) {
      throw error.response?.data || error;
    }
  },

  /**
   * Get current user (protected route)
   */
  getCurrentUser: async () => {
    try {
      const response = await apiClient.get('/auth/me');
      return response.data;
    } catch (error) {
      throw error.response?.data || error;
    }
  },
};

export default authService;
