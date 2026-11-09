/**
 * test_snapshot_recovery.js — the inspection, lease and evidence foundation of snapshot recovery.
 *
 * Runner: node:test.  Run: node --test test_snapshot_recovery.js   (or the full suite: npm test)
 * Real MongoDB replica set, isolated database (RECOVERY_MONGO_URI), dropped before and after.
 *
 * Recovery does not delete anything: applySnapshotRecovery always refuses, and these tests pin that. What exists is
 * classification, a digest-bound dry-run plan, fenced leases and a durable evidence file. This is NOT evidence that a purge
 * would be safe: no purge exists, and the crash-consistency and reconciliation gates in docs/integrity/SNAPSHOT-RECOVERY.md
 * are still open. Tests assert persisted state.
 */

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { shapes } from './test_support/snapshotShapes.js';

const TEST_DB_URI = process.env.RECOVERY_MONGO_URI || 'mongodb://127.0.0.1:27018/payguard_snapshot_recovery_test?replicaSet=rs0';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.MONGO_URI = TEST_DB_URI;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'recovery-test-secret-long-enough-for-validation';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.FIELD_ENCRYPTION_KEYS = `v1:${crypto.randomBytes(32).toString('base64')}`;
process.env.FIELD_ENCRYPTION_ACTIVE_KEY = 'v1';
process.env.FIELD_BLIND_INDEX_KEY = crypto.randomBytes(32).toString('hex');

const { default: PayrollSnapshot, computeSnapshotHash } = await import('./src/models/PayrollSnapshot.js');
const { default: PayrollRun } = await import('./src/models/PayrollRun.js');
const { default: SnapshotRecoveryLease } = await import('./src/models/SnapshotRecoveryLease.js');
const { default: AuditLog } = await import('./src/models/AuditLog.js');
const { default: AuditChainHead } = await import('./src/models/AuditChainHead.js');
const { default: auditService } = await import('./src/services/auditService.js');
const recovery = await import('./src/services/payrollSnapshotRecoveryService.js');

const COMPANY = new mongoose.Types.ObjectId();
let evidenceDir;
let month = 0;

const oid = () => new mongoose.Types.ObjectId();

async function makeRun(status) {
  month += 1;
  const run = { _id: oid(), companyId: COMPANY, status, periodYear: 2031 + Math.floor(month / 12), periodMonth: (month % 12) + 1 };
  await PayrollRun.collection.insertOne(run);
  return run;
}

async function makeSnapshot(run, { status = 'PENDING_FINALIZATION', tamper = false, employeeId = oid(), companyId = COMPANY, finalized = false } = {}) {
  const doc = {
    ...shapes().preWave3,
    _id: oid(),
    payrollRunId: run._id,
    companyId,
    periodYear: run.periodYear,
    periodMonth: run.periodMonth,
    snapshotStatus: status,
    finalizedAt: finalized ? new Date() : null,
    finalizedBy: finalized ? oid() : null,
  };
  doc.employeeSnapshot = { ...doc.employeeSnapshot, employeeId };
  doc.snapshotHash = computeSnapshotHash(doc);
  if (tamper) doc.payrollResults = { ...doc.payrollResults, netPayBeforeTDS: doc.payrollResults.netPayBeforeTDS + 1 };
  await PayrollSnapshot.collection.insertOne(doc);
  return doc;
}

const inspect = (snapshot) => recovery.inspectSnapshotRecovery({ snapshotId: snapshot._id, companyId: COMPANY });

const fingerprint = async () => {
  const out = {};
  for (const name of ['payrollsnapshots', 'payrollruns', 'auditlogs', 'auditchainheads']) {
    const docs = await mongoose.connection.collection(name).find({}).sort({ _id: 1 }).toArray();
    out[name] = crypto.createHash('sha256').update(JSON.stringify(docs)).digest('hex');
  }
  return out;
};

