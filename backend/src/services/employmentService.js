import mongoose from 'mongoose';
import Employee, { anyArchiveState } from '../models/Employee.js';
import EmploymentRecord from '../models/EmploymentRecord.js';
import PayrollRun from '../models/PayrollRun.js';
import auditService from './auditService.js';
import { runInTransaction } from '../utils/transaction.js';
import { DEPARTMENTS, EMPLOYMENT_TYPES, EXIT_REASONS } from '../utils/workforce.js';
import { httpError, startOfUtcDay, dateOnly, isValidDate, loadCompanyEmployee } from './employeeScope.js';

/**
 * employmentService — effective-dated employment history.
 *
 * A change never edits an earlier version. It closes the current version the
 * instant before the new one takes effect and appends the new version, in one
 * transaction with the Employee projection and the audit event.
 *
 * Rules:
 *   - JOINING is recorded when the employee is created (or backfilled by the
 *     migration for older records).
 *   - Changes are appended after the current version; history before it is
 *     never rewritten.
 *   - Only EXIT may be scheduled ahead (by its last working day). Other
 *     changes are recorded on or after the day they take effect, because the
 *     Employee projection used by payroll is updated at recording time.
 *   - After EXIT no further changes are accepted.
 *   - A manager must be a current employee of the same company, never the
 *     employee, and never create a reporting cycle.
 *   - While JOINING is the only version, edits to department, position or
 *     hire date on the employee record correct it in place (audited).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Payload fields each change type may set. */
const CHANGE_FIELDS = Object.freeze({
  TRANSFER: ['department', 'workLocation', 'managerEmployeeId'],
  PROMOTION: ['designation', 'department'],
  REDESIGNATION: ['designation'],
  MANAGER_CHANGE: ['managerEmployeeId'],
  LOCATION_CHANGE: ['workLocation'],
  EMPLOYMENT_TYPE_CHANGE: ['employmentType'],
  CONFIRMATION: [],
  EXIT: [],
});

/** Fields a change type must include. */
const REQUIRED_FIELDS = Object.freeze({
  PROMOTION: ['designation'],
  REDESIGNATION: ['designation'],
  MANAGER_CHANGE: ['managerEmployeeId'],
  LOCATION_CHANGE: ['workLocation'],
  EMPLOYMENT_TYPE_CHANGE: ['employmentType'],
});

const TERM_KEYS = [
  'department', 'designation', 'managerEmployeeId', 'workLocation', 'employmentType',
  'probationStatus', 'confirmationDate', 'lifecycleStatus', 'exit',
];

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/** Comparable, JSON-safe view of the employment terms in a version. */
const termsOf = (record) => ({
  department: record.department,
  designation: record.designation,
  managerEmployeeId: record.managerEmployeeId ? String(record.managerEmployeeId) : null,
  workLocation: { name: record.workLocation?.name ?? null, state: record.workLocation?.state ?? null },
  employmentType: record.employmentType,
  probationStatus: record.probationStatus,
  confirmationDate: dateOnly(record.confirmationDate),
  lifecycleStatus: record.lifecycleStatus,
  exit: { lastWorkingDay: dateOnly(record.exit?.lastWorkingDay), reason: record.exit?.reason ?? null },
});

const pick = (object, keys) => Object.fromEntries(keys.map((key) => [key, object[key]]));

function toView(record, managerNames = new Map()) {
  const managerId = record.managerEmployeeId ? String(record.managerEmployeeId) : null;
  return {
    id: String(record._id),
    changeType: record.changeType,
    effectiveFrom: record.effectiveFrom,
    effectiveTo: record.effectiveTo,
    isCurrent: record.isCurrent,
    department: record.department,
    designation: record.designation,
    manager: managerId ? { employeeId: managerId, name: managerNames.get(managerId) || null } : null,
    workLocation: { name: record.workLocation?.name ?? null, state: record.workLocation?.state ?? null },
    employmentType: record.employmentType,
    probationStatus: record.probationStatus,
    confirmationDate: record.confirmationDate,
    lifecycleStatus: record.lifecycleStatus,
    exit: record.lifecycleStatus === 'EXITED'
      ? { lastWorkingDay: record.exit?.lastWorkingDay ?? null, reason: record.exit?.reason ?? null }
      : null,
    reason: record.reason,
    recordedByEmail: record.recordedByEmail,
    recordedAt: record.createdAt,
  };
}

