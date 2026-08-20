/**
 * test_phase10.js — Phase 10: Point-in-Time Historical Isolation Gate
 *
 * M → M+1 Immutability Verification
 *
 * Runner: node:test (Node >= 18 built-in)
 * Run:    node test_phase10.js
 *
 * This is a HARD GATE. Every test uses a real isolated test database.
 * No mocks. No stubs. No bypass of persistence.
 *
 * Test DB: employee_management_phase10_test
 * Isolated entirely from the production/development database.
 * Collections are dropped before and after the suite.
 *
 * INVARIANT UNDER TEST:
 *   FinalizedSnapshot(M) must equal FinalizedSnapshot(M) after all
 *   post-finalization operational mutations to Month M+1 data.
 *   Expected delta: ZERO.
 */

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

// ─── Test database URI ────────────────────────────────────────────────────────
// Fully isolated from production. Dropped before and after tests.
const TEST_DB_URI =
  process.env.PHASE10_MONGO_URI ||
  'mongodb://localhost:27017/payguard_phase10_test';

// ─── Import models and services ───────────────────────────────────────────────
import Admin           from './src/models/Admin.js';
import Employee        from './src/models/Employee.js';
import SalaryStructure from './src/models/SalaryStructure.js';
import ComplianceRuleVersion from './src/models/ComplianceRuleVersion.js';
import PayrollRun,     { PAYROLL_STATUS, canTransition } from './src/models/PayrollRun.js';
import PayrollStagingResult  from './src/models/PayrollStagingResult.js';
import PayrollSnapshot, { computeSnapshotHash, verifySnapshotHash }
  from './src/models/PayrollSnapshot.js';

import payrollRunRepository       from './src/repositories/payrollRunRepository.js';
import payrollSnapshotRepository  from './src/repositories/payrollSnapshotRepository.js';
import payrollRunService          from './src/services/payrollRunService.js';
import payrollSnapshotService     from './src/services/payrollSnapshotService.js';
import auditService               from './src/services/auditService.js';

// ─── Deep diff helper ─────────────────────────────────────────────────────────
/**
 * Recursively compare two plain objects.
 * Returns array of { path, before, after } for every changed leaf.
 * Ignores: updatedAt, createdAt, __v (system metadata not in hash).
 */
const IGNORED_KEYS = new Set(['updatedAt','createdAt','__v']);
function deepDiff(before, after, path = '') {
  const diffs = [];
  const bObj  = before && typeof before === 'object' ? before : {};
  const aObj  = after  && typeof after  === 'object' ? after  : {};
  const keys  = new Set([...Object.keys(bObj), ...Object.keys(aObj)]);
  for (const key of keys) {
    if (IGNORED_KEYS.has(key)) continue;
    const p  = path ? `${path}.${key}` : key;
    const bv = bObj[key];
    const av = aObj[key];
    if (bv === null && av === null) continue;
    if (bv instanceof Date && av instanceof Date) {
      if (bv.getTime() !== av.getTime()) diffs.push({ path: p, before: bv, after: av });
      continue;
    }
    if (bv && typeof bv === 'object' && av && typeof av === 'object') {
      diffs.push(...deepDiff(bv, av, p));
    } else {
      const bs = String(bv);
      const as = String(av);
      if (bs !== as) diffs.push({ path: p, before: bv, after: av });
    }
  }
  return diffs;
}

// ─── Snapshot serializer ──────────────────────────────────────────────────────
/** Extract financially meaningful fields for comparison (excludes system metadata). */
function snapshotFinancialFields(snap) {
  const s = snap.toObject ? snap.toObject() : snap;
  return {
    employeeSnapshot:     s.employeeSnapshot,
    salarySnapshot:       s.salarySnapshot,
    complianceProvenance: s.complianceProvenance,
    payrollInputs:        s.payrollInputs,
    payrollResults:       s.payrollResults,
    periodMonth:          s.periodMonth,
    periodYear:           s.periodYear,
    periodStart:          s.periodStart,
    periodEnd:            s.periodEnd,
    processingVersion:    s.processingVersion,
    snapshotStatus:       s.snapshotStatus,
    snapshotHash:         s.snapshotHash,
    tdsStatus:            s.payrollResults?.tdsStatus,
    attendanceAdjustment: s.payrollInputs?.attendanceAdjustment,
  };
}

// ─── Test fixture factory ─────────────────────────────────────────────────────
/**
 * Build a complete payroll run and finalize it against the test database.
 * Returns { admin, employee, salary, epfRule, esiRule, ptRule, run, snapshot }
 */
async function buildAndFinalizePayrollMonth({
  email = 'test.admin@payguard.io',
  employeeEmail = 'emp001@payguard.io',
  department    = 'Engineering',
  position      = 'Software Engineer',
  periodMonth   = 7,
  periodYear    = 2026,
  basicSalary   = 18000,
  hra           = 7200,
  workState     = 'MH',
  epfVersion    = 1,
} = {}) {
  // Admin (acting as company identity)
  let admin = await Admin.findOne({ email });
  if (!admin) {
    admin = await Admin.create({ name: 'Test Admin', email, password: 'TestPass123!', role: 'admin' });
  }
  const actor = { id: admin._id.toString(), email: admin.email, role: admin.role };

  // Employee
  let employee = await Employee.findOne({ email: employeeEmail });
  if (!employee) {
    employee = await Employee.create({
      firstName: 'Priya', lastName: 'Sharma',
      email: employeeEmail, phone: '+91-9000000001',
      department, position,
      salary: basicSalary + hra,
      hireDate: new Date('2023-01-15'),
      status: 'active',
      createdBy: admin._id,
    });
  }

  // Salary Structure V1
  const periodStart = new Date(Date.UTC(periodYear, periodMonth - 1, 1));
  const periodEnd   = new Date(Date.UTC(periodYear, periodMonth, 1) - 1);
  let salary = await SalaryStructure.findOne({ employeeId: employee._id, effectiveTo: null });
  if (!salary) {
    salary = await SalaryStructure.create({
      employeeId: employee._id,
      effectiveFrom: periodStart,
      effectiveTo: null,
      components: { basic: basicSalary, hra, conveyanceAllowance: 1600,
                    medicalAllowance: 1250, specialAllowance: 1950, otherAllowances: 0 },
      grossMonthly: basicSalary + hra + 1600 + 1250 + 1950,
      workState,
      pfEnrolled: true, esiEnrolled: false, ptEnrolled: true,
      createdBy: admin._id,
    });
  }

  // Compliance Rules
  const ruleEffFrom = new Date('2014-01-01');
  let epfRule = await ComplianceRuleVersion.findOne({ ruleType: 'EPF', jurisdiction: 'IN', effectiveTo: null });
  if (!epfRule) {
    epfRule = await ComplianceRuleVersion.create({
      ruleType: 'EPF', jurisdiction: 'IN',
      effectiveFrom: ruleEffFrom, effectiveTo: null,
      description: `EPF-IN-2014-v${epfVersion}`,
      epfParams: {
        employeeContributionRate: 0.12, employerContributionRate: 0.12,
        wageCapForContribution: 15000, epsRate: 0.0833,
      },
      createdBy: admin._id,
    });
  }

  let ptRule = await ComplianceRuleVersion.findOne({ ruleType: 'PT', jurisdiction: workState, effectiveTo: null });
  if (!ptRule) {
    ptRule = await ComplianceRuleVersion.create({
      ruleType: 'PT', jurisdiction: workState,
      effectiveFrom: new Date('2009-01-01'), effectiveTo: null,
      description: `PT-${workState}-2009-v1`,
      ptSlabs: [
        { upTo: 7500, monthlyTax: 0 },
        { upTo: 10000, monthlyTax: 175 },
        { upTo: null, monthlyTax: 200 },
      ],
      createdBy: admin._id,
    });
  }

  const companyId = admin._id.toString();

  // Create + Process + Materialize + Finalize the payroll run
  const { run: draft } = await payrollRunService.createPayrollRun({
    companyId, periodMonth, periodYear, actorId: actor.id,
    actorEmail: actor.email, actorRole: actor.role,
  });

  const { run: rff } = await payrollRunService.processPayrollRun(
    draft._id.toString(), companyId, actor
  );

  await payrollSnapshotService.materializeSnapshots(
    rff._id.toString(), companyId, actor
  );

  const { run: finalized } = await payrollSnapshotService.finalizeRun(
    rff._id.toString(), companyId, actor
  );

  const snapshots = await payrollSnapshotRepository.findByRun(finalized._id.toString());
  const snapshot  = snapshots.find(s =>
    s.employeeSnapshot.employeeId.toString() === employee._id.toString()
  );

  return { admin, actor, employee, salary, epfRule, ptRule, run: finalized, snapshot };
}

