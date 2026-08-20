import mongoose from 'mongoose';
import Employee from '../models/Employee.js';
import SalaryStructure from '../models/SalaryStructure.js';
import auditService from './auditService.js';

const ensureObjectId = (value) => {
  if (!mongoose.isValidObjectId(value)) {
    throw Object.assign(new Error('Invalid employee ID.'), { statusCode: 400 });
  }
};

const employeeForCompany = (employeeId, companyId, session = null) => {
  const query = Employee.findOne({ _id: employeeId, createdBy: companyId });
  return session ? query.session(session) : query;
};

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

  async createSalaryRevision(employeeId, companyId, payload, actor) {
    ensureObjectId(employeeId);
    const { effectiveFrom, components, currency, payFrequency, workState, pfEnrolled, esiEnrolled, ptEnrolled, pfWageOverride, remarks } = payload;
    const effectiveDate = new Date(effectiveFrom);
    if (Number.isNaN(effectiveDate.getTime())) throw Object.assign(new Error('effectiveFrom must be a valid date.'), { statusCode: 422 });
    if (!components || typeof components.basic !== 'number') throw Object.assign(new Error('components.basic is required.'), { statusCode: 422 });

    const session = await mongoose.startSession();
    try {
      let created;
      await session.withTransaction(async () => {
        const employee = await employeeForCompany(employeeId, companyId, session);
        if (!employee) throw Object.assign(new Error('Employee not found.'), { statusCode: 404 });
        const overlapping = await SalaryStructure.findOne({
          employeeId,
          effectiveFrom: { $lte: effectiveDate },
          $or: [{ effectiveTo: null }, { effectiveTo: { $gte: effectiveDate } }],
        }).session(session);
        if (overlapping) throw Object.assign(new Error('A salary version already covers the effective date.'), { statusCode: 409 });

        const current = await SalaryStructure.findOne({ employeeId, effectiveTo: null }).sort({ effectiveFrom: -1 }).session(session);
        if (current && current.effectiveFrom >= effectiveDate) {
          throw Object.assign(new Error('New salary effective date must be after the current version.'), { statusCode: 422 });
        }
        if (current) {
          current.effectiveTo = new Date(effectiveDate.getTime() - 1);
          await current.save({ session });
        }
        [created] = await SalaryStructure.create([{
          employeeId,
          effectiveFrom: effectiveDate,
          components,
          currency,
          payFrequency,
          workState,
          pfEnrolled,
          esiEnrolled,
          ptEnrolled,
          pfWageOverride,
          remarks,
          createdBy: companyId,
        }], { session });
        employee.salary = created.grossMonthly;
        await employee.save({ session });
        await auditService.log({
          action: 'SALARY_VERSION_CREATED',
          actorId: actor.id,
          actorEmail: actor.email,
          actorRole: actor.role,
          entityType: 'SALARY_STRUCTURE',
          entityId: created._id,
          meta: { employeeId, effectiveFrom: effectiveDate.toISOString() },
        }, session);
      });
      return created.toObject();
    } finally {
      await session.endSession();
    }
  },
};

export default salaryService;
