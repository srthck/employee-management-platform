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

// Request interceptor (for future: add JWT token)
apiClient.interceptors.request.use(
  (config) => {
    // const token = localStorage.getItem('authToken');
    // if (token) {
    //   config.headers.Authorization = `Bearer ${token}`;
    // }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      // Handle unauthorized (redirect to login, clear token, etc.)
      console.error('Unauthorized - redirect to login');
    }
    return Promise.reject(error);
  }
);

export default apiClient;