before(async () => {
  await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 5000 });
  await mongoose.connection.dropDatabase();
  await Promise.all([AuditLog.init(), AuditChainHead.init(), SnapshotRecoveryLease.init(), PayrollSnapshot.init()]);
  await auditService.logStandalone({ action: 'TEST_GENESIS', actorId: oid(), actorEmail: 'a@example.com', actorRole: 'admin', entityType: 'TEST', entityId: oid(), companyId: COMPANY, meta: {} });
  evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payguard-recovery-'));
});

after(async () => {
  fs.rmSync(evidenceDir, { recursive: true, force: true });
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('classification', () => {
  test('a pending snapshot of a FAILED or CANCELLED run with intact evidence is the only eligible case', async () => {
    for (const status of ['FAILED', 'CANCELLED']) {
      const run = await makeRun(status);
      const result = await inspect(await makeSnapshot(run));
      assert.equal(result.classification, 'SAFE_ORPHAN_PENDING', JSON.stringify(result.reasons));
      assert.equal(result.eligible, true);
    }
  });

  test('a run that may still use the snapshot is never eligible', async () => {
    for (const status of ['DRAFT', 'PROCESSING']) {
      const result = await inspect(await makeSnapshot(await makeRun(status)));
      assert.equal(result.eligible, false, status);
      assert.equal(result.classification, 'INCONSISTENT');
    }
  });

  test('F-03: a snapshot flipped back to PENDING after finalization is recognised from the audit trail, not from its status field', async () => {
    const run = await makeRun('FAILED');
    const snapshot = await makeSnapshot(run);
    await auditService.logStandalone({ action: 'PAYROLL_SNAPSHOT_FINALIZED', actorId: oid(), actorEmail: 'a@example.com', actorRole: 'admin', entityType: 'PAYROLL_SNAPSHOT', entityId: snapshot._id, companyId: COMPANY, meta: {} });
    const result = await inspect(snapshot);
    assert.equal(result.eligible, false);
    assert.equal(result.classification, 'FINALIZED');
  });

  test('finalization evidence on the run or the snapshot itself is FINALIZED, whatever the status says', async () => {
    assert.equal((await inspect(await makeSnapshot(await makeRun('FINALIZED')))).classification, 'FINALIZED');
    assert.equal((await inspect(await makeSnapshot(await makeRun('FAILED'), { finalized: true }))).classification, 'FINALIZED');
    assert.equal((await inspect(await makeSnapshot(await makeRun('FAILED'), { status: 'FINALIZED' }))).classification, 'FINALIZED');
  });

  test('altered content and a snapshot of another tenant are not eligible; a duplicate cannot exist', async () => {
    const tampered = await inspect(await makeSnapshot(await makeRun('FAILED'), { tamper: true }));
    assert.equal(tampered.eligible, false);
    assert.equal(tampered.classification, 'INCONSISTENT');

    const run = await makeRun('FAILED');
    const employeeId = oid();
    await makeSnapshot(run, { employeeId });
    await assert.rejects(makeSnapshot(run, { employeeId }), (e) => e.code === 11000, 'the database refuses a second snapshot for the same run and employee');

    const foreign = await makeSnapshot(await makeRun('FAILED'), { companyId: oid() });
    assert.equal((await inspect(foreign)).classification, 'MISSING_EVIDENCE');
  });

  test('malformed identifiers are INVESTIGATE, and a broken chain makes everything ineligible', async () => {
    assert.equal((await recovery.inspectSnapshotRecovery({ snapshotId: 'nope', companyId: COMPANY })).classification, 'INVESTIGATE');
    assert.equal((await recovery.inspectSnapshotRecovery()).classification, 'INVESTIGATE');

    const snapshot = await makeSnapshot(await makeRun('FAILED'));
    const original = auditService.verifyHead;
    auditService.verifyHead = async () => ({ ok: false, reason: 'simulated head disagreement' });
    try {
      assert.equal((await inspect(snapshot)).eligible, false);
    } finally {
      auditService.verifyHead = original;
    }

    // A chain broken in the middle while the head still matches the tail: the chain check alone must refuse (SIMULATED verifier answer).
    const originalChain = auditService.verifyAuditChain;
    auditService.verifyAuditChain = async () => ({ valid: false, reason: 'simulated broken link in the middle of the chain' });
    try {
      const result = await inspect(snapshot);
      assert.equal(result.eligible, false);
      assert.ok(result.reasons.some((reason) => /audit chain invalid/.test(reason)), JSON.stringify(result.reasons));
    } finally {
      auditService.verifyAuditChain = originalChain;
    }
  });

  test('inspection and planning change nothing', async () => {
    const snapshot = await makeSnapshot(await makeRun('FAILED'));
    const before = await fingerprint();
    await inspect(snapshot);
    const plan = await recovery.planSnapshotRecovery({ snapshotId: snapshot._id, companyId: COMPANY });
    assert.equal(plan.mode, 'DRY_RUN');
    assert.equal(plan.applyEnabled, false);
    assert.match(plan.planDigest, /^[0-9a-f]{64}$/);
    assert.deepEqual(await fingerprint(), before);
  });
});

describe('apply stays disabled', () => {
  test('applySnapshotRecovery refuses, whatever it is given, and changes nothing', async () => {
    const snapshot = await makeSnapshot(await makeRun('FAILED'));
    const plan = await recovery.planSnapshotRecovery({ snapshotId: snapshot._id, companyId: COMPANY });
    const before = await fingerprint();
    await assert.rejects(recovery.applySnapshotRecovery({ plan, confirm: true }), (e) => e.code === 'SNAPSHOT_RECOVERY_APPLY_DISABLED' && e.statusCode === 503);
    assert.deepEqual(await fingerprint(), before);
  });
});

describe('leases', () => {
  const owner = (lease) => [lease.resourceKey, lease.ownerToken, lease.fence];
  beforeEach(() => SnapshotRecoveryLease.deleteMany({}));

  test('a live lease excludes a second owner, and of many simultaneous acquirers exactly one wins', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => recovery.acquireRecoveryLease('run-1')));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await SnapshotRecoveryLease.countDocuments({ resourceKey: 'run-1' }), 1);
  });

  test('an expired lease can be taken over, the fence rises, and the superseded owner can neither prove, renew nor release', async () => {
    const first = await recovery.acquireRecoveryLease('run-2', { leaseMs: 1000 });
    assert.equal(first.fence, 1);
    await SnapshotRecoveryLease.updateOne({ resourceKey: 'run-2' }, { $set: { leaseExpiresAt: new Date(Date.now() - 1) } });
    await assert.rejects(recovery.assertRecoveryFence(...owner(first)), (e) => e.code === 'RECOVERY_FENCE_REJECTED', 'an expired lease proves nothing even before a takeover');

    const second = await recovery.acquireRecoveryLease('run-2');
    assert.equal(second.fence, 2);
    await recovery.assertRecoveryFence(...owner(second));

    await assert.rejects(recovery.assertRecoveryFence(...owner(first)), (e) => e.code === 'RECOVERY_FENCE_REJECTED');
    assert.equal(await recovery.renewRecoveryLease(...owner(first)), null);
    assert.equal((await recovery.releaseRecoveryLease(...owner(first))).deletedCount, 0);
    await recovery.assertRecoveryFence(...owner(second));
  });

  test('the fence, not only the token, separates two leases: an owner that reacquires with the SAME token cannot act on its old lease', async () => {
    const first = await recovery.acquireRecoveryLease('run-5', { ownerToken: 'same-owner', leaseMs: 1000 });
    await SnapshotRecoveryLease.updateOne({ resourceKey: 'run-5' }, { $set: { leaseExpiresAt: new Date(Date.now() - 1) } });
    const second = await recovery.acquireRecoveryLease('run-5', { ownerToken: 'same-owner' });
    assert.equal(second.fence, 2);
    await assert.rejects(recovery.assertRecoveryFence('run-5', 'same-owner', 1), (e) => e.code === 'RECOVERY_FENCE_REJECTED');
    assert.equal(await recovery.renewRecoveryLease('run-5', 'same-owner', 1), null);
    assert.equal((await recovery.releaseRecoveryLease('run-5', 'same-owner', 1)).deletedCount, 0);
    await recovery.assertRecoveryFence(...owner(second));
  });

  test('an expired lease cannot be renewed by its own owner, even when nobody has taken it over', async () => {
    const lease = await recovery.acquireRecoveryLease('run-6', { leaseMs: 1000 });
    await SnapshotRecoveryLease.updateOne({ resourceKey: 'run-6' }, { $set: { leaseExpiresAt: new Date(Date.now() - 1) } });
    assert.equal(await recovery.renewRecoveryLease(...owner(lease)), null);
    await assert.rejects(recovery.assertRecoveryFence(...owner(lease)), (e) => e.code === 'RECOVERY_FENCE_REJECTED');
  });

  test('renewal extends a live lease; bounds on the key and the duration are enforced', async () => {
    const lease = await recovery.acquireRecoveryLease('run-3', { leaseMs: 2000 });
    const renewed = await recovery.renewRecoveryLease(...owner(lease), 60_000);
    assert.ok(renewed.leaseExpiresAt > lease.leaseExpiresAt);
    await assert.rejects(recovery.acquireRecoveryLease(''), (e) => e.code === 'RECOVERY_SCOPE_INVALID');
    await assert.rejects(recovery.acquireRecoveryLease('run-4', { leaseMs: 10 }), (e) => e.code === 'RECOVERY_LEASE_INVALID');
  });
});

