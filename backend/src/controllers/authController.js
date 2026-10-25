import jwt from 'jsonwebtoken';
import bcryptjs from 'bcryptjs';
import Admin from '../models/Admin.js';
import EmployeeAccount from '../models/EmployeeAccount.js';
import Employee from '../models/Employee.js';
import config from '../config/environment.js';
import Company from '../models/Company.js';
import auditService from '../services/auditService.js';
import compensationComponentService from '../services/compensationComponentService.js';
import { formatUserResponse } from '../utils/formatUser.js';
import { runInTransaction } from '../utils/transaction.js';
import { permissionsForRole } from '../utils/permissions.js';

/**
 * Authentication Controller
 *
 * Supports:
 * - Admin registration (creates a company workspace)
 * - Admin/Manager login
 * - Employee login
 * - Current authenticated user
 * - Logout / sign out everywhere
 *
 * Authentication architecture:
 *
 * Admin / Manager            Employee
 *      ↓                        ↓
 *    Admin               EmployeeAccount → Employee
 *
 * Login hardening:
 * - Unknown emails still perform a bcrypt comparison so response timing does
 *   not reveal which emails are registered.
 * - Account status (deactivated / inactive) is only revealed AFTER the correct
 *   password is supplied.
 * - LOGIN_MAX_ATTEMPTS consecutive failures lock the account for LOGIN_LOCK_MS.
 */

const INVALID_CREDENTIALS = 'Invalid email or password.';

let timingEqualizerHash = null;
const equalizeTiming = async (password) => {
  if (!timingEqualizerHash) {
    timingEqualizerHash = await bcryptjs.hash('payguard-timing-equalizer', config.bcryptRounds);
  }
  await bcryptjs.compare(String(password), timingEqualizerHash);
};

/**
 * Generate JWT. `tv` (token version) lets the server revoke all sessions.
 */
const generateToken = ({ id, email, name, role, tokenVersion = 0 }) => {
  return jwt.sign(
    { id, email, name, role, tv: tokenVersion },
    config.jwtSecret,
    { expiresIn: config.jwtExpire, algorithm: 'HS256' }
  );
};

const setAuthCookie = (res, sessionJwt) => {
  const secure = config.authCookieSecure ? '; Secure' : '';

  res.setHeader(
    'Set-Cookie',
    `${config.authCookieName}=${encodeURIComponent(sessionJwt)}; Path=/; HttpOnly; Max-Age=${config.authCookieMaxAgeSeconds}; SameSite=${config.authCookieSameSite}${secure}`
  );
};

const clearAuthCookie = (res) => {
  res.setHeader(
    'Set-Cookie',
    `${config.authCookieName}=; Path=/; HttpOnly; Max-Age=0; SameSite=${config.authCookieSameSite}${config.authCookieSecure ? '; Secure' : ''}`
  );
};

const invalidCredentials = (res) =>
  res.status(401).json({ success: false, message: INVALID_CREDENTIALS });

async function registerFailedAttempt(Model, doc, entityType) {
  const updated = await Model.findOneAndUpdate(
    { _id: doc._id },
    { $inc: { failedLoginAttempts: 1 } },
    { new: true }
  ).select('+failedLoginAttempts');

  if (updated && updated.failedLoginAttempts >= config.loginMaxAttempts) {
    const lockUntil = new Date(Date.now() + config.loginLockMs);
    await Model.updateOne(
      { _id: doc._id },
      { $set: { lockUntil, failedLoginAttempts: 0 } }
    );
    await auditService.logStandalone({
      action: 'AUTH_ACCOUNT_LOCKED',
      actorId: doc._id,
      actorEmail: doc.email,
      actorRole: doc.role,
      entityType,
      entityId: doc._id,
      companyId: doc.companyId || (entityType === 'ADMIN' ? doc._id : null),
      meta: { lockUntil: lockUntil.toISOString(), threshold: config.loginMaxAttempts },
    });
  }
}

/**
 * POST /api/auth/register
 *
 * Register a new admin user (and with it, a new company workspace).
 *
 * Public employee registration is intentionally NOT allowed.
 * Employees must be created by an authorized Admin/Manager.
 */
export const register = async (req, res) => {
  const { name, email, password, companyName } = req.body;

  const [existingAdmin, existingAccount] = await Promise.all([
    Admin.exists({ email }),
    EmployeeAccount.exists({ email }),
  ]);

  if (existingAdmin || existingAccount) {
    return res.status(409).json({
      success: false,
      code: 'EMAIL_IN_USE',
      message:
        'Email already registered. Please login or use a different email.',
    });
  }

  // Owner, company and audit event are created together or not at all.
  const newAdmin = await runInTransaction(async (session) => {
    const [admin] = await Admin.create([{
      name,
      email,
      password,
      role: 'admin',
      // Registration signs the owner in.
      lastLoginAt: new Date(),
    }], { session });

    await Company.create([{
      _id: admin._id,
      ownerId: admin._id,
      name: companyName || `${name}'s company`,
    }], { session });

    // Every company starts with the standard pay component catalogue.
    await compensationComponentService.seedDefaults(
      admin._id,
      { id: admin._id, email: admin.email, role: admin.role },
      session
    );

    await auditService.log({
      action: 'COMPANY_WORKSPACE_CREATED',
      actorId: admin._id,
      actorEmail: admin.email,
      actorRole: admin.role,
      entityType: 'COMPANY',
      entityId: admin._id,
      companyId: admin._id,
      meta: { companyName: companyName || null },
    }, session);

    return admin;
  }, { label: 'auth.register' });

  setAuthCookie(res, generateToken({
    id: newAdmin._id.toString(),
    email: newAdmin.email,
    name: newAdmin.name,
    role: newAdmin.role,
    tokenVersion: newAdmin.tokenVersion,
  }));

  return res.status(201).json({
    success: true,
    message: 'Registration successful',
    data: {
      user: formatUserResponse(newAdmin),
    },
  });
};