/** JOINING version from the employee record (inside the caller's transaction). */
export async function createJoiningRecord(employee, companyId, actor, session) {
  const [record] = await EmploymentRecord.create([{
    employeeId: employee._id,
    companyId,
    effectiveFrom: startOfUtcDay(employee.hireDate),
    changeType: 'JOINING',
    department: employee.department,
    designation: employee.position,
    reason: null,
    recordedBy: actor.id,
    recordedByEmail: actor.email || null,
  }], { session });
  return record;
}

function validateChangeValues(changeType, changes) {
  if (!CHANGE_FIELDS[changeType]) {
    throw httpError(422, 'INVALID_CHANGE_TYPE', 'Unsupported employment change type. Joining is recorded when the employee is created.');
  }
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw httpError(422, 'VALIDATION_FAILED', 'changes must be an object.');
  }
  const unexpected = Object.keys(changes).filter((key) => !CHANGE_FIELDS[changeType].includes(key));
  if (unexpected.length) {
    throw httpError(422, 'FIELD_NOT_ALLOWED_FOR_CHANGE', `${changeType} cannot change: ${unexpected.join(', ')}.`);
  }
  const missing = (REQUIRED_FIELDS[changeType] || []).filter((key) => !has(changes, key));
  if (missing.length) {
    throw httpError(422, 'CHANGE_FIELDS_REQUIRED', `${changeType} requires: ${missing.join(', ')}.`);
  }

  if (has(changes, 'department') && !DEPARTMENTS.includes(changes.department)) {
    throw httpError(422, 'VALIDATION_FAILED', `department must be one of: ${DEPARTMENTS.join(', ')}.`);
  }
  if (has(changes, 'designation')) {
    const designation = typeof changes.designation === 'string' ? changes.designation.trim() : '';
    if (designation.length < 2 || designation.length > 100) {
      throw httpError(422, 'VALIDATION_FAILED', 'designation must be 2 to 100 characters.');
    }
  }
  if (has(changes, 'employmentType') && !EMPLOYMENT_TYPES.includes(changes.employmentType)) {
    throw httpError(422, 'VALIDATION_FAILED', `employmentType must be one of: ${EMPLOYMENT_TYPES.join(', ')}.`);
  }
  if (has(changes, 'workLocation')) {
    const location = changes.workLocation;
    const validPart = (value, min, max) => value === null || value === undefined || (typeof value === 'string' && value.trim().length >= min && value.trim().length <= max);
    if (!location || typeof location !== 'object' || !validPart(location.name, 2, 100) || !validPart(location.state, 2, 20)) {
      throw httpError(422, 'VALIDATION_FAILED', 'workLocation needs a name (2–100 characters) and/or a state code (2–20 characters).');
    }
  }
}

async function resolveManager(managerEmployeeId, employee, companyId, session) {
  if (managerEmployeeId === null) return null;
  if (!mongoose.isValidObjectId(managerEmployeeId)) {
    throw httpError(422, 'INVALID_MANAGER', 'managerEmployeeId must be an employee ID or null.');
  }
  if (String(managerEmployeeId) === String(employee._id)) {
    throw httpError(422, 'INVALID_MANAGER', 'An employee cannot be their own manager.');
  }
  const manager = await Employee.findOne({ _id: managerEmployeeId, createdBy: companyId }).session(session).lean();
  if (!manager) throw httpError(422, 'INVALID_MANAGER', 'The manager must be a current employee of this company.');

  // Walk up the reporting line from the proposed manager.
  let cursor = String(managerEmployeeId);
  for (let depth = 0; cursor && depth < 500; depth += 1) {
    const record = await EmploymentRecord.findOne({ employeeId: cursor, isCurrent: true })
      .select('managerEmployeeId lifecycleStatus')
      .session(session)
      .lean();
    if (depth === 0 && record?.lifecycleStatus === 'EXITED') {
      throw httpError(422, 'INVALID_MANAGER', 'The manager has exited the company.');
    }
    const next = record?.managerEmployeeId ? String(record.managerEmployeeId) : null;
    if (next === String(employee._id)) {
      throw httpError(409, 'MANAGER_CYCLE', 'This manager reports, directly or indirectly, to the employee.');
    }
    cursor = next;
  }
  return manager._id;
}

