/**
 * test_audit_hardening.js — audit-chain concurrency and payroll-snapshot lifecycle invariants.
 *
 * Runner: node:test.  Run: node --test test_audit_hardening.js   (or the full suite: npm test)
 * Real MongoDB replica set, isolated database (AUDIT_HARDENING_MONGO_URI), dropped before and after.
 *
 * Group A — the audit chain: DATABASE-enforced single successor, liveness under real concurrency (in one
 *           process, in a transaction, across processes), explicit failure outcomes, fail-closed index guard,
 *           and tamper-evidence after deliberate corruption.
 * Group B — payroll snapshot lifecycle: snapshot + audit event are atomic, finalization is all-or-nothing
 *           including every audit event, retries and duplicate requests change nothing.
 * Group C — the pending-snapshot reconciliation tool: classification and a read-only dry run. Destructive apply is
 *           DISABLED (Phase 0 containment): the tests prove it refuses everything and that no code path can mutate.
 *
 * A test here proves an INVARIANT (state after the operation), never merely "an error was thrown".
 * Concurrency is exercised with genuinely concurrent operations (Promise.all, separate processes), never
 * inferred from sequential runs.
 */

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'audit-hardening-test-secret-long-enough';
process.env.FIELD_ENCRYPTION_KEYS = `v1:${crypto.randomBytes(32).toString('base64')}`;
process.env.FIELD_ENCRYPTION_ACTIVE_KEY = 'v1';
process.env.FIELD_BLIND_INDEX_KEY = crypto.randomBytes(32).toString('hex');

const TEST_DB_URI = process.env.AUDIT_HARDENING_MONGO_URI || 'mongodb://127.0.0.1:27018/payguard_audit_hardening_test?replicaSet=rs0';

const { default: app } = await import('./src/app.js');
const { default: Admin } = await import('./src/models/Admin.js');
const { default: Company } = await import('./src/models/Company.js');
const { default: Employee } = await import('./src/models/Employee.js');
const { default: EmployeeAccount } = await import('./src/models/EmployeeAccount.js');
const { default: SalaryStructure } = await import('./src/models/SalaryStructure.js');
const { default: ComplianceRuleVersion } = await import('./src/models/ComplianceRuleVersion.js');
const { default: PayrollRun } = await import('./src/models/PayrollRun.js');
const { default: PayrollStagingResult } = await import('./src/models/PayrollStagingResult.js');
const { default: PayrollSnapshot, computeSnapshotHash } = await import('./src/models/PayrollSnapshot.js');
const { default: AuditLog } = await import('./src/models/AuditLog.js');
const { default: IdempotencyRecord } = await import('./src/models/IdempotencyRecord.js');
const { default: auditService } = await import('./src/services/auditService.js');
const { default: payrollRunService } = await import('./src/services/payrollRunService.js');
const { default: payrollSnapshotService } = await import('./src/services/payrollSnapshotService.js');
const { default: payrollFinalizationService } = await import('./src/services/payrollFinalizationService.js');
const { runInTransaction } = await import('./src/utils/transaction.js');
const recon = await import('./scripts/lib/snapshotReconciliation.mjs');

const MODELS = [Admin, Company, Employee, EmployeeAccount, SalaryStructure, ComplianceRuleVersion, PayrollRun, PayrollStagingResult, PayrollSnapshot, AuditLog, IdempotencyRecord];
const PASSWORD = 'StrongPass123';
const WORKER = fileURLToPath(new URL('./test_support/auditAppendWorker.mjs', import.meta.url));

let server;
let baseUrl;
/** Fixture handles that group B creates and group C reuses (the groups run in file order). */
const shared = {};

const actorId = new mongoose.Types.ObjectId();
const params = (i, action = 'HARDENING_TEST') => ({ action, actorId, entityType: 'TEST', entityId: new mongoose.Types.ObjectId(), meta: { i } });
const resetChain = () => AuditLog.collection.deleteMany({});
const sequences = async () => (await AuditLog.collection.find({}, { projection: { sequenceNumber: 1 } }).sort({ sequenceNumber: 1 }).toArray()).map((d) => d.sequenceNumber);
const assertContiguous = async (expected) => {
  const seqs = await sequences();
  assert.deepEqual(seqs, Array.from({ length: expected }, (_, i) => i + 1), 'sequence numbers must be exactly 1..N with no gap and no duplicate');
};
const assertChainValid = async (message = '') => {
  const verification = await auditService.verifyAuditChain();
  assert.equal(verification.valid, true, `${message} ${verification.reason}`);
  return verification;
};
const indexes = async () => AuditLog.collection.indexes();
// Always reset the chain FIRST: a previous test may have left a deliberately forked chain, over which a unique index cannot be built.
const restoreIndexes = async () => { await AuditLog.collection.dropIndexes(); await AuditLog.createIndexes(); auditService._resetIndexGuard?.(); };

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
    return { status: response.status, body: json };
  };
  return { get: (p) => request('GET', p), post: (p, b = {}, h) => request('POST', p, b, h) };
}

/** Make auditService.log throw for matching calls; returns a restore function. */
function injectAuditFailure(match) {
  const original = auditService.log;
  const seen = {};
  auditService.log = async function injected(entry, session) {
    seen[entry.action] = (seen[entry.action] || 0) + 1;
    if (match(entry, seen[entry.action])) throw Object.assign(new Error(`Injected audit failure for ${entry.action}`), { injected: true });
    return original.call(this, entry, session);
  };
  return () => { auditService.log = original; };
}

