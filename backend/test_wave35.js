/**
 * test_wave35.js — Wave 3.5: compensation operations and pay-basis completion.
 *
 * Runner: node:test (Node >= 18 built-in)
 * Run:    npm test   (full suite on a replica set, transactions required)
 *
 * Real Express app on an ephemeral port, real MongoDB replica set, isolated
 * database (WAVE35_MONGO_URI, default payguard_wave35_test), dropped before and
 * after.
 *
 * What this proves:
 *   - a full month is calculated exactly as it was before this wave
 *   - joining or leaving inside a period pays for the days employed, under the
 *     company's payable-days basis (calendar, fixed or working days)
 *   - statutory amounts follow the earned wage, while ESI eligibility follows
 *     the wage for the period — a part month does not create ESI cover
 *   - the professional tax slab basis is a company decision, recorded per result
 *   - recurring voluntary deductions and employer contributions reach net pay,
 *     the payslip, and the register
 *   - the variance report explains part-period pay instead of blocking on it
 *   - snapshots written before this wave still verify: new fields are hashed
 *     only when present
 *   - finalized payroll never moves when the pay basis changes afterwards
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'wave35-test-secret-that-is-long-enough';
process.env.FIELD_ENCRYPTION_KEYS = `v1:${crypto.randomBytes(32).toString('base64')}`;
process.env.FIELD_ENCRYPTION_ACTIVE_KEY = 'v1';
process.env.FIELD_BLIND_INDEX_KEY = crypto.randomBytes(32).toString('hex');

const TEST_DB_URI = process.env.WAVE35_MONGO_URI || 'mongodb://127.0.0.1:27018/payguard_wave35_test?replicaSet=rs0';

const { default: app } = await import('./src/app.js');
const { default: ComplianceRuleVersion } = await import('./src/models/ComplianceRuleVersion.js');
const { default: PayrollSnapshot, computeSnapshotHash } = await import('./src/models/PayrollSnapshot.js');
const { default: auditService } = await import('./src/services/auditService.js');
const { computePayPeriodDays, payrollBasisFrom } = await import('./src/utils/payBasis.js');
const { supportsTransactions } = await import('./src/utils/transaction.js');

const PASSWORD = 'StrongPass123';

let server;
let baseUrl;

function createClient() {
  let cookie = '';
  const request = async (method, url, body, headers = {}) => {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { 'content-type': 'application/json', ...(method !== 'GET' && { 'Idempotency-Key': `test-${globalThis.crypto.randomUUID()}` }), ...(cookie && { cookie }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: response.status, body: json, raw: text };
  };
  return {
    get: (url, headers) => request('GET', url, undefined, headers),
    post: (url, body = {}, headers) => request('POST', url, body, headers),
    patch: (url, body = {}, headers) => request('PATCH', url, body, headers),
    del: (url, body, headers) => request('DELETE', url, body, headers),
  };
}

const login = async (email) => {
  const client = createClient();
  const res = await client.post('/auth/login', { email, password: PASSWORD });
  assert.equal(res.status, 200, `login ${email}: ${JSON.stringify(res.body)}`);
  return client;
};

const expectStatus = (res, status) => assert.equal(res.status, status, JSON.stringify(res.body));
const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

before(async () => {
  await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 5000 });
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  assert.equal(await supportsTransactions(), true, 'Wave 3.5 tests need a replica set');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  try {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  } finally {
    await mongoose.disconnect();
  }
});

describe('Wave 3.5 — compensation operations and pay basis', () => {
  const owner = createClient();
  const ownerB = createClient();
  const s = {};

  // March 2026 has 31 calendar days and five Sundays (1, 8, 15, 22, 29).
  const MARCH = { periodMonth: 3, periodYear: 2026 };

  const staging = (employeeId, runId = s.marchRun) => mongoose.connection.db
    .collection('payrollstagingresults')
    .findOne({
      runId: new mongoose.Types.ObjectId(runId),
      employeeId: new mongoose.Types.ObjectId(employeeId),
    });

  const createEmployee = async (client, firstName, lastName, hireDate) => {
    const res = await client.post('/employees', {
      firstName,
      lastName,
      email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`,
      department: 'Engineering',
      position: 'Engineer',
      salary: 20000,
      hireDate,
      status: 'active',
    });
    expectStatus(res, 201);
    return res.body.data.employee._id;
  };

  const setSalary = async (client, employeeId, effectiveFrom, components) => {
    const res = await client.post(`/employees/${employeeId}/salary`, {
      effectiveFrom,
      components,
      workState: 'MH',
      pfEnrolled: true,
      esiEnrolled: true,
      ptEnrolled: true,
    });
    expectStatus(res, 201);
    return res.body.data;
  };

  const processRun = async (client, period = MARCH) => {
    const created = await client.post('/payroll-runs', period);
    expectStatus(created, 201);
    const runId = created.body.data.run._id;
    expectStatus(await client.post(`/payroll-runs/${runId}/process`), 200);
    return runId;
  };

  const setBasis = async (client, settings) => {
    const res = await client.patch('/company/settings', { settings });
    expectStatus(res, 200);
    return res.body.data.company.settings;
  };

  test('setup: company, team, statutory rules, and people who join and leave', async () => {
    expectStatus(await owner.post('/auth/register', {
      name: 'Owner One', email: 'owner@example.com', password: PASSWORD, confirmPassword: PASSWORD, companyName: 'Acme Payroll',
    }), 201);
    s.companyId = (await owner.get('/auth/me')).body.data.user.companyId;

    for (const [name, email, role] of [
      ['Pavan Preparer', 'payroll@example.com', 'payroll_admin'],
      ['Anita Approver', 'approver@example.com', 'payroll_approver'],
      ['Arti Auditor', 'auditor@example.com', 'auditor'],
    ]) {
      expectStatus(await owner.post('/company/users', { name, email, role, password: PASSWORD }), 201);
    }
    s.payrollAdmin = await login('payroll@example.com');
    s.approver = await login('approver@example.com');
    s.auditor = await login('auditor@example.com');

    const createdBy = new mongoose.Types.ObjectId();
    await ComplianceRuleVersion.create([
      { ruleType: 'EPF', jurisdiction: 'IN', effectiveFrom: new Date('2014-09-01'), createdBy, description: 'EPF',
        epfParams: { employeeContributionRate: 0.12, employerContributionRate: 0.12, wageCapForContribution: 15000, epsRate: 0.0833, epsWageCeiling: 15000, roundingMode: 'NEAREST_RUPEE' } },
      { ruleType: 'ESI', jurisdiction: 'IN', effectiveFrom: new Date('2019-07-01'), createdBy, description: 'ESI',
        esiParams: { employeeContributionRate: 0.0075, employerContributionRate: 0.0325, grossWageCeiling: 21000, roundingMode: 'CEIL_RUPEE' } },
      { ruleType: 'PT', jurisdiction: 'MH', effectiveFrom: new Date('2000-01-01'), createdBy, description: 'MH PT',
        ptSlabs: [{ upTo: 7500, monthlyTax: 0 }, { upTo: 10000, monthlyTax: 175 }, { upTo: null, monthlyTax: 200 }] },
    ]);

    // Asha works the whole period. Neha joins on the 20th. Tara joins on the
    // 16th and earns above the ESI ceiling. Ravi leaves on the 10th. Vikram
    // pays into a voluntary fund and is covered for gratuity.
    s.asha = await createEmployee(owner, 'Asha', 'Verma', '2024-01-15');
    s.neha = await createEmployee(owner, 'Neha', 'Rao', '2026-03-20');
    s.tara = await createEmployee(owner, 'Tara', 'Menon', '2026-03-16');
    s.ravi = await createEmployee(owner, 'Ravi', 'Kumar', '2024-01-15');
    s.vikram = await createEmployee(owner, 'Vikram', 'Shah', '2024-01-15');

    await setSalary(s.payrollAdmin, s.asha, '2026-01-01', { basic: 12000, hra: 4800, specialAllowance: 3200 });
    await setSalary(s.payrollAdmin, s.neha, '2026-03-20', { basic: 12000, hra: 4800, specialAllowance: 3200 });
    await setSalary(s.payrollAdmin, s.tara, '2026-03-16', { basic: 13200, hra: 5280, specialAllowance: 3520 });
    await setSalary(s.payrollAdmin, s.ravi, '2026-01-01', { basic: 12000, hra: 4800, specialAllowance: 3200 });
    await setSalary(s.payrollAdmin, s.vikram, '2026-01-01', { basic: 12000, hra: 4800, specialAllowance: 3200 });

    const exit = await owner.post(`/employees/${s.ravi}/employment`, {
      changeType: 'EXIT',
      effectiveFrom: '2026-03-11',
      exit: { lastWorkingDay: '2026-03-10', reason: 'RESIGNATION' },
      reason: 'Resigned with notice served.',
    });
    expectStatus(exit, 201);

    const proposal = await s.payrollAdmin.post(`/employees/${s.vikram}/compensation/changes`, {
      effectiveFrom: '2026-03-01',
      lines: [
        { componentCode: 'BASIC', calculationMethod: 'FIXED_AMOUNT', basis: { amount: 12000 } },
        { componentCode: 'HRA', calculationMethod: 'FIXED_AMOUNT', basis: { amount: 4800 } },
        { componentCode: 'SPECIAL', calculationMethod: 'FIXED_AMOUNT', basis: { amount: 3200 } },
        { componentCode: 'VPF', calculationMethod: 'FIXED_AMOUNT', basis: { amount: 1000 } },
        { componentCode: 'GRATUITY', calculationMethod: 'FIXED_AMOUNT', basis: { amount: 577 } },
      ],
      reason: 'Employee opted into the voluntary provident fund, with gratuity cover.',
    });
    expectStatus(proposal, 201);
    const changeId = proposal.body.data.change.id;
    expectStatus(await s.payrollAdmin.post(`/compensation/changes/${changeId}/submit`), 200);
    expectStatus(await s.approver.post(`/compensation/changes/${changeId}/approve`), 200);
  });

  // ─── The pay basis itself ──────────────────────────────────────────────────

  test('the payable-days basis is a company setting, validated, permission-gated and audited', async () => {
    const company = (await owner.get('/company')).body.data.company;
    assert.equal(company.settings.payableDaysBasis, 'CALENDAR_DAYS', 'calendar days is the default');
    assert.equal(company.settings.fixedPayableDays, 30);
    assert.equal(company.settings.professionalTaxBasis, 'EARNED_GROSS');

    expectStatus(await owner.patch('/company/settings', { settings: { payableDaysBasis: 'LUNAR_MONTH' } }), 400);
    expectStatus(await owner.patch('/company/settings', { settings: { fixedPayableDays: 45 } }), 400);
    expectStatus(await owner.patch('/company/settings', { settings: { weeklyOffDays: [9] } }), 400);
    expectStatus(await owner.patch('/company/settings', { settings: { professionalTaxBasis: 'GUESS' } }), 400);
    expectStatus(await s.payrollAdmin.patch('/company/settings', { settings: { payableDaysBasis: 'FIXED_DAYS' } }), 403);

    const auditLogs = mongoose.connection.db.collection('auditlogs');
    const settingsAudits = () => auditLogs.countDocuments({ action: 'COMPANY_SETTINGS_UPDATED' });

    // Re-saving the current values changes nothing, so it writes no audit entry.
    const auditsBefore = await settingsAudits();
    const unchanged = await setBasis(owner, { payableDaysBasis: 'CALENDAR_DAYS', professionalTaxBasis: 'EARNED_GROSS' });
    assert.equal(unchanged.payableDaysBasis, 'CALENDAR_DAYS');
    assert.equal(await settingsAudits(), auditsBefore, 'a no-op settings save is not audited');

    // A real change is audited, with the old and new value; the default is then restored.
    const changed = await setBasis(owner, { payableDaysBasis: 'FIXED_DAYS' });
    assert.equal(changed.payableDaysBasis, 'FIXED_DAYS');
    const audit = await auditLogs.findOne({ action: 'COMPANY_SETTINGS_UPDATED' }, { sort: { _id: -1 } });
    assert.ok(audit, 'a settings change is audited');
    assert.equal(await settingsAudits(), auditsBefore + 1);
    assert.deepEqual(audit.meta.changes['settings.payableDaysBasis'], { from: 'CALENDAR_DAYS', to: 'FIXED_DAYS' });

    const restored = await setBasis(owner, { payableDaysBasis: 'CALENDAR_DAYS' });
    assert.equal(restored.payableDaysBasis, 'CALENDAR_DAYS');
  });

  test('payable days follow the basis, and a full month is always exactly one', () => {
    const period = { periodStart: new Date('2026-03-01'), periodEnd: new Date('2026-03-31') };
    const calendar = computePayPeriodDays({ ...period, basis: payrollBasisFrom({ payableDaysBasis: 'CALENDAR_DAYS' }) });
    assert.deepEqual(
      [calendar.payableDays, calendar.paidDays, calendar.prorationFactor, calendar.prorated],
      [31, 31, 1, false]
    );

    const joined = computePayPeriodDays({
      ...period, basis: payrollBasisFrom({ payableDaysBasis: 'CALENDAR_DAYS' }), hireDate: new Date('2026-03-20'),
    });
    assert.deepEqual([joined.payableDays, joined.paidDays], [31, 12], 'the 20th to the 31st, inclusive');
    assert.equal(joined.prorationFactor, 0.387097);
    assert.deepEqual(joined.reasons, ['JOINED_MID_PERIOD']);

    const fixed = computePayPeriodDays({
      ...period, basis: payrollBasisFrom({ payableDaysBasis: 'FIXED_DAYS', fixedPayableDays: 30 }), hireDate: new Date('2026-03-20'),
    });
    assert.deepEqual([fixed.payableDays, fixed.paidDays], [30, 11.61], 'a fixed divisor still reflects the part worked');

    const working = computePayPeriodDays({
      ...period, basis: payrollBasisFrom({ payableDaysBasis: 'WORKING_DAYS', weeklyOffDays: [0] }),
    });
    assert.deepEqual([working.payableDays, working.paidDays], [26, 26], 'March 2026 has five Sundays');

    const exited = computePayPeriodDays({
      ...period, basis: payrollBasisFrom({ payableDaysBasis: 'CALENDAR_DAYS' }), lastWorkingDay: new Date('2026-03-10'),
    });
    assert.deepEqual([exited.paidDays, exited.reasons], [10, ['EXITED_MID_PERIOD']]);
  });

  // ─── Payroll under the pay basis ───────────────────────────────────────────

  test('a full month is calculated exactly as before, and says so', async () => {
    s.marchRun = await processRun(s.payrollAdmin);
    const result = await staging(s.asha);

    assert.equal(result.payrollInputs.grossMonthly, 20000);
    assert.equal(result.payrollInputs.fullMonthlyGross, 20000);
    assert.deepEqual(
      [result.payrollInputs.payableDays, result.payrollInputs.paidDays, result.payrollInputs.prorationFactor],
      [31, 31, 1]
    );
    assert.equal(result.payrollInputs.payableDaysBasis, 'CALENDAR_DAYS');
    assert.equal(result.payrollInputs.attendanceAdjustment, 'DEFERRED', 'nothing was prorated');
    assert.equal(result.epf.employeeEpf, 1440, '12% of basic 12,000');
    assert.equal(result.esi.employeeEsi, 150, '0.75% of gross 20,000');
    assert.equal(result.pt.pt, 200);
    assert.equal(result.totalEmployeeDeductions, 1790);
    assert.equal(result.netPayBeforeTDS, 18210);
  });

  test('joining inside the period pays for the days employed, and statutory follows the earned wage', async () => {
    const result = await staging(s.neha);

    assert.deepEqual(
      [result.payrollInputs.payableDays, result.payrollInputs.paidDays, result.payrollInputs.prorationFactor],
      [31, 12, 0.387097]
    );
    assert.equal(result.payrollInputs.attendanceAdjustment, 'PRORATED_BY_EMPLOYMENT_DATES');
    assert.equal(result.payrollInputs.fullMonthlyGross, 20000, 'the full rate is kept for context');
    assert.equal(result.payrollInputs.grossMonthly, 7741.94, '20,000 x 12/31');
    assert.equal(result.payrollInputs.basicSalary, 4645.16, 'the PF wage is prorated too');
    assert.equal(result.epf.employeeEpf, 557, '12% of the earned PF wage');
    assert.equal(result.esi.employeeEsi, 59, '0.75% of earned gross, rounded up');
    assert.equal(result.pt.pt, 175, 'the earned gross falls in a lower slab');
    assert.equal(result.payrollInputs.professionalTaxBasis, 'EARNED_GROSS');
    assert.equal(result.netPayBeforeTDS, round2(7741.94 - (557 + 59 + 175)));

    const component = result.compensationSnapshot.lines.find((line) => line.componentCode === 'BASIC');
    assert.equal(component.amountMonthly, 12000);
    assert.equal(component.amountEarned, 4645.16, 'every component is prorated by the same factor');
  });

  test('ESI eligibility follows the wage for the period, not the part of it that was earned', async () => {
    const result = await staging(s.tara);

    assert.equal(result.payrollInputs.fullMonthlyGross, 22000, 'above the 21,000 ceiling');
    assert.equal(result.payrollInputs.grossMonthly, 11354.84, '22,000 x 16/31');
    assert.equal(result.esi.applicable, false, 'a part month does not create ESI cover');
    assert.equal(result.esi.employeeEsi, 0);
    assert.equal(result.esi.employerEsi, 0);
  });

  test('leaving inside the period is paid for the days worked, not skipped', async () => {
    const result = await staging(s.ravi);

    assert.deepEqual([result.payrollInputs.payableDays, result.payrollInputs.paidDays], [31, 10]);
    assert.equal(result.payrollInputs.grossMonthly, 6451.62, '20,000 x 10/31');
    assert.ok(result.netPayBeforeTDS > 0, 'the final month is still paid');

    const readiness = (await s.payrollAdmin.get(`/employees/${s.ravi}/payroll-readiness?periodMonth=3&periodYear=2026`)).body.data.readiness;
    const exitWarning = readiness.warnings.find((warning) => warning.code === 'EXIT_WITHIN_PERIOD');
    assert.ok(exitWarning, 'readiness still raises the exit');
    assert.match(exitWarning.message, /prorated/, 'and says pay is prorated now');

    const joinerReadiness = (await s.payrollAdmin.get(`/employees/${s.neha}/payroll-readiness?periodMonth=3&periodYear=2026`)).body.data.readiness;
    assert.ok(joinerReadiness.warnings.some((warning) => warning.code === 'JOINED_WITHIN_PERIOD'));
  });

  // ─── Compensation that is not gross ────────────────────────────────────────

  test('a recurring voluntary deduction and employer contribution reach net pay', async () => {
    const result = await staging(s.vikram);

    assert.equal(result.payrollInputs.grossMonthly, 20000, 'gross is unchanged: the voluntary fund is a deduction');
    assert.equal(result.voluntaryDeductionsTotal, 1000);
    assert.equal(result.employerOtherContributionTotal, 577);
    assert.equal(result.totalEmployeeDeductions, 2790, '1,440 PF + 150 ESI + 200 PT + 1,000 voluntary');
    assert.equal(result.netPayBeforeTDS, 17210);
    assert.equal(result.voluntaryDeductions[0].componentCode, 'VPF');
    assert.equal(result.employerOtherContributions[0].componentCode, 'GRATUITY');

    const compensation = (await s.auditor.get(`/employees/${s.vikram}/compensation`)).body.data;
    const vpf = compensation.current.lines.find((line) => line.componentCode === 'VPF');
    assert.equal(vpf.payrollApplication, 'NET_DEDUCTION', 'the catalogue no longer says payroll ignores it');
  });

  test('the register counts voluntary deductions and every employer cost', async () => {
    const register = (await s.approver.get(`/payroll-runs/${s.marchRun}/register`)).body.data;

    assert.equal(register.totals.voluntaryDeductions, 1000);
    assert.equal(register.totals.employerOtherContributions, 577);
    assert.equal(
      register.totals.employerContributions,
      round2(register.totals.statutoryEmployerContributions + 577),
      'employer contributions include what is not statutory'
    );
    assert.equal(
      register.totals.costToCompany,
      round2(register.totals.gross + register.totals.employerContributions)
    );

    const vikram = register.employees.find((line) => line.employeeId === s.vikram);
    assert.equal(vikram.voluntaryDeductions, 1000);
    assert.deepEqual([vikram.payableDays, vikram.paidDays], [31, 31]);
    const neha = register.employees.find((line) => line.employeeId === s.neha);
    assert.deepEqual([neha.payableDays, neha.paidDays], [31, 12], 'the register shows what each person was paid for');
  });

  // ─── The payslip ───────────────────────────────────────────────────────────

  test('the payslip shows prorated earnings, voluntary deductions and the true cost to company', async () => {
    expectStatus(await s.approver.post(`/payroll-runs/${s.marchRun}/finalize`), 200);
    const snapshots = (await s.approver.get(`/payroll-runs/${s.marchRun}/snapshots?limit=50`)).body.data.snapshots;
    const snapshotFor = (employeeId) => snapshots.find(
      (snapshot) => String(snapshot.employeeSnapshot.employeeId) === String(employeeId)
    );
    s.nehaSnapshotId = snapshotFor(s.neha)._id;
    s.ashaSnapshotId = snapshotFor(s.asha)._id;

    const nehaPayslip = (await s.approver.get(`/payroll-snapshots/${s.nehaSnapshotId}/explain`)).body.data.payslip;
    assert.deepEqual(
      [nehaPayslip.payPeriodDays.payableDays, nehaPayslip.payPeriodDays.paidDays, nehaPayslip.payPeriodDays.prorated],
      [31, 12, true]
    );
    assert.equal(nehaPayslip.fullMonthlyGross, 20000);
    const basic = nehaPayslip.earnings.find((line) => line.code === 'BASIC');
    assert.equal(basic.amount, 4645.16);
    assert.match(basic.formula, /12\/31 paid days/, 'the payslip shows the days it was prorated by');
    assert.ok(
      nehaPayslip.limitations.some((limitation) => /prorated/i.test(limitation)),
      'and says plainly that pay was prorated'
    );

    const vikramPayslip = (await s.approver.get(`/payroll-snapshots/${snapshotFor(s.vikram)._id}/explain`)).body.data.payslip;
    const vpf = vikramPayslip.deductions.find((line) => line.code === 'VPF');
    assert.equal(vpf.amount, 1000);
    const gratuity = vikramPayslip.employerContributions.find((line) => line.code === 'GRATUITY');
    assert.equal(gratuity.amount, 577);
    assert.equal(vikramPayslip.totals.voluntaryDeductions, 1000);
    assert.equal(vikramPayslip.totals.netPayBeforeTDS, 17210);
    assert.equal(
      vikramPayslip.totals.costToCompany,
      round2(vikramPayslip.totals.gross + vikramPayslip.totals.statutoryEmployerContributions + 577)
    );
  });

  test('finalized payroll never moves when the pay basis changes afterwards', async () => {
    const before = await PayrollSnapshot.findById(s.nehaSnapshotId).lean();
    await setBasis(owner, { payableDaysBasis: 'WORKING_DAYS', weeklyOffDays: [0], professionalTaxBasis: 'FULL_MONTHLY_GROSS' });

    const after = await PayrollSnapshot.findById(s.nehaSnapshotId).lean();
    assert.equal(after.snapshotHash, before.snapshotHash);
    assert.equal(after.payrollInputs.payableDaysBasis, 'CALENDAR_DAYS');
    assert.equal(after.payrollInputs.paidDays, 12);
    assert.equal((await s.auditor.get(`/payroll-snapshots/${s.nehaSnapshotId}/verify`)).body.data.valid, true);

    await setBasis(owner, { payableDaysBasis: 'CALENDAR_DAYS', professionalTaxBasis: 'EARNED_GROSS' });
  });

  // ─── Variance ──────────────────────────────────────────────────────────────

  test('the variance report explains part-period pay instead of blocking on it', async () => {
    s.aprilRun = await processRun(s.payrollAdmin, { periodMonth: 4, periodYear: 2026 });
    const variance = (await s.approver.get(`/payroll-runs/${s.aprilRun}/variance`)).body.data;

    const neha = variance.flags.find((flag) => flag.employeeId === s.neha);
    assert.equal(neha.code, 'PAY_CHANGE_EXPECTED', 'a first full month after joining is not a mystery');
    assert.equal(neha.classification, 'EXPECTED');
    assert.deepEqual(neha.causes, ['PRORATION_CHANGE']);
    assert.equal(neha.blocking, false);
    assert.ok(neha.components.every((component) => component.explained));

    const asha = variance.flags.find((flag) => flag.employeeId === s.asha);
    assert.equal(asha, undefined, 'an unchanged full month raises nothing at all');

    assert.equal(variance.counts.blocking, 0);
    const readiness = (await s.approver.get(`/payroll-runs/${s.aprilRun}/finalization-readiness`)).body.data;
    assert.equal(readiness.canFinalize, true, 'part-period pay must not block a close');
  });

  // ─── History and hashes ────────────────────────────────────────────────────

  test('a snapshot written before this wave still verifies: new fields are hashed only when present', async () => {
    const current = await PayrollSnapshot.findById(s.ashaSnapshotId).lean();
    assert.ok(current.compensationSnapshot, 'a snapshot written today carries its compensation breakdown');

    // Rebuild the document shape a pre-Wave-3.5 run wrote: no compensation
    // breakdown, and none of the pay-basis inputs. The April run has no
    // snapshots of its own, so this one does not collide with a real record.
    const { _id, snapshotHash, compensationSnapshot, createdAt, updatedAt, __v, ...rest } = current;
    const {
      fullMonthlyGross, payableDays, paidDays, prorationFactor, payableDaysBasis, professionalTaxBasis, ...oldInputs
    } = current.payrollInputs;
    const legacy = {
      ...rest,
      _id: new mongoose.Types.ObjectId(),
      payrollRunId: new mongoose.Types.ObjectId(s.aprilRun),
      payrollInputs: oldInputs,
    };
    legacy.snapshotHash = computeSnapshotHash(legacy);
    assert.notEqual(legacy.snapshotHash, snapshotHash, 'the new fields are covered by the hash when present');
    await mongoose.connection.db.collection('payrollsnapshots').insertOne(legacy);

    const verified = (await s.auditor.get(`/payroll-snapshots/${legacy._id}/verify`)).body.data;
    assert.equal(verified.valid, true, 'a snapshot in the old shape still verifies under the new code');

    const payslip = (await s.auditor.get(`/payroll-snapshots/${legacy._id}/explain`)).body.data.payslip;
    assert.equal(payslip.totals.gross, 20000, 'and still explains itself');
    assert.equal(payslip.payPeriodDays, null, 'without claiming a pay basis it never recorded');
  });

  // ─── Another company, another basis ────────────────────────────────────────

  test('each company chooses its own basis, and one company never reads another', async () => {
    expectStatus(await ownerB.post('/auth/register', {
      name: 'Owner Two', email: 'owner.b@example.com', password: PASSWORD, confirmPassword: PASSWORD, companyName: 'Other Co',
    }), 201);
    await setBasis(ownerB, {
      payableDaysBasis: 'FIXED_DAYS', fixedPayableDays: 30, professionalTaxBasis: 'FULL_MONTHLY_GROSS',
    });

    const bina = await createEmployee(ownerB, 'Bina', 'Shah', '2026-03-20');
    await setSalary(ownerB, bina, '2026-03-20', { basic: 12000, hra: 4800, specialAllowance: 3200 });
    const runB = await processRun(ownerB);
    const result = await staging(bina, runB);

    assert.deepEqual(
      [result.payrollInputs.payableDaysBasis, result.payrollInputs.payableDays, result.payrollInputs.paidDays],
      ['FIXED_DAYS', 30, 11.61],
      'a fixed 30-day month, not the 31 days March happens to have'
    );
    assert.equal(result.payrollInputs.grossMonthly, 7740, '20,000 x 11.61/30');
    assert.equal(result.pt.pt, 200, 'this company reads the slab from the full monthly gross');
    assert.equal(result.payrollInputs.professionalTaxBasis, 'FULL_MONTHLY_GROSS');

    const ashaUnderB = await staging(s.asha, runB);
    assert.equal(ashaUnderB, null, 'another company’s people are not in this run');
    expectStatus(await ownerB.get(`/payroll-runs/${s.marchRun}/register`), 404);
    expectStatus(await ownerB.get(`/payroll-snapshots/${s.nehaSnapshotId}/explain`), 404);

    const acme = (await owner.get('/company')).body.data.company;
    assert.equal(acme.settings.payableDaysBasis, 'CALENDAR_DAYS', 'the other company’s choice changed nothing here');
  });

  test('the audit chain still verifies after every Wave 3.5 action', async () => {
    const verification = await auditService.verifyAuditChain();
    assert.equal(verification.valid, true, JSON.stringify(verification));
    expectStatus(await s.auditor.get('/audit/verify'), 200);
  });
});
