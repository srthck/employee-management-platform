import jwt from 'jsonwebtoken';
import config from '../config/environment.js';

/**
 * Authentication Middleware
 * 
 * Responsibilities:
 * - Extract JWT from Authorization header
 * - Verify token signature and expiration
 * - Attach user data to request object
 * - Reject invalid or missing tokens
 * 
 * Production standards:
 * - Follows Bearer token scheme (RFC 6750)
 * - Clear error messages for debugging
 * - Secure token validation
 */

const authMiddleware = async (req, res, next) => {
  try {
    // Extract token from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'No token provided. Authorization header missing or invalid format.',
      });
    }

    // Extract token (remove "Bearer " prefix)
    const token = authHeader.substring(7);

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Token is empty.',
      });
    }

    // Verify token
    const decoded = jwt.verify(token, config.jwtSecret);

    // Attach user data to request
    req.user = {
      id: decoded.id,
      email: decoded.email,
      name: decoded.name,
      role: decoded.role,
    };

    next();
  } catch (error) {
    // Handle specific JWT errors
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token has expired. Please login again.',
      });
    }

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token. Please login again.',
      });
    }

    // Generic error
    return res.status(401).json({
      success: false,
      message: 'Authentication failed.',
    });
  }
};

/**
 * Optional: Role-based access control
 * 
 * Can be extended later to protect routes by role
 * Example: Only admins can delete users
 */
export const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required.',
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions. This action requires higher privileges.',
      });
    }

    next();
  };
};

export default authMiddleware;
