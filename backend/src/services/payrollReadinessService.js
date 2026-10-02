import mongoose from 'mongoose';
import Employee from '../models/Employee.js';
import EmploymentRecord from '../models/EmploymentRecord.js';
import EmployeeStatutoryProfile from '../models/EmployeeStatutoryProfile.js';
import EmployeeBankAccount from '../models/EmployeeBankAccount.js';
import EmployeeDocument from '../models/EmployeeDocument.js';
import CompensationVersion from '../models/CompensationVersion.js';
import CompensationChangeRequest from '../models/CompensationChangeRequest.js';
import PayrollRun from '../models/PayrollRun.js';
import { resolveEligibleEmployees } from './payrollRunService.js';
import { httpError, dateOnly, loadCompanyEmployee } from './employeeScope.js';

/**
 * payrollReadinessService — "Can this employee safely enter the next payroll?"
 *
 *   BLOCKED  payroll cannot calculate this employee for the period. These
 *            come from the SAME eligibility function payroll preflight and
 *            calculation use, so readiness and payroll can never disagree.
 *   WARNING  payroll can calculate, but something needs attention before the
 *            money moves or before a statutory filing.
 *   READY    nothing found.
 *
 * Warnings:
 *   EXIT_WITHIN_PERIOD            last working day falls inside the period (pay prorated)
 *   JOINED_WITHIN_PERIOD          joining date falls inside the period (pay prorated)
 *   PAN_MISSING                   needed for income tax (TDS) once it is calculated
 *   UAN_MISSING                   PF enrolled but no UAN (PF returns need it)
 *   ESIC_NUMBER_MISSING           ESI applies but no insurance number
 *   BANK_ACCOUNT_MISSING          no salary account on record
 *   BANK_ACCOUNT_RECENTLY_CHANGED salary account changed in the 30 days before period end
 *   BANK_ACCOUNT_SHARED           the same account is another employee's salary account
 *   DOCUMENT_EXPIRED              a verified document expired before the period
 *   COMPENSATION_COMPONENTS_NOT_APPLIED  compensation carries components payroll does not pay yet
 *   COMPENSATION_CHANGE_WITHIN_PERIOD    compensation changes mid-period (no proration yet)
 *   COMPENSATION_CHANGE_PENDING_APPROVAL a submitted pay change for this period is unapproved
 */

const RECENT_BANK_CHANGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const STATE_ORDER = { BLOCKED: 0, WARNING: 1, READY: 2 };

const ISSUE_CODES = [
  [/^HIRED_AFTER_PERIOD/, 'HIRED_AFTER_PERIOD'],
  [/^EXITED_BEFORE_PERIOD/, 'EXITED_BEFORE_PERIOD'],
  [/^No salary structure/, 'NO_SALARY_VERSION'],
  [/^MISSING_PT_JURISDICTION/, 'MISSING_PT_JURISDICTION'],
  [/^UNSUPPORTED_PT_JURISDICTION/, 'UNSUPPORTED_PT_JURISDICTION'],
  [/^EPF rule version not found/, 'EPF_RULE_MISSING'],
  [/^ESI rule version not found/, 'ESI_RULE_MISSING'],
];

const blockerFromIssue = (message) => ({
  code: ISSUE_CODES.find(([pattern]) => pattern.test(message))?.[1] || 'PAYROLL_INPUT_BLOCKED',
  message: message.replace(/^[A-Z_]+:\s*/, ''),
});

function periodBounds(periodYear, periodMonth) {
  const periodStart = new Date(Date.UTC(periodYear, periodMonth - 1, 1));
  const periodEnd = new Date(Date.UTC(periodYear, periodMonth, 1) - 1);
  return { periodYear, periodMonth, periodStart, periodEnd };
}

/** Explicit period, else the month after the latest finalized run, else this month. */
async function resolvePeriod(companyId, { periodYear, periodMonth } = {}) {
  const hasYear = periodYear !== undefined && periodYear !== null && periodYear !== '';
  const hasMonth = periodMonth !== undefined && periodMonth !== null && periodMonth !== '';
  if (hasYear !== hasMonth) throw httpError(422, 'VALIDATION_FAILED', 'Provide both periodYear and periodMonth, or neither.');
  if (hasYear) {
    const year = Number(periodYear);
    const month = Number(periodMonth);
    if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
      throw httpError(422, 'VALIDATION_FAILED', 'periodYear must be 2000–2100 and periodMonth 1–12.');
    }
    return periodBounds(year, month);
  }

  const latest = await PayrollRun.findOne({ companyId, status: { $in: ['FINALIZED', 'DISBURSED'] } })
    .sort({ periodYear: -1, periodMonth: -1 })
    .select('periodYear periodMonth')
    .lean();
  if (latest) {
    return latest.periodMonth === 12
      ? periodBounds(latest.periodYear + 1, 1)
      : periodBounds(latest.periodYear, latest.periodMonth + 1);
  }
  const now = new Date();
  return periodBounds(now.getUTCFullYear(), now.getUTCMonth() + 1);
}

