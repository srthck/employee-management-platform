/**
 * Phase 12 data migration for databases created before the hardening pass.
 *
 * Usage:
 *   npm run migrate:dry-run   report what would change, change nothing
 *   npm run migrate           apply
 *
 * Steps (each safe to re-run):
 *   1. payrollruns       replace the full unique period index with the partial
 *                        one that ignores CANCELLED runs; replace the
 *                        non-sparse idempotencyKey index with the sparse one
 *   2. employees         backfill soft-delete fields; replace the global unique
 *                        email and employeeCode indexes with per-company ones
 *                        (code uniqueness applies only when a code is set;
 *                        aborts that step if a company has duplicates)
 *   3. salarystructures  backfill isCurrent; build the one-open-version index
 *                        (aborts that step if an employee has two open versions)
 *   4. employeeaccounts  backfill companyId from the employee record
 *   5. employmentrecords create the JOINING version for employees that have
 *                        no employment history yet (Wave 2)
 *   6. compensation      seed each company's component catalogue and record a
 *                        compensation version for every existing salary version
 *   7. compensation      record a new component version wherever Wave 3.5
 *                        changed what payroll does with it (recurring
 *                        voluntary deductions and employer contributions)
 *   8. idempotency       drop the old TTL indexes (one expired every record; the
 *                        replacement expires only COMPLETED ones, counted from
 *                        completion) and set completedAt on older COMPLETED records
 *   9. everything else   build any missing schema indexes
 *
 * Audit records are never rewritten. Events recorded before companyId existed
 * stay unscoped (and keep verifying); they are not visible through the
 * company-scoped audit API.
 *
 * Exit code 1 when a step had to be skipped because data needs human review.
 */

import mongoose from 'mongoose';
import config from '../src/config/environment.js';
import Admin from '../src/models/Admin.js';
import AuditLog from '../src/models/AuditLog.js';
import Company from '../src/models/Company.js';
import IdempotencyRecord, { LEGACY_IDEMPOTENCY_TTL_INDEXES } from '../src/models/IdempotencyRecord.js';
import ComplianceRuleVersion from '../src/models/ComplianceRuleVersion.js';
import Employee from '../src/models/Employee.js';
import EmployeeAccount from '../src/models/EmployeeAccount.js';
import EmployeeBankAccount from '../src/models/EmployeeBankAccount.js';
import EmployeeDocument from '../src/models/EmployeeDocument.js';
import EmployeeStatutoryProfile from '../src/models/EmployeeStatutoryProfile.js';
import EmploymentRecord from '../src/models/EmploymentRecord.js';
import CompensationComponent from '../src/models/CompensationComponent.js';
import CompensationVersion from '../src/models/CompensationVersion.js';
import CompensationChangeRequest from '../src/models/CompensationChangeRequest.js';
import { backfillCompensation } from './lib/backfillCompensation.mjs';
import { refreshPayrollApplication } from './lib/refreshPayrollApplication.mjs';
import PayrollRun from '../src/models/PayrollRun.js';
import PayrollSnapshot from '../src/models/PayrollSnapshot.js';
import PayrollStagingResult from '../src/models/PayrollStagingResult.js';
import SalaryStructure from '../src/models/SalaryStructure.js';

const dryRun = process.argv.includes('--dry-run');
const problems = [];

const log = (message) => console.log(`${dryRun ? '[dry-run] ' : ''}${message}`);

async function indexNames(model) {
  try {
    return (await model.collection.indexes()).map((index) => ({
      name: index.name,
      unique: Boolean(index.unique),
      sparse: Boolean(index.sparse),
    }));
  } catch (err) {
    if (err.codeName === 'NamespaceNotFound' || err.code === 26) return [];
    throw err;
  }
}

async function dropIndexIfPresent(model, name) {
  const indexes = await indexNames(model);
  if (!indexes.some((index) => index.name === name)) return;
  log(`${model.collection.collectionName}: drop index ${name}`);
  if (!dryRun) await model.collection.dropIndex(name);
}

async function buildIndexes(model) {
  log(`${model.collection.collectionName}: build schema indexes`);
  if (!dryRun) await model.createIndexes();
}

async function updateMany(model, filter, update, description) {
  const count = await model.collection.countDocuments(filter);
  if (count === 0) return;
  log(`${model.collection.collectionName}: ${description} (${count} document(s))`);
  if (!dryRun) await model.collection.updateMany(filter, update);
}

