import jwt from 'jsonwebtoken';
import config from '../config/environment.js';
import Admin from '../models/Admin.js';
import EmployeeAccount from '../models/EmployeeAccount.js';
import Employee from '../models/Employee.js';
import { setContextValues } from '../utils/requestContext.js';
import { permissionsForRole } from '../utils/permissions.js';

const readCookie = (req, name) => {
  const header = req.headers.cookie || '';
  const item = header.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : null;
};

const unauthorized = (res, message) =>
  res.status(401).json({ success: false, message, requestId: res.req?.requestId });

/**
 * Resolve the authenticated principal from the database.
 *
 * The JWT only proves "this token was issued by us". Whether the account is
 * still allowed in is decided here on every request, so that:
 *   - deactivating a user takes effect immediately (not after the token expires)
 *   - a role change takes effect immediately
 *   - "sign out everywhere" (tokenVersion bump) revokes every outstanding token
 *   - archived or inactive employees lose self-service access immediately
 */
async function loadPrincipal(decoded) {
  const tokenVersion = decoded.tv || 0;

  if (decoded.role === 'employee') {
    const account = await EmployeeAccount.findById(decoded.id)
      .select('email role isActive employee companyId tokenVersion')
      .lean();
    if (!account || !account.isActive || (account.tokenVersion || 0) !== tokenVersion) return null;

    const employee = await Employee.findById(account.employee)
      .select('firstName lastName status createdBy')
      .lean();
    if (!employee || employee.status !== 'active') return null;

    return {
      id: String(account._id),
      email: account.email,
      name: `${employee.firstName} ${employee.lastName}`,
      role: 'employee',
      employeeId: String(employee._id),
      companyId: String(account.companyId || employee.createdBy),
    };
  }

  const admin = await Admin.findById(decoded.id)
    .select('name email role isActive companyId tokenVersion')
    .lean();
  if (!admin || !admin.isActive || (admin.tokenVersion || 0) !== tokenVersion) return null;

  return {
    id: String(admin._id),
    email: admin.email,
    name: admin.name,
    role: admin.role,
    companyId: String(admin.companyId || admin._id),
  };
}

/**
 * Authentication Middleware
 *
 * Responsibilities:
 * - Extract JWT from the HttpOnly session cookie (Bearer header accepted for
 *   non-browser API clients)
 * - Verify token signature and expiration
 * - Re-validate the account against the database
 * - Attach the principal (including companyId) to req.user
 */
const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = readCookie(req, config.authCookieName) || (authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null);

  if (!token) {
    return unauthorized(res, 'Authentication required.');
  }

  let decoded;
  try {
    decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return unauthorized(res, 'Token has expired. Please login again.');
    }
    return unauthorized(res, 'Invalid token. Please login again.');
  }

  const principal = await loadPrincipal(decoded);
  if (!principal) {
    return unauthorized(res, 'Session is no longer valid. Please login again.');
  }

  req.user = principal;
  setContextValues({ companyId: principal.companyId, actorId: principal.id });
  return next();
};

/**
 * Role-based access control
 *
 * Usage: router.post('/', requireRole('admin'), handler)
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

/**
 * Permission-based access control (see utils/permissions.js).
 *
 * Usage: router.post('/:id/finalize', requirePermission(PERMISSIONS.PAYROLL_FINALIZE), handler)
 */
export const requirePermission = (...required) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required.',
      });
    }

    const granted = permissionsForRole(req.user.role);
    const missing = required.filter((permission) => !granted.includes(permission));
    if (missing.length > 0) {
      return res.status(403).json({
        success: false,
        code: 'FORBIDDEN',
        message: 'Insufficient permissions for this action.',
        missingPermissions: missing,
      });
    }

    return next();
  };
};

export { readCookie };
export default authMiddleware;
