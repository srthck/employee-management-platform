import express from 'express';
import {
  register,
  login,
  getCurrentUser,
} from '../controllers/authController.js';
import authMiddleware from '../middleware/authMiddleware.js';
import { authRateLimiter } from '../middleware/rateLimiter.js';
import {
  validateRegister,
  validateLogin,
  handleValidationErrors,
} from '../validators/authValidator.js';

/**
 * Authentication Routes
 * 
 * POST   /api/auth/register  - Register new user
 * POST   /api/auth/login     - Login user
 * GET    /api/auth/me        - Get current user (protected)
 */

const router = express.Router();

/**
 * POST /api/auth/register
 * 
 * Register a new admin user
 * 
 * Request body:
 * {
 *   "name": "John Doe",
 *   "email": "john@example.com",
 *   "password": "SecurePass123!",
 *   "confirmPassword": "SecurePass123!"
 * }
 * 
 * Response:
 * {
 *   "success": true,
 *   "data": {
 *     "user": { id, name, email, role },
 *     "token": "eyJhbGc..."
 *   }
 * }
 */
router.post(
  '/register',
  validateRegister,
  handleValidationErrors,
  register
);

/**
 * POST /api/auth/login
 * 
 * Authenticate user and receive JWT token
 * 
 * Request body:
 * {
 *   "email": "john@example.com",
 *   "password": "SecurePass123!"
 * }
 * 
 * Response:
 * {
 *   "success": true,
 *   "data": {
 *     "user": { id, name, email, role },
 *     "token": "eyJhbGc..."
 *   }
 * }
 */
router.post(
  '/login',
  authRateLimiter,
  validateLogin,
  handleValidationErrors,
  login
);

/**
 * GET /api/auth/me
 * 
 * Fetch current authenticated user
 * 
 * Headers:
 * Authorization: Bearer eyJhbGc...
 * 
 * Response:
 * {
 *   "success": true,
 *   "data": {
 *     "user": { id, name, email, role }
 *   }
 * }
 */
router.get(
  '/me',
  authMiddleware,
  getCurrentUser
);

export default router;