async function migratePayrollRuns() {
  await dropIndexIfPresent(PayrollRun, 'unique_company_period');
  // Older schemas declared idempotencyKey twice; the non-sparse copy blocks
  // the intended sparse index from being built.
  const idempotencyIndex = (await indexNames(PayrollRun)).find((index) => index.name === 'idempotencyKey_1');
  if (idempotencyIndex && !idempotencyIndex.sparse) await dropIndexIfPresent(PayrollRun, 'idempotencyKey_1');
  await buildIndexes(PayrollRun);
}

async function migrateEmployees() {
  await updateMany(
    Employee,
    { isDeleted: { $exists: false } },
    { $set: { isDeleted: false, deletedAt: null, deletedBy: null, deletionReason: null } },
    'backfill soft-delete fields'
  );

  const duplicates = await Employee.collection.aggregate([
    { $group: { _id: { createdBy: '$createdBy', email: '$email' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();
  if (duplicates.length > 0) {
    problems.push(`employees: ${duplicates.length} duplicate (company, email) pair(s); per-company email index not built.`);
    return;
  }

  const codeDuplicates = await Employee.collection.aggregate([
    { $match: { employeeCode: { $type: 'string' } } },
    { $group: { _id: { createdBy: '$createdBy', employeeCode: '$employeeCode' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();
  if (codeDuplicates.length > 0) {
    problems.push(`employees: ${codeDuplicates.length} duplicate (company, employeeCode) pair(s); per-company code index not built.`);
    return;
  }

  const existing = await indexNames(Employee);
  if (existing.some((index) => index.name === 'email_1' && index.unique)) {
    await dropIndexIfPresent(Employee, 'email_1');
  }
  // A global, non-partial unique code index makes every employee without a
  // code collide on null. It is replaced by a per-company partial index.
  if (existing.some((index) => index.name === 'employeeCode_1' && index.unique)) {
    await dropIndexIfPresent(Employee, 'employeeCode_1');
  }
  await buildIndexes(Employee);
}

async function migrateSalaryStructures() {
  await updateMany(SalaryStructure, { effectiveTo: null, isCurrent: { $ne: true } }, { $set: { isCurrent: true } }, 'mark open versions current');
  await updateMany(SalaryStructure, { effectiveTo: { $ne: null }, isCurrent: { $ne: false } }, { $set: { isCurrent: false } }, 'mark closed versions not current');

  const duplicates = await SalaryStructure.collection.aggregate([
    { $match: { effectiveTo: null } },
    { $group: { _id: '$employeeId', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();
  if (duplicates.length > 0) {
    problems.push(
      `salarystructures: ${duplicates.length} employee(s) have more than one open salary version ` +
      `(${duplicates.slice(0, 5).map((d) => d._id).join(', ')}); one-current-version index not built.`
    );
    return;
  }
  await buildIndexes(SalaryStructure);
}

async function migrateCompanies() {
  // Workspace owners (admins without companyId) predating the Company entity.
  const owners = await Admin.collection.find({ companyId: { $in: [null] } }).project({ name: 1 }).toArray();
  const existing = new Set((await Company.collection.find({}, { projection: { _id: 1 } }).toArray()).map((c) => String(c._id)));
  const missing = owners.filter((owner) => !existing.has(String(owner._id)));
  if (missing.length === 0) return;
  log(`companies: create company records for existing workspaces (${missing.length})`);
  if (dryRun) return;
  const now = new Date();
  await Company.collection.insertMany(missing.map((owner) => ({
    _id: owner._id,
    ownerId: owner._id,
    name: `${owner.name}'s company`,
    settings: { approvalMode: 'single', varianceThresholdPercent: 10, blockFinalizationOnUnexplainedVariance: true },
    createdAt: now,
    updatedAt: now,
  })));
}

async function migrateEmployeeAccounts() {
  const accounts = await EmployeeAccount.collection.find({ companyId: { $in: [null] } }).project({ employee: 1 }).toArray();
  if (accounts.length === 0) return;
  log(`employeeaccounts: backfill companyId (${accounts.length} account(s))`);
  if (dryRun) return;
  for (const account of accounts) {
    const employee = await Employee.collection.findOne({ _id: account.employee }, { projection: { createdBy: 1 } });
    if (!employee) {
      problems.push(`employeeaccounts: account ${account._id} references missing employee ${account.employee}.`);
      continue;
    }
    await EmployeeAccount.collection.updateOne({ _id: account._id }, { $set: { companyId: employee.createdBy } });
  }
}

async function migrateEmploymentRecords() {
  const withHistory = await EmploymentRecord.collection.distinct('employeeId');
  const missing = await Employee.collection
    .find({ _id: { $nin: withHistory } })
    .project({ createdBy: 1, department: 1, position: 1, hireDate: 1 })
    .toArray();
  if (missing.length === 0) return;

  const incomplete = missing.filter((employee) => !employee.hireDate || !employee.department || !employee.position);
  if (incomplete.length > 0) {
    problems.push(`employmentrecords: ${incomplete.length} employee(s) lack hireDate, department or position; no JOINING version created for them.`);
  }
  const complete = missing.filter((employee) => !incomplete.includes(employee));
  if (complete.length === 0) return;

  log(`employmentrecords: create JOINING versions from employee records (${complete.length})`);
  if (dryRun) return;
  const now = new Date();
  const systemActor = new mongoose.Types.ObjectId('000000000000000000000000');
  await EmploymentRecord.collection.insertMany(complete.map((employee) => {
    const hire = new Date(employee.hireDate);
    return {
      employeeId: employee._id,
      companyId: employee.createdBy,
      effectiveFrom: new Date(Date.UTC(hire.getUTCFullYear(), hire.getUTCMonth(), hire.getUTCDate())),
      effectiveTo: null,
      isCurrent: true,
      changeType: 'JOINING',
      reason: 'Joining (recorded by migration from the employee record)',
      department: employee.department,
      designation: employee.position,
      managerEmployeeId: null,
      workLocation: { name: null, state: null },
      employmentType: 'FULL_TIME',
      probationStatus: 'NOT_APPLICABLE',
      confirmationDate: null,
      lifecycleStatus: 'ACTIVE',
      exit: { lastWorkingDay: null },
      recordedBy: systemActor,
      recordedByEmail: null,
      createdAt: now,
      updatedAt: now,
    };
  }));
}

async function main() {
  if (!config.mongoUri) throw new Error('MONGO_URI is not configured.');
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 5000, autoIndex: false });
  log(`Connected to ${mongoose.connection.name}`);

  await migratePayrollRuns();
  await migrateEmployees();
  await migrateSalaryStructures();
  await migrateCompanies();
  await migrateEmployeeAccounts();
  await buildIndexes(EmploymentRecord);
  await migrateEmploymentRecords();
  for (const model of [CompensationComponent, CompensationVersion, CompensationChangeRequest]) {
    await buildIndexes(model);
  }
  await backfillCompensation({ dryRun, log, problems });
  await refreshPayrollApplication({ dryRun, log });
  // The earlier TTL indexes expired records the system still needs: 'idempotency_ttl' every record (including the ones that
  // stop a retry from re-running work whose outcome is unknown or that already committed), 'idempotency_ttl_completed'
  // COMPLETED records counted from creation rather than completion. The replacement (built below) expires COMPLETED records
  // counted from completedAt. Dropping an index removes no document. COMPLETED records written before completedAt existed get
  // completedAt = createdAt, so they keep the retention they had.
  for (const name of LEGACY_IDEMPOTENCY_TTL_INDEXES) await dropIndexIfPresent(IdempotencyRecord, name);
  await updateMany(
    IdempotencyRecord,
    { status: 'COMPLETED', completedAt: null }, // matches a missing field as well as null
    [{ $set: { completedAt: '$createdAt' } }],
    'set completedAt on COMPLETED records written before the field existed'
  );
  for (const model of [
    Admin, AuditLog, Company, ComplianceRuleVersion, EmployeeAccount, IdempotencyRecord, PayrollSnapshot, PayrollStagingResult,
    EmployeeStatutoryProfile, EmployeeBankAccount, EmployeeDocument,
  ]) {
    await buildIndexes(model);
  }

  if (problems.length > 0) {
    console.error('\nSteps skipped — data needs review:');
    problems.forEach((problem) => console.error(`  - ${problem}`));
    process.exitCode = 1;
  } else {
    log('\nMigration complete.');
  }
}

main()
  .catch((err) => {
    console.error(`Migration failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
