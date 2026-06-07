import axios from 'axios';

/**
 * Centralized Axios Instance
 *
 * All API calls go through this instance.
 * Request interceptor automatically injects the JWT Bearer token.
 * Response interceptor handles global 401 (token expired / invalid).
 *
 * Portfolio implementation:
 * Token is stored in localStorage for simplicity.
 * Production systems should prefer HttpOnly Secure Cookies.
 */

const axiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:5000/api',
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// ─── Request Interceptor ────────────────────────────────────────────────────
// Attach JWT token to every outgoing request if present
axiosInstance.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// ─── Response Interceptor ───────────────────────────────────────────────────
// Globally handle 401 Unauthorized (expired / invalid token)
axiosInstance.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      // Token is invalid or expired – clear storage and redirect to login
      localStorage.removeItem('token');
      // Avoid circular imports: use window.location for hard redirect
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default axiosInstance;
