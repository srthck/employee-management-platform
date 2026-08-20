import axios from 'axios';

/**
 * Centralized Axios Instance
 *
 * All API calls go through this instance.
 * Request interceptor automatically injects the JWT Bearer token.
 * Response interceptor handles global 401 (token expired / invalid).
 *
 * Portfolio implementation:
 * Authentication is browser-managed through an HttpOnly cookie.
 */

const axiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:5000/api',
  timeout: 10000,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

// ─── Request Interceptor ────────────────────────────────────────────────────
axiosInstance.interceptors.request.use(
  (config) => config,
  (error) => Promise.reject(error)
);

// ─── Response Interceptor ───────────────────────────────────────────────────
// Globally handle 401 Unauthorized (expired / invalid token)
axiosInstance.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      // Avoid circular imports: use window.location for hard redirect
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default axiosInstance;
