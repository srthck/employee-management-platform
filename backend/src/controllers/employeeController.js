import mongoose from 'mongoose';
import Employee, { anyArchiveState } from '../models/Employee.js';
import EmployeeAccount from '../models/EmployeeAccount.js';
import auditService from '../services/auditService.js';
import employmentService, { createJoiningRecord } from '../services/employmentService.js';
import { runInTransaction } from '../utils/transaction.js';
import { actorFromRequest, companyIdFromRequest, notFound } from '../utils/tenant.js';

/**
 * Employee Controller
 *
 * Full lifecycle operations for employee records.
 * All routes are protected — req.user is set by authMiddleware.
 *
 * Every query is scoped to the caller's company (Employee.createdBy).
 * An ID belonging to another company behaves exactly like a missing ID (404),
 * so record existence is never disclosed across tenants.
 *
 * Every write emits an audit event in the same transaction as the change.
 *
 * Endpoints:
 *   GET    /api/employees              – List / search / filter employees (paginated)
 *   GET    /api/employees/stats        – Aggregate stats for dashboard
 *   GET    /api/employees/:id          – Get single employee
 *   POST   /api/employees              – Create employee
 *   PUT    /api/employees/:id          – Update employee (allowlisted fields only)
 *   DELETE /api/employees/:id          – Archive employee (soft delete)
 *   POST   /api/employees/:id/restore  – Restore an archived employee
 */

const UPDATABLE_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'department', 'position', 'hireDate', 'status', 'notes'];
const ADDRESS_FIELDS = ['street', 'city', 'state', 'zipCode', 'country'];

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build the $set payload from an explicit allowlist. Fields that are not
 * allowlisted are ignored, so adding a new sensitive field to the schema can
 * never make it client-writable by accident.
 */
const pickUpdates = (body) => {
  const updates = {};
  for (const field of UPDATABLE_FIELDS) {
    if (hasOwn(body, field)) updates[field] = body[field];
  }
  if (body.address && typeof body.address === 'object') {
    for (const field of ADDRESS_FIELDS) {
      if (hasOwn(body.address, field)) updates[`address.${field}`] = body.address[field];
    }
  }
  return updates;
};

// Includes archived records: an email stays reserved while its employee is archived.
const findByEmailIncludingArchived = (companyId, email, excludeId = null) => {
  const filter = { createdBy: companyId, email: email.toLowerCase(), isDeleted: anyArchiveState() };
  if (excludeId) filter._id = { $ne: excludeId };
  return Employee.findOne(filter).select('isDeleted').lean();
};

// ─── List / Search / Filter ──────────────────────────────────────────────────
/**
 * GET /api/employees
 *
 * Query params:
 *   page       (default: 1)
 *   limit      (default: 10, max: 100)
 *   search     partial match across name, email, position, department
 *   department filter by department
 *   status     filter by status
 *   archived   'true' lists archived employees instead of current ones
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
    archived = 'false',
    sortBy = 'createdAt',
    sortOrder = 'desc',
  } = req.query;

  const filter = {
    createdBy: companyIdFromRequest(req),
    isDeleted: archived === 'true' ? true : { $ne: true },
  };

  if (search.trim()) {
    // User input is escaped: a raw RegExp allows ReDoS and pattern injection.
    const regex = new RegExp(escapeRegex(search.trim()), 'i');
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
      .sort({ [sortBy]: sortDirection, _id: sortDirection })
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
 * Returns summary statistics for the dashboard (current, non-archived employees):
 *   - total employees
 *   - active / inactive / on-leave counts
 *   - per-department breakdown
 *   - salary statistics (from the synced legacy salary field)
 *   - new hires this month
 */
