/**
 * test_wave2.js — Wave 2: workforce identity and Employee 360, over HTTP.
 *
 * Runner: node:test (Node >= 18 built-in)
 * Run:    npm test   (full suite on a replica set, transactions required)
 *
 * Real Express app on an ephemeral port, real MongoDB replica set, isolated
 * database (WAVE2_MONGO_URI, default payguard_wave2_test), dropped before and after.
 *
 * Covers:
 *   - effective-dated employment history: append-only versions, point-in-time
 *     answers, manager rules (same company, no self, no cycles), exits
 *   - employee record edits stay consistent with employment history
 *   - statutory identifiers: validation, encryption at rest, masking in every
 *     read API, per-company PAN uniqueness, versioning
 *   - reveal: permission, reason, audit-before-release, no plaintext in audit,
 *     idempotency records or logs, tamper detection
 *   - bank accounts: versioning, masking, audited reveal, shared-account flag,
 *     segregation of duties (payroll preparers cannot change bank accounts)
 *   - documents: verification by a different person, final decisions
 *   - payroll readiness READY / WARNING / BLOCKED, identical to preflight
 *   - historical isolation: finalized payslips never absorb profile changes
 *   - transactions: an employment change rolls back when its audit write fails
 *   - migration backfills employment history for older employees
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
process.env.JWT_SECRET = process.env.JWT_SECRET || 'wave2-test-secret-that-is-long-enough-to-use';
process.env.FIELD_ENCRYPTION_KEYS = `v1:${crypto.randomBytes(32).toString('base64')}`;
// Set explicitly so a developer's .env cannot change which key is active.
process.env.FIELD_ENCRYPTION_ACTIVE_KEY = 'v1';
process.env.FIELD_BLIND_INDEX_KEY = crypto.randomBytes(32).toString('hex');

const TEST_DB_URI = process.env.WAVE2_MONGO_URI || 'mongodb://127.0.0.1:27018/payguard_wave2_test?replicaSet=rs0';
const BACKEND = path.dirname(fileURLToPath(import.meta.url));

const { default: app } = await import('./src/app.js');
const { default: Employee } = await import('./src/models/Employee.js');
const { default: EmploymentRecord } = await import('./src/models/EmploymentRecord.js');
const { default: EmployeeStatutoryProfile } = await import('./src/models/EmployeeStatutoryProfile.js');
const { default: EmployeeBankAccount } = await import('./src/models/EmployeeBankAccount.js');
const { default: EmployeeDocument } = await import('./src/models/EmployeeDocument.js');
const { default: ComplianceRuleVersion } = await import('./src/models/ComplianceRuleVersion.js');
const { default: AuditLog } = await import('./src/models/AuditLog.js');
const { default: auditService } = await import('./src/services/auditService.js');
const { supportsTransactions } = await import('./src/utils/transaction.js');

const PASSWORD = 'StrongPass123';
// Not the format example in the PAN validation message ("for example ABCDE1234F"): a stored error response quoting the
// example would look like a leak of this fixture.
const PAN = 'LMNOP4321Q';
const UAN = '100200300400';
const FIRST_ACCOUNT = '123456789012';
const SECOND_ACCOUNT = '987654321098';
const KIRAN_PAN = 'PQRSX6789K';
const PLAINTEXTS = [PAN, UAN, FIRST_ACCOUNT, SECOND_ACCOUNT, KIRAN_PAN, '200300400500', '3100123456', '555500001111'];

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
    put: (url, body = {}, headers) => request('PUT', url, body, headers),
  };
}

const login = async (email) => {
  const client = createClient();
  const res = await client.post('/auth/login', { email, password: PASSWORD });
  assert.equal(res.status, 200, `login ${email}: ${JSON.stringify(res.body)}`);
  return client;
};

const expectStatus = (res, status) => assert.equal(res.status, status, JSON.stringify(res.body));
const containsNone = (text, values = PLAINTEXTS) => values.filter((value) => text.includes(value));
const today = () => new Date().toISOString().slice(0, 10);

before(async () => {
  await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 5000 });
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  assert.equal(await supportsTransactions(), true, 'Wave 2 tests need a replica set');
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

describe('Wave 2 — workforce identity and Employee 360', () => {
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

  const addSalary = async (employeeId) => {
    const res = await s.payrollAdmin.post(`/employees/${employeeId}/salary`, {
      effectiveFrom: '2026-01-01', components: { basic: 12000, hra: 4000, specialAllowance: 4000 },
      workState: 'MH', pfEnrolled: true, esiEnrolled: true, ptEnrolled: true,
    });
    expectStatus(res, 201);
  };

  test('setup: company A team, company B, statutory rules, employees', async () => {
    expectStatus(await owner.post('/auth/register', {
      name: 'Owner One', email: 'owner@example.com', password: PASSWORD, confirmPassword: PASSWORD, companyName: 'Acme Payroll',
    }), 201);
    s.companyId = (await owner.get('/auth/me')).body.data.user.companyId;
    for (const [name, email, role] of [
      ['Hema Manager', 'hr@example.com', 'manager'],
      ['Pavan Preparer', 'payroll@example.com', 'payroll_admin'],
      ['Arti Auditor', 'auditor@example.com', 'auditor'],
    ]) {
      expectStatus(await owner.post('/company/users', { name, email, role, password: PASSWORD }), 201);
    }
    s.hr = await login('hr@example.com');
    s.payrollAdmin = await login('payroll@example.com');
    s.auditor = await login('auditor@example.com');

    expectStatus(await ownerB.post('/auth/register', {
      name: 'Owner Two', email: 'owner.b@example.com', password: PASSWORD, confirmPassword: PASSWORD, companyName: 'Other Co',
    }), 201);
    s.bEmployee = await createEmployee(ownerB, 'Bina', 'Shah');

    const createdBy = new mongoose.Types.ObjectId();
    await ComplianceRuleVersion.create([
      { ruleType: 'EPF', jurisdiction: 'IN', effectiveFrom: new Date('2014-09-01'), createdBy, description: 'EPF',
        epfParams: { employeeContributionRate: 0.12, employerContributionRate: 0.12, wageCapForContribution: 15000, epsRate: 0.0833, roundingMode: 'NEAREST_RUPEE' } },
      { ruleType: 'ESI', jurisdiction: 'IN', effectiveFrom: new Date('2019-07-01'), createdBy, description: 'ESI',
        esiParams: { employeeContributionRate: 0.0075, employerContributionRate: 0.0325, grossWageCeiling: 21000, roundingMode: 'CEIL_RUPEE' } },
      { ruleType: 'PT', jurisdiction: 'MH', effectiveFrom: new Date('2000-01-01'), createdBy, description: 'MH PT',
        ptSlabs: [{ upTo: 7500, monthlyTax: 0 }, { upTo: 10000, monthlyTax: 175 }, { upTo: null, monthlyTax: 200 }] },
    ]);

    s.asha = await createEmployee(s.hr, 'Asha', 'Verma');
    s.ravi = await createEmployee(s.hr, 'Ravi', 'Kumar');
    s.meena = await createEmployee(s.hr, 'Meena', 'Iyer', { position: 'Engineering Manager', hireDate: '2023-05-01' });
    s.kiran = await createEmployee(s.hr, 'Kiran', 'Rao');
    for (const id of [s.asha, s.ravi, s.kiran]) await addSalary(id);
  });

  // ─── Employment history ────────────────────────────────────────────────────

  test('creating an employee records the joining version in the same transaction', async () => {
    const res = await s.auditor.get(`/employees/${s.asha}/employment`);
    expectStatus(res, 200);
    const { history, current } = res.body.data;
    assert.equal(history.length, 1);
    assert.equal(history[0].changeType, 'JOINING');
    assert.equal(history[0].effectiveFrom.slice(0, 10), '2024-01-15');
    assert.equal(current.designation, 'Engineer');
    assert.equal(current.department, 'Engineering');
  });

  test('employment changes append effective-dated versions and never rewrite history', async () => {
    const promotion = await s.hr.post(`/employees/${s.asha}/employment`, {
      changeType: 'PROMOTION', effectiveFrom: '2025-04-01', changes: { designation: 'Senior Engineer' }, reason: 'Annual review',
    });
    expectStatus(promotion, 201);
    assert.equal(promotion.body.data.version.effectiveFrom.slice(0, 10), '2025-04-01');
    assert.deepEqual(promotion.body.data.changedFields, ['designation']);
    assert.equal((await Employee.findById(s.asha).lean()).position, 'Senior Engineer');

    const closed = await EmploymentRecord.findOne({ employeeId: s.asha, changeType: 'JOINING' }).lean();
    assert.equal(closed.isCurrent, false);
    assert.equal(closed.effectiveTo.toISOString(), '2025-03-31T23:59:59.999Z');

    const backdated = await s.hr.post(`/employees/${s.asha}/employment`, {
      changeType: 'TRANSFER', effectiveFrom: '2025-01-01', changes: { department: 'Finance' },
    });
    expectStatus(backdated, 409);
    assert.equal(backdated.body.code, 'EFFECTIVE_DATE_NOT_AFTER_CURRENT');

    const future = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
    const futureDated = await s.hr.post(`/employees/${s.asha}/employment`, {
      changeType: 'REDESIGNATION', effectiveFrom: future, changes: { designation: 'Staff Engineer' },
    });
    expectStatus(futureDated, 422);
    assert.equal(futureDated.body.code, 'FUTURE_DATED_CHANGE_NOT_SUPPORTED');

    const wrongField = await s.hr.post(`/employees/${s.asha}/employment`, {
      changeType: 'PROMOTION', effectiveFrom: '2025-05-01', changes: { designation: 'Lead', employmentType: 'CONTRACT' },
    });
    expectStatus(wrongField, 422);
    assert.equal(wrongField.body.code, 'FIELD_NOT_ALLOWED_FOR_CHANGE');

    // Point in time: one answer per date.
    assert.equal((await EmploymentRecord.findValidForDate(s.asha, new Date('2025-03-15'))).designation, 'Engineer');
    assert.equal((await EmploymentRecord.findValidForDate(s.asha, new Date('2025-05-01'))).designation, 'Senior Engineer');

    const event = await AuditLog.findOne({ action: 'EMPLOYMENT_CHANGE_RECORDED', entityId: s.asha }).lean();
    assert.deepEqual(event.meta.before, { designation: 'Engineer' });
    assert.deepEqual(event.meta.after, { designation: 'Senior Engineer' });

    // The model refuses rewrites from any code path.
    await assert.rejects(
      EmploymentRecord.updateOne({ employeeId: s.asha }, { $set: { designation: 'Rewritten' } }),
      (err) => err.code === 'EMPLOYMENT_HISTORY_IMMUTABLE'
    );
    const closedDoc = await EmploymentRecord.findOne({ employeeId: s.asha, isCurrent: false });
    closedDoc.designation = 'Rewritten';
    await assert.rejects(closedDoc.save(), (err) => err.code === 'EMPLOYMENT_HISTORY_IMMUTABLE');

    expectStatus(await s.auditor.post(`/employees/${s.asha}/employment`, { changeType: 'REDESIGNATION', effectiveFrom: '2025-05-01', changes: { designation: 'X Y' } }), 403);
    expectStatus(await s.payrollAdmin.post(`/employees/${s.asha}/employment`, { changeType: 'REDESIGNATION', effectiveFrom: '2025-05-01', changes: { designation: 'X Y' } }), 403);
  });

  test('managers must be colleagues in the same company, never the employee, and never a reporting cycle', async () => {
    const assigned = await s.hr.post(`/employees/${s.asha}/employment`, {
      changeType: 'MANAGER_CHANGE', effectiveFrom: '2025-06-01', changes: { managerEmployeeId: s.meena },
    });
    expectStatus(assigned, 201);
    const history = (await s.hr.get(`/employees/${s.asha}/employment`)).body.data;
    assert.equal(history.current.manager.name, 'Meena Iyer');

    const cycle = await s.hr.post(`/employees/${s.meena}/employment`, {
      changeType: 'MANAGER_CHANGE', effectiveFrom: '2025-06-02', changes: { managerEmployeeId: s.asha },
    });
    expectStatus(cycle, 409);
    assert.equal(cycle.body.code, 'MANAGER_CYCLE');

    const self = await s.hr.post(`/employees/${s.ravi}/employment`, {
      changeType: 'MANAGER_CHANGE', effectiveFrom: '2025-06-02', changes: { managerEmployeeId: s.ravi },
    });
    expectStatus(self, 422);
    assert.equal(self.body.code, 'INVALID_MANAGER');

    const otherCompany = await s.hr.post(`/employees/${s.ravi}/employment`, {
      changeType: 'MANAGER_CHANGE', effectiveFrom: '2025-06-02', changes: { managerEmployeeId: s.bEmployee },
    });
    expectStatus(otherCompany, 422);
    assert.equal(otherCompany.body.code, 'INVALID_MANAGER');

    expectStatus(await ownerB.get(`/employees/${s.asha}/employment`), 404);
  });

  test('editing the employee record keeps employment history consistent', async () => {
    // Only the joining version exists: corrected in place, with the old value audited.
    expectStatus(await s.hr.put(`/employees/${s.ravi}`, { position: 'Data Analyst' }), 200);
    const raviHistory = await EmploymentRecord.find({ employeeId: s.ravi }).lean();
    assert.equal(raviHistory.length, 1);
    assert.equal(raviHistory[0].designation, 'Data Analyst');
    const correction = await AuditLog.findOne({ action: 'EMPLOYEE_UPDATED', entityId: s.ravi }).lean();
    assert.equal(correction.meta.employment.mode, 'JOINING_CORRECTED');
    assert.equal(correction.meta.employment.previous.designation, 'Engineer');

    // Later versions exist: the edit becomes a new version effective today.
    expectStatus(await s.hr.put(`/employees/${s.asha}`, { department: 'Finance' }), 200);
    const ashaCurrent = await EmploymentRecord.findOne({ employeeId: s.asha, isCurrent: true }).lean();
    assert.equal(ashaCurrent.changeType, 'TRANSFER');
    assert.equal(ashaCurrent.department, 'Finance');
    assert.equal(ashaCurrent.effectiveFrom.toISOString().slice(0, 10), today());
    assert.equal(ashaCurrent.managerEmployeeId.toString(), s.meena, 'unchanged terms are carried forward');

    const hireDate = await s.hr.put(`/employees/${s.asha}`, { hireDate: '2024-02-01' });
    expectStatus(hireDate, 409);
    assert.equal(hireDate.body.code, 'HIRE_DATE_LOCKED');

    const sameDay = await s.hr.put(`/employees/${s.asha}`, { position: 'Finance Analyst' });
    expectStatus(sameDay, 409);
    assert.equal(sameDay.body.code, 'EMPLOYMENT_CHANGE_PENDING');
  });

  // ─── Statutory identifiers ─────────────────────────────────────────────────

  test('statutory identifiers are validated, encrypted at rest, masked everywhere and unique per company', async () => {
    const invalid = await s.hr.post(`/employees/${s.asha}/statutory`, { pan: 'ABCDE12345', uan: '12' });
    expectStatus(invalid, 422);
    assert.deepEqual(invalid.body.errors.map((e) => e.field).sort(), ['pan', 'uan']);
    assert.ok(!invalid.raw.includes('ABCDE12345'), 'validation errors never echo the value');

    const saved = await s.hr.post(
      `/employees/${s.asha}/statutory`,
      { pan: 'lmnop 4321q', uan: UAN, reason: 'Joining documents' },
      { 'Idempotency-Key': `statutory-${crypto.randomUUID()}` }
    );
    expectStatus(saved, 201);
    assert.equal(saved.body.data.profile.fields.pan.masked, '••••••321Q');
    assert.equal(saved.body.data.profile.fields.uan.masked, '••••••••0400');
    assert.equal(saved.body.data.profile.fields.esicNumber.isSet, false);
    assert.deepEqual(containsNone(saved.raw), []);
    assert.ok(!saved.raw.includes('enc:'), 'ciphertext never leaves the server');

    const raw = await EmployeeStatutoryProfile.collection.findOne({ employeeId: new mongoose.Types.ObjectId(s.asha) });
    assert.match(raw.pan.ciphertext, /^enc:v1:/);
    assert.match(raw.uan.ciphertext, /^enc:v1:/);
    assert.deepEqual(containsNone(JSON.stringify(raw)), [], 'no plaintext at rest');

    for (const reader of [s.auditor, s.hr, owner]) {
      const view = await reader.get(`/employees/${s.asha}/statutory`);
      expectStatus(view, 200);
      assert.deepEqual(containsNone(view.raw), []);
    }
    const ordinary = await s.auditor.get(`/employees/${s.asha}`);
    assert.ok(!ordinary.raw.includes('"pan"') && containsNone(ordinary.raw).length === 0, 'ordinary employee APIs carry no statutory data');

    const duplicate = await s.hr.post(`/employees/${s.ravi}/statutory`, { pan: PAN });
    expectStatus(duplicate, 409);
    assert.equal(duplicate.body.code, 'PAN_ALREADY_REGISTERED');
    expectStatus(await ownerB.post(`/employees/${s.bEmployee}/statutory`, { pan: PAN }), 201);

    const unchanged = await s.hr.post(`/employees/${s.asha}/statutory`, { pan: PAN });
    expectStatus(unchanged, 422);
    assert.equal(unchanged.body.code, 'NO_CHANGE');

    const secondVersion = await s.payrollAdmin.post(`/employees/${s.asha}/statutory`, { uan: '100200300401' });
    expectStatus(secondVersion, 201);
    assert.equal(secondVersion.body.data.profile.version, 2);
    const versions = await EmployeeStatutoryProfile.collection.find({ employeeId: new mongoose.Types.ObjectId(s.asha) }).sort({ version: 1 }).toArray();
    assert.equal(versions.length, 2);
    assert.equal(versions[0].isCurrent, false);
    assert.ok(versions[0].supersededAt);
    assert.equal(versions[1].pan.ciphertext, versions[0].pan.ciphertext, 'unchanged identifiers carry forward');
    // Restore the original UAN for later assertions.
    expectStatus(await s.hr.post(`/employees/${s.asha}/statutory`, { uan: UAN }), 201);

    expectStatus(await s.auditor.post(`/employees/${s.asha}/statutory`, { esicNumber: '3100000001' }), 403);

    await assert.rejects(
      EmployeeStatutoryProfile.create({
        employeeId: new mongoose.Types.ObjectId(), companyId: new mongoose.Types.ObjectId(), version: 1,
        pan: { ciphertext: PAN, last4: '321Q' }, recordedBy: new mongoose.Types.ObjectId(),
      }),
      /must be stored encrypted/
    );
    await assert.rejects(
      EmployeeStatutoryProfile.updateOne({ employeeId: s.asha }, { $set: { isCurrent: false } }),
      (err) => err.code === 'STATUTORY_HISTORY_IMMUTABLE'
    );
  });

  test('revealing a value needs permission and a reason, is audited first, and never reaches logs or stored responses', async () => {
    const captured = [];
    const originals = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    for (const name of Object.keys(originals)) console[name] = (...args) => { captured.push(args.map(String).join(' ')); };
    try {
      expectStatus(await s.auditor.post(`/employees/${s.asha}/statutory/reveal`, { field: 'pan', reason: 'Auditor curiosity check' }), 403);
      expectStatus(await s.hr.post(`/employees/${s.asha}/statutory/reveal`, { field: 'pan', reason: 'HR wants to look at it' }), 403);
      expectStatus(await s.payrollAdmin.post(`/employees/${s.asha}/statutory/reveal`, { field: 'pan' }), 422);
      expectStatus(await s.payrollAdmin.post(`/employees/${s.asha}/statutory/reveal`, { field: 'pan', reason: 'short' }), 422);
      expectStatus(await s.payrollAdmin.post(`/employees/${s.asha}/statutory/reveal`, { field: 'esicNumber', reason: 'Checking the ESIC number' }), 404);

      const reveal = await s.payrollAdmin.post(`/employees/${s.asha}/statutory/reveal`, { field: 'pan', reason: 'Form 24Q correction for Q4' });
      expectStatus(reveal, 200);
      assert.equal(reveal.body.data.value, PAN);
      assert.equal(reveal.headers.get('cache-control'), 'no-store');

      const event = await AuditLog.findOne({ action: 'SENSITIVE_FIELD_REVEALED', entityId: s.asha }).lean();
      assert.equal(event.meta.field, 'statutory.pan');
      assert.equal(event.meta.reason, 'Form 24Q correction for Q4');
      assert.equal(event.actorEmail, 'payroll@example.com');

      // Tampering: another employee's ciphertext copied into this record.
      expectStatus(await s.hr.post(`/employees/${s.ravi}/statutory`, { uan: '555566667777' }), 201);
      const ashaRaw = await EmployeeStatutoryProfile.collection.findOne({ employeeId: new mongoose.Types.ObjectId(s.asha), isCurrent: true });
      await EmployeeStatutoryProfile.collection.updateOne(
        { employeeId: new mongoose.Types.ObjectId(s.ravi), isCurrent: true },
        { $set: { pan: ashaRaw.pan } }
      );
      const tampered = await s.payrollAdmin.post(`/employees/${s.ravi}/statutory/reveal`, { field: 'pan', reason: 'Verifying PAN before filing' });
      expectStatus(tampered, 500);
      assert.equal(tampered.body.code, 'ENCRYPTED_FIELD_TAMPERED');
      assert.deepEqual(containsNone(tampered.raw), []);
      assert.ok(await AuditLog.exists({ action: 'SENSITIVE_FIELD_INTEGRITY_FAILED', entityId: s.ravi }));
    } finally {
      Object.assign(console, originals);
    }

    assert.deepEqual(containsNone(captured.join('\n')), [], 'no plaintext in logs');
    const auditJson = JSON.stringify(await AuditLog.collection.find().toArray());
    assert.deepEqual(containsNone(auditJson), [], 'no plaintext in the audit trail');
    const idempotencyJson = JSON.stringify(await mongoose.connection.db.collection('idempotencyrecords').find().toArray());
    assert.ok(idempotencyJson.includes('statutory'), 'an idempotent statutory response was stored');
    assert.deepEqual(containsNone(idempotencyJson), [], 'no plaintext in stored idempotent responses');
  });

  // ─── Bank accounts ─────────────────────────────────────────────────────────

  test('bank accounts are versioned and masked; payroll preparers cannot change them; shared accounts are flagged', async () => {
    const account = { accountHolderName: 'Asha Verma', accountNumber: FIRST_ACCOUNT, ifsc: 'hdfc0001234', bankName: 'HDFC Bank' };
    const preparer = await s.payrollAdmin.post(`/employees/${s.asha}/bank-accounts`, account);
    expectStatus(preparer, 403);
    assert.deepEqual(preparer.body.missingPermissions, ['employee.bank.write']);

    const invalid = await s.hr.post(`/employees/${s.asha}/bank-accounts`, { ...account, ifsc: 'HDFC1234567' });
    expectStatus(invalid, 422);
    assert.deepEqual(invalid.body.errors.map((e) => e.field), ['ifsc']);

    const first = await s.hr.post(`/employees/${s.asha}/bank-accounts`, account);
    expectStatus(first, 201);
    assert.equal(first.body.data.account.accountNumberMasked, '••••••••9012');
    assert.equal(first.body.data.account.ifsc, 'HDFC0001234');
    assert.deepEqual(containsNone(first.raw), []);

    const same = await s.hr.post(`/employees/${s.asha}/bank-accounts`, account);
    expectStatus(same, 422);
    assert.equal(same.body.code, 'NO_CHANGE');

    const second = await s.hr.post(`/employees/${s.asha}/bank-accounts`, {
      accountHolderName: 'Asha Verma', accountNumber: SECOND_ACCOUNT, ifsc: 'ICIC0004321', bankName: 'ICICI Bank', reason: 'Employee changed banks',
    });
    expectStatus(second, 201);
    assert.equal(second.body.data.account.version, 2);

    const sharing = await s.hr.post(`/employees/${s.ravi}/bank-accounts`, {
      accountHolderName: 'Ravi Kumar', accountNumber: SECOND_ACCOUNT, ifsc: 'ICIC0004321',
    });
    expectStatus(sharing, 201);
    assert.equal(sharing.body.data.warnings[0].code, 'BANK_ACCOUNT_SHARED');

    const list = await s.auditor.get(`/employees/${s.asha}/bank-accounts`);
    expectStatus(list, 200);
    assert.equal(list.body.data.history.length, 2);
    assert.equal(list.body.data.current.version, 2);
    assert.equal(list.body.data.current.sharedWithOtherEmployees, 1);
    assert.equal(list.body.data.history[1].isCurrent, false);
    assert.deepEqual(containsNone(list.raw), []);

    const raw = await EmployeeBankAccount.collection.find({ employeeId: new mongoose.Types.ObjectId(s.asha) }).toArray();
    assert.ok(raw.every((doc) => doc.accountNumber.ciphertext.startsWith('enc:')));
    assert.deepEqual(containsNone(JSON.stringify(raw)), []);

    expectStatus(await s.auditor.post(`/employees/${s.asha}/bank-accounts/${list.body.data.current.id}/reveal`, { reason: 'Auditor wants the number' }), 403);
    const reveal = await s.payrollAdmin.post(`/employees/${s.asha}/bank-accounts/${list.body.data.current.id}/reveal`, { reason: 'Bank rejected the transfer file' });
    expectStatus(reveal, 200);
    assert.equal(reveal.body.data.value, SECOND_ACCOUNT);
    assert.ok(await AuditLog.exists({ action: 'SENSITIVE_FIELD_REVEALED', 'meta.field': 'bank.accountNumber', entityId: s.asha }));
    expectStatus(await ownerB.post(`/employees/${s.asha}/bank-accounts/${list.body.data.current.id}/reveal`, { reason: 'Other company probing' }), 404);

    await assert.rejects(
      EmployeeBankAccount.updateOne({ employeeId: s.asha }, { $set: { ifsc: 'SBIN0000001' } }),
      (err) => err.code === 'BANK_ACCOUNT_HISTORY_IMMUTABLE'
    );
  });

  // ─── Documents ─────────────────────────────────────────────────────────────

  test('documents are verified by someone other than the submitter, and decisions are final', async () => {
    const submitted = await s.hr.post(`/employees/${s.asha}/documents`, {
      documentType: 'PASSPORT', title: 'Passport', issuedOn: '2015-01-01', expiresOn: '2025-01-01', fileSha256: 'a'.repeat(64),
    });
    expectStatus(submitted, 201);
    const documentId = submitted.body.data.document.id;
    assert.equal(submitted.body.data.document.status, 'SUBMITTED');
    assert.equal(submitted.body.data.document.isExpired, true);

    const selfVerify = await s.hr.post(`/employees/${s.asha}/documents/${documentId}/decision`, { decision: 'VERIFIED' });
    expectStatus(selfVerify, 403);
    assert.equal(selfVerify.body.code, 'SEGREGATION_OF_DUTIES');
    expectStatus(await s.payrollAdmin.post(`/employees/${s.asha}/documents/${documentId}/decision`, { decision: 'VERIFIED' }), 403);

    const verified = await owner.post(`/employees/${s.asha}/documents/${documentId}/decision`, { decision: 'VERIFIED', note: 'Original seen' });
    expectStatus(verified, 200);
    assert.equal(verified.body.data.document.decision.byEmail, 'owner@example.com');

    const again = await owner.post(`/employees/${s.asha}/documents/${documentId}/decision`, { decision: 'REJECTED', note: 'Changed my mind' });
    expectStatus(again, 409);
    assert.equal(again.body.code, 'DOCUMENT_DECISION_FINAL');

    const other = await s.payrollAdmin.post(`/employees/${s.asha}/documents`, { documentType: 'OFFER_LETTER', title: 'Offer letter' });
    expectStatus(other, 201);
    const noReason = await s.hr.post(`/employees/${s.asha}/documents/${other.body.data.document.id}/decision`, { decision: 'REJECTED' });
    expectStatus(noReason, 422);
    assert.equal(noReason.body.code, 'REJECTION_REASON_REQUIRED');

    await assert.rejects(
      EmployeeDocument.updateOne({ _id: documentId }, { $set: { status: 'REJECTED' } }),
      (err) => err.code === 'DOCUMENT_DECISION_FINAL'
    );
  });

  // ─── Payroll readiness ─────────────────────────────────────────────────────

  test('payroll readiness is READY, WARNING or BLOCKED with reasons', async () => {
    expectStatus(await s.hr.post(`/employees/${s.kiran}/statutory`, { pan: KIRAN_PAN, uan: '200300400500', esicNumber: '3100123456' }), 201);
    expectStatus(await s.hr.post(`/employees/${s.kiran}/bank-accounts`, { accountHolderName: 'Kiran Rao', accountNumber: '555500001111', ifsc: 'SBIN0000123' }), 201);

    const period = '?periodYear=2026&periodMonth=2';
    const kiran = await s.auditor.get(`/employees/${s.kiran}/payroll-readiness${period}`);
    expectStatus(kiran, 200);
    assert.equal(kiran.body.data.readiness.state, 'READY', JSON.stringify(kiran.body.data.readiness));

    const meena = (await s.auditor.get(`/employees/${s.meena}/payroll-readiness${period}`)).body.data.readiness;
    assert.equal(meena.state, 'BLOCKED');
    assert.ok(meena.blockers.some((b) => b.code === 'NO_SALARY_VERSION'));

    const asha = (await s.auditor.get(`/employees/${s.asha}/payroll-readiness${period}`)).body.data.readiness;
    assert.equal(asha.state, 'WARNING');
    const ashaCodes = asha.warnings.map((w) => w.code).sort();
    assert.deepEqual(ashaCodes, ['BANK_ACCOUNT_RECENTLY_CHANGED', 'BANK_ACCOUNT_SHARED', 'DOCUMENT_EXPIRED', 'ESIC_NUMBER_MISSING']);

    // Ravi resigned with January as his last month.
    const exit = await s.hr.post(`/employees/${s.ravi}/employment`, {
      changeType: 'EXIT', exit: { lastWorkingDay: '2026-01-31', reason: 'RESIGNATION' }, reason: 'Resigned',
    });
    expectStatus(exit, 201);
    assert.equal((await Employee.findById(s.ravi).lean()).status, 'active', 'an exit does not drop the final period from payroll');
    const afterExit = await s.hr.post(`/employees/${s.ravi}/employment`, { changeType: 'REDESIGNATION', effectiveFrom: today(), changes: { designation: 'Returned' } });
    expectStatus(afterExit, 409);
    assert.equal(afterExit.body.code, 'EMPLOYEE_EXITED');

    const raviFebruary = (await s.auditor.get(`/employees/${s.ravi}/payroll-readiness${period}`)).body.data.readiness;
    assert.equal(raviFebruary.state, 'BLOCKED');
    assert.equal(raviFebruary.blockers[0].code, 'EXITED_BEFORE_PERIOD');
    const raviJanuary = (await s.auditor.get(`/employees/${s.ravi}/payroll-readiness?periodYear=2026&periodMonth=1`)).body.data.readiness;
    assert.ok(raviJanuary.warnings.some((w) => w.code === 'EXIT_WITHIN_PERIOD'));

    const company = await s.auditor.get(`/payroll-readiness${period}`);
    expectStatus(company, 200);
    assert.deepEqual(company.body.data.summary, { total: 4, ready: 1, warning: 1, blocked: 2 });
    assert.deepEqual(company.body.data.employees.map((e) => e.state), ['BLOCKED', 'BLOCKED', 'WARNING', 'READY']);
    assert.deepEqual(containsNone(company.raw), []);
    expectStatus(await ownerB.get(`/employees/${s.asha}/payroll-readiness`), 404);
    expectStatus(await s.hr.get('/payroll-readiness?periodYear=2026'), 422);

    // Readiness and payroll preflight share one eligibility decision.
    const run = await owner.post('/payroll-runs', { periodMonth: 2, periodYear: 2026 });
    expectStatus(run, 201);
    s.febRun = run.body.data.run._id;
    const preflight = await owner.post(`/payroll-runs/${s.febRun}/preflight`);
    expectStatus(preflight, 200);
    const preflightBlocked = preflight.body.data.blockedEmployees.map((e) => e.employeeId).sort();
    const readinessBlocked = company.body.data.employees.filter((e) => e.state === 'BLOCKED').map((e) => e.employeeId).sort();
    assert.deepEqual(preflightBlocked, readinessBlocked);
  });

  // ─── Historical isolation ──────────────────────────────────────────────────

  test('finalized payslips never absorb later employment, statutory or bank changes', async () => {
    expectStatus(await owner.post(`/payroll-runs/${s.febRun}/process`), 200);
    expectStatus(await owner.post(`/payroll-runs/${s.febRun}/finalize`), 200);

    const snapshots = mongoose.connection.db.collection('payrollsnapshots');
    const before = await snapshots.find({ payrollRunId: new mongoose.Types.ObjectId(s.febRun) }).sort({ _id: 1 }).toArray();
    assert.equal(before.length, 2, 'Asha and Kiran were paid; Meena and Ravi were blocked');

    const payrollJson = JSON.stringify([before, await mongoose.connection.db.collection('payrollstagingresults').find().toArray()]);
    assert.ok(!payrollJson.includes('enc:'), 'no ciphertext copied into payroll records');
    assert.deepEqual(containsNone(payrollJson), [], 'no statutory or bank identifiers in payroll records');

    const nextPeriod = await s.auditor.get('/payroll-readiness');
    assert.equal(nextPeriod.body.data.period.periodMonth, 3, 'readiness defaults to the period after the last finalized run');

    expectStatus(await s.hr.post(`/employees/${s.kiran}/employment`, {
      changeType: 'LOCATION_CHANGE', effectiveFrom: today(), changes: { workLocation: { name: 'Pune office', state: 'MH' } },
    }), 201);
    expectStatus(await s.hr.put(`/employees/${s.kiran}`, { department: 'Operations' }), 409);
    expectStatus(await s.hr.post(`/employees/${s.kiran}/statutory`, { uan: '200300400501' }), 201);
    expectStatus(await s.hr.post(`/employees/${s.kiran}/bank-accounts`, { accountHolderName: 'Kiran Rao', accountNumber: '555500002222', ifsc: 'SBIN0000123' }), 201);
    expectStatus(await s.hr.put(`/employees/${s.meena}`, { position: 'Director of Engineering' }), 200);

    const after = await snapshots.find({ payrollRunId: new mongoose.Types.ObjectId(s.febRun) }).sort({ _id: 1 }).toArray();
    assert.deepEqual(after, before, 'finalized snapshots are byte-for-byte unchanged');
  });

  // ─── Transactions and migration ────────────────────────────────────────────

  test('an employment change rolls back completely when its audit write fails', async () => {
    const originalLog = auditService.log;
    auditService.log = async function failingLog(params, session) {
      if (params.action === 'EMPLOYMENT_CHANGE_RECORDED') throw new Error('Injected audit failure');
      return originalLog.call(this, params, session);
    };
    try {
      const res = await s.hr.post(`/employees/${s.meena}/employment`, {
        changeType: 'REDESIGNATION', effectiveFrom: '2025-01-01', changes: { designation: 'VP Engineering' },
      });
      expectStatus(res, 500);
    } finally {
      auditService.log = originalLog;
    }
    const records = await EmploymentRecord.find({ employeeId: s.meena }).lean();
    assert.equal(records.length, 1);
    assert.equal(records[0].effectiveTo, null);
    assert.equal((await Employee.findById(s.meena).lean()).position, 'Director of Engineering');
  });

  test('the migration backfills employment history for employees created before Wave 2, once', async () => {
    const legacyId = new mongoose.Types.ObjectId();
    await Employee.collection.insertOne({
      _id: legacyId, firstName: 'Old', lastName: 'Timer', email: 'old.timer@example.com', department: 'Sales', position: 'Account Executive',
      salary: 30000, hireDate: new Date('2019-07-10'), status: 'active', createdBy: new mongoose.Types.ObjectId(s.companyId),
      isDeleted: false, createdAt: new Date(), updatedAt: new Date(),
    });

    const migrate = () => spawnSync(process.execPath, ['scripts/migrate.js'], {
      cwd: BACKEND,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, MONGO_URI: TEST_DB_URI },
    });
    const first = migrate();
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /employmentrecords: create JOINING versions from employee records \(1\)/);
    const second = migrate();
    assert.equal(second.status, 0, second.stdout + second.stderr);

    const records = await EmploymentRecord.find({ employeeId: legacyId }).lean();
    assert.equal(records.length, 1);
    assert.equal(records[0].changeType, 'JOINING');
    assert.equal(records[0].effectiveFrom.toISOString(), '2019-07-10T00:00:00.000Z');
    assert.equal(records[0].designation, 'Account Executive');
  });

  test('the audit chain still verifies after every Wave 2 action', async () => {
    assert.equal((await auditService.verifyAuditChain()).valid, true);
  });
});
