import Employee from '../models/Employee.js';

/**
 * Employee Controller
 *
 * Full CRUD operations for employee records.
 * All routes are protected — req.user is set by authMiddleware.
 *
 * Endpoints:
 *   GET    /api/employees          – List / search / filter employees (paginated)
 *   GET    /api/employees/stats    – Aggregate stats for dashboard
 *   GET    /api/employees/:id      – Get single employee
 *   POST   /api/employees          – Create employee
 *   PUT    /api/employees/:id      – Update employee
 *   DELETE /api/employees/:id      – Delete employee
 */

// ─── List / Search / Filter ──────────────────────────────────────────────────
/**
 * GET /api/employees
 *
 * Query params:
 *   page       (default: 1)
 *   limit      (default: 10, max: 100)
 *   search     full-text search across name, email, position, department
 *   department filter by department
 *   status     filter by status
 *   sortBy     field to sort by (default: createdAt)
 *   sortOrder  asc | desc (default: desc)
 */
export const getEmployees = async (req, res) => {
  const {
    page = 1,
    limit = 10,
    search = '',
    department = '',
    status = '',
    sortBy = 'createdAt',
    sortOrder = 'desc',
  } = req.query;

  // Build query filter
  const filter = {};

  if (search.trim()) {
    // Use regex for partial name / email / position match
    const regex = new RegExp(search.trim(), 'i');
    filter.$or = [
      { firstName: regex },
      { lastName: regex },
      { email: regex },
      { position: regex },
      { department: regex },
    ];
  }

  if (department) filter.department = department;
  if (status) filter.status = status;

  const sortDirection = sortOrder === 'asc' ? 1 : -1;
  const skip = (page - 1) * limit;

  const [employees, total] = await Promise.all([
    Employee.find(filter)
      .sort({ [sortBy]: sortDirection })
      .skip(skip)
      .limit(limit)
      .lean(),
    Employee.countDocuments(filter),
  ]);

  return res.status(200).json({
    success: true,
    data: {
      employees,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page < Math.ceil(total / limit),
        hasPrevPage: page > 1,
      },
    },
  });
};

// ─── Aggregate Stats ─────────────────────────────────────────────────────────
/**
 * GET /api/employees/stats
 *
 * Returns summary statistics for the dashboard:
 *   - total employees
 *   - active / inactive / on-leave counts
 *   - per-department breakdown
 *   - average salary
 *   - new hires this month
 */
export const getEmployeeStats = async (req, res) => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [statusCounts, departmentCounts, salaryStats, newHires] =
    await Promise.all([
      // Status breakdown
      Employee.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      // Department breakdown
      Employee.aggregate([
        { $group: { _id: '$department', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      // Salary statistics
      Employee.aggregate([
        {
          $group: {
            _id: null,
            avgSalary: { $avg: '$salary' },
            maxSalary: { $max: '$salary' },
            minSalary: { $min: '$salary' },
            totalPayroll: { $sum: '$salary' },
          },
        },
      ]),
      // New hires this month
      Employee.countDocuments({ createdAt: { $gte: startOfMonth } }),
    ]);

  // Normalize status counts
  const statusMap = { active: 0, inactive: 0, 'on-leave': 0 };
  statusCounts.forEach(({ _id, count }) => {
    if (_id in statusMap) statusMap[_id] = count;
  });

  const totalEmployees = Object.values(statusMap).reduce((a, b) => a + b, 0);

  return res.status(200).json({
    success: true,
    data: {
      stats: {
        total: totalEmployees,
        active: statusMap.active,
        inactive: statusMap.inactive,
        onLeave: statusMap['on-leave'],
        newHiresThisMonth: newHires,
        departments: departmentCounts.map((d) => ({
          name: d._id,
          count: d.count,
        })),
        salary: salaryStats[0]
          ? {
              average: Math.round(salaryStats[0].avgSalary || 0),
              max: salaryStats[0].maxSalary || 0,
              min: salaryStats[0].minSalary || 0,
              totalPayroll: salaryStats[0].totalPayroll || 0,
            }
          : { average: 0, max: 0, min: 0, totalPayroll: 0 },
      },
    },
  });
};

// ─── Get Single Employee ──────────────────────────────────────────────────────
/**
 * GET /api/employees/:id
 */
export const getEmployee = async (req, res) => {
  const employee = await Employee.findById(req.params.id).lean();

  if (!employee) {
    return res.status(404).json({
      success: false,
      message: 'Employee not found.',
    });
  }

  return res.status(200).json({
    success: true,
    data: { employee },
  });
};

// ─── Create Employee ──────────────────────────────────────────────────────────
/**
 * POST /api/employees
 */
export const createEmployee = async (req, res) => {
  const {
    firstName,
    lastName,
    email,
    phone,
    department,
    position,
    salary,
    hireDate,
    status,
    address,
    notes,
  } = req.body;

  // Check for duplicate email
  const existing = await Employee.findOne({ email: email.toLowerCase() });
  if (existing) {
    return res.status(409).json({
      success: false,
      message: 'An employee with this email already exists.',
    });
  }

  const employee = await Employee.create({
    firstName,
    lastName,
    email,
    phone,
    department,
    position,
    salary,
    hireDate,
    status: status || 'active',
    address,
    notes,
    createdBy: req.user.id,
  });

  return res.status(201).json({
    success: true,
    message: 'Employee created successfully.',
    data: { employee },
  });
};

// ─── Update Employee ──────────────────────────────────────────────────────────
/**
 * PUT /api/employees/:id
 */
export const updateEmployee = async (req, res) => {
  const { id } = req.params;

  // If email is being changed, check for conflicts
  if (req.body.email) {
    const conflict = await Employee.findOne({
      email: req.body.email.toLowerCase(),
      _id: { $ne: id },
    });
    if (conflict) {
      return res.status(409).json({
        success: false,
        message: 'Another employee with this email already exists.',
      });
    }
  }

  const employee = await Employee.findByIdAndUpdate(
    id,
    { $set: req.body },
    { new: true, runValidators: true }
  ).lean();

  if (!employee) {
    return res.status(404).json({
      success: false,
      message: 'Employee not found.',
    });
  }

  return res.status(200).json({
    success: true,
    message: 'Employee updated successfully.',
    data: { employee },
  });
};

// ─── Delete Employee ──────────────────────────────────────────────────────────
/**
 * DELETE /api/employees/:id
 */
export const deleteEmployee = async (req, res) => {
  const employee = await Employee.findByIdAndDelete(req.params.id);

  if (!employee) {
    return res.status(404).json({
      success: false,
      message: 'Employee not found.',
    });
  }

  return res.status(200).json({
    success: true,
    message: 'Employee deleted successfully.',
  });
};
