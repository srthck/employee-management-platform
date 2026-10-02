import Admin from '../models/Admin.js';
import Company from '../models/Company.js';
import EmployeeAccount from '../models/EmployeeAccount.js';
import auditService from './auditService.js';
import { runInTransaction } from '../utils/transaction.js';
import { STAFF_ROLES } from '../utils/permissions.js';

/**
 * companyService — company settings and staff user management.
 *
 * Guard rails:
 *   - users can only be managed inside the caller's company
 *   - nobody can change their own role or deactivate themselves
 *   - the last active administrator cannot be demoted or deactivated
 *   - role or status changes revoke the user's sessions immediately
 *   - every change is audited with before/after values
 */

const serviceError = (message, statusCode, code) => Object.assign(new Error(message), { statusCode, code });

const SETTING_FIELDS = [
  'approvalMode', 'compensationApprovalMode', 'varianceThresholdPercent', 'blockFinalizationOnUnexplainedVariance',
  'payableDaysBasis', 'fixedPayableDays', 'weeklyOffDays', 'professionalTaxBasis',
];

const sameSetting = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const publicUser = (user) => ({
  id: String(user._id),
  name: user.name,
  email: user.email,
  role: user.role,
  isActive: user.isActive,
  isOwner: String(user._id) === String(user.companyId || user._id),
  lastLoginAt: user.lastLoginAt || null,
  createdAt: user.createdAt,
});

const inCompany = (companyId) => ({ $or: [{ _id: companyId }, { companyId }] });

const companyService = {
  /** Company for the caller; creates it for workspaces that predate the Company entity. */
  async getCompany(companyId) {
    const company = await Company.findById(companyId).lean();
    if (company) return company;
    const owner = await Admin.findById(companyId);
    if (!owner) throw serviceError('Company not found.', 404, 'NOT_FOUND');
    return (await Company.ensureForOwner(owner)).toObject();
  },

  async updateSettings(companyId, actor, { name, settings = {} }) {
    await this.getCompany(companyId);

    return runInTransaction(async (session) => {
      const company = await Company.findById(companyId).session(session);
      const changes = {};

      if (typeof name === 'string' && name.trim() && name.trim() !== company.name) {
        changes.name = { from: company.name, to: name.trim() };
        company.name = name.trim();
      }
      for (const field of SETTING_FIELDS) {
        if (settings[field] === undefined || sameSetting(settings[field], company.settings[field])) continue;
        changes[`settings.${field}`] = { from: company.settings[field], to: settings[field] };
        company.settings[field] = settings[field];
      }

      if (Object.keys(changes).length === 0) return company.toObject();

      await company.save({ session });
      await auditService.log({
        action: 'COMPANY_SETTINGS_UPDATED',
        actorId: actor.id,
        actorEmail: actor.email,
        actorRole: actor.role,
        entityType: 'COMPANY',
        entityId: company._id,
        companyId,
        meta: { changes },
      }, session);

      return company.toObject();
    }, { label: 'company.settings' });
  },

  async listUsers(companyId) {
    const users = await Admin.find(inCompany(companyId))
      .select('name email role isActive companyId lastLoginAt createdAt')
      .sort({ createdAt: 1 })
      .lean();
    return users.map(publicUser);
  },

  async createUser(companyId, actor, { name, email, role, password }) {
    if (!STAFF_ROLES.includes(role)) {
      throw serviceError(`Role must be one of: ${STAFF_ROLES.join(', ')}.`, 422, 'INVALID_ROLE');
    }
    const normalizedEmail = email.toLowerCase();
    const [adminExists, accountExists] = await Promise.all([
      Admin.exists({ email: normalizedEmail }),
      EmployeeAccount.exists({ email: normalizedEmail }),
    ]);
    if (adminExists || accountExists) {
      throw serviceError('A user with this email already exists.', 409, 'EMAIL_IN_USE');
    }

    return runInTransaction(async (session) => {
      const [user] = await Admin.create([{
        name,
        email: normalizedEmail,
        password,
        role,
        companyId,
      }], { session });

      await auditService.log({
        action: 'COMPANY_USER_CREATED',
        actorId: actor.id,
        actorEmail: actor.email,
        actorRole: actor.role,
        entityType: 'ADMIN',
        entityId: user._id,
        companyId,
        newStatus: role,
        meta: { email: normalizedEmail, role },
      }, session);

      return publicUser(user);
    }, { label: 'company.createUser' });
  },

  async updateUser(companyId, actor, userId, { role, isActive }) {
    if (String(userId) === String(actor.id)) {
      throw serviceError('You cannot change your own role or status.', 422, 'SELF_MODIFICATION');
    }
    if (role !== undefined && !STAFF_ROLES.includes(role)) {
      throw serviceError(`Role must be one of: ${STAFF_ROLES.join(', ')}.`, 422, 'INVALID_ROLE');
    }

    return runInTransaction(async (session) => {
      const user = await Admin.findOne({ _id: userId, ...inCompany(companyId) }).session(session);
      if (!user) throw serviceError('User not found.', 404, 'NOT_FOUND');

      const changes = {};
      if (role !== undefined && role !== user.role) changes.role = { from: user.role, to: role };
      if (isActive !== undefined && isActive !== user.isActive) changes.isActive = { from: user.isActive, to: isActive };
      if (Object.keys(changes).length === 0) return publicUser(user);

      const losesAdmin = user.role === 'admin' && user.isActive
        && ((changes.role && changes.role.to !== 'admin') || (changes.isActive && changes.isActive.to === false));
      if (losesAdmin) {
        const otherActiveAdmins = await Admin.countDocuments({
          ...inCompany(companyId),
          _id: { $ne: user._id },
          role: 'admin',
          isActive: true,
        }).session(session);
        if (otherActiveAdmins === 0) {
          throw serviceError('The company must keep at least one active administrator.', 409, 'LAST_ADMIN');
        }
      }

      if (changes.role) user.role = changes.role.to;
      if (changes.isActive) user.isActive = changes.isActive.to;
      // Revoke existing sessions so the new role or status applies immediately.
      user.tokenVersion = (user.tokenVersion || 0) + 1;
      await user.save({ session });

      await auditService.log({
        action: 'COMPANY_USER_UPDATED',
        actorId: actor.id,
        actorEmail: actor.email,
        actorRole: actor.role,
        entityType: 'ADMIN',
        entityId: user._id,
        companyId,
        previousStatus: changes.role?.from || null,
        newStatus: changes.role?.to || null,
        meta: { changes },
      }, session);

      return publicUser(user);
    }, { label: 'company.updateUser' });
  },
};

export default companyService;
