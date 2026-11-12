/**
 * test_phase12.js — Phase 12: Hardening + differentiators, end to end over HTTP.
 *
 * Runner: node:test (Node >= 18 built-in)
 * Run:    node --test test_phase12.js
 *
 * Real Express app on an ephemeral port, real MongoDB, isolated database
 * (PHASE12_MONGO_URI, default payguard_phase12_test), dropped before and after.
 *
 * Covers the audit report's critical/high findings and the new capabilities:
 *   - tenant isolation, soft delete + audit, mass assignment, regex/operator injection
 *   - session revocation, login lockout
 *   - salary revision bug fix, one-current-salary index, retroactive-revision warning
 *   - statutory rounding and month-specific professional tax
 *   - finalize endpoint materializes + verifies snapshots
 *   - explainable payslips, payroll register, variance report, employee self-service
 *   - audit chain under concurrent writes, append-only and immutability guards
 *   - cancelled-run history retained, automatic stuck-run recovery
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'phase12-test-secret-that-is-long-enough';

const TEST_DB_URI = process.env.PHASE12_MONGO_URI || 'mongodb://127.0.0.1:27018/payguard_phase12_test?replicaSet=rs0';

// Imported after the environment is set: configuration is read at import time.
const { default: app } = await import('./src/app.js');
const { default: Admin } = await import('./src/models/Admin.js');
const { default: Employee } = await import('./src/models/Employee.js');
const { default: EmployeeAccount } = await import('./src/models/EmployeeAccount.js');
const { default: SalaryStructure } = await import('./src/models/SalaryStructure.js');
const { default: ComplianceRuleVersion } = await import('./src/models/ComplianceRuleVersion.js');
const { default: PayrollRun } = await import('./src/models/PayrollRun.js');
const { default: PayrollStagingResult } = await import('./src/models/PayrollStagingResult.js');
const { default: PayrollSnapshot } = await import('./src/models/PayrollSnapshot.js');
const { default: AuditLog } = await import('./src/models/AuditLog.js');
const { default: auditService } = await import('./src/services/auditService.js');
const { default: payrollRunService } = await import('./src/services/payrollRunService.js');
const { default: payrollRunRepository } = await import('./src/repositories/payrollRunRepository.js');
const { default: complianceCalculationService } = await import('./src/services/complianceCalculationService.js');
const { runInTransaction } = await import('./src/utils/transaction.js');

const MODELS = [Admin, Employee, EmployeeAccount, SalaryStructure, ComplianceRuleVersion, PayrollRun, PayrollStagingResult, PayrollSnapshot, AuditLog];
const PASSWORD = 'StrongPass123';

let server;
let baseUrl;

/** Minimal HTTP client with a per-client cookie jar. */
function createClient() {
  let cookie = '';
  const request = async (method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(method !== 'GET' && { 'Idempotency-Key': `test-${globalThis.crypto.randomUUID()}` }), ...(cookie && { cookie }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: response.status, body: json, headers: response.headers };
  };
  return {
    get: (path) => request('GET', path),
    post: (path, body = {}) => request('POST', path, body),
    put: (path, body = {}) => request('PUT', path, body),
    patch: (path, body = {}) => request('PATCH', path, body),
    del: (path, body) => request('DELETE', path, body),
  };
}

const employeePayload = (overrides = {}) => ({
  firstName: 'Asha',
  lastName: 'Verma',
  email: 'asha.verma@example.com',
  department: 'Engineering',
  position: 'Engineer',
  salary: 20000,
  hireDate: '2024-01-15',
  status: 'active',
  ...overrides,
});

const salaryPayload = (effectiveFrom, components, overrides = {}) => ({
  effectiveFrom,
  components,
  workState: 'MH',
  pfEnrolled: true,
  esiEnrolled: true,
  ptEnrolled: true,
  ...overrides,
});