/** Let the audit write happen, THEN fail: a crash right after the write, inside whatever transaction the caller opened. */
function injectFailureAfterAuditWrite(match) {
  const original = auditService.log;
  auditService.log = async function injectedAfter(entry, session) {
    const written = await original.call(this, entry, session);
    if (match(entry)) throw Object.assign(new Error(`Injected failure right after writing ${entry.action}`), { injected: true });
    return written;
  };
  return () => { auditService.log = original; };
}

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
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  } finally {
    await mongoose.disconnect();
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Group A — the audit chain
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe('A — audit chain: the database allows exactly one successor per predecessor', () => {
  beforeEach(async () => { await resetChain(); await restoreIndexes(); });

  test('the unique constraints exist: one on sequenceNumber and one on previousHash (a predecessor has one successor)', async () => {
    const unique = (await indexes()).filter((index) => index.unique);
    assert.ok(unique.some((index) => index.key.sequenceNumber === 1), 'unique sequenceNumber');
    const successor = unique.find((index) => index.key.previousHash === 1);
    assert.ok(successor, 'unique previousHash');
    assert.deepEqual(successor.partialFilterExpression, { previousHash: { $type: 'string' } }, 'partial, so records written before chaining (no previousHash) cannot collide');
  });

  test('the DATABASE rejects a second successor of the same predecessor even under a different sequence number', async () => {
    const first = await auditService.log(params(1));
    const second = await auditService.log(params(2));
    assert.equal(second.previousHash, first.hash);
    const forged = { ...second.toObject(), _id: new mongoose.Types.ObjectId(), sequenceNumber: 9999, hash: 'f'.repeat(64) };
    await assert.rejects(AuditLog.collection.insertOne(forged), (error) => error.code === 11000 && Boolean(error.keyPattern?.previousHash));
    assert.equal(await AuditLog.collection.countDocuments({}), 2, 'nothing was written');
  });

  test('the DATABASE rejects a second record with the same sequence number', async () => {
    const first = await auditService.log(params(1));
    const forged = { ...first.toObject(), _id: new mongoose.Types.ObjectId(), previousHash: 'a'.repeat(64), hash: 'e'.repeat(64) };
    await assert.rejects(AuditLog.collection.insertOne(forged), (error) => error.code === 11000 && Boolean(error.keyPattern?.sequenceNumber));
    assert.equal(await AuditLog.collection.countDocuments({}), 1);
  });
});

describe('A — audit chain: concurrent appends all succeed, linearly (liveness AND safety)', () => {
  beforeEach(async () => { await resetChain(); await restoreIndexes(); });

  test('100 concurrent appends in one process, three rounds: every one succeeds, sequence 1..N, chain valid', async () => {
    for (let round = 1; round <= 3; round += 1) {
      await resetChain();
      const settled = await Promise.allSettled(Array.from({ length: 100 }, (_, i) => auditService.log(params(i))));
      const failures = settled.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.code ?? r.reason?.message));
      assert.deepEqual(failures, [], `round ${round}: an append must never fail merely because another was logged at the same moment`);
      await assertContiguous(100);
      await assertChainValid(`round ${round}`);
    }
  });

  test('25 concurrent TRANSACTIONS each doing business work + an audit append: all commit exactly once, none duplicated', async () => {
    const scratch = mongoose.connection.collection('audit_hardening_scratch');
    await scratch.deleteMany({});
    const settled = await Promise.allSettled(Array.from({ length: 25 }, (_, i) => runInTransaction(async (session) => {
      await scratch.insertOne({ i }, { session });
      return auditService.log(params(i), session);
    }, { label: 'a5' })));
    assert.deepEqual(settled.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.code ?? r.reason?.message)), []);
    const rows = await scratch.find({}).toArray();
    assert.equal(rows.length, 25, 'every business write committed');
    assert.equal(new Set(rows.map((row) => row.i)).size, 25, 'and exactly once: a retried transaction must not duplicate its business write');
    await assertContiguous(25);
    await assertChainValid();
  });

  test('plain and transactional appends racing each other: all succeed, chain valid', async () => {
    const settled = await Promise.allSettled(Array.from({ length: 60 }, (_, i) => (i % 2
      ? runInTransaction((session) => auditService.log(params(i), session), { label: 'a6' })
      : auditService.log(params(i)))));
    assert.deepEqual(settled.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.code ?? r.reason?.message)), []);
    await assertContiguous(60);
    await assertChainValid();
  });

  test('FOUR SEPARATE PROCESSES appending to one chain: every append succeeds, sequence 1..N, chain valid', async () => {
    const run = (count, mode) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [WORKER, TEST_DB_URI, String(count), mode], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out.trim().split('\n').pop())) : reject(new Error(`worker exited ${code}: ${err}`))));
    });
    const results = await Promise.all([run(40, 'plain'), run(40, 'plain'), run(40, 'txn'), run(40, 'txn')]);
    for (const result of results) assert.equal(result.rejected, 0, JSON.stringify(result));
    await assertContiguous(160);
    await assertChainValid();
  });

  test('two audit events in ONE transaction are consecutive and linked; an abort leaves no trace and no gap', async () => {
    const [a, b] = await runInTransaction(async (session) => [await auditService.log(params(1), session), await auditService.log(params(2), session)]);
    assert.equal(b.sequenceNumber, a.sequenceNumber + 1);
    assert.equal(b.previousHash, a.hash);
    await assert.rejects(runInTransaction(async (session) => {
      await auditService.log(params(3), session);
      await auditService.log(params(4), session);
      throw Object.assign(new Error('business failure after two audit writes'), { statusCode: 500 });
    }), /business failure/);
    await assertContiguous(2);
    const next = await auditService.log(params(5));
    assert.equal(next.sequenceNumber, 3, 'the aborted transaction consumed no sequence number');
    await assertChainValid();
  });

  test('a transient transaction failure after the audit insert is retried: committed exactly once, no gap', async () => {
    let attempts = 0;
    const entry = await runInTransaction(async (session) => {
      attempts += 1;
      const logged = await auditService.log(params(1), session);
      if (attempts === 1) throw Object.assign(new Error('injected transient failure'), { errorLabels: new Set(['TransientTransactionError']) });
      return logged;
    }, { label: 'a10' });
    assert.equal(attempts, 2);
    assert.equal(entry.sequenceNumber, 1);
    await assertContiguous(1);
    await assertChainValid();
  });
});

describe('A — audit chain: explicit outcomes when an append cannot be made', () => {
  beforeEach(async () => { await resetChain(); await restoreIndexes(); });

  test('exhausted contention is a named, retryable 503 (AUDIT_CHAIN_CONTENTION); nothing is written and the chain stays valid', async () => {
    const original = auditService._append;
    const policy = auditService.appendPolicy;
    let calls = 0;
    auditService._append = async () => { calls += 1; throw Object.assign(new Error('E11000 duplicate key'), { code: 11000, keyPattern: { sequenceNumber: 1 } }); };
    auditService.appendPolicy = { ...policy, maxWaitMs: 300 };
    try {
      await assert.rejects(auditService.log(params(1)), (error) => error.code === 'AUDIT_CHAIN_CONTENTION' && error.statusCode === 503 && error.retryable === true);
      assert.ok(calls > 1, 'it retried before giving up');
    } finally {
      auditService._append = original;
      auditService.appendPolicy = policy;
    }
    assert.equal(await AuditLog.collection.countDocuments({}), 0);
    await assertChainValid();
  });

  test('inside a transaction an exhausted retry budget on AUDIT conflicts is the same explicit 503, nothing written; an unrelated conflict is not relabelled', async () => {
    const original = auditService._append;
    let calls = 0;
    const transient = () => Object.assign(new Error('WriteConflict'), { code: 112, errorLabels: new Set(['TransientTransactionError']) });
    auditService._append = async () => { calls += 1; throw transient(); };
    try {
      await assert.rejects(
        runInTransaction((session) => auditService.log(params(1), session), { label: 'a-exhaust', maxAttempts: 4, maxWaitMs: 5000 }),
        (error) => error.code === 'AUDIT_CHAIN_CONTENTION' && error.statusCode === 503 && error.retryable === true
      );
      assert.equal(calls, 4, 'the whole unit of work was re-run up to the attempt limit');
      calls = 0;
      auditService._append = async () => { calls += 1; throw Object.assign(new Error('E11000 duplicate key'), { code: 11000, keyPattern: { previousHash: 1 } }); };
      await assert.rejects(
        runInTransaction((session) => auditService.log(params(2), session), { label: 'a-exhaust-2', maxAttempts: 3, maxWaitMs: 5000 }),
        (error) => error.code === 'AUDIT_CHAIN_CONTENTION'
      );
      assert.equal(calls, 3, 'a previousHash collision is retried like a sequenceNumber collision');
    } finally {
      auditService._append = original;
    }
    assert.equal(await AuditLog.collection.countDocuments({}), 0);

    let attempts = 0;
    await assert.rejects(runInTransaction(async () => { attempts += 1; throw transient(); }, { label: 'business-conflict', maxAttempts: 3, maxWaitMs: 5000 }), (error) => error.code === 112);
    assert.equal(attempts, 3, 'a conflict that did not come from the audit insert is retried, then reported unchanged');
    await assertChainValid();
  });

  test('a non-collision database error is NOT retried and is not disguised as contention', async () => {
    const original = auditService._append;
    let calls = 0;
    auditService._append = async () => { calls += 1; throw Object.assign(new Error('disk exploded'), { code: 9999 }); };
    try {
      await assert.rejects(auditService.log(params(1)), (error) => error.code === 9999);
      assert.equal(calls, 1);
    } finally {
      auditService._append = original;
    }
  });
});

