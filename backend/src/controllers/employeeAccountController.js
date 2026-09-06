import Employee from '../models/Employee.js';
import EmployeeAccount from '../models/EmployeeAccount.js';

/**
 * Create a login account for an existing employee
 *
 * Admin/Manager creates the account.
 * The employee record itself remains unchanged.
 */
export const createEmployeeAccount = async (req, res) => {
  const { employeeId, password } = req.body;

  if (!employeeId || !password) {
    return res.status(400).json({
      success: false,
      message: 'Employee ID and password are required.',
    });
  }

  if (password.length < 8) {
    return res.status(400).json({
      success: false,
      message: 'Password must be at least 8 characters.',
    });
  }

  const employee = await Employee.findById(employeeId);

  if (!employee) {
    return res.status(404).json({
      success: false,
      message: 'Employee not found.',
    });
  }

  if (employee.status !== 'active') {
    return res.status(400).json({
      success: false,
      message: 'Login account can only be created for an active employee.',
    });
  }

  const existingAccount = await EmployeeAccount.findOne({
    employee: employee._id,
  });

  if (existingAccount) {
    return res.status(409).json({
      success: false,
      message: 'This employee already has a login account.',
    });
  }

  const emailAccount = await EmployeeAccount.findOne({
    email: employee.email,
  });

  if (emailAccount) {
    return res.status(409).json({
      success: false,
      message: 'An account already exists with this employee email.',
    });
  }

  const account = await EmployeeAccount.create({
    employee: employee._id,
    email: employee.email,
    password,
    role: 'employee',
  });

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

  const account = await EmployeeAccount.findOne({
    employee: employeeId,
  });

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
 * Activate or deactivate an employee login account
 */
export const updateEmployeeAccountStatus = async (req, res) => {
  const { employeeId } = req.params;
  const { isActive } = req.body;

  if (typeof isActive !== 'boolean') {
    return res.status(400).json({
      success: false,
      message: 'isActive must be true or false.',
    });
  }

  const account = await EmployeeAccount.findOneAndUpdate(
    { employee: employeeId },
    { isActive },
    { new: true, runValidators: true }
  );

  if (!account) {
    return res.status(404).json({
      success: false,
      message: 'Employee login account not found.',
    });
  }

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