before(async () => {
  await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 5000 });
  await mongoose.connection.dropDatabase();
  await Promise.all(MODELS.map((model) => model.createIndexes()));

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  try {
    if (server) {
      // fetch keeps connections alive; close them so server.close() resolves.
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
    }
  } finally {
    // Always release the connection, or a failed setup leaves the process hanging.
    await mongoose.disconnect();
  }
});

describe('Phase 12 — hardened payroll platform', () => {
  const adminA = createClient();
  const adminB = createClient();
  const state = {};

  test('setup: two independent company workspaces and statutory rules', async () => {
    const a = await adminA.post('/auth/register', { name: 'Admin Alpha', email: 'alpha@example.com', password: PASSWORD, confirmPassword: PASSWORD });
    const b = await adminB.post('/auth/register', { name: 'Admin Bravo', email: 'bravo@example.com', password: PASSWORD, confirmPassword: PASSWORD });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(JSON.stringify(a.body).includes('eyJ'), false, 'session token must not appear in the body');
    state.companyA = a.body.data.user.companyId;
    state.companyB = b.body.data.user.companyId;
    assert.notEqual(state.companyA, state.companyB);

    const createdBy = new mongoose.Types.ObjectId();
    await ComplianceRuleVersion.create([
      {
        ruleType: 'EPF', jurisdiction: 'IN', effectiveFrom: new Date('2014-09-01'), createdBy,
        description: 'EPF test rule',
        epfParams: { employeeContributionRate: 0.12, employerContributionRate: 0.12, wageCapForContribution: 15000, epsRate: 0.0833, roundingMode: 'NEAREST_RUPEE' },
      },
      {
        ruleType: 'ESI', jurisdiction: 'IN', effectiveFrom: new Date('2019-07-01'), createdBy,
        description: 'ESI test rule',
        esiParams: { employeeContributionRate: 0.0075, employerContributionRate: 0.0325, grossWageCeiling: 21000, roundingMode: 'CEIL_RUPEE' },
      },
      {
        ruleType: 'PT', jurisdiction: 'MH', effectiveFrom: new Date('2000-01-01'), createdBy,
        description: 'MH PT test rule',
        ptSlabs: [
          { upTo: 7500, monthlyTax: 0 },
          { upTo: 10000, monthlyTax: 175 },
          { upTo: null, monthlyTax: 200, monthOverrides: [{ month: 2, monthlyTax: 300 }] },
        ],
      },
    ]);
  });

  // ─── Platform security ────────────────────────────────────────────────────

  test('responses carry a request ID and security headers', async () => {
    const res = await createClient().get('/health');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('x-request-id'), /^[A-Za-z0-9._-]{8,}$/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  test('MongoDB operator injection is rejected before reaching a query', async () => {
    const res = await createClient().post('/auth/login', { email: { $gt: '' }, password: 'anything' });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /Invalid key/);
  });

  test('protected routes require a session', async () => {
    const res = await createClient().get('/employees');
    assert.equal(res.status, 401);
  });

  // ─── Employees: tenancy, mass assignment, search, soft delete ─────────────

  test('employees are created inside the caller company only', async () => {
    const e1 = await adminA.post('/employees', employeePayload());
    const e2 = await adminA.post('/employees', employeePayload({ firstName: 'Ravi', lastName: 'Kumar', email: 'ravi.kumar@example.com' }));
    const archived = await adminA.post('/employees', employeePayload({ firstName: 'Meera', lastName: 'Das', email: 'meera.das@example.com' }));
    assert.equal(e1.status, 201);
    assert.equal(e2.status, 201);
    assert.equal(archived.status, 201);
    state.e1 = e1.body.data.employee._id;
    state.e2 = e2.body.data.employee._id;
    state.archivedEmployee = archived.body.data.employee._id;

    // The same person may work for another company.
    const sameEmailOtherCompany = await adminB.post('/employees', employeePayload());
    assert.equal(sameEmailOtherCompany.status, 201);
  });

  test('employee codes are unique per company and optional', async () => {
    const base = { lastName: 'Code', department: 'Other', position: 'Tester', salary: 1, hireDate: new Date('2024-01-01') };
    await Employee.create({ ...base, firstName: 'Coded', email: 'coded.a@example.com', employeeCode: 'EMP-001', createdBy: state.companyA });
    // Same code in another company is allowed.
    await Employee.create({ ...base, firstName: 'Coded', email: 'coded.b@example.com', employeeCode: 'EMP-001', createdBy: state.companyB });
    // Same code twice in one company is not.
    await assert.rejects(
      Employee.create({ ...base, firstName: 'Clash', email: 'clash.a@example.com', employeeCode: 'EMP-001', createdBy: state.companyA }),
      (err) => err.code === 11000
    );
    // Employees without a code never collide (the legacy global index made them collide on null).
    const first = await adminB.post('/employees', employeePayload({ firstName: 'Nocode', lastName: 'One', email: 'nocode.one@example.com' }));
    const second = await adminB.post('/employees', employeePayload({ firstName: 'Nocode', lastName: 'Two', email: 'nocode.two@example.com' }));
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    await Employee.collection.deleteMany({ email: { $in: ['coded.a@example.com', 'coded.b@example.com', 'nocode.one@example.com', 'nocode.two@example.com'] } });
  });

  test('another company cannot list, read, update, archive or see salary of an employee (404, not 403)', async () => {
    const list = await adminB.get('/employees?limit=100');
    assert.equal(list.status, 200);
    assert.ok(list.body.data.employees.every((employee) => employee.createdBy === state.companyB));

    assert.equal((await adminB.get(`/employees/${state.e1}`)).status, 404);
    assert.equal((await adminB.put(`/employees/${state.e1}`, { position: 'Hijacked' })).status, 404);
    assert.equal((await adminB.del(`/employees/${state.e1}`)).status, 404);
    assert.equal((await adminB.get(`/employees/${state.e1}/salary/current`)).status, 404);
    assert.equal((await adminB.post('/employee-accounts', { employeeId: state.e1, password: 'EmployeePass1' })).status, 404);

    const stats = await adminB.get('/employees/stats');
    assert.equal(stats.body.data.stats.total, 1);
  });

  test('profile updates reject protected fields and ignore non-allowlisted fields', async () => {
    const protectedAttempt = await adminA.put(`/employees/${state.e1}`, { createdBy: state.companyB });
    assert.equal(protectedAttempt.status, 422);

    const smuggled = await adminA.put(`/employees/${state.e1}`, { position: 'Senior Engineer', isAdmin: true, companyId: state.companyB });
    assert.equal(smuggled.status, 200);
    const stored = await Employee.findById(state.e1).lean();
    assert.equal(stored.position, 'Senior Engineer');
    assert.equal(stored.isAdmin, undefined);
    assert.equal(String(stored.createdBy), state.companyA);
  });

  test('search input is treated literally (no regex injection or ReDoS)', async () => {
    const res = await adminA.get(`/employees?search=${encodeURIComponent('(a+)+$')}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.employees.length, 0);
  });

  test('archiving is a soft delete with an audit event, and the email stays reserved', async () => {
    const archived = await adminA.del(`/employees/${state.archivedEmployee}`, { reason: 'Left the company' });
    assert.equal(archived.status, 200);

    assert.equal((await adminA.get(`/employees/${state.archivedEmployee}`)).status, 404);
    const stillStored = await Employee.findOne({ _id: state.archivedEmployee, isDeleted: true }).lean();
    assert.ok(stillStored, 'the record must still exist');
    assert.equal(stillStored.deletionReason, 'Left the company');
    assert.equal(stillStored.status, 'inactive');

    const archivedList = await adminA.get('/employees?archived=true');
    assert.deepEqual(archivedList.body.data.employees.map((e) => e._id), [state.archivedEmployee]);

    const event = await AuditLog.findOne({ action: 'EMPLOYEE_DELETED', entityId: state.archivedEmployee }).lean();
    assert.ok(event, 'EMPLOYEE_DELETED must be audited');
    assert.equal(String(event.companyId), state.companyA);
    assert.equal(event.meta.mode, 'SOFT_DELETE');

    const duplicate = await adminA.post('/employees', employeePayload({ firstName: 'Meera', lastName: 'Das', email: 'meera.das@example.com' }));
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.body.message, /archived/i);

    const restored = await adminA.post(`/employees/${state.archivedEmployee}/restore`);
    assert.equal(restored.status, 200);
    assert.equal(restored.body.data.employee.status, 'inactive');
  });

  test('audit logs are scoped to the caller company', async () => {
    const res = await adminB.get('/audit/logs?limit=100');
    assert.equal(res.status, 200);
    assert.ok(res.body.data.logs.length > 0);
    assert.ok(res.body.data.logs.every((log) => log.companyId === state.companyB));
  });

  // ─── Salary ────────────────────────────────────────────────────────────────

  test('salary revisions: workState is required, and a second revision succeeds', async () => {
    const missingState = await adminA.post(`/employees/${state.e2}/salary`, {
      effectiveFrom: '2026-01-01',
      components: { basic: 12000 },
    });
    assert.ok([400, 422].includes(missingState.status));

    const v1 = await adminA.post(`/employees/${state.e2}/salary`, salaryPayload('2026-01-01', { basic: 12000, hra: 4000, specialAllowance: 4001 }));
    assert.equal(v1.status, 201);

    // Previously the open-ended current version "covered" every later date and
    // this returned 409, so no employee could ever get a second revision.
    const v2 = await adminA.post(`/employees/${state.e2}/salary`, salaryPayload('2026-06-01', { basic: 13000, hra: 4500, specialAllowance: 4001 }));
    assert.equal(v2.status, 201);

    const history = await adminA.get(`/employees/${state.e2}/salary`);
    assert.equal(history.body.data.salaries.length, 2);
    assert.equal(history.body.data.salaries.filter((s) => s.effectiveTo === null).length, 1);

    const e1v1 = await adminA.post(`/employees/${state.e1}/salary`, salaryPayload('2026-01-01', { basic: 12000, hra: 4000, specialAllowance: 4000 }));
    assert.equal(e1v1.status, 201);
    assert.deepEqual(e1v1.body.data.warnings, []);
  });

  test('the database refuses a second open-ended salary version', async () => {
    await assert.rejects(
      SalaryStructure.create({
        employeeId: state.e2,
        effectiveFrom: new Date('2027-01-01'),
        components: { basic: 1 },
        workState: 'MH',
        createdBy: state.companyA,
      }),
      (err) => err.code === 11000
    );
  });

  // ─── Statutory calculation ────────────────────────────────────────────────

  test('statutory rounding modes and month-specific professional tax', () => {
    const epf = complianceCalculationService.calculateEpf({
      pfWage: 12000,
      pfEnrolled: true,
      epfRule: { employeeContributionRate: 0.12, employerContributionRate: 0.12, wageCapForContribution: 15000, epsRate: 0.0833, roundingMode: 'NEAREST_RUPEE' },
    });
    assert.equal(epf.employeeEpf, 1440);
    assert.equal(epf.epsContribution, 1000); // 999.6 → nearest rupee

    const esi = complianceCalculationService.calculateEsi({
      grossMonthly: 20001,
      esiEnrolled: true,
      esiRule: { employeeContributionRate: 0.0075, employerContributionRate: 0.0325, grossWageCeiling: 21000, roundingMode: 'CEIL_RUPEE' },
    });
    assert.equal(esi.employeeEsi, 151); // 150.0075 → next rupee
    assert.equal(esi.employerEsi, 651);

    const slabs = [{ upTo: null, monthlyTax: 200, monthOverrides: [{ month: 2, monthlyTax: 300 }] }];
    assert.equal(complianceCalculationService.calculatePt({ grossMonthly: 20000, ptSlabs: slabs, ptEnrolled: true, periodMonth: 2 }).pt, 300);
    assert.equal(complianceCalculationService.calculatePt({ grossMonthly: 20000, ptSlabs: slabs, ptEnrolled: true, periodMonth: 3 }).pt, 200);

    // Floating point: 1.005 must round to 1.01, not 1.00.
    const paise = complianceCalculationService.calculateEsi({
      grossMonthly: 134,
      esiEnrolled: true,
      esiRule: { employeeContributionRate: 0.0075, employerContributionRate: 0, grossWageCeiling: 21000 },
    });
    assert.equal(paise.employeeEsi, 1.01);
  });

  // ─── Payroll lifecycle ────────────────────────────────────────────────────

  test('February run: process, review and finalize through the /finalize endpoint', async () => {
    const created = await adminA.post('/payroll-runs', { periodMonth: 2, periodYear: 2026 });
    assert.equal(created.status, 201);
    state.febRun = created.body.data.run._id;

    const preflight = await adminA.post(`/payroll-runs/${state.febRun}/preflight`);
    assert.equal(preflight.status, 200);
    assert.equal(preflight.body.data.canProcess, true);
    // Restored-but-inactive and never-salaried employees are not paid.
    assert.equal(preflight.body.data.eligibleEmployees.length, 2);

    const processed = await adminA.post(`/payroll-runs/${state.febRun}/process`);
    assert.equal(processed.status, 200);
    assert.equal(processed.body.data.run.status, 'READY_FOR_FINALIZATION');

    const register = await adminA.get(`/payroll-runs/${state.febRun}/register`);
    assert.equal(register.status, 200);
    assert.equal(register.body.data.source, 'STAGING');
    assert.equal(register.body.data.totals.headcount, 2);
    assert.equal(register.body.data.totals.gross, 40001);
    assert.equal((await adminB.get(`/payroll-runs/${state.febRun}/register`)).status, 404);

    const variance = await adminA.get(`/payroll-runs/${state.febRun}/variance`);
    assert.equal(variance.status, 200);
    assert.equal(variance.body.data.baseline, null);
    assert.match(variance.body.data.note, /No earlier finalized run/);

    // The legacy endpoint used to flip the status without any snapshots.
    const finalized = await adminA.post(`/payroll-runs/${state.febRun}/finalize`);
    assert.equal(finalized.status, 200);
    assert.equal(finalized.body.data.run.status, 'FINALIZED');
    assert.equal(await PayrollSnapshot.countDocuments({ payrollRunId: state.febRun, snapshotStatus: 'FINALIZED' }), 2);

    const snapshots = await adminA.get(`/payroll-runs/${state.febRun}/snapshots`);
    state.e1Snapshot = snapshots.body.data.snapshots.find((s) => String(s.employeeSnapshot.employeeId) === state.e1)._id;
    state.e2Snapshot = snapshots.body.data.snapshots.find((s) => String(s.employeeSnapshot.employeeId) === state.e2)._id;
  });

  test('F-C01: repeating finished financial operations with a FRESH key (what a client sees after its key expired) has no second effect: business guards hold on their own', async () => {
    // Every request below carries a new Idempotency-Key (the test client sends one per request), so the idempotency record
    // of the original operation plays no part: only the business-level guard can stop a second effect.
    const periodRuns = () => PayrollRun.countDocuments({ companyId: state.companyA, periodMonth: 2, periodYear: 2026 });
    const finalizedSnapshots = () => PayrollSnapshot.countDocuments({ payrollRunId: state.febRun, snapshotStatus: 'FINALIZED' });
    const runsBefore = await periodRuns();
    const snapshotsBefore = await finalizedSnapshots();
    const clientError = (res) => res.status >= 400 && res.status < 500;

    const recreate = await adminA.post('/payroll-runs', { periodMonth: 2, periodYear: 2026 });
    assert.ok(clientError(recreate), `a second run for the period: ${recreate.status} ${JSON.stringify(recreate.body)}`);
    assert.equal(await periodRuns(), runsBefore, 'one run per period');

    for (const action of ['process', 'finalize', 'cancel']) {
      const again = await adminA.post(`/payroll-runs/${state.febRun}/${action}`);
      assert.ok(clientError(again), `${action} of a FINALIZED run: ${again.status} ${JSON.stringify(again.body)}`);
    }
    assert.equal((await PayrollRun.findById(state.febRun).lean()).status, 'FINALIZED');
    assert.equal(await finalizedSnapshots(), snapshotsBefore, 'no snapshot added or changed');

    const versionsBefore = await SalaryStructure.countDocuments({ employeeId: state.e1 });
    const revision = await adminA.post(`/employees/${state.e1}/salary`, salaryPayload('2026-01-01', { basic: 12000, hra: 4000, specialAllowance: 4000 }));
    assert.ok(clientError(revision), `the same salary revision again: ${revision.status} ${JSON.stringify(revision.body)}`);
    assert.equal(await SalaryStructure.countDocuments({ employeeId: state.e1 }), versionsBefore, 'no second salary version');
  });

  test('explained payslip: formulas, rule sources, self-checks and integrity', async () => {
    const res = await adminA.get(`/payroll-snapshots/${state.e1Snapshot}/explain`);
    assert.equal(res.status, 200);
    const { payslip } = res.body.data;

    assert.equal(payslip.totals.gross, 20000);
    assert.deepEqual(payslip.checks, { earningsMatchGross: true, deductionsMatchTotal: true, netPayMatchesFormula: true });
    assert.equal(payslip.integrity.verified, true);

    const pf = payslip.deductions.find((line) => line.code === 'EPF_EMPLOYEE');
    assert.equal(pf.amount, 1440);
    assert.match(pf.formula, /ceiling ₹15,000\.00/);
    assert.equal(pf.source.ruleType, 'EPF');
    assert.equal(pf.rateDerivedFromAmounts, false);

    const pt = payslip.deductions.find((line) => line.code === 'PT');
    assert.equal(pt.amount, 300);
    assert.match(pt.formula, /February amount/);

    assert.equal(payslip.totals.netPayBeforeTDS, 20000 - 1440 - 150 - 300);
    assert.ok(payslip.limitations.some((text) => /TDS/.test(text)));

    const e2Payslip = (await adminA.get(`/payroll-snapshots/${state.e2Snapshot}/explain`)).body.data.payslip;
    assert.equal(e2Payslip.deductions.find((line) => line.code === 'ESI_EMPLOYEE').amount, 151);

    assert.equal((await adminB.get(`/payroll-snapshots/${state.e1Snapshot}/explain`)).status, 404);
    assert.equal((await adminB.get(`/payroll-snapshots/${state.e1Snapshot}/verify`)).status, 404);
  });

  test('finalized snapshots cannot be modified or deleted through the model', async () => {
    const update = await PayrollSnapshot.updateOne({ _id: state.e1Snapshot }, { $set: { 'payrollResults.netPayBeforeTDS': 1 } });
    assert.equal(update.matchedCount, 0);
    const removal = await PayrollSnapshot.deleteOne({ _id: state.e1Snapshot });
    assert.equal(removal.deletedCount, 0);

    const run = await PayrollRun.findById(state.febRun);
    run.status = 'PROCESSING';
    await assert.rejects(run.save(), /Illegal payroll run transition/);
    assert.equal(
      await payrollRunRepository.transitionStateAtomically(state.febRun, 'FINALIZED', 'PROCESSING', {}, { actorId: state.companyA }),
      null
    );
  });

  test('March variance report explains the net pay change as an expected statutory change', async () => {
    const created = await adminA.post('/payroll-runs', { periodMonth: 3, periodYear: 2026 });
    state.marRun = created.body.data.run._id;
    assert.equal((await adminA.post(`/payroll-runs/${state.marRun}/process`)).status, 200);

    const res = await adminA.get(`/payroll-runs/${state.marRun}/variance`);
    assert.equal(res.status, 200);
    const report = res.body.data;
    assert.equal(report.baseline.periodMonth, 2);
    const flag = report.flags.find((f) => f.employeeId === state.e1 && f.code === 'PAY_CHANGE_EXPECTED');
    assert.ok(flag, 'February PT (300) → March PT (200) changes net with unchanged gross');
    assert.equal(flag.classification, 'EXPECTED');
    assert.equal(flag.severity, 'info');
    assert.deepEqual(flag.causes, ['PT_MONTH_SPECIFIC_AMOUNT']);
    assert.equal(report.counts.blocking, 0);
    assert.equal(report.totals.change.headcount, 0);
  });

  test('a salary revision inside a finalized period warns that arrears are due', async () => {
    const res = await adminA.post(`/employees/${state.e1}/salary`, salaryPayload('2026-02-01', { basic: 14000, hra: 4000, specialAllowance: 4000 }));
    assert.equal(res.status, 201);
    assert.equal(res.body.data.warnings.length, 1);
    assert.equal(res.body.data.warnings[0].code, 'RETROACTIVE_REVISION');
    assert.deepEqual(res.body.data.warnings[0].periods.map((p) => p.periodMonth), [2]);

    // The finalized payslip is unchanged.
    const payslip = (await adminA.get(`/payroll-snapshots/${state.e1Snapshot}/explain`)).body.data.payslip;
    assert.equal(payslip.totals.gross, 20000);
    assert.equal(payslip.integrity.verified, true);
  });

  // ─── Employee self-service and sessions ───────────────────────────────────

  test('employees see only their own finalized payslips', async () => {
    const account = await adminA.post('/employee-accounts', { employeeId: state.e1, password: 'EmployeePass1' });
    assert.equal(account.status, 201);

    const employee = createClient();
    const login = await employee.post('/auth/login', { email: 'asha.verma@example.com', password: 'EmployeePass1' });
    assert.equal(login.status, 200);
    assert.equal(login.body.data.user.role, 'employee');

    const list = await employee.get('/me/payslips');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data.payslips.map((p) => p.periodMonth), [2]);

    const own = await employee.get(`/me/payslips/${state.e1Snapshot}`);
    assert.equal(own.status, 200);
    assert.equal(own.body.data.payslip.employee.name, 'Asha Verma');

    assert.equal((await employee.get(`/me/payslips/${state.e2Snapshot}`)).status, 404);
    assert.equal((await employee.get('/employees')).status, 403);
    state.employeeClient = employee;
  });

  test('sign out everywhere revokes every outstanding session', async () => {
    const secondDevice = createClient();
    assert.equal((await secondDevice.post('/auth/login', { email: 'asha.verma@example.com', password: 'EmployeePass1' })).status, 200);
    assert.equal((await secondDevice.get('/auth/me')).status, 200);

    assert.equal((await state.employeeClient.post('/auth/logout-all')).status, 200);
    assert.equal((await secondDevice.get('/auth/me')).status, 401);
  });

  test('archiving an employee immediately ends their self-service access', async () => {
    const employee = createClient();
    assert.equal((await employee.post('/auth/login', { email: 'asha.verma@example.com', password: 'EmployeePass1' })).status, 200);
    assert.equal((await adminA.del(`/employees/${state.e1}`)).status, 200);
    assert.equal((await employee.get('/me/payslips')).status, 401);
    const account = await EmployeeAccount.findOne({ employee: state.e1 }).lean();
    assert.equal(account.isActive, false);
  });

  test('repeated failed logins lock the account; unknown emails get the same message', async () => {
    const admin = createClient();
    await admin.post('/auth/register', { name: 'Admin Charlie', email: 'charlie@example.com', password: PASSWORD, confirmPassword: PASSWORD });

    const attacker = createClient();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await attacker.post('/auth/login', { email: 'charlie@example.com', password: 'WrongPass123' });
      assert.equal(res.status, 401);
      assert.equal(res.body.message, 'Invalid email or password.');
    }
    const locked = await attacker.post('/auth/login', { email: 'charlie@example.com', password: PASSWORD });
    assert.equal(locked.status, 429);

    const unknown = await attacker.post('/auth/login', { email: 'nobody@example.com', password: PASSWORD });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.message, 'Invalid email or password.');
    assert.ok(await AuditLog.exists({ action: 'AUTH_ACCOUNT_LOCKED', actorEmail: 'charlie@example.com' }));
  });

  // ─── Operations ───────────────────────────────────────────────────────────

  test('cancelled runs stay as history and the period can be re-run', async () => {
    const created = await adminB.post('/payroll-runs', { periodMonth: 1, periodYear: 2026 });
    const runId = created.body.data.run._id;

    // Company B has no salaried employees, so processing fails.
    assert.equal((await adminB.post(`/payroll-runs/${runId}/process`)).status, 422);
    assert.equal((await adminB.post(`/payroll-runs/${runId}/cancel`)).status, 200);

    const again = await adminB.post('/payroll-runs', { periodMonth: 1, periodYear: 2026 });
    assert.equal(again.status, 201);
    assert.equal(await PayrollRun.countDocuments({ companyId: state.companyB, periodYear: 2026, periodMonth: 1 }), 2);
    assert.ok(await PayrollRun.exists({ _id: runId, status: 'CANCELLED' }));

    const duplicate = await adminB.post('/payroll-runs', { periodMonth: 1, periodYear: 2026 });
    assert.equal(duplicate.status, 409);
  });

  test('stuck PROCESSING runs are recovered automatically and audited as system actions', async () => {
    const created = await adminB.post('/payroll-runs', { periodMonth: 5, periodYear: 2026 });
    const runId = created.body.data.run._id;
    await payrollRunRepository.transitionStateAtomically(runId, 'DRAFT', 'PROCESSING', {}, { actorId: state.companyB });
    await PayrollRun.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(runId) },
      { $set: { lastActivityAt: new Date(Date.now() - 60 * 60 * 1000) } }
    );

    const recovered = await payrollRunService.autoRecoverStuckRuns({ thresholdMs: 5 * 60 * 1000 });
    assert.equal(recovered, 1);

    const run = await PayrollRun.findById(runId).lean();
    assert.equal(run.status, 'FAILED');
    assert.match(run.failureReason, /AUTO_RECOVERED/);
    const event = await AuditLog.findOne({ action: 'PAYROLL_PROCESSING_FAILED', entityId: runId }).lean();
    assert.equal(event.actorRole, 'system');
    assert.equal(String(event.companyId), state.companyB);

    assert.equal(await payrollRunService.autoRecoverStuckRuns({ thresholdMs: 5 * 60 * 1000 }), 0);
  });

  test('concurrent audit writes produce one linear, verifiable chain', async () => {
    const actorId = new mongoose.Types.ObjectId();
    const entityId = new mongoose.Types.ObjectId();
    const writes = Array.from({ length: 25 }, (_, index) => auditService.logStandalone({
      action: 'CONCURRENCY_TEST',
      actorId,
      entityType: 'TEST',
      entityId,
      meta: { index },
    }));
    const entries = await Promise.all(writes);
    assert.equal(new Set(entries.map((entry) => entry.sequenceNumber)).size, 25);

    const verification = await auditService.verifyAuditChain();
    assert.equal(verification.valid, true, verification.reason);

    await assert.rejects(AuditLog.deleteMany({ action: 'CONCURRENCY_TEST' }), /append-only/);
  });

  test('transaction helper runs the unit of work on this deployment', async () => {
    const result = await runInTransaction(async () => 'committed');
    assert.equal(result, 'committed');
    const ready = await createClient().get('/ready');
    assert.equal(ready.status, 200);
    assert.equal(ready.body.database, 'connected');
  });
});
