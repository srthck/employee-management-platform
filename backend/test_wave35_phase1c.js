/**
 * test_wave35_phase1c.js — Wave 3.5 Phase 1C (technical wiring): ESI and PT are
 * calculated on their own wage, never on gross by accident.
 *
 * Runner: node:test. Part 1 is pure. Part 2 is the real Express app on a real
 * MongoDB replica set (WAVE35C_MONGO_URI, default payguard_wave35c_test), dropped
 * before and after.
 *
 * What this phase does:
 *   frozen compensation lines -> pure basis derivation -> statutory calculator
 *   -> payroll staging -> result -> snapshot, and the SAME derivation behind the
 *   compensation preview and the CTC estimate.
 *
 * What it deliberately does NOT do (separate gates): no rule matrix is active,
 * statutoryNature is not consulted, ESI coverage and continuity are unchanged,
 * readiness and payslip explanations are untouched.
 *
 * Until a matrix is active, inclusion follows the treatment flags FROZEN on each
 * compensation line (inclusionSource LEGACY_TREATMENT_FLAGS). Every nature key and
 * rule matrix below is a TEST FIXTURE, not a statement about the law.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'wave35c-test-secret-that-is-long-enough';
process.env.FIELD_ENCRYPTION_KEYS = `v1:${crypto.randomBytes(32).toString('base64')}`;
process.env.FIELD_ENCRYPTION_ACTIVE_KEY = 'v1';
process.env.FIELD_BLIND_INDEX_KEY = crypto.randomBytes(32).toString('hex');

const TEST_DB_URI = process.env.WAVE35C_MONGO_URI || 'mongodb://127.0.0.1:27018/payguard_wave35c_test?replicaSet=rs0';

const { default: app } = await import('./src/app.js');
const { default: ComplianceRuleVersion } = await import('./src/models/ComplianceRuleVersion.js');
const { default: SalaryStructure } = await import('./src/models/SalaryStructure.js');
const { default: PayrollSnapshot, verifySnapshotHash } = await import('./src/models/PayrollSnapshot.js');
const { default: auditService } = await import('./src/services/auditService.js');
const { default: statutory } = await import('./src/services/complianceCalculationService.js');
const bases = await import('./src/utils/statutoryBases.js');
const { supportsTransactions } = await import('./src/utils/transaction.js');

const PASSWORD = 'StrongPass123';
const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const fixed = (componentCode, amount) => ({ componentCode, calculationMethod: 'FIXED_AMOUNT', basis: { amount } });

// ═══════════════════════════════════════════════════════════════════════════
// Part 1 — the pure derivation
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 1C — the pure statutory basis derivation', () => {
  const flags = (esiWage, ptWage) => ({ taxable: 'TAXABLE', pfWage: 'EXCLUDED', esiWage, ptWage, ctc: 'INCLUDED', payslip: 'VISIBLE' });
  const line = (componentCode, amountMonthly, amountEarned, esiWage = 'INCLUDED', ptWage = 'INCLUDED', extra = {}) => ({
    componentCode, type: 'EARNING', recurrence: 'RECURRING', treatments: flags(esiWage, ptWage), amountMonthly, amountEarned, ...extra,
  });
  const deepFreeze = (value) => {
    Object.values(value).forEach((child) => { if (child && typeof child === 'object') deepFreeze(child); });
    return Object.freeze(value);
  };

  test('identity rule: every recurring earning included, so the basis IS earned gross, residual and all', () => {
    // Three lines earned 33.33 each add up to 99.99; the gross prorated as one number is 100.00.
    const lines = [line('A', 100, 33.33), line('B', 100, 33.33), line('C', 100, 33.33)];
    const derived = bases.deriveStatutoryBasesFromLines({ lines, earnedGross: 100, fullMonthlyGross: 300 });
    assert.equal(derived.esiContributionWage, 100, 'earned gross, exactly as payroll calculated it');
    assert.equal(derived.ptSlabWage, 100);
    assert.equal(derived.lineRoundingResidual, -1, 'the line sum is one paisa short, and that is recorded');
    assert.deepEqual(derived.lineage.esiContribution, { identity: true, included: ['A', 'B', 'C'] });
  });

  test('partial inclusion: the basis is the sum of the included, individually rounded, earned lines', () => {
    const lines = [line('A', 100, 33.33), line('B', 100, 33.33, 'EXCLUDED'), line('C', 100, 33.33)];
    const derived = bases.deriveStatutoryBasesFromLines({ lines, earnedGross: 100, fullMonthlyGross: 300 });
    assert.equal(derived.esiContributionWage, 66.66, '33.33 + 33.33, not 100 minus anything');
    assert.equal(derived.ptSlabWage, 100, 'PT inclusion is its own question: all three are PT wage');
    assert.deepEqual(derived.lineage.esiContribution, { identity: false, included: ['A', 'C'] });
  });

  test('the identity transition is visible: excluding even a zero-amount line switches to the line sum', () => {
    const all = [line('A', 100, 33.33), line('B', 100, 33.33), line('C', 100, 33.33)];
    const withZeroExcluded = [...all, line('Z', 0, 0, 'EXCLUDED')];
    const identity = bases.deriveStatutoryBasesFromLines({ lines: all, earnedGross: 100, fullMonthlyGross: 300 });
    const partial = bases.deriveStatutoryBasesFromLines({ lines: withZeroExcluded, earnedGross: 100, fullMonthlyGross: 300 });
    assert.equal(identity.esiContributionWage, 100);
    assert.equal(partial.esiContributionWage, 99.99, 'the documented discontinuity: the residual, by its sign, and no more');
    assert.equal(round2(identity.esiContributionWage - partial.esiContributionWage), 0.01);
  });

  test('PT keeps the company basis: earned amounts, or the full-month amounts', () => {
    const lines = [line('A', 1000, 400), line('B', 500, 200, 'INCLUDED', 'EXCLUDED')];
    const earned = bases.deriveStatutoryBasesFromLines({ lines, earnedGross: 600, fullMonthlyGross: 1500, ptBasis: 'EARNED_GROSS' });
    const full = bases.deriveStatutoryBasesFromLines({ lines, earnedGross: 600, fullMonthlyGross: 1500, ptBasis: 'FULL_MONTHLY_GROSS' });
    assert.equal(earned.ptSlabWage, 400, 'earned lines, B excluded');
    assert.equal(full.ptSlabWage, 1000, 'full-month lines, B excluded');
    const allIn = [line('A', 1000, 400), line('B', 500, 200)];
    assert.equal(bases.deriveStatutoryBasesFromLines({ lines: allIn, earnedGross: 600, fullMonthlyGross: 1500, ptBasis: 'EARNED_GROSS' }).ptSlabWage, 600);
    assert.equal(bases.deriveStatutoryBasesFromLines({ lines: allIn, earnedGross: 600, fullMonthlyGross: 1500, ptBasis: 'FULL_MONTHLY_GROSS' }).ptSlabWage, 1500);
  });

  test('only recurring earnings are wages: deductions, employer costs and one-time pay are not', () => {
    const lines = [
      line('BASIC', 1000, 1000),
      { ...line('VPF', 100, 100), type: 'DEDUCTION' },
      { ...line('GRATUITY', 50, 50), type: 'EMPLOYER_CONTRIBUTION' },
      { ...line('BONUS', 5000, 0), recurrence: 'ONE_TIME' },
    ];
    const derived = bases.deriveStatutoryBasesFromLines({ lines, earnedGross: 1000, fullMonthlyGross: 1000 });
    assert.equal(derived.esiContributionWage, 1000);
    assert.deepEqual(derived.lineage.esiContribution.included, ['BASIC']);
  });

  test('statutoryNature is not consulted: null, classified and unknown natures all give the same answer', () => {
    const make = (nature) => [line('A', 100, 60, 'INCLUDED', 'INCLUDED', { statutoryNature: nature }), line('B', 100, 40, 'EXCLUDED', 'INCLUDED', { statutoryNature: nature })];
    const results = [null, undefined, 'FIXTURE_NATURE_A', 'NOT_IN_ANY_MATRIX'].map((nature) => {
      const { lineage, ...rest } = bases.deriveStatutoryBasesFromLines({ lines: make(nature), earnedGross: 100, fullMonthlyGross: 200 });
      return JSON.stringify({ ...rest, lineage });
    });
    assert.equal(new Set(results).size, 1);
  });

  test('a line with no frozen treatment is refused, never defaulted into or out of a wage', () => {
    const missing = { ...line('A', 100, 100), treatments: { taxable: 'TAXABLE', pfWage: 'EXCLUDED', ctc: 'INCLUDED', payslip: 'VISIBLE' } };
    assert.throws(
      () => bases.deriveStatutoryBasesFromLines({ lines: [missing], earnedGross: 100, fullMonthlyGross: 100 }),
      (error) => error.code === 'FROZEN_TREATMENT_MISSING'
    );
    assert.throws(
      () => bases.deriveStatutoryBasesFromLines({ lines: [{ ...line('A', 100, 100), treatments: undefined }], earnedGross: 100, fullMonthlyGross: 100 }),
      (error) => error.code === 'FROZEN_TREATMENT_MISSING'
    );
  });

  test('matrix inclusion is not active: asking for it is refused, not guessed', () => {
    assert.throws(
      () => bases.deriveStatutoryBasesFromLines({ lines: [line('A', 100, 100)], earnedGross: 100, fullMonthlyGross: 100, inclusion: 'RULE_MATRIX' }),
      (error) => error.code === 'INCLUSION_MODE_NOT_ACTIVE'
    );
  });

  test('the residual can never exceed what rounding allows; beyond that is a defect', () => {
    // One line, so at most one paisa of difference is possible. Five is impossible.
    assert.throws(
      () => bases.deriveStatutoryBasesFromLines({ lines: [line('A', 100, 100.05)], earnedGross: 100, fullMonthlyGross: 100 }),
      (error) => error.code === 'RESIDUAL_OUT_OF_BOUND'
    );
    assert.doesNotThrow(() => bases.deriveStatutoryBasesFromLines({ lines: [line('A', 100, 100.01)], earnedGross: 100, fullMonthlyGross: 100 }));
  });

  test('the stored document carries only what was derived, never an undefined key', () => {
    const fromLines = bases.toStatutoryBasesDocument(bases.deriveStatutoryBasesFromLines({ lines: [line('A', 100, 100)], earnedGross: 100, fullMonthlyGross: 100 }));
    assert.deepEqual(Object.keys(fromLines).sort(), ['basisSource', 'esiContributionWage', 'inclusionSource', 'lineRoundingResidual', 'ptSlabWage']);
    const buckets = bases.toStatutoryBasesDocument(bases.deriveStatutoryBasesFromSalaryBuckets({ earnedGross: 100, fullMonthlyGross: 120 }));
    assert.deepEqual(buckets, {
      esiContributionWage: 100, ptSlabWage: 100, basisSource: 'SALARY_STRUCTURE_BUCKETS',
      inclusionSource: { esiContribution: 'LEGACY_SALARY_BUCKETS', ptSlab: 'LEGACY_SALARY_BUCKETS' },
    });
    const drift = bases.toStatutoryBasesDocument(bases.deriveUnresolvedDriftBases({ earnedGross: 100, fullMonthlyGross: 120, ptBasis: 'FULL_MONTHLY_GROSS' }));
    assert.deepEqual(drift, { esiContributionWage: 100, ptSlabWage: 120, basisSource: 'UNRESOLVED_PROJECTION_DRIFT' });
    for (const document of [fromLines, buckets, drift]) {
      assert.ok(Object.values(document).every((value) => value !== undefined), 'no undefined values');
      assert.equal(JSON.stringify(document).includes('undefined'), false);
    }
  });

  test('deterministic: the same input gives the same output, and the input is never changed', () => {
    const lines = deepFreeze([line('A', 1000, 387.1), line('B', 500, 193.55, 'EXCLUDED', 'INCLUDED')]);
    const input = deepFreeze({ lines, earnedGross: 580.65, fullMonthlyGross: 1500, ptBasis: 'EARNED_GROSS' });
    const first = bases.deriveStatutoryBasesFromLines(input);
    const second = bases.deriveStatutoryBasesFromLines(input);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  test('the legacy salary-bucket path reproduces the old behaviour exactly', () => {
    for (const [earned, full] of [[20000, 20000], [7741.94, 20000], [3333.33, 10000.5]]) {
      const legacy = (ptBasis) => (ptBasis === 'FULL_MONTHLY_GROSS' ? full : earned);
      for (const ptBasis of ['EARNED_GROSS', 'FULL_MONTHLY_GROSS']) {
        const derived = bases.deriveStatutoryBasesFromSalaryBuckets({ earnedGross: earned, fullMonthlyGross: full, ptBasis });
        assert.equal(derived.esiContributionWage, earned, 'ESI was always charged on earned gross');
        assert.equal(derived.ptSlabWage, legacy(ptBasis), 'PT used the company basis, as before');
      }
    }
  });

  test('the calculator: ESI is charged on the contribution wage, net pay stays on gross, coverage is unchanged', () => {
    const esiRule = { employeeContributionRate: 0.0075, employerContributionRate: 0.0325, grossWageCeiling: 21000, roundingMode: 'PAISE' };
    const epfRule = { employeeContributionRate: 0.12, employerContributionRate: 0.12, wageCapForContribution: 15000, roundingMode: 'PAISE' };
    const slabs = [{ upTo: 7500, monthlyTax: 0 }, { upTo: 10000, monthlyTax: 175 }, { upTo: null, monthlyTax: 200 }];
    const base = {
      grossMonthly: 10400, basicSalary: 4000, pfEnrolled: true, esiEnrolled: true, ptEnrolled: true, epfRule, esiRule, ptSlabs: slabs, periodMonth: 3,
    };

    const before = statutory.calculate(base);
    assert.equal(before.esi.employeeEsi, 78, 'no contribution wage given: gross, exactly as before');
    assert.equal(before.pt.pt, 200);

    const split = statutory.calculate({ ...base, esiContributionWage: 7900, ptGross: 8900 });
    assert.equal(split.esi.employeeEsi, 59.25, '0.75% of 7,900');
    assert.equal(split.esi.employerEsi, 256.75, '3.25% of 7,900');
    assert.equal(split.pt.pt, 175, 'the slab is read from 8,900');
    assert.equal(split.grossMonthly, 10400, 'gross is still gross');
    assert.equal(split.netPay, round2(10400 - split.totalEmployeeDeductions), 'net pay is gross minus deductions, not wage minus deductions');
    assert.equal(split.epf.employeeEpf, before.epf.employeeEpf, 'PF is untouched');

    // Coverage still follows the existing path: a low contribution wage does not create coverage.
    const overCeiling = statutory.calculate({ ...base, grossMonthly: 25000, esiCeilingWage: 25000, esiContributionWage: 5000 });
    assert.equal(overCeiling.esi.applicable, false);
    assert.equal(overCeiling.esi.employeeEsi, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Part 2 — end to end
// ═══════════════════════════════════════════════════════════════════════════

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
  assert.equal(await supportsTransactions(), true, 'Wave 3.5 Phase 1C tests need a replica set');
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

describe('Phase 1C — independent ESI and PT wage, end to end', () => {
  const owner = createClient();
  const ownerB = createClient();
  const s = {};
  const db = () => mongoose.connection.db;
  const oid = (value) => new mongoose.Types.ObjectId(value);
  const MARCH = { periodMonth: 3, periodYear: 2026 };
  const APRIL = { periodMonth: 4, periodYear: 2026 };
  const MAY = { periodMonth: 5, periodYear: 2026 };

  const stagingOf = (runId, employeeId) => db().collection('payrollstagingresults')
    .findOne({ runId: oid(runId), employeeId: oid(employeeId) });
  const snapshotsOf = async (runId) => db().collection('payrollsnapshots').find({ payrollRunId: oid(runId) }).toArray();
  const snapshotFor = (snapshots, employeeId) => snapshots.find((entry) => String(entry.employeeSnapshot.employeeId) === String(employeeId));

  const createEmployee = async (client, firstName, lastName, hireDate = '2024-01-15') => {
    const res = await client.post('/employees', {
      firstName, lastName, email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`,
      department: 'Engineering', position: 'Engineer', salary: 20000, hireDate, status: 'active',
    });
    expectStatus(res, 201);
    return res.body.data.employee._id;
  };

  const recordCompensation = async (maker, checker, employeeId, effectiveFrom, lines) => {
    const proposal = await maker.post(`/employees/${employeeId}/compensation/changes`, {
      effectiveFrom, reason: 'Phase 1C fixture', workState: 'MH', lines,
    });
    expectStatus(proposal, 201);
    const changeId = proposal.body.data.change.id;
    expectStatus(await maker.post(`/compensation/changes/${changeId}/submit`), 200);
    expectStatus(await checker.post(`/compensation/changes/${changeId}/approve`), 200);
  };

  const processRun = async (client, period) => {
    const created = await client.post('/payroll-runs', period);
    expectStatus(created, 201);
    const runId = created.body.data.run._id;
    expectStatus(await client.post(`/payroll-runs/${runId}/process`), 200);
    return runId;
  };

  // The canonical fixture: gross != ESI contribution wage != PT slab wage.
  //   BASIC 4000 + HRA 1600 + SPECIAL 800            = 6400   (in every wage)
  //   ESI_OUT 2500: outside the ESI wage, inside the PT wage
  //   PT_OUT  1500: inside the ESI wage, outside the PT wage
  //   gross 10400 | ESI contribution wage 7900 | PT slab wage 8900
  // PT slabs: up to 7,500 nil, up to 10,000 175, above 200. Gross (10,400) would
  // fall in the 200 slab; the PT slab wage (8,900) falls in the 175 slab.
  const KAVYA_LINES = [fixed('BASIC', 4000), fixed('HRA', 1600), fixed('SPECIAL', 800), fixed('ESI_OUT', 2500), fixed('PT_OUT', 1500)];

  // ─── Setup ─────────────────────────────────────────────────────────────────

  test('setup: company, rules, components and people', async () => {
    expectStatus(await owner.post('/auth/register', {
      name: 'Owner One', email: 'owner@example.com', password: PASSWORD, confirmPassword: PASSWORD, companyName: 'Acme Payroll',
    }), 201);
    s.companyId = (await owner.get('/auth/me')).body.data.user.companyId;
    for (const [name, email, role] of [
      ['Pavan Preparer', 'payroll@example.com', 'payroll_admin'],
      ['Anita Approver', 'approver@example.com', 'payroll_approver'],
      ['Arti Auditor', 'auditor@example.com', 'auditor'],
    ]) expectStatus(await owner.post('/company/users', { name, email, role, password: PASSWORD }), 201);
    s.payrollAdmin = await login('payroll@example.com');
    s.approver = await login('approver@example.com');
    s.auditor = await login('auditor@example.com');

    const createdBy = new mongoose.Types.ObjectId();
    const epfParams = { employeeContributionRate: 0.12, employerContributionRate: 0.12, wageCapForContribution: 15000, epsRate: 0.0833, epsWageCeiling: 15000, roundingMode: 'NEAREST_RUPEE' };
    const esiBase = { employeeContributionRate: 0.0075, employerContributionRate: 0.0325, grossWageCeiling: 21000, roundingMode: 'CEIL_RUPEE' };
    const slabs = [{ upTo: 7500, monthlyTax: 0 }, { upTo: 10000, monthlyTax: 175 }, { upTo: null, monthlyTax: 200 }];
    await ComplianceRuleVersion.create([
      { ruleType: 'EPF', jurisdiction: 'IN', effectiveFrom: new Date('2014-09-01'), createdBy, description: 'EPF', epfParams },
      // A period ends at 23:59:59.999 UTC on its last day, so the old rule runs to the end of April 30.
      { ruleType: 'ESI', jurisdiction: 'IN', effectiveFrom: new Date('2019-07-01'), effectiveTo: new Date('2026-04-30T23:59:59.999Z'), createdBy, description: 'ESI v1', esiParams: esiBase },
      { ruleType: 'PT', jurisdiction: 'MH', effectiveFrom: new Date('2000-01-01'), effectiveTo: new Date('2026-04-30T23:59:59.999Z'), createdBy, description: 'MH PT v1', ptSlabs: slabs },
      // From May: identical rates, plus a FIXTURE matrix that nothing reads yet.
      {
        ruleType: 'ESI', jurisdiction: 'IN', effectiveFrom: new Date('2026-05-01'), createdBy, description: 'ESI v2 (fixture matrix)',
        esiParams: {
          ...esiBase,
          statutoryInclusion: { coverage: [{ nature: 'FIXTURE_NATURE_A', inclusion: 'EXCLUDED' }], contribution: [{ nature: 'FIXTURE_NATURE_A', inclusion: 'EXCLUDED' }] },
        },
      },
      { ruleType: 'PT', jurisdiction: 'MH', effectiveFrom: new Date('2026-05-01'), createdBy, description: 'MH PT v2 (fixture matrix)', ptSlabs: slabs, ptInclusion: [{ nature: 'FIXTURE_NATURE_A', inclusion: 'EXCLUDED' }] },
    ]);

    for (const component of [
      { code: 'ESI_OUT', name: 'Outside ESI wage', treatments: { esiWage: 'EXCLUDED', ptWage: 'INCLUDED' } },
      { code: 'PT_OUT', name: 'Outside PT wage', treatments: { esiWage: 'INCLUDED', ptWage: 'EXCLUDED' } },
      { code: 'ZERO_OUT', name: 'Zero, outside ESI wage', treatments: { esiWage: 'EXCLUDED', ptWage: 'INCLUDED' } },
      { code: 'NATURE_IN', name: 'Classified, included by flags', statutoryNature: 'FIXTURE_NATURE_A', treatments: { esiWage: 'INCLUDED', ptWage: 'INCLUDED' } },
    ]) expectStatus(await s.payrollAdmin.post('/compensation/components', { type: 'EARNING', ...component }), 201);

    s.kavya = await createEmployee(owner, 'Kavya', 'Rao');
    s.ivan = await createEmployee(owner, 'Ivan', 'Das');
    s.tara = await createEmployee(owner, 'Tara', 'Menon', '2026-03-16');
    s.tara2 = await createEmployee(owner, 'Tara', 'Menontwo', '2026-03-16');
    s.nina = await createEmployee(owner, 'Nina', 'Shah', '2026-03-20');
    s.leo = await createEmployee(owner, 'Leo', 'Nair');
    s.drew = await createEmployee(owner, 'Drew', 'Bose');
    s.mina = await createEmployee(owner, 'Mina', 'Paul');
    s.legacy = await createEmployee(owner, 'Lena', 'Old');

    await recordCompensation(s.payrollAdmin, s.approver, s.kavya, '2026-01-01', KAVYA_LINES);
    expectStatus(await s.payrollAdmin.post(`/employees/${s.ivan}/salary`, {
      effectiveFrom: '2026-01-01', components: { basic: 12000, hra: 4800, specialAllowance: 3200 },
      workState: 'MH', pfEnrolled: true, esiEnrolled: true, ptEnrolled: true,
    }), 201);
    const taraLines = [fixed('BASIC', 13200), fixed('HRA', 5280), fixed('SPECIAL', 3520)];
    await recordCompensation(s.payrollAdmin, s.approver, s.tara, '2026-03-16', taraLines);
    await recordCompensation(s.payrollAdmin, s.approver, s.tara2, '2026-03-16', [...taraLines, fixed('ZERO_OUT', 0)]);
    await recordCompensation(s.payrollAdmin, s.approver, s.nina, '2026-03-20', KAVYA_LINES);
    await recordCompensation(s.payrollAdmin, s.approver, s.leo, '2026-01-01', KAVYA_LINES);
    expectStatus(await owner.post(`/employees/${s.leo}/employment`, {
      changeType: 'EXIT', effectiveFrom: '2026-03-11', exit: { lastWorkingDay: '2026-03-10', reason: 'RESIGNATION' }, reason: 'Resigned with notice served.',
    }), 201);
    await recordCompensation(s.payrollAdmin, s.approver, s.drew, '2026-01-01', [fixed('BASIC', 8000), fixed('HRA', 3200), fixed('SPECIAL', 800), fixed('ESI_OUT', 2000)]);
    await recordCompensation(s.payrollAdmin, s.approver, s.mina, '2026-01-01', [fixed('BASIC', 12000), fixed('HRA', 4800), fixed('SPECIAL', 1200), fixed('NATURE_IN', 2000)]);

    // Drew's compensation and his payroll projection drift apart (the existing, unchanged state this phase must leave alone).
    await db().collection('salarystructures').updateOne(
      { employeeId: oid(s.drew), effectiveTo: null },
      { $set: { 'components.basic': 8001, grossMonthly: 14001 } }
    );

    // Lena predates compensation altogether: a salary structure and no compensation version.
    await SalaryStructure.create({
      employeeId: oid(s.legacy), effectiveFrom: new Date('2026-01-01'), createdBy: oid(s.companyId), workState: 'MH',
      components: { basic: 12000, hra: 4800, specialAllowance: 3200 }, pfEnrolled: true, esiEnrolled: true, ptEnrolled: true,
    });
    assert.equal(await db().collection('compensationversions').countDocuments({ employeeId: oid(s.legacy) }), 0);
  });

  // ─── The canonical anti-gross-reuse fixture ────────────────────────────────

  const KAVYA = {
    gross: 10400, esiContributionWage: 7900, ptSlabWage: 8900,
    employeeEpf: 480, employeeEsi: 60, employerEsi: 257, pt: 175, totalEmployeeDeductions: 715, netPayBeforeTDS: 9685,
  };

  test('preview: gross, ESI contribution wage and PT slab wage are three different numbers, each used for its own purpose', async () => {
    const preview = await s.payrollAdmin.post(`/employees/${s.kavya}/compensation/impact-preview`, {
      effectiveFrom: '2026-03-01', workState: 'MH', lines: KAVYA_LINES,
    });
    expectStatus(preview, 200);
    const { proposed } = preview.body.data;
    const estimate = proposed.statutoryEstimate;

    assert.equal(proposed.totals.monthlyGross, KAVYA.gross);
    assert.equal(estimate.statutoryBases.esiContributionWage, KAVYA.esiContributionWage);
    assert.equal(estimate.statutoryBases.ptSlabWage, KAVYA.ptSlabWage);
    assert.ok(KAVYA.gross !== KAVYA.esiContributionWage && KAVYA.esiContributionWage !== KAVYA.ptSlabWage && KAVYA.gross !== KAVYA.ptSlabWage);
    assert.deepEqual(estimate.statutoryBases.inclusionSource, { esiContribution: 'LEGACY_TREATMENT_FLAGS', ptSlab: 'LEGACY_TREATMENT_FLAGS' });
    assert.equal(estimate.employeeEsi, KAVYA.employeeEsi, 'ceil(0.75% of 7,900); on gross it would be 78');
    assert.equal(estimate.employerEsi, KAVYA.employerEsi, 'ceil(3.25% of 7,900); on gross it would be 338');
    assert.equal(estimate.professionalTax, KAVYA.pt, 'the 175 slab; on gross it would be 200');
    assert.equal(estimate.employeePf, KAVYA.employeeEpf, 'PF is untouched');
    assert.equal(estimate.totalEmployeeDeductions, KAVYA.totalEmployeeDeductions);
    assert.equal(estimate.netPayBeforeTds, KAVYA.netPayBeforeTDS, 'net pay is gross minus deductions');

    const codes = preview.body.data.impact.notes.map((note) => note.code);
    assert.ok(codes.includes('ESI_WAGE_DIFFERS_FROM_GROSS'));
    assert.ok(codes.includes('PT_WAGE_DIFFERS_FROM_GROSS'));
    assert.ok(!codes.includes('ESI_WAGE_BASE_NOT_APPLIED'), 'that note said the opposite of what is now true');

    s.kavyaPreview = estimate;
    assert.equal(await db().collection('compensationversions').countDocuments({ employeeId: oid(s.kavya) }), 1, 'a preview writes nothing');
  });

  test('payroll staging and result: the same three numbers, with their sources', async () => {
    s.marchRun = await processRun(s.payrollAdmin, MARCH);
    const staging = await stagingOf(s.marchRun, s.kavya);
    s.kavyaMarch = staging;

    assert.equal(staging.payrollInputs.grossMonthly, KAVYA.gross);
    assert.deepEqual(staging.payrollInputs.statutoryBases, {
      esiContributionWage: KAVYA.esiContributionWage,
      ptSlabWage: KAVYA.ptSlabWage,
      inclusionSource: { esiContribution: 'LEGACY_TREATMENT_FLAGS', ptSlab: 'LEGACY_TREATMENT_FLAGS' },
      basisSource: 'COMPENSATION_LINES',
      lineRoundingResidual: 0,
    });
    assert.equal(staging.esi.employeeEsi, KAVYA.employeeEsi);
    assert.equal(staging.esi.employerEsi, KAVYA.employerEsi);
    assert.equal(staging.pt.pt, KAVYA.pt);
    assert.equal(staging.epf.employeeEpf, KAVYA.employeeEpf);
    assert.equal(staging.totalEmployeeDeductions, KAVYA.totalEmployeeDeductions);
    assert.equal(staging.netPayBeforeTDS, KAVYA.netPayBeforeTDS);
    assert.equal(staging.esi.applicable, true, 'coverage still follows the existing path: gross 10,400 is under the ceiling');
  });

  test('preview and payroll agree for the same context', () => {
    const e = s.kavyaPreview;
    const p = s.kavyaMarch;
    assert.equal(e.statutoryBases.esiContributionWage, p.payrollInputs.statutoryBases.esiContributionWage);
    assert.equal(e.statutoryBases.ptSlabWage, p.payrollInputs.statutoryBases.ptSlabWage);
    assert.equal(e.employeeEsi, p.esi.employeeEsi);
    assert.equal(e.employerEsi, p.esi.employerEsi);
    assert.equal(e.professionalTax, p.pt.pt);
    assert.equal(e.employeePf, p.epf.employeeEpf);
    assert.equal(e.employerPf, p.epf.employerEpf);
    assert.equal(e.totalEmployeeDeductions, p.totalEmployeeDeductions);
    assert.equal(e.netPayBeforeTds, p.netPayBeforeTDS);
  });

  test('rollback: a finalization that fails finalizes nothing, and the run can still be finalized', async () => {
    const original = auditService.log;
    auditService.log = async function failing(params, session) {
      if (params.action === 'PAYROLL_FINALIZED') throw new Error('Injected finalization failure');
      return original.call(this, params, session);
    };
    try {
      const failed = await s.approver.post(`/payroll-runs/${s.marchRun}/finalize`);
      assert.equal(failed.status, 500, JSON.stringify(failed.body));
    } finally {
      auditService.log = original;
    }
    // Snapshots are materialised before the finalization transaction; what must roll back is the
    // finalization itself: no snapshot is FINALIZED, none is immutable, the run is not FINALIZED.
    const rows = await snapshotsOf(s.marchRun);
    assert.ok(rows.length > 0, 'materialisation is a separate, earlier step');
    assert.ok(rows.every((row) => row.snapshotStatus !== 'FINALIZED'), 'nothing was finalized');
    const run = (await s.approver.get(`/payroll-runs/${s.marchRun}`)).body.data.run;
    assert.notEqual(run.status, 'FINALIZED');
    assert.equal(await db().collection('payrollstagingresults').countDocuments({ runId: oid(s.marchRun), 'payrollInputs.statutoryBases': { $exists: true } }) > 0, true, 'staging is intact');
  });

  test('snapshot: the exact calculated bases are frozen, and an idempotent retry finalizes once', async () => {
    const key = `finalize-${crypto.randomUUID()}`;
    const first = await s.approver.post(`/payroll-runs/${s.marchRun}/finalize`, {}, { 'Idempotency-Key': key });
    expectStatus(first, 200);
    const count = (await snapshotsOf(s.marchRun)).length;
    const retry = await s.approver.post(`/payroll-runs/${s.marchRun}/finalize`, {}, { 'Idempotency-Key': key });
    expectStatus(retry, 200);
    assert.equal((await snapshotsOf(s.marchRun)).length, count, 'the retry replayed the first result and added nothing');

    const snapshots = await snapshotsOf(s.marchRun);
    s.marchSnapshots = snapshots;
    const kavya = snapshotFor(snapshots, s.kavya);
    assert.deepEqual(kavya.payrollInputs.statutoryBases, s.kavyaMarch.payrollInputs.statutoryBases, 'copied exactly as staging held it');
    assert.equal(kavya.payrollInputs.grossMonthly, KAVYA.gross);
    assert.equal(kavya.payrollResults.esi.employeeEsi, KAVYA.employeeEsi);
    assert.equal(kavya.payrollResults.pt.pt, KAVYA.pt);
    assert.equal(kavya.payrollResults.netPayBeforeTDS, KAVYA.netPayBeforeTDS);
    assert.equal(verifySnapshotHash(await PayrollSnapshot.findById(kavya._id)).valid, true);
    assert.equal((await s.auditor.get(`/payroll-snapshots/${kavya._id}/verify`)).body.data.valid, true);
  });

  // ─── Identity rule and partial inclusion ───────────────────────────────────

  test('identity: all components included means the basis equals earned gross, residual recorded', async () => {
    const ivan = await stagingOf(s.marchRun, s.ivan);
    assert.equal(ivan.payrollInputs.statutoryBases.esiContributionWage, ivan.payrollInputs.grossMonthly);
    assert.equal(ivan.payrollInputs.statutoryBases.ptSlabWage, ivan.payrollInputs.grossMonthly);
    assert.equal(ivan.esi.employeeEsi, 150);
    assert.equal(ivan.pt.pt, 200);
    assert.equal(ivan.netPayBeforeTDS, 18210, 'a default employee is calculated exactly as before this phase');

    // A prorated joiner where the individually rounded lines are a paisa short of the gross.
    const tara = await stagingOf(s.marchRun, s.tara);
    assert.equal(tara.payrollInputs.statutoryBases.lineRoundingResidual, -1);
    assert.equal(tara.payrollInputs.statutoryBases.esiContributionWage, tara.payrollInputs.grossMonthly, 'earned gross, not the line sum');
  });

  test('identity transition: one zero-amount excluded line moves the basis from earned gross to the line sum', async () => {
    const tara = await stagingOf(s.marchRun, s.tara);
    const tara2 = await stagingOf(s.marchRun, s.tara2);
    assert.equal(tara2.payrollInputs.grossMonthly, tara.payrollInputs.grossMonthly, 'same gross');
    assert.equal(
      tara2.payrollInputs.statutoryBases.esiContributionWage,
      round2(tara.payrollInputs.statutoryBases.esiContributionWage + tara.payrollInputs.statutoryBases.lineRoundingResidual / 100),
      'the line sum, which differs from earned gross by exactly the recorded residual'
    );
    assert.equal(tara2.payrollInputs.statutoryBases.ptSlabWage, tara2.payrollInputs.grossMonthly, 'PT still includes every line: identity there');
  });

  test('joiner: the bases are the sums of the included, individually prorated and rounded lines', async () => {
    const nina = await stagingOf(s.marchRun, s.nina);
    assert.deepEqual([nina.payrollInputs.paidDays, nina.payrollInputs.prorationFactor], [12, 0.387097]);
    const earned = (code) => nina.compensationSnapshot.lines.find((entry) => entry.componentCode === code).amountEarned;
    const sumOf = (...codes) => round2(codes.reduce((total, code) => total + earned(code), 0));

    assert.equal(sumOf('BASIC', 'HRA', 'SPECIAL', 'PT_OUT'), 3058.08);
    assert.equal(nina.payrollInputs.statutoryBases.esiContributionWage, 3058.08, 'ESI wage: everything but ESI_OUT');
    assert.equal(sumOf('BASIC', 'HRA', 'SPECIAL', 'ESI_OUT'), 3445.17);
    assert.equal(nina.payrollInputs.statutoryBases.ptSlabWage, 3445.17, 'PT wage (earned basis): everything but PT_OUT');
    assert.equal(nina.payrollInputs.grossMonthly, 4025.81);
    assert.equal(nina.payrollInputs.statutoryBases.lineRoundingResidual, 1);
    assert.equal(nina.esi.employeeEsi, Math.ceil(round2(3058.08 * 0.0075)));
    assert.equal(nina.esi.employerEsi, Math.ceil(round2(3058.08 * 0.0325)));
    assert.equal(nina.pt.pt, 0, 'an earned PT wage of 3,445.17 is in the nil slab');
  });

  test('leaver: the same, for the days worked', async () => {
    const leo = await stagingOf(s.marchRun, s.leo);
    assert.deepEqual([leo.payrollInputs.paidDays, leo.payrollInputs.prorationFactor], [10, 0.322581]);
    const earned = (code) => leo.compensationSnapshot.lines.find((entry) => entry.componentCode === code).amountEarned;
    assert.equal(leo.payrollInputs.statutoryBases.esiContributionWage, round2(earned('BASIC') + earned('HRA') + earned('SPECIAL') + earned('PT_OUT')));
    assert.equal(leo.payrollInputs.statutoryBases.esiContributionWage, 2548.38);
    assert.equal(leo.payrollInputs.statutoryBases.ptSlabWage, 2870.96);
    assert.ok(leo.netPayBeforeTDS > 0);
  });

  // ─── Legacy compatibility ──────────────────────────────────────────────────

  test('no compensation version: the salary-bucket path reproduces the old behaviour and says so', async () => {
    const lena = await stagingOf(s.marchRun, s.legacy);
    assert.deepEqual(lena.payrollInputs.statutoryBases, {
      esiContributionWage: 20000, ptSlabWage: 20000,
      inclusionSource: { esiContribution: 'LEGACY_SALARY_BUCKETS', ptSlab: 'LEGACY_SALARY_BUCKETS' },
      basisSource: 'SALARY_STRUCTURE_BUCKETS',
    });
    assert.equal(lena.compensationSnapshot, undefined);
    assert.equal(lena.esi.employeeEsi, 150);
    assert.equal(lena.pt.pt, 200);
    assert.equal(lena.netPayBeforeTDS, 18210);
  });

  test('a compensation version that drifted from its projection keeps its existing behaviour, labelled and unchanged', async () => {
    const drew = await stagingOf(s.marchRun, s.drew);
    assert.equal(drew.payrollInputs.grossMonthly, 14001, 'the projection is paid, as before');
    assert.equal(drew.compensationSnapshot, undefined, 'and no breakdown that would contradict it is frozen');
    assert.deepEqual(drew.payrollInputs.statutoryBases, {
      esiContributionWage: 14001, ptSlabWage: 14001, basisSource: 'UNRESOLVED_PROJECTION_DRIFT',
    });
    assert.equal('inclusionSource' in drew.payrollInputs.statutoryBases, false, 'no inclusion decision is claimed');
    assert.equal(drew.esi.employeeEsi, Math.ceil(round2(14001 * 0.0075)), 'ESI on gross: no silent re-basing, and no new fallback invented');
    assert.equal(drew.pt.pt, 200);
  });

  test('no rule matrix is active: the frozen flag decides, whatever the nature or any fixture matrix says', async () => {
    s.aprilRun = await processRun(s.payrollAdmin, APRIL);
    s.mayRun = await processRun(s.payrollAdmin, MAY);
    const mina = await stagingOf(s.mayRun, s.mina);

    // NATURE_IN is classified FIXTURE_NATURE_A, which the May rule's fixture matrix EXCLUDES. Its flags say INCLUDED.
    assert.equal(mina.payrollInputs.grossMonthly, 20000);
    assert.equal(mina.payrollInputs.statutoryBases.esiContributionWage, 20000, 'the matrix is not read');
    assert.equal(mina.esi.employeeEsi, 150);
    assert.equal(mina.pt.pt, 200);
    assert.equal(mina.payrollInputs.statutoryBases.inclusionSource.esiContribution, 'LEGACY_TREATMENT_FLAGS');
    const esiRule = mina.ruleProvenance.find((entry) => entry.ruleType === 'ESI');
    assert.ok(esiRule.parameters.statutoryInclusion, 'the fixture rule really was the one in force');

    // No statutoryNature anywhere is required: Kavya's lines are all unclassified.
    const kavyaVersion = await db().collection('compensationversions').findOne({ employeeId: oid(s.kavya) });
    assert.ok(kavyaVersion.lines.some((entry) => entry.statutoryNature == null));
    const kavyaMay = await stagingOf(s.mayRun, s.kavya);
    assert.deepEqual(kavyaMay.payrollInputs.statutoryBases, s.kavyaMarch.payrollInputs.statutoryBases);
  });

  test('a historically excluded line stays excluded: a later catalogue change does not reach frozen history', async () => {
    // ESI_OUT was excluded from the ESI wage when Kavya's compensation was written.
    expectStatus(await s.payrollAdmin.patch('/compensation/components/ESI_OUT', { treatments: { esiWage: 'INCLUDED' } }), 200);
    const catalogue = (await s.auditor.get('/compensation/components')).body.data.components.find((component) => component.code === 'ESI_OUT');
    assert.equal(catalogue.treatments.esiWage, 'INCLUDED', 'today\'s catalogue now says included');

    const juneLikeRun = await processRun(s.payrollAdmin, { periodMonth: 6, periodYear: 2026 });
    const kavya = await stagingOf(juneLikeRun, s.kavya);
    assert.equal(kavya.payrollInputs.statutoryBases.esiContributionWage, KAVYA.esiContributionWage, 'the frozen flag, not today\'s catalogue');
    assert.equal(kavya.esi.employeeEsi, KAVYA.employeeEsi);
  });

  test('preview: the baseline is the stored version, so a catalogue change moves only the proposal', async () => {
    const preview = await s.payrollAdmin.post(`/employees/${s.kavya}/compensation/impact-preview`, {
      effectiveFrom: '2026-03-01', workState: 'MH', lines: KAVYA_LINES,
    });
    expectStatus(preview, 200);
    const { impact } = preview.body.data;
    // Before: the stored version, as recorded. PF 480 + ESI 60 + PT 175.
    assert.equal(impact.monthlyEmployeeDeductions.before, KAVYA.totalEmployeeDeductions);
    // After: the same lines evaluated by today's catalogue, where ESI_OUT is now in the ESI wage.
    // ESI on 10,400 = ceil(78) = 78; PT wage 8,900 -> 175; PF 480.
    assert.equal(impact.monthlyEmployeeDeductions.after, 733);
    assert.equal(impact.monthlyNetPayBeforeTds.before, KAVYA.netPayBeforeTDS);
  });

  // ─── Determinism ───────────────────────────────────────────────────────────

  test('deterministic repeat: the same compensation in another period gives the same bases and results', async () => {
    // Full-month employees only: a mid-month joiner's April is a different (full) month by design.
    for (const employee of [s.kavya, s.ivan]) {
      const march = await stagingOf(s.marchRun, employee);
      const april = await stagingOf(s.aprilRun, employee);
      assert.deepEqual(april.payrollInputs.statutoryBases, march.payrollInputs.statutoryBases);
      for (const key of ['epf', 'esi', 'pt', 'totalEmployeeDeductions', 'netPayBeforeTDS']) assert.deepEqual(april[key], march[key], key);
    }
  });

  test('historical isolation: the finalized March snapshots did not move, and still verify', async () => {
    for (const before of s.marchSnapshots) {
      const after = await db().collection('payrollsnapshots').findOne({ _id: before._id });
      assert.deepEqual(after, before, 'byte for byte');
      assert.equal((await s.auditor.get(`/payroll-snapshots/${before._id}/verify`)).body.data.valid, true);
    }
  });

  // ─── Pay basis and tenant isolation ────────────────────────────────────────

  test('full-month PT basis, in another company: the slab is read from the full-month PT wage; nothing crosses companies', async () => {
    expectStatus(await ownerB.post('/auth/register', {
      name: 'Owner Two', email: 'owner.b@example.com', password: PASSWORD, confirmPassword: PASSWORD, companyName: 'Other Co',
    }), 201);
    for (const [name, email, role] of [
      ['Bela Preparer', 'payroll.b@example.com', 'payroll_admin'],
      ['Bhanu Approver', 'approver.b@example.com', 'payroll_approver'],
    ]) expectStatus(await ownerB.post('/company/users', { name, email, role, password: PASSWORD }), 201);
    const payrollAdminB = await login('payroll.b@example.com');
    const approverB = await login('approver.b@example.com');
    expectStatus(await ownerB.patch('/company/settings', { settings: { professionalTaxBasis: 'FULL_MONTHLY_GROSS' } }), 200);

    for (const component of [
      { code: 'ESI_OUT', name: 'Outside ESI wage', treatments: { esiWage: 'EXCLUDED', ptWage: 'INCLUDED' } },
      { code: 'PT_OUT', name: 'Outside PT wage', treatments: { esiWage: 'INCLUDED', ptWage: 'EXCLUDED' } },
    ]) expectStatus(await payrollAdminB.post('/compensation/components', { type: 'EARNING', ...component }), 201);
    const bina = await createEmployee(ownerB, 'Bina', 'Shah', '2026-03-20');
    await recordCompensation(payrollAdminB, approverB, bina, '2026-03-20', KAVYA_LINES);
    const runB = await processRun(payrollAdminB, MARCH);
    const result = await stagingOf(runB, bina);

    assert.equal(result.payrollInputs.statutoryBases.esiContributionWage, 3058.08, 'ESI wage is earned, partial');
    assert.equal(result.payrollInputs.statutoryBases.ptSlabWage, 8900, 'PT slab wage is the FULL-month PT wage: 4000 + 1600 + 800 + 2500');
    assert.equal(result.pt.pt, 175);
    assert.equal(result.payrollInputs.professionalTaxBasis, 'FULL_MONTHLY_GROSS');

    // Company A's earned-basis joiner in the same month is unaffected by company B's setting.
    const nina = await stagingOf(s.marchRun, s.nina);
    assert.equal(nina.payrollInputs.statutoryBases.ptSlabWage, 3445.17);
    // And neither company can read the other's snapshot.
    expectStatus(await approverB.get(`/payroll-snapshots/${snapshotFor(s.marchSnapshots, s.kavya)._id}/verify`), 404);
  });
});
