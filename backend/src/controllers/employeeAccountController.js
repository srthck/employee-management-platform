import Employee from '../models/Employee.js';
import EmployeeAccount from '../models/EmployeeAccount.js';
import auditService from '../services/auditService.js';
import { runInTransaction } from '../utils/transaction.js';
import { actorFromRequest, companyIdFromRequest, notFound } from '../utils/tenant.js';

/**
 * Employee login accounts.
 *
 * Every operation first proves the employee belongs to the caller's company;
 * an employee of another company is reported as not found.
 * Every change is audited.
 */

const findCompanyEmployee = (employeeId, companyId, session = null) =>
  Employee.findOne({ _id: employeeId, createdBy: companyId }).session(session);

/**
 * Create a login account for an existing employee
 *
 * Admin/Manager creates the account.
 * The employee record itself remains unchanged.
 */
export const createEmployeeAccount = async (req, res) => {
  const { employeeId, password } = req.body;
  const companyId = companyIdFromRequest(req);
  const actor = actorFromRequest(req);

  const { account, employee } = await runInTransaction(async (session) => {
    const employeeDoc = await findCompanyEmployee(employeeId, companyId, session);
    if (!employeeDoc) throw notFound('Employee not found.');

    if (employeeDoc.status !== 'active') {
      throw Object.assign(
        new Error('Login account can only be created for an active employee.'),
        { statusCode: 422 }
      );
    }

    if (await EmployeeAccount.exists({ employee: employeeDoc._id }).session(session)) {
      throw Object.assign(new Error('This employee already has a login account.'), { statusCode: 409 });
    }

    if (await EmployeeAccount.exists({ email: employeeDoc.email }).session(session)) {
      throw Object.assign(new Error('A login account already exists with this email.'), { statusCode: 409 });
    }

    const [created] = await EmployeeAccount.create([{
      employee: employeeDoc._id,
      companyId,
      email: employeeDoc.email,
      password,
      role: 'employee',
    }], { session });

    await auditService.log({
      action: 'EMPLOYEE_ACCOUNT_CREATED',
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      entityType: 'EMPLOYEE_ACCOUNT',
      entityId: created._id,
      companyId,
      meta: { employeeId: String(employeeDoc._id) },
    }, session);

    return { account: created, employee: employeeDoc };
  }, { label: 'employeeAccount.create' });

  return res.status(201).json({
    success: true,
    message: 'Employee login account created successfully.',
    data: {
      account: account.toJSON(),
      employee: {
        id: employee._id,
        name: `${employee.firstName} ${employee.lastName}`,
        email: employee.email,
      },
    },
  });
};

/**
 * Get the login account associated with an employee
 */
export const getEmployeeAccount = async (req, res) => {
  const { employeeId } = req.params;

  const employee = await findCompanyEmployee(employeeId, companyIdFromRequest(req));
  const account = employee
    ? await EmployeeAccount.findOne({ employee: employee._id })
    : null;

  if (!account) {
    return res.status(404).json({
      success: false,
      message: 'This employee does not have a login account.',
    });
  }

  return res.status(200).json({
    success: true,
    data: {
      account: account.toJSON(),
    },
  });
};

/**
 * Activate or deactivate an employee login account.
 * Deactivation also revokes every outstanding session for the account.
 */
export const updateEmployeeAccountStatus = async (req, res) => {
  const { employeeId } = req.params;
  const { isActive } = req.body;
  const companyId = companyIdFromRequest(req);
  const actor = actorFromRequest(req);

  const account = await runInTransaction(async (session) => {
    const employee = await findCompanyEmployee(employeeId, companyId, session);
    if (!employee) throw notFound('Employee login account not found.');

    const update = isActive
      ? { $set: { isActive: true } }
      : { $set: { isActive: false }, $inc: { tokenVersion: 1 } };

    const updated = await EmployeeAccount.findOneAndUpdate(
      { employee: employee._id },
      update,
      { new: true, runValidators: true, session }
    );
    if (!updated) throw notFound('Employee login account not found.');

    await auditService.log({
      action: isActive ? 'EMPLOYEE_ACCOUNT_ACTIVATED' : 'EMPLOYEE_ACCOUNT_DEACTIVATED',
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      entityType: 'EMPLOYEE_ACCOUNT',
      entityId: updated._id,
      companyId,
      newStatus: isActive ? 'ACTIVE' : 'INACTIVE',
      meta: { employeeId: String(employee._id) },
    }, session);

    return updated;
  }, { label: 'employeeAccount.status' });

  return res.status(200).json({
    success: true,
    message: `Employee login account ${
      isActive ? 'activated' : 'deactivated'
    } successfully.`,
    data: {
      account: account.toJSON(),
    },
  });
};
