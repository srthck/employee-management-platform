import companyService from '../services/companyService.js';
import { actorFromRequest, companyIdFromRequest } from '../utils/tenant.js';
import { ROLE_LABELS, ROLE_PERMISSIONS, STAFF_ROLES } from '../utils/permissions.js';

const publicCompany = (company) => ({
  id: String(company._id),
  name: company.name,
  settings: company.settings,
  createdAt: company.createdAt,
});

export const getCompany = async (req, res) => {
  const company = await companyService.getCompany(companyIdFromRequest(req));
  return res.status(200).json({
    success: true,
    data: {
      company: publicCompany(company),
      roles: STAFF_ROLES.map((role) => ({ role, label: ROLE_LABELS[role], permissions: ROLE_PERMISSIONS[role] })),
    },
  });
};

export const updateCompanySettings = async (req, res) => {
  const company = await companyService.updateSettings(companyIdFromRequest(req), actorFromRequest(req), req.body);
  return res.status(200).json({ success: true, message: 'Company settings updated.', data: { company: publicCompany(company) } });
};

export const listCompanyUsers = async (req, res) => {
  const users = await companyService.listUsers(companyIdFromRequest(req));
  return res.status(200).json({ success: true, data: { users } });
};

export const createCompanyUser = async (req, res) => {
  const user = await companyService.createUser(companyIdFromRequest(req), actorFromRequest(req), req.body);
  return res.status(201).json({ success: true, message: 'User created.', data: { user } });
};

export const updateCompanyUser = async (req, res) => {
  const user = await companyService.updateUser(
    companyIdFromRequest(req),
    actorFromRequest(req),
    req.params.userId,
    req.body
  );
  return res.status(200).json({ success: true, message: 'User updated.', data: { user } });
};