const employmentService = {
  async getHistory(employeeId, companyId) {
    const employee = await loadCompanyEmployee(employeeId, companyId, { lean: true });
    const records = await EmploymentRecord.find({ employeeId: employee._id }).sort({ effectiveFrom: -1 }).lean();

    const managerIds = [...new Set(records.map((r) => r.managerEmployeeId && String(r.managerEmployeeId)).filter(Boolean))];
    const managers = managerIds.length
      ? await Employee.find({ _id: { $in: managerIds }, createdBy: companyId, isDeleted: anyArchiveState() }).select('firstName lastName').lean()
      : [];
    const names = new Map(managers.map((m) => [String(m._id), `${m.firstName} ${m.lastName}`]));

    const now = new Date();
    const inEffect = records.find((r) => r.effectiveFrom <= now && (!r.effectiveTo || r.effectiveTo >= now)) || null;
    const scheduled = records.find((r) => r.isCurrent && r.effectiveFrom > now) || null;

    return {
      current: inEffect ? toView(inEffect, names) : null,
      scheduled: scheduled ? toView(scheduled, names) : null,
      history: records.map((r) => toView(r, names)),
    };
  },

  async recordChange(employeeId, companyId, payload, actor) {
    const { changeType, changes = {}, exit = null } = payload;
    validateChangeValues(changeType, changes);
    const reason = typeof payload.reason === 'string' && payload.reason.trim() ? payload.reason.trim() : null;

    const today = startOfUtcDay(new Date());
    let effectiveFrom;
    let lastWorkingDay = null;
    let exitReason = null;

    if (changeType === 'EXIT') {
      if (!exit || !isValidDate(exit.lastWorkingDay) || !EXIT_REASONS.includes(exit.reason)) {
        throw httpError(422, 'EXIT_DETAILS_REQUIRED', `An exit needs exit.lastWorkingDay and exit.reason (${EXIT_REASONS.join(', ')}).`);
      }
      lastWorkingDay = startOfUtcDay(exit.lastWorkingDay);
      exitReason = exit.reason;
      effectiveFrom = new Date(lastWorkingDay.getTime() + DAY_MS);
    } else {
      if (!isValidDate(payload.effectiveFrom)) {
        throw httpError(422, 'EFFECTIVE_DATE_REQUIRED', 'effectiveFrom must be a valid date.');
      }
      effectiveFrom = startOfUtcDay(payload.effectiveFrom);
      if (effectiveFrom > today) {
        throw httpError(422, 'FUTURE_DATED_CHANGE_NOT_SUPPORTED', 'Only exits can be scheduled ahead. Record other changes on or after the day they take effect.');
      }
    }

    const { version, previous, changedFields, before, after } = await runInTransaction(async (session) => {
      const employee = await loadCompanyEmployee(employeeId, companyId, { session });
      let current = await EmploymentRecord.findOne({ employeeId: employee._id, isCurrent: true }).session(session);
      if (!current) current = await createJoiningRecord(employee, companyId, actor, session);

      if (current.lifecycleStatus === 'EXITED') {
        throw httpError(409, 'EMPLOYEE_EXITED', 'This employee has exited; no further employment changes can be recorded.');
      }
      if (effectiveFrom <= current.effectiveFrom) {
        throw httpError(
          409,
          'EFFECTIVE_DATE_NOT_AFTER_CURRENT',
          `Changes are added after the current version, effective ${dateOnly(current.effectiveFrom)}. Recorded history is never rewritten.`
        );
      }

      const next = {
        department: current.department,
        designation: current.designation,
        managerEmployeeId: current.managerEmployeeId,
        workLocation: { name: current.workLocation?.name ?? null, state: current.workLocation?.state ?? null },
        employmentType: current.employmentType,
        probationStatus: current.probationStatus,
        confirmationDate: current.confirmationDate,
        lifecycleStatus: current.lifecycleStatus,
        exit: { lastWorkingDay: null, reason: undefined },
      };
      if (has(changes, 'department')) next.department = changes.department;
      if (has(changes, 'designation')) next.designation = changes.designation.trim();
      if (has(changes, 'employmentType')) next.employmentType = changes.employmentType;
      if (has(changes, 'workLocation')) {
        next.workLocation = {
          name: changes.workLocation.name?.trim() || null,
          state: changes.workLocation.state?.trim().toUpperCase() || null,
        };
      }
      if (has(changes, 'managerEmployeeId')) {
        next.managerEmployeeId = await resolveManager(changes.managerEmployeeId, employee, companyId, session);
      }
      if (changeType === 'CONFIRMATION') {
        if (current.probationStatus === 'CONFIRMED') {
          throw httpError(409, 'ALREADY_CONFIRMED', 'Employment is already confirmed.');
        }
        next.probationStatus = 'CONFIRMED';
        next.confirmationDate = effectiveFrom;
      }
      if (changeType === 'EXIT') {
        next.lifecycleStatus = 'EXITED';
        next.exit = { lastWorkingDay, reason: exitReason };
      }

      const termsBefore = termsOf(current);
      const termsAfter = termsOf(next);
      const changed = TERM_KEYS.filter((key) => JSON.stringify(termsBefore[key]) !== JSON.stringify(termsAfter[key]));
      if (changed.length === 0) {
        throw httpError(422, 'NO_CHANGE', 'This change does not alter any employment terms.');
      }

      current.effectiveTo = new Date(effectiveFrom.getTime() - 1);
      await current.save({ session });

      const [created] = await EmploymentRecord.create([{
        employeeId: employee._id,
        companyId,
        effectiveFrom,
        changeType,
        reason,
        ...next,
        recordedBy: actor.id,
        recordedByEmail: actor.email || null,
      }], { session });

      // The Employee projection follows once the change is in effect. An exit
      // does NOT change Employee.status: payroll excludes the employee from
      // periods that start after the last working day (eligibility reads this
      // record), so an exit recorded late still pays the final period.
      if (effectiveFrom <= new Date()) {
        employee.department = created.department;
        employee.position = created.designation;
        if (employee.isModified()) await employee.save({ session });
      }

      await auditService.log({
        action: 'EMPLOYMENT_CHANGE_RECORDED',
        actorId: actor.id,
        actorEmail: actor.email,
        actorRole: actor.role,
        entityType: 'EMPLOYEE',
        entityId: employee._id,
        companyId,
        previousStatus: current.lifecycleStatus,
        newStatus: created.lifecycleStatus,
        meta: {
          changeType,
          effectiveFrom: dateOnly(effectiveFrom),
          changedFields: changed,
          before: pick(termsBefore, changed),
          after: pick(termsAfter, changed),
          previousVersionId: String(current._id),
          versionId: String(created._id),
          reason,
        },
      }, session);

      return { version: created, previous: current, changedFields: changed, before: termsBefore, after: termsAfter };
    }, { label: 'employment.change' });

    const warnings = [];
    if (effectiveFrom > new Date()) {
      warnings.push({
        code: 'SCHEDULED',
        message: `Takes effect on ${dateOnly(effectiveFrom)}. Payroll excludes the employee from periods that start after the last working day.`,
      });
    }
    const finalizedRuns = await PayrollRun.find({
      companyId,
      status: { $in: ['FINALIZED', 'DISBURSED'] },
      periodEnd: { $gte: effectiveFrom },
    }).select('periodMonth periodYear').sort({ periodYear: 1, periodMonth: 1 }).lean();
    if (finalizedRuns.length > 0) {
      warnings.push({
        code: 'FINALIZED_PERIODS_UNCHANGED',
        message: `${finalizedRuns.length} finalized payroll period(s) overlap this change. Their payslips keep the employment details frozen when they were calculated.`,
        periods: finalizedRuns.map((run) => ({ periodMonth: run.periodMonth, periodYear: run.periodYear })),
      });
    }

    return {
      version: toView(version),
      previousVersionId: String(previous._id),
      changedFields,
      before: pick(before, changedFields),
      after: pick(after, changedFields),
      warnings,
    };
  },

  /**
   * Keep employment history consistent with edits made on the employee record
   * (PUT /api/employees/:id). Runs inside that update's transaction, before
   * the employee is saved. `employee` already carries the new values.
   *
   * @returns {Promise<object|null>} summary for the audit event
   */
  async applyEmployeeRecordEdit(employee, previous, changedFields, companyId, actor, session) {
    const touched = ['department', 'position', 'hireDate'].filter((field) => changedFields.includes(field));
    if (touched.length === 0) return null;

    const records = await EmploymentRecord.find({ employeeId: employee._id }).sort({ effectiveFrom: -1 }).session(session);

    if (records.length === 0) {
      const record = await createJoiningRecord(employee, companyId, actor, session);
      return { mode: 'JOINING_RECORDED', versionId: String(record._id), fields: touched };
    }

    if (records.length === 1 && records[0].changeType === 'JOINING') {
      const joining = records[0];
      joining.$locals.allowJoiningCorrection = true;
      if (touched.includes('department')) joining.department = employee.department;
      if (touched.includes('position')) joining.designation = employee.position;
      if (touched.includes('hireDate')) joining.effectiveFrom = startOfUtcDay(employee.hireDate);
      await joining.save({ session });
      return {
        mode: 'JOINING_CORRECTED',
        versionId: String(joining._id),
        fields: touched,
        previous: {
          ...(touched.includes('department') && { department: previous.department }),
          ...(touched.includes('position') && { designation: previous.position }),
          ...(touched.includes('hireDate') && { joiningDate: dateOnly(previous.hireDate) }),
        },
      };
    }

    if (touched.includes('hireDate')) {
      throw httpError(409, 'HIRE_DATE_LOCKED', 'The joining date cannot change after later employment changes were recorded.');
    }

    const current = records.find((record) => record.isCurrent);
    if (current.lifecycleStatus === 'EXITED') {
      throw httpError(409, 'EMPLOYEE_EXITED', 'This employee has exited; no further employment changes can be recorded.');
    }
    const today = startOfUtcDay(new Date());
    if (current.effectiveFrom >= today) {
      throw httpError(409, 'EMPLOYMENT_CHANGE_PENDING', 'An employment change already takes effect today or later. Record further changes on the employment timeline.');
    }

    current.effectiveTo = new Date(today.getTime() - 1);
    await current.save({ session });
    const changeType = touched.includes('department') ? 'TRANSFER' : 'REDESIGNATION';
    const [created] = await EmploymentRecord.create([{
      ...termsOf(current),
      managerEmployeeId: current.managerEmployeeId,
      confirmationDate: current.confirmationDate,
      exit: { lastWorkingDay: null, reason: undefined },
      employeeId: employee._id,
      companyId,
      effectiveFrom: today,
      changeType,
      department: employee.department,
      designation: employee.position,
      reason: 'Edited on the employee record',
      recordedBy: actor.id,
      recordedByEmail: actor.email || null,
    }], { session });
    return { mode: 'VERSION_APPENDED', changeType, versionId: String(created._id), fields: touched };
  },
};

export default employmentService;
