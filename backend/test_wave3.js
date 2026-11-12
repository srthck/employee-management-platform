/**
 * test_wave3.js — Wave 3: the compensation control plane, over HTTP.
 *
 * Runner: node:test (Node >= 18 built-in)
 * Run:    npm test   (full suite on a replica set, transactions required)
 *
 * Real Express app on an ephemeral port, real MongoDB replica set, isolated
 * database (WAVE3_MONGO_URI, default payguard_wave3_test), dropped before and after.
 *
 * Covers:
 *   - the component catalogue: semantics, versioning, system-managed statutory
 *     components, archive rules
 *   - deterministic component evaluation: dependency order, lineage, cycles
 *   - CTC vs gross vs net, with statutory amounts from versioned rules
 *   - effective-dated compensation and its payroll projection
 *   - impact preview: money, affected period and what a reviewer must know
 *   - the change workflow with maker-checker and segregation of duties
 *   - scheduled changes, baseline conflicts, rollback, idempotency, isolation
 *   - payroll integration: component semantics reach the payslip unchanged,
 *     and finalized payroll never moves
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'wave3-test-secret-that-is-long-enough-to-use';
process.env.FIELD_ENCRYPTION_KEYS = `v1:${crypto.randomBytes(32).toString('base64')}`;
process.env.FIELD_ENCRYPTION_ACTIVE_KEY = 'v1';
process.env.FIELD_BLIND_INDEX_KEY = crypto.randomBytes(32).toString('hex');

const TEST_DB_URI = process.env.WAVE3_MONGO_URI || 'mongodb://127.0.0.1:27018/payguard_wave3_test?replicaSet=rs0';
const BACKEND = path.dirname(fileURLToPath(import.meta.url));

const { default: app } = await import('./src/app.js');
const { default: SalaryStructure } = await import('./src/models/SalaryStructure.js');
const { default: CompensationVersion } = await import('./src/models/CompensationVersion.js');
const { default: CompensationComponent } = await import('./src/models/CompensationComponent.js');
const { default: CompensationChangeRequest } = await import('./src/models/CompensationChangeRequest.js');
const { default: ComplianceRuleVersion } = await import('./src/models/ComplianceRuleVersion.js');
const { default: AuditLog } = await import('./src/models/AuditLog.js');
const { default: Employee } = await import('./src/models/Employee.js');
const { default: auditService } = await import('./src/services/auditService.js');
const { default: compensationChangeService } = await import('./src/services/compensationChangeService.js');
const { supportsTransactions } = await import('./src/utils/transaction.js');

const PASSWORD = 'StrongPass123';
const fixed = (componentCode, amount) => ({ componentCode, calculationMethod: 'FIXED_AMOUNT', basis: { amount } });
const percentOfBasic = (componentCode, percentage) => ({ componentCode, calculationMethod: 'PERCENT_OF_BASIC', basis: { percentage } });

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
    return { status: response.status, body: json, headers: response.headers, raw: text };
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

before(async () => {
  await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 5000 });
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  assert.equal(await supportsTransactions(), true, 'Wave 3 tests need a replica set');
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

describe('Wave 3 — compensation control plane', () => {
  const owner = createClient();
  const ownerB = createClient();
  const s = {};

  const createEmployee = async (client, firstName, lastName, extra = {}) => {
    const res = await client.post('/employees', {
      firstName, lastName, email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`,
      department: 'Engineering', position: 'Engineer', salary: 20000, hireDate: '2024-01-15', status: 'active', ...extra,
    });
    expectStatus(res, 201);
    return res.body.data.employee._id;
  };

  test('setup: company, team, statutory rules and employees', async () => {
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

    expectStatus(await ownerB.post('/auth/register', {
      name: 'Owner Two', email: 'owner.b@example.com', password: PASSWORD, confirmPassword: PASSWORD, companyName: 'Other Co',
    }), 201);
    s.bEmployee = await createEmployee(ownerB, 'Bina', 'Shah');

    const createdBy = new mongoose.Types.ObjectId();
    await ComplianceRuleVersion.create([
      { ruleType: 'EPF', jurisdiction: 'IN', effectiveFrom: new Date('2014-09-01'), createdBy, description: 'EPF',
        epfParams: { employeeContributionRate: 0.12, employerContributionRate: 0.12, wageCapForContribution: 15000, epsRate: 0.0833, epsWageCeiling: 15000, roundingMode: 'NEAREST_RUPEE' } },
      { ruleType: 'ESI', jurisdiction: 'IN', effectiveFrom: new Date('2019-07-01'), createdBy, description: 'ESI',
        esiParams: { employeeContributionRate: 0.0075, employerContributionRate: 0.0325, grossWageCeiling: 21000, roundingMode: 'CEIL_RUPEE' } },
      { ruleType: 'PT', jurisdiction: 'MH', effectiveFrom: new Date('2000-01-01'), createdBy, description: 'MH PT',
        ptSlabs: [{ upTo: 7500, monthlyTax: 0 }, { upTo: 10000, monthlyTax: 175 }, { upTo: null, monthlyTax: 200, monthOverrides: [{ month: 2, monthlyTax: 300 }] }] },
    ]);

    s.asha = await createEmployee(owner, 'Asha', 'Verma');
    s.ravi = await createEmployee(owner, 'Ravi', 'Kumar');
    s.meena = await createEmployee(owner, 'Meena', 'Iyer');
  });

  // ─── Component catalogue ───────────────────────────────────────────────────

  test('a new company starts with a component catalogue that carries semantics', async () => {
    const res = await s.auditor.get('/compensation/components');
    expectStatus(res, 200);
    const byCode = Object.fromEntries(res.body.data.components.map((component) => [component.code, component]));

    assert.equal(byCode.BASIC.type, 'EARNING');
    assert.equal(byCode.BASIC.treatments.pfWage, 'INCLUDED', 'the PF wage is built from basic by default');
    assert.equal(byCode.HRA.treatments.pfWage, 'EXCLUDED');
    assert.equal(byCode.HRA.treatments.taxable, 'PARTIALLY_EXEMPT');
    assert.equal(byCode.BASIC.payrollApplication, 'GROSS_INPUT');

    assert.equal(byCode.PF_EMPLOYEE.statutory, true);
    assert.equal(byCode.PF_EMPLOYEE.calculationMethod, 'STATUTORY');
    assert.equal(byCode.PF_EMPLOYEE.payrollApplication, 'STATUTORY_ENGINE');
    assert.equal(byCode.PF_EMPLOYER.type, 'EMPLOYER_CONTRIBUTION');
    assert.equal(byCode.PF_EMPLOYER.treatments.ctc, 'INCLUDED');

    assert.equal(byCode.BONUS.recurrence, 'ONE_TIME');
    assert.equal(byCode.BONUS.payrollApplication, 'NOT_APPLIED_YET', 'one-time pay is not part of a monthly run yet');
    assert.equal(byCode.VPF.type, 'DEDUCTION');
    // Wave 3.5 pays recurring voluntary deductions, so the flag says so.
    assert.equal(byCode.VPF.payrollApplication, 'NET_DEDUCTION');
    assert.equal(byCode.GRATUITY.payrollApplication, 'EMPLOYER_COST');
    assert.equal(byCode.GRATUITY.type, 'EMPLOYER_CONTRIBUTION');
  });

  test('components are versioned, statutory ones are system-managed, and archiving is guarded', async () => {
    const created = await s.payrollAdmin.post('/compensation/components', {
      code: 'shift_allowance', name: 'Shift allowance', type: 'EARNING',
      treatments: { pfWage: 'EXCLUDED', esiWage: 'INCLUDED' },
      description: 'Paid for night shifts.',
    });
    expectStatus(created, 201);
    assert.equal(created.body.data.component.code, 'SHIFT_ALLOWANCE');
    assert.equal(created.body.data.component.version, 1);
    assert.equal(created.body.data.component.statutory, false);

    const duplicate = await s.payrollAdmin.post('/compensation/components', { code: 'SHIFT_ALLOWANCE', name: 'Again', type: 'EARNING' });
    expectStatus(duplicate, 409);
    assert.equal(duplicate.body.code, 'COMPONENT_CODE_IN_USE');

    expectStatus(await s.auditor.post('/compensation/components', { code: 'NOPE_ALLOWANCE', name: 'Nope', type: 'EARNING' }), 403);
    expectStatus(await s.payrollAdmin.post('/compensation/components', { code: 'BAD', name: 'X', type: 'EARNING' }), 422);

    const updated = await s.payrollAdmin.patch('/compensation/components/SHIFT_ALLOWANCE', {
      treatments: { pfWage: 'INCLUDED' },
    });
    expectStatus(updated, 200);
    assert.equal(updated.body.data.component.version, 2);
    assert.equal(updated.body.data.component.treatments.pfWage, 'INCLUDED');
    const versions = await CompensationComponent.find({ code: 'SHIFT_ALLOWANCE' }).sort({ version: 1 }).lean();
    assert.equal(versions.length, 2);
    assert.equal(versions[0].isCurrent, false);
    assert.ok(versions[0].supersededAt);

    const statutory = await s.payrollAdmin.patch('/compensation/components/PF_EMPLOYEE', { name: 'Renamed PF' });
    expectStatus(statutory, 409);
    assert.equal(statutory.body.code, 'COMPONENT_SYSTEM_MANAGED');
    expectStatus(await s.payrollAdmin.del('/compensation/components/ESI_EMPLOYER'), 409);

    // The model refuses rewrites from any code path.
    await assert.rejects(
      CompensationComponent.updateOne({ code: 'SHIFT_ALLOWANCE' }, { $set: { name: 'Rewritten' } }),
      (err) => err.code === 'COMPONENT_HISTORY_IMMUTABLE'
    );
  });

  // ─── Evaluation and CTC ────────────────────────────────────────────────────

  test('the direct salary path records compensation with lineage, and the payroll projection matches', async () => {
    const res = await s.payrollAdmin.post(`/employees/${s.asha}/salary`, {
      effectiveFrom: '2026-01-01',
      components: { basic: 12000, hra: 4000, specialAllowance: 4000 },
      workState: 'MH', pfEnrolled: true, esiEnrolled: true, ptEnrolled: true,
    });
    expectStatus(res, 201);
    assert.deepEqual(res.body.data.warnings, []);

    const compensation = (await s.auditor.get(`/employees/${s.asha}/compensation`)).body.data;
    const current = compensation.current;
    assert.equal(current.version, 1);
    assert.equal(current.source, 'DIRECT_REVISION');
    assert.equal(current.totals.monthlyGross, 20000);
    assert.deepEqual(current.lines.map((line) => line.componentCode).sort(), ['BASIC', 'HRA', 'SPECIAL']);
    assert.equal(current.lines.find((line) => line.componentCode === 'BASIC').lineage.explanation, 'Fixed amount ₹12,000.00');

    // CTC is gross plus employer contributions; net is gross minus employee deductions.
    assert.equal(current.statutoryEstimate.employeePf, 1440);
    assert.equal(current.statutoryEstimate.employerPf, 1440);
    assert.equal(current.statutoryEstimate.eps, 1000);
    assert.equal(current.statutoryEstimate.employeeEsi, 150);
    assert.equal(current.statutoryEstimate.employerEsi, 650);
    assert.equal(current.statutoryEstimate.professionalTax, 200);
    assert.equal(current.statutoryEstimate.netPayBeforeTds, 18210);
    assert.equal(current.totals.monthlyCtc, 22090);
    assert.equal(current.totals.annualCtc, 265080);
    assert.equal(current.pfWageBase, 12000);

    const salary = (await s.auditor.get(`/employees/${s.asha}/salary/current`)).body.data.salary;
    assert.equal(salary.grossMonthly, current.totals.monthlyGross, 'payroll input equals compensation gross');
    assert.equal(salary.pfWageOverride, null, 'PF wage is basic, so no override is needed');
    assert.equal(String(current.salaryStructureId), String(salary._id));

    await assert.rejects(
      CompensationVersion.updateOne({ employeeId: s.asha }, { $set: { 'totals.monthlyGross': 1 } }),
      (err) => err.code === 'COMPENSATION_HISTORY_IMMUTABLE'
    );
  });

  test('components are evaluated in dependency order, and a loop is refused', async () => {
    const lines = [
      fixed('BASIC', 50000),
      percentOfBasic('HRA', 40),
      { componentCode: 'SPECIAL', calculationMethod: 'PERCENT_OF_GROSS', basis: { percentage: 10 } },
      {
        componentCode: 'MISC_ALLOWANCE',
        calculationMethod: 'FORMULA',
        basis: { formula: { operation: 'PERCENT', percentage: 10, operands: [{ operation: 'SUM', operands: [{ component: 'BASIC' }, { component: 'HRA' }] }] } },
      },
      percentOfBasic('GRATUITY', 4.81),
      percentOfBasic('VPF', 5),
      fixed('BONUS', 50000),
    ];

    const preview = await s.payrollAdmin.post(`/employees/${s.ravi}/compensation/impact-preview`, {
      effectiveFrom: '2026-01-01', lines, workState: 'MH',
    });
    expectStatus(preview, 200);
    const proposed = preview.body.data.proposed;
    const amounts = Object.fromEntries(proposed.lines.map((line) => [line.componentCode, line.amountMonthly]));

    assert.equal(amounts.BASIC, 50000);
    assert.equal(amounts.HRA, 20000, '40% of basic');
    assert.equal(amounts.MISC_ALLOWANCE, 7000, '10% of (basic + HRA) through a declarative formula');
    assert.equal(amounts.SPECIAL, 7700, '10% of the gross of the components it does not depend on');
    assert.equal(amounts.GRATUITY, 2405);
    assert.equal(amounts.VPF, 2500);
    assert.equal(proposed.totals.monthlyGross, 84700, 'gross is the recurring earnings only');
    assert.equal(proposed.totals.monthlyVoluntaryDeductions, 2500);
    assert.equal(proposed.totals.monthlyEmployerContributions, 2405);
    assert.equal(proposed.totals.oneTimeAnnualEarnings, 50000);

    // Statutory: PF wage is basic capped at the ceiling; ESI stops above its ceiling.
    assert.equal(proposed.statutoryEstimate.pfWageBase, 50000);
    assert.equal(proposed.statutoryEstimate.employeePf, 1800, '12% of the ₹15,000 ceiling');
    assert.equal(proposed.statutoryEstimate.esiApplicable, false);
    assert.equal(proposed.statutoryEstimate.employeeEsi, 0);
    assert.equal(proposed.totals.monthlyCtc, 88905, 'gross + employer PF + gratuity');
    assert.equal(proposed.totals.annualCtc, 1116860, '12 months plus the one-time bonus');

    const hra = proposed.lines.find((line) => line.componentCode === 'HRA');
    assert.equal(hra.lineage.baseLabel, 'BASIC');
    assert.equal(hra.lineage.baseAmount, 50000);
    assert.equal(hra.lineage.rate, 40);
    assert.equal(hra.lineage.explanation, '40% of BASIC ₹50,000.00 = ₹20,000.00');
    assert.match(proposed.lines.find((line) => line.componentCode === 'MISC_ALLOWANCE').lineage.explanation, /10% of \(BASIC/);

    // Same inputs, same numbers.
    const again = await s.payrollAdmin.post(`/employees/${s.ravi}/compensation/impact-preview`, {
      effectiveFrom: '2026-01-01', lines, workState: 'MH',
    });
    assert.deepEqual(
      again.body.data.proposed.lines.map((line) => [line.componentCode, line.amountMonthly]),
      proposed.lines.map((line) => [line.componentCode, line.amountMonthly])
    );
    assert.equal(await CompensationVersion.countDocuments({ employeeId: s.ravi }), 0, 'a preview writes nothing');

    const cycle = await s.payrollAdmin.post(`/employees/${s.ravi}/compensation/impact-preview`, {
      effectiveFrom: '2026-01-01', workState: 'MH',
      lines: [
        fixed('BASIC', 10000),
        { componentCode: 'HRA', calculationMethod: 'PERCENT_OF_COMPONENT', basis: { percentage: 50, ofComponentCode: 'SPECIAL' } },
        { componentCode: 'SPECIAL', calculationMethod: 'PERCENT_OF_COMPONENT', basis: { percentage: 50, ofComponentCode: 'HRA' } },
      ],
    });
    expectStatus(cycle, 422);
    assert.equal(cycle.body.code, 'COMPONENT_DEPENDENCY_CYCLE');

    const statutoryLine = await s.payrollAdmin.post(`/employees/${s.ravi}/compensation/impact-preview`, {
      effectiveFrom: '2026-01-01', workState: 'MH', lines: [fixed('BASIC', 10000), fixed('PF_EMPLOYEE', 500)],
    });
    expectStatus(statutoryLine, 422);
    assert.match(JSON.stringify(statutoryLine.body.errors), /statutory/);

    const noBasic = await s.payrollAdmin.post(`/employees/${s.ravi}/compensation/impact-preview`, {
      effectiveFrom: '2026-01-01', workState: 'MH', lines: [fixed('HRA', 1000)],
    });
    expectStatus(noBasic, 422);
  });

  // ─── Impact preview ────────────────────────────────────────────────────────

  test('impact preview states the cost of a change and what a reviewer must know', async () => {
    const preview = await s.payrollAdmin.post(`/employees/${s.asha}/compensation/impact-preview`, {
      effectiveFrom: '2026-03-15',
      lines: [fixed('BASIC', 30000), percentOfBasic('HRA', 40), fixed('SPECIAL', 8000), percentOfBasic('GRATUITY', 4.81)],
      workState: 'MH',
    });
    expectStatus(preview, 200);
    const { impact } = preview.body.data;

    assert.equal(impact.monthlyGross.before, 20000);
    assert.equal(impact.monthlyGross.after, 50000);
    assert.equal(impact.monthlyGross.delta, 30000);
    assert.equal(impact.monthlyEmployeeDeductions.before, 1790);
    assert.equal(impact.monthlyNetPayBeforeTds.after, 48000, 'gross 50000 − PF 1800 − PT 200, no ESI above the ceiling');
    assert.equal(impact.monthlyCtc.before, 22090);
    // Monthly CTC after = gross 50,000 + employer PF 1,800 + gratuity 1,443.
    assert.equal(impact.monthlyCtc.after, 53243);
    assert.equal(impact.annualCtc.delta, 373836);
    assert.equal(impact.annualCtcChangePercent, 141.03);
    assert.deepEqual(impact.affectedPeriod, { periodMonth: 3, periodYear: 2026, runStatus: 'NOT_CREATED', alreadyFinalized: false });

    const codes = impact.notes.map((note) => note.code);
    assert.ok(codes.includes('MID_PERIOD_EFFECTIVE'), 'a mid-month date pays the whole month at the new rate');
    assert.ok(codes.includes('ESI_ELIGIBILITY_CHANGED'));
    assert.ok(
      !codes.includes('COMPONENTS_NOT_APPLIED_IN_PAYROLL'),
      'gratuity is a recurring employer cost that payroll now applies, so it is not reported as unpaid'
    );
    assert.ok(impact.ruleProvenance.length >= 2, 'the rule versions behind the numbers are recorded');

    // One-time pay is still outside the monthly run: that is what the note is for.
    const withBonus = await s.payrollAdmin.post(`/employees/${s.asha}/compensation/impact-preview`, {
      effectiveFrom: '2026-03-15',
      lines: [fixed('BASIC', 30000), percentOfBasic('GRATUITY', 4.81), percentOfBasic('VPF', 5), fixed('BONUS', 60000)],
      workState: 'MH',
    });
    expectStatus(withBonus, 200);
    const bonusNote = withBonus.body.data.impact.notes.find((item) => item.code === 'COMPONENTS_NOT_APPLIED_IN_PAYROLL');
    assert.ok(bonusNote, 'a one-time bonus is counted in CTC but not paid by the monthly run');
    assert.match(bonusNote.message, /Bonus/);
    assert.doesNotMatch(bonusNote.message, /Gratuity provision|Voluntary provident fund/, 'recurring VPF and gratuity are payroll-applied');
    expectStatus(await s.auditor.post(`/employees/${s.asha}/compensation/impact-preview`, {
      effectiveFrom: '2026-03-01', lines: [fixed('BASIC', 30000)], workState: 'MH',
    }), 403);
  });

  // ─── Change workflow ───────────────────────────────────────────────────────

  test('maker-checker: a pay change needs a second person, and the direct path closes', async () => {
    expectStatus(await owner.patch('/company/settings', { settings: { compensationApprovalMode: 'maker_checker' } }), 200);

    const direct = await s.payrollAdmin.post(`/employees/${s.asha}/salary`, {
      effectiveFrom: '2026-04-01', components: { basic: 13000 }, workState: 'MH',
    });
    expectStatus(direct, 409);
    assert.equal(direct.body.code, 'COMPENSATION_APPROVAL_REQUIRED');

    expectStatus(await s.auditor.post(`/employees/${s.asha}/compensation/changes`, {
      effectiveFrom: '2026-04-01', reason: 'Auditor tries a raise', lines: [fixed('BASIC', 99000)], workState: 'MH',
    }), 403);

    const proposal = await s.payrollAdmin.post(`/employees/${s.asha}/compensation/changes`, {
      effectiveFrom: '2026-04-01',
      reason: 'Annual review: promotion to senior engineer',
      lines: [fixed('BASIC', 30000), percentOfBasic('HRA', 40), fixed('SPECIAL', 8000)],
      workState: 'MH',
    });
    expectStatus(proposal, 201);
    s.change = proposal.body.data.change.id;
    assert.equal(proposal.body.data.change.status, 'PROPOSED');
    // Gross 50,000 + employer PF 1,800; ESI stops applying above its wage ceiling.
    assert.equal(proposal.body.data.impact.monthlyCtc.after, 51800);
    assert.equal(await CompensationVersion.countDocuments({ employeeId: s.asha }), 1, 'a proposal changes no pay');

    const earlyApproval = await s.approver.post(`/compensation/changes/${s.change}/approve`);
    expectStatus(earlyApproval, 409);
    assert.equal(earlyApproval.body.code, 'COMPENSATION_STATE_CONFLICT');

    expectStatus(await s.payrollAdmin.post(`/compensation/changes/${s.change}/submit`), 200);
    expectStatus(await s.payrollAdmin.post(`/compensation/changes/${s.change}/approve`), 403);

    const approved = await s.approver.post(`/compensation/changes/${s.change}/approve`, { note: 'Approved in the April cycle' });
    expectStatus(approved, 200);
    assert.equal(approved.body.data.change.status, 'EFFECTIVE');
    assert.equal(approved.body.data.change.approvalMode, 'maker_checker');
    assert.equal(approved.body.data.version.version, 2);
    assert.equal(approved.body.data.version.totals.monthlyGross, 50000);

    const salary = (await s.auditor.get(`/employees/${s.asha}/salary/current`)).body.data.salary;
    assert.equal(salary.grossMonthly, 50000, 'payroll input follows the approved compensation');
    assert.equal(salary.effectiveFrom.slice(0, 10), '2026-04-01');
    assert.equal((await Employee.findById(s.asha).lean()).salary, 50000);

    assert.ok(await AuditLog.exists({ action: 'COMPENSATION_CHANGE_PROPOSED', entityId: s.change }));
    const approval = await AuditLog.findOne({ action: 'COMPENSATION_CHANGE_APPROVED', entityId: s.change }).lean();
    assert.equal(approval.meta.approvalMode, 'maker_checker');
    assert.equal(approval.meta.proposedByEmail, 'payroll@example.com');
    assert.equal(approval.actorEmail, 'approver@example.com');
    assert.ok(await AuditLog.exists({ action: 'COMPENSATION_VERSION_CREATED', entityId: s.asha }));
  });

  test('the proposer cannot approve their own change under maker-checker', async () => {
    // The owner may both propose and approve, so only the maker-checker rule stops this.
    const proposal = await owner.post(`/employees/${s.meena}/compensation/changes`, {
      effectiveFrom: '2026-02-01', reason: 'Owner proposes for Meena', lines: [fixed('BASIC', 25000)], workState: 'MH',
    });
    expectStatus(proposal, 201);
    const changeId = proposal.body.data.change.id;
    expectStatus(await owner.post(`/compensation/changes/${changeId}/submit`), 200);

    const selfApproval = await owner.post(`/compensation/changes/${changeId}/approve`);
    expectStatus(selfApproval, 403);
    assert.equal(selfApproval.body.code, 'SEGREGATION_OF_DUTIES');

    const approved = await s.approver.post(`/compensation/changes/${changeId}/approve`);
    expectStatus(approved, 200);
    assert.equal(approved.body.data.change.status, 'EFFECTIVE');
    s.meenaChange = changeId;
  });

  test('rejection needs a reason, cancellation stops before approval, and approved changes are final', async () => {
    const proposal = await s.payrollAdmin.post(`/employees/${s.ravi}/compensation/changes`, {
      effectiveFrom: '2026-02-01', reason: 'Market correction for Ravi', lines: [fixed('BASIC', 40000)], workState: 'MH',
    });
    expectStatus(proposal, 201);
    const changeId = proposal.body.data.change.id;
    expectStatus(await s.payrollAdmin.post(`/compensation/changes/${changeId}/submit`), 200);

    const noReason = await s.approver.post(`/compensation/changes/${changeId}/reject`, {});
    expectStatus(noReason, 422);
    const rejected = await s.approver.post(`/compensation/changes/${changeId}/reject`, { note: 'Budget for this quarter is closed' });
    expectStatus(rejected, 200);
    assert.equal(rejected.body.data.change.status, 'REJECTED');
    assert.equal(await CompensationVersion.countDocuments({ employeeId: s.ravi }), 0);
    expectStatus(await s.approver.post(`/compensation/changes/${changeId}/approve`), 409);

    const second = await s.payrollAdmin.post(`/employees/${s.ravi}/compensation/changes`, {
      effectiveFrom: '2026-02-01', reason: 'Second attempt for Ravi', lines: [fixed('BASIC', 35000)], workState: 'MH',
    });
    expectStatus(second, 201);
    const cancelled = await s.payrollAdmin.post(`/compensation/changes/${second.body.data.change.id}/cancel`);
    expectStatus(cancelled, 200);
    assert.equal(cancelled.body.data.change.status, 'CANCELLED');

    expectStatus(await s.payrollAdmin.post(`/compensation/changes/${s.change}/cancel`), 409);
  });

  test('approval is refused when the compensation it was based on has changed', async () => {
    const stale = await s.payrollAdmin.post(`/employees/${s.meena}/compensation/changes`, {
      effectiveFrom: '2026-05-01', reason: 'Based on the compensation of today', lines: [fixed('BASIC', 26000)], workState: 'MH',
    });
    expectStatus(stale, 201);
    expectStatus(await s.payrollAdmin.post(`/compensation/changes/${stale.body.data.change.id}/submit`), 200);

    const jumpedAhead = await s.payrollAdmin.post(`/employees/${s.meena}/compensation/changes`, {
      effectiveFrom: '2026-04-01', reason: 'A different change lands first', lines: [fixed('BASIC', 27000)], workState: 'MH',
    });
    expectStatus(jumpedAhead, 201);
    expectStatus(await s.payrollAdmin.post(`/compensation/changes/${jumpedAhead.body.data.change.id}/submit`), 200);
    expectStatus(await s.approver.post(`/compensation/changes/${jumpedAhead.body.data.change.id}/approve`), 200);

    const conflict = await s.approver.post(`/compensation/changes/${stale.body.data.change.id}/approve`);
    expectStatus(conflict, 409);
    assert.equal(conflict.body.code, 'BASELINE_CHANGED');
  });

  test('a future-dated change is scheduled, and payroll before it is unaffected', async () => {
    const future = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 5, 1));
    const proposal = await s.payrollAdmin.post(`/employees/${s.asha}/compensation/changes`, {
      effectiveFrom: future.toISOString().slice(0, 10),
      reason: 'Scheduled increase for the next cycle',
      lines: [fixed('BASIC', 60000), percentOfBasic('HRA', 40)],
      workState: 'MH',
    });
    expectStatus(proposal, 201);
    const changeId = proposal.body.data.change.id;
    expectStatus(await s.payrollAdmin.post(`/compensation/changes/${changeId}/submit`), 200);

    const approved = await s.approver.post(`/compensation/changes/${changeId}/approve`);
    expectStatus(approved, 200);
    assert.equal(approved.body.data.change.status, 'SCHEDULED');

    const compensation = (await s.auditor.get(`/employees/${s.asha}/compensation`)).body.data;
    assert.equal(compensation.current.totals.monthlyGross, 50000, 'today still uses the current compensation');
    assert.equal(compensation.scheduled.length, 1);
    assert.equal(compensation.scheduled[0].totals.monthlyGross, 84000);

    // Payroll resolves by date: the period before the change keeps the old pay.
    const beforeChange = await SalaryStructure.findValidForDate(s.asha, new Date('2026-05-31'));
    const afterChange = await SalaryStructure.findValidForDate(s.asha, new Date(future.getTime() + 86400000));
    assert.equal(beforeChange.grossMonthly, 50000);
    assert.equal(afterChange.grossMonthly, 84000);

    const activated = await compensationChangeService.activateDue({ now: new Date(future.getTime() + 86400000) });
    assert.ok(activated >= 1);
    assert.equal((await CompensationChangeRequest.findById(changeId).lean()).status, 'EFFECTIVE');
    assert.ok(await AuditLog.exists({ action: 'COMPENSATION_CHANGE_EFFECTIVE', entityId: changeId }));
  });

  // ─── Payroll integration ───────────────────────────────────────────────────

  test('component semantics reach payroll: a PF-wage component changes the PF wage deterministically', async () => {
    expectStatus(await s.payrollAdmin.patch('/compensation/components/SPECIAL', { treatments: { pfWage: 'INCLUDED' } }), 200);

    const proposal = await s.payrollAdmin.post(`/employees/${s.meena}/compensation/changes`, {
      effectiveFrom: '2026-06-01',
      reason: 'Special allowance counted in the PF wage',
      lines: [fixed('BASIC', 10000), fixed('SPECIAL', 4000)],
      workState: 'MH',
    });
    expectStatus(proposal, 201);
    const changeId = proposal.body.data.change.id;
    expectStatus(await s.payrollAdmin.post(`/compensation/changes/${changeId}/submit`), 200);
    expectStatus(await s.approver.post(`/compensation/changes/${changeId}/approve`), 200);

    const compensation = (await s.auditor.get(`/employees/${s.meena}/compensation`)).body.data.current;
    assert.equal(compensation.pfWageBase, 14000, 'basic plus the special allowance');
    assert.equal(compensation.statutoryEstimate.employeePf, 1680, '12% of ₹14,000');

    const salary = (await s.auditor.get(`/employees/${s.meena}/salary/current`)).body.data.salary;
    assert.equal(salary.pfWageOverride, 14000, 'the payroll engine is told the PF wage, not left to guess');

    // Payroll calculates the same number the compensation estimate predicted.
    const run = await owner.post('/payroll-runs', { periodMonth: 7, periodYear: 2026 });
    expectStatus(run, 201);
    s.julyRun = run.body.data.run._id;
    expectStatus(await owner.post(`/payroll-runs/${s.julyRun}/process`), 200);
    const snapshotsResponse = await owner.post(`/payroll-runs/${s.julyRun}/materialize`);
    assert.ok([200, 201].includes(snapshotsResponse.status), JSON.stringify(snapshotsResponse.body));

    const staging = await mongoose.connection.db.collection('payrollstagingresults')
      .findOne({ runId: new mongoose.Types.ObjectId(s.julyRun), employeeId: new mongoose.Types.ObjectId(s.meena) });
    assert.equal(staging.payrollInputs.pfWageOverride, 14000);
    assert.equal(staging.epf.employeeEpf, 1680, 'payroll and the compensation estimate agree');
    assert.equal(staging.payrollInputs.grossMonthly, 14000);
  });

  test('finalized payroll never moves when compensation changes later', async () => {
    expectStatus(await owner.post(`/payroll-runs/${s.julyRun}/finalize`), 200);
    const snapshots = mongoose.connection.db.collection('payrollsnapshots');
    const before = await snapshots.find({ payrollRunId: new mongoose.Types.ObjectId(s.julyRun) }).sort({ _id: 1 }).toArray();
    assert.ok(before.length > 0);

    const proposal = await s.payrollAdmin.post(`/employees/${s.meena}/compensation/changes`, {
      effectiveFrom: '2026-08-01', reason: 'Raise after July payroll was locked', lines: [fixed('BASIC', 20000)], workState: 'MH',
    });
    expectStatus(proposal, 201);
    const changeId = proposal.body.data.change.id;
    expectStatus(await s.payrollAdmin.post(`/compensation/changes/${changeId}/submit`), 200);
    const approved = await s.approver.post(`/compensation/changes/${changeId}/approve`);
    expectStatus(approved, 200);

    const after = await snapshots.find({ payrollRunId: new mongoose.Types.ObjectId(s.julyRun) }).sort({ _id: 1 }).toArray();
    assert.deepEqual(after, before, 'finalized payslips are byte-for-byte unchanged');

    const payslip = await owner.get(`/payroll-snapshots/${before[0]._id}/explain`);
    expectStatus(payslip, 200);
    assert.equal(payslip.body.data.payslip.integrity.verified, true);
  });

  test('payroll readiness reports compensation that payroll does not pay yet', async () => {
    const proposal = await s.payrollAdmin.post(`/employees/${s.ravi}/compensation/changes`, {
      effectiveFrom: '2026-01-01',
      reason: 'Ravi joins with gratuity, voluntary PF and a joining bonus',
      lines: [fixed('BASIC', 20000), percentOfBasic('GRATUITY', 4.81), percentOfBasic('VPF', 5), fixed('BONUS', 60000)],
      workState: 'MH',
    });
    expectStatus(proposal, 201);
    const changeId = proposal.body.data.change.id;
    expectStatus(await s.payrollAdmin.post(`/compensation/changes/${changeId}/submit`), 200);
    expectStatus(await s.approver.post(`/compensation/changes/${changeId}/approve`), 200);

    const readiness = (await s.auditor.get(`/employees/${s.ravi}/payroll-readiness?periodYear=2026&periodMonth=9`)).body.data.readiness;
    const codes = readiness.warnings.map((warning) => warning.code);
    assert.ok(codes.includes('COMPENSATION_COMPONENTS_NOT_APPLIED'));
    const notApplied = readiness.warnings.find((warning) => warning.code === 'COMPENSATION_COMPONENTS_NOT_APPLIED').message;
    assert.match(notApplied, /Bonus/, 'a one-time bonus is not paid by the monthly run');
    assert.doesNotMatch(notApplied, /Gratuity provision|Voluntary provident fund/, 'recurring VPF and gratuity are payroll-applied, so they are not flagged');

    const pending = await s.payrollAdmin.post(`/employees/${s.ravi}/compensation/changes`, {
      effectiveFrom: '2026-09-01', reason: 'Pending September change', lines: [fixed('BASIC', 21000)], workState: 'MH',
    });
    expectStatus(pending, 201);
    expectStatus(await s.payrollAdmin.post(`/compensation/changes/${pending.body.data.change.id}/submit`), 200);
    const withPending = (await s.auditor.get(`/employees/${s.ravi}/payroll-readiness?periodYear=2026&periodMonth=9`)).body.data.readiness;
    assert.ok(withPending.warnings.map((warning) => warning.code).includes('COMPENSATION_CHANGE_PENDING_APPROVAL'));
  });

  // ─── Safety ────────────────────────────────────────────────────────────────

  test('an approval that fails rolls back completely', async () => {
    const proposal = await s.payrollAdmin.post(`/employees/${s.meena}/compensation/changes`, {
      effectiveFrom: '2026-09-01', reason: 'Change that will fail while being approved', lines: [fixed('BASIC', 31000)], workState: 'MH',
    });
    expectStatus(proposal, 201);
    const changeId = proposal.body.data.change.id;
    expectStatus(await s.payrollAdmin.post(`/compensation/changes/${changeId}/submit`), 200);

    const versionsBefore = await CompensationVersion.countDocuments({ employeeId: s.meena });
    const salaryBefore = await SalaryStructure.findOne({ employeeId: s.meena, effectiveTo: null }).lean();

    const originalLog = auditService.log;
    auditService.log = async function failingLog(params, session) {
      if (params.action === 'COMPENSATION_CHANGE_APPROVED') throw new Error('Injected approval failure');
      return originalLog.call(this, params, session);
    };
    try {
      expectStatus(await s.approver.post(`/compensation/changes/${changeId}/approve`), 500);
    } finally {
      auditService.log = originalLog;
    }

    assert.equal(await CompensationVersion.countDocuments({ employeeId: s.meena }), versionsBefore, 'no compensation version survived');
    const salaryAfter = await SalaryStructure.findOne({ employeeId: s.meena, effectiveTo: null }).lean();
    assert.equal(String(salaryAfter._id), String(salaryBefore._id), 'the payroll input is untouched');
    assert.equal((await CompensationChangeRequest.findById(changeId).lean()).status, 'SUBMITTED', 'the change can be approved again');

    const retry = await s.approver.post(`/compensation/changes/${changeId}/approve`);
    expectStatus(retry, 200);
  });

  test('a retried approval applies one pay change, not two', async () => {
    const proposal = await s.payrollAdmin.post(`/employees/${s.meena}/compensation/changes`, {
      effectiveFrom: '2026-10-01', reason: 'Change approved with a retry', lines: [fixed('BASIC', 32000)], workState: 'MH',
    });
    expectStatus(proposal, 201);
    const changeId = proposal.body.data.change.id;
    expectStatus(await s.payrollAdmin.post(`/compensation/changes/${changeId}/submit`), 200);

    const key = `approve-${crypto.randomUUID()}`;
    const versionsBefore = await CompensationVersion.countDocuments({ employeeId: s.meena });
    const first = await s.approver.post(`/compensation/changes/${changeId}/approve`, {}, { 'Idempotency-Key': key });
    const retry = await s.approver.post(`/compensation/changes/${changeId}/approve`, {}, { 'Idempotency-Key': key });
    expectStatus(first, 200);
    expectStatus(retry, 200);
    assert.equal(retry.headers.get('idempotent-replayed'), 'true');
    assert.equal(await CompensationVersion.countDocuments({ employeeId: s.meena }), versionsBefore + 1);
  });

  test('compensation stays inside its company', async () => {
    expectStatus(await ownerB.get(`/employees/${s.asha}/compensation`), 404);
    expectStatus(await ownerB.get(`/compensation/changes/${s.change}`), 404);
    expectStatus(await ownerB.post(`/employees/${s.asha}/compensation/changes`, {
      effectiveFrom: '2026-06-01', reason: 'Cross-company attempt', lines: [fixed('BASIC', 1000)], workState: 'MH',
    }), 404);

    const theirComponents = (await ownerB.get('/compensation/components')).body.data.components;
    assert.ok(!theirComponents.some((component) => component.code === 'SHIFT_ALLOWANCE'), 'catalogues are per company');
    assert.equal((await ownerB.get('/compensation/changes')).body.data.changes.length, 0);
  });

  test('the migration records compensation for salary versions created before Wave 3', async () => {
    const legacyEmployee = await createEmployee(owner, 'Legacy', 'Person');
    await SalaryStructure.create({
      employeeId: legacyEmployee,
      effectiveFrom: new Date('2025-01-01'),
      components: { basic: 15000, hra: 5000, specialAllowance: 2000 },
      workState: 'MH',
      pfEnrolled: true,
      esiEnrolled: true,
      ptEnrolled: true,
      createdBy: new mongoose.Types.ObjectId(s.companyId),
    });
    assert.equal(await CompensationVersion.countDocuments({ employeeId: legacyEmployee }), 0);

    const migration = spawnSync(process.execPath, ['scripts/migrate.js'], {
      cwd: BACKEND,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, MONGO_URI: TEST_DB_URI },
    });
    assert.equal(migration.status, 0, migration.stdout + migration.stderr);

    const version = await CompensationVersion.findOne({ employeeId: legacyEmployee }).lean();
    assert.ok(version, 'the legacy salary version now has compensation');
    assert.equal(version.source, 'MIGRATION');
    assert.equal(version.totals.monthlyGross, 22000);
    // SPECIAL was marked part of the PF wage earlier in this suite, so the
    // backfill builds the PF wage from basic + special, capped later by the rule.
    assert.equal(version.pfWageBase, 17000);
    assert.deepEqual(version.lines.map((line) => line.componentCode).sort(), ['BASIC', 'HRA', 'SPECIAL']);
    assert.equal(version.statutoryEstimate.employeePf, 1800);

    const rerun = spawnSync(process.execPath, ['scripts/migrate.js'], {
      cwd: BACKEND, encoding: 'utf8', timeout: 120_000, env: { ...process.env, MONGO_URI: TEST_DB_URI },
    });
    assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
    assert.equal(await CompensationVersion.countDocuments({ employeeId: legacyEmployee }), 1, 'the backfill does not duplicate');
  });

  test('every compensation version has a matching payroll projection, and the audit chain verifies', async () => {
    const versions = await CompensationVersion.find({ companyId: s.companyId }).lean();
    assert.ok(versions.length >= 5);
    for (const version of versions) {
      const salary = await SalaryStructure.findById(version.salaryStructureId).lean();
      assert.ok(salary, `compensation version ${version._id} has no payroll projection`);
      assert.equal(salary.grossMonthly, version.totals.monthlyGross);
      assert.equal(String(salary.employeeId), String(version.employeeId));
      assert.equal(new Date(salary.effectiveFrom).toISOString(), new Date(version.effectiveFrom).toISOString());
      assert.equal(salary.workState, version.workState);
    }

    assert.equal((await auditService.verifyAuditChain()).valid, true);
  });
});
