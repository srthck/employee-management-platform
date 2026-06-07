import axios from 'axios';

/**
 * API Service Layer
 * 
 * Production standards:
 * - Centralized Axios configuration
 * - Request/response interceptors
 * - Error handling
 * - Base URL management
 * - Token injection (for authentication, implemented later)
 */

const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:5000/api',
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor (add JWT token to all requests)
apiClient.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

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
      localStorage.removeItem('token');
      localStorage.removeItem('authUser');
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }

    return Promise.reject(error);
  }
);

export default apiClient;
