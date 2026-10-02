import mongoose from 'mongoose';
import Employee from '../models/Employee.js';
import SalaryStructure from '../models/SalaryStructure.js';
import Company from '../models/Company.js';
import compensationService from './compensationService.js';

/**
 * salaryService — reads of the payroll input, and the direct revision path.
 *
 * Since Wave 3 every pay change goes through compensationService, which writes
 * the compensation version and this SalaryStructure projection in one
 * transaction. This service keeps the original read shapes and the direct
 * revision endpoint, so payroll and existing clients are unaffected.
 *
 * When a company turns on compensation maker-checker, the direct path is
 * closed: pay then changes only through an approved compensation change.
 */

const unprocessable = (message) => Object.assign(new Error(message), { statusCode: 422 });

const ensureObjectId = (value) => {
  if (!mongoose.isValidObjectId(value)) {
    throw Object.assign(new Error('Invalid employee ID.'), { statusCode: 400 });
  }
};

const employeeForCompany = (employeeId, companyId) =>
  Employee.findOne({ _id: employeeId, createdBy: companyId });

const salaryService = {
  async getCurrentSalary(employeeId, companyId) {
    ensureObjectId(employeeId);
    const employee = await employeeForCompany(employeeId, companyId);
    if (!employee) throw Object.assign(new Error('Employee not found.'), { statusCode: 404 });
    return SalaryStructure.findOne({ employeeId, effectiveTo: null }).sort({ effectiveFrom: -1 }).lean();
  },

  async getSalaryHistory(employeeId, companyId) {
    ensureObjectId(employeeId);
    const employee = await employeeForCompany(employeeId, companyId);
    if (!employee) throw Object.assign(new Error('Employee not found.'), { statusCode: 404 });
    return SalaryStructure.find({ employeeId }).sort({ effectiveFrom: -1 }).lean();
  },

  /**
   * Create a new salary version directly (POST /api/employees/:id/salary).
   *
   * Returns { salary, warnings }. A revision effective on or before the end of
   * an already finalized payroll period cannot change that period (snapshots
   * are immutable), so the caller is warned that arrears are due instead of
   * the difference silently going unpaid.
   */
  async createSalaryRevision(employeeId, companyId, payload, actor) {
    ensureObjectId(employeeId);
    const { effectiveFrom, components, workState } = payload;
    if (Number.isNaN(new Date(effectiveFrom).getTime())) throw unprocessable('effectiveFrom must be a valid date.');
    if (!components || typeof components.basic !== 'number') throw unprocessable('components.basic is required.');
    if (typeof workState !== 'string' || !workState.trim()) {
      throw unprocessable('workState is required. Professional tax jurisdiction is never assumed.');
    }

    const company = await Company.findById(companyId).select('settings.compensationApprovalMode').lean();
    if ((company?.settings?.compensationApprovalMode || 'single') === 'maker_checker') {
      throw Object.assign(
        new Error('This company requires compensation changes to be proposed and approved. Use the compensation change workflow.'),
        { statusCode: 409, code: 'COMPENSATION_APPROVAL_REQUIRED' }
      );
    }

    return compensationService.applyDirectRevision(employeeId, companyId, payload, actor);
  },
};

export default salaryService;