describe('A — audit chain: the unique-index guard fails closed', () => {
  beforeEach(async () => { await resetChain(); await restoreIndexes(); });

  test('a dropped unique index is rebuilt before appending (no data conflicts), and the append then succeeds', async () => {
    await auditService.log(params(1));
    await AuditLog.collection.dropIndex('sequenceNumber_1');
    auditService._resetIndexGuard();
    await auditService.log(params(2));
    const unique = (await indexes()).filter((index) => index.unique);
    assert.ok(unique.some((index) => index.key.sequenceNumber === 1), 'the guard restored the unique index');
    await assertContiguous(2);
  });

  test('the guard re-checks periodically: an index dropped while the process is running is restored on the next append once the re-check interval has passed', async () => {
    const policy = auditService.appendPolicy;
    auditService.appendPolicy = { ...policy, indexRecheckMs: 0 };
    try {
      await auditService.log(params(1)); // the guard has now checked and cached
      await AuditLog.collection.dropIndex('previousHash_unique_successor');
      await auditService.log(params(2)); // no manual reset: the (zero) interval has elapsed
      assert.ok((await indexes()).some((index) => index.unique && index.key.previousHash === 1), 'the dropped guard was restored without any operator action');
    } finally {
      auditService.appendPolicy = policy;
    }
    auditService.appendPolicy = { ...policy, indexRecheckMs: 60 * 60 * 1000 };
    try {
      auditService._resetIndexGuard();
      await auditService.log(params(3));
      await AuditLog.collection.dropIndex('previousHash_unique_successor');
      await auditService.log(params(4)); // inside the interval the cached check is trusted (documented residual window)
      assert.equal((await indexes()).some((index) => index.unique && index.key.previousHash === 1), false, 'within the interval nothing re-checks: this is the documented window');
    } finally {
      auditService.appendPolicy = policy;
      auditService._resetIndexGuard();
    }
  });

  test('the guard verifies its own result: if a rebuild reports success but the guard is still missing, appends are refused', async () => {
    await AuditLog.collection.dropIndex('previousHash_unique_successor');
    auditService._resetIndexGuard();
    const original = AuditLog.collection.createIndex;
    AuditLog.collection.createIndex = async () => 'pretended-success';
    try {
      await assert.rejects(auditService.log(params(1)), (error) => error.code === 'AUDIT_CHAIN_INDEX_UNAVAILABLE' && error.statusCode === 503);
    } finally {
      AuditLog.collection.createIndex = original;
    }
    assert.equal(await AuditLog.collection.countDocuments({}), 0);
  });

  test('if the unique index is missing AND the chain already forked, appends are REFUSED (503 AUDIT_CHAIN_INDEX_UNAVAILABLE); nothing is written', async () => {
    const first = await auditService.log(params(1));
    await AuditLog.collection.dropIndexes();
    await AuditLog.collection.insertOne({ ...first.toObject(), _id: new mongoose.Types.ObjectId(), hash: 'd'.repeat(64) }); // duplicate sequenceNumber 1
    auditService._resetIndexGuard();
    await assert.rejects(auditService.log(params(2)), (error) => error.code === 'AUDIT_CHAIN_INDEX_UNAVAILABLE' && error.statusCode === 503);
    assert.equal(await AuditLog.collection.countDocuments({}), 2, 'the refused append wrote nothing');
    const verification = await auditService.verifyAuditChain();
    assert.equal(verification.valid, false, 'the fork stays detectable');
  });
});

