/**
 * test_wave35_phase1b.js — Wave 3.5 Phase 1B: schema and historical plumbing.
 *
 * Runner: node:test. Real Express app, real MongoDB replica set, isolated
 * database (WAVE35B_MONGO_URI, default payguard_wave35b_test), dropped before and
 * after.
 *
 * This phase adds STRUCTURE ONLY and must change no payroll behaviour:
 *   - a nullable statutoryNature on catalogue components and on new
 *     compensation version lines
 *   - optional inclusion-matrix and continuity containers on rule versions
 *   - an optional payrollInputs.statutoryBases sub-document on staging and
 *     snapshots, copied conditionally into a snapshot
 *
 * It deliberately asserts NO new ESI or PT behaviour. Where a matrix or a
 * classification is present, the proof is that payroll is calculated exactly as
 * it is without them.
 *
 * Every nature key and matrix entry below is a TEST FIXTURE. None is a statement
 * about what the law includes; production values need compliance approval.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'wave35b-test-secret-that-is-long-enough';
process.env.FIELD_ENCRYPTION_KEYS = `v1:${crypto.randomBytes(32).toString('base64')}`;
process.env.FIELD_ENCRYPTION_ACTIVE_KEY = 'v1';
process.env.FIELD_BLIND_INDEX_KEY = crypto.randomBytes(32).toString('hex');

const TEST_DB_URI = process.env.WAVE35B_MONGO_URI || 'mongodb://127.0.0.1:27018/payguard_wave35b_test?replicaSet=rs0';
const BACKEND = path.dirname(fileURLToPath(import.meta.url));

const { default: app } = await import('./src/app.js');
const { default: CompensationComponent } = await import('./src/models/CompensationComponent.js');
const { default: CompensationVersion } = await import('./src/models/CompensationVersion.js');
const { default: ComplianceRuleVersion } = await import('./src/models/ComplianceRuleVersion.js');
const { default: PayrollStagingResult } = await import('./src/models/PayrollStagingResult.js');
const { default: PayrollSnapshot, computeSnapshotHash, verifySnapshotHash } = await import('./src/models/PayrollSnapshot.js');
const { supportsTransactions } = await import('./src/utils/transaction.js');

const PASSWORD = 'StrongPass123';
const fixed = (componentCode, amount) => ({ componentCode, calculationMethod: 'FIXED_AMOUNT', basis: { amount } });

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

before(async () => {
  await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 5000 });
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  assert.equal(await supportsTransactions(), true, 'Wave 3.5 Phase 1B tests need a replica set');
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

describe('Wave 3.5 Phase 1B — schema and historical plumbing', () => {
  const owner = createClient();
  const ownerB = createClient();
  const s = {};

  const db = () => mongoose.connection.db;
  const oid = (value) => new mongoose.Types.ObjectId(value);
  const MARCH = { periodMonth: 3, periodYear: 2026 };
  const MAY = { periodMonth: 5, periodYear: 2026 };

  const stagingOf = (runId, employeeId) => db().collection('payrollstagingresults')
    .findOne({ runId: oid(runId), employeeId: oid(employeeId) });

  const createEmployee = async (client, firstName, lastName) => {
    const res = await client.post('/employees', {
      firstName, lastName, email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`,
      department: 'Engineering', position: 'Engineer', salary: 20000, hireDate: '2024-01-15', status: 'active',
    });
    expectStatus(res, 201);
    return res.body.data.employee._id;
  };

  const processRun = async (client, period) => {
    const created = await client.post('/payroll-runs', period);
    expectStatus(created, 201);
    const runId = created.body.data.run._id;
    expectStatus(await client.post(`/payroll-runs/${runId}/process`), 200);
    return runId;
  };

  // The statutory figures every full-month, 20,000-gross, 12,000-basic employee
  // gets in this suite. They are the same numbers Wave 3.5's own tests assert, so
  // "unchanged" means unchanged from the pre-1B checkpoint.
  const EXPECTED_FULL_MONTH = {
    gross: 20000, employeeEpf: 1440, employeeEsi: 150, pt: 200, totalEmployeeDeductions: 1790, netPayBeforeTDS: 18210,
  };
  const figures = (result) => ({
    gross: result.payrollInputs.grossMonthly,
    employeeEpf: result.epf.employeeEpf,
    employeeEsi: result.esi.employeeEsi,
    pt: result.pt.pt,
    totalEmployeeDeductions: result.totalEmployeeDeductions,
    netPayBeforeTDS: result.netPayBeforeTDS,
  });

  // ─── Setup ─────────────────────────────────────────────────────────────────

  test('setup: company, people, and rule versions with and without inclusion containers', async () => {
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
    const epfParams = { employeeContributionRate: 0.12, employerContributionRate: 0.12, wageCapForContribution: 15000, epsRate: 0.0833, epsWageCeiling: 15000, roundingMode: 'NEAREST_RUPEE' };
    const esiBase = { employeeContributionRate: 0.0075, employerContributionRate: 0.0325, grossWageCeiling: 21000, roundingMode: 'CEIL_RUPEE' };
    const slabs = [{ upTo: 7500, monthlyTax: 0 }, { upTo: 10000, monthlyTax: 175 }, { upTo: null, monthlyTax: 200 }];

    await ComplianceRuleVersion.create([
      { ruleType: 'EPF', jurisdiction: 'IN', effectiveFrom: new Date('2014-09-01'), createdBy, description: 'EPF', epfParams },
      // v1: no inclusion matrix, no continuity. Every rule in production looks like this.
      { ruleType: 'ESI', jurisdiction: 'IN', effectiveFrom: new Date('2019-07-01'), effectiveTo: new Date('2026-04-30'), createdBy, description: 'ESI v1', esiParams: esiBase },
      { ruleType: 'PT', jurisdiction: 'MH', effectiveFrom: new Date('2000-01-01'), effectiveTo: new Date('2026-04-30'), createdBy, description: 'MH PT v1', ptSlabs: slabs },
      // v2: IDENTICAL rates and slabs, plus the optional containers, filled with TEST FIXTURE values.
      {
        ruleType: 'ESI', jurisdiction: 'IN', effectiveFrom: new Date('2026-05-01'), createdBy, description: 'ESI v2 (fixture matrix)',
        esiParams: {
          ...esiBase,
          statutoryInclusion: {
            coverage: [{ nature: 'FIXTURE_NATURE_A', inclusion: 'EXCLUDED' }, { nature: 'FIXTURE_NATURE_B', inclusion: 'INCLUDED' }],
            contribution: [{ nature: 'FIXTURE_NATURE_A', inclusion: 'EXCLUDED' }],
          },
          coverageContinuity: { mode: 'CONTRIBUTION_PERIOD', periods: [{ startMonth: 4, endMonth: 9 }, { startMonth: 10, endMonth: 3 }] },
        },
      },
      {
        ruleType: 'PT', jurisdiction: 'MH', effectiveFrom: new Date('2026-05-01'), createdBy, description: 'MH PT v2 (fixture matrix)', ptSlabs: slabs,
        ptInclusion: [{ nature: 'FIXTURE_NATURE_A', inclusion: 'EXCLUDED' }],
      },
    ]);

    s.asha = await createEmployee(owner, 'Asha', 'Verma');
    s.meera = await createEmployee(owner, 'Meera', 'Iyer');
    const salary = await s.payrollAdmin.post(`/employees/${s.asha}/salary`, {
      effectiveFrom: '2026-01-01', components: { basic: 12000, hra: 4800, specialAllowance: 3200 },
      workState: 'MH', pfEnrolled: true, esiEnrolled: true, ptEnrolled: true,
    });
    expectStatus(salary, 201);
  });

  // ─── Step 2: the catalogue component ───────────────────────────────────────

  test('A. a component stored without statutoryNature still loads, unclassified, and is not rewritten', async () => {
    const collection = db().collection('compensationcomponents');
    await collection.updateOne({ companyId: oid(s.companyId), code: 'CONVEYANCE' }, { $unset: { statutoryNature: '' } });
    const before = await collection.findOne({ companyId: oid(s.companyId), code: 'CONVEYANCE' });
    assert.equal('statutoryNature' in before, false, 'this is what a pre-1B document looks like');

    const hydrated = await CompensationComponent.findOne({ companyId: oid(s.companyId), code: 'CONVEYANCE' });
    assert.equal(hydrated.statutoryNature, null, 'unclassified, never a guessed legal class');

    const listed = (await s.auditor.get('/compensation/components')).body.data.components;
    assert.equal(listed.find((component) => component.code === 'CONVEYANCE').statutoryNature, null);

    const after = await collection.findOne({ companyId: oid(s.companyId), code: 'CONVEYANCE' });
    assert.deepEqual(after, before, 'reading it wrote nothing');
  });

  test('no default component is assigned a legal classification', async () => {
    const docs = await db().collection('compensationcomponents').find({ companyId: oid(s.companyId) }).toArray();
    assert.ok(docs.length >= 15, 'the default catalogue was seeded');
    for (const doc of docs) {
      assert.ok(doc.statutoryNature == null, `${doc.code} must stay unclassified, found ${doc.statutoryNature}`);
    }
  });

  test('B. a new component round-trips its nature; syntax is validated, meaning is not', async () => {
    const created = await s.payrollAdmin.post('/compensation/components', {
      code: 'FIXTURE_ALLOWANCE', name: 'Fixture allowance', type: 'EARNING',
      statutoryNature: 'fixture_nature_a',
      treatments: { pfWage: 'EXCLUDED', esiWage: 'EXCLUDED', ptWage: 'EXCLUDED' },
    });
    expectStatus(created, 201);
    assert.equal(created.body.data.component.statutoryNature, 'FIXTURE_NATURE_A', 'the key is normalized, nothing else');

    const raw = await db().collection('compensationcomponents').findOne({ companyId: oid(s.companyId), code: 'FIXTURE_ALLOWANCE' });
    assert.equal(raw.statutoryNature, 'FIXTURE_NATURE_A');
    const listed = (await s.auditor.get('/compensation/components')).body.data.components.find((c) => c.code === 'FIXTURE_ALLOWANCE');
    assert.equal(listed.statutoryNature, 'FIXTURE_NATURE_A');

    for (const bad of ['bad nature!', 'A', '1STARTS_WITH_DIGIT', 'X'.repeat(41)]) {
      const rejected = await s.payrollAdmin.post('/compensation/components', {
        code: 'REJECTED_ALLOWANCE', name: 'Rejected', type: 'EARNING', statutoryNature: bad,
      });
      expectStatus(rejected, 422);
      assert.equal(rejected.body.code, 'VALIDATION_FAILED');
    }
    assert.equal(await CompensationComponent.countDocuments({ companyId: oid(s.companyId), code: 'REJECTED_ALLOWANCE' }), 0);

    // Unknown to every rule is still accepted: the application attaches no meaning.
    expectStatus(await s.payrollAdmin.post('/compensation/components', {
      code: 'UNMATCHED_ALLOWANCE', name: 'Unmatched', type: 'EARNING', statutoryNature: 'NOT_IN_ANY_MATRIX',
    }), 201);
    const nullNature = await s.payrollAdmin.post('/compensation/components', {
      code: 'PLAIN_ALLOWANCE', name: 'Plain', type: 'EARNING', statutoryNature: null,
    });
    expectStatus(nullNature, 201);
    assert.equal(nullNature.body.data.component.statutoryNature, null);
  });

  test('classifying a component later appends a version and never rewrites the old one', async () => {
    const before = await db().collection('compensationcomponents').findOne({ companyId: oid(s.companyId), code: 'PLAIN_ALLOWANCE', version: 1 });
    const updated = await s.payrollAdmin.patch('/compensation/components/PLAIN_ALLOWANCE', { statutoryNature: 'FIXTURE_NATURE_B' });
    expectStatus(updated, 200);
    assert.equal(updated.body.data.component.version, 2);
    assert.equal(updated.body.data.component.statutoryNature, 'FIXTURE_NATURE_B');

    const versions = await db().collection('compensationcomponents')
      .find({ companyId: oid(s.companyId), code: 'PLAIN_ALLOWANCE' }).sort({ version: 1 }).toArray();
    assert.equal(versions.length, 2);
    assert.equal(versions[0].statutoryNature, before.statutoryNature, 'version 1 keeps the nature it had');
    assert.equal(versions[0].isCurrent, false);

    const same = await s.payrollAdmin.patch('/compensation/components/PLAIN_ALLOWANCE', { statutoryNature: 'FIXTURE_NATURE_B' });
    expectStatus(same, 422);
    assert.equal(same.body.code, 'NO_CHANGE');
    const legacyUnchanged = await s.payrollAdmin.patch('/compensation/components/CONVEYANCE', { name: 'Conveyance allowance' });
    expectStatus(legacyUnchanged, 422);
    assert.equal(legacyUnchanged.body.code, 'NO_CHANGE', 'a pre-1B definition with no nature still counts as unchanged');
  });

  // ─── Step 3: the version line ──────────────────────────────────────────────

  test('C. a new compensation version copies the component nature onto its lines', async () => {
    const proposal = await s.payrollAdmin.post(`/employees/${s.meera}/compensation/changes`, {
      effectiveFrom: '2026-01-01',
      reason: 'Meera joins with a fixture allowance',
      workState: 'MH',
      lines: [fixed('BASIC', 12000), fixed('HRA', 4800), fixed('SPECIAL', 1200), fixed('FIXTURE_ALLOWANCE', 2000)],
    });
    expectStatus(proposal, 201);
    const changeId = proposal.body.data.change.id;
    expectStatus(await s.payrollAdmin.post(`/compensation/changes/${changeId}/submit`), 200);
    expectStatus(await s.approver.post(`/compensation/changes/${changeId}/approve`), 200);

    const current = (await s.auditor.get(`/employees/${s.meera}/compensation`)).body.data.current;
    const line = (code) => current.lines.find((entry) => entry.componentCode === code);
    assert.equal(line('FIXTURE_ALLOWANCE').statutoryNature, 'FIXTURE_NATURE_A');
    assert.equal(line('BASIC').statutoryNature, null, 'an unclassified component is written as null, not as a guessed class');

    const raw = await db().collection('compensationversions').findOne({ employeeId: oid(s.meera), isCurrent: true });
    const rawLine = (code) => raw.lines.find((entry) => entry.componentCode === code);
    assert.equal(rawLine('FIXTURE_ALLOWANCE').statutoryNature, 'FIXTURE_NATURE_A');
    assert.ok('statutoryNature' in rawLine('BASIC') && rawLine('BASIC').statutoryNature === null, 'recorded explicitly');
    s.meeraVersionId = raw._id;

    // The nature is frozen on the line: classifying the catalogue differently later does not reach it.
    expectStatus(await s.payrollAdmin.patch('/compensation/components/FIXTURE_ALLOWANCE', { statutoryNature: 'FIXTURE_NATURE_B' }), 200);
    const afterCatalogueChange = await db().collection('compensationversions').findOne({ _id: s.meeraVersionId });
    assert.equal(
      afterCatalogueChange.lines.find((entry) => entry.componentCode === 'FIXTURE_ALLOWANCE').statutoryNature,
      'FIXTURE_NATURE_A',
      'history is not reconstructed from today\'s catalogue'
    );
  });

  // ─── Step 4 / F: rule-version containers ───────────────────────────────────

  test('F. the inclusion and continuity containers round-trip and validate', async () => {
    const stored = await ComplianceRuleVersion.findOne({ ruleType: 'ESI', description: 'ESI v2 (fixture matrix)' }).lean();
    assert.deepEqual(stored.esiParams.statutoryInclusion.coverage, [
      { nature: 'FIXTURE_NATURE_A', inclusion: 'EXCLUDED' }, { nature: 'FIXTURE_NATURE_B', inclusion: 'INCLUDED' },
    ]);
    assert.deepEqual(stored.esiParams.statutoryInclusion.contribution, [{ nature: 'FIXTURE_NATURE_A', inclusion: 'EXCLUDED' }]);
    assert.deepEqual(stored.esiParams.coverageContinuity, {
      mode: 'CONTRIBUTION_PERIOD', periods: [{ startMonth: 4, endMonth: 9 }, { startMonth: 10, endMonth: 3 }],
    });
    const pt = await ComplianceRuleVersion.findOne({ ruleType: 'PT', description: 'MH PT v2 (fixture matrix)' }).lean();
    assert.deepEqual(pt.ptInclusion, [{ nature: 'FIXTURE_NATURE_A', inclusion: 'EXCLUDED' }]);

    const probe = (overrides) => new ComplianceRuleVersion({
      ruleType: 'ESI', jurisdiction: 'IN', effectiveFrom: new Date('2030-01-01'), createdBy: new mongoose.Types.ObjectId(),
      esiParams: { employeeContributionRate: 0.0075, employerContributionRate: 0.0325, grossWageCeiling: 21000, ...overrides },
    }).validateSync();
    assert.equal(probe({}), undefined, 'a rule with no containers is valid exactly as before');
    assert.ok(probe({ statutoryInclusion: { coverage: [{ nature: 'FIXTURE_NATURE_A', inclusion: 'MAYBE' }] } }), 'inclusion must be INCLUDED or EXCLUDED');
    assert.ok(probe({ statutoryInclusion: { coverage: [{ nature: 'lower case', inclusion: 'INCLUDED' }] } }), 'nature syntax is checked');
    assert.ok(probe({
      statutoryInclusion: { contribution: [{ nature: 'FIXTURE_NATURE_A', inclusion: 'INCLUDED' }, { nature: 'FIXTURE_NATURE_A', inclusion: 'EXCLUDED' }] },
    }), 'a nature may appear only once');
    assert.ok(probe({ coverageContinuity: { mode: 'ALWAYS' } }), 'continuity mode is an enumerated mechanism');
    assert.ok(probe({ coverageContinuity: { mode: 'CONTRIBUTION_PERIOD', periods: [{ startMonth: 13, endMonth: 3 }] } }), 'months are 1 to 12');
  });

  test('E. a rule without containers carries none into its frozen parameters', async () => {
    const v1 = await ComplianceRuleVersion.findOne({ ruleType: 'ESI', description: 'ESI v1' }).lean();
    assert.equal('statutoryInclusion' in v1.esiParams, false);
    assert.equal('coverageContinuity' in v1.esiParams, false);
    const v1Pt = await ComplianceRuleVersion.findOne({ ruleType: 'PT', description: 'MH PT v1' }).lean();
    assert.equal('ptInclusion' in v1Pt, false);
  });

  // ─── Payroll under a rule without containers (E) ───────────────────────────

  test('E. payroll under a rule with no containers is calculated exactly as before', async () => {
    s.marchRun = await processRun(s.payrollAdmin, MARCH);
    const asha = await stagingOf(s.marchRun, s.asha);
    const meera = await stagingOf(s.marchRun, s.meera);

    assert.deepEqual(figures(asha), EXPECTED_FULL_MONTH, 'the control, with every component in every wage, is exactly as before');

    // Phase 1C: ESI and PT are calculated on their own wage, by the treatment flags frozen on each line.
    // Meera's 2,000 FIXTURE_ALLOWANCE is flagged outside the ESI wage and the PT wage, so ESI is charged on
    // 18,000 (135) where gross-based it was 20,000 (150). PT stays 200: 18,000 is in the same slab.
    assert.deepEqual(figures(meera), {
      gross: 20000, employeeEpf: 1440, employeeEsi: 135, pt: 200, totalEmployeeDeductions: 1775, netPayBeforeTDS: 18225,
    });
    assert.equal(asha.payrollInputs.statutoryBases.esiContributionWage, 20000);
    assert.equal(meera.payrollInputs.statutoryBases.esiContributionWage, 18000);
    assert.equal(meera.payrollInputs.statutoryBases.ptSlabWage, 18000);
    assert.equal(meera.payrollInputs.statutoryBases.inclusionSource.esiContribution, 'LEGACY_TREATMENT_FLAGS');
    const esiProvenance = asha.ruleProvenance.find((entry) => entry.ruleType === 'ESI');
    assert.equal('statutoryInclusion' in esiProvenance.parameters, false);
    assert.equal('coverageContinuity' in esiProvenance.parameters, false);
  });

  test('H. a snapshot in the pre-statutoryBases shape verifies and stays identical; a new one carries and verifies its bases', async () => {
    expectStatus(await s.approver.post(`/payroll-runs/${s.marchRun}/finalize`), 200);
    const snapshots = (await s.approver.get(`/payroll-runs/${s.marchRun}/snapshots?limit=50`)).body.data.snapshots;
    s.marchSnapshotIds = snapshots.map((snapshot) => snapshot._id);
    assert.equal(snapshots.length, 2);

    // Phase 1C: payroll now writes statutoryBases, so these snapshots carry them, hashed with the rest.
    for (const id of s.marchSnapshotIds) {
      const raw = await db().collection('payrollsnapshots').findOne({ _id: oid(id) });
      assert.equal(raw.payrollInputs.statutoryBases.basisSource, 'COMPENSATION_LINES');
      assert.equal((await s.auditor.get(`/payroll-snapshots/${id}/verify`)).body.data.valid, true);
      const hydrated = await PayrollSnapshot.findById(id);
      assert.equal(verifySnapshotHash(hydrated).valid, true);
      assert.equal(computeSnapshotHash(hydrated.toObject()), raw.snapshotHash);
    }

    // The shape written BEFORE the structure existed: same record without it, hashed as it always was.
    const source = await db().collection('payrollsnapshots').findOne({ _id: oid(s.marchSnapshotIds[0]) });
    const { statutoryBases, ...oldInputs } = source.payrollInputs;
    const legacy = { ...source, _id: new mongoose.Types.ObjectId(), payrollRunId: new mongoose.Types.ObjectId(), payrollInputs: oldInputs };
    legacy.snapshotHash = computeSnapshotHash(legacy);
    assert.notEqual(legacy.snapshotHash, source.snapshotHash, 'the structure is covered by the hash when present');
    await db().collection('payrollsnapshots').insertOne(legacy);

    assert.equal((await s.auditor.get(`/payroll-snapshots/${legacy._id}/verify`)).body.data.valid, true);
    const hydrated = await PayrollSnapshot.findById(legacy._id);
    assert.equal('statutoryBases' in hydrated.toObject().payrollInputs, false, 'loading adds nothing to the hashed shape');
    assert.equal(verifySnapshotHash(hydrated).valid, true);
    assert.equal(computeSnapshotHash(hydrated.toObject()), legacy.snapshotHash);
  });

  // ─── Payroll under a rule WITH containers (F) ──────────────────────────────

  test('F. payroll under a rule carrying a matrix is unchanged: the matrix is not read, the frozen flags still decide', async () => {
    s.mayRun = await processRun(s.payrollAdmin, MAY);
    const asha = await stagingOf(s.mayRun, s.asha);
    const meera = await stagingOf(s.mayRun, s.meera);

    // Meera's FIXTURE_ALLOWANCE (2,000) is classified FIXTURE_NATURE_A, which the v2 fixture matrix EXCLUDES
    // for ESI coverage, ESI contribution and PT, and it is flagged EXCLUDED on the component. Phase 1C applies
    // the FLAG (ESI on 18,000 = 135, as in March). The matrix is inert: had it been read, the May figures
    // would differ from March, and the nature would be consulted.
    assert.deepEqual(figures(asha), EXPECTED_FULL_MONTH);
    assert.deepEqual(figures(meera), {
      gross: 20000, employeeEpf: 1440, employeeEsi: 135, pt: 200, totalEmployeeDeductions: 1775, netPayBeforeTDS: 18225,
    });

    const marchAsha = await stagingOf(s.marchRun, s.asha);
    const marchMeera = await stagingOf(s.marchRun, s.meera);
    for (const key of ['epf', 'esi', 'pt', 'totalEmployeeDeductions', 'netPayBeforeTDS']) {
      assert.deepEqual(asha[key], marchAsha[key], `${key} equals the same month under the old rule`);
      assert.deepEqual(meera[key], marchMeera[key], `${key} (meera) equals the same month under the old rule`);
    }
    assert.deepEqual(meera.payrollInputs.statutoryBases, marchMeera.payrollInputs.statutoryBases, 'derived from the flags in both months');
    assert.equal(meera.payrollInputs.statutoryBases.inclusionSource.esiContribution, 'LEGACY_TREATMENT_FLAGS');
  });

  test('F. a rule\'s containers are frozen with its other parameters, only when it has them', async () => {
    const asha = await stagingOf(s.mayRun, s.asha);
    const esi = asha.ruleProvenance.find((entry) => entry.ruleType === 'ESI');
    assert.equal(esi.parameters.grossWageCeiling, 21000);
    assert.equal(esi.parameters.statutoryInclusion.coverage.length, 2, 'the rule as it was, frozen');
    assert.equal(esi.parameters.coverageContinuity.mode, 'CONTRIBUTION_PERIOD');
    const marchEsi = (await stagingOf(s.marchRun, s.asha)).ruleProvenance.find((entry) => entry.ruleType === 'ESI');
    assert.equal('statutoryInclusion' in marchEsi.parameters, false, 'an older rule is frozen exactly as before');
  });

  // ─── Step 5 / G: statutoryBases structure ──────────────────────────────────

  const BASES = () => ({
    esiCoverageWage: 20000,
    esiContributionWage: 20000,
    ptSlabWage: 20000,
    esiCoverage: {
      decision: 'COVERED', coverageWage: 20000, ceiling: 21000, mode: 'CONTRIBUTION_PERIOD_CONTINUITY',
      anchorDate: new Date('2026-04-01T00:00:00.000Z'),
      contributionPeriod: { start: new Date('2026-04-01T00:00:00.000Z'), end: new Date('2026-09-30T00:00:00.000Z') },
      continuityApplied: false,
    },
    inclusionSource: { esiCoverage: 'LEGACY_TREATMENT_FLAGS', esiContribution: 'LEGACY_TREATMENT_FLAGS', ptSlab: 'RULE_MATRIX' },
    basisSource: 'COMPENSATION_LINES',
    lineRoundingResidual: 0,
  });

  test('G. statutoryBases is optional and round-trips through the staging schema', async () => {
    // Optional: a staging result with none (the shape written before payroll populated it) is valid,
    // and has none after hydration.
    const rawAsha = await stagingOf(s.mayRun, s.asha);
    await db().collection('payrollstagingresults').updateOne({ _id: rawAsha._id }, { $unset: { 'payrollInputs.statutoryBases': '' } });
    const without = PayrollStagingResult.hydrate(await stagingOf(s.mayRun, s.asha));
    assert.equal(without.validateSync(), undefined);
    assert.equal('statutoryBases' in without.toObject().payrollInputs, false);

    // Present: set by hand to a value payroll does not derive (a coverage block), then read back through the model.
    await db().collection('payrollstagingresults').updateOne({ _id: rawAsha._id }, { $set: { 'payrollInputs.statutoryBases': BASES() } });
    const hydrated = PayrollStagingResult.hydrate(await stagingOf(s.mayRun, s.asha));
    assert.equal(hydrated.validateSync(), undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(hydrated.toObject().payrollInputs.statutoryBases)), JSON.parse(JSON.stringify(BASES())));

    // Enumerated fields reject unknown values.
    for (const [field, value] of [
      ['payrollInputs.statutoryBases.basisSource', 'GROSS'],
      ['payrollInputs.statutoryBases.inclusionSource.ptSlab', 'GUESSED'],
      ['payrollInputs.statutoryBases.esiCoverage.decision', 'MAYBE'],
      ['payrollInputs.statutoryBases.esiCoverage.mode', 'FOREVER'],
    ]) {
      const probe = PayrollStagingResult.hydrate(await stagingOf(s.mayRun, s.asha));
      probe.set(field, value);
      assert.ok(probe.validateSync(), `${field} = ${value} is rejected`);
    }
  });

  // ─── Step 6 / I: conditional snapshot copy ─────────────────────────────────

  test('I. a snapshot materialised from staging that carries statutoryBases persists it and verifies', async () => {
    expectStatus(await s.approver.post(`/payroll-runs/${s.mayRun}/finalize`), 200);
    const snapshots = (await s.approver.get(`/payroll-runs/${s.mayRun}/snapshots?limit=50`)).body.data.snapshots;
    const snapshotFor = (employeeId) => snapshots.find((entry) => String(entry.employeeSnapshot.employeeId) === String(employeeId));
    const ashaId = snapshotFor(s.asha)._id;
    const meeraId = snapshotFor(s.meera)._id;
    s.ashaMaySnapshotId = ashaId;

    const ashaRaw = await db().collection('payrollsnapshots').findOne({ _id: oid(ashaId) });
    assert.deepEqual(
      JSON.parse(JSON.stringify(ashaRaw.payrollInputs.statutoryBases)),
      JSON.parse(JSON.stringify(BASES())),
      'copied exactly as staging held it'
    );
    assert.equal((await s.auditor.get(`/payroll-snapshots/${ashaId}/verify`)).body.data.valid, true);
    assert.equal(verifySnapshotHash(await PayrollSnapshot.findById(ashaId)).valid, true);
    assert.equal(computeSnapshotHash(ashaRaw), ashaRaw.snapshotHash);

    // It is part of what the hash protects: altering it is detected.
    const tampered = {
      ...ashaRaw,
      payrollInputs: { ...ashaRaw.payrollInputs, statutoryBases: { ...ashaRaw.payrollInputs.statutoryBases, ptSlabWage: 1 } },
    };
    assert.notEqual(computeSnapshotHash(tampered), ashaRaw.snapshotHash, 'changing a frozen basis changes the hash');
    assert.equal(computeSnapshotHash(ashaRaw), ashaRaw.snapshotHash, 'while the untouched record still matches');

    // A neighbour keeps the bases payroll derived for it, and the hand-set structure changed no figure:
    // Asha's May money equals her own March money.
    const meeraRaw = await db().collection('payrollsnapshots').findOne({ _id: oid(meeraId) });
    assert.equal(meeraRaw.payrollInputs.statutoryBases.basisSource, 'COMPENSATION_LINES');
    assert.equal(meeraRaw.payrollInputs.statutoryBases.esiContributionWage, 18000);
    const ashaMarch = await db().collection('payrollsnapshots').findOne({
      payrollRunId: oid(s.marchRun), 'employeeSnapshot.employeeId': oid(s.asha),
    });
    assert.deepEqual(ashaRaw.payrollResults, ashaMarch.payrollResults, 'carrying the structure changed no figure');
    assert.equal(ashaRaw.payrollResults.netPayBeforeTDS, 18210);

    // And the earlier month is exactly as it was.
    for (const id of s.marchSnapshotIds) assert.equal((await s.auditor.get(`/payroll-snapshots/${id}/verify`)).body.data.valid, true);
  });

  test('G. the snapshot schema declares the same optional structure', async () => {
    // The May snapshot of Asha, whose structure includes a coverage block that payroll does not derive.
    const hydrated = await PayrollSnapshot.findById(s.ashaMaySnapshotId);
    assert.equal(hydrated.toObject().payrollInputs.statutoryBases.basisSource, 'COMPENSATION_LINES');
    assert.equal(hydrated.toObject().payrollInputs.statutoryBases.esiCoverage.decision, 'COVERED');
  });

  // ─── J: the canonical hash of an old snapshot ──────────────────────────────

  test('J. the canonical hash of a snapshot in the pre-1B shape is byte-for-byte what it was', () => {
    const id = (n) => n.toString(16).padStart(24, '0');
    const legacy = {
      companyId: id(1), payrollRunId: id(2), stagingResultId: id(3),
      periodMonth: 3, periodYear: 2026, periodStart: new Date('2026-03-01T00:00:00.000Z'), periodEnd: new Date('2026-03-31T00:00:00.000Z'),
      processingVersion: 1,
      employeeSnapshot: { employeeId: id(4), fullName: 'Asha Verma', email: 'asha.verma@example.com', department: 'Engineering', position: 'Engineer', employmentStatus: 'active', hireDate: new Date('2024-01-15T00:00:00.000Z') },
      salarySnapshot: {
        salaryStructureId: id(5), effectiveFrom: new Date('2026-01-01T00:00:00.000Z'), effectiveTo: null,
        components: { basic: 12000, hra: 4800, conveyanceAllowance: 0, medicalAllowance: 0, specialAllowance: 3200, otherAllowances: 0 },
        grossMonthly: 20000, currency: 'INR', payFrequency: 'monthly', workState: 'MH', pfEnrolled: true, esiEnrolled: true, ptEnrolled: true, pfWageOverride: null,
      },
      complianceProvenance: [
        { ruleType: 'EPF', ruleId: id(6), jurisdiction: 'IN', effectiveFrom: new Date('2014-09-01T00:00:00.000Z'), effectiveTo: null, sourceReference: 'EPF', parameters: { employeeContributionRate: 0.12, employerContributionRate: 0.12, wageCapForContribution: 15000, epsRate: 0.0833, epsWageCeiling: 15000, voluntaryContributionAllowed: true, roundingMode: 'NEAREST_RUPEE' } },
        { ruleType: 'ESI', ruleId: id(7), jurisdiction: 'IN', effectiveFrom: new Date('2019-07-01T00:00:00.000Z'), effectiveTo: null, sourceReference: 'ESI', parameters: { employeeContributionRate: 0.0075, employerContributionRate: 0.0325, grossWageCeiling: 21000, roundingMode: 'CEIL_RUPEE' } },
        { ruleType: 'PT', ruleId: id(8), jurisdiction: 'MH', effectiveFrom: new Date('2000-01-01T00:00:00.000Z'), effectiveTo: null, sourceReference: 'MH PT', parameters: { slabs: [{ upTo: 7500, monthlyTax: 0 }, { upTo: 10000, monthlyTax: 175 }, { upTo: null, monthlyTax: 200 }] } },
      ],
      payrollInputs: { grossMonthly: 20000, basicSalary: 12000, pfWageOverride: null, pfEnrolled: true, esiEnrolled: true, ptEnrolled: true, workState: 'MH', payrollDate: new Date('2026-03-31T00:00:00.000Z'), attendanceAdjustment: 'DEFERRED' },
      payrollResults: {
        epf: { enrolled: true, pfWageUsed: 12000, employeeEpf: 1440, employerEpf: 1440, epsContribution: 1000, totalEpf: 2880 },
        esi: { enrolled: true, applicable: true, employeeEsi: 150, employerEsi: 650, totalEsi: 800 },
        pt: { enrolled: true, applicable: true, pt: 200 },
        totalEmployeeDeductions: 1790, employerTotalContribution: 2090, netPayBeforeTDS: 18210, tdsStatus: 'DEFERRED', tdsAmount: null,
      },
    };
    // Captured from the code as it was at the Phase 1A checkpoint, before this phase touched anything.
    const GOLDEN = 'ca97dc1e8e700cc297ebc75811b5d0ae668d3460a0ccf08918f4a5e83ded2868';
    assert.equal(computeSnapshotHash(legacy), GOLDEN);

    // A PRESENT structure changes the hash; an ABSENT one does not.
    assert.notEqual(computeSnapshotHash({ ...legacy, payrollInputs: { ...legacy.payrollInputs, statutoryBases: BASES() } }), GOLDEN);
    // Existing behaviour worth knowing: a key that EXISTS with the value undefined is not the same as no key
    // (the canonical form turns it into null). That is why the snapshot service copies statutoryBases only
    // when staging has it, and never as an undefined key. Characterised here, not changed.
    assert.notEqual(computeSnapshotHash({ ...legacy, payrollInputs: { ...legacy.payrollInputs, statutoryBases: undefined } }), GOLDEN);
    assert.equal(computeSnapshotHash(structuredClone(legacy)), GOLDEN, 'repeatable');
  });

  // ─── D: history is never rewritten ─────────────────────────────────────────

  test('D. a compensation version written before the field existed is closed, not rewritten', async () => {
    const collection = db().collection('compensationversions');
    const original = await collection.findOne({ employeeId: oid(s.asha), isCurrent: true });
    await collection.updateOne({ _id: original._id }, { $unset: { 'lines.$[].statutoryNature': '' } });
    const legacy = await collection.findOne({ _id: original._id });
    assert.ok(legacy.lines.every((line) => !('statutoryNature' in line)), 'this is what a pre-1B version looks like');

    // Reading it through the model neither fails nor writes anything.
    const hydrated = await CompensationVersion.findById(original._id);
    assert.ok(hydrated.lines.every((line) => line.statutoryNature === undefined), 'absent, not guessed');
    assert.deepEqual(await collection.findOne({ _id: original._id }), legacy);

    // A later revision closes it through the real code path.
    const revision = await s.payrollAdmin.post(`/employees/${s.asha}/salary`, {
      effectiveFrom: '2026-06-01', components: { basic: 13000, hra: 5200, specialAllowance: 3800 },
      workState: 'MH', pfEnrolled: true, esiEnrolled: true, ptEnrolled: true,
    });
    expectStatus(revision, 201);

    const closed = await collection.findOne({ _id: original._id });
    const { effectiveTo, isCurrent, updatedAt, ...closedRest } = closed;
    const { effectiveTo: _e, isCurrent: _c, updatedAt: _u, ...legacyRest } = legacy;
    assert.deepEqual(closedRest, legacyRest, 'only the validity interval moved');
    assert.ok(closed.lines.every((line) => !('statutoryNature' in line)), 'no backfill, no inference from today\'s catalogue');
    assert.equal(closed.isCurrent, false);

    const next = await collection.findOne({ employeeId: oid(s.asha), isCurrent: true });
    assert.ok(next.lines.every((line) => 'statutoryNature' in line), 'a NEW version records the field');
    assert.equal(next.version, original.version + 1);
  });

  // ─── K / L ────────────────────────────────────────────────────────────────

  test('K. the production compliance seed carries no inclusion matrix, nature or continuity', () => {
    const seed = fs.readFileSync(path.join(BACKEND, 'scripts', 'seed-compliance-rules.js'), 'utf8');
    for (const forbidden of ['statutoryInclusion', 'ptInclusion', 'coverageContinuity', 'statutoryNature', 'FIXTURE_NATURE', 'EXCLUDED']) {
      assert.equal(seed.includes(forbidden), false, `the seed must not mention ${forbidden}`);
    }
  });

  test('L. no migration is needed: the migration tooling does not mention the new fields', () => {
    const files = [
      path.join(BACKEND, 'scripts', 'migrate.js'),
      ...fs.readdirSync(path.join(BACKEND, 'scripts', 'lib')).map((name) => path.join(BACKEND, 'scripts', 'lib', name)),
    ];
    assert.ok(files.length >= 2);
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const forbidden of ['statutoryNature', 'statutoryBases', 'statutoryInclusion', 'ptInclusion']) {
        assert.equal(text.includes(forbidden), false, `${path.basename(file)} must not mention ${forbidden}`);
      }
    }
  });

  // ─── Tenant isolation ──────────────────────────────────────────────────────

  test('another company neither sees nor changes this company\'s classified components', async () => {
    expectStatus(await ownerB.post('/auth/register', {
      name: 'Owner Two', email: 'owner.b@example.com', password: PASSWORD, confirmPassword: PASSWORD, companyName: 'Other Co',
    }), 201);
    const catalogue = (await ownerB.get('/compensation/components')).body.data.components;
    assert.ok(!catalogue.some((component) => component.code === 'FIXTURE_ALLOWANCE'));
    assert.ok(catalogue.every((component) => component.statutoryNature === null), 'their defaults are unclassified too');
    expectStatus(await ownerB.patch('/compensation/components/FIXTURE_ALLOWANCE', { statutoryNature: 'FIXTURE_NATURE_A' }), 404);

    const ours = await db().collection('compensationcomponents').findOne({ companyId: oid(s.companyId), code: 'FIXTURE_ALLOWANCE', isCurrent: true });
    assert.equal(ours.statutoryNature, 'FIXTURE_NATURE_B', 'ours is as we left it');
  });
});
