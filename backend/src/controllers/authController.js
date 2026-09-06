import jwt from 'jsonwebtoken';
import Admin from '../models/Admin.js';
import EmployeeAccount from '../models/EmployeeAccount.js';
import Employee from '../models/Employee.js';
import config from '../config/environment.js';
import { formatUserResponse } from '../utils/formatUser.js';

/**
 * Authentication Controller
 *
 * Supports:
 * - Admin registration
 * - Admin/Manager login
 * - Employee login
 * - Current authenticated user
 * - Logout
 *
 * Authentication architecture:
 *
 * Admin / Manager
 *      ↓
 *    Admin
 *
 * Employee
 *      ↓
 * EmployeeAccount
 *      ↓
 *   Employee
 */

/**
 * Generate JWT Token
 *
 * @param {string} userId
 * @param {string} email
 * @param {string} name
 * @param {string} role
 * @returns {string}
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

const setAuthCookie = (res, token) => {
  const secure = config.authCookieSecure ? '; Secure' : '';

  res.setHeader(
    'Set-Cookie',
    `${config.authCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=${config.authCookieSameSite}${secure}`
  );
};

const clearAuthCookie = (res) => {
  res.setHeader(
    'Set-Cookie',
    `${config.authCookieName}=; Path=/; HttpOnly; Max-Age=0; SameSite=${config.authCookieSameSite}${config.authCookieSecure ? '; Secure' : ''}`
  );
};

/**
 * POST /api/auth/register
 *
 * Register a new admin user.
 *
 * Public employee registration is intentionally NOT allowed.
 * Employees must be created by an authorized Admin/Manager.
 */
export const register = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    const existingAdmin = await Admin.findOne({ email });

    if (existingAdmin) {
      return res.status(409).json({
        success: false,
        message:
          'Email already registered. Please login or use a different email.',
      });
    }

    const newAdmin = new Admin({
      name,
      email,
      password,
      role: 'admin',
    });

    await newAdmin.save();

    const token = generateToken(
      newAdmin._id.toString(),
      newAdmin.email,
      newAdmin.name,
      newAdmin.role
    );

    setAuthCookie(res, token);

    return res.status(201).json({
      success: true,
      message: 'Registration successful',
      data: {
        user: formatUserResponse(newAdmin),
      },
    });
  } catch (error) {
    console.error('[AUTH] Register error:', error.message);

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
 * Login supports both:
 *
 * 1. Admin / Manager
 * 2. Employee
 *
 * The user does NOT select a role.
 * The backend determines the account type from the email.
 */
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    /*
     * --------------------------------------------------
     * STEP 1 — Try Admin / Manager account
     * --------------------------------------------------
     */

    const admin = await Admin.findOne({ email }).select('+password');

    if (admin) {
      if (!admin.isActive) {
        return res.status(403).json({
          success: false,
          message:
            'Your account has been deactivated. Please contact support.',
        });
      }

      const isPasswordValid = await admin.comparePassword(password);

      if (!isPasswordValid) {
        return res.status(401).json({
          success: false,
          message: 'Invalid email or password.',
        });
      }

      const token = generateToken(
        admin._id.toString(),
        admin.email,
        admin.name,
        admin.role
      );

      setAuthCookie(res, token);

      return res.status(200).json({
        success: true,
        message: 'Login successful',
        data: {
          user: formatUserResponse(admin),
        },
      });
    }

    /*
     * --------------------------------------------------
     * STEP 2 — Try Employee account
     * --------------------------------------------------
     */

    const employeeAccount = await EmployeeAccount.findOne({
      email,
    }).select('+password');

    if (!employeeAccount) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    /*
     * Employee account status
     */
    if (!employeeAccount.isActive) {
      return res.status(403).json({
        success: false,
        message:
          'Your employee login account has been deactivated. Please contact your administrator.',
      });
    }

    /*
     * Find the associated Employee record.
     */
    const employee = await Employee.findById(employeeAccount.employee);

    if (!employee) {
      return res.status(404).json({
        success: false,
        message:
          'Employee record associated with this account could not be found.',
      });
    }

    /*
     * Employee itself must also be active.
     */
    if (employee.status !== 'active') {
      return res.status(403).json({
        success: false,
        message:
          'Your employee account is not currently active. Please contact your administrator.',
      });
    }

    /*
     * Verify employee password.
     */
    const isPasswordValid = await employeeAccount.comparePassword(password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    /*
     * Employee display name.
     */
    const employeeName = `${employee.firstName} ${employee.lastName}`;

    /*
     * IMPORTANT:
     *
     * The EmployeeAccount itself is the authenticated identity.
     * Therefore the JWT id is EmployeeAccount._id.
     *
     * The role is always "employee".
     */
    const token = generateToken(
      employeeAccount._id.toString(),
      employeeAccount.email,
      employeeName,
      employeeAccount.role
    );

    setAuthCookie(res, token);

    return res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        user: {
          id: employeeAccount._id,
          employeeId: employee._id,
          name: employeeName,
          email: employeeAccount.email,
          role: employeeAccount.role,
          isActive: employeeAccount.isActive,
          department: employee.department,
          position: employee.position,
        },
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
 * POST /api/auth/logout
 */
export const logout = async (req, res) => {
  clearAuthCookie(res);

  return res.status(200).json({
    success: true,
    message: 'Logout successful.',
  });
};

/**
 * GET /api/auth/me
 *
 * Returns the currently authenticated user.
 *
 * Supports:
 * - Admin
 * - Manager
 * - Employee
 */
export const getCurrentUser = async (req, res) => {
  try {
    /*
     * --------------------------------------------------
     * ADMIN / MANAGER
     * --------------------------------------------------
     */

    if (req.user.role === 'admin' || req.user.role === 'manager') {
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
          message:
            'Your account has been deactivated. Please contact support.',
        });
      }

      return res.status(200).json({
        success: true,
        message: 'User fetched successfully',
        data: {
          user: formatUserResponse(admin),
        },
      });
    }

    /*
     * --------------------------------------------------
     * EMPLOYEE
     * --------------------------------------------------
     */

    if (req.user.role === 'employee') {
      const employeeAccount = await EmployeeAccount.findById(req.user.id);

      if (!employeeAccount) {
        return res.status(404).json({
          success: false,
          message: 'Employee login account not found.',
        });
      }

      if (!employeeAccount.isActive) {
        return res.status(403).json({
          success: false,
          message:
            'Your employee login account has been deactivated.',
        });
      }

      const employee = await Employee.findById(employeeAccount.employee);

      if (!employee) {
        return res.status(404).json({
          success: false,
          message: 'Employee record not found.',
        });
      }

      if (employee.status !== 'active') {
        return res.status(403).json({
          success: false,
          message:
            'Your employee record is not currently active.',
        });
      }

      return res.status(200).json({
        success: true,
        message: 'User fetched successfully',
        data: {
          user: {
            id: employeeAccount._id,
            employeeId: employee._id,
            name: `${employee.firstName} ${employee.lastName}`,
            email: employeeAccount.email,
            role: employeeAccount.role,
            isActive: employeeAccount.isActive,
            department: employee.department,
            position: employee.position,
          },
        },
      });
    }

    /*
     * Unknown role
     */
    return res.status(403).json({
      success: false,
      message: 'Invalid user role.',
    });
  } catch (error) {
    console.error('[AUTH] Get current user error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch user data.',
    });
  }
};