import salaryService from '../services/salaryService.js';
import { actorFromRequest, companyIdFromRequest } from '../utils/tenant.js';

export const getCurrentSalary = async (req, res) => {
  const salary = await salaryService.getCurrentSalary(req.params.employeeId, companyIdFromRequest(req));
  return res.status(200).json({ success: true, data: { salary } });
};

export const getSalaryHistory = async (req, res) => {
  const salaries = await salaryService.getSalaryHistory(req.params.employeeId, companyIdFromRequest(req));
  return res.status(200).json({ success: true, data: { salaries } });
};

export const createSalaryRevision = async (req, res) => {
  const { salary, warnings } = await salaryService.createSalaryRevision(
    req.params.employeeId,
    companyIdFromRequest(req),
    req.body,
    actorFromRequest(req)
  );
  return res.status(201).json({ success: true, message: 'Salary version created.', data: { salary, warnings } });
};