describe('A — audit chain: tamper-evidence after deliberate corruption (tamper-EVIDENT, not tamper-proof)', () => {
  beforeEach(async () => { await resetChain(); await restoreIndexes(); });

  const buildChain = async (n) => { for (let i = 1; i <= n; i += 1) await auditService.log(params(i)); };

  test('deleting a middle record, rewriting a link, rewriting a hash and reordering are each detected, at the right sequence', async () => {
    await buildChain(5);
    await assertChainValid('before tampering');
    const docs = await AuditLog.collection.find({}).sort({ sequenceNumber: 1 }).toArray();

    await AuditLog.collection.deleteOne({ _id: docs[2]._id });
    let verification = await auditService.verifyAuditChain();
    assert.equal(verification.valid, false);
    assert.equal(verification.firstBrokenSequence, 4);
    assert.match(verification.reason, /Sequence continuity/);
    await AuditLog.collection.insertOne(docs[2]);
    await assertChainValid('after restoring the deleted record');

    await AuditLog.collection.updateOne({ _id: docs[3]._id }, { $set: { previousHash: '0'.repeat(64) } });
    verification = await auditService.verifyAuditChain();
    assert.equal(verification.firstBrokenSequence, 4);
    assert.match(verification.reason, /linkage/);
    await AuditLog.collection.updateOne({ _id: docs[3]._id }, { $set: { previousHash: docs[3].previousHash } });

    await AuditLog.collection.updateOne({ _id: docs[1]._id }, { $set: { hash: '1'.repeat(64) } });
    verification = await auditService.verifyAuditChain();
    assert.equal(verification.firstBrokenSequence, 2);
    assert.match(verification.reason, /hash/i);
    await AuditLog.collection.updateOne({ _id: docs[1]._id }, { $set: { hash: docs[1].hash } });

    // the unique index even refuses to let a record be renumbered onto an existing sequence number
    await assert.rejects(AuditLog.collection.updateOne({ _id: docs[4]._id }, { $set: { sequenceNumber: 3 } }), (error) => error.code === 11000);
    await AuditLog.collection.updateOne({ _id: docs[4]._id }, { $set: { sequenceNumber: 99 } });
    verification = await auditService.verifyAuditChain();
    assert.equal(verification.valid, false);
    assert.equal(verification.firstBrokenSequence, 99);
    await AuditLog.collection.updateOne({ _id: docs[4]._id }, { $set: { sequenceNumber: 5 } });
    await assertChainValid('after every corruption was reverted: verification is a pure function of the stored chain');
  });

  test('concurrent appends racing a verification never make a valid chain look broken', async () => {
    await buildChain(10);
    const writers = Array.from({ length: 30 }, (_, i) => auditService.log(params(100 + i)));
    const verifications = await Promise.all(Array.from({ length: 5 }, () => auditService.verifyAuditChain()));
    await Promise.all(writers);
    for (const verification of verifications) assert.equal(verification.valid, true, verification.reason);
    await assertChainValid();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Group B — payroll snapshot lifecycle
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe('B — payroll snapshots: persistence, audit and finalization are atomic', () => {
  const owner = createClient();
  const state = { employees: [] };
  let month = 0;

  const nextRun = async () => {
    month += 1;
    const actor = { id: state.ownerId, email: 'owner@example.com', role: 'admin' };
    const { run } = await payrollRunService.createPayrollRun({ companyId: state.companyId, periodMonth: month, periodYear: 2026, actorId: actor.id, actorEmail: actor.email, actorRole: actor.role });
    const runId = String(run._id);
    await payrollRunService.processPayrollRun(runId, state.companyId, actor);
    const processed = await PayrollRun.findById(runId).lean();
    assert.equal(processed.status, 'READY_FOR_FINALIZATION');
    assert.equal(processed.successfulEmployeeCount, 3);
    return { runId, actor };
  };
  const snapshotsOf = (runId) => PayrollSnapshot.find({ payrollRunId: runId }).lean();
  const eventsOf = async (runId, action) => {
    const ids = (await snapshotsOf(runId)).map((s) => s._id);
    return AuditLog.countDocuments({ action, entityId: { $in: [...ids, new mongoose.Types.ObjectId(runId)] } });
  };
  const created = async (runId) => AuditLog.countDocuments({ action: 'PAYROLL_SNAPSHOT_CREATED', entityId: { $in: (await snapshotsOf(runId)).map((s) => s._id) } });
  shared.nextRun = nextRun;
  shared.state = state;

  before(async () => {
    await resetChain();
    const res = await owner.post('/auth/register', { name: 'Owner One', email: 'owner@example.com', password: PASSWORD, confirmPassword: PASSWORD, companyName: 'Hardening Pvt Ltd' });
    assert.equal(res.status, 201);
    state.companyId = res.body.data.user.companyId;
    state.ownerId = res.body.data.user.id;
    const createdBy = new mongoose.Types.ObjectId();
    await ComplianceRuleVersion.create([
      { ruleType: 'EPF', jurisdiction: 'IN', effectiveFrom: new Date('2014-09-01'), createdBy, description: 'EPF test rule', epfParams: { employeeContributionRate: 0.12, employerContributionRate: 0.12, wageCapForContribution: 15000, epsRate: 0.0833, roundingMode: 'NEAREST_RUPEE' } },
      { ruleType: 'ESI', jurisdiction: 'IN', effectiveFrom: new Date('2019-07-01'), createdBy, description: 'ESI test rule', esiParams: { employeeContributionRate: 0.0075, employerContributionRate: 0.0325, grossWageCeiling: 21000, roundingMode: 'CEIL_RUPEE' } },
      { ruleType: 'PT', jurisdiction: 'MH', effectiveFrom: new Date('2000-01-01'), createdBy, description: 'MH PT test rule', ptSlabs: [{ upTo: 7500, monthlyTax: 0 }, { upTo: 10000, monthlyTax: 175 }, { upTo: null, monthlyTax: 200 }] },
    ]);
    for (const [first, last, special] of [['Asha', 'Verma', 4000], ['Ravi', 'Kumar', 4001], ['Meera', 'Iyer', 4002]]) {
      const employee = await owner.post('/employees', { firstName: first, lastName: last, email: `${first}.${last}@example.com`.toLowerCase(), department: 'Engineering', position: 'Engineer', salary: 20000, hireDate: '2024-01-15', status: 'active' });
      assert.equal(employee.status, 201, JSON.stringify(employee.body));
      const id = employee.body.data.employee._id;
      state.employees.push(id);
      const salary = await owner.post(`/employees/${id}/salary`, { effectiveFrom: '2026-01-01', components: { basic: 12000, hra: 4000, specialAllowance: special }, workState: 'MH', pfEnrolled: true, esiEnrolled: true, ptEnrolled: true });
      assert.equal(salary.status, 201, JSON.stringify(salary.body));
    }
  });

  test('a snapshot and its PAYROLL_SNAPSHOT_CREATED event commit together: when the event cannot be written, the snapshot is not persisted', async () => {
    const { runId, actor } = await nextRun();
    const restore = injectAuditFailure((entry, n) => entry.action === 'PAYROLL_SNAPSHOT_CREATED' && n === 2);
    let result;
    try { result = await payrollSnapshotService.materializeSnapshots(runId, state.companyId, actor); } finally { restore(); }
    assert.equal(result.errors, 1);
    assert.equal(result.created, 2);
    const persisted = await snapshotsOf(runId);
    assert.equal(persisted.length, 2, 'the snapshot whose audit event failed must NOT exist');
    assert.equal(await created(runId), persisted.length, 'every persisted snapshot has exactly one creation event');

    const retry = await payrollSnapshotService.materializeSnapshots(runId, state.companyId, actor);
    assert.equal(retry.created, 1);
    assert.equal(retry.reused, 2);
    assert.equal(retry.errors, 0);
    assert.equal((await snapshotsOf(runId)).length, 3);
    assert.equal(await created(runId), 3, 'and after the retry still exactly one event per snapshot (a reused snapshot logs nothing new)');
    await assertChainValid();
  });

  test('a failure right AFTER the creation event was written rolls the event back with its snapshot (they share one transaction)', async () => {
    const { runId, actor } = await nextRun();
    const eventsBefore = await AuditLog.countDocuments({});
    const restore = injectFailureAfterAuditWrite((entry) => entry.action === 'PAYROLL_SNAPSHOT_CREATED');
    let result;
    try { result = await payrollSnapshotService.materializeSnapshots(runId, state.companyId, actor); } finally { restore(); }
    assert.equal(result.created, 0);
    assert.equal(result.errors, 3, 'every employee failed after its event was written');
    assert.equal((await snapshotsOf(runId)).length, 0, 'no snapshot persisted');
    assert.equal(await AuditLog.countDocuments({}), eventsBefore, 'and no creation event survived: the event was written inside the transaction that was rolled back');
    const retry = await payrollSnapshotService.materializeSnapshots(runId, state.companyId, actor);
    assert.equal(retry.created, 3);
    assert.equal(await created(runId), 3);
    await assertChainValid();
  });

  test('a partially materialized run is completed by simply finalizing again: no duplicates, one event per snapshot, finalized once', async () => {
    const { runId, actor } = await nextRun();
    const restore = injectAuditFailure((entry, n) => entry.action === 'PAYROLL_SNAPSHOT_CREATED' && n === 3);
    await payrollSnapshotService.materializeSnapshots(runId, state.companyId, actor).finally(restore);
    assert.equal((await snapshotsOf(runId)).length, 2, 'two of three materialized');
    assert.equal((await PayrollRun.findById(runId).lean()).status, 'READY_FOR_FINALIZATION');

    const result = await payrollFinalizationService.finalize(runId, state.companyId, actor);
    assert.equal(result.snapshotCount, 3);
    const run = await PayrollRun.findById(runId).lean();
    assert.equal(run.status, 'FINALIZED');
    const snapshots = await snapshotsOf(runId);
    assert.equal(snapshots.length, 3);
    assert.ok(snapshots.every((s) => s.snapshotStatus === 'FINALIZED'));
    assert.equal(await created(runId), 3);
    assert.equal(await AuditLog.countDocuments({ action: 'PAYROLL_FINALIZED', entityId: runId }), 1);
    await assertChainValid();
  });

  test('finalization is ALL-OR-NOTHING including its audit events: a failure at any event leaves the run READY and every snapshot PENDING', async () => {
    for (const failing of ['PAYROLL_FINALIZED', 'PAYROLL_SNAPSHOT_FINALIZED']) {
      const { runId, actor } = await nextRun();
      await payrollSnapshotService.materializeSnapshots(runId, state.companyId, actor);
      const before = await snapshotsOf(runId);
      const eventsBefore = await AuditLog.countDocuments({});

      const restore = injectAuditFailure((entry) => entry.action === failing);
      await assert.rejects(payrollSnapshotService.finalizeRun(runId, state.companyId, actor), /Injected audit failure/, failing);
      restore();

      assert.equal((await PayrollRun.findById(runId).lean()).status, 'READY_FOR_FINALIZATION', `${failing}: the run must not be finalized`);
      const after = await snapshotsOf(runId);
      assert.ok(after.every((s) => s.snapshotStatus === 'PENDING_FINALIZATION'), `${failing}: no snapshot may be finalized`);
      assert.deepEqual(after.map((s) => s.snapshotHash), before.map((s) => s.snapshotHash));
      assert.equal(await AuditLog.countDocuments({}), eventsBefore, `${failing}: no audit event written`);
      assert.equal(await AuditLog.countDocuments({ action: { $in: ['PAYROLL_FINALIZED', 'PAYROLL_SNAPSHOT_FINALIZED'] }, entityId: runId }), 0);

      const retried = await payrollSnapshotService.finalizeRun(runId, state.companyId, actor);
      assert.equal(retried.snapshotCount, 3);
      assert.equal(await AuditLog.countDocuments({ action: 'PAYROLL_FINALIZED', entityId: runId }), 1, `${failing}: exactly one event after the retry`);
      assert.equal(await AuditLog.countDocuments({ action: 'PAYROLL_SNAPSHOT_FINALIZED', entityId: runId }), 1);
      await assertChainValid();
    }
  });

  test('a failure right AFTER a finalization event was written leaves nothing behind (every finalization event shares the finalization transaction)', async () => {
    for (const after of ['PAYROLL_FINALIZED', 'PAYROLL_SNAPSHOT_FINALIZED', 'HARDENING_LATE_EXTRA']) {
      const { runId, actor } = await nextRun();
      await payrollSnapshotService.materializeSnapshots(runId, state.companyId, actor);
      const eventsBefore = await AuditLog.countDocuments({});
      const extra = [{ action: 'HARDENING_LATE_EXTRA', actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, entityType: 'PAYROLL_RUN', entityId: runId, companyId: state.companyId, meta: {} }];
      const restore = injectFailureAfterAuditWrite((entry) => entry.action === after);
      await assert.rejects(payrollSnapshotService.finalizeRun(runId, state.companyId, actor, { extraAuditEvents: extra }), /Injected failure right after/, after);
      restore();
      assert.equal(await AuditLog.countDocuments({}), eventsBefore, `${after}: every event written before the failure was rolled back with the transaction`);
      assert.equal((await PayrollRun.findById(runId).lean()).status, 'READY_FOR_FINALIZATION', after);
      assert.ok((await snapshotsOf(runId)).every((snap) => snap.snapshotStatus === 'PENDING_FINALIZATION'), after);
      await payrollSnapshotService.finalizeRun(runId, state.companyId, actor);
      await assertChainValid();
    }
  });

  test('extra audit events handed to finalization (e.g. a variance override) are written in the same transaction', async () => {
    const { runId, actor } = await nextRun();
    await payrollSnapshotService.materializeSnapshots(runId, state.companyId, actor);
    const extra = [{ action: 'PAYROLL_VARIANCE_OVERRIDDEN', actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, entityType: 'PAYROLL_RUN', entityId: runId, companyId: state.companyId, meta: { reason: 'hardening test override reason' } }];

    const restore = injectAuditFailure((entry) => entry.action === 'PAYROLL_VARIANCE_OVERRIDDEN');
    await assert.rejects(payrollSnapshotService.finalizeRun(runId, state.companyId, actor, { extraAuditEvents: extra }), /Injected audit failure/);
    restore();
    assert.equal((await PayrollRun.findById(runId).lean()).status, 'READY_FOR_FINALIZATION', 'the override event failing aborts the whole finalization');

    await payrollSnapshotService.finalizeRun(runId, state.companyId, actor, { extraAuditEvents: extra });
    assert.equal(await AuditLog.countDocuments({ action: 'PAYROLL_VARIANCE_OVERRIDDEN', entityId: runId }), 1);
    assert.equal((await PayrollRun.findById(runId).lean()).status, 'FINALIZED');
    await assertChainValid();
  });

  test('several extra events are all-or-nothing together: when the LAST one fails, the earlier ones, every snapshot and the run are rolled back', async () => {
    const { runId, actor } = await nextRun();
    await payrollSnapshotService.materializeSnapshots(runId, state.companyId, actor);
    const extra = (name) => ({ action: name, actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, entityType: 'PAYROLL_RUN', entityId: runId, companyId: state.companyId, meta: { name } });
    const events = [extra('HARDENING_EXTRA_ONE'), extra('HARDENING_EXTRA_TWO'), extra('HARDENING_EXTRA_THREE')];
    const auditBefore = await AuditLog.countDocuments({});

    const restore = injectAuditFailure((entry) => entry.action === 'HARDENING_EXTRA_THREE');
    await assert.rejects(payrollSnapshotService.finalizeRun(runId, state.companyId, actor, { extraAuditEvents: events }), /Injected audit failure/);
    restore();

    assert.equal(await AuditLog.countDocuments({}), auditBefore, 'no event of the failed finalization survived, not even the ones that were written before the failure');
    assert.equal(await AuditLog.countDocuments({ action: { $in: ['HARDENING_EXTRA_ONE', 'HARDENING_EXTRA_TWO'] } }), 0);
    assert.equal((await PayrollRun.findById(runId).lean()).status, 'READY_FOR_FINALIZATION');
    assert.ok((await snapshotsOf(runId)).every((s) => s.snapshotStatus === 'PENDING_FINALIZATION'));

    await payrollSnapshotService.finalizeRun(runId, state.companyId, actor, { extraAuditEvents: events });
    for (const event of events) assert.equal(await AuditLog.countDocuments({ action: event.action }), 1, `${event.action} exactly once after the retry`);
    const chain = await AuditLog.find({ action: { $in: ['PAYROLL_FINALIZED', 'PAYROLL_SNAPSHOT_FINALIZED', 'HARDENING_EXTRA_ONE', 'HARDENING_EXTRA_TWO', 'HARDENING_EXTRA_THREE'] }, entityId: runId }).sort({ sequenceNumber: 1 }).lean();
    assert.deepEqual(chain.map((e) => e.action), ['PAYROLL_FINALIZED', 'PAYROLL_SNAPSHOT_FINALIZED', 'HARDENING_EXTRA_ONE', 'HARDENING_EXTRA_TWO', 'HARDENING_EXTRA_THREE'], 'one transaction, consecutive and in order');
    assert.deepEqual(chain.map((e) => e.sequenceNumber), chain.map((e, i) => chain[0].sequenceNumber + i));
    await assertChainValid();
  });

  test('retried and duplicate finalization requests (8 at once, then again afterwards) change nothing: one winner, one event each, amounts and hashes untouched', async () => {
    const { runId, actor } = await nextRun();
    await payrollSnapshotService.materializeSnapshots(runId, state.companyId, actor);
    const settled = await Promise.allSettled(Array.from({ length: 8 }, () => payrollSnapshotService.finalizeRun(runId, state.companyId, actor)));
    assert.equal(settled.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one finalization wins');
    for (const r of settled.filter((x) => x.status === 'rejected')) assert.ok([409, 422].includes(r.reason.statusCode), `a loser is a clean conflict, not ${r.reason.statusCode}/${r.reason.code}: ${r.reason.message}`);
    assert.equal(await AuditLog.countDocuments({ action: 'PAYROLL_FINALIZED', entityId: runId }), 1);
    assert.equal(await AuditLog.countDocuments({ action: 'PAYROLL_SNAPSHOT_FINALIZED', entityId: runId }), 1);

    const frozen = (await snapshotsOf(runId)).map((s) => ({ id: String(s._id), hash: s.snapshotHash, finalizedAt: String(s.finalizedAt), results: JSON.stringify(s.payrollResults), valid: computeSnapshotHash(s) === s.snapshotHash }));
    assert.ok(frozen.every((s) => s.valid));
    await assert.rejects(payrollSnapshotService.finalizeRun(runId, state.companyId, actor), (error) => error.statusCode === 409);
    await assert.rejects(payrollFinalizationService.finalize(runId, state.companyId, actor), (error) => error.statusCode === 409);
    const again = (await snapshotsOf(runId)).map((s) => ({ id: String(s._id), hash: s.snapshotHash, finalizedAt: String(s.finalizedAt), results: JSON.stringify(s.payrollResults), valid: computeSnapshotHash(s) === s.snapshotHash }));
    assert.deepEqual(again, frozen, 'a retried finalization must not rewrite a finalized snapshot in any way');
    assert.equal(await AuditLog.countDocuments({ action: 'PAYROLL_FINALIZED', entityId: runId }), 1);
    await assertChainValid();
  });

  test('every FINALIZED run in the database has exactly one PAYROLL_FINALIZED and one PAYROLL_SNAPSHOT_FINALIZED event (no crash window leaves a gap)', async () => {
    const runs = await PayrollRun.find({ status: 'FINALIZED' }).lean();
    assert.ok(runs.length >= 3);
    for (const run of runs) {
      assert.equal(await AuditLog.countDocuments({ action: 'PAYROLL_FINALIZED', entityId: run._id }), 1, `run ${run._id} PAYROLL_FINALIZED`);
      assert.equal(await AuditLog.countDocuments({ action: 'PAYROLL_SNAPSHOT_FINALIZED', entityId: run._id }), 1, `run ${run._id} PAYROLL_SNAPSHOT_FINALIZED`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Group C — the pending-snapshot reconciliation tool
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe('C — reconciliation tool: classification, read-only dry run, apply disabled', () => {
  const BACKEND = fileURLToPath(new URL('.', import.meta.url));
  const SCRIPT = fileURLToPath(new URL('./scripts/reconcile-payroll-snapshots.mjs', import.meta.url));
  const EVIDENCE = path.join(os.tmpdir(), `payguard-reconcile-${process.pid}-${Date.now()}`);
  let synthYear = 2030;
  let historical;

  const collections = () => [PayrollSnapshot, PayrollRun, PayrollStagingResult, AuditLog].map((model) => model.collection.name);
  /** A content fingerprint of everything the tool could possibly touch. */
  const fingerprint = async () => {
    const out = {};
    for (const name of [...collections(), 'maintenance_locks']) {
      const docs = await mongoose.connection.collection(name).find({}).sort({ _id: 1 }).toArray();
      out[name] = { count: docs.length, sha: crypto.createHash('sha256').update(JSON.stringify(docs)).digest('hex') };
    }
    return out;
  };

  const baseRun = () => PayrollRun.findOne({ status: 'FINALIZED' }).lean();
  const baseSnapshot = () => PayrollSnapshot.findOne({ snapshotStatus: 'FINALIZED' }).lean();
  async function makeRun(status) {
    const run = { ...(await baseRun()), _id: new mongoose.Types.ObjectId(), status, periodYear: (synthYear += 1), periodMonth: 1 };
    delete run.idempotencyKey;
    await PayrollRun.collection.insertOne(run);
    return run;
  }
  async function makeSnapshot(run, { status = 'PENDING_FINALIZATION', tamper = null, employeeId = new mongoose.Types.ObjectId() } = {}) {
    const base = await baseSnapshot();
    const doc = {
      ...base, _id: new mongoose.Types.ObjectId(), payrollRunId: run._id, periodYear: run.periodYear, periodMonth: run.periodMonth,
      snapshotStatus: status, finalizedAt: status === 'FINALIZED' ? base.finalizedAt : null, finalizedBy: status === 'FINALIZED' ? base.finalizedBy : null,
      employeeSnapshot: { ...base.employeeSnapshot, employeeId },
    };
    doc.snapshotHash = computeSnapshotHash(doc);
    if (tamper === 'hash') doc.snapshotHash = '0'.repeat(64);
    if (tamper === 'content') doc.payrollResults = { ...doc.payrollResults, netPayBeforeTDS: doc.payrollResults.netPayBeforeTDS + 1 };
    await PayrollSnapshot.collection.insertOne(doc);
    return doc;
  }
  const scanRun = (run) => recon.scanPayrollSnapshots({ runId: String(run._id) });
  const exists = (id) => PayrollSnapshot.collection.countDocuments({ _id: new mongoose.Types.ObjectId(String(id)) });
  const runCli = (args, env = {}) => new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { cwd: BACKEND, env: { ...process.env, MONGO_URI: TEST_DB_URI, ...env } }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });

  before(async () => {
    historical = (await PayrollSnapshot.find({ snapshotStatus: 'FINALIZED' }).sort({ _id: 1 }).lean()).map((s) => JSON.stringify(s));
    assert.ok(historical.length >= 12, 'the earlier groups produced finalized snapshots to protect');
  });

  after(() => { fs.rmSync(EVIDENCE, { recursive: true, force: true }); });

  test('every state is classified, with the action the policy prescribes', async () => {
    const expect = async (run, snap, cls, action) => {
      const report = await scanRun(run);
      const item = report.items.find((i) => i.snapshotId === String(snap._id));
      assert.equal(item.class, cls, `${cls}: ${item.reason}`);
      assert.equal(item.action, action, cls);
    };
    for (const status of ['FAILED', 'CANCELLED']) {
      const run = await makeRun(status);
      await expect(run, await makeSnapshot(run), recon.CLASSES.ORPHAN_PENDING, recon.ACTIONS.PURGE_ELIGIBLE);
    }
    const processing = await makeRun('PROCESSING');
    await expect(processing, await makeSnapshot(processing), recon.CLASSES.PENDING_ON_ACTIVE_RUN, recon.ACTIONS.INVESTIGATE);
    const closed = await makeRun('FINALIZED');
    await expect(closed, await makeSnapshot(closed), recon.CLASSES.PENDING_UNDER_FINALIZED_RUN, recon.ACTIONS.INVESTIGATE);
    await expect(closed, await makeSnapshot(closed, { status: 'FINALIZED' }), recon.CLASSES.OK, recon.ACTIONS.NONE);
    const ready = await makeRun('READY_FOR_FINALIZATION');
    await expect(ready, await makeSnapshot(ready, { status: 'FINALIZED' }), recon.CLASSES.FINALIZED_UNDER_UNFINALIZED_RUN, recon.ACTIONS.INVESTIGATE);
    const hashRun = await makeRun('FAILED');
    await expect(hashRun, await makeSnapshot(hashRun, { tamper: 'hash' }), recon.CLASSES.HASH_INVALID, recon.ACTIONS.INVESTIGATE);
    await expect(hashRun, await makeSnapshot(hashRun, { tamper: 'content' }), recon.CLASSES.HASH_INVALID, recon.ACTIONS.INVESTIGATE);
    await expect(closed, await makeSnapshot(closed, { status: 'FINALIZED', tamper: 'content' }), recon.CLASSES.HASH_INVALID, recon.ACTIONS.INVESTIGATE);
    const ghost = { _id: new mongoose.Types.ObjectId(), periodYear: 2099, periodMonth: 1 };
    await expect(ghost, await makeSnapshot(ghost), recon.CLASSES.RUN_MISSING, recon.ACTIONS.INVESTIGATE);
  });

  test('duplicates (only possible without the unique index) and a genuinely in-flight / stale run are classified', async () => {
    // in flight: a real READY run, materialized from its real staging
    const { runId, actor } = await shared.nextRun();
    await payrollSnapshotService.materializeSnapshots(runId, shared.state.companyId, actor);
    let report = await recon.scanPayrollSnapshots({ runId });
    assert.deepEqual(report.byClass, { [recon.CLASSES.IN_FLIGHT]: 3 });
    assert.ok(report.items.every((i) => i.action === recon.ACTIONS.FINALIZE_AGAIN));
    assert.deepEqual(report.purgeEligible, []);
    // stale: staging changed after materialization
    const staging = await PayrollStagingResult.findOne({ runId }).lean();
    await PayrollStagingResult.collection.updateOne({ _id: staging._id }, { $set: { totalEmployeeDeductions: staging.totalEmployeeDeductions + 1 } });
    report = await recon.scanPayrollSnapshots({ runId });
    assert.equal(report.byClass[recon.CLASSES.PENDING_STALE], 1);
    assert.equal(report.byClass[recon.CLASSES.IN_FLIGHT], 2);
    await PayrollStagingResult.collection.updateOne({ _id: staging._id }, { $set: { totalEmployeeDeductions: staging.totalEmployeeDeductions } });
    shared.inFlightRun = runId;

    // duplicates
    const run = await makeRun('FAILED');
    const employeeId = new mongoose.Types.ObjectId();
    await makeSnapshot(run, { employeeId });
    await PayrollSnapshot.collection.dropIndex('unique_snapshot_per_run_employee');
    try {
      await makeSnapshot(run, { employeeId });
      report = await scanRun(run);
      assert.deepEqual(report.byClass, { [recon.CLASSES.DUPLICATE_SNAPSHOT]: 2 });
      assert.deepEqual(report.purgeEligible, [], 'a duplicate is never purged automatically');
    } finally {
      await PayrollSnapshot.collection.deleteMany({ payrollRunId: run._id });
      await PayrollSnapshot.createIndexes();
    }
  });

  test('audit gaps are reported, never repaired', async () => {
    const run = await makeRun('FINALIZED');
    const snapshot = await makeSnapshot(run, { status: 'FINALIZED' });
    const before = await AuditLog.countDocuments({});
    const report = await scanRun(run);
    assert.ok(report.auditGaps.some((g) => g.snapshotId === String(snapshot._id)), 'no PAYROLL_SNAPSHOT_CREATED event');
    const finding = report.runFindings.find((f) => f.runId === String(run._id));
    assert.deepEqual(finding.missingAuditEvents, ['PAYROLL_FINALIZED', 'PAYROLL_SNAPSHOT_FINALIZED']);
    assert.equal(await AuditLog.countDocuments({}), before, 'scanning backfills nothing');
  });

  /** Every collection, its documents and its index names: the full observable shape of the database. */
  const dbShape = async () => {
    const shape = {};
    for (const { name } of await mongoose.connection.db.listCollections().toArray()) {
      const collection = mongoose.connection.collection(name);
      const docs = await collection.find({}).sort({ _id: 1 }).toArray();
      shape[name] = {
        count: docs.length,
        sha: crypto.createHash('sha256').update(JSON.stringify(docs)).digest('hex'),
        indexes: (await collection.indexes()).map((index) => index.name).sort(),
      };
    }
    return shape;
  };

  /** Names of the collections whose content or indexes differ between two dbShape() results ([] means identical). */
  const changedCollections = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((name) => JSON.stringify(a[name]) !== JSON.stringify(b[name]));

  test('DRY RUN IS THE ONLY MODE AND WRITES NOTHING: the library scan and the CLI leave every document, collection and index unchanged, and create no file', async () => {
    const orphanRun = await makeRun('CANCELLED');
    await makeSnapshot(orphanRun);
    const before = await dbShape();
    await recon.scanPayrollSnapshots({});
    const plain = await runCli([]);
    assert.equal(plain.code, 0, plain.stderr);
    assert.match(plain.stdout, /mode: DRY_RUN/);
    assert.match(plain.stdout, /DRY RUN: nothing was written/);
    assert.match(plain.stdout, /purge-eligible \(informational only; apply is disabled\): [1-9]/);
    const asJson = await runCli(['--json']);
    assert.equal(JSON.parse(asJson.stdout).mode, 'DRY_RUN');
    const scoped = await runCli(['--company', String(orphanRun.companyId), '--run', String(orphanRun._id)]);
    assert.equal(scoped.code, 0, scoped.stderr);
    assert.deepEqual(await dbShape(), before, 'not one document, collection or index changed');
    assert.equal(fs.existsSync(path.join(BACKEND, 'reconcile-evidence')), false, 'no evidence directory is created');
  });

  test('--apply is refused BEFORE any database access, whatever else is passed: the CLI never connects (an unreachable database does not change the outcome) and nothing is created', async () => {
    const unreachable = { MONGO_URI: 'mongodb://127.0.0.1:1/never_reached?serverSelectionTimeoutMS=100' };
    const company = String(new mongoose.Types.ObjectId());
    const run = String(new mongoose.Types.ObjectId());
    const evidenceDir = path.join(EVIDENCE, 'must-not-exist');
    for (const args of [
      ['--apply'],
      ['--apply', '--purge-orphans', '--operator', 'tester'],
      ['--apply', '--purge-orphans', '--operator', 'tester', '--company', company, '--run', run, '--evidence-dir', evidenceDir],
    ]) {
      const started = Date.now();
      const result = await runCli(args, unreachable);
      assert.equal(result.code, 1, args.join(' '));
      assert.match(result.stderr, /Refusing to apply: .*APPLY_DISABLED/, args.join(' '));
      assert.doesNotMatch(result.stderr, /failed:|ECONNREFUSED|MongoServerSelection/, 'it was refused, it did not try to connect and fail');
      assert.ok(Date.now() - started < 5000, 'refused without waiting for a database');
    }
    const withAllFlags = await runCli(['--apply', '--purge-orphans', '--operator', 'tester', '--company', company, '--run', run], unreachable);
    assert.doesNotMatch(withAllFlags.stderr, /OPERATOR_INVALID|SCOPE_REQUIRED/, 'a complete, valid request is refused only because apply is disabled');
    const incomplete = await runCli(['--apply', '--operator', '  x'], unreachable);
    assert.match(incomplete.stderr, /SCOPE_REQUIRED: --company/);
    assert.match(incomplete.stderr, /SCOPE_REQUIRED: --run/);
    assert.equal(fs.existsSync(evidenceDir), false, 'no evidence directory is created by a refused apply');
  });

  test('arguments are parsed strictly: unknown, positional, duplicated, blank, valueless, malformed and --flag=value forms are all refused; no environment variable enables anything', async () => {
    const before = await dbShape();
    const reportPath = path.join(os.tmpdir(), `payguard-reconcile-report-${process.pid}.json`);
    fs.writeFileSync(reportPath, 'keep-me');
    const bad = String(new mongoose.Types.ObjectId());
    const cases = [
      [['--frobnicate'], /unknown argument --frobnicate/],
      [['stray'], /unexpected argument "stray"/],
      [['--json', '--json'], /--json was given more than once/],
      [['--company', bad, '--company', bad], /--company was given more than once/],
      [['--company'], /--company needs a value/],
      [['--company', '--run', bad], /--company needs a value/],
      [['--company', ''], /--company must not be blank/],
      [['--run', '   '], /--run must not be blank/],
      [['--company', 'abc'], /--company must be a 24-character hexadecimal id/],
      [['--run', 'zzzzzzzzzzzzzzzzzzzzzzzz'], /--run must be a 24-character hexadecimal id/],
      [[`--company=${bad}`], /unknown argument --company=/],
      [['--purge-orphans'], /only meaningful with --apply, which is disabled/],
      [['--operator', 'someone'], /only meaningful with --apply, which is disabled/],
      [['--evidence-dir', 'somewhere'], /only meaningful with --apply, which is disabled/],
    ];
    for (const [args, reason] of cases) {
      const result = await runCli(args);
      assert.equal(result.code, 1, args.join(' '));
      assert.match(result.stderr, reason, `${args.join(' ')}: refused for the right reason`);
    }
    // --report never overwrites an existing file
    const overwrite = await runCli(['--report', reportPath]);
    assert.equal(overwrite.code, 1);
    assert.match(overwrite.stderr, /EEXIST/);
    assert.equal(fs.readFileSync(reportPath, 'utf8'), 'keep-me', 'an existing file is never overwritten');
    fs.rmSync(reportPath);
    // nothing in the environment can switch a mode on: these are ignored and the run stays a dry run
    const hostile = await runCli([], { RECONCILE_APPLY: '1', APPLY: 'true', PURGE_ORPHANS: 'true', REQUIRE_TRANSACTIONS: 'false', NODE_ENV: 'development' });
    assert.equal(hostile.code, 0, hostile.stderr);
    assert.match(hostile.stdout, /mode: DRY_RUN/);
    assert.deepEqual(await dbShape(), before);
  });

  test('purgeOrphans() refuses UNCONDITIONALLY, even for a perfect request and a perfect scan, and reports every reason it can establish; the exported function is not a way around the CLI', async () => {
    const scan = await recon.scanPayrollSnapshots({});
    assert.equal(scan.auditChain.valid, true);
    const before = await dbShape();
    const company = String(new mongoose.Types.ObjectId());
    const run = String(new mongoose.Types.ObjectId());
    const refuses = async (input, expected, unexpected = []) => {
      const beforeThisCall = await dbShape(); // taken right before the call: some cases deliberately alter the database first
      await assert.rejects(recon.purgeOrphans(input), (error) => {
        assert.ok(error instanceof recon.ReconciliationRefused, 'a ReconciliationRefused, not a crash');
        for (const code of ['APPLY_DISABLED', ...expected]) assert.ok(error.reasons.some((reason) => reason.startsWith(code)), `${code} is among the reasons: ${error.reasons.map((r) => r.slice(0, 24))}`);
        for (const code of unexpected) assert.ok(!error.reasons.some((reason) => reason.startsWith(code)), `${code} must not be reported for this request`);
        return true;
      });
      assert.deepEqual(changedCollections(beforeThisCall, await dbShape()), [], 'a refusal changes nothing');
    };
    // a perfect request: still refused, and only because apply is disabled
    await refuses({ scan, operator: 'tester', company, run, evidenceDir: EVIDENCE }, [], ['OPERATOR_INVALID', 'SCOPE_REQUIRED', 'TRANSACTIONS_UNAVAILABLE', 'CHAIN_UNVERIFIED', 'CHAIN_GUARDS_UNVERIFIED']);
    // each further reason is reported when it applies
    await refuses({ scan, operator: '   ', company, run }, ['OPERATOR_INVALID']);
    await refuses({ scan, operator: 'x'.repeat(101), company, run }, ['OPERATOR_INVALID']);
    await refuses({ scan, operator: 'tester', company: '', run }, ['SCOPE_REQUIRED: --company']);
    await refuses({ scan, operator: 'tester', company, run: 'not-an-id' }, ['SCOPE_REQUIRED: --run']);
    await refuses({ operator: 'tester', company, run }, ['CHAIN_UNVERIFIED', 'CHAIN_GUARDS_UNVERIFIED']); // no scan at all: nothing is assumed
    await refuses({ scan: { auditChain: { valid: true }, auditChainGuards: { ok: true } }, operator: 'tester', company, run }, [], ['CHAIN_UNVERIFIED']); // a caller-built scan can only ADD reasons, never authorize
    // an invalid chain, as a scan reports it
    const first = await AuditLog.collection.findOne({ sequenceNumber: 1 });
    await AuditLog.collection.updateOne({ _id: first._id }, { $set: { action: 'TAMPERED' } });
    try {
      const tampered = await recon.scanPayrollSnapshots({});
      assert.equal(tampered.auditChain.valid, false);
      await refuses({ scan: tampered, operator: 'tester', company, run }, ['CHAIN_UNVERIFIED']);
    } finally {
      await AuditLog.collection.updateOne({ _id: first._id }, { $set: { action: first.action } });
    }
    // missing chain guards
    await AuditLog.collection.dropIndex('previousHash_unique_successor');
    try {
      const noGuards = await recon.scanPayrollSnapshots({});
      assert.equal(noGuards.auditChainGuards.ok, false);
      await refuses({ scan: noGuards, operator: 'tester', company, run }, ['CHAIN_GUARDS_UNVERIFIED']);
    } finally {
      await AuditLog.createIndexes();
    }
    assert.deepEqual(changedCollections(before, await dbShape()), [], 'after the deliberate tamper and guard drop were restored, the database equals its state at the start');
    assert.equal(fs.existsSync(EVIDENCE), false, 'no evidence directory, no file');
    assert.equal(await mongoose.connection.db.listCollections({ name: 'maintenance_locks' }).hasNext(), false, 'no lock collection exists to be held');
  });

  test('the recovery tool contains NO code that can write: no insert, update, delete, replace, bulk write, index or collection operation, no transaction, no file write other than the exclusive-create report', async () => {
    const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
    const forbidden = /\b(insertOne|insertMany|updateOne|updateMany|replaceOne|bulkWrite|deleteOne|deleteMany|findOneAndUpdate|findOneAndDelete|findOneAndReplace|findByIdAndUpdate|findByIdAndDelete|createIndex|createIndexes|ensureIndexes|dropIndex|dropIndexes|dropCollection|dropDatabase|createCollection|syncIndexes|runInTransaction|startTransaction|startSession)\b|\.(save|create|remove|collection)\(/;
    for (const file of [SCRIPT, fileURLToPath(new URL('./scripts/lib/snapshotReconciliation.mjs', import.meta.url))]) {
      const code = strip(fs.readFileSync(file, 'utf8'));
      const hit = forbidden.exec(code);
      assert.equal(hit, null, `${path.basename(file)} contains a write-capable call: ${hit && hit[0]}`);
    }
    const cli = strip(fs.readFileSync(SCRIPT, 'utf8'));
    const writes = [...cli.matchAll(/fs\.(\w+)\(/g)].map((match) => match[1]);
    assert.deepEqual(writes, ['writeFileSync'], 'the only file operation is the report write');
    assert.match(cli, /flag: 'wx'/, 'and it is an exclusive create that never overwrites');
  });

  test('historical integrity: every finalized snapshot that existed before this group is byte-identical, its hash valid, and the audit chain verifies', async () => {
    const after = (await PayrollSnapshot.find({ snapshotStatus: 'FINALIZED' }).sort({ _id: 1 }).lean()).map((s) => JSON.stringify(s));
    for (const original of historical) assert.ok(after.includes(original), 'a historical finalized snapshot changed');
    for (const json of historical) { const snapshot = JSON.parse(json); assert.equal(computeSnapshotHash({ ...snapshot, payrollRunId: snapshot.payrollRunId, stagingResultId: snapshot.stagingResultId }), snapshot.snapshotHash, 'stored hash still equals the recomputed hash'); }
    await assertChainValid('final check');
  });
});