describe('evidence file', () => {
  const eligiblePlan = async () => recovery.planSnapshotRecovery({ snapshotId: (await makeSnapshot(await makeRun('FAILED')))._id, companyId: COMPANY });

  test('an eligible plan writes an exclusive, verifiable file; the returned digest matches the bytes on disk', async () => {
    const plan = await eligiblePlan();
    const written = await recovery.createRecoveryEvidence({ plan, evidenceDirectory: evidenceDir, filename: 'a.json' });
    assert.equal(written.planDigest, plan.planDigest);
    const bytes = fs.readFileSync(written.path);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), written.digest);
    assert.equal(bytes.length, written.bytes);
    assert.equal(JSON.parse(bytes).planDigest, plan.planDigest);

    await assert.rejects(recovery.createRecoveryEvidence({ plan, evidenceDirectory: evidenceDir, filename: 'a.json' }), (e) => e.code === 'EEXIST', 'never overwrites');
  });

  test('an ineligible or forged plan writes nothing, and a path outside the directory is refused', async () => {
    const before = fs.readdirSync(evidenceDir).length;
    const ineligible = await recovery.planSnapshotRecovery({ snapshotId: (await makeSnapshot(await makeRun('PROCESSING')))._id, companyId: COMPANY });
    await assert.rejects(recovery.createRecoveryEvidence({ plan: ineligible, evidenceDirectory: evidenceDir, filename: 'b.json' }), (e) => e.code === 'RECOVERY_EVIDENCE_REFUSED');
    await assert.rejects(recovery.createRecoveryEvidence({ plan: { mode: 'APPLY' }, evidenceDirectory: evidenceDir, filename: 'c.json' }), (e) => e.code === 'RECOVERY_EVIDENCE_REFUSED');
    const plan = await eligiblePlan();
    for (const filename of ['../escape.json', '..\\escape.json', 'x/y.json', '']) {
      await assert.rejects(recovery.createRecoveryEvidence({ plan, evidenceDirectory: evidenceDir, filename }), (e) => e.code === 'RECOVERY_EVIDENCE_PATH_INVALID', filename);
    }
    assert.equal(fs.readdirSync(evidenceDir).length, before);
  });
});