export const getEmployeeStats = async (req, res) => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const match = {
    createdBy: new mongoose.Types.ObjectId(companyIdFromRequest(req)),
    isDeleted: { $ne: true },
  };

  const [statusCounts, departmentCounts, salaryStats, newHires, archived] =
    await Promise.all([
      Employee.aggregate([
        { $match: match },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      Employee.aggregate([
        { $match: match },
        { $group: { _id: '$department', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Employee.aggregate([
        { $match: match },
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
      Employee.countDocuments({ ...match, createdAt: { $gte: startOfMonth } }),
      Employee.countDocuments({ createdBy: match.createdBy, isDeleted: true }),
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
        archived,
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
  const employee = await Employee.findOne({
    _id: req.params.id,
    createdBy: companyIdFromRequest(req),
  }).lean();

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
  const companyId = companyIdFromRequest(req);
  const actor = actorFromRequest(req);
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

  const existing = await findByEmailIncludingArchived(companyId, email);
  if (existing) {
    return res.status(409).json({
      success: false,
      message: existing.isDeleted
        ? 'An archived employee with this email exists. Restore that record instead of creating a new one.'
        : 'An employee with this email already exists.',
    });
  }

  const employee = await runInTransaction(async (session) => {
    const [created] = await Employee.create([{
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
      createdBy: companyId,
    }], { session });

    // Employment history starts at joining, in the same transaction.
    await createJoiningRecord(created, companyId, actor, session);

    await auditService.log({
      action: 'EMPLOYEE_CREATED',
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      entityType: 'EMPLOYEE',
      entityId: created._id,
      companyId,
      newStatus: created.status,
      meta: { department: created.department, position: created.position },
    }, session);

    return created;
  }, { label: 'employee.create' });

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
  const companyId = companyIdFromRequest(req);
  const actor = actorFromRequest(req);

  const protectedFields = ['employeeCode', 'isDeleted', 'deletedAt', 'deletedBy', 'createdBy', 'salary', 'role', 'permissions'];
  const attemptedProtectedField = protectedFields.find((field) => hasOwn(req.body, field));
  if (attemptedProtectedField) {
    return res.status(422).json({
      success: false,
      message: `${attemptedProtectedField} cannot be changed through employee profile updates.`,
    });
  }

  const updates = pickUpdates(req.body);
  if (Object.keys(updates).length === 0) {
    return res.status(422).json({
      success: false,
      message: 'No updatable employee fields were supplied.',
    });
  }

  if (updates.email) {
    const conflict = await findByEmailIncludingArchived(companyId, updates.email, id);
    if (conflict) {
      return res.status(409).json({
        success: false,
        message: 'Another employee with this email already exists.',
      });
    }
  }

  const employee = await runInTransaction(async (session) => {
    const doc = await Employee.findOne({ _id: id, createdBy: companyId }).session(session);
    if (!doc) throw notFound('Employee not found.');

    const previousStatus = doc.status;
    const previous = { department: doc.department, position: doc.position, hireDate: doc.hireDate };
    doc.set(updates);
    const changedFields = [...new Set(doc.modifiedPaths().map((path) => path.split('.')[0]))];
    if (changedFields.length === 0) return doc;

    // Department, position and hire date are employment history, not free text.
    const employment = await employmentService.applyEmployeeRecordEdit(doc, previous, changedFields, companyId, actor, session);

    await doc.save({ session });

    await auditService.log({
      action: 'EMPLOYEE_UPDATED',
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      entityType: 'EMPLOYEE',
      entityId: doc._id,
      companyId,
      previousStatus,
      newStatus: doc.status,
      meta: { changedFields, ...(employment && { employment }) },
    }, session);

    return doc;
  }, { label: 'employee.update' });

  return res.status(200).json({
    success: true,
    message: 'Employee updated successfully.',
    data: { employee: employee.toObject() },
  });
};

// ─── Archive Employee (soft delete) ───────────────────────────────────────────
/**
 * DELETE /api/employees/:id
 *
 * The record is archived, never removed:
 *   - isDeleted / deletedAt / deletedBy / deletionReason are recorded
 *   - status becomes inactive, so the employee leaves future payroll runs
 *   - the employee's login account is deactivated and its sessions revoked
 *   - EMPLOYEE_DELETED is audited in the same transaction
 * Finalized payroll snapshots are untouched.
 */
export const deleteEmployee = async (req, res) => {
  const companyId = companyIdFromRequest(req);
  const actor = actorFromRequest(req);
  const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
    ? req.body.reason.trim()
    : null;

  await runInTransaction(async (session) => {
    const doc = await Employee.findOne({ _id: req.params.id, createdBy: companyId }).session(session);
    if (!doc) throw notFound('Employee not found.');

    const previousStatus = doc.status;
    doc.set({
      isDeleted: true,
      deletedAt: new Date(),
      deletedBy: actor.id,
      deletionReason: reason,
      status: 'inactive',
    });
    await doc.save({ session });

    const accountUpdate = await EmployeeAccount.updateOne(
      { employee: doc._id },
      { $set: { isActive: false }, $inc: { tokenVersion: 1 } },
      { session }
    );

    await auditService.log({
      action: 'EMPLOYEE_DELETED',
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      entityType: 'EMPLOYEE',
      entityId: doc._id,
      companyId,
      previousStatus,
      newStatus: 'ARCHIVED',
      meta: {
        mode: 'SOFT_DELETE',
        reason,
        loginAccountDeactivated: accountUpdate.modifiedCount > 0,
      },
    }, session);
  }, { label: 'employee.archive' });

  return res.status(200).json({
    success: true,
    message: 'Employee archived. Payroll history is retained.',
  });
};

// ─── Restore Employee ─────────────────────────────────────────────────────────
/**
 * POST /api/employees/:id/restore
 *
 * Restores the record as inactive. Reactivation (status) and login access are
 * separate, deliberate follow-up actions.
 */
export const restoreEmployee = async (req, res) => {
  const companyId = companyIdFromRequest(req);
  const actor = actorFromRequest(req);

  const employee = await runInTransaction(async (session) => {
    const doc = await Employee.findOne({
      _id: req.params.id,
      createdBy: companyId,
      isDeleted: true,
    }).session(session);
    if (!doc) throw notFound('Archived employee not found.');

    doc.set({ isDeleted: false, deletedAt: null, deletedBy: null, deletionReason: null });
    await doc.save({ session });

    await auditService.log({
      action: 'EMPLOYEE_RESTORED',
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      entityType: 'EMPLOYEE',
      entityId: doc._id,
      companyId,
      previousStatus: 'ARCHIVED',
      newStatus: doc.status,
      meta: {},
    }, session);

    return doc;
  }, { label: 'employee.restore' });

  return res.status(200).json({
    success: true,
    message: 'Employee restored as inactive. Update the status to include them in payroll.',
    data: { employee: employee.toObject() },
  });
};
