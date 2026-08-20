import axios from 'axios';

/**
 * Centralized Axios Instance
 *
 * All API calls go through this instance.
 * Request interceptor automatically injects the JWT Bearer token.
 * Response interceptor handles global 401 (token expired / invalid).
 *
 * Portfolio implementation:
 * The backend currently accepts bearer tokens but does not issue HttpOnly
 * cookies. Keep the token in memory until the backend cookie contract exists.
 */

const axiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:5000/api',
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

let authToken = null;

export const setAuthToken = (token) => { authToken = token || null; };
export const clearAuthToken = () => { authToken = null; };

// ─── Request Interceptor ────────────────────────────────────────────────────
// Attach JWT token to every outgoing request if present
axiosInstance.interceptors.request.use(
  (config) => {
    if (authToken) {
      config.headers.Authorization = `Bearer ${authToken}`;
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
      clearAuthToken();
      // Avoid circular imports: use window.location for hard redirect
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default axiosInstance;