/**
 * POST /api/auth/login
 *
 * The user does NOT select a role. The backend determines the account type
 * from the email.
 */
export const login = async (req, res) => {
  const { email, password } = req.body;

  const admin = await Admin.findOne({ email })
    .select('+password +failedLoginAttempts +lockUntil');
  const account = admin
    ? null
    : await EmployeeAccount.findOne({ email }).select('+password +failedLoginAttempts +lockUntil');

  const principal = admin || account;
  const Model = admin ? Admin : EmployeeAccount;
  const entityType = admin ? 'ADMIN' : 'EMPLOYEE_ACCOUNT';

  if (!principal) {
    await equalizeTiming(password);
    return invalidCredentials(res);
  }

  if (principal.lockUntil && principal.lockUntil > new Date()) {
    const minutes = Math.ceil((principal.lockUntil.getTime() - Date.now()) / 60000);
    return res.status(429).json({
      success: false,
      message: `Too many failed login attempts. Try again in ${minutes} minute(s).`,
    });
  }

  const isPasswordValid = await principal.comparePassword(password);
  if (!isPasswordValid) {
    await registerFailedAttempt(Model, principal, entityType);
    return invalidCredentials(res);
  }

  // The caller has proven knowledge of the password; status can be disclosed.
  if (!principal.isActive) {
    return res.status(403).json({
      success: false,
      message: admin
        ? 'Your account has been deactivated. Please contact support.'
        : 'Your employee login account has been deactivated. Please contact your administrator.',
    });
  }

  let employee = null;
  if (account) {
    employee = await Employee.findById(account.employee);
    if (!employee || employee.status !== 'active') {
      return res.status(403).json({
        success: false,
        message:
          'Your employee account is not currently active. Please contact your administrator.',
      });
    }
  }

  await Model.updateOne(
    { _id: principal._id },
    { $set: { failedLoginAttempts: 0, lockUntil: null, lastLoginAt: new Date() } }
  );

  const displayName = employee ? `${employee.firstName} ${employee.lastName}` : principal.name;
  const companyId = admin
    ? String(admin.companyId || admin._id)
    : String(account.companyId || employee.createdBy);

  await auditService.logStandalone({
    action: 'AUTH_LOGIN_SUCCEEDED',
    actorId: principal._id,
    actorEmail: principal.email,
    actorRole: principal.role,
    entityType,
    entityId: principal._id,
    companyId,
    meta: {},
  });

  setAuthCookie(res, generateToken({
    id: principal._id.toString(),
    email: principal.email,
    name: displayName,
    role: principal.role,
    tokenVersion: principal.tokenVersion,
  }));

  if (admin) {
    return res.status(200).json({
      success: true,
      message: 'Login successful',
      data: { user: formatUserResponse(admin) },
    });
  }

  return res.status(200).json({
    success: true,
    message: 'Login successful',
    data: {
      user: {
        id: account._id,
        employeeId: employee._id,
        name: displayName,
        email: account.email,
        role: account.role,
        isActive: account.isActive,
        department: employee.department,
        position: employee.position,
        companyId,
        permissions: permissionsForRole(account.role),
      },
    },
  });
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
 * POST /api/auth/logout-all
 *
 * Revokes every session issued for this account (all devices) by bumping the
 * token version checked in authMiddleware.
 */
export const logoutAll = async (req, res) => {
  const Model = req.user.role === 'employee' ? EmployeeAccount : Admin;
  await Model.updateOne({ _id: req.user.id }, { $inc: { tokenVersion: 1 } });

  await auditService.logStandalone({
    action: 'AUTH_SESSIONS_REVOKED',
    actorId: req.user.id,
    actorEmail: req.user.email,
    actorRole: req.user.role,
    entityType: req.user.role === 'employee' ? 'EMPLOYEE_ACCOUNT' : 'ADMIN',
    entityId: req.user.id,
    meta: {},
  });

  clearAuthCookie(res);
  return res.status(200).json({
    success: true,
    message: 'Signed out of all sessions.',
  });
};

/**
 * GET /api/auth/me
 *
 * authMiddleware has already re-validated the account against the database.
 */
export const getCurrentUser = async (req, res) => {
  if (req.user.role === 'employee') {
    const employee = await Employee.findById(req.user.employeeId)
      .select('department position')
      .lean();

    return res.status(200).json({
      success: true,
      message: 'User fetched successfully',
      data: {
        user: {
          id: req.user.id,
          employeeId: req.user.employeeId,
          name: req.user.name,
          email: req.user.email,
          role: req.user.role,
          isActive: true,
          department: employee?.department,
          position: employee?.position,
          companyId: req.user.companyId,
          permissions: permissionsForRole(req.user.role),
        },
      },
    });
  }

  return res.status(200).json({
    success: true,
    message: 'User fetched successfully',
    data: {
      user: {
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role,
        isActive: true,
        companyId: req.user.companyId,
        permissions: permissionsForRole(req.user.role),
      },
    },
  });
};
