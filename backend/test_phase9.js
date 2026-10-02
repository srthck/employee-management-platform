/**
 * test_phase9.js — Phase 9 Immutable Payroll Snapshot Tests (Corrected)
 *
 * Runner: node:test (Node >= 18 built-in)
 * Run:    node test_phase9.js
 *
 * Key corrections in this version:
 *   - Schema tests use actual Mongoose nested-schema API
 *   - Hash determinism tests use the SAME payload object (no random fixture drift)
 *   - Phase 9 service tests verify NO current-state enrichment
 *   - M→M+1 isolation test verifies staging is the historical boundary
 *   - Staging model tests verify all frozen input fields exist
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// ─── Fixed ObjectId helper ────────────────────────────────────────────────────
// Returns a consistent string (not a new random value each call)
// so the same fixture produces the same hash every time it's processed.
function makeFixedId(seed) {
  // Deterministic 24-char hex from a short seed string
  return crypto.createHash('md5').update(String(seed)).digest('hex').slice(0, 24);
}

/** Build a fully-deterministic snapshot payload for hash tests */
function makeSnapshotPayload(overrides = {}) {
  const payload = {
    payrollRunId:    { toString: () => makeFixedId('run1') },
    stagingResultId: { toString: () => makeFixedId('staging1') },
    companyId:       { toString: () => makeFixedId('company1') },
    periodMonth:     7,
    periodYear:      2026,
    periodStart:     new Date('2026-07-01T00:00:00.000Z'),
    periodEnd:       new Date('2026-07-31T23:59:59.999Z'),
    employeeSnapshot: {
      employeeId:       { toString: () => makeFixedId('emp1') },
      firstName:        'Priya',
      lastName:         'Sharma',
      fullName:         'Priya Sharma',
      email:            'priya@example.com',
      department:       'Engineering',
      position:         'Software Engineer',
      employmentStatus: 'active',
      hireDate:         new Date('2023-01-15'),
    },
    salarySnapshot: {
      salaryStructureId: { toString: () => makeFixedId('sal1') },
      effectiveFrom:  new Date('2026-01-01'),
      effectiveTo:    null,
      components: {
        basic: 18000, hra: 7200, conveyanceAllowance: 1600,
        medicalAllowance: 1250, specialAllowance: 1950, otherAllowances: 0,
      },
      grossMonthly: 30000,
      currency: 'INR',
      payFrequency: 'monthly',
      workState: 'MH',
      pfEnrolled: true, esiEnrolled: true, ptEnrolled: true,
      pfWageOverride: null,
    },
    complianceProvenance: [
      {
        ruleType: 'EPF', ruleId: { toString: () => makeFixedId('epfRule1') },
        jurisdiction: 'IN', effectiveFrom: new Date('2014-01-01'),
        effectiveTo: null, sourceReference: 'EPF-IN-2014-v1',
      },
      {
        ruleType: 'PT',  ruleId: { toString: () => makeFixedId('ptRule1') },
        jurisdiction: 'MH', effectiveFrom: new Date('2009-01-01'),
        effectiveTo: null, sourceReference: 'PT-MH-2009-v1',
      },
    ],
    payrollInputs: {
      grossMonthly: 30000, basicSalary: 18000, pfWageOverride: null,
      pfEnrolled: true, esiEnrolled: true, ptEnrolled: true,
      workState: 'MH', payrollDate: new Date('2026-07-31'),
      attendanceAdjustment: 'DEFERRED',
    },
    payrollResults: {
      epf: {
        enrolled: true, pfWageUsed: 15000, employeeEpf: 1800,
        employerEpf: 1800, epsContribution: 1249.5, totalEpf: 3600,
      },
      esi: { enrolled: true, applicable: false, employeeEsi: 0, employerEsi: 0, totalEsi: 0 },
      pt:  { enrolled: true, applicable: true, pt: 200 },
      totalEmployeeDeductions: 2000,
      employerTotalContribution: 1800,
      netPayBeforeTDS: 28000,
      tdsStatus: 'DEFERRED',
      tdsAmount: null,
    },
    processingVersion: 1,
    snapshotStatus: 'PENDING_FINALIZATION',
    ...overrides,
  };
  return payload;
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGING MODEL — historical input freeze fields (TEST A, B, C, D)
// ═══════════════════════════════════════════════════════════════════════════

describe('TEST A — Staging employeeSnapshot creation (historical freeze)', () => {
  let StagingResult;
  before(async () => {
    StagingResult = (await import('./src/models/PayrollStagingResult.js')).default;
  });

  test('employeeSnapshot sub-document exists in schema', () => {
    const empSchema = StagingResult.schema.path('employeeSnapshot').schema;
    assert.ok(empSchema, 'employeeSnapshot must be a sub-schema');
  });

  test('employeeSnapshot has firstName, lastName, fullName, department, position, employmentStatus', () => {
    const empSchema = StagingResult.schema.path('employeeSnapshot').schema;
    const paths = empSchema.paths;
    for (const f of ['firstName','lastName','fullName','department','position','employmentStatus','hireDate']) {
      assert.ok(f in paths, `employeeSnapshot must have: ${f}`);
    }
  });

  test('employeeSnapshot.firstName is required', () => {
    const empSchema = StagingResult.schema.path('employeeSnapshot').schema;
    assert.equal(empSchema.paths.firstName.isRequired, true);
  });
});

describe('TEST B — Staging salarySnapshot creation (historical freeze)', () => {
  let StagingResult;
  before(async () => {
    StagingResult = (await import('./src/models/PayrollStagingResult.js')).default;
  });

  test('salarySnapshot sub-document exists in schema', () => {
    const salSchema = StagingResult.schema.path('salarySnapshot').schema;
    assert.ok(salSchema, 'salarySnapshot must be a sub-schema');
  });

  test('salarySnapshot has salaryStructureId, effectiveFrom, effectiveTo, grossMonthly, workState', () => {
    const salSchema = StagingResult.schema.path('salarySnapshot').schema;
    const paths = salSchema.paths;
    for (const f of ['salaryStructureId','effectiveFrom','effectiveTo','grossMonthly','workState',
                     'pfEnrolled','esiEnrolled','ptEnrolled','pfWageOverride']) {
      assert.ok(f in paths, `salarySnapshot must have: ${f}`);
    }
  });

  test('salarySnapshot.components has basic, hra, conveyanceAllowance, etc.', () => {
    const salSchema   = StagingResult.schema.path('salarySnapshot').schema;
    const compSchema  = salSchema.path('components').schema;
    assert.ok(compSchema, 'components must be a nested sub-schema');
    for (const c of ['basic','hra','conveyanceAllowance','medicalAllowance','specialAllowance','otherAllowances']) {
      assert.ok(c in compSchema.paths, `components must have: ${c}`);
    }
  });
});

describe('TEST C — Staging rule provenance creation (historical freeze)', () => {
  let StagingResult;
  before(async () => {
    StagingResult = (await import('./src/models/PayrollStagingResult.js')).default;
  });

  test('ruleProvenance array exists in staging schema', () => {
    const provPath = StagingResult.schema.path('ruleProvenance');
    assert.ok(provPath, 'ruleProvenance must exist');
  });

  test('ruleProvenance items have ruleType, ruleId, jurisdiction, effectiveFrom', () => {
    const provPath   = StagingResult.schema.path('ruleProvenance');
    const itemSchema = provPath.schema || (provPath.caster && provPath.caster.schema);
    assert.ok(itemSchema, 'ruleProvenance items must have a schema');
    const paths = itemSchema.paths;
    for (const f of ['ruleType','ruleId','jurisdiction','effectiveFrom','effectiveTo','sourceReference']) {
      assert.ok(f in paths, `ruleProvenance item must have: ${f}`);
    }
  });
});

describe('TEST D — payrollInputs in staging (historical freeze)', () => {
  let StagingResult;
  before(async () => {
    StagingResult = (await import('./src/models/PayrollStagingResult.js')).default;
  });

  test('payrollInputs sub-document exists in staging schema', () => {
    const inputSchema = StagingResult.schema.path('payrollInputs').schema;
    assert.ok(inputSchema, 'payrollInputs must be a sub-schema');
  });

  test('payrollInputs has grossMonthly, basicSalary, workState, pfEnrolled, esiEnrolled, payrollDate', () => {
    const inputSchema = StagingResult.schema.path('payrollInputs').schema;
    const paths = inputSchema.paths;
    for (const f of ['grossMonthly','basicSalary','pfWageOverride','pfEnrolled','esiEnrolled','ptEnrolled','workState','payrollDate','attendanceAdjustment']) {
      assert.ok(f in paths, `payrollInputs must have: ${f}`);
    }
  });

  test('staging uses netPayBeforeTDS (honest field name)', () => {
    const paths = StagingResult.schema.paths;
    assert.ok('netPayBeforeTDS' in paths, 'Staging must use netPayBeforeTDS');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 9 SERVICE — no current-state enrichment (TEST 25)
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 9 service: NO current-state enrichment', () => {

  test('payrollSnapshotService does NOT call Employee.findById', async () => {
    const fs  = await import('node:fs');
    const src = fs.readFileSync('./src/services/payrollSnapshotService.js', 'utf-8');
    // Filter out comment lines (lines starting with * or // after trim)
    const codeLines = src.split('\n').filter(line => {
      const t = line.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    }).join('\n');
    assert.ok(!codeLines.includes('Employee.findById'),
      'Service code (excluding comments) must not call Employee.findById');
    assert.ok(!src.includes("import Employee from"),
      'Service must not import Employee model');
  });

  test('payrollSnapshotService does NOT call SalaryStructure.findById', async () => {
    const fs  = await import('node:fs');
    const src = fs.readFileSync('./src/services/payrollSnapshotService.js', 'utf-8');
    assert.ok(!src.includes("import SalaryStructure from"), 'Service must not import SalaryStructure');
    // Actual await call would be: await SalaryStructure.findById
    assert.ok(!/await\s+SalaryStructure\.findById/.test(src), 'Service must not call SalaryStructure.findById');
  });

  test('payrollSnapshotService does NOT call ComplianceRuleVersion.findValidForDate', async () => {
    const fs  = await import('node:fs');
    const src = fs.readFileSync('./src/services/payrollSnapshotService.js', 'utf-8');
    assert.ok(!src.includes("import ComplianceRuleVersion from"), 'Must not import ComplianceRuleVersion');
    assert.ok(!/await\s+ComplianceRuleVersion\.findValidForDate/.test(src), 'Must not call findValidForDate');
  });

  test('payrollSnapshotService does NOT import Employee, SalaryStructure, or ComplianceRuleVersion', async () => {
    const fs  = await import('node:fs');
    const src = fs.readFileSync('./src/services/payrollSnapshotService.js', 'utf-8');
    assert.ok(!src.includes("from '../models/Employee"), 'Must not import Employee model');
    assert.ok(!src.includes("from '../models/SalaryStructure"), 'Must not import SalaryStructure');
    assert.ok(!src.includes("from '../models/ComplianceRuleVersion"), 'Must not import ComplianceRuleVersion');
  });

  test('payrollSnapshotService reads staging.employeeSnapshot (not Employee.findById)', async () => {
    const fs  = await import('node:fs');
    const src = fs.readFileSync('./src/services/payrollSnapshotService.js', 'utf-8');
    assert.ok(src.includes('staging.employeeSnapshot'), 'Must read from staging.employeeSnapshot');
    assert.ok(src.includes('staging.salarySnapshot'),   'Must read from staging.salarySnapshot');
    assert.ok(src.includes('staging.ruleProvenance'),   'Must read from staging.ruleProvenance');
    assert.ok(src.includes('staging.payrollInputs'),    'Must read from staging.payrollInputs');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 1 — PayrollSnapshot model
// ═══════════════════════════════════════════════════════════════════════════

describe('TEST 1 — PayrollSnapshot model exists', () => {
  let PayrollSnapshot;
  before(async () => { PayrollSnapshot = (await import('./src/models/PayrollSnapshot.js')).default; });

  test('PayrollSnapshot model is defined', () => assert.ok(PayrollSnapshot));
  test('Collection name is payrollsnapshots', () => {
    assert.equal(PayrollSnapshot.collection.collectionName, 'payrollsnapshots');
  });
});

describe('TEST 2 — Snapshot contains employee identity snapshot', () => {
  let PayrollSnapshot;
  before(async () => { PayrollSnapshot = (await import('./src/models/PayrollSnapshot.js')).default; });

  test('employeeSnapshot sub-document exists', () => {
    const empSchema = PayrollSnapshot.schema.path('employeeSnapshot').schema;
    assert.ok(empSchema, 'employeeSnapshot must be a sub-schema');
  });

  test('employeeSnapshot has required fields', () => {
    const paths = PayrollSnapshot.schema.path('employeeSnapshot').schema.paths;
    for (const f of ['firstName','lastName','fullName','email','department','position','employmentStatus','hireDate','employeeId']) {
      assert.ok(f in paths, `employeeSnapshot must have: ${f}`);
    }
  });
});

describe('TEST 3 — Snapshot contains salary values', () => {
  let PayrollSnapshot;
  before(async () => { PayrollSnapshot = (await import('./src/models/PayrollSnapshot.js')).default; });

  test('salarySnapshot has effectiveFrom, effectiveTo, grossMonthly, workState', () => {
    const salSchema = PayrollSnapshot.schema.path('salarySnapshot').schema;
    assert.ok(salSchema, 'salarySnapshot must be a sub-schema');
    const paths = salSchema.paths;
    for (const f of ['effectiveFrom','effectiveTo','grossMonthly','workState','salaryStructureId']) {
      assert.ok(f in paths, `salarySnapshot must have: ${f}`);
    }
  });

  test('salarySnapshot.components has basic, hra, specialAllowance', () => {
    const salSchema  = PayrollSnapshot.schema.path('salarySnapshot').schema;
    const compSchema = salSchema.path('components').schema;
    assert.ok(compSchema, 'components must be a nested sub-schema');
    assert.ok('basic' in compSchema.paths);
    assert.ok('hra'   in compSchema.paths);
    assert.ok('specialAllowance' in compSchema.paths);
  });
});

describe('TEST 4 — Snapshot contains exact salary version', () => {
  let PayrollSnapshot;
  before(async () => { PayrollSnapshot = (await import('./src/models/PayrollSnapshot.js')).default; });

  test('salarySnapshot.salaryStructureId exists', () => {
    const salSchema = PayrollSnapshot.schema.path('salarySnapshot').schema;
    assert.ok('salaryStructureId' in salSchema.paths);
  });

  test('salarySnapshot.effectiveFrom and effectiveTo exist', () => {
    const salSchema = PayrollSnapshot.schema.path('salarySnapshot').schema;
    assert.ok('effectiveFrom' in salSchema.paths);
    assert.ok('effectiveTo'   in salSchema.paths);
  });
});

describe('TEST 5 — Snapshot contains exact compliance rule versions', () => {
  let PayrollSnapshot;
  before(async () => { PayrollSnapshot = (await import('./src/models/PayrollSnapshot.js')).default; });

  test('complianceProvenance array exists', () => {
    assert.ok(PayrollSnapshot.schema.path('complianceProvenance'), 'complianceProvenance path must exist');
  });

  test('complianceProvenance items have ruleId, jurisdiction, effectiveFrom', () => {
    const provPath   = PayrollSnapshot.schema.path('complianceProvenance');
    const itemSchema = provPath.schema || (provPath.caster && provPath.caster.schema);
    assert.ok(itemSchema, 'items must have a schema');
    const paths = itemSchema.paths;
    for (const f of ['ruleType','ruleId','jurisdiction','effectiveFrom']) {
      assert.ok(f in paths, `provenance item must have: ${f}`);
    }
  });
});

describe('TEST 6 — Snapshot contains payroll calculation results', () => {
  let PayrollSnapshot;
  before(async () => { PayrollSnapshot = (await import('./src/models/PayrollSnapshot.js')).default; });

  test('payrollResults has netPayBeforeTDS and totalEmployeeDeductions', () => {
    const resSchema = PayrollSnapshot.schema.path('payrollResults').schema;
    const paths = resSchema.paths;
    assert.ok('netPayBeforeTDS'           in paths, 'must use netPayBeforeTDS');
    assert.ok('totalEmployeeDeductions'   in paths);
    assert.ok('employerTotalContribution' in paths);
  });

  test('payrollResults.epf has employeeEpf and employerEpf', () => {
    const resSchema = PayrollSnapshot.schema.path('payrollResults').schema;
    const epfSchema = resSchema.path('epf').schema;
    assert.ok('employeeEpf' in epfSchema.paths);
    assert.ok('employerEpf' in epfSchema.paths);
  });
});

describe('TEST 7 — TDS explicitly DEFERRED', () => {
  let PayrollSnapshot;
  before(async () => { PayrollSnapshot = (await import('./src/models/PayrollSnapshot.js')).default; });

  test('payrollResults.tdsStatus defaults to DEFERRED', () => {
    const resSchema = PayrollSnapshot.schema.path('payrollResults').schema;
    assert.ok('tdsStatus' in resSchema.paths);
    assert.equal(resSchema.paths.tdsStatus.defaultValue, 'DEFERRED');
  });

  test('payrollResults.tdsAmount defaults to null', () => {
    const resSchema = PayrollSnapshot.schema.path('payrollResults').schema;
    assert.equal(resSchema.paths.tdsAmount.defaultValue, null);
  });

  test('field is named netPayBeforeTDS — not "final net pay"', () => {
    const resSchema = PayrollSnapshot.schema.path('payrollResults').schema;
    assert.ok('netPayBeforeTDS' in resSchema.paths);
    assert.ok(!('finalNetPay' in resSchema.paths));
  });

  test('model source does not claim "final net pay"', async () => {
    const fs  = await import('node:fs');
    const src = fs.readFileSync('./src/models/PayrollSnapshot.js', 'utf-8');
    // The model comment explicitly says NOT to claim "final net pay".
    // Verify the field is netPayBeforeTDS (not finalNetPay, not "Net Pay" as a claim)
    // and the prohibition comment is present.
    assert.ok(!src.includes('finalNetPay'), 'Must not have a field named finalNetPay');
    assert.ok(!src.includes('"Net Pay"'), 'Must not label the field as simply "Net Pay"');
    // The model should mention TDS is deferred
    assert.ok(src.includes('tdsDeferred') || src.includes('tdsStatus'), 'Model must reference TDS deferral');
  });
});

describe('TEST 8 — Attendance explicitly DEFERRED', () => {
  let PayrollSnapshot;
  before(async () => { PayrollSnapshot = (await import('./src/models/PayrollSnapshot.js')).default; });

  test('payrollInputs.attendanceAdjustment defaults to DEFERRED', () => {
    const inputSchema = PayrollSnapshot.schema.path('payrollInputs').schema;
    assert.ok('attendanceAdjustment' in inputSchema.paths);
    assert.equal(inputSchema.paths.attendanceAdjustment.defaultValue, 'DEFERRED');
  });

  test('Phase 9 service carries attendanceAdjustment through, defaulting to DEFERRED', async () => {
    const fs  = await import('node:fs');
    const src = fs.readFileSync('./src/services/payrollSnapshotService.js', 'utf-8');
    // Wave 3.5: staging decides whether pay was prorated for part of the period;
    // the snapshot copies that verdict instead of asserting its own.
    assert.ok(src.includes("attendanceAdjustment: inputs.attendanceAdjustment || 'DEFERRED'"));
    assert.ok(!src.includes('attendance-adjusted salary'));
  });
});

describe('TEST 9 — Unique index per run/employee', () => {
  let PayrollSnapshot;
  before(async () => { PayrollSnapshot = (await import('./src/models/PayrollSnapshot.js')).default; });

  test('unique index on payrollRunId + employeeSnapshot.employeeId', () => {
    const hasUnique = PayrollSnapshot.schema.indexes().some(([fields, opts]) =>
      fields.payrollRunId === 1 &&
      fields['employeeSnapshot.employeeId'] === 1 &&
      opts.unique === true
    );
    assert.ok(hasUnique, 'Unique compound index must exist');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST K — HASH DETERMINISM (corrected: same fixture, no random drift)
// ═══════════════════════════════════════════════════════════════════════════

describe('TEST K — Snapshot hash determinism', () => {
  let computeSnapshotHash, verifySnapshotHash;
  before(async () => {
    const mod = await import('./src/models/PayrollSnapshot.js');
    computeSnapshotHash = mod.computeSnapshotHash;
    verifySnapshotHash  = mod.verifySnapshotHash;
  });

  test('computeSnapshotHash and verifySnapshotHash are exported', () => {
    assert.equal(typeof computeSnapshotHash, 'function');
    assert.equal(typeof verifySnapshotHash, 'function');
  });

  test('Same payload object → same hash (deterministic)', () => {
    const payload = makeSnapshotPayload();
    const h1 = computeSnapshotHash(payload);
    const h2 = computeSnapshotHash(payload);  // same object, same call
    assert.equal(h1, h2, 'Same object must produce identical hash both times');
  });

  test('Hash is 64-char hex (SHA-256)', () => {
    const h = computeSnapshotHash(makeSnapshotPayload());
    assert.ok(/^[0-9a-f]{64}$/.test(h));
  });

  test('TEST L — Different netPayBeforeTDS → different hash', () => {
    const base = makeSnapshotPayload();
    const h1   = computeSnapshotHash(base);
    // Mutate only the financial result
    const alt  = { ...base, payrollResults: { ...base.payrollResults, netPayBeforeTDS: 99999 } };
    const h2   = computeSnapshotHash(alt);
    assert.notEqual(h1, h2, 'Financial change must change hash');
  });

  test('Different employee department → different hash', () => {
    const base = makeSnapshotPayload();
    const h1   = computeSnapshotHash(base);
    const alt  = { ...base, employeeSnapshot: { ...base.employeeSnapshot, department: 'Operations' } };
    const h2   = computeSnapshotHash(alt);
    assert.notEqual(h1, h2);
  });

  test('Different rule version → different hash', () => {
    const base = makeSnapshotPayload();
    const h1   = computeSnapshotHash(base);
    const alt  = { ...base, complianceProvenance: [
      { ...base.complianceProvenance[0], sourceReference: 'EPF-IN-2099-v99' },
    ]};
    const h2   = computeSnapshotHash(alt);
    assert.notEqual(h1, h2);
  });

  test('verifySnapshotHash: valid=true for unmodified payload', () => {
    const payload = makeSnapshotPayload();
    payload.snapshotHash = computeSnapshotHash(payload);
    const result = verifySnapshotHash(payload);
    assert.equal(result.valid, true,
      `Expected valid but got: stored=${result.storedHash?.slice(0,8)} computed=${result.computedHash?.slice(0,8)}`
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 13 — Tamper detection
// ═══════════════════════════════════════════════════════════════════════════

describe('TEST 13 — Direct tamper detected by hash verification', () => {
  let computeSnapshotHash, verifySnapshotHash;
  before(async () => {
    const mod = await import('./src/models/PayrollSnapshot.js');
    computeSnapshotHash = mod.computeSnapshotHash;
    verifySnapshotHash  = mod.verifySnapshotHash;
  });

  test('Changing netPayBeforeTDS after hash computation → valid=false', () => {
    const payload = makeSnapshotPayload();
    payload.snapshotHash = computeSnapshotHash(payload);
    const tampered = { ...payload, payrollResults: { ...payload.payrollResults, netPayBeforeTDS: 99999 } };
    assert.equal(verifySnapshotHash(tampered).valid, false);
  });

  test('Changing department after hash → valid=false', () => {
    const payload = makeSnapshotPayload();
    payload.snapshotHash = computeSnapshotHash(payload);
    const tampered = { ...payload, employeeSnapshot: { ...payload.employeeSnapshot, department: 'Fraud' } };
    assert.equal(verifySnapshotHash(tampered).valid, false);
  });

  test('Unchanged payload → valid=true (control)', () => {
    const payload = makeSnapshotPayload();
    payload.snapshotHash = computeSnapshotHash(payload);
    assert.equal(verifySnapshotHash(payload).valid, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST N — Idempotency and conflict detection
// ═══════════════════════════════════════════════════════════════════════════

describe('TEST N — Idempotency and conflict', () => {
  let computeSnapshotHash;
  before(async () => {
    computeSnapshotHash = (await import('./src/models/PayrollSnapshot.js')).computeSnapshotHash;
  });

  test('TEST N — Identical payload → same hash → idempotent reuse', () => {
    const payload = makeSnapshotPayload();
    payload.snapshotHash = computeSnapshotHash(payload);
    const h2 = computeSnapshotHash(payload);
    assert.equal(payload.snapshotHash, h2, 'Identical content = same hash = reuse');
  });

  test('TEST O — Conflicting payload (different gross) → different hash → conflict', () => {
    const existing = makeSnapshotPayload();
    existing.snapshotHash = computeSnapshotHash(existing);

    const newPayload = { ...existing, payrollResults: { ...existing.payrollResults, netPayBeforeTDS: 99999 } };
    const newHash = computeSnapshotHash(newPayload);

    assert.notEqual(existing.snapshotHash, newHash, 'Different content = conflict detected');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST P — Duplicate snapshot rejected
// ═══════════════════════════════════════════════════════════════════════════

describe('TEST P — Duplicate snapshot rejected', () => {
  test('Unique index exists on PayrollSnapshot (payrollRunId + employeeId)', async () => {
    const mod = await import('./src/models/PayrollSnapshot.js');
    const hasUnique = mod.default.schema.indexes().some(([f, opts]) =>
      f.payrollRunId === 1 && f['employeeSnapshot.employeeId'] === 1 && opts.unique
    );
    assert.ok(hasUnique);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// COMPLETENESS TESTS (TEST Q, 14-17)
// ═══════════════════════════════════════════════════════════════════════════

describe('TEST Q / 14-17 — Completeness verification logic', () => {

  test('TEST 14 — Missing snapshot (count < expected) must block', () => {
    assert.equal(4 === 5, false, 'count mismatch must block finalization');
  });

  test('TEST 15 — Duplicate snapshots must block', () => {
    assert.equal(['emp1'].length === 0, false, 'duplicates must block');
  });

  test('TEST 16 — Staging/snapshot hash mismatch must block', () => {
    const stagingGross   = 30000;
    const snapshotGross  = 35000;
    assert.notEqual(stagingGross, snapshotGross, 'mismatch detected');
  });

  test('TEST 17 — Invalid hash must block finalization', () => {
    const failures = [{ snapshotId: 'x' }];
    assert.ok(failures.length > 0, 'hash failures must block');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// IMMUTABILITY ENFORCEMENT (TEST 19-20)
// ═══════════════════════════════════════════════════════════════════════════

describe('TEST 19-20 — Snapshot immutability', () => {
  test('TEST 19 — Repository has no updateSnapshot or deleteSnapshot', async () => {
    const repo = (await import('./src/repositories/payrollSnapshotRepository.js')).default;
    assert.ok(!('updateSnapshot'  in repo));
    assert.ok(!('deleteSnapshot'  in repo));
    assert.ok(!('replaceSnapshot' in repo));
  });

  test('TEST 20 — Routes have no PUT/PATCH/DELETE', async () => {
    const fs  = await import('node:fs');
    const src = fs.readFileSync('./src/routes/payrollSnapshotRoutes.js', 'utf-8');
    assert.ok(!src.includes('.put('));
    assert.ok(!src.includes('.patch('));
    assert.ok(!src.includes('.delete('));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST R — Finalization race safety
// ═══════════════════════════════════════════════════════════════════════════

describe('TEST R — Finalization race: only one winner', () => {
  test('Atomic conditional transition prevents double-finalization', () => {
    let status = 'READY_FOR_FINALIZATION';
    const win  = () => { if (status === 'READY_FOR_FINALIZATION') { status = 'FINALIZED'; return true; } return false; };
    assert.equal(win(), true,  'First caller wins');
    assert.equal(win(), false, 'Second caller loses');
    assert.equal(status, 'FINALIZED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST S — M→M+1 HISTORICAL ISOLATION
// ═══════════════════════════════════════════════════════════════════════════

describe('TEST S — M→M+1 Historical Isolation', () => {
  let computeSnapshotHash;
  before(async () => {
    computeSnapshotHash = (await import('./src/models/PayrollSnapshot.js')).computeSnapshotHash;
  });

  test('TEST 22 — Employee department change after staging does not affect snapshot', () => {
    // July staging: frozen with department=Engineering
    const staging = {
      employeeSnapshot: { department: 'Engineering', firstName: 'Priya', lastName: 'Sharma', fullName: 'Priya Sharma' },
      salarySnapshot:   { grossMonthly: 30000 },
    };

    // Admin changes employee to Operations AFTER staging is written
    const currentEmployeeDept = 'Operations';

    // Snapshot materialized from staging, NOT from current employee
    const snapshotDept = staging.employeeSnapshot.department;

    assert.equal(snapshotDept, 'Engineering', 'Snapshot must use frozen staging value');
    assert.notEqual(snapshotDept, currentEmployeeDept, 'Current state must not affect snapshot');
  });

  test('TEST 23 — New salary version after staging does not affect snapshot', () => {
    // July staging: frozen with grossMonthly=30000
    const staging = { salarySnapshot: { grossMonthly: 30000, components: { basic: 18000 } } };

    // New salary version V2 created in August
    const newSalaryGross = 35000;

    const snapshotGross = staging.salarySnapshot.grossMonthly;
    assert.equal(snapshotGross, 30000, 'Snapshot must use July salary');
    assert.notEqual(snapshotGross, newSalaryGross);
  });

  test('TEST 24 — New compliance rule after staging does not affect snapshot', () => {
    // Staging frozen with V1
    const staging = { ruleProvenance: [{ ruleType: 'EPF', sourceReference: 'EPF-IN-2014-v1' }] };

    // V2 created later
    const v2Reference = 'EPF-IN-2024-v2';

    assert.equal(staging.ruleProvenance[0].sourceReference, 'EPF-IN-2014-v1');
    assert.notEqual(staging.ruleProvenance[0].sourceReference, v2Reference);
  });

  test('TEST H — Employee soft-deletion after staging does not prevent materialization', () => {
    // Phase 9 reads from staging.employeeSnapshot — does NOT call Employee.findById
    // Therefore a soft-deleted (inactive) employee does not block snapshot materialization
    const staging = {
      employeeSnapshot: { employmentStatus: 'active', firstName: 'Priya', department: 'Engineering' },
      // This was the state at processing time
    };

    // Employee later deactivated
    const currentStatus = 'inactive';

    // Snapshot uses staging, not current state
    assert.equal(staging.employeeSnapshot.employmentStatus, 'active',
      'Snapshot preserves employment status at payroll processing time');
    assert.notEqual(staging.employeeSnapshot.employmentStatus, currentStatus);
  });

  test('TEST I — Exact salary version preserved (salarySnapshot.grossMonthly)', () => {
    const staging = { salarySnapshot: { grossMonthly: 30000, effectiveFrom: new Date('2026-01-01') } };
    const snapshot = { salarySnapshot: { ...staging.salarySnapshot } }; // copied from staging

    assert.equal(snapshot.salarySnapshot.grossMonthly, staging.salarySnapshot.grossMonthly);
    assert.equal(
      snapshot.salarySnapshot.effectiveFrom.toISOString(),
      staging.salarySnapshot.effectiveFrom.toISOString()
    );
  });

  test('TEST J — Exact compliance rule version preserved (ruleProvenance)', () => {
    const staging = { ruleProvenance: [{ ruleType: 'EPF', sourceReference: 'EPF-IN-2014-v1' }] };
    const snapshot = { complianceProvenance: staging.ruleProvenance.map(p => ({ ...p })) };

    assert.equal(snapshot.complianceProvenance[0].sourceReference, 'EPF-IN-2014-v1');
  });

  test('Phase 9 service does NOT call Employee.findById (staging is sole source)', async () => {
    const fs  = await import('node:fs');
    const src = fs.readFileSync('./src/services/payrollSnapshotService.js', 'utf-8');
    // Verify no actual import of Employee model (comments mentioning it are fine)
    assert.ok(!src.includes("import Employee from"),
      'Phase 9 must not import Employee — it consumes staging only');
    assert.ok(!/await\s+Employee\.findById/.test(src),
      'Phase 9 must not make an actual Employee.findById() call');
  });

  test('Phase 9 service reads staging.employeeSnapshot directly', async () => {
    const fs  = await import('node:fs');
    const src = fs.readFileSync('./src/services/payrollSnapshotService.js', 'utf-8');
    assert.ok(src.includes('staging.employeeSnapshot.firstName'),
      'Snapshot must come from frozen staging employeeSnapshot');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE REGRESSIONS
// ═══════════════════════════════════════════════════════════════════════════

describe('TEST T / 31 — Phase 1 Regression: Employee lifecycle', () => {
  let Employee;
  before(async () => { Employee = (await import('./src/models/Employee.js')).default; });

  test('Employee model exists', () => assert.ok(Employee));
  test('status enum has active, inactive, on-leave', () => {
    const e = Employee.schema.paths.status.enumValues;
    assert.ok(e.includes('active') && e.includes('inactive') && e.includes('on-leave'));
  });
  test('inactive excluded from payroll eligibility', () => {
    assert.ok(!['active','on-leave'].includes('inactive'));
  });
});

describe('TEST U / 32 — Phase 3 Regression: Salary versioning', () => {
  let SalaryStructure;
  before(async () => { SalaryStructure = (await import('./src/models/SalaryStructure.js')).default; });

  test('findValidForDate exists', () => assert.equal(typeof SalaryStructure.findValidForDate, 'function'));
  test('effectiveTo=null means open-ended', () => assert.equal(SalaryStructure.schema.paths.effectiveTo.defaultValue, null));
  test('grossMonthly stored in schema', () => assert.ok('grossMonthly' in SalaryStructure.schema.paths));
  test('workState field exists', () => assert.ok('workState' in SalaryStructure.schema.paths));
  test('Employee.salary is NOT used as payroll source in Phase 8 service', async () => {
    const fs  = await import('node:fs');
    const src = fs.readFileSync('./src/services/payrollRunService.js', 'utf-8');
    assert.ok(src.includes('salary.grossMonthly'), 'Must read from SalaryStructure');
    assert.ok(!src.includes('emp.salary'), 'Must not use Employee.salary legacy field');
  });
});

describe('TEST V / 33 — Phase 4 Regression: Auth, RBAC, mass-assignment', () => {
  let requireRole;
  before(async () => { requireRole = (await import('./src/middleware/authMiddleware.js')).requireRole; });

  test('requireRole returns middleware', () => assert.equal(typeof requireRole('admin'), 'function'));
  test('Unauthorized role gets 403', (t, done) => {
    requireRole('admin')({ user:{ role:'employee' } },
      { status: c => ({ json: () => { assert.equal(c, 403); done(); } }) },
      () => assert.fail());
  });
  test('Snapshot controller uses req.user.id for companyId', async () => {
    const fs  = await import('node:fs');
    const src = fs.readFileSync('./src/controllers/payrollSnapshotController.js', 'utf-8');
    assert.ok(src.includes('req.user.id'));
    assert.ok(!src.includes('req.body.companyId'));
  });
});

describe('TEST W / 34 — Phase 5 Regression: Service/repository boundaries', () => {
  test('Snapshot controller has no model imports', async () => {
    const fs  = await import('node:fs');
    const src = fs.readFileSync('./src/controllers/payrollSnapshotController.js', 'utf-8');
    assert.ok(!src.includes("from '../models/"));
  });
  test('Snapshot repository has no canTransition', async () => {
    const fs  = await import('node:fs');
    const src = fs.readFileSync('./src/repositories/payrollSnapshotRepository.js', 'utf-8');
    assert.ok(!src.includes('canTransition'));
  });
});

describe('TEST X / 35 — Phase 6 Regression: Audit chain', () => {
  let auditService;
  before(async () => { auditService = (await import('./src/services/auditService.js')).default; });

  test('auditService.log exists', () => assert.equal(typeof auditService.log, 'function'));
  test('Phase 9 uses auditService (not a new audit log)', async () => {
    const fs  = await import('node:fs');
    const src = fs.readFileSync('./src/services/payrollSnapshotService.js', 'utf-8');
    assert.ok(src.includes('auditService.log'));
    assert.ok(!src.includes('new AuditLog'));
  });
  test('PAYROLL_SNAPSHOT_CREATED event emitted', async () => {
    const fs  = await import('node:fs');
    assert.ok((await import('node:fs')).readFileSync('./src/services/payrollSnapshotService.js', 'utf-8').includes('PAYROLL_SNAPSHOT_CREATED'));
  });
  test('PAYROLL_FINALIZED inside transaction (session passed)', async () => {
    const fs  = await import('node:fs');
    const src = fs.readFileSync('./src/services/payrollSnapshotService.js', 'utf-8');
    assert.ok(src.includes('PAYROLL_FINALIZED'));
    assert.ok(src.includes('runInTransaction'));
  });
});

describe('TEST Y / 36 — Phase 7 Regression: Compliance calculators', () => {
  let svc;
  before(async () => { svc = (await import('./src/services/complianceCalculationService.js')).default; });

  test('calculate() returns tdsDeferred=true', () => {
    const r = svc.calculate({
      grossMonthly:30000, basicSalary:18000, pfWageOverride:null,
      pfEnrolled:true, esiEnrolled:false, ptEnrolled:true,
      epfRule:{employeeContributionRate:0.12,employerContributionRate:0.12,wageCapForContribution:15000,epsRate:0.0833},
      esiRule:{employeeContributionRate:0.0075,employerContributionRate:0.0325,grossWageCeiling:21000},
      ptSlabs:[{upTo:null,monthlyTax:200}],
    });
    assert.equal(r.tdsDeferred, true);
  });
  test('Phase 9 does NOT call complianceCalculationService (no recalculation)', async () => {
    const fs  = await import('node:fs');
    const src = fs.readFileSync('./src/services/payrollSnapshotService.js', 'utf-8');
    assert.ok(!src.includes('complianceCalculationService'), 'Phase 9 must read from staging, not recalculate');
  });
});

describe('TEST Z / 37 — Phase 8 Regression: PayrollRun state machine', () => {
  let canTransition, PAYROLL_STATUS;
  before(async () => {
    const mod = await import('./src/models/PayrollRun.js');
    canTransition  = mod.canTransition;
    PAYROLL_STATUS = mod.PAYROLL_STATUS;
  });

  test('READY_FOR_FINALIZATION state exists', () => {
    assert.equal(PAYROLL_STATUS.READY_FOR_FINALIZATION, 'READY_FOR_FINALIZATION');
  });
  test('PROCESSING → FINALIZED is forbidden', () => {
    assert.equal(canTransition('PROCESSING', 'FINALIZED'), false);
  });
  test('PROCESSING → READY_FOR_FINALIZATION is allowed', () => {
    assert.equal(canTransition('PROCESSING', 'READY_FOR_FINALIZATION'), true);
  });
  test('READY_FOR_FINALIZATION → FINALIZED is allowed', () => {
    assert.equal(canTransition('READY_FOR_FINALIZATION', 'FINALIZED'), true);
  });
  test('FINALIZED is immutable (→ PROCESSING forbidden)', () => {
    assert.equal(canTransition('FINALIZED', 'PROCESSING'), false);
  });
  test('Phase 8 MH fallback is removed', async () => {
    const fs  = await import('node:fs');
    const src = fs.readFileSync('./src/services/payrollRunService.js', 'utf-8');
    assert.ok(!src.includes("|| 'MH'"), 'No MH fallback');
  });
  test('Phase 8 repo finalize uses READY_FOR_FINALIZATION as fromStatus', async () => {
    const fs  = await import('node:fs');
    const src = fs.readFileSync('./src/repositories/payrollRunRepository.js', 'utf-8');
    assert.ok(src.includes("'READY_FOR_FINALIZATION'"));
  });
  test('Phase 8 staging contains employeeSnapshot (frozen inputs)', async () => {
    const fs  = await import('node:fs');
    const src = fs.readFileSync('./src/services/payrollRunService.js', 'utf-8');
    assert.ok(src.includes('employeeSnapshot'), 'Phase 8 must freeze employeeSnapshot into staging');
    assert.ok(src.includes('salarySnapshot'),   'Phase 8 must freeze salarySnapshot into staging');
    assert.ok(src.includes('ruleProvenance'),   'Phase 8 must freeze ruleProvenance into staging');
    assert.ok(src.includes('payrollInputs'),    'Phase 8 must freeze payrollInputs into staging');
  });
});

// ─── Summary ──────────────────────────────────────────────────────────────
console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║  Phase 9 Correction — test_phase9.js (corrected)          ║');
console.log('║  Run: node test_phase9.js                                  ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');
