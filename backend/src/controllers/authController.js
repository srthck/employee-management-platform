import jwt from 'jsonwebtoken';
import Admin from '../models/Admin.js';
import config from '../config/environment.js';
import { formatUserResponse } from '../utils/formatUser.js';

/**
 * Authentication Controller
 * 
 * Handles all authentication business logic:
 * - User registration
 * - User login
 * - Fetch current user (profile)
 * 
 * Production standards:
 * - Password never logged or exposed
 * - Meaningful error messages
 * - JWT generation with proper claims
 * - Input already validated by middleware
 */

/**
 * Generate JWT Token
 * 
 * @param {string} userId - User ID
 * @param {string} email - User email
 * @param {string} name - User name
 * @param {string} role - User role
 * @returns {string} - Signed JWT token
 */
const generateToken = (userId, email, name, role) => {
  return jwt.sign(
    {
      id: userId,
      email,
      name,
      role,
    },
    config.jwtSecret,
    {
      expiresIn: config.jwtExpire,
    }
  );
};

/**
 * POST /api/auth/register
 * 
 * Register a new admin user
 * 
 * Input (validated): name, email, password, confirmPassword
 * Output: user object + JWT token
 */
export const register = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // Check if user already exists
    const existingAdmin = await Admin.findOne({ email });
    if (existingAdmin) {
      return res.status(409).json({
        success: false,
        message: 'Email already registered. Please login or use a different email.',
      });
    }

    // Create new admin user (password hashing happens in pre-save middleware)
    const newAdmin = new Admin({
      name,
      email,
      password,
      role: 'admin',
    });

    // Save to database (triggers bcrypt hashing)
    await newAdmin.save();

    // Generate JWT token
    const token = generateToken(
      newAdmin._id.toString(),
      newAdmin.email,
      newAdmin.name,
      newAdmin.role
    );

    return res.status(201).json({
      success: true,
      message: 'Registration successful',
      data: {
        user: formatUserResponse(newAdmin),
        token,
      },
    });
  } catch (error) {
    console.error('[AUTH] Register error:', error.message);

    // Handle MongoDB duplicate key error
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'Email already registered.',
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Registration failed. Please try again.',
    });
  }
};

/**
 * POST /api/auth/login
 * 
 * Authenticate user and return JWT token
 * 
 * Input (validated): email, password
 * Output: user object + JWT token
 */
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find user by email (explicitly select password since schema excludes it by default)
    const admin = await Admin.findOne({ email }).select('+password');

    // User not found
    if (!admin) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    // User account deactivated
    if (!admin.isActive) {
      return res.status(403).json({
        success: false,
        message: 'Your account has been deactivated. Please contact support.',
      });
    }

    // Verify password (uses comparePassword method)
    const isPasswordValid = await admin.comparePassword(password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    // Generate JWT token
    const token = generateToken(
      admin._id.toString(),
      admin.email,
      admin.name,
      admin.role
    );

    return res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        user: formatUserResponse(admin),
        token,
      },
    });
  } catch (error) {
    console.error('[AUTH] Login error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Login failed. Please try again.',
    });
  }
};

/**
 * GET /api/auth/me
 * 
 * Fetch current authenticated user
 * 
 * Protected route: requires valid JWT token
 * Output: user object (no token)
 */
export const getCurrentUser = async (req, res) => {
  try {
    // User attached to request by authMiddleware
    const admin = await Admin.findById(req.user.id);

    if (!admin) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    if (!admin.isActive) {
      return res.status(403).json({
        success: false,
        message: 'Your account has been deactivated. Please contact support.',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'User fetched successfully',
      data: {
        user: formatUserResponse(admin),
      },
    });
  } catch (error) {
    console.error('[AUTH] Get current user error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch user data.',
    });
  }
};
