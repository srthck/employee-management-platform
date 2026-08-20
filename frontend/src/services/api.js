import axios from 'axios';

/**
 * API Service Layer
 * 
 * Production standards:
 * - Centralized Axios configuration
 * - Request/response interceptors
 * - Error handling
 * - Base URL management
 * - Public health endpoint client
 */

const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:5000/api',
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

const AUTH_PUBLIC_PATHS = ['/auth/login', '/auth/register'];

// Response interceptor
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    const requestUrl = error.config?.url || '';

    const isAuthEndpoint = AUTH_PUBLIC_PATHS.some((path) =>
      requestUrl.includes(path)
    );

    if (status === 401 && !isAuthEndpoint) {
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }

    return Promise.reject(error);
  }
);

export default apiClient;
