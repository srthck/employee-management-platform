/**
 * test_phase13.js — Wave 1: financial foundation hardening, over HTTP.
 *
 * Runner: node:test (Node >= 18 built-in)
 * Run:    node --test test_phase13.js
 *         npm run test:replset          (full suite on a replica set, transactions required)
 *
 * Real Express app on an ephemeral port, real MongoDB, isolated database
 * (PHASE13_MONGO_URI, default payguard_phase13_test), dropped before and after.
 *
 * Covers:
 *   - company entity, staff user management, permission-based RBAC
 *   - machine-readable error envelope
 *   - Idempotency-Key replay, reuse detection and concurrent duplicates
 *   - variance classification: expected vs unexplained pay changes,
 *     finalization gate, override with reason, maker-checker segregation of duties
 *   - field-level encryption: context binding, tamper detection, key rotation
 *   - transactions: rollback on failure and finalization races
 *     (asserted only when the database supports transactions; required when
 *     REQUIRE_TRANSACTIONS=true)
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'phase13-test-secret-that-is-long-enough';
process.env.FIELD_ENCRYPTION_KEYS = `v1:${crypto.randomBytes(32).toString('base64')}`;
// Set explicitly so a developer's .env cannot change which key is active.
process.env.FIELD_ENCRYPTION_ACTIVE_KEY = 'v1';
process.env.FIELD_BLIND_INDEX_KEY = crypto.randomBytes(32).toString('hex');

const TEST_DB_URI = process.env.PHASE13_MONGO_URI || 'mongodb://127.0.0.1:27018/payguard_phase13_test?replicaSet=rs0';

const { default: app } = await import('./src/app.js');
const { default: Admin } = await import('./src/models/Admin.js');
const { default: Company } = await import('./src/models/Company.js');
const { default: Employee } = await import('./src/models/Employee.js');
const { default: EmployeeAccount } = await import('./src/models/EmployeeAccount.js');
const { default: SalaryStructure } = await import('./src/models/SalaryStructure.js');
const { default: ComplianceRuleVersion } = await import('./src/models/ComplianceRuleVersion.js');
const { default: PayrollRun } = await import('./src/models/PayrollRun.js');
const { default: PayrollStagingResult } = await import('./src/models/PayrollStagingResult.js');
const { default: PayrollSnapshot } = await import('./src/models/PayrollSnapshot.js');
const { default: AuditLog } = await import('./src/models/AuditLog.js');
const { default: IdempotencyRecord } = await import('./src/models/IdempotencyRecord.js');
const { default: auditService } = await import('./src/services/auditService.js');
const { default: companyService } = await import('./src/services/companyService.js');
const { default: payrollRunService } = await import('./src/services/payrollRunService.js');
const { default: payrollSnapshotService } = await import('./src/services/payrollSnapshotService.js');
const { default: payrollFinalizationService } = await import('./src/services/payrollFinalizationService.js');
const { supportsTransactions } = await import('./src/utils/transaction.js');
const encryption = await import('./src/utils/fieldEncryption.js');

const MODELS = [Admin, Company, Employee, EmployeeAccount, SalaryStructure, ComplianceRuleVersion, PayrollRun, PayrollStagingResult, PayrollSnapshot, AuditLog, IdempotencyRecord];
const PASSWORD = 'StrongPass123';

let server;
let baseUrl;
let transactionsAvailable = false;

function createClient() {
  let cookie = '';
  const request = async (method, path, body, headers = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie && { cookie }), ...headers },
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
    get: (path, headers) => request('GET', path, undefined, headers),
    post: (path, body = {}, headers) => request('POST', path, body, headers),
    put: (path, body = {}, headers) => request('PUT', path, body, headers),
    patch: (path, body = {}, headers) => request('PATCH', path, body, headers),
    del: (path, body, headers) => request('DELETE', path, body, headers),
  };
}

const login = async (email, password = PASSWORD) => {
  const client = createClient();
  const res = await client.post('/auth/login', { email, password });
  assert.equal(res.status, 200, `login ${email}: ${JSON.stringify(res.body)}`);
  return client;
};

const employeePayload = (firstName, lastName, overrides = {}) => ({
  firstName,
  lastName,
  email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`,
  department: 'Engineering',
  position: 'Engineer',
  salary: 20000,
  hireDate: '2024-01-15',
  status: 'active',
  ...overrides,
});

before(async () => {
  await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 5000 });
  await mongoose.connection.dropDatabase();
  await Promise.all(MODELS.map((model) => model.createIndexes()));
  transactionsAvailable = await supportsTransactions();

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

describe('Wave 1 — financial foundation', () => {
  const owner = createClient();
  const state = {};

  // ─── Company, users, RBAC ──────────────────────────────────────────────────

  test('registration creates the owner and the company together', async () => {
    const res = await owner.post('/auth/register', {
      name: 'Owner One', email: 'owner@example.com', password: PASSWORD, confirmPassword: PASSWORD, companyName: 'Acme Payroll Pvt Ltd',
    });
    assert.equal(res.status, 201);
    state.companyId = res.body.data.user.companyId;
    state.ownerId = res.body.data.user.id;
    assert.ok(res.body.data.user.permissions.includes('company.manage'));

    const company = await owner.get('/company');
    assert.equal(company.status, 200);
    assert.equal(company.body.data.company.name, 'Acme Payroll Pvt Ltd');
    assert.equal(company.body.data.company.settings.approvalMode, 'single');
    assert.ok(company.body.data.roles.some((r) => r.role === 'payroll_approver'));
    assert.ok(await AuditLog.exists({ action: 'COMPANY_WORKSPACE_CREATED', companyId: state.companyId }));

    const createdBy = new mongoose.Types.ObjectId();
    await ComplianceRuleVersion.create([
      {
        ruleType: 'EPF', jurisdiction: 'IN', effectiveFrom: new Date('2014-09-01'), createdBy, description: 'EPF test rule',
        epfParams: { employeeContributionRate: 0.12, employerContributionRate: 0.12, wageCapForContribution: 15000, epsRate: 0.0833, roundingMode: 'NEAREST_RUPEE' },
      },
      {
        ruleType: 'ESI', jurisdiction: 'IN', effectiveFrom: new Date('2019-07-01'), createdBy, description: 'ESI test rule',
        esiParams: { employeeContributionRate: 0.0075, employerContributionRate: 0.0325, grossWageCeiling: 21000, roundingMode: 'CEIL_RUPEE' },
      },
      {
        ruleType: 'PT', jurisdiction: 'MH', effectiveFrom: new Date('2000-01-01'), createdBy, description: 'MH PT test rule',
        ptSlabs: [
          { upTo: 7500, monthlyTax: 0 },
          { upTo: 10000, monthlyTax: 175 },
          { upTo: null, monthlyTax: 200, monthOverrides: [{ month: 2, monthlyTax: 300 }] },
        ],
      },
    ]);
  });

  test('admins create staff users with roles; each role gets exactly its permissions', async () => {
    const users = [
      ['Payroll Admin', 'payroll.admin@example.com', 'payroll_admin'],
      ['Payroll Approver', 'approver@example.com', 'payroll_approver'],
      ['Audit Person', 'auditor@example.com', 'auditor'],
      ['Hr Manager', 'hr.manager@example.com', 'manager'],
    ];
    for (const [name, email, role] of users) {
      const res = await owner.post('/company/users', { name, email, role, password: PASSWORD });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.user.role, role);
    }

    const duplicate = await owner.post('/company/users', { name: 'Dup User', email: 'approver@example.com', role: 'auditor', password: PASSWORD });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.code, 'EMAIL_IN_USE');

    const list = await owner.get('/company/users');
    assert.equal(list.body.data.users.length, 5);
    assert.equal(list.body.data.users.find((u) => u.isOwner).email, 'owner@example.com');

    state.payrollAdmin = await login('payroll.admin@example.com');
    state.approver = await login('approver@example.com');
    state.auditor = await login('auditor@example.com');
    state.hrManager = await login('hr.manager@example.com');

    const me = await state.approver.get('/auth/me');
    assert.equal(me.body.data.user.companyId, state.companyId);
    assert.ok(me.body.data.user.permissions.includes('payroll.finalize'));
    assert.ok(!me.body.data.user.permissions.includes('payroll.prepare'));
    state.approverId = me.body.data.user.id;
  });

  test('permission matrix is enforced by the API, with FORBIDDEN codes and missing permissions', async () => {
    const denied = await state.payrollAdmin.post('/employees', employeePayload('Denied', 'Person'));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'FORBIDDEN');
    assert.deepEqual(denied.body.missingPermissions, ['employee.write']);

    assert.equal((await state.payrollAdmin.get('/company/users')).status, 403);
    assert.equal((await state.approver.post('/payroll-runs', { periodMonth: 1, periodYear: 2026 })).status, 403);
    assert.equal((await state.auditor.post('/employees', employeePayload('Audit', 'Denied'))).status, 403);
    assert.equal((await state.auditor.get('/audit/verify')).status, 200);
    assert.equal((await state.auditor.get('/employees')).status, 200);
    assert.equal((await state.hrManager.patch('/company/settings', { settings: { approvalMode: 'maker_checker' } })).status, 403);

    const e1 = await state.hrManager.post('/employees', employeePayload('Asha', 'Verma'));
    const e2 = await state.hrManager.post('/employees', employeePayload('Ravi', 'Kumar'));
    assert.equal(e1.status, 201);
    assert.equal(e2.status, 201);
    state.e1 = e1.body.data.employee._id;
    state.e2 = e2.body.data.employee._id;

    // Salary revisions belong to payroll, not HR.
    const hrSalary = await state.hrManager.post(`/employees/${state.e1}/salary`, {
      effectiveFrom: '2026-01-01', components: { basic: 12000 }, workState: 'MH',
    });
    assert.equal(hrSalary.status, 403);

    for (const [id, special] of [[state.e1, 4000], [state.e2, 4001]]) {
      const res = await state.payrollAdmin.post(`/employees/${id}/salary`, {
        effectiveFrom: '2026-01-01',
        components: { basic: 12000, hra: 4000, specialAllowance: special },
        workState: 'MH', pfEnrolled: true, esiEnrolled: true, ptEnrolled: true,
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
    }
  });

  test('user changes revoke sessions; nobody can modify themselves; the last admin is protected', async () => {
    const self = await owner.patch(`/company/users/${state.ownerId}`, { role: 'auditor' });
    assert.equal(self.status, 422);
    assert.equal(self.body.code, 'SELF_MODIFICATION');

    const hrMe = await state.hrManager.get('/auth/me');
    const hrId = hrMe.body.data.user.id;
    assert.equal((await owner.patch(`/company/users/${hrId}`, { role: 'auditor' })).status, 200);
    assert.equal((await state.hrManager.get('/auth/me')).status, 401, 'old session must be revoked');
    const relogged = await login('hr.manager@example.com');
    assert.equal((await relogged.get('/auth/me')).body.data.user.role, 'auditor');
    assert.equal((await owner.patch(`/company/users/${hrId}`, { role: 'manager' })).status, 200);
    state.hrManager = await login('hr.manager@example.com');

    await assert.rejects(
      companyService.updateUser(state.companyId, { id: hrId, email: 'hr.manager@example.com', role: 'admin' }, state.ownerId, { role: 'auditor' }),
      (err) => err.code === 'LAST_ADMIN'
    );
    assert.ok(await AuditLog.exists({ action: 'COMPANY_USER_UPDATED', companyId: state.companyId }));
  });

  // ─── Error envelope ────────────────────────────────────────────────────────

  test('every failure carries a machine-readable code and request ID', async () => {
    const anonymous = createClient();
    const unauthenticated = await anonymous.get('/employees');
    assert.equal(unauthenticated.body.code, 'UNAUTHENTICATED');
    assert.ok(unauthenticated.body.requestId);

    const missingRoute = await anonymous.get('/does-not-exist');
    assert.equal(missingRoute.status, 404);
    assert.equal(missingRoute.body.code, 'NOT_FOUND');

    const invalid = await owner.post('/employees', { firstName: 'X' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'VALIDATION_FAILED');

    const missingRun = await owner.get(`/payroll-runs/${new mongoose.Types.ObjectId()}`);
    assert.equal(missingRun.status, 404);
    assert.equal(missingRun.body.code, 'NOT_FOUND');
  });

  // ─── Idempotency ───────────────────────────────────────────────────────────

  test('a retried request with the same Idempotency-Key replays instead of acting twice', async () => {
    const key = `create-${crypto.randomUUID()}`;
    const payload = employeePayload('Idem', 'Potent');
    const first = await owner.post('/employees', payload, { 'Idempotency-Key': key });
    const retry = await owner.post('/employees', payload, { 'Idempotency-Key': key });
    assert.equal(first.status, 201);
    assert.equal(retry.status, 201);
    assert.equal(retry.headers.get('idempotent-replayed'), 'true');
    assert.equal(retry.body.data.employee._id, first.body.data.employee._id);
    assert.equal(await Employee.countDocuments({ email: payload.email }), 1);

    const reused = await owner.post('/employees', employeePayload('Other', 'Person'), { 'Idempotency-Key': key });
    assert.equal(reused.status, 422);
    assert.equal(reused.body.code, 'IDEMPOTENCY_KEY_REUSED');

    const malformed = await owner.post('/employees', payload, { 'Idempotency-Key': 'bad key!' });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.code, 'IDEMPOTENCY_KEY_INVALID');
  });

  test('concurrent duplicates with one Idempotency-Key execute exactly once', async () => {
    const key = `concurrent-${crypto.randomUUID()}`;
    const payload = employeePayload('Race', 'Condition');
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => owner.post('/employees', payload, { 'Idempotency-Key': key }))
    );
    const created = responses.filter((r) => r.status === 201);
    assert.ok(created.length >= 1);
    assert.ok(responses.every((r) => r.status === 201 || r.body.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS'));
    assert.equal(new Set(created.map((r) => r.body.data.employee._id)).size, 1);
    assert.equal(await Employee.countDocuments({ email: payload.email }), 1);

    // Archive the extra employees so they do not affect payroll assertions.
    for (const email of [payload.email, employeePayload('Idem', 'Potent').email]) {
      const employee = await Employee.findOne({ email }).lean();
      await owner.del(`/employees/${employee._id}`);
    }
  });

  // ─── Variance classification and finalization controls ────────────────────

  test('February: payroll admin prepares, approver finalizes', async () => {
    const created = await state.payrollAdmin.post('/payroll-runs', { periodMonth: 2, periodYear: 2026 }, { 'Idempotency-Key': `run-feb-${crypto.randomUUID()}` });
    assert.equal(created.status, 201);
    state.febRun = created.body.data.run._id;
    assert.equal((await state.payrollAdmin.post(`/payroll-runs/${state.febRun}/process`)).status, 200);
    assert.equal((await state.payrollAdmin.post(`/payroll-runs/${state.febRun}/finalize`)).status, 403);

    const finalized = await state.approver.post(`/payroll-runs/${state.febRun}/finalize`);
    assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
    const run = await PayrollRun.findById(state.febRun).lean();
    assert.equal(run.finalizationControls.approvedBy, state.approverId);
    assert.equal(run.finalizationControls.override, null);
  });

  test('March: a statutory month-specific change is EXPECTED and does not block', async () => {
    const settings = await owner.patch('/company/settings', { settings: { approvalMode: 'maker_checker' } });
    assert.equal(settings.status, 200);
    assert.ok(await AuditLog.exists({ action: 'COMPANY_SETTINGS_UPDATED', companyId: state.companyId }));

    state.marRun = (await state.payrollAdmin.post('/payroll-runs', { periodMonth: 3, periodYear: 2026 })).body.data.run._id;
    assert.equal((await state.payrollAdmin.post(`/payroll-runs/${state.marRun}/process`)).status, 200);

    const variance = (await state.approver.get(`/payroll-runs/${state.marRun}/variance`)).body.data;
    const flag = variance.flags.find((f) => f.employeeId === state.e1);
    assert.equal(flag.classification, 'EXPECTED');
    assert.equal(flag.severity, 'info');
    assert.deepEqual(flag.causes, ['PT_MONTH_SPECIFIC_AMOUNT']);
    assert.deepEqual(flag.components.map((c) => [c.component, c.delta]), [['professionalTax', -100]]);
    assert.equal(variance.counts.blocking, 0);

    const readiness = (await state.approver.get(`/payroll-runs/${state.marRun}/finalization-readiness`)).body.data;
    assert.equal(readiness.canFinalize, true);
    assert.equal((await state.approver.post(`/payroll-runs/${state.marRun}/finalize`)).status, 200);
  });

  test('April: an unexplained change blocks finalization; maker-checker blocks self-approval; override needs a reason', async () => {
    // Change a salary IN PLACE (same version, no revision): a direct database edit.
    await SalaryStructure.collection.updateOne(
      { employeeId: new mongoose.Types.ObjectId(state.e2), effectiveTo: null },
      { $set: { 'components.specialAllowance': 14001, grossMonthly: 30001 } }
    );

    state.aprRun = (await owner.post('/payroll-runs', { periodMonth: 4, periodYear: 2026 })).body.data.run._id;
    assert.equal((await owner.post(`/payroll-runs/${state.aprRun}/process`)).status, 200);

    const variance = (await state.approver.get(`/payroll-runs/${state.aprRun}/variance`)).body.data;
    const flag = variance.flags.find((f) => f.employeeId === state.e2);
    assert.equal(flag.code, 'PAY_CHANGE_UNEXPLAINED');
    assert.equal(flag.classification, 'UNEXPLAINED');
    assert.equal(flag.severity, 'critical');
    assert.equal(flag.blocking, true);
    assert.ok(flag.components.some((c) => c.component === 'gross' && !c.explained));

    // The owner calculated April, so under maker-checker the owner cannot finalize it.
    const ownerReadiness = (await owner.get(`/payroll-runs/${state.aprRun}/finalization-readiness`)).body.data;
    assert.ok(ownerReadiness.blockers.some((b) => b.code === 'SEGREGATION_OF_DUTIES'));
    const selfApproval = await owner.post(`/payroll-runs/${state.aprRun}/finalize`, { override: { reason: 'Owner approving own calculation' } });
    assert.equal(selfApproval.status, 403);
    assert.equal(selfApproval.body.code, 'SEGREGATION_OF_DUTIES');

    const blocked = await state.approver.post(`/payroll-runs/${state.aprRun}/finalize`);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'VARIANCE_UNEXPLAINED');
    assert.equal(blocked.body.blockingFlags[0].employeeId, state.e2);

    const weakReason = await state.approver.post(`/payroll-runs/${state.aprRun}/finalize`, { override: { reason: 'ok' } });
    assert.equal(weakReason.status, 422);
    assert.equal(weakReason.body.code, 'OVERRIDE_REASON_REQUIRED');

    await assert.rejects(
      payrollFinalizationService.finalize(state.aprRun, state.companyId, { id: state.approverId, email: 'x@example.com', role: 'manager' }, { override: { reason: 'A manager cannot override variance blocks' } }),
      (err) => err.code === 'FORBIDDEN'
    );

    const reason = 'Mid-cycle correction approved by finance on ticket FIN-2231';
    const overridden = await state.approver.post(`/payroll-runs/${state.aprRun}/finalize`, { override: { reason } });
    assert.equal(overridden.status, 200, JSON.stringify(overridden.body));

    const run = await PayrollRun.findById(state.aprRun).lean();
    assert.equal(run.status, 'FINALIZED');
    assert.equal(run.finalizationControls.approvalMode, 'maker_checker');
    assert.equal(run.finalizationControls.preparedBy, state.ownerId);
    assert.equal(run.finalizationControls.approvedBy, state.approverId);
    assert.equal(run.finalizationControls.override.reason, reason);
    assert.ok(await AuditLog.exists({ action: 'PAYROLL_VARIANCE_OVERRIDDEN', entityId: state.aprRun }));
    const finalizedEvent = await AuditLog.findOne({ action: 'PAYROLL_FINALIZED', entityId: state.aprRun }).lean();
    assert.equal(finalizedEvent.meta.finalizationControls.override.reason, reason);
  });

  // ─── Field encryption ──────────────────────────────────────────────────────

  test('field encryption binds values to their record, detects tampering and supports key rotation', () => {
    const context = `${state.companyId}:${state.e1}:employee.pan`;
    const encrypted = encryption.encryptField('ABCDE1234F', { context });
    assert.match(encrypted, /^enc:v1:/);
    assert.notEqual(encrypted, encryption.encryptField('ABCDE1234F', { context }), 'random IV per encryption');
    assert.equal(encryption.decryptField(encrypted, { context }), 'ABCDE1234F');

    assert.throws(
      () => encryption.decryptField(encrypted, { context: `${state.companyId}:${state.e2}:employee.pan` }),
      (err) => err.code === 'ENCRYPTED_FIELD_TAMPERED'
    );
    const parts = encrypted.split(':');
    parts[4] = Buffer.from('tampered').toString('base64url');
    assert.throws(() => encryption.decryptField(parts.join(':'), { context }), (err) => err.code === 'ENCRYPTED_FIELD_TAMPERED');

    const originalKeys = process.env.FIELD_ENCRYPTION_KEYS;
    try {
      // Rotation: add v2 and make it the active key for new values.
      process.env.FIELD_ENCRYPTION_KEYS = `${originalKeys},v2:${crypto.randomBytes(32).toString('base64')}`;
      process.env.FIELD_ENCRYPTION_ACTIVE_KEY = 'v2';
      const rotated = encryption.encryptField('ABCDE1234F', { context });
      assert.equal(encryption.encryptionKeyIdOf(rotated), 'v2');
      assert.equal(encryption.decryptField(encrypted, { context }), 'ABCDE1234F', 'v1 values stay readable');
    } finally {
      process.env.FIELD_ENCRYPTION_KEYS = originalKeys;
      process.env.FIELD_ENCRYPTION_ACTIVE_KEY = 'v1';
    }

    assert.equal(encryption.blindIndex(' abcde1234f ', { scope: 'employee.pan' }), encryption.blindIndex('ABCDE1234F', { scope: 'employee.pan' }));
    assert.notEqual(encryption.blindIndex('ABCDE1234F', { scope: 'employee.pan' }), encryption.blindIndex('ABCDE1234F', { scope: 'bank.account' }));
    assert.equal(encryption.maskValue('123456789012'), '••••••••9012');
  });

  // ─── Transactions ──────────────────────────────────────────────────────────

  // Transactions are part of the product's guarantees, so these tests never
  // skip: a database that cannot run transactions fails the suite.
  test('the test database runs real transactions, like every other environment', () => {
    assert.equal(transactionsAvailable, true, 'MongoDB must be a replica set; start one with scripts/start-replica-set.ps1');
  });

  test('a failure inside finalization rolls back every change', async () => {
    const actor = { id: state.ownerId, email: 'owner@example.com', role: 'admin' };
    const { run } = await payrollRunService.createPayrollRun({
      companyId: state.companyId, periodMonth: 5, periodYear: 2026,
      actorId: actor.id, actorEmail: actor.email, actorRole: actor.role,
    });
    const runId = String(run._id);
    await payrollRunService.processPayrollRun(runId, state.companyId, actor);
    await payrollSnapshotService.materializeSnapshots(runId, state.companyId, actor);

    const originalLog = auditService.log;
    auditService.log = async function failingLog(params, session) {
      if (params.action === 'PAYROLL_FINALIZED') throw new Error('Injected failure after snapshots were marked');
      return originalLog.call(this, params, session);
    };
    try {
      await assert.rejects(payrollSnapshotService.finalizeRun(runId, state.companyId, actor), /Injected failure/);
    } finally {
      auditService.log = originalLog;
    }

    assert.equal((await PayrollRun.findById(runId).lean()).status, 'READY_FOR_FINALIZATION');
    assert.equal(await PayrollSnapshot.countDocuments({ payrollRunId: runId, snapshotStatus: 'FINALIZED' }), 0);
    assert.equal(await AuditLog.countDocuments({ action: 'PAYROLL_FINALIZED', entityId: runId }), 0);
    state.mayRun = runId;
  });

  test('concurrent finalizations: exactly one wins, with one audit event', async () => {
    const actor = { id: state.ownerId, email: 'owner@example.com', role: 'admin' };
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => payrollSnapshotService.finalizeRun(state.mayRun, state.companyId, actor))
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(results.filter((r) => r.status === 'rejected').every((r) => [409, 422].includes(r.reason.statusCode)));

    const run = await PayrollRun.findById(state.mayRun).lean();
    assert.equal(run.status, 'FINALIZED');
    assert.equal(await PayrollSnapshot.countDocuments({ payrollRunId: state.mayRun, snapshotStatus: 'FINALIZED' }), run.successfulEmployeeCount);
    assert.equal(await AuditLog.countDocuments({ action: 'PAYROLL_FINALIZED', entityId: state.mayRun }), 1);
    assert.equal((await auditService.verifyAuditChain()).valid, true);
  });

  test('registration rolls back completely when any part fails', async () => {
    const originalLog = auditService.log;
    auditService.log = async function failingLog(params, session) {
      if (params.action === 'COMPANY_WORKSPACE_CREATED') throw new Error('Injected registration failure');
      return originalLog.call(this, params, session);
    };
    try {
      const res = await createClient().post('/auth/register', {
        name: 'Rolled Back', email: 'rollback@example.com', password: PASSWORD, confirmPassword: PASSWORD,
      });
      assert.equal(res.status, 500);
    } finally {
      auditService.log = originalLog;
    }
    assert.equal(await Admin.countDocuments({ email: 'rollback@example.com' }), 0);
    assert.equal(await Company.countDocuments({ name: "Rolled Back's company" }), 0);
  });
});