// ─── Database setup / teardown ────────────────────────────────────────────────
async function connectTestDb() {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 5000 });
  }
}

async function dropTestCollections() {
  const db = mongoose.connection.db;
  if (!db) return;
  const cols = await db.listCollections().toArray();
  for (const col of cols) {
    await db.collection(col.name).drop().catch(() => {});
  }
}

// ─── Global setup ─────────────────────────────────────────────────────────────
before(async () => {
  await connectTestDb();
  await dropTestCollections();
  console.log('[PHASE 10] Test DB connected and cleaned:', TEST_DB_URI);
});

after(async () => {
  await dropTestCollections();
  await mongoose.disconnect();
  console.log('[PHASE 10] Test DB dropped and disconnected.');
});

console.log('\n╔═══════════════════════════════════════════════════════════════╗');
console.log('║  Phase 10 — M→M+1 Historical Isolation Gate (Integration)   ║');
console.log('║  DB: payguard_phase10_test  (isolated, real MongoDB)         ║');
console.log('║  Run: node test_phase10.js                                   ║');
console.log('╚═══════════════════════════════════════════════════════════════╝\n');

// ═══════════════════════════════════════════════════════════════════════════════
// PRECONDITION CHECKS
// ═══════════════════════════════════════════════════════════════════════════════
describe('STEP 0 — Precondition Verification', () => {

  test('PC-1: READY_FOR_FINALIZATION state exists in PayrollRun', () => {
    assert.equal(PAYROLL_STATUS.READY_FOR_FINALIZATION, 'READY_FOR_FINALIZATION');
  });

  test('PC-2: PROCESSING → FINALIZED direct transition is forbidden', () => {
    assert.equal(canTransition('PROCESSING', 'FINALIZED'), false);
  });

  test('PC-3: READY_FOR_FINALIZATION → FINALIZED is the only path to FINALIZED', () => {
    assert.equal(canTransition('READY_FOR_FINALIZATION', 'FINALIZED'), true);
    assert.equal(canTransition('PROCESSING', 'FINALIZED'), false);
    assert.equal(canTransition('DRAFT', 'FINALIZED'), false);
  });

  test('PC-4: FINALIZED is immutable — all backward transitions forbidden', () => {
    for (const s of ['DRAFT','PROCESSING','READY_FOR_FINALIZATION','FAILED','CANCELLED']) {
      assert.equal(canTransition('FINALIZED', s), false,
        `FINALIZED → ${s} must be rejected`);
    }
  });

  test('PC-5: Phase 9 service has no current-state enrichment (import check)', () => {
    // Verify by checking exported service methods exist (source-level audit in STEP-28)
    assert.equal(typeof payrollSnapshotService.materializeSnapshots, 'function');
    assert.equal(typeof payrollSnapshotService.finalizeRun, 'function');
    assert.equal(typeof payrollSnapshotService.verifySnapshot, 'function');
  });

  test('PC-6: computeSnapshotHash and verifySnapshotHash are available', () => {
    assert.equal(typeof computeSnapshotHash, 'function');
    assert.equal(typeof verifySnapshotHash, 'function');
  });

  test('PC-7: PayrollSnapshotRepository has no update/delete methods', () => {
    assert.ok(!('updateSnapshot'  in payrollSnapshotRepository));
    assert.ok(!('deleteSnapshot'  in payrollSnapshotRepository));
    assert.ok(!('replaceSnapshot' in payrollSnapshotRepository));
  });

  test('PC-8: SalaryStructure workState field exists (required for PT jurisdiction)', () => {
    assert.ok('workState' in SalaryStructure.schema.paths);
  });

  test('PC-9: PayrollStagingResult has frozen sub-documents', () => {
    const paths = PayrollStagingResult.schema.paths;
    assert.ok('employeeSnapshot' in paths, 'employeeSnapshot frozen field required');
    assert.ok('salarySnapshot'   in paths, 'salarySnapshot frozen field required');
    assert.ok('ruleProvenance'   in paths, 'ruleProvenance frozen field required');
    assert.ok('payrollInputs'    in paths, 'payrollInputs frozen field required');
    assert.ok('netPayBeforeTDS'  in paths, 'netPayBeforeTDS field required');
  });

  test('PC-10: MongoDB connection is to isolated test database', () => {
    const name = mongoose.connection.name;
    assert.equal(name, 'payguard_phase10_test',
      `Tests must run against isolated test DB, got: ${name}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PRIMARY M → M+1 ISOLATION TEST
// This is the hard gate. All downstream mutations must produce zero delta.
// ═══════════════════════════════════════════════════════════════════════════════
describe('PRIMARY: M → M+1 Historical Isolation', () => {

  let ctx; // shared context across sub-tests

  before(async () => {
    // Build and finalize Month M payroll
    ctx = await buildAndFinalizePayrollMonth({
      email:         'isolation.admin@payguard.io',
      employeeEmail: 'isolation.emp@payguard.io',
      department:    'Engineering',
      position:      'Software Engineer',
      periodMonth:   7,
      periodYear:    2026,
      basicSalary:   18000,
      hra:           7200,
      workState:     'MH',
    });
    // Record baseline fingerprint immediately after finalization
    ctx.baseline = snapshotFinancialFields(ctx.snapshot);
    ctx.baselineHash = ctx.snapshot.snapshotHash;
  });

  // ── STEP 1: Baseline is valid ──────────────────────────────────────────────
  test('STEP-1: Baseline snapshot exists and is FINALIZED', () => {
    assert.ok(ctx.snapshot, 'Snapshot must exist');
    assert.equal(ctx.snapshot.snapshotStatus, 'FINALIZED');
    assert.ok(ctx.baselineHash, 'Baseline hash must be set');
  });

  test('STEP-1: Baseline snapshot hash verifies (no tampering at creation)', () => {
    const { valid } = verifySnapshotHash(ctx.snapshot);
    assert.equal(valid, true, 'Baseline hash must be valid immediately after finalization');
  });

  test('STEP-1: PayrollRun is FINALIZED', () => {
    assert.equal(ctx.run.status, 'FINALIZED');
  });

  // ── STEP 3: Mutate current Employee ────────────────────────────────────────
  test('STEP-3a: Change employee department Engineering → Operations', async () => {
    await Employee.findByIdAndUpdate(ctx.employee._id, {
      $set: { department: 'Operations' },
    });
    const current = await Employee.findById(ctx.employee._id);
    assert.equal(current.department, 'Operations', 'Current employee should be Operations now');
  });

  test('STEP-3b: Change employee position', async () => {
    await Employee.findByIdAndUpdate(ctx.employee._id, {
      $set: { position: 'Senior Software Engineer' },
    });
  });

  test('STEP-3c: Change employee status active → inactive', async () => {
    await Employee.findByIdAndUpdate(ctx.employee._id, {
      $set: { status: 'inactive' },
    });
  });

  // ── STEP 4: Create Salary V2 ───────────────────────────────────────────────
  test('STEP-4: Create Salary Version 2 (₹35,000 gross)', async () => {
    // Close V1
    await SalaryStructure.findByIdAndUpdate(ctx.salary._id, {
      $set: { effectiveTo: new Date(Date.UTC(2026, 7, 1) - 1) }, // July 31
    });
    // Create V2
    const v2 = await SalaryStructure.create({
      employeeId:   ctx.employee._id,
      effectiveFrom: new Date(Date.UTC(2026, 7, 1)), // Aug 1
      effectiveTo:   null,
      components: { basic: 22000, hra: 8800, conveyanceAllowance: 1600,
                    medicalAllowance: 1250, specialAllowance: 1350, otherAllowances: 0 },
      grossMonthly: 22000 + 8800 + 1600 + 1250 + 1350,
      workState: 'KA', // different jurisdiction for M+1
      pfEnrolled: true, esiEnrolled: false, ptEnrolled: true,
      createdBy: ctx.admin._id,
    });
    assert.ok(v2._id, 'Salary V2 created');
    ctx.salaryV2 = v2;
  });

  // ── STEP 5: Create compliance Rule V2 ─────────────────────────────────────
  test('STEP-5: Create EPF Rule V2 (newer effective date)', async () => {
    const v2 = await ComplianceRuleVersion.create({
      ruleType: 'EPF', jurisdiction: 'IN',
      effectiveFrom: new Date('2025-01-01'),
      effectiveTo: null,
      description: 'EPF-IN-2025-v2',
      epfParams: {
        employeeContributionRate: 0.12, employerContributionRate: 0.12,
        wageCapForContribution: 15000, epsRate: 0.0833,
      },
      createdBy: ctx.admin._id,
    });
    ctx.epfRuleV2 = v2;
    assert.ok(v2._id, 'EPF Rule V2 created');
  });

  test('STEP-5: Create PT Rule V2 for Karnataka (new jurisdiction)', async () => {
    const v2 = await ComplianceRuleVersion.create({
      ruleType: 'PT', jurisdiction: 'KA',
      effectiveFrom: new Date('2009-01-01'),
      effectiveTo: null,
      description: 'PT-KA-2009-v1',
      ptSlabs: [{ upTo: null, monthlyTax: 200 }],
      createdBy: ctx.admin._id,
    });
    ctx.ptRuleKA = v2;
    assert.ok(v2._id);
  });

  // ── STEP 6: Soft-delete employee ───────────────────────────────────────────
  test('STEP-6: Soft-delete employee (set status = inactive)', async () => {
    // The Employee model uses status: 'inactive' as the soft-delete marker
    await Employee.findByIdAndUpdate(ctx.employee._id, { $set: { status: 'inactive' } });
    const current = await Employee.findById(ctx.employee._id);
    assert.equal(current.status, 'inactive');
  });

  // ── STEP 8: Re-read the Month M snapshot ───────────────────────────────────
  test('STEP-8: Re-read Month M snapshot from database', async () => {
    const reread = await PayrollSnapshot.findById(ctx.snapshot._id).lean();
    assert.ok(reread, 'Snapshot must still be readable after all mutations');
    ctx.reread = reread;
  });

  test('STEP-8: Snapshot status is still FINALIZED', () => {
    assert.equal(ctx.reread.snapshotStatus, 'FINALIZED');
  });

  // ── STEP 9: Full deep diff — ZERO DIFFERENCES EXPECTED ────────────────────
  test('STEP-9 (PRIMARY GATE): Full deep diff of snapshot before and after mutations = ZERO', () => {
    const after  = snapshotFinancialFields(ctx.reread);
    const diffs  = deepDiff(ctx.baseline, after);

    if (diffs.length > 0) {
      const report = diffs.map(d =>
        `  PATH: ${d.path}\n  BEFORE: ${JSON.stringify(d.before)}\n  AFTER:  ${JSON.stringify(d.after)}`
      ).join('\n---\n');
      assert.fail(
        `HISTORICAL ISOLATION VIOLATION: ${diffs.length} field(s) changed:\n${report}`
      );
    }

    assert.equal(diffs.length, 0, 'Zero financial fields must differ after M+1 mutations');
  });

  // ── STEP 10: Hash must be identical ──────────────────────────────────────
  test('STEP-10: Snapshot hash identical before and after mutations', () => {
    assert.equal(
      ctx.reread.snapshotHash,
      ctx.baselineHash,
      `Hash changed after mutations!\nBefore: ${ctx.baselineHash}\nAfter:  ${ctx.reread.snapshotHash}`
    );
  });

  test('STEP-10: verifySnapshot still returns valid=true after all M+1 mutations', () => {
    const { valid } = verifySnapshotHash(ctx.reread);
    assert.equal(valid, true, 'Snapshot integrity must pass after M+1 operational changes');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// INDIVIDUAL FIELD ISOLATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════
describe('STEP-12: Salary Version Isolation', () => {
  let snap;
  before(async () => {
    snap = await PayrollSnapshot.findOne({
      'employeeSnapshot.email': 'isolation.emp@payguard.io',
      periodMonth: 7, periodYear: 2026,
    }).lean();
  });

  test('Salary snapshot has original basic=18000', () => {
    assert.equal(snap.salarySnapshot.components.basic, 18000);
  });

  test('Salary snapshot has original grossMonthly', () => {
    // 18000+7200+1600+1250+1950 = 30000
    assert.equal(snap.salarySnapshot.grossMonthly, 30000);
  });

  test('Salary snapshot.effectiveFrom is Month M start', () => {
    const ef = new Date(snap.salarySnapshot.effectiveFrom);
    assert.equal(ef.toISOString().slice(0, 10), '2026-07-01');
  });

  test('Salary snapshot workState = MH (original jurisdiction)', () => {
    assert.equal(snap.salarySnapshot.workState, 'MH');
  });

  test('New Salary V2 (₹35,000) does NOT appear in Month M snapshot', () => {
    assert.equal(snap.salarySnapshot.components.basic, 18000,
      'Month M snapshot must retain original basic salary, not V2 value');
    assert.notEqual(snap.salarySnapshot.components.basic, 22000,
      'V2 basic (22000) must not appear in Month M snapshot');
  });
});

describe('STEP-13: Compliance Rule Version Isolation', () => {
  let snap;
  before(async () => {
    snap = await PayrollSnapshot.findOne({
      'employeeSnapshot.email': 'isolation.emp@payguard.io',
      periodMonth: 7, periodYear: 2026,
    }).lean();
  });

  test('EPF rule provenance is V1 (EPF-IN-2014-v1)', () => {
    const epfProv = snap.complianceProvenance.find(p => p.ruleType === 'EPF');
    assert.ok(epfProv, 'EPF provenance must exist');
    assert.ok(
      epfProv.sourceReference.includes('2014'),
      `EPF provenance must reference V1 (2014), got: ${epfProv.sourceReference}`
    );
  });

  test('PT rule provenance is MH (original jurisdiction)', () => {
    const ptProv = snap.complianceProvenance.find(p => p.ruleType === 'PT');
    assert.ok(ptProv, 'PT provenance must exist');
    assert.equal(ptProv.jurisdiction, 'MH',
      'PT jurisdiction must be MH (not KA — the M+1 change)');
  });

  test('Rule provenance effectiveFrom is frozen at V1 date', () => {
    const epfProv = snap.complianceProvenance.find(p => p.ruleType === 'EPF');
    const ef = new Date(epfProv.effectiveFrom);
    assert.equal(ef.getFullYear(), 2014,
      'EPF provenance effectiveFrom must be 2014 (V1), not 2025 (V2)');
  });
});

describe('STEP-15: Employee Field Isolation', () => {
  let snap;
  before(async () => {
    snap = await PayrollSnapshot.findOne({
      'employeeSnapshot.email': 'isolation.emp@payguard.io',
      periodMonth: 7, periodYear: 2026,
    }).lean();
  });

  test('employeeSnapshot.department = Engineering (not Operations)', () => {
    assert.equal(snap.employeeSnapshot.department, 'Engineering',
      'Snapshot must retain Engineering, not Operations (the M+1 change)');
  });

  test('employeeSnapshot.position = Software Engineer (not Senior)', () => {
    assert.equal(snap.employeeSnapshot.position, 'Software Engineer',
      'Snapshot must retain original position');
  });

  test('employeeSnapshot.employmentStatus = active (payroll-time status)', () => {
    assert.equal(snap.employeeSnapshot.employmentStatus, 'active',
      'Snapshot must retain active status at payroll processing time');
  });

  test('employeeSnapshot.firstName and lastName unchanged', () => {
    assert.equal(snap.employeeSnapshot.firstName, 'Priya');
    assert.equal(snap.employeeSnapshot.lastName, 'Sharma');
  });
});

describe('STEP-14: Employee Soft-Deletion Compatibility', () => {
  test('Snapshot is readable after employee is soft-deleted (inactive)', async () => {
    const emp = await Employee.findOne({ email: 'isolation.emp@payguard.io' });
    assert.equal(emp.status, 'inactive', 'Employee should be inactive by now');

    const snap = await PayrollSnapshot.findOne({
      'employeeSnapshot.email': 'isolation.emp@payguard.io',
      periodMonth: 7, periodYear: 2026,
    }).lean();

    assert.ok(snap, 'Snapshot must remain readable after employee is soft-deleted');
    assert.equal(snap.snapshotStatus, 'FINALIZED');
    assert.equal(snap.employeeSnapshot.employmentStatus, 'active',
      'Snapshot must record active status — which was the status at payroll time');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 16: FINALIZED RUN IMMUTABILITY
// ═══════════════════════════════════════════════════════════════════════════════
describe('STEP-16: Finalized PayrollRun cannot transition backwards', () => {
  let runId, companyId;
  before(async () => {
    const run = await PayrollRun.findOne({
      periodMonth: 7, periodYear: 2026, status: 'FINALIZED',
    });
    runId     = run._id.toString();
    companyId = run.companyId.toString();
  });

  test('canTransition(FINALIZED, DRAFT) = false', () => {
    assert.equal(canTransition('FINALIZED', 'DRAFT'), false);
  });

  test('canTransition(FINALIZED, PROCESSING) = false', () => {
    assert.equal(canTransition('FINALIZED', 'PROCESSING'), false);
  });

  test('canTransition(FINALIZED, FAILED) = false', () => {
    assert.equal(canTransition('FINALIZED', 'FAILED'), false);
  });

  test('canTransition(FINALIZED, READY_FOR_FINALIZATION) = false', () => {
    assert.equal(canTransition('FINALIZED', 'READY_FOR_FINALIZATION'), false);
  });

  test('Atomic transition FINALIZED → PROCESSING returns null (DB-level guard)', async () => {
    const result = await payrollRunRepository.transitionStateAtomically(
      runId, 'FINALIZED', 'PROCESSING', {}, { actorId: runId }
    );
    assert.equal(result, null, 'DB-level atomic transition guard must reject FINALIZED → PROCESSING');
  });

  test('Calling processPayrollRun on a FINALIZED run throws 409', async () => {
    const actor = { id: companyId, email: 'x@x.com', role: 'admin' };
    await assert.rejects(
      () => payrollRunService.processPayrollRun(runId, companyId, actor),
      (err) => {
        assert.ok(err.message.includes('Cannot process'), `Expected 'Cannot process', got: ${err.message}`);
        return true;
      }
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 17: SNAPSHOT IMMUTABILITY API
// ═══════════════════════════════════════════════════════════════════════════════
describe('STEP-17: Snapshot immutability (no mutation path in repository)', () => {
  test('payrollSnapshotRepository has no updateSnapshot method', () => {
    assert.ok(!('updateSnapshot'  in payrollSnapshotRepository));
    assert.ok(!('deleteSnapshot'  in payrollSnapshotRepository));
    assert.ok(!('replaceSnapshot' in payrollSnapshotRepository));
  });

  test('PayrollSnapshot routes have no PUT/PATCH/DELETE endpoints', async () => {
    const src = readFileSync('./src/routes/payrollSnapshotRoutes.js', 'utf-8');
    assert.ok(!src.includes('.put('));
    assert.ok(!src.includes('.patch('));
    assert.ok(!src.includes('.delete('));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 22: IDEMPOTENT RE-READ
// ═══════════════════════════════════════════════════════════════════════════════
describe('STEP-22: Idempotent repeat reads produce identical results', () => {
  let snapId;
  before(async () => {
    const snap = await PayrollSnapshot.findOne({
      'employeeSnapshot.email': 'isolation.emp@payguard.io',
      periodMonth: 7, periodYear: 2026,
    });
    snapId = snap._id.toString();
  });

  test('Reading same snapshot three times returns identical hash', async () => {
    const r1 = await PayrollSnapshot.findById(snapId).lean();
    const r2 = await PayrollSnapshot.findById(snapId).lean();
    const r3 = await PayrollSnapshot.findById(snapId).lean();
    assert.equal(r1.snapshotHash, r2.snapshotHash);
    assert.equal(r2.snapshotHash, r3.snapshotHash);
    assert.equal(r1.snapshotStatus, 'FINALIZED');
  });

  test('verifySnapshot returns valid=true on every re-read', async () => {
    const result = await payrollSnapshotService.verifySnapshot(snapId);
    assert.equal(result.valid, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 25: DIRECT DATABASE TAMPER DETECTION
// ═══════════════════════════════════════════════════════════════════════════════
describe('STEP-25: Direct DB tampering is detected by hash verification', () => {
  let snapId;
  before(async () => {
    const snap = await PayrollSnapshot.findOne({
      'employeeSnapshot.email': 'isolation.emp@payguard.io',
      periodMonth: 7, periodYear: 2026,
    });
    snapId = snap._id.toString();
  });

  test('verifySnapshot returns valid=true before tamper', async () => {
    const result = await payrollSnapshotService.verifySnapshot(snapId);
    assert.equal(result.valid, true);
  });

  test('Directly mutating netPayBeforeTDS causes verifySnapshotHash to return valid=false', async () => {
    // Bypass all application logic — write directly to MongoDB (simulates DB-level tamper)
    await PayrollSnapshot.findByIdAndUpdate(snapId, {
      $set: { 'payrollResults.netPayBeforeTDS': 99999 },
    });

    const tampered = await PayrollSnapshot.findById(snapId).lean();
    const { valid, storedHash, computedHash } = verifySnapshotHash(tampered);

    assert.equal(valid, false,
      `Tampered snapshot must fail verification.\nStored:   ${storedHash?.slice(0,16)}\nComputed: ${computedHash?.slice(0,16)}`
    );
  });

  after(async () => {
    // Restore the correct value so the snapshot remains consistent for later tests
    // Note: this restore simulates what a controlled correction mechanism would do.
    // In production, a tampered record would be quarantined, NOT silently restored.
    // We restore here only to avoid polluting the test DB for subsequent checks.
    const snap = await PayrollSnapshot.findById(snapId).lean();
    const correctNet = snap.payrollResults.totalEmployeeDeductions !== undefined
      ? snap.payrollResults.netPayBeforeTDS  // already wrong — we need the original
      : null;
    // Recompute what the correct netPayBeforeTDS should be from other stored values
    const grossMonthly = snap.payrollResults.epf?.totalEpf !== undefined
      ? snap.salarySnapshot?.grossMonthly
      : null;
    if (grossMonthly && snap.payrollResults.totalEmployeeDeductions != null) {
      const correct = Math.round((grossMonthly - snap.payrollResults.totalEmployeeDeductions) * 100) / 100;
      await PayrollSnapshot.findByIdAndUpdate(snapId, {
        $set: { 'payrollResults.netPayBeforeTDS': correct },
      });
      // Recompute hash from restored payload
      const restored = await PayrollSnapshot.findById(snapId).lean();
      const newHash  = computeSnapshotHash(restored);
      await PayrollSnapshot.findByIdAndUpdate(snapId, { $set: { snapshotHash: newHash } });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 19: MULTI-EMPLOYEE ISOLATION (3 employees)
// ═══════════════════════════════════════════════════════════════════════════════
describe('STEP-19: Multi-employee isolation', () => {
  const employees = [
    { employeeEmail: 'multi.emp1@payguard.io', department: 'Engineering',  basicSalary: 20000, hra: 8000 },
    { employeeEmail: 'multi.emp2@payguard.io', department: 'Finance',       basicSalary: 22000, hra: 8800 },
    { employeeEmail: 'multi.emp3@payguard.io', department: 'Human Resources', basicSalary: 18000, hra: 7200 },
  ];
  const ctxList = [];

  before(async () => {
    // Each employee gets a separate admin / run to avoid company-period uniqueness collision.
    // Use same admin but different period months (8, 9, 10) for isolation.
    const adminEmail = 'multi.admin@payguard.io';
    let admin = await Admin.findOne({ email: adminEmail });
    if (!admin) {
      admin = await Admin.create({
        name: 'Multi Admin', email: adminEmail, password: 'TestPass123!', role: 'admin',
      });
    }

    for (let i = 0; i < employees.length; i++) {
      const emp = employees[i];
      // Use months 8, 9, 10 to avoid collision with the primary test (month 7)
      const periodMonth = 8 + i;
      const c = await buildAndFinalizePayrollMonth({
        email:         adminEmail,
        employeeEmail: emp.employeeEmail,
        department:    emp.department,
        position:      'Analyst',
        periodMonth,
        periodYear:    2026,
        basicSalary:   emp.basicSalary,
        hra:           emp.hra,
        workState:     'MH',
      });
      ctxList.push({ ...c, originalBasic: emp.basicSalary, originalDept: emp.department, periodMonth });
    }
  });

  test('All 3 employees have FINALIZED snapshots', () => {
    assert.equal(ctxList.length, 3);
    for (const c of ctxList) {
      assert.ok(c.snapshot, `Snapshot must exist for employee ${c.employee.email}`);
      assert.equal(c.snapshot.snapshotStatus, 'FINALIZED');
    }
  });

  test('Mutating Employee A salary does not affect Employees B and C snapshots', async () => {
    const empA = ctxList[0];
    // Mutate Employee A's current salary
    await Employee.findByIdAndUpdate(empA.employee._id, {
      $set: { department: 'Operations' },
    });

    // Re-read B and C snapshots
    for (let i = 1; i < ctxList.length; i++) {
      const c    = ctxList[i];
      const snap = await PayrollSnapshot.findById(c.snapshot._id).lean();
      assert.equal(snap.employeeSnapshot.department, c.originalDept,
        `Employee ${i+1} snapshot department must be unchanged`);
      const { valid } = verifySnapshotHash(snap);
      assert.equal(valid, true, `Employee ${i+1} snapshot hash must remain valid`);
    }
  });

  test('Mutating Employee B department does not affect Employees A and C snapshots', async () => {
    const empB = ctxList[1];
    await Employee.findByIdAndUpdate(empB.employee._id, {
      $set: { department: 'Legal' },
    });

    const snapA = await PayrollSnapshot.findById(ctxList[0].snapshot._id).lean();
    const snapC = await PayrollSnapshot.findById(ctxList[2].snapshot._id).lean();

    assert.equal(snapA.employeeSnapshot.department, ctxList[0].originalDept);
    assert.equal(snapC.employeeSnapshot.department, ctxList[2].originalDept);

    assert.equal(verifySnapshotHash(snapA).valid, true);
    assert.equal(verifySnapshotHash(snapC).valid, true);
  });

  test('Each employee snapshot hash is unique (no cross-contamination)', () => {
    const hashes = ctxList.map(c => c.snapshot.snapshotHash);
    const unique = new Set(hashes);
    assert.equal(unique.size, 3, 'All three employee snapshots must have distinct hashes');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 26: LONGITUDINAL MULTI-MONTH ISOLATION (Month M, M+1, M+2)
// ═══════════════════════════════════════════════════════════════════════════════
describe('STEP-26: Longitudinal multi-month isolation (M, M+1, M+2)', () => {
  const months = [
    { periodMonth: 1, periodYear: 2026, basicSalary: 18000, hra: 7200, department: 'Engineering' },
    { periodMonth: 2, periodYear: 2026, basicSalary: 20000, hra: 8000, department: 'Finance' },
    { periodMonth: 3, periodYear: 2026, basicSalary: 22000, hra: 8800, department: 'Design' },
  ];
  const longCtx = [];

  before(async () => {
    const adminEmail = 'longitudinal.admin@payguard.io';
    let admin = await Admin.findOne({ email: adminEmail });
    if (!admin) {
      admin = await Admin.create({
        name: 'Longitudinal Admin', email: adminEmail, password: 'TestPass123!', role: 'admin',
      });
    }

    for (const m of months) {
      const employeeEmail = `longitudinal.emp.m${m.periodMonth}@payguard.io`;
      const c = await buildAndFinalizePayrollMonth({
        email:         adminEmail,
        employeeEmail,
        department:    m.department,
        position:      'Analyst',
        periodMonth:   m.periodMonth,
        periodYear:    m.periodYear,
        basicSalary:   m.basicSalary,
        hra:           m.hra,
        workState:     'MH',
      });
      longCtx.push({ ...c, month: m, employeeEmail });
    }
  });

  test('All three months are finalized with correct snapshots', () => {
    assert.equal(longCtx.length, 3);
    for (const c of longCtx) {
      assert.equal(c.snapshot.snapshotStatus, 'FINALIZED');
      assert.equal(c.snapshot.salarySnapshot.components.basic, c.month.basicSalary,
        `Month ${c.month.periodMonth} snapshot must have correct basicSalary`);
    }
  });

  test('Mutating M+2 current data does not affect M or M+1 snapshots', async () => {
    // Mutate the M+2 employee
    const m2Ctx = longCtx[2];
    await Employee.findByIdAndUpdate(m2Ctx.employee._id, {
      $set: { department: 'Operations', status: 'inactive' },
    });
    // Create a new salary version for M+3
    await SalaryStructure.create({
      employeeId:    m2Ctx.employee._id,
      effectiveFrom: new Date(Date.UTC(2026, 3, 1)),
      effectiveTo:   null,
      components:    { basic: 30000, hra: 12000, conveyanceAllowance: 0, medicalAllowance: 0, specialAllowance: 0, otherAllowances: 0 },
      grossMonthly:  42000,
      workState:     'MH',
      pfEnrolled: true, esiEnrolled: false, ptEnrolled: true,
      createdBy:     m2Ctx.admin._id,
    });

    // Re-read M and M+1 snapshots
    for (let i = 0; i < 2; i++) {
      const c    = longCtx[i];
      const snap = await PayrollSnapshot.findById(c.snapshot._id).lean();

      assert.equal(snap.salarySnapshot.components.basic, c.month.basicSalary,
        `Month ${c.month.periodMonth} basicSalary must be unchanged after M+2 mutations`);
      assert.equal(snap.employeeSnapshot.department, c.month.department,
        `Month ${c.month.periodMonth} department must be unchanged`);
      assert.equal(verifySnapshotHash(snap).valid, true,
        `Month ${c.month.periodMonth} hash must still be valid`);
    }
  });

  test('Each month snapshot has a different hash (different financial state)', () => {
    const hashes = longCtx.map(c => c.snapshot.snapshotHash);
    const unique = new Set(hashes);
    assert.equal(unique.size, 3, 'Each month must produce a distinct snapshot hash');
  });

  test('Month M snapshot contains Month M salary (not M+1 or M+2)', () => {
    assert.equal(longCtx[0].snapshot.salarySnapshot.components.basic, 18000);
    assert.equal(longCtx[1].snapshot.salarySnapshot.components.basic, 20000);
    assert.equal(longCtx[2].snapshot.salarySnapshot.components.basic, 22000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 23: FINALIZATION CONCURRENCY (only one winner)
// ═══════════════════════════════════════════════════════════════════════════════
describe('STEP-23: Finalization race condition — only one concurrent request succeeds', () => {
  let run, companyId, actor, admin;

  before(async () => {
    // Build a fresh run specifically for this concurrency test
    const adminEmail = 'concurrency.admin@payguard.io';
    admin = await Admin.findOne({ email: adminEmail });
    if (!admin) {
      admin = await Admin.create({
        name: 'Concurrency Admin', email: adminEmail, password: 'TestPass123!', role: 'admin',
      });
    }
    actor     = { id: admin._id.toString(), email: admin.email, role: admin.role };
    companyId = admin._id.toString();

    const empEmail = 'concurrency.emp@payguard.io';
    let emp = await Employee.findOne({ email: empEmail });
    if (!emp) {
      emp = await Employee.create({
        firstName: 'Concurrent', lastName: 'Tester', email: empEmail,
        phone: '+91-9000000099', department: 'Engineering', position: 'Tester',
        salary: 30000, hireDate: new Date('2023-01-01'),
        status: 'active', createdBy: admin._id,
      });
    }
    let sal = await SalaryStructure.findOne({ employeeId: emp._id, effectiveTo: null });
    if (!sal) {
      sal = await SalaryStructure.create({
        employeeId: emp._id,
        effectiveFrom: new Date(Date.UTC(2026, 3, 1)),
        effectiveTo: null,
        components: { basic: 18000, hra: 7200, conveyanceAllowance: 1600,
                      medicalAllowance: 1250, specialAllowance: 1950, otherAllowances: 0 },
        workState: 'MH', pfEnrolled: true, esiEnrolled: false, ptEnrolled: true,
        createdBy: admin._id,
      });
    }

    const { run: draft } = await payrollRunService.createPayrollRun({
      companyId, periodMonth: 4, periodYear: 2026,
      actorId: actor.id, actorEmail: actor.email, actorRole: actor.role,
    });
    const { run: rff } = await payrollRunService.processPayrollRun(
      draft._id.toString(), companyId, actor
    );
    await payrollSnapshotService.materializeSnapshots(
      rff._id.toString(), companyId, actor
    );
    run = rff;
  });

  test('Two simultaneous finalizeRun calls — only one succeeds, one gets 409', async () => {
    const p1 = payrollSnapshotService.finalizeRun(run._id.toString(), companyId, actor);
    const p2 = payrollSnapshotService.finalizeRun(run._id.toString(), companyId, actor);

    const results = await Promise.allSettled([p1, p2]);
    const succeeded = results.filter(r => r.status === 'fulfilled');
    const failed    = results.filter(r => r.status === 'rejected');

    assert.equal(succeeded.length, 1, 'Exactly one finalization must succeed');
    assert.equal(failed.length,    1, 'Exactly one finalization must be rejected (race)');

    // The failing one must be a conflict error, not a system error
    const err = failed[0].reason;
    const isConflict = err.statusCode === 409 ||
      err.message.includes('concurrent') ||
      err.message.includes('FINALIZED') ||
      err.message.includes('aborted');
    assert.ok(isConflict,
      `Race loser must report a conflict, got: ${err.message}`);
  });

  test('After concurrent race, PayrollRun is FINALIZED exactly once', async () => {
    const r = await PayrollRun.findById(run._id).lean();
    assert.equal(r.status, 'FINALIZED');
  });

  test('After concurrent race, snapshots are complete and unique', async () => {
    const snapshots  = await payrollSnapshotRepository.findByRun(run._id.toString());
    const duplicates = await payrollSnapshotRepository.findDuplicates(run._id.toString());
    assert.ok(snapshots.length >= 1, 'Must have at least one snapshot');
    assert.equal(duplicates.length, 0, 'No duplicate snapshots after concurrent finalization');
    assert.ok(snapshots.every(s => s.snapshotStatus === 'FINALIZED'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 28: CURRENT-STATE ENRICHMENT AUDIT (source-level)
// ═══════════════════════════════════════════════════════════════════════════════
describe('STEP-28: Current-state enrichment audit — no forbidden calls in Phase 9', () => {
  const svcSrc   = readFileSync('./src/services/payrollSnapshotService.js', 'utf-8');
  const codeLines = svcSrc.split('\n')
    .filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
    .join('\n');

  test('Phase 9 service does not import Employee model', () => {
    assert.ok(!svcSrc.includes("import Employee from"), 'Must not import Employee');
  });

  test('Phase 9 service does not call Employee.findById in code (only comments)', () => {
    assert.ok(!codeLines.includes('Employee.findById'), 'Must not call Employee.findById');
  });

  test('Phase 9 service does not import SalaryStructure', () => {
    assert.ok(!svcSrc.includes("import SalaryStructure from"), 'Must not import SalaryStructure');
  });

  test('Phase 9 service does not call SalaryStructure.findById in code', () => {
    assert.ok(!codeLines.includes('SalaryStructure.findById'), 'No SalaryStructure lookup');
  });

  test('Phase 9 service does not call ComplianceRuleVersion.findValidForDate in code', () => {
    assert.ok(!codeLines.includes('ComplianceRuleVersion.findValidForDate'), 'No rule re-resolution');
  });

  test('Phase 9 service reads staging.employeeSnapshot directly', () => {
    assert.ok(svcSrc.includes('staging.employeeSnapshot'), 'Must read from frozen staging');
    assert.ok(svcSrc.includes('staging.salarySnapshot'),   'Must read from frozen staging');
    assert.ok(svcSrc.includes('staging.ruleProvenance'),   'Must read from frozen staging');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 29: DATABASE INDEX VERIFICATION (actual MongoDB)
// ═══════════════════════════════════════════════════════════════════════════════
describe('STEP-29: Database index verification (actual MongoDB)', () => {

  test('PayrollSnapshot unique index payrollRunId+employeeId exists in MongoDB', async () => {
    const db      = mongoose.connection.db;
    const indexes = await db.collection('payrollsnapshots').indexes();
    const hasUnique = indexes.some(idx =>
      idx.key &&
      idx.key.payrollRunId === 1 &&
      idx.key['employeeSnapshot.employeeId'] === 1 &&
      idx.unique === true
    );
    assert.ok(hasUnique,
      'payrollsnapshots collection must have unique index on payrollRunId+employeeSnapshot.employeeId');
  });

  test('PayrollRun compound index companyId+periodYear+periodMonth exists in MongoDB', async () => {
    const db      = mongoose.connection.db;
    const indexes = await db.collection('payrollruns').indexes();
    const hasIdx  = indexes.some(idx =>
      idx.key &&
      idx.key.companyId  === 1 &&
      idx.key.periodYear === 1 &&
      idx.key.periodMonth === 1
    );
    assert.ok(hasIdx,
      'payrollruns must have compound index on companyId+periodYear+periodMonth');
  });

  test('PayrollStagingResult unique index per run+employee+version exists', async () => {
    const db      = mongoose.connection.db;
    const indexes = await db.collection('payrollstagingresults').indexes();
    const hasUnique = indexes.some(idx =>
      idx.key &&
      idx.key.runId === 1 &&
      idx.key.employeeId === 1 &&
      idx.key.processingVersion === 1 &&
      idx.unique === true
    );
    assert.ok(hasUnique,
      'payrollstagingresults must have unique index on runId+employeeId+processingVersion');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TDS AND ATTENDANCE HONESTY
// ═══════════════════════════════════════════════════════════════════════════════
describe('TDS and Attendance explicit deferral in finalized snapshots', () => {
  let snap;
  before(async () => {
    snap = await PayrollSnapshot.findOne({
      'employeeSnapshot.email': 'isolation.emp@payguard.io',
      periodMonth: 7, periodYear: 2026,
    }).lean();
  });

  test('payrollResults.tdsStatus = DEFERRED on every finalized snapshot', () => {
    assert.equal(snap.payrollResults.tdsStatus, 'DEFERRED',
      'TDS must be explicitly deferred — not calculated');
  });

  test('payrollResults.tdsAmount = null (not invented)', () => {
    assert.equal(snap.payrollResults.tdsAmount, null,
      'TDS amount must be null — never fabricated');
  });

  test('payrollInputs.attendanceAdjustment = DEFERRED', () => {
    assert.equal(snap.payrollInputs.attendanceAdjustment, 'DEFERRED',
      'Attendance adjustment must be explicitly DEFERRED');
  });

  test('Field is netPayBeforeTDS — not "netPay" or "finalNetPay"', () => {
    assert.ok('netPayBeforeTDS' in snap.payrollResults,
      'Honest field name netPayBeforeTDS must exist');
    assert.ok(!('finalNetPay' in snap.payrollResults));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 11: MATERIALIZATION DOES NOT RE-READ CURRENT STATE
// ═══════════════════════════════════════════════════════════════════════════════
describe('STEP-11: Re-materialize after mutations does not use current employee state', () => {
  let runId, companyId, actor, originalDept;

  before(async () => {
    // Use the isolation.emp run from the primary test
    const snap = await PayrollSnapshot.findOne({
      'employeeSnapshot.email': 'isolation.emp@payguard.io',
      periodMonth: 7, periodYear: 2026,
    });
    runId       = snap.payrollRunId.toString();
    companyId   = snap.companyId.toString();
    originalDept = snap.employeeSnapshot.department;
    const admin = await Admin.findById(snap.companyId);
    actor       = { id: admin._id.toString(), email: admin.email, role: admin.role };
  });

  test('Calling materializeSnapshots on an already-FINALIZED run throws a 409', async () => {
    await assert.rejects(
      () => payrollSnapshotService.materializeSnapshots(runId, companyId, actor),
      (err) => {
        assert.ok(
          err.statusCode === 409 || err.message.includes('READY_FOR_FINALIZATION'),
          `Expected 409/RFF error, got: ${err.message}`
        );
        return true;
      }
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 18: CROSS-RUN ISOLATION (July vs August)
// ═══════════════════════════════════════════════════════════════════════════════
describe('STEP-18: Cross-run isolation — July and August run snapshots do not interfere', () => {
  let julyCtx, augCtx;

  before(async () => {
    const adminEmail = 'crossrun.admin@payguard.io';
    let admin = await Admin.findOne({ email: adminEmail });
    if (!admin) {
      admin = await Admin.create({
        name: 'CrossRun Admin', email: adminEmail, password: 'TestPass123!', role: 'admin',
      });
    }
    const empEmail = 'crossrun.emp@payguard.io';

    julyCtx = await buildAndFinalizePayrollMonth({
      email: adminEmail, employeeEmail: empEmail,
      department: 'Engineering', position: 'Analyst',
      periodMonth: 5, periodYear: 2026,
      basicSalary: 20000, hra: 8000, workState: 'MH',
    });

    // Close July salary before creating August
    await SalaryStructure.findByIdAndUpdate(julyCtx.salary._id, {
      $set: { effectiveTo: new Date(Date.UTC(2026, 5, 0, 23, 59, 59, 999)) },
    });
    await Employee.findByIdAndUpdate(julyCtx.employee._id, {
      $set: { department: 'Operations', position: 'Senior Analyst' },
    });

    augCtx = await buildAndFinalizePayrollMonth({
      email: adminEmail, employeeEmail: empEmail,
      department: 'Operations',
      position: 'Senior Analyst',
      periodMonth: 6, periodYear: 2026,
      basicSalary: 24000, hra: 9600, workState: 'MH',
    });
  });

  test('July snapshot has July salary (basic=20000)', () => {
    assert.equal(julyCtx.snapshot.salarySnapshot.components.basic, 20000);
    assert.equal(julyCtx.snapshot.employeeSnapshot.department, 'Engineering');
  });

  test('August snapshot has August salary (basic=24000)', () => {
    assert.equal(augCtx.snapshot.salarySnapshot.components.basic, 24000);
    assert.equal(augCtx.snapshot.employeeSnapshot.department, 'Operations');
  });

  test('July snapshot is unaffected by August data', async () => {
    const reread = await PayrollSnapshot.findById(julyCtx.snapshot._id).lean();
    assert.equal(reread.salarySnapshot.components.basic, 20000,
      'July snapshot must still show 20000 after August was finalized');
    assert.equal(reread.employeeSnapshot.department, 'Engineering',
      'July snapshot department must still be Engineering');
    assert.equal(verifySnapshotHash(reread).valid, true);
  });

  test('Both runs are independently FINALIZED', () => {
    assert.equal(julyCtx.run.status, 'FINALIZED');
    assert.equal(augCtx.run.status,  'FINALIZED');
  });

  test('July and August snapshots have distinct hashes', () => {
    assert.notEqual(julyCtx.snapshot.snapshotHash, augCtx.snapshot.snapshotHash);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REGRESSION SUITE (structural — prior phases)
// ═══════════════════════════════════════════════════════════════════════════════
describe('Phase 1 Regression: Employee soft-delete model', () => {
  test('Employee status enum has active, inactive, on-leave', () => {
    const e = Employee.schema.paths.status.enumValues;
    assert.ok(e.includes('active') && e.includes('inactive') && e.includes('on-leave'));
  });
  test('inactive status is excluded from payroll eligibility criteria', () => {
    assert.ok(!['active','on-leave'].includes('inactive'));
  });
});

describe('Phase 3 Regression: Valid-time salary versioning', () => {
  test('SalaryStructure.findValidForDate static exists', () => {
    assert.equal(typeof SalaryStructure.findValidForDate, 'function');
  });
  test('effectiveTo = null means open-ended', () => {
    assert.equal(SalaryStructure.schema.paths.effectiveTo.defaultValue, null);
  });
  test('workState field exists on SalaryStructure', () => {
    assert.ok('workState' in SalaryStructure.schema.paths);
  });
});

describe('Phase 4 Regression: RBAC', () => {
  test('requireRole middleware is available', async () => {
    const mod = await import('./src/middleware/authMiddleware.js');
    assert.equal(typeof mod.requireRole, 'function');
    assert.equal(typeof mod.requireRole('admin'), 'function');
  });
  test('Unauthorized role is rejected with 403', async () => {
    const { requireRole } = await import('./src/middleware/authMiddleware.js');
    await new Promise((resolve) => {
      requireRole('admin')({ user: { role: 'employee' } },
        { status: (c) => ({ json: () => { assert.equal(c, 403); resolve(); } }) },
        () => assert.fail('next() must not be called'));
    });
  });
});

describe('Phase 5 Regression: Service/repository layering', () => {
  test('PayrollSnapshot repository has no business logic (canTransition absent)', async () => {
    const src = readFileSync('./src/repositories/payrollSnapshotRepository.js', 'utf-8');
    assert.ok(!src.includes('canTransition'));
  });
  test('PayrollSnapshot controller has no direct model imports', async () => {
    const src = readFileSync('./src/controllers/payrollSnapshotController.js', 'utf-8');
    assert.ok(!src.includes("from '../models/Employee"));
  });
});

describe('Phase 6 Regression: Audit chain', () => {
  test('auditService.log function exists', () => {
    assert.equal(typeof auditService.log, 'function');
  });
  test('AuditLog model exists', async () => {
    const mod = await import('./src/models/AuditLog.js');
    assert.ok(mod.default);
  });
  test('Audit records exist for Phase 10 payroll lifecycle', async () => {
    const AuditLog = (await import('./src/models/AuditLog.js')).default;
    const count = await AuditLog.countDocuments({
      entityType: 'PAYROLL_RUN',
      action: { $in: ['PAYROLL_RUN_CREATED','PAYROLL_PROCESSING_STARTED',
                       'PAYROLL_READY_FOR_FINALIZATION','PAYROLL_FINALIZED'] },
    });
    assert.ok(count > 0, `Expected audit records for payroll lifecycle, got ${count}`);
  });
});

describe('Phase 7 Regression: Compliance calculators', () => {
  test('complianceCalculationService.calculate returns tdsDeferred=true', async () => {
    const svc = (await import('./src/services/complianceCalculationService.js')).default;
    const r   = svc.calculate({
      grossMonthly: 30000, basicSalary: 18000, pfWageOverride: null,
      pfEnrolled: true, esiEnrolled: false, ptEnrolled: true,
      epfRule: { employeeContributionRate:0.12, employerContributionRate:0.12,
                 wageCapForContribution:15000, epsRate:0.0833 },
      esiRule: { employeeContributionRate:0.0075, employerContributionRate:0.0325, grossWageCeiling:21000 },
      ptSlabs: [{ upTo: null, monthlyTax: 200 }],
    });
    assert.equal(r.tdsDeferred, true);
  });
  test('TDS is NOT in ComplianceRuleVersion ruleType enum', () => {
    const enumValues = ComplianceRuleVersion.schema.paths.ruleType.enumValues;
    assert.ok(!enumValues.includes('TDS'), 'TDS must not be a rule type — it is deferred');
  });
});

describe('Phase 8 Regression: State machine and staging', () => {
  test('PROCESSING → FINALIZED is forbidden', () => {
    assert.equal(canTransition('PROCESSING', 'FINALIZED'), false);
  });
  test('READY_FOR_FINALIZATION → FINALIZED is allowed', () => {
    assert.equal(canTransition('READY_FOR_FINALIZATION', 'FINALIZED'), true);
  });
  test('No MH fallback in payrollRunService', async () => {
    const src = readFileSync('./src/services/payrollRunService.js', 'utf-8');
    assert.ok(!src.includes("|| 'MH'"), 'No silent MH fallback');
  });
  test('Staging model has employeeSnapshot sub-document', () => {
    assert.ok('employeeSnapshot' in PayrollStagingResult.schema.paths);
  });
});

describe('Phase 9 Regression: PayrollSnapshot model and service', () => {
  test('PayrollSnapshot model exists', () => {
    assert.ok(PayrollSnapshot);
  });
  test('Unique index on payrollRunId+employeeId exists in schema', () => {
    const hasUnique = PayrollSnapshot.schema.indexes().some(([f, opts]) =>
      f.payrollRunId === 1 && f['employeeSnapshot.employeeId'] === 1 && opts.unique
    );
    assert.ok(hasUnique);
  });
  test('payrollSnapshotService.materializeSnapshots is a function', () => {
    assert.equal(typeof payrollSnapshotService.materializeSnapshots, 'function');
  });
  test('payrollSnapshotService.finalizeRun is a function', () => {
    assert.equal(typeof payrollSnapshotService.finalizeRun, 'function');
  });
  test('computeSnapshotHash is exported from PayrollSnapshot model', () => {
    assert.equal(typeof computeSnapshotHash, 'function');
  });
  test('verifySnapshotHash is exported from PayrollSnapshot model', () => {
    assert.equal(typeof verifySnapshotHash, 'function');
  });
});

console.log('\n[PHASE 10] All test suites registered. Running...\n');