const payrollReadinessService = {
  async evaluate(companyId, { periodYear, periodMonth, employeeIds = null } = {}) {
    const period = await resolvePeriod(companyId, { periodYear, periodMonth });
    const { periodStart, periodEnd } = period;

    const { eligible, blocked, esiRule } = await resolveEligibleEmployees(companyId, periodStart, periodEnd, { employeeIds });
    const candidateIds = [...eligible.map((e) => e.employeeId), ...blocked.map((b) => b.employeeId)];

    const [employees, exits, statutoryProfiles, bankAccounts, sharedAccounts, expiredDocuments, compensationVersions, pendingChanges] = await Promise.all([
      Employee.find({ _id: { $in: candidateIds } }).select('firstName lastName department position employeeCode hireDate').lean(),
      EmploymentRecord.find({ employeeId: { $in: candidateIds }, isCurrent: true, lifecycleStatus: 'EXITED' })
        .select('employeeId exit').lean(),
      EmployeeStatutoryProfile.find({ employeeId: { $in: candidateIds }, isCurrent: true })
        .select({ employeeId: 1, 'pan.last4': 1, 'uan.last4': 1, 'esicNumber.last4': 1, 'pfMemberId.last4': 1 }).lean(),
      EmployeeBankAccount.find({ employeeId: { $in: candidateIds }, isCurrent: true })
        .select('employeeId version accountNumberBlindIndex createdAt').lean(),
      // Aggregation pipelines are not cast by Mongoose: match on a real ObjectId.
      EmployeeBankAccount.aggregate([
        { $match: { companyId: new mongoose.Types.ObjectId(String(companyId)), isCurrent: true } },
        { $group: { _id: '$accountNumberBlindIndex', employees: { $addToSet: '$employeeId' } } },
        { $match: { 'employees.1': { $exists: true } } },
      ]),
      EmployeeDocument.find({ employeeId: { $in: candidateIds }, status: 'VERIFIED', expiresOn: { $ne: null, $lt: periodStart } })
        .select('employeeId title expiresOn').lean(),
      CompensationVersion.find({ employeeId: { $in: candidateIds } })
        .select('employeeId effectiveFrom isCurrent lines').lean(),
      CompensationChangeRequest.find({
        companyId, employeeId: { $in: candidateIds }, status: 'SUBMITTED', effectiveFrom: { $lte: periodEnd },
      }).select('employeeId effectiveFrom').lean(),
    ]);

    const byEmployee = (items, key = 'employeeId') => {
      const map = new Map();
      for (const item of items) {
        const id = String(item[key]);
        if (!map.has(id)) map.set(id, []);
        map.get(id).push(item);
      }
      return map;
    };
    const employeeById = new Map(employees.map((employee) => [String(employee._id), employee]));
    const exitById = new Map(exits.map((record) => [String(record.employeeId), record]));
    const statutoryById = new Map(statutoryProfiles.map((profile) => [String(profile.employeeId), profile]));
    const bankById = new Map(bankAccounts.map((account) => [String(account.employeeId), account]));
    const sharedByIndex = new Map(sharedAccounts.map((group) => [group._id, group.employees.length]));
    const documentsById = byEmployee(expiredDocuments);
    const currentCompensation = new Map(
      compensationVersions.filter((version) => version.isCurrent).map((version) => [String(version.employeeId), version])
    );
    const compensationStartingInPeriod = new Map(
      compensationVersions
        .filter((version) => version.effectiveFrom > periodStart && version.effectiveFrom <= periodEnd)
        .map((version) => [String(version.employeeId), version])
    );
    const pendingChangesById = byEmployee(pendingChanges);
    const salaryById = new Map(eligible.map((e) => [e.employeeId, e.salary]));
    const blockedById = new Map(blocked.map((b) => [b.employeeId, b]));

    const results = candidateIds.map((employeeId) => {
      const employee = employeeById.get(employeeId);
      const blockers = (blockedById.get(employeeId)?.issues || []).map(blockerFromIssue);
      const warnings = [];

      const exit = exitById.get(employeeId);
      const lastWorkingDay = exit?.exit?.lastWorkingDay ? new Date(exit.exit.lastWorkingDay) : null;
      if (lastWorkingDay && lastWorkingDay >= periodStart && lastWorkingDay <= periodEnd) {
        warnings.push({
          code: 'EXIT_WITHIN_PERIOD',
          message: `Last working day ${dateOnly(lastWorkingDay)} falls in this period, so pay is prorated to the days employed. Full and final settlement is not built yet.`,
        });
      }

      const hireDate = employee && employee.hireDate ? new Date(employee.hireDate) : null;
      if (hireDate && hireDate > periodStart && hireDate <= periodEnd) {
        warnings.push({
          code: 'JOINED_WITHIN_PERIOD',
          message: `Joined on ${dateOnly(hireDate)}, so pay for this period is prorated to the days employed.`,
        });
      }

      const statutory = statutoryById.get(employeeId);
      const salary = salaryById.get(employeeId);
      if (!statutory?.pan) {
        warnings.push({
          code: 'PAN_MISSING',
          message: 'PAN is not recorded. Income tax (TDS) is not calculated yet; once it is, a missing PAN requires deduction at a higher rate (section 206AA).',
        });
      }
      if (salary?.pfEnrolled && !statutory?.uan) {
        warnings.push({ code: 'UAN_MISSING', message: 'PF is enrolled but the UAN is not recorded. PF returns (ECR) need it.' });
      }
      const esiCeiling = esiRule?.esiParams?.grossWageCeiling;
      const esiApplies = salary?.esiEnrolled && (esiCeiling == null || salary.grossMonthly <= esiCeiling);
      if (esiApplies && !statutory?.esicNumber) {
        warnings.push({ code: 'ESIC_NUMBER_MISSING', message: 'ESI applies but the ESIC insurance number is not recorded.' });
      }

      const bank = bankById.get(employeeId);
      if (!bank) {
        warnings.push({ code: 'BANK_ACCOUNT_MISSING', message: 'No salary bank account is recorded, so this employee cannot be paid by bank transfer.' });
      } else {
        if (bank.version > 1 && new Date(bank.createdAt).getTime() >= periodEnd.getTime() - RECENT_BANK_CHANGE_DAYS * DAY_MS) {
          warnings.push({
            code: 'BANK_ACCOUNT_RECENTLY_CHANGED',
            message: `The salary bank account was changed on ${dateOnly(bank.createdAt)}. Confirm the change with the employee before paying.`,
          });
        }
        const sharedCount = sharedByIndex.get(bank.accountNumberBlindIndex);
        if (sharedCount) {
          warnings.push({
            code: 'BANK_ACCOUNT_SHARED',
            message: `The same bank account is the salary account of ${sharedCount - 1} other employee(s) in this company.`,
          });
        }
      }

      for (const document of documentsById.get(employeeId) || []) {
        warnings.push({ code: 'DOCUMENT_EXPIRED', message: `${document.title} expired on ${dateOnly(document.expiresOn)}.` });
      }

      const compensation = currentCompensation.get(employeeId);
      const notApplied = (compensation?.lines || []).filter(
        (line) => line.payrollApplication === 'NOT_APPLIED_YET'
          && line.recurrence !== 'RECURRING'
          && line.amountMonthly > 0
      );
      if (notApplied.length > 0) {
        warnings.push({
          code: 'COMPENSATION_COMPONENTS_NOT_APPLIED',
          message: `${notApplied.map((line) => line.name).join(', ')} count towards CTC, but payroll does not pay or deduct them yet.`,
        });
      }

      const startingInPeriod = compensationStartingInPeriod.get(employeeId);
      if (startingInPeriod) {
        warnings.push({
          code: 'COMPENSATION_CHANGE_WITHIN_PERIOD',
          message: `Compensation changes on ${dateOnly(startingInPeriod.effectiveFrom)}, inside this period. The whole month is calculated at the new rate, because proration is not built yet.`,
        });
      }

      for (const pending of pendingChangesById.get(employeeId) || []) {
        warnings.push({
          code: 'COMPENSATION_CHANGE_PENDING_APPROVAL',
          message: `A compensation change effective ${dateOnly(pending.effectiveFrom)} is waiting for approval. This period is calculated on the current compensation until it is approved.`,
        });
      }

      const state = blockers.length ? 'BLOCKED' : warnings.length ? 'WARNING' : 'READY';
      return {
        employeeId,
        name: employee ? `${employee.firstName} ${employee.lastName}` : blockedById.get(employeeId)?.name,
        employeeCode: employee?.employeeCode || null,
        department: employee?.department || null,
        designation: employee?.position || null,
        state,
        blockers,
        warnings,
      };
    });

    results.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || String(a.name).localeCompare(String(b.name)));

    return {
      period,
      summary: {
        total: results.length,
        ready: results.filter((r) => r.state === 'READY').length,
        warning: results.filter((r) => r.state === 'WARNING').length,
        blocked: results.filter((r) => r.state === 'BLOCKED').length,
      },
      employees: results,
    };
  },

  async forEmployee(employeeId, companyId, options = {}) {
    const employee = await loadCompanyEmployee(employeeId, companyId, { lean: true });
    const result = await this.evaluate(companyId, { ...options, employeeIds: [employee._id] });
    if (result.employees[0]) return { period: result.period, readiness: result.employees[0] };

    // Not a payroll candidate at all (inactive status).
    const exit = await EmploymentRecord.findOne({ employeeId: employee._id, isCurrent: true, lifecycleStatus: 'EXITED' }).lean();
    const readiness = {
      employeeId: String(employee._id),
      name: `${employee.firstName} ${employee.lastName}`,
      employeeCode: employee.employeeCode || null,
      department: employee.department,
      designation: employee.position,
      state: 'BLOCKED',
      blockers: [{
        code: 'NOT_ACTIVE',
        message: `Employment status is "${employee.status}". Only active and on-leave employees are included in payroll.` +
          (exit ? ` The employee exited; last working day ${dateOnly(exit.exit?.lastWorkingDay)}.` : ''),
      }],
      warnings: [],
    };
    return { period: result.period, readiness };
  },
};

export default payrollReadinessService;
