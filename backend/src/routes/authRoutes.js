import express from 'express';
import {
  register,
  login,
  getCurrentUser,
  logout,
  logoutAll,
} from '../controllers/authController.js';
import authMiddleware from '../middleware/authMiddleware.js';
import { authRateLimiter, registerRateLimiter } from '../middleware/rateLimiter.js';
import {
  validateRegister,
  validateLogin,
  handleValidationErrors,
} from '../validators/authValidator.js';

/**
 * Authentication Routes
 *
 * POST   /api/auth/register    - Register new admin (creates a company workspace)
 * POST   /api/auth/login       - Login (admin, manager or employee)
 * POST   /api/auth/logout      - Clear this browser's session cookie
 * POST   /api/auth/logout-all  - Revoke every session for this account (protected)
 * GET    /api/auth/me          - Get current user (protected)
 *
 * Request / response contract:
 *   register: { name, email, password, confirmPassword } → { data: { user } }
 *   login:    { email, password }                         → { data: { user } }
 * The session JWT is delivered only as an HttpOnly cookie, never in the body.
 */

const router = express.Router();

router.post(
  '/register',
  registerRateLimiter,
  validateRegister,
  handleValidationErrors,
  register
);

router.post(
  '/login',
  authRateLimiter,
  validateLogin,
  handleValidationErrors,
  login
);

router.post('/logout', logout);

router.post('/logout-all', authMiddleware, logoutAll);

router.get(
  '/me',
  authMiddleware,
  getCurrentUser
);

export default router;
