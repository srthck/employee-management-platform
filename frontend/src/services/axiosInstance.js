import axios from 'axios';

/**
 * Centralized Axios Instance
 *
 * Authentication is handled through an HttpOnly cookie.
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

// Handle 401 Unauthorized for protected API requests.
//
// IMPORTANT:
// /auth/me is intentionally excluded because a 401 response from /auth/me
// simply means that the user is currently not logged in. It should NOT
// automatically redirect a public page such as the Home page to /login.

axiosInstance.interceptors.response.use(
  (response) => response,

  (error) => {
    const status = error.response?.status;
    const requestUrl = error.config?.url || '';

    const isAuthCheck = requestUrl.includes('/auth/me');
    const isLoginRequest = requestUrl.includes('/auth/login');
    const isRegisterRequest = requestUrl.includes('/auth/register');

    if (
      status === 401 &&
      !isAuthCheck &&
      !isLoginRequest &&
      !isRegisterRequest
    ) {
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }

    return Promise.reject(error);
  }
);

export default axiosInstance;