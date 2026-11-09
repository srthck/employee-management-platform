/**
 * test_audit_chain_head.js — Phase 2 of the integrity program: the transactional audit-chain head.
 *
 * Runner: node:test.  Real MongoDB replica set, isolated database (AUDIT_HEAD_MONGO_URI), dropped before and after.
 * Run: node --test test_audit_chain_head.js   (or the full suite: npm test)
 *
 * What the tests assert: the database tests assert PERSISTED state (records, head document, business documents), not only a
 * return value or an error. The exceptions are labelled in their titles: pure functions (the mode policy, the specification
 * evaluators, the argument parsing), the static census (a tripwire, see its comment) and the readiness unit tests.
 * Concurrency: the race tests (B, C) use SEPARATE OS processes released by a database barrier, not
 * sleeps; the workers connect with autoIndex/autoCreate OFF and every race asserts that the injected index fault still held when
 * the writers were released and when they finished. Tests that need two writers inside ONE process (a paused writer, an overtaken
 * writer, the initializer barrier) hold a call at a gate and say so. Anything that is a simulation (a stubbed commit result,
 * a stubbed standalone server, a stubbed $currentOp answer, an injected exception) says SIMULATED in its title; the process-crash
 * test is a real SIGKILL.
 *
 *   A  — basic append invariants and the hash format (an independent canonical-bytes vector)
 *   B  — competing writers: processes released together (lane off AND the production lane-on configuration), a writer paused
 *        between its read and its write (indexes present and absent)
 *   C  — index faults: absent, look-alike (ineffective partial filter) and incompatible indexes; the chain still never forks;
 *        a real index build in progress
 *   D  — transaction rollback and commit-outcome injection at every step, including a real process crash
 *   E  — session semantics and the static census of every audit writer (six tripwires)
 *   E2 — a re-run transaction callback must not apply an outer-scope effect twice (activateDue)
 *   F  — controlled initialization, cutover and old writers
 *   F2 — cutover on an empty/absent chain, more refusals, real-server old-writer interleavings, competing initializers,
 *        copy-database, the CLI's evidence
 *   G  — strict mode, readiness, the development fallback; the head-creation race on a real server
 *   G2 — the development fallback under concurrency
 *   G3 — the mode policy, readiness that fails closed, the loopback-only bootstrap, nested audited transactions, the retry
 *        budget, a consistent verifyHead, the validator and the specification pins
 *   H  — the per-process transaction lane (liveness only)
 *   I  — head verification and the specification evaluators, one disagreement / one option at a time
 */

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'audit-head-test-secret-long-enough';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.FIELD_ENCRYPTION_KEYS = `v1:${crypto.randomBytes(32).toString('base64')}`;
process.env.FIELD_ENCRYPTION_ACTIVE_KEY = 'v1';
process.env.FIELD_BLIND_INDEX_KEY = crypto.randomBytes(32).toString('hex');

const TEST_DB_URI = process.env.AUDIT_HEAD_MONGO_URI || 'mongodb://127.0.0.1:27018/payguard_audit_head_test?replicaSet=rs0';
process.env.MONGO_URI = TEST_DB_URI;

const BACKEND = fileURLToPath(new URL('.', import.meta.url));
const WORKER = path.join(BACKEND, 'test_support/auditHeadRaceWorker.mjs');
const HEAD_CLI = path.join(BACKEND, 'scripts/audit-chain-head.mjs');

const { default: app } = await import('./src/app.js');
const { default: config } = await import('./src/config/environment.js');
const { default: AuditLog } = await import('./src/models/AuditLog.js');
const { default: AuditChainHead } = await import('./src/models/AuditChainHead.js');
const { default: auditService, calculateAuditHash, GENESIS_HASH } = await import('./src/services/auditService.js');
const { planHeadInitialization, applyHeadInitialization, HeadInitializationRefused } = await import('./src/services/auditChainHeadService.js');
const { REQUIRED_VALIDATOR, REQUIRED_INDEXES, VALIDATION_OPTIONS, evaluateIndexes, evaluateValidator, indexMismatch } = await import('./src/services/auditChainSpec.js');
const { runInTransaction, resetTransactionCapabilityCache, transactionLane, transactionLaneStatus, supportsTransactions } = await import('./src/utils/transaction.js');
const { resolveAuditChainPolicy } = await import('./src/config/auditChainPolicy.js');

const actorId = new mongoose.Types.ObjectId();
const params = (i, extra = {}) => ({ action: 'HEAD_TEST', actorId, entityType: 'TEST', entityId: new mongoose.Types.ObjectId(), meta: { i }, ...extra });
const scratch = () => mongoose.connection.collection('audit_head_scratch');
const raceScratch = () => mongoose.connection.collection('audit_race_scratch');
const heads = () => AuditChainHead.collection;
const headDoc = () => heads().findOne({ _id: 'global' });
const records = () => AuditLog.collection.find({}).sort({ sequenceNumber: 1, _id: 1 }).toArray();
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ── independent canonical bytes: the historical format re-implemented here from its RULES, NOT imported from the service ──
//   keys sorted at every depth; the keys password/passwordHash/jwt/token/refreshToken/secret/bankAccount/bankCredentials/privateKey
//   are replaced by "[REDACTED]"; ObjectIds and dates are strings; and EVERY NUMBER IS RENDERED AS A DECIMAL STRING
//   (an artefact of the original normalization, where mongoose.isValidObjectId(number) is true). That last rule is historical
//   behaviour and is deliberately preserved: changing it would change every stored hash.
const SENSITIVE = new Set(['password', 'passwordHash', 'jwt', 'token', 'refreshToken', 'secret', 'bankAccount', 'bankCredentials', 'privateKey']);
const norm = (v) => (typeof v === 'number' ? String(v) : Array.isArray(v) ? v.map(norm) : (v && typeof v === 'object' && !(v instanceof Date)) ? Object.keys(v).sort().reduce((o, k) => { o[k] = SENSITIVE.has(k) ? '[REDACTED]' : norm(v[k]); return o; }, {}) : v);
const independentHash = (r) => {
  const payload = {
    sequenceNumber: r.sequenceNumber, action: r.action, actorId: String(r.actorId), actorEmail: r.actorEmail || null, actorRole: r.actorRole || null,
    entityType: r.entityType, entityId: String(r.entityId), previousStatus: r.previousStatus || null, newStatus: r.newStatus || null,
    meta: r.meta || {}, ipAddress: r.ipAddress || null, createdAt: new Date(r.createdAt).toISOString(), previousHash: r.previousHash,
  };
  if (r.companyId) payload.companyId = String(r.companyId);
  return crypto.createHash('sha256').update(JSON.stringify(norm(payload)), 'utf8').digest('hex');
};

/** The whole truth about the chain in one assertion: linear, hash-correct by independent recomputation, and the head agrees. */
async function assertSound(message = '', { expectedRecords = null } = {}) {
  const all = await records();
  if (expectedRecords !== null) assert.equal(all.length, expectedRecords, `${message}: record count`);
  let previous = GENESIS_HASH;
  all.forEach((r, i) => {
    assert.equal(r.sequenceNumber, i + 1, `${message}: sequence ${i + 1}`);
    assert.equal(r.previousHash, previous, `${message}: record ${i + 1} extends its predecessor`);
    assert.equal(r.hash, independentHash(r), `${message}: record ${i + 1} hash matches independently computed canonical bytes`);
    previous = r.hash;
  });
  const verification = await auditService.verifyAuditChain();
  assert.equal(verification.valid, true, `${message}: ${verification.reason}`);
  if (all.length > 0) {
    const head = await auditService.verifyHead();
    assert.equal(head.ok, true, `${message}: head — ${head.reason}`);
  }
  const versions = all.map((r) => r.headVersion).filter((v) => v !== undefined);
  assert.equal(new Set(versions).size, versions.length, `${message}: one record per head transition`);
  return all;
}

async function resetAll({ validator = false } = {}) {
  for (const collection of [AuditLog.collection, AuditChainHead.collection, scratch(), raceScratch(), mongoose.connection.collection('audit_race_barrier')]) await collection.drop().catch(() => {});
  await AuditLog.createIndexes();
  if (validator) await mongoose.connection.db.command({ collMod: 'auditlogs', validator: REQUIRED_VALIDATOR, ...VALIDATION_OPTIONS });
}

/** A chain as it existed BEFORE the head protocol: valid hashes, no head document, no headVersion. */
async function makePreProtocolChain(n) {
  for (let i = 1; i <= n; i += 1) await auditService.logStandalone(params(i));
  await heads().deleteMany({});
  await AuditLog.collection.updateMany({}, { $unset: { headVersion: 1 } });
  await AuditLog.collection.dropIndex('headVersion_unique_transition').catch(() => {});
}

/**
 * Run `body` while the default connection REPORTS different hosts. The driver freezes client.options, so the client is wrapped in a
 * Proxy for the duration; nothing real is mutated and the wrapper is removed afterwards.
 */
async function withReportedHosts(hosts, body) {
  const realClient = mongoose.connection.getClient();
  const reported = new Proxy(realClient, {
    get(target, prop) {
      if (prop === 'options') return { ...target.options, hosts };
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  mongoose.connection.getClient = () => reported;
  try {
    return await body();
  } finally {
    delete mongoose.connection.getClient;
  }
}

const indexStatuses = async () => evaluateIndexes(await AuditLog.collection.indexes()).map((row) => row.status);
let raceCounter = 0;

/**
 * Spawn competing writer processes, release them together through a database barrier, collect their results.
 * `expectIndexStatuses` (optional): the statuses of [sequence, predecessor, headVersion] that the test injected. They are asserted
 * at the moment of release AND after the race, so a writer that rebuilt an index (the workers connect with autoIndex off) fails the test.
 * Roles may set `lane: true` to run a worker with the per-process transaction lane ON (the production configuration).
 */
async function race(roles, { timeoutMs = 90_000, expectIndexStatuses = null, anyRefusalCode = false } = {}) {
  raceCounter += 1;
  const barrierName = `audit_race_barrier_${process.pid}_${raceCounter}`;
  const barrier = mongoose.connection.collection(barrierName);
  await barrier.deleteMany({});
  const children = [];
  const outcomes = roles.map(({ mode, count, lane = false }) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, TEST_DB_URI, String(count), mode], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RACE_BARRIER: barrierName, WORKER_LANE: lane ? '1' : '0' } });
    children.push(child);
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`worker timed out: ${err}`)); }, timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); return code === 0 ? resolve(JSON.parse(out.trim().split('\n').pop())) : reject(new Error(`worker exited ${code}: ${err}`)); });
  }));
  for (const outcome of outcomes) outcome.catch(() => {}); // a failure is reported through Promise.all below; never as an unhandled rejection
  try {
    const deadline = Date.now() + 30_000;
    while ((await barrier.countDocuments({ _id: /^ready-/ })) < roles.length) {
      if (Date.now() > deadline) throw new Error('workers did not become ready');
      await sleep(10);
    }
    if (expectIndexStatuses) assert.deepEqual(await indexStatuses(), expectIndexStatuses, 'the injected index fault holds at the moment the writers are released');
    await barrier.insertOne({ _id: 'go' });
    const results = await Promise.all(outcomes);
    if (expectIndexStatuses) assert.deepEqual(await indexStatuses(), expectIndexStatuses, 'no writer changed the index state during the race');
    const committedOperations = results.reduce((sum, r) => sum + r.committedOperations, 0);
    const refused = results.reduce((sum, r) => sum + r.refused, 0);
    if (!anyRefusalCode) for (const r of results) for (const code of Object.keys(r.refusalCodes)) assert.equal(code, 'AUDIT_CHAIN_CONTENTION', `a refusal must be the explicit bounded one: ${JSON.stringify(r)}`);
    const events = results.flatMap((r) => r.committed);
    const logCalls = results.reduce((sum, r) => sum + r.logCalls, 0);
    return { results, committedOperations, refused, submitted: roles.reduce((sum, r) => sum + r.count, 0), events, logCalls, rolledBackAttempts: logCalls - events.length };
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill(); // a worker left polling for 'go' would fire into the NEXT test's chain
    await barrier.drop().catch(() => {});
  }
}

before(async () => {
  await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 5000 });
  await mongoose.connection.dropDatabase();
});
after(async () => {
  try { if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase(); } finally { await mongoose.disconnect(); }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('A — basic append invariants and the hash format', () => {
  beforeEach(() => resetAll());

  test('the first append on an empty chain (development/test only) creates the genesis head and extends it: sequence 1, predecessor GENESIS, headVersion 2, head {1, hash, version 2}', async () => {
    assert.equal(await headDoc(), null);
    const first = await auditService.logStandalone(params(1));
    assert.equal(first.sequenceNumber, 1);
    assert.equal(first.previousHash, GENESIS_HASH);
    assert.equal(first.headVersion, 2);
    const head = await headDoc();
    assert.deepEqual({ sequence: head.sequence, hash: head.hash, version: head.version, source: head.baseline.source }, { sequence: 1, hash: first.hash, version: 2, source: 'auto-bootstrap-empty' });
    await assertSound('first append', { expectedRecords: 1 });
  });

  test('60 sequential appends: exact sequence progression, every predecessor link, every hash matches INDEPENDENTLY computed canonical bytes, and the head agrees after EVERY append', async () => {
    for (let i = 1; i <= 60; i += 1) {
      const entry = await auditService.logStandalone(params(i));
      assert.equal(entry.sequenceNumber, i);
      const head = await headDoc();
      assert.deepEqual([head.sequence, head.hash, head.version], [i, entry.hash, i + 1], `after append ${i}`);
    }
    await assertSound('sequential', { expectedRecords: 60 });
  });

  test('three events in ONE transaction extend each other (they read the transaction\'s own earlier head advance): consecutive, linked, headVersions 2,3,4; business write committed with them', async () => {
    const events = await runInTransaction(async (session) => {
      await scratch().insertOne({ marker: 'multi' }, { session });
      return [await auditService.log(params(1), session), await auditService.log(params(2), session), await auditService.log(params(3), session)];
    });
    assert.deepEqual(events.map((e) => e.sequenceNumber), [1, 2, 3]);
    assert.equal(events[1].previousHash, events[0].hash);
    assert.equal(events[2].previousHash, events[1].hash);
    assert.deepEqual(events.map((e) => e.headVersion), [2, 3, 4]);
    assert.equal((await headDoc()).version, 4);
    assert.equal(await scratch().countDocuments({ marker: 'multi' }), 1);
    await assertSound('multi-event', { expectedRecords: 3 });
  });

  test('the audit HASH FORMAT is unchanged: a pinned digest for a literal record computed from independently re-implemented canonical bytes, equal to calculateAuditHash; and records produced by the new protocol hash identically', async () => {
    const payload = { sequenceNumber: 7, action: 'VECTOR_ACTION', actorId: '64b7f0c2a1b2c3d4e5f60718', actorEmail: 'vector@example.invalid', actorRole: 'admin', entityType: 'PAYROLL_RUN', entityId: '64b7f0c2a1b2c3d4e5f60719', previousStatus: 'READY', newStatus: 'FINALIZED', meta: { b: 2, a: 1, nested: { z: [3, 2, 1], password: 'secret' } }, ipAddress: '203.0.113.9', createdAt: '2026-01-02T03:04:05.678Z', previousHash: 'a'.repeat(64), companyId: '64b7f0c2a1b2c3d4e5f6071a' };
    const expectedBytes = '{"action":"VECTOR_ACTION","actorEmail":"vector@example.invalid","actorId":"64b7f0c2a1b2c3d4e5f60718","actorRole":"admin","companyId":"64b7f0c2a1b2c3d4e5f6071a","createdAt":"2026-01-02T03:04:05.678Z","entityId":"64b7f0c2a1b2c3d4e5f60719","entityType":"PAYROLL_RUN","ipAddress":"203.0.113.9","meta":{"a":"1","b":"2","nested":{"password":"[REDACTED]","z":["3","2","1"]}},"newStatus":"FINALIZED","previousHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","previousStatus":"READY","sequenceNumber":"7"}';
    assert.equal(JSON.stringify(norm(payload)), expectedBytes);
    // Computed with the service code of commits 2dfddaf (before the hardening), 04c872b and this one: all three give this digest.
    const PINNED = '48512827ed4da88ee65d220055f106ac517db4a1820f9d3bcac41f683428ffcd';
    assert.equal(crypto.createHash('sha256').update(expectedBytes, 'utf8').digest('hex'), PINNED);
    assert.equal(calculateAuditHash(payload), PINNED, 'the service\'s canonicalization still produces the pinned digest');
    const entry = await auditService.logStandalone(params(1, { actorEmail: 'Someone@Example.INVALID', meta: { token: 'x', deep: { b: 1, a: [2, { password: 'p' }] } } }));
    assert.equal(entry.hash, independentHash(entry), 'a record written by the new protocol hashes exactly as the documented canonical form says (headVersion is NOT part of the hash)');
    assert.equal((await AuditLog.collection.findOne({ _id: entry._id })).headVersion, 2, 'and it carries headVersion outside the hash');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('B — competing writers', () => {
  // The chain starts with one record, so the races are about ADVANCING an existing head, not about creating it
  // (the creation race has its own tests in G).
  beforeEach(async () => { await resetAll(); await auditService.logStandalone(params(0)); });
  const SEEDED = 1;
  const OK3 = ['OK', 'OK', 'OK'];

  const assertRace = async (outcome, label) => {
    assert.equal(outcome.committedOperations + outcome.refused, outcome.submitted, `${label}: every operation is a commit or an explicit refusal`);
    assert.ok(outcome.committedOperations > 0, `${label}: progress — ${JSON.stringify(outcome.results)}`);
    const all = await assertSound(label);
    const eventsPerOperation = outcome.events.length / outcome.committedOperations;
    assert.equal(all.length, SEEDED + outcome.events.length, `${label}: exactly the committed events exist (plus the seed record)`);
    assert.deepEqual([...outcome.events].sort((a, b) => a - b), all.slice(SEEDED).map((r) => r.sequenceNumber), `${label}: the sequence numbers the workers were told are exactly the ones persisted, each once (${eventsPerOperation} event(s) per operation)`);
    assert.equal((await headDoc()).version, 1 + all.length, `${label}: one head transition per record`);
  };

  test('two independent processes, audit-only appends, released together from the same head', async () => {
    await assertRace(await race([{ mode: 'standalone', count: 15 }, { mode: 'standalone', count: 15 }], { expectIndexStatuses: OK3 }), 'two processes');
  });

  test('three processes with mixed append types (audit-only, business transaction, three-event finalization shape)', async () => {
    const outcome = await race([{ mode: 'standalone', count: 10 }, { mode: 'txn', count: 10 }, { mode: 'multi3', count: 6 }], { expectIndexStatuses: OK3 });
    await assertRace(outcome, 'mixed');
    assert.equal(await raceScratch().countDocuments({}), outcome.results.filter((r) => r.mode !== 'standalone').reduce((s, r) => s + r.committedOperations, 0), 'every committed business transaction wrote its document exactly once; no refused one did');
  });

  test('high contention: three processes x 25 transactions on one head (the per-process lane is OFF, so every transaction of a process starts at once); attempts were really rolled back', async () => {
    const outcome = await race([{ mode: 'txn', count: 25 }, { mode: 'txn', count: 25 }, { mode: 'txn', count: 25 }], { expectIndexStatuses: OK3 });
    await assertRace(outcome, 'high contention');
    assert.ok(outcome.rolledBackAttempts > 0, `contention is proven, not assumed: ${outcome.logCalls} append attempts for ${outcome.events.length} committed events`);
  });

  test('PRODUCTION CONFIGURATION: three processes, the per-process lane ON in each, released together: every operation commits, none is refused, the chain is linear and the head agrees', async () => {
    const outcome = await race([{ mode: 'standalone', count: 20, lane: true }, { mode: 'txn', count: 20, lane: true }, { mode: 'multi3', count: 10, lane: true }], { expectIndexStatuses: OK3 });
    assert.equal(outcome.refused, 0, `with the lane on, no operation may be refused: ${JSON.stringify(outcome.results.map((r) => [r.mode, r.refusalCodes, r.causes]))}`);
    await assertRace(outcome, 'lane on');
    assert.equal(outcome.committedOperations, 50);
    assert.equal(await raceScratch().countDocuments({}), 30, 'every business transaction wrote its document exactly once');
  });

  // A writer paused between its head read and its head write, while a competitor commits. With a head already in place the
  // conflict arises at the conditional HEAD UPDATE (before any record insert), so it is not something a unique index could mask.
  const pausedWriterScenario = async ({ dropIndexes }) => {
    if (dropIndexes) await AuditLog.collection.dropIndexes();
    let release;
    transactionLane.enabled = false; // two writers of the SAME process must be able to be mid-transaction together, as two processes can
    const gate = new Promise((resolve) => { release = resolve; });
    let paused;
    const waitingAtGate = new Promise((resolve) => { paused = resolve; });
    const original = heads().updateOne;
    let held = false;
    heads().updateOne = async function gatedUpdate(...args) {
      if (!held) { held = true; paused(); await gate; } // the FIRST head advance waits: the head was already read
      return original.apply(this, args);
    };
    let executions = 0;
    try {
      const pausedWriter = runInTransaction(async (session) => { executions += 1; return auditService.log(params(1), session); }, { label: 'paused-writer' });
      await waitingAtGate;
      const competitor = await auditService.logStandalone(params(2)); // commits while the first writer sits between its read and its write
      assert.equal(competitor.sequenceNumber, SEEDED + 1);
      release();
      const resumed = await pausedWriter;
      assert.equal(executions >= 2, true, 'the whole unit of work was re-run from a fresh transaction');
      assert.equal(resumed.sequenceNumber, SEEDED + 2);
      assert.equal(resumed.previousHash, competitor.hash, "it extends the competitor's record, not the head it originally read");
    } finally {
      release(); // never leave the paused writer waiting on its gate if an assertion above failed
      heads().updateOne = original;
      transactionLane.enabled = true;
    }
    if (dropIndexes) assert.deepEqual(await indexStatuses(), ['MISSING', 'MISSING', 'MISSING'], 'no unique index existed during the scenario');
    await assertSound('paused writer', { expectedRecords: SEEDED + 2 });
  };

  test('a writer PAUSED after reading the head while a competitor commits: it conflicts, retries from a fresh head, and links to the competitors record (no fork, no lost event)', () => pausedWriterScenario({ dropIndexes: false }));

  test('the same paused writer with EVERY unique index absent: the conflict can only come from the head document, and it is enough', () => pausedWriterScenario({ dropIndexes: true }));

  test('a head held by an uncommitted transaction makes a competitor fail with the explicit, retryable, bounded 503 and leave nothing behind', async () => {
    const holder = await mongoose.startSession();
    holder.startTransaction();
    await auditService.log(params(1), holder);
    try {
      await assert.rejects(auditService.logStandalone(params(2), { maxAttempts: 3, maxWaitMs: 3000 }), (e) => e.code === 'AUDIT_CHAIN_CONTENTION' && e.statusCode === 503 && e.retryable === true);
    } finally {
      await holder.abortTransaction();
      await holder.endSession();
    }
    assert.equal(await AuditLog.collection.countDocuments({}), SEEDED);
    assert.equal((await headDoc()).version, 1 + SEEDED, 'the head was not advanced by either the refused or the aborted transaction');
    await auditService.logStandalone(params(3));
    await assertSound('after the hold', { expectedRecords: SEEDED + 1 });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('C — index faults: the head protocol keeps the chain linear whatever state the unique indexes are in', () => {
  const lookalike = async (key, name, partialFilterExpression) => {
    await AuditLog.collection.dropIndex(name);
    await AuditLog.collection.createIndex(key, { name, unique: true, partialFilterExpression });
  };
  // [name, setup, the strict-status issue it must raise, the statuses [sequence, predecessor, headVersion] that must hold DURING the race]
  const OK3 = ['OK', 'OK', 'OK'];
  const CONFIGS = [
    ['all three correct, validator set', async () => { await resetAll({ validator: true }); }, null, OK3],
    ['sequenceNumber index absent', async () => { await resetAll(); await AuditLog.collection.dropIndex('sequenceNumber_1'); }, 'INDEX_MISSING', ['MISSING', 'OK', 'OK']],
    ['previousHash index absent', async () => { await resetAll(); await AuditLog.collection.dropIndex('previousHash_unique_successor'); }, 'INDEX_MISSING', ['OK', 'MISSING', 'OK']],
    ['headVersion index absent', async () => { await resetAll(); await AuditLog.collection.dropIndex('headVersion_unique_transition'); }, 'INDEX_MISSING', ['OK', 'OK', 'MISSING']],
    ['ALL unique indexes absent', async () => { await resetAll(); await AuditLog.collection.dropIndexes(); }, 'INDEX_MISSING', ['MISSING', 'MISSING', 'MISSING']],
    ['sequenceNumber: same name, unique, but an INEFFECTIVE partial filter', async () => { await resetAll(); await lookalike({ sequenceNumber: 1 }, 'sequenceNumber_1', { sequenceNumber: { $type: 'string' } }); }, 'INDEX_INCOMPATIBLE', ['INCOMPATIBLE', 'OK', 'OK']],
    ['previousHash: same name, unique, INEFFECTIVE partial filter', async () => { await resetAll(); await lookalike({ previousHash: 1 }, 'previousHash_unique_successor', { previousHash: { $type: 'number' } }); }, 'INDEX_INCOMPATIBLE', ['OK', 'INCOMPATIBLE', 'OK']],
    ['headVersion: same name, unique, INEFFECTIVE partial filter', async () => { await resetAll(); await lookalike({ headVersion: 1 }, 'headVersion_unique_transition', { headVersion: { $type: 'string' } }); }, 'INDEX_INCOMPATIBLE', ['OK', 'OK', 'INCOMPATIBLE']],
    ['all three are look-alikes with ineffective partial filters', async () => {
      await resetAll();
      await lookalike({ sequenceNumber: 1 }, 'sequenceNumber_1', { sequenceNumber: { $type: 'string' } });
      await lookalike({ previousHash: 1 }, 'previousHash_unique_successor', { previousHash: { $type: 'number' } });
      await lookalike({ headVersion: 1 }, 'headVersion_unique_transition', { headVersion: { $type: 'string' } });
    }, 'INDEX_INCOMPATIBLE', ['INCOMPATIBLE', 'INCOMPATIBLE', 'INCOMPATIBLE']],
    ['incompatible options: a collation on sequenceNumber, a NON-unique headVersion index', async () => {
      await resetAll();
      await AuditLog.collection.dropIndex('sequenceNumber_1');
      await AuditLog.collection.createIndex({ sequenceNumber: 1 }, { name: 'sequenceNumber_1', unique: true, collation: { locale: 'en' } });
      await AuditLog.collection.dropIndex('headVersion_unique_transition');
      await AuditLog.collection.createIndex({ headVersion: 1 }, { name: 'headVersion_unique_transition', partialFilterExpression: { headVersion: { $type: 'number' } } });
    }, 'INDEX_INCOMPATIBLE', ['INCOMPATIBLE', 'OK', 'INCOMPATIBLE']],
  ];

  for (const [name, setup, expectedIssue, expectedStatuses] of CONFIGS) {
    test(`${name}: a barriered race of three processes (indexes held as injected) never forks, the head agrees, and strict status says ${expectedIssue ?? 'OK'}`, async () => {
      await setup();
      assert.deepEqual(await indexStatuses(), expectedStatuses, 'the configuration was injected as intended');
      const before = auditService._modeOverride;
      auditService._modeOverride = 'strict';
      try {
        const status = await auditService.protocolStatus({ checkBuilds: false });
        if (expectedIssue === null) {
          assert.deepEqual(status.issues.filter((i) => i.severity === 'error').map((i) => i.code).filter((c) => c !== 'HEAD_MISSING'), [], 'a correctly configured collection raises no index or validator error');
        } else {
          assert.ok(status.issues.some((i) => i.severity === 'error' && i.code === expectedIssue), `expected ${expectedIssue}, got ${JSON.stringify(status.issues)}`);
          assert.equal(status.ok, false);
        }
      } finally {
        auditService._modeOverride = before;
      }
      const outcome = await race([{ mode: 'standalone', count: 12 }, { mode: 'standalone', count: 12 }, { mode: 'txn', count: 12 }], { expectIndexStatuses: expectedStatuses });
      assert.equal(outcome.committedOperations + outcome.refused, outcome.submitted);
      assert.ok(outcome.committedOperations > 0, `no operation committed: ${JSON.stringify(outcome.results)}`);
      const all = await assertSound(name);
      assert.equal(all.length, outcome.events.length);
      assert.equal(new Set(all.map((r) => r.previousHash)).size, all.length, 'no predecessor has two successors');
    });
  }

  test('POSITIVE CONTROL: the harness CAN see a fork. Writers that append the pre-head way (read the newest record, insert sequence+1) fork the chain when every unique index is absent, and cannot when the sequenceNumber index is present; the head protocol (the matrix above) does not fork in either state', async () => {
    const duplicates = async () => {
      const bySequence = new Map();
      for (const record of await records()) bySequence.set(record.sequenceNumber, (bySequence.get(record.sequenceNumber) ?? 0) + 1);
      return [...bySequence.entries()].filter(([, n]) => n > 1).length;
    };
    const roles = [{ mode: 'oldstyle', count: 8 }, { mode: 'oldstyle', count: 8 }, { mode: 'oldstyle', count: 8 }];
    await resetAll();
    await AuditLog.collection.dropIndexes();
    await race(roles, { expectIndexStatuses: ['MISSING', 'MISSING', 'MISSING'], anyRefusalCode: true });
    const forkedPositions = await duplicates();
    assert.ok(forkedPositions > 0, 'with every unique index absent the pre-head algorithm took the same position more than once: the harness really runs without indexes and really detects forks');
    await resetAll();
    await race(roles, { expectIndexStatuses: ['OK', 'OK', 'OK'], anyRefusalCode: true });
    assert.equal(await duplicates(), 0, 'with the unique indexes present the same writers cannot take a position twice');
  });

  test('the three evaluators agree on what is effective: only the exact specification is OK', async () => {
    await resetAll();
    assert.deepEqual(evaluateIndexes(await AuditLog.collection.indexes()).map((r) => r.status), ['OK', 'OK', 'OK']);
    await lookalike({ previousHash: 1 }, 'previousHash_unique_successor', { previousHash: { $type: 'number' } });
    assert.deepEqual(evaluateIndexes(await AuditLog.collection.indexes()).map((r) => r.status), ['OK', 'INCOMPATIBLE', 'OK']);
  });

  test('a REAL index build in progress on the audit collection: protocolStatus is NEVER healthy while it runs (it reports the build as an error, or the status read itself fails closed); best effort, needs the $currentOp privilege, skipped with the reason when the database user lacks it', async (t) => {
    await resetAll();
    if ((await auditService.indexBuildState()).state === 'UNAVAILABLE') { t.skip('the database user cannot run $currentOp (inprog): running index builds are unobservable here'); return; }
    // filler documents with distinct (huge) sequence numbers so they satisfy the unique indexes; removed again below
    for (let batch = 0; batch < 60; batch += 1) {
      await AuditLog.collection.insertMany(Array.from({ length: 5000 }, (_, i) => ({ sequenceNumber: 1e9 + batch * 5000 + i, x: `${batch}-${i}-${'y'.repeat(60)}`, filler: true, createdAt: new Date() })), { ordered: false });
    }
    let buildDone = false;
    const build = AuditLog.collection.createIndex({ x: 1 }, { name: 'x_build_probe' }).finally(() => { buildDone = true; });
    // Sample the readiness status for as long as the build runs. A status read that needs the collection lock can itself time out
    // while the build commits (a 5 ms lock timeout inside a transaction): that is "not ready", the safe answer. The property is that
    // the status is NEVER healthy while a build is running.
    const samples = { runningError: 0, failedClosed: 0, healthyWhileRunning: 0, other: 0 };
    while (!buildDone) {
      try {
        const status = await auditService.protocolStatus({ checkBuilds: true });
        if (status.build.state === 'RUNNING' && status.ok) samples.healthyWhileRunning += 1;
        else if (status.issues.some((issue) => issue.code === 'INDEX_BUILD_RUNNING' && issue.severity === 'error') && !status.ok) samples.runningError += 1;
        else samples.other += 1;
      } catch {
        samples.failedClosed += 1;
      }
      await sleep(1);
    }
    await build;
    assert.equal(samples.healthyWhileRunning, 0, JSON.stringify(samples));
    assert.ok(samples.runningError + samples.failedClosed > 0, `the build was noticed by the status (as an error) or made it fail closed: ${JSON.stringify(samples)}`);
    assert.equal((await auditService.indexBuildState()).state, 'NONE', 'and the build state is clear once it finished');
    await AuditLog.collection.deleteMany({ filler: true });
  });

  test('protocolStatus turns a RUNNING index build into an ERROR, an unobservable one into a WARNING, and does not ask when told not to (SIMULATED $currentOp answers)', async () => {
    await resetAll();
    await auditService.logStandalone(params(1));
    const original = auditService.indexBuildState;
    let asked = 0;
    const answer = (state, detail = null) => { auditService.indexBuildState = async () => { asked += 1; return { state, detail }; }; };
    const buildIssues = (status) => status.issues.filter((i) => /INDEX_BUILD/.test(i.code)).map((i) => [i.code, i.severity]);
    try {
      answer('NONE');
      let status = await auditService.protocolStatus();
      assert.deepEqual(buildIssues(status), []);
      assert.equal(status.ok, true);
      answer('RUNNING');
      status = await auditService.protocolStatus();
      assert.deepEqual(buildIssues(status), [['INDEX_BUILD_RUNNING', 'error']]);
      assert.equal(status.ok, false, 'a running build means an index may not be enforcing yet');
      answer('UNAVAILABLE', 'not authorized on admin');
      status = await auditService.protocolStatus();
      assert.deepEqual(buildIssues(status), [['INDEX_BUILD_UNOBSERVABLE', 'warning']]);
      assert.equal(status.ok, true, 'an unobservable build is reported as a warning, never silently as "no build"');
      asked = 0;
      answer('RUNNING');
      status = await auditService.protocolStatus({ checkBuilds: false });
      assert.equal(asked, 0, 'the build question was not asked');
      assert.equal(status.build.state, 'SKIPPED');
      assert.deepEqual(buildIssues(status), []);
    } finally {
      auditService.indexBuildState = original;
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('D — transaction rollback and commit-outcome injection', () => {
  beforeEach(async () => { await resetAll(); await auditService.logStandalone(params(0)); });

  const state = async () => ({ records: await records(), head: await headDoc(), scratch: await scratch().find({}).toArray() });
  const businessAndAudit = (events = 1) => async (session) => {
    await scratch().insertOne({ marker: 'business' }, { session });
    for (let k = 1; k <= events; k += 1) await auditService.log(params(k), session);
  };
  const patched = async (object, name, replacement, body) => {
    const original = object[name];
    object[name] = replacement(original);
    try { return await body(); } finally { object[name] = original; }
  };
  // `body` is a FUNCTION: the transaction must start only after the before-state is read. Passing an already-running promise
  // let an early rejection go unhandled while that read was in progress (an intermittent failure, found 2026-11-09).
  const unchangedAfter = async (body, matcher = /injected/) => {
    const before = await state();
    await assert.rejects(body, matcher);
    assert.deepEqual(await state(), before, 'a known abort leaves no record, no head advance and no business write');
    await assertSound('after abort');
  };

  test('failure BEFORE the head update (SIMULATED: an exception injected at the head update call)', async () => {
    await patched(heads(), 'updateOne', () => async () => { throw new Error('injected before head update'); },
      () => unchangedAfter(() => runInTransaction(businessAndAudit(1), { label: 'd1' })));
  });

  test('failure AFTER the head update but BEFORE the audit insertion (SIMULATED: an exception injected at the insert)', async () => {
    await patched(AuditLog.prototype, 'save', () => async function injected() { throw new Error('injected at insertion'); },
      () => unchangedAfter(() => runInTransaction(businessAndAudit(1), { label: 'd2' })));
  });

  test('failure AFTER the audit write but before commit (the callback throws; real abort, real rollback)', async () => {
    await unchangedAfter(() => runInTransaction(async (session) => { await businessAndAudit(1)(session); throw new Error('injected after the audit write'); }, { label: 'd3' }));
  });

  test('failure at the 2nd and then at the 3rd event of a three-event transaction: everything, including the earlier events and the head advance, is rolled back', async () => {
    for (const failAt of [2, 3]) {
      await unchangedAfter(() => runInTransaction(async (session) => {
        await scratch().insertOne({ marker: 'business' }, { session });
        for (let k = 1; k <= 3; k += 1) {
          if (k === failAt) throw new Error(`injected at event ${k}`);
          await auditService.log(params(k), session);
        }
      }, { label: `d4-${failAt}` }));
    }
  });

  test('a transient transaction failure after the audit write is retried from a fresh head: the whole unit re-runs, committed exactly once, head advanced exactly once', async () => {
    let executions = 0;
    const before = await headDoc();
    await runInTransaction(async (session) => {
      executions += 1;
      await businessAndAudit(1)(session);
      if (executions === 1) throw Object.assign(new Error('injected transient failure'), { errorLabels: new Set(['TransientTransactionError']) });
    }, { label: 'd5' });
    assert.equal(executions, 2);
    assert.equal((await headDoc()).version, before.version + 1);
    assert.equal(await scratch().countDocuments({ marker: 'business' }), 1);
    await assertSound('after retry', { expectedRecords: 2 });
  });

  // ── commit outcome (SIMULATED: the commit is really applied by the server, then an error is raised to the caller) ──
  const withAmbiguousCommit = (failures) => async (body) => {
    const originalStart = mongoose.startSession.bind(mongoose);
    let calls = 0;
    mongoose.startSession = async (...args) => {
      const session = await originalStart(...args);
      const commit = session.commitTransaction.bind(session);
      session.commitTransaction = async () => {
        calls += 1;
        await commit(); // the server applies the commit...
        if (calls <= failures) throw Object.assign(new Error('simulated: the commit reply was lost'), { errorLabels: new Set(['UnknownTransactionCommitResult']) }); // ...but the caller is told it is unknown
      };
      return session;
    };
    try { return await body(() => calls); } finally { mongoose.startSession = originalStart; }
  };

  test('commit outcome unknown (SIMULATED), resolved by the commit retry: committed exactly once, the callback ran once, head advanced once', async () => {
    let executions = 0;
    await withAmbiguousCommit(2)(async (calls) => {
      await runInTransaction(async (session) => { executions += 1; await businessAndAudit(1)(session); }, { label: 'd6' });
      assert.equal(calls(), 3, 'the commit (not the callback) was re-sent');
    });
    assert.equal(executions, 1, 'an unknown commit result never re-runs the unit of work');
    assert.equal(await scratch().countDocuments({ marker: 'business' }), 1);
    await assertSound('after ambiguous commit', { expectedRecords: 2 });
  });

  test('commit outcome unknown on EVERY send (SIMULATED): the caller gets 503 COMMIT_OUTCOME_UNKNOWN, which does NOT claim the transaction rolled back, and the database shows it committed exactly once', async () => {
    let executions = 0;
    await withAmbiguousCommit(99)(async () => {
      await assert.rejects(runInTransaction(async (session) => { executions += 1; await businessAndAudit(1)(session); }, { label: 'd7' }), (e) => e.code === 'COMMIT_OUTCOME_UNKNOWN' && e.statusCode === 503 && e.retryable === false && /commit reply was lost/.test(e.cause?.message) && !/nothing was written/i.test(e.message));
    });
    assert.equal(executions, 1);
    assert.equal(await scratch().countDocuments({ marker: 'business' }), 1, 'it did commit');
    await assertSound('after unresolved ambiguity', { expectedRecords: 2 });
  });

  // ── the remaining steps of the injection matrix: the very first step, a stale conditional update, and a DEFINITE failure during commit ──
  test('failure while READING the head (the first step of an append): the business write made earlier in the same transaction rolls back; no record, no head change', async () => {
    const before = await state();
    await patched(heads(), 'findOne', () => async () => { throw new Error('injected at head read'); },
      () => assert.rejects(runInTransaction(businessAndAudit(1), { label: 'd8' }), /injected at head read/));
    assert.deepEqual(await state(), before);
    await assertSound('after the failed head read');
  });

  test('a conditional head update that matches NOTHING (SIMULATED stale match) is a lost race: that attempt writes no record, and the unit re-runs from a fresh head and commits exactly once', async () => {
    let executions = 0;
    let updates = 0;
    const before = await headDoc();
    await patched(heads(), 'updateOne', (original) => async function staleOnce(...args) {
      updates += 1;
      if (updates === 1) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null }; // as if the head had changed under this transaction
      return original.apply(this, args);
    }, () => runInTransaction(async (session) => { executions += 1; await businessAndAudit(1)(session); }, { label: 'd10' }));
    assert.equal(executions, 2, 'the unit re-ran after the stale attempt');
    assert.equal((await headDoc()).version, before.version + 1, 'the head advanced exactly once');
    assert.equal(await scratch().countDocuments({ marker: 'business' }), 1);
    await assertSound('after the stale match', { expectedRecords: 2 });
  });

  const withFailingCommit = (decide) => async (body) => {
    const originalStart = mongoose.startSession.bind(mongoose);
    let calls = 0;
    mongoose.startSession = async (...args) => {
      const session = await originalStart(...args);
      const commit = session.commitTransaction.bind(session);
      session.commitTransaction = async () => {
        calls += 1;
        const failure = decide(calls);
        if (failure) { await session.abortTransaction(); throw failure; } // the server rolled the transaction back, then the caller is told so
        return commit();
      };
      return session;
    };
    try { return await body(() => calls); } finally { mongoose.startSession = originalStart; }
  };

  test('a DEFINITE, non-retryable failure during commit (SIMULATED: aborted, then reported): nothing is committed, the error is surfaced, the head is unchanged', async () => {
    const before = await state();
    await withFailingCommit(() => new Error('injected: the commit failed and the transaction was aborted'))(async () => {
      await assert.rejects(runInTransaction(businessAndAudit(2), { label: 'd9' }), /injected: the commit failed/);
    });
    assert.deepEqual(await state(), before);
    await assertSound('after the failed commit');
  });

  test('a DEFINITE, retryable failure during commit (SIMULATED: aborted + TransientTransactionError) re-runs the whole unit once and commits exactly once', async () => {
    let executions = 0;
    const before = await headDoc();
    await withFailingCommit((call) => (call === 1 ? Object.assign(new Error('injected transient commit failure'), { errorLabels: new Set(['TransientTransactionError']) }) : null))(async (calls) => {
      await runInTransaction(async (session) => { executions += 1; await businessAndAudit(1)(session); }, { label: 'd11' });
      assert.equal(calls(), 2);
    });
    assert.equal(executions, 2);
    assert.equal((await headDoc()).version, before.version + 1);
    assert.equal(await scratch().countDocuments({ marker: 'business' }), 1);
    await assertSound('after the retried commit', { expectedRecords: 2 });
  });

  test('commit outcome unknown and the commit NEVER reached the server (SIMULATED): nothing is committed; the caller gets COMMIT_OUTCOME_UNKNOWN, which claims neither a commit nor a rollback', async () => {
    const before = await state();
    const originalStart = mongoose.startSession.bind(mongoose);
    let sends = 0;
    mongoose.startSession = async (...args) => {
      const session = await originalStart(...args);
      session.commitTransaction = async () => { sends += 1; throw Object.assign(new Error('simulated: the commit message was lost before it reached the server'), { errorLabels: new Set(['UnknownTransactionCommitResult']) }); };
      return session;
    };
    try {
      await assert.rejects(runInTransaction(businessAndAudit(1), { label: 'd12' }), (e) => e.code === 'COMMIT_OUTCOME_UNKNOWN' && /commit message was lost/.test(e.cause?.message) && !/nothing was written/i.test(e.message));
    } finally {
      mongoose.startSession = originalStart;
    }
    assert.equal(sends, 5, 'the commit (not the callback) was re-sent up to its limit');
    assert.deepEqual(await state(), before, 'and the database shows it was NOT committed: the unit was never applied');
    await assertSound('after the lost commit');
  });

  test('PROCESS CRASH (a real SIGKILL) after the head advance and the record insert but before the commit: nothing persists, the head did not move, and audited writes resume once the server discards the orphaned transaction (the stall is measured and reported)', async (t) => {
    const admin = mongoose.connection.getClient().db('admin');
    const previousLimit = (await admin.command({ getParameter: 1, transactionLifetimeLimitSeconds: 1 })).transactionLifetimeLimitSeconds;
    await admin.command({ setParameter: 1, transactionLifetimeLimitSeconds: 3 }); // restored below; a disposable local test server
    const before = await state();
    const barrierName = `audit_race_barrier_crash_${process.pid}`;
    const barrier = mongoose.connection.collection(barrierName);
    const child = spawn(process.execPath, [WORKER, TEST_DB_URI, '1', 'hold'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RACE_BARRIER: barrierName, WORKER_LANE: '0' } });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    let recoveredAfterMs = null;
    try {
      const deadline = Date.now() + 30_000;
      while (!(await barrier.findOne({ _id: /^held-/ }))) {
        if (Date.now() > deadline) throw new Error(`the worker never reached the commit point: ${stderr}`);
        await sleep(20);
      }
      const closed = new Promise((resolve) => { child.once('close', resolve); });
      child.kill('SIGKILL');
      await closed;
      const killedAt = Date.now();
      assert.deepEqual(await state(), before, 'the crashed process committed nothing and moved nothing');
      while (Date.now() - killedAt < 40_000 && recoveredAfterMs === null) {
        try {
          await auditService.logStandalone(params(1), { maxAttempts: 3, maxWaitMs: 2000 });
          recoveredAfterMs = Date.now() - killedAt;
        } catch (error) {
          assert.equal(error.code, 'AUDIT_CHAIN_CONTENTION', `while the orphaned transaction lives only the bounded refusal is acceptable, got ${error.code}: ${error.message}`);
        }
      }
    } finally {
      child.kill();
      await barrier.drop().catch(() => {});
      await admin.command({ setParameter: 1, transactionLifetimeLimitSeconds: previousLimit });
    }
    assert.notEqual(recoveredAfterMs, null, 'audited writes resumed after the server discarded the orphaned transaction');
    t.diagnostic(`audited writes resumed ${recoveredAfterMs} ms after the crash (transactionLifetimeLimitSeconds was 3, default ${previousLimit})`);
    assert.equal(await scratch().countDocuments({ held: true }), 0, 'the crashed unit left no business write');
    await assertSound('after the crash and the recovery', { expectedRecords: 2 });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('E — session semantics and a census of every audit writer', () => {
  beforeEach(async () => { await resetAll(); await auditService.logStandalone(params(0)); });

  test('a missing session is refused (AUDIT_SESSION_REQUIRED) and nothing is written: there is no silent independent commit', async () => {
    const before = [await records(), await headDoc()];
    await assert.rejects(auditService.log(params(1)), (e) => e.code === 'AUDIT_SESSION_REQUIRED' && e.statusCode === 500);
    await assert.rejects(auditService.log(params(1), undefined), (e) => e.code === 'AUDIT_SESSION_REQUIRED');
    assert.deepEqual([await records(), await headDoc()], before);
  });

  test('a session with NO active transaction (never started, committed, aborted, ended) is refused and nothing is written', async () => {
    const before = [await records(), await headDoc()];
    const plain = await mongoose.startSession();
    await assert.rejects(auditService.log(params(1), plain), (e) => e.code === 'AUDIT_SESSION_REQUIRED' && /no active transaction/.test(e.message));
    plain.startTransaction(); await auditService.log(params(2), plain); await plain.commitTransaction();
    await assert.rejects(auditService.log(params(3), plain), (e) => e.code === 'AUDIT_SESSION_REQUIRED', 'after commit');
    plain.startTransaction(); await plain.abortTransaction();
    await assert.rejects(auditService.log(params(4), plain), (e) => e.code === 'AUDIT_SESSION_REQUIRED', 'after abort');
    await plain.endSession();
    await assert.rejects(auditService.log(params(5), plain), (e) => e.code === 'AUDIT_SESSION_REQUIRED', 'after the session ended');
    assert.equal((await records()).length, before[0].length + 1, 'only the one properly transacted event exists');
    await assertSound('session misuse');
  });

  test('logStandalone inside a transaction callback is refused (AUDIT_NESTED_TRANSACTION): it would be a second, independent transaction; the outer transaction is unaffected', async () => {
    const before = [await records(), await headDoc()];
    await assert.rejects(runInTransaction(async (session) => {
      await scratch().insertOne({ marker: 'outer' }, { session });
      await auditService.logStandalone(params(1));
    }, { label: 'e-nested' }), (e) => e.code === 'AUDIT_NESTED_TRANSACTION' && /logStandalone was called inside a transaction callback/.test(e.message), 'refused at the FIRST line of defence (logStandalone itself), not only by the second one (the nested-transaction check inside log)');
    assert.deepEqual([await records(), await headDoc()], before);
    assert.equal(await scratch().countDocuments({ marker: 'outer' }), 0, 'the outer business write rolled back with the refusal');
  });

  test('an outer business transaction that aborts AFTER the audit append leaves neither the record nor a head advance; a business failure after two events rolls back both', async () => {
    const before = [await records(), await headDoc()];
    await assert.rejects(runInTransaction(async (session) => {
      await scratch().insertOne({ marker: 'outer' }, { session });
      await auditService.log(params(1), session);
      await auditService.log(params(2), session);
      throw Object.assign(new Error('business failure'), { statusCode: 500 });
    }, { label: 'e-abort' }), /business failure/);
    assert.deepEqual([await records(), await headDoc()], before);
    assert.equal(await scratch().countDocuments({}), 0);
  });

  test('an audit insertion that fails after a business write in the same session rolls the business write back too', async () => {
    const original = AuditLog.prototype.save;
    AuditLog.prototype.save = async function failing() { throw new Error('injected audit insertion failure'); };
    try {
      await assert.rejects(runInTransaction(async (session) => { await scratch().insertOne({ marker: 'business' }, { session }); await auditService.log(params(1), session); }, { label: 'e-insert' }), /injected audit insertion failure/);
    } finally {
      AuditLog.prototype.save = original;
    }
    assert.equal(await scratch().countDocuments({}), 0);
    await assertSound('after failed insertion');
  });

  // ── static census: a TRIPWIRE, not a proof ──
  // It inventories every production file that touches the audit machinery. A new file, a new call site, a new write API in a trusted
  // writer or a new way of reaching auditService FAILS a test below until a human has reviewed it and updated the table. The real
  // enforcement is at run time (AUDIT_SESSION_REQUIRED, AUDIT_NESTED_TRANSACTION, the validator); this only makes drift visible.
  // Limits, stated: it is regex based, not an AST (a "/*" inside a string literal can hide code from it), and it cannot see code that
  // is generated or loaded dynamically from outside these directories.
  const walk = (dir, out = []) => {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'node_modules') continue;
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p, out); else if (/\.(js|mjs)$/.test(name)) out.push(p);
    }
    return out;
  };
  const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const callArguments = (source, start) => { // the text between the parentheses of the call whose '(' precedes `start`
    let depth = 1; let i = start; let quote = null;
    for (; i < source.length && depth > 0; i += 1) {
      const c = source[i];
      if (quote) { if (c === '\\') i += 1; else if (c === quote) quote = null; continue; }
      if (c === '\'' || c === '"' || c === '`') quote = c; else if (c === '(') depth += 1; else if (c === ')') depth -= 1;
    }
    return source.slice(start, i - 1);
  };
  const splitTopLevel = (args) => {
    const parts = []; let depth = 0; let quote = null; let last = 0;
    for (let i = 0; i < args.length; i += 1) {
      const c = args[i];
      if (quote) { if (c === '\\') i += 1; else if (c === quote) quote = null; continue; }
      if (c === '\'' || c === '"' || c === '`') quote = c; else if ('({['.includes(c)) depth += 1; else if (')}]'.includes(c)) depth -= 1;
      else if (c === ',' && depth === 0) { parts.push(args.slice(last, i).trim()); last = i + 1; }
    }
    parts.push(args.slice(last).trim());
    return parts;
  };
  const productionFiles = () => [...walk(path.join(BACKEND, 'src')), ...walk(path.join(BACKEND, 'scripts')), path.join(BACKEND, 'server.js')]
    .map((file) => ({ rel: path.relative(BACKEND, file).split(path.sep).join('/'), source: strip(fs.readFileSync(file, 'utf8')) }));
  const line = (source, index) => source.slice(0, index).split('\n').length;

  // The reviewed inventory. [log calls, logStandalone calls] per file; files that only call other members are listed with [0, 0].
  const AUDIT_TOUCHING_FILES = {
    'server.js': [0, 0],
    'scripts/audit-chain-head.mjs': [0, 0],
    'scripts/audit-chain-legacy-backfill.mjs': [0, 0],
    'scripts/lib/snapshotReconciliation.mjs': [0, 0],
    'scripts/migrate.js': [0, 0],
    'src/app.js': [0, 0],
    'src/controllers/auditController.js': [0, 0],
    'src/controllers/authController.js': [4, 0],
    'src/controllers/employeeAccountController.js': [2, 0],
    'src/controllers/employeeController.js': [4, 0],
    'src/models/AuditChainHead.js': [0, 0],
    'src/models/AuditLog.js': [0, 0],
    'src/services/auditChainHeadService.js': [0, 0],
    'src/services/auditChainSpec.js': [0, 0],
    'src/services/auditService.js': [0, 0],
    'src/services/bankAccountService.js': [1, 1],
    'src/services/companyService.js': [3, 0],
    'src/services/compensationChangeService.js': [2, 0],
    'src/services/compensationComponentService.js': [1, 0],
    'src/services/compensationService.js': [2, 0],
    'src/services/employeeDocumentService.js': [2, 0],
    'src/services/employeeScope.js': [0, 1],
    'src/services/employmentService.js': [1, 0],
    'src/services/payrollFinalizationService.js': [0, 0],
    'src/services/payrollSnapshotRecoveryService.js': [0, 0],
    'src/services/payrollRunService.js': [8, 0],
    'src/services/payrollSnapshotService.js': [4, 0],
    'src/services/statutoryProfileService.js': [1, 1],
    'src/utils/auditErrors.js': [0, 0],
  };
  const TOUCHES_AUDIT = /\bauditService\b|\bAuditLog\b|\bAuditChainHead\b|auditlogs|auditchainheads/;
  // Files that may name the audit models / collections themselves (everyone else reaches the chain only through auditService).
  const DIRECT_REFERENCES = {
    'src/models/AuditLog.js': 'the model',
    'src/models/AuditChainHead.js': 'the head model: owns the collection name, refuses the Mongoose update API',
    'src/services/auditService.js': 'the only appender (head protocol) and the explicit legacy backfill',
    'src/services/auditChainHeadService.js': 'the explicit initialization: creates the collection, indexes, validator and the head',
    'src/services/auditChainSpec.js': 'the specification (pure functions and constants)',
    'src/utils/auditErrors.js': 'error vocabulary (names only)',
    'scripts/lib/snapshotReconciliation.mjs': 'read-only reconciliation (Phase 0 removed its write capability)',
    'src/services/payrollSnapshotRecoveryService.js': 'read-only inspection of finalization evidence; apply is disabled',
    'scripts/migrate.js': 'explicit operator migration: builds the schema-declared indexes (additive); never drops or repairs the audit indexes',
  };
  const WRITE_API = /\b(insertOne|insertMany|bulkWrite|updateOne|updateMany|replaceOne|deleteOne|deleteMany|findOneAndUpdate|findOneAndReplace|findOneAndDelete|createIndex|createIndexes|dropIndex|dropIndexes|createCollection|collMod|drop)\b|\.(create|save)\(|new AuditLog\(/g;
  // The write-capable operations of the trusted writers, counted. A change means a new write path exists: review it, then update the pin.
  const PINNED_WRITE_TOKENS = { 'src/services/auditService.js': 9, 'src/services/auditChainHeadService.js': 5 };
  const ALLOWED_MEMBERS = new Set(['log', 'logStandalone', 'list', 'getEntityHistory', 'getEntityHistoryPage', 'verifyAuditChain', 'verifyHead', 'protocolStatus', 'protocolMode', 'databaseShape', 'chainGuardStatus', 'indexBuildState', 'legacyChainStatus', 'planLegacyBackfill', 'applyLegacyBackfill', '_modeOverride']);
  const GENERIC_COLLECTION_WRITERS = { 'scripts/copy-database.mjs': 'clones a whole database; loads documents before it applies validators' };

  test('CENSUS 1 — the set of production files that touch the audit machinery is exactly the reviewed inventory', () => {
    const touching = productionFiles().filter((f) => TOUCHES_AUDIT.test(f.source)).map((f) => f.rel).sort();
    assert.deepEqual(touching, Object.keys(AUDIT_TOUCHING_FILES).sort(), 'a file started (or stopped) touching the audit chain: review it and update the inventory');
  });

  test('CENSUS 2 — auditService is only ever reached as auditService.<reviewed member>: no alias, no destructuring, no optional chaining, no bracket access, no named or dynamic import', () => {
    const problems = [];
    for (const { rel, source } of productionFiles()) {
      if (rel === 'src/services/auditService.js' || !/\bauditService\b/.test(source)) continue;
      const imports = [...source.matchAll(/^import\s+([^;]*?)\s+from\s+'[^']*auditService\.js'\s*;?/gm)];
      for (const m of imports) {
        const clause = m[1].trim();
        if (clause === 'auditService') continue;
        const named = /^auditService\s*,\s*\{([^}]*)\}$/.exec(clause)?.[1];
        const onlyNamed = /^\{([^}]*)\}$/.exec(clause)?.[1];
        const names = (named ?? onlyNamed ?? '').split(',').map((n) => n.trim()).filter(Boolean);
        if (!named && !onlyNamed) problems.push(`${rel}: import clause "${clause}" (an alias?)`);
        for (const n of names) if (!['GENESIS_HASH', 'canonicalize', 'calculateAuditHash'].includes(n)) problems.push(`${rel}: named import ${n}`);
      }
      const scan = source.replace(/^import\s+[^;]*auditService\.js'\s*;?/gm, '');
      for (const m of scan.matchAll(/\bauditService\b/g)) {
        const after = scan.slice(m.index + m[0].length);
        const member = /^\.\s*(\w+)/.exec(after)?.[1];
        if (!member || !ALLOWED_MEMBERS.has(member)) problems.push(`${rel}:${line(scan, m.index)} uses auditService in a form the census does not understand (${JSON.stringify(after.slice(0, 24))})`);
      }
      if (/import\s*\([^)]*auditService/.test(source)) problems.push(`${rel}: dynamic import of auditService`);
    }
    assert.deepEqual(problems, []);
  });

  test('CENSUS 3 — every auditService.log( call passes the literal identifier `session` as its second argument, and the per-file number of log and logStandalone calls equals the reviewed inventory', () => {
    const problems = [];
    let logTotal = 0; let standaloneTotal = 0;
    for (const { rel, source } of productionFiles()) {
      let logs = 0; let standalone = 0;
      for (const m of source.matchAll(/\bauditService\s*\.\s*log\s*\(/g)) {
        logs += 1;
        const parts = splitTopLevel(callArguments(source, m.index + m[0].length));
        if (parts[1] !== 'session') problems.push(`${rel}:${line(source, m.index)} auditService.log(...) second argument is ${JSON.stringify(parts[1] ?? null)}, not session`);
      }
      standalone += [...source.matchAll(/\bauditService\s*\.\s*logStandalone\s*\(/g)].length;
      logTotal += logs; standaloneTotal += standalone;
      if (AUDIT_TOUCHING_FILES[rel] && (AUDIT_TOUCHING_FILES[rel][0] !== logs || AUDIT_TOUCHING_FILES[rel][1] !== standalone)) problems.push(`${rel}: ${logs} log / ${standalone} logStandalone calls, inventory says ${AUDIT_TOUCHING_FILES[rel].join(' / ')}`);
    }
    assert.deepEqual(problems, []);
    assert.equal(logTotal, 35, 'auditService.log call sites');
    assert.equal(standaloneTotal, 3, 'exactly the three reviewed audit-only call sites use logStandalone');
  });

  test('CENSUS 4 — only the reviewed files name the audit models or collections, and the trusted writers keep exactly their reviewed number of write-capable operations', () => {
    const direct = []; const pins = [];
    for (const { rel, source } of productionFiles()) {
      if (/\b(AuditLog|AuditChainHead)\b|auditlogs|auditchainheads|models\.AuditLog|model\(\s*['"]AuditLog/.test(source)) direct.push(rel);
      if (PINNED_WRITE_TOKENS[rel] !== undefined) {
        const count = [...source.matchAll(WRITE_API)].length;
        if (count !== PINNED_WRITE_TOKENS[rel]) pins.push(`${rel}: ${count} write-capable operations, reviewed ${PINNED_WRITE_TOKENS[rel]}`);
      }
    }
    assert.deepEqual(direct.sort(), Object.keys(DIRECT_REFERENCES).sort(), 'a new file names the audit models or collections directly');
    assert.deepEqual(pins, []);
  });

  test('CENSUS 5 — code that opens collections by a computed name (a generic copier or restorer) and writes to them is exactly the reviewed list', () => {
    const found = [];
    for (const { rel, source } of productionFiles()) {
      const computed = [...source.matchAll(/\.collection\(\s*([^)]*)\)/g)].some((m) => !/^['"`]/.test(m[1].trim()));
      if (computed && /\b(insertOne|insertMany|bulkWrite|updateMany|replaceOne)\b/.test(source)) found.push(rel);
    }
    assert.deepEqual(found.sort(), Object.keys(GENERIC_COLLECTION_WRITERS).sort());
  });

  test('CENSUS 6 — logStandalone is never called lexically inside a runInTransaction callback (it would be a second, independent transaction; at run time it throws AUDIT_NESTED_TRANSACTION)', () => {
    const problems = [];
    for (const { rel, source } of productionFiles()) {
      for (const m of source.matchAll(/\brunInTransaction\s*\(/g)) {
        const body = callArguments(source, m.index + m[0].length);
        if (/\blogStandalone\s*\(/.test(body)) problems.push(`${rel}:${line(source, m.index)}`);
      }
    }
    assert.deepEqual(problems, []);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('E2 — a transaction callback that is re-run must not apply an outer-scope effect twice (the head protocol makes re-runs more likely)', () => {
  beforeEach(async () => { await resetAll(); await auditService.logStandalone(params(0)); });

  test('compensationChangeService.activateDue counts only what COMMITTED: a transient failure at the first commit re-runs that callback, yet the returned count, the documents and the audit events are each exact', async () => {
    const { default: CompensationChangeRequest } = await import('./src/models/CompensationChangeRequest.js');
    const { default: compensationChangeService } = await import('./src/services/compensationChangeService.js');
    const companyId = new mongoose.Types.ObjectId();
    const make = () => CompensationChangeRequest.create({ companyId, employeeId: new mongoose.Types.ObjectId(), status: 'SCHEDULED', effectiveFrom: new Date('2026-01-01'), reason: 'retry safety probe', proposedLines: [{ code: 'BASIC' }], proposedBy: actorId });
    const created = [await make(), await make()];
    const originalStart = mongoose.startSession.bind(mongoose);
    let commits = 0;
    mongoose.startSession = async (...args) => {
      const session = await originalStart(...args);
      const commit = session.commitTransaction.bind(session);
      session.commitTransaction = async () => {
        commits += 1;
        if (commits === 1) { await session.abortTransaction(); throw Object.assign(new Error('injected transient commit failure'), { errorLabels: new Set(['TransientTransactionError']) }); }
        return commit();
      };
      return session;
    };
    let activated;
    try {
      activated = await compensationChangeService.activateDue({ companyId, now: new Date('2026-06-01') });
    } finally {
      mongoose.startSession = originalStart;
    }
    try {
      assert.equal(commits, 3, 'the first change needed two commit attempts, the second one');
      assert.equal(activated, 2, 'two changes were activated; the re-run of the first callback must not be counted twice');
      const stored = await CompensationChangeRequest.find({ companyId }).lean();
      assert.deepEqual(stored.map((d) => d.status), ['EFFECTIVE', 'EFFECTIVE']);
      for (const { _id } of created) assert.equal(await AuditLog.collection.countDocuments({ action: 'COMPENSATION_CHANGE_EFFECTIVE', entityId: _id }), 1, 'exactly one audit event per activated change');
      await assertSound('after activateDue with a re-run', { expectedRecords: 3 });
    } finally {
      await CompensationChangeRequest.deleteMany({ companyId });
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('F — controlled initialization, cutover and old writers', () => {
  const quiet = { quietSeconds: 0 };
  beforeEach(() => resetAll());

  const cli = (args, env = {}) => new Promise((resolve) => {
    execFile(process.execPath, [HEAD_CLI, ...args], { cwd: BACKEND, env: { ...process.env, MONGO_URI: TEST_DB_URI, ...env } }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });

  test('a clean pre-protocol chain initializes: plan then apply creates ONE head at the verified tail, sets the validator and indexes, and every pre-existing record is byte-identical', async () => {
    await makePreProtocolChain(6);
    const before = await records();
    const plan = await planHeadInitialization(quiet);
    assert.equal(plan.ok, true, JSON.stringify(plan.findings));
    assert.deepEqual(plan.tail.sequence, 6);
    assert.ok(plan.actions.some((a) => a.startsWith('CREATE_INDEX unique headVersion')) && plan.actions.includes('SET_VALIDATOR') && plan.actions.includes('CREATE_HEAD at sequence 6'));
    assert.equal(await headDoc(), null, 'planning created nothing');
    const result = await applyHeadInitialization({ expectedDigest: plan.digest, operator: 'tester', commit: 'abc123', ...quiet });
    assert.equal(result.applied, true);
    assert.deepEqual(await records(), before, 'no pre-existing record changed by one byte');
    const head = await headDoc();
    assert.deepEqual([head.sequence, head.hash, head.version, head.baseline.source, head.baseline.operator, head.baseline.commit, head.baseline.planDigest], [6, before[5].hash, 1, 'initialized-from-verified-history', 'tester', 'abc123', plan.digest]);
    auditService._modeOverride = 'strict';
    try { assert.equal((await auditService.protocolStatus({ checkBuilds: false })).ok, true, 'strict status is clean after cutover'); } finally { auditService._modeOverride = null; }
    const next = await auditService.logStandalone(params(7));
    assert.equal(next.sequenceNumber, 7);
    assert.equal(next.previousHash, before[5].hash);
    assert.equal(next.headVersion, 2);
    await assertSound('after cutover', { expectedRecords: 7 });
  });

  const refusals = [
    ['a fork (two records claim one sequence)', async () => { await makePreProtocolChain(4); await AuditLog.collection.dropIndexes(); const { _id, ...two } = await AuditLog.collection.findOne({ sequenceNumber: 2 }); await AuditLog.collection.insertOne(two); }, 'CHAIN_INVALID'],
    ['a broken predecessor link', async () => { await makePreProtocolChain(4); await AuditLog.collection.updateOne({ sequenceNumber: 3 }, { $set: { previousHash: 'f'.repeat(64) } }); }, 'CHAIN_INVALID'],
    ['an unexplained gap', async () => { await makePreProtocolChain(4); await AuditLog.collection.deleteOne({ sequenceNumber: 2 }); }, 'CHAIN_INVALID'],
    ['an edited record', async () => { await makePreProtocolChain(4); await AuditLog.collection.updateOne({ sequenceNumber: 2 }, { $set: { action: 'EDITED' } }); }, 'CHAIN_INVALID'],
    ['a record that predates the chain (no chain fields)', async () => { await makePreProtocolChain(3); await AuditLog.collection.insertOne({ action: 'OLD', actorId, entityType: 'T', entityId: actorId, meta: {}, createdAt: new Date('2020-01-01') }); }, 'UNCHAINED_RECORDS'],
    ['records written under the head protocol while the head is MISSING (the head was removed)', async () => { for (let i = 1; i <= 3; i += 1) await auditService.logStandalone(params(i)); await heads().deleteMany({}); }, 'HEAD_MISSING_BUT_PROTOCOL_RECORDS'],
    ['an incompatible index (a look-alike previousHash index)', async () => { await makePreProtocolChain(3); await AuditLog.collection.dropIndex('previousHash_unique_successor'); await AuditLog.collection.createIndex({ previousHash: 1 }, { name: 'previousHash_unique_successor', unique: true, partialFilterExpression: { previousHash: { $type: 'number' } } }); }, 'INDEX_INCOMPATIBLE'],
    ['an incompatible validator', async () => { await makePreProtocolChain(3); await mongoose.connection.db.command({ collMod: 'auditlogs', validator: { $jsonSchema: { bsonType: 'object', required: ['somethingElse'] } }, validationLevel: 'moderate', validationAction: 'error' }); }, 'VALIDATOR_INCOMPATIBLE'],
  ];
  for (const [title, build, code] of refusals) {
    test(`initialization REFUSES ${title}: ${code}, creates nothing, and apply refuses even with the matching digest`, async () => {
      await build();
      const before = [await records(), await headDoc()];
      const plan = await planHeadInitialization(quiet);
      assert.equal(plan.ok, false);
      assert.ok(plan.findings.some((f) => f.code === code), `expected ${code}, got ${JSON.stringify(plan.findings.map((f) => f.code))}`);
      await assert.rejects(applyHeadInitialization({ expectedDigest: plan.digest, operator: 'tester', ...quiet }), (e) => e instanceof HeadInitializationRefused && e.code === 'PLAN_REFUSED');
      assert.deepEqual([await records(), await headDoc()], before);
    });
  }

  test('recent writes (writers may still be running) prevent cutover by default', async () => {
    await makePreProtocolChain(3);
    const plan = await planHeadInitialization({ quietSeconds: 60 });
    assert.equal(plan.ok, false);
    assert.ok(plan.findings.some((f) => f.code === 'RECENT_WRITES'));
    assert.equal(await headDoc(), null);
  });

  test('apply needs the reviewed digest and an operator, and a head already present refuses a second initialization', async () => {
    await makePreProtocolChain(3);
    const plan = await planHeadInitialization(quiet);
    await assert.rejects(applyHeadInitialization({ expectedDigest: 'f'.repeat(64), operator: 'tester', ...quiet }), (e) => e.code === 'DIGEST_MISMATCH');
    await assert.rejects(applyHeadInitialization({ expectedDigest: plan.digest, operator: '  ', ...quiet }), (e) => e.code === 'OPERATOR_REQUIRED');
    assert.equal(await headDoc(), null);
    await applyHeadInitialization({ expectedDigest: plan.digest, operator: 'tester', ...quiet });
    const again = await planHeadInitialization(quiet);
    assert.equal(again.ok, false);
    assert.ok(again.findings.some((f) => f.code === 'HEAD_ALREADY_EXISTS'));
    await assert.rejects(applyHeadInitialization({ expectedDigest: again.digest, operator: 'tester', ...quiet }), (e) => e.code === 'PLAN_REFUSED');
  });

  test('TWO initializers racing: exactly one head is created, the loser is refused, and the chain is sound', async () => {
    await makePreProtocolChain(5);
    const plan = await planHeadInitialization(quiet);
    const settled = await Promise.allSettled([1, 2, 3].map((n) => applyHeadInitialization({ expectedDigest: plan.digest, operator: `racer-${n}`, ...quiet })));
    assert.equal(settled.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(settled.map((r) => r.status === 'rejected' ? r.reason.code : 'applied')));
    for (const r of settled.filter((x) => x.status === 'rejected')) assert.ok(['PLAN_REFUSED', 'HEAD_ALREADY_EXISTS', 'CHAIN_CHANGED_DURING_CUTOVER', 'DIGEST_MISMATCH'].includes(r.reason.code), r.reason.code);
    assert.equal(await heads().countDocuments({}), 1);
    await assertSound('after the initializer race', { expectedRecords: 5 });
  });

  test('an OLD writer active during cutover: a record it appends between the plan and the head creation aborts the cutover (the chain changed); re-running then succeeds', async () => {
    await makePreProtocolChain(4);
    const plan = await planHeadInitialization(quiet);
    const last = (await records()).at(-1);
    const sneaking = { ...last, _id: new mongoose.Types.ObjectId(), sequenceNumber: 5, previousHash: last.hash, createdAt: new Date() };
    sneaking.hash = independentHash(sneaking); // a perfectly valid pre-protocol append by a writer that had not stopped
    const originalCommand = mongoose.connection.db.command.bind(mongoose.connection.db);
    mongoose.connection.db.command = async (cmd, ...rest) => { if (cmd.collMod) await AuditLog.collection.insertOne(sneaking); return originalCommand(cmd, ...rest); };
    try {
      await assert.rejects(applyHeadInitialization({ expectedDigest: plan.digest, operator: 'tester', ...quiet }), (e) => e.code === 'CHAIN_CHANGED_DURING_CUTOVER' && e.found.sequence === 5 && e.planned.sequence === 4);
    } finally {
      mongoose.connection.db.command = originalCommand;
    }
    assert.equal(await headDoc(), null, 'no head was created over a chain that moved');
    const replan = await planHeadInitialization(quiet);
    assert.equal(replan.ok, true);
    await applyHeadInitialization({ expectedDigest: replan.digest, operator: 'tester', ...quiet });
    assert.equal((await headDoc()).sequence, 5);
    await assertSound('after the re-run', { expectedRecords: 5 });
  });

  test('after cutover the DATABASE refuses an old writer: an insert without headVersion fails document validation (code 121); a forged-protocol writer is not claimed to be stopped', async () => {
    await makePreProtocolChain(3);
    const plan = await planHeadInitialization(quiet);
    await applyHeadInitialization({ expectedDigest: plan.digest, operator: 'tester', ...quiet });
    const last = (await records()).at(-1);
    const oldWriterRecord = { ...last, _id: new mongoose.Types.ObjectId(), sequenceNumber: 4, previousHash: last.hash, hash: 'e'.repeat(64) };
    delete oldWriterRecord.headVersion;
    await assert.rejects(AuditLog.collection.insertOne(oldWriterRecord), (e) => e.code === 121);
    assert.equal((await records()).length, 3, 'the old writer\'s record was not stored');
    // what the validator does NOT do (stated in the specification): a writer that fakes the field passes validation. The head protocol, not the validator, is what keeps compliant writers linear.
    const faked = { ...oldWriterRecord, headVersion: 99 };
    await AuditLog.collection.insertOne(faked);
    assert.equal((await records()).length, 4);
    const head = await auditService.verifyHead();
    assert.equal(head.ok, false, 'and the disagreement between head and chain is visible');
  });

  test('the legacy-record migration is REFUSED once a head exists (it must run before the head)', async () => {
    await makePreProtocolChain(3);
    const plan = await planHeadInitialization(quiet);
    await applyHeadInitialization({ expectedDigest: plan.digest, operator: 'tester', ...quiet });
    const backfill = await auditService.planLegacyBackfill();
    assert.equal(backfill.ok, false);
    assert.ok(backfill.findings.some((f) => f.code === 'HEAD_ALREADY_INITIALIZED'));
  });

  test('LIMITATION, documented not hidden: records removed from the tail BEFORE initialization are not detectable; the plan says so and records the truncated tail as the trusted baseline', async () => {
    await makePreProtocolChain(6);
    await AuditLog.collection.deleteMany({ sequenceNumber: { $gt: 4 } }); // an attacker (or an accident) removed the newest two
    const plan = await planHeadInitialization(quiet);
    assert.equal(plan.ok, true, 'a shorter, internally valid chain is indistinguishable from the real history');
    assert.equal(plan.tail.sequence, 4);
    assert.match(plan.limitation, /cannot prove that records after it were not removed before this point/);
  });

  test('CLI: a dry run against a brand-new EMPTY database creates no collection and no index; --status judges as production would and exits 1 while the head is missing', async () => {
    const emptyUri = TEST_DB_URI.replace(/\/[^/?]+\?/, '/payguard_audit_head_cli_empty?');
    const probe = await mongoose.createConnection(emptyUri, { autoIndex: false, autoCreate: false }).asPromise();
    try {
      await probe.dropDatabase();
      const dry = await cli(['--quiet-seconds', '0'], { MONGO_URI: emptyUri });
      assert.equal(dry.code, 0, dry.stderr);
      assert.match(dry.stdout, /DRY RUN: nothing was written/);
      assert.match(dry.stdout, /would: CREATE_COLLECTION/);
      assert.deepEqual(await probe.db.listCollections().toArray(), [], 'a dry run created a collection');
      const status = await cli(['--status'], { MONGO_URI: emptyUri });
      assert.equal(status.code, 1);
      assert.match(status.stdout, /judged as strict/);
      assert.deepEqual(await probe.db.listCollections().toArray(), [], '--status created nothing either');
    } finally {
      await probe.dropDatabase();
      await probe.close();
    }
  });

  test('CLI apply is guarded (digest, database name, operator, strict arguments) and then initializes; a second apply is refused', async () => {
    await makePreProtocolChain(3);
    const DB = mongoose.connection.name;
    const plan = JSON.parse((await cli(['--json', '--quiet-seconds', '0'])).stdout).plan;
    const good = ['--apply', '--plan-digest', plan.digest, '--confirm-database', DB, '--operator', 'tester', '--quiet-seconds', '0'];
    const cases = [
      [['--apply'], /--apply needs --plan-digest/],
      [['--apply', '--plan-digest', plan.digest, '--operator', 'x'], /--apply needs --confirm-database/],
      [['--apply', '--plan-digest', plan.digest, '--confirm-database', DB], /--apply needs --operator/],
      [['--apply', '--plan-digest', plan.digest, '--confirm-database', 'other_db', '--operator', 'x'], /does not match the connected database/],
      [['--apply', '--plan-digest', 'f'.repeat(64), '--confirm-database', DB, '--operator', 'x', '--quiet-seconds', '0'], /plan digest does not match/],
      [['--plan-digest', plan.digest], /only meaningful with --apply/],
      [['--apply', '--status'], /cannot be combined/],
      [['--bogus'], /unknown argument --bogus/],
      [['--quiet-seconds', 'abc'], /whole number of seconds/],
    ];
    for (const [args, reason] of cases) {
      const result = await cli(args);
      assert.equal(result.code, 1, args.join(' '));
      assert.match(result.stderr, reason, args.join(' '));
    }
    assert.equal(await headDoc(), null, 'every refusal left the database untouched');
    const applied = await cli(good);
    assert.equal(applied.code, 0, applied.stderr);
    assert.match(applied.stdout, /APPLIED by tester/);
    assert.match(applied.stdout, /Audit chain protocol \(judged as strict\): OK/);
    const again = await cli(good);
    assert.equal(again.code, 1);
    await assertSound('after CLI cutover', { expectedRecords: 3 });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('F2 — cutover on an empty or absent chain, more refusals, real-server old-writer interleavings, competing initializers, copy-database, CLI evidence', () => {
  const quiet = { quietSeconds: 0 };
  const EXPECTED_HOST = new URL(TEST_DB_URI).host.toLowerCase(); // host:port as the driver reports it
  beforeEach(() => resetAll());

  const cli = (args, env = {}) => new Promise((resolve) => {
    execFile(process.execPath, [HEAD_CLI, ...args], { cwd: BACKEND, env: { ...process.env, MONGO_URI: TEST_DB_URI, ...env } }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
  const strictly = async (body) => { auditService._modeOverride = 'strict'; try { return await body(); } finally { auditService._modeOverride = null; } };
  /** A perfectly valid pre-protocol append by a writer that had not stopped: it extends the current tail, carries no headVersion. */
  const oldWriterRecord = async (sequenceNumber) => {
    const last = (await records()).at(-1);
    const record = { ...last, _id: new mongoose.Types.ObjectId(), sequenceNumber, previousHash: last.hash, createdAt: new Date() };
    delete record.headVersion;
    record.hash = independentHash(record);
    return record;
  };

  // ── an EMPTY chain and an ABSENT collection: the first deployment of a new installation ──
  test('cutover on an EMPTY audit collection creates the genesis head (sequence 0, GENESIS, version 1) and the first strict append is sequence 1 linked to GENESIS', async () => {
    const plan = await planHeadInitialization(quiet);
    assert.equal(plan.ok, true, JSON.stringify(plan.findings));
    assert.equal(plan.tail, null);
    assert.ok(plan.actions.includes('CREATE_HEAD at sequence 0') && plan.actions.includes('SET_VALIDATOR'));
    await applyHeadInitialization({ expectedDigest: plan.digest, operator: 'tester', ...quiet });
    const head = await headDoc();
    assert.deepEqual([head.sequence, head.hash, head.version, head.baseline.sequence, head.baseline.hash, head.baseline.source], [0, GENESIS_HASH, 1, 0, GENESIS_HASH, 'initialized-from-verified-history']);
    assert.equal((await auditService.verifyHead()).ok, true);
    const first = await strictly(() => auditService.logStandalone(params(1)));
    assert.deepEqual([first.sequenceNumber, first.previousHash, first.headVersion], [1, GENESIS_HASH, 2]);
    await assertSound('first append after an empty cutover', { expectedRecords: 1 });
  });

  test('cutover on an ABSENT audit collection creates the collection, the three indexes, the validator and the genesis head; the database is then exactly the specification', async () => {
    await AuditLog.collection.drop();
    assert.deepEqual(await mongoose.connection.db.listCollections({ name: 'auditlogs' }).toArray(), []);
    const plan = await planHeadInitialization(quiet);
    assert.equal(plan.ok, true, JSON.stringify(plan.findings));
    assert.deepEqual(plan.actions.filter((a) => !a.startsWith('CREATE_INDEX')), ['CREATE_COLLECTION', 'SET_VALIDATOR', 'CREATE_HEAD at sequence 0']);
    assert.equal(plan.actions.filter((a) => a.startsWith('CREATE_INDEX')).length, 3);
    await applyHeadInitialization({ expectedDigest: plan.digest, operator: 'tester', ...quiet });
    const shape = await auditService.databaseShape();
    assert.deepEqual(shape.indexes.map((i) => i.status), ['OK', 'OK', 'OK']);
    assert.equal(shape.validator.status, 'OK');
    const first = await strictly(() => auditService.logStandalone(params(1)));
    assert.deepEqual([first.sequenceNumber, first.previousHash], [1, GENESIS_HASH]);
    await assertSound('after the absent-collection cutover', { expectedRecords: 1 });
  });

  // ── more history the cutover must refuse (each leaves the database untouched) ──
  const MORE_REFUSALS = [
    ['a PARTIALLY chained record (sequence and previous hash, no hash)', async () => { await makePreProtocolChain(3); await AuditLog.collection.insertOne({ sequenceNumber: 4, previousHash: 'a'.repeat(64), action: 'PARTIAL', actorId, entityType: 'T', entityId: actorId, meta: {}, createdAt: new Date() }); }, 'UNCHAINED_RECORDS'],
    ['a chain whose FIRST sequence is not 1 (the oldest record is missing)', async () => { await makePreProtocolChain(4); await AuditLog.collection.deleteOne({ sequenceNumber: 1 }); }, 'CHAIN_INVALID'],
    ['a record whose hash is not a valid SHA-256 hex digest', async () => { await makePreProtocolChain(4); await AuditLog.collection.updateOne({ sequenceNumber: 4 }, { $set: { hash: 'not-a-hash' } }); }, 'CHAIN_INVALID'],
    ['a record with an UNPARSEABLE createdAt (a finding, not a crash)', async () => { await makePreProtocolChain(4); await AuditLog.collection.updateOne({ sequenceNumber: 3 }, { $set: { createdAt: 'garbage' } }); }, 'CHAIN_RECORD_MALFORMED'],
    ['a record with NO createdAt at all (a finding, not a crash)', async () => { await makePreProtocolChain(4); await AuditLog.collection.updateOne({ sequenceNumber: 2 }, { $unset: { createdAt: 1 } }); }, 'CHAIN_RECORD_MALFORMED'],
  ];
  for (const [title, build, code] of MORE_REFUSALS) {
    test(`initialization REFUSES ${title}: ${code}; creates nothing; apply refuses even with the matching digest`, async () => {
      await build();
      const before = [await records(), await headDoc()];
      const plan = await planHeadInitialization(quiet);
      assert.equal(plan.ok, false);
      assert.ok(plan.findings.some((f) => f.code === code), `expected ${code}, got ${JSON.stringify(plan.findings.map((f) => f.code))}`);
      await assert.rejects(applyHeadInitialization({ expectedDigest: plan.digest, operator: 'tester', ...quiet }), (e) => e instanceof HeadInitializationRefused && e.code === 'PLAN_REFUSED');
      assert.deepEqual([await records(), await headDoc()], before);
    });
  }

  // ── a running index build, an unobservable one, and the cluster the plan was made against ──
  test('a RUNNING index build refuses the plan; an UNOBSERVABLE one refuses it too unless the operator acknowledges it, and the acknowledgement is part of the reviewed digest (SIMULATED $currentOp answers)', async () => {
    await makePreProtocolChain(3);
    const original = auditService.indexBuildState;
    try {
      auditService.indexBuildState = async () => ({ state: 'RUNNING', detail: null });
      let plan = await planHeadInitialization(quiet);
      assert.equal(plan.ok, false);
      assert.ok(plan.findings.some((f) => f.code === 'INDEX_BUILD_RUNNING'));
      assert.equal((await planHeadInitialization({ ...quiet, acceptUnobservableIndexBuilds: true })).ok, false, 'an acknowledgement never overrides a build that IS running');

      auditService.indexBuildState = async () => ({ state: 'UNAVAILABLE', detail: 'not authorized on admin to execute command' });
      plan = await planHeadInitialization(quiet);
      assert.equal(plan.ok, false);
      assert.ok(plan.findings.some((f) => f.code === 'INDEX_BUILD_UNOBSERVABLE' && /--accept-unobservable-index-builds/.test(f.detail)));
      await assert.rejects(applyHeadInitialization({ expectedDigest: plan.digest, operator: 'tester', ...quiet }), (e) => e.code === 'PLAN_REFUSED');

      const acknowledged = await planHeadInitialization({ ...quiet, acceptUnobservableIndexBuilds: true });
      assert.equal(acknowledged.ok, true, JSON.stringify(acknowledged.findings));
      assert.equal(acknowledged.unobservableAccepted, true);
      assert.notEqual(acknowledged.digest, plan.digest, 'the acknowledgement is bound into the digest');
      await assert.rejects(applyHeadInitialization({ expectedDigest: acknowledged.digest, operator: 'tester', ...quiet }), (e) => e.code === 'PLAN_REFUSED', 'apply without repeating the acknowledgement is refused');
      assert.equal(await headDoc(), null);
      await applyHeadInitialization({ expectedDigest: acknowledged.digest, operator: 'tester', acceptUnobservableIndexBuilds: true, ...quiet });
      assert.equal((await headDoc()).sequence, 3);
    } finally {
      auditService.indexBuildState = original;
    }
  });

  test('a plan reviewed by a user who can SEE index builds cannot be applied on an acknowledgement nobody reviewed: the two plans differ only in that acknowledgement, and their digests differ (SIMULATED $currentOp answers)', async () => {
    await makePreProtocolChain(3);
    const original = auditService.indexBuildState;
    try {
      auditService.indexBuildState = async () => ({ state: 'NONE', detail: null });
      const observed = await planHeadInitialization(quiet);
      assert.equal(observed.ok, true, JSON.stringify(observed.findings));

      auditService.indexBuildState = async () => ({ state: 'UNAVAILABLE', detail: 'not authorized on admin to execute command' });
      const acknowledged = await planHeadInitialization({ ...quiet, acceptUnobservableIndexBuilds: true });
      assert.equal(acknowledged.ok, true, JSON.stringify(acknowledged.findings));
      assert.deepEqual(acknowledged.actions, observed.actions, 'the plans otherwise agree');
      assert.notEqual(acknowledged.digest, observed.digest);

      await assert.rejects(
        applyHeadInitialization({ expectedDigest: observed.digest, operator: 'tester', acceptUnobservableIndexBuilds: true, ...quiet }),
        (e) => e.code === 'DIGEST_MISMATCH',
      );
      assert.equal(await headDoc(), null);
    } finally {
      auditService.indexBuildState = original;
    }
  });

  test('the plan names the cluster it inspected and the digest binds it: the same data seen through a DIFFERENT set of hosts gets a different digest, so a plan reviewed on one cluster cannot be applied to a restored copy with the same database name', async () => {
    await makePreProtocolChain(3);
    const plan = await planHeadInitialization(quiet);
    assert.equal(plan.target.database, mongoose.connection.name);
    assert.deepEqual(plan.target.hosts, [EXPECTED_HOST]);
    await withReportedHosts([{ host: 'restored-copy.example.invalid', port: 27017 }], async () => {
      const elsewhere = await planHeadInitialization(quiet);
      assert.deepEqual(elsewhere.target.hosts, ['restored-copy.example.invalid:27017']);
      assert.notEqual(elsewhere.digest, plan.digest);
      await assert.rejects(applyHeadInitialization({ expectedDigest: plan.digest, operator: 'tester', ...quiet }), (e) => e.code === 'DIGEST_MISMATCH');
    });
    assert.equal(await headDoc(), null, 'nothing was created');
    assert.equal((await planHeadInitialization(quiet)).digest, plan.digest, 'restored: the original digest is valid again');
  });

  // ── initializers that really collide ──
  test('N initializers released TOGETHER (a barrier BEFORE the validator step, outside any transaction or lock: every one has passed its plan and its digest check first): exactly one head, every other one reports HEAD_ALREADY_EXISTS', async () => {
    // The barrier must sit outside the locks: collMod needs exclusive access to the collection, so an initializer parked INSIDE its
    // transaction would make another one wait for a lock that is never released (a self-inflicted deadlock the first version of this
    // test had). Here all N arrive at the validator step, are released together, and the server serializes them.
    await makePreProtocolChain(4);
    await AuditLog.createIndexes(); // so the race is about the validator and the head, not about N concurrent builds of the same index
    const plan = await planHeadInitialization(quiet);
    assert.ok(!plan.actions.some((a) => a.startsWith('CREATE_INDEX')), 'no index step is left in the race');
    const N = 4;
    const originalCommand = mongoose.connection.db.command.bind(mongoose.connection.db);
    let arrived = 0;
    let open;
    const everyoneArrived = new Promise((resolve) => { open = resolve; });
    const safety = setTimeout(() => open(), 10_000); // a failure must be reported, never hang the suite
    mongoose.connection.db.command = async (cmd, ...rest) => {
      if (cmd.collMod) {
        arrived += 1;
        if (arrived === N) open();
        await everyoneArrived;
      }
      return originalCommand(cmd, ...rest);
    };
    let settled;
    try {
      settled = await Promise.allSettled(Array.from({ length: N }, (_, n) => applyHeadInitialization({ expectedDigest: plan.digest, operator: `racer-${n}`, ...quiet })));
    } finally {
      clearTimeout(safety);
      mongoose.connection.db.command = originalCommand;
    }
    assert.equal(arrived, N, `all initializers passed their plan and digest check and reached the validator step together: ${JSON.stringify(settled.map((r) => (r.status === 'rejected' ? r.reason.code ?? r.reason.message : 'applied')))}`);
    assert.equal(settled.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(settled.map((r) => (r.status === 'rejected' ? r.reason.code : 'applied'))));
    assert.deepEqual([...new Set(settled.filter((r) => r.status === 'rejected').map((r) => r.reason.code))], ['HEAD_ALREADY_EXISTS']);
    assert.equal(await heads().countDocuments({}), 1);
    assert.equal((await headDoc()).sequence, 4);
    await assertSound('after the barriered initializer race', { expectedRecords: 4 });
  });

  // ── old writers that straddle the validator (REAL server behaviour, observed by probe and pinned here) ──
  test('REAL server: an old writer whose transaction snapshot PREDATES the validator cannot insert after the cutover: the server refuses it with a WriteConflict about catalog changes; nothing is stored and the head still agrees', async () => {
    await makePreProtocolChain(3);
    const plan = await planHeadInitialization(quiet);
    const oldWriter = await mongoose.startSession();
    oldWriter.startTransaction({ readConcern: { level: 'snapshot' } });
    await scratch().findOne({}, { session: oldWriter }); // its snapshot is fixed NOW, before the validator exists; it has not touched the audit collection
    await applyHeadInitialization({ expectedDigest: plan.digest, operator: 'tester', ...quiet });
    try {
      await assert.rejects(AuditLog.collection.insertOne(await oldWriterRecord(4), { session: oldWriter }), (e) => e.code === 112 && /catalog changes/i.test(e.message), 'refused as a catalog-change WriteConflict');
    } finally {
      await oldWriter.abortTransaction().catch(() => {});
      await oldWriter.endSession();
    }
    assert.equal((await records()).length, 3, 'the straddling writer stored nothing');
    await assertSound('after the straddling old writer', { expectedRecords: 3 });
  });

  test('REAL server: an old writer that ALREADY touched the audit collection holds the cutover back; the record it then commits is caught by the tail check (CHAIN_CHANGED_DURING_CUTOVER); the database is left fail-closed and re-running succeeds', async () => {
    await makePreProtocolChain(3);
    const plan = await planHeadInitialization(quiet);
    const oldWriter = await mongoose.startSession();
    oldWriter.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    await AuditLog.collection.findOne({}, { session: oldWriter }); // the open transaction now holds the collection
    const applying = applyHeadInitialization({ expectedDigest: plan.digest, operator: 'tester', ...quiet }).then(() => ({ applied: true }), (error) => ({ error }));
    const early = await Promise.race([applying.then(() => 'finished'), sleep(1500).then(() => 'held back')]);
    assert.equal(early, 'held back', 'the cutover waits for the open transaction instead of racing it');
    await AuditLog.collection.insertOne(await oldWriterRecord(4), { session: oldWriter }); // accepted: no validator is in force yet
    await oldWriter.commitTransaction();
    await oldWriter.endSession();
    const outcome = await applying;
    assert.equal(outcome.error?.code, 'CHAIN_CHANGED_DURING_CUTOVER', JSON.stringify(outcome));
    assert.equal(await headDoc(), null, 'no head over a chain that moved');
    assert.equal((await auditService.databaseShape()).validator.status, 'OK', 'fail closed: the validator is already in force, so audited operations are refused until the tool is re-run');
    const replan = await planHeadInitialization(quiet);
    assert.equal(replan.ok, true, JSON.stringify(replan.findings));
    await applyHeadInitialization({ expectedDigest: replan.digest, operator: 'tester', ...quiet });
    assert.equal((await headDoc()).sequence, 4);
    await assertSound('after the held-back cutover', { expectedRecords: 4 });
  });

  // ── what the head check is and is NOT ──
  test('PINNED LIMITATION: with the unique indexes ineffective a head-unaware writer that took the next position is NOT detected at append time (the append succeeds and the chain forks); verifyAuditChain reports the fork and the unique indexes refuse it when present', async () => {
    await makePreProtocolChain(3);
    const plan = await planHeadInitialization(quiet);
    await applyHeadInitialization({ expectedDigest: plan.digest, operator: 'tester', ...quiet });
    await AuditLog.collection.dropIndexes(); // an attacker or an accident removed every unique index
    const record = await oldWriterRecord(4);
    record.headVersion = 2; // a writer that fakes the field passes the validator (documented: the validator is not a security boundary)
    await AuditLog.collection.insertOne(record);
    const appended = await auditService.logStandalone(params(5)); // the head still says "sequence 3 is the tail": the protocol cannot know about the rogue record
    assert.equal(appended.sequenceNumber, 4, 'the protocol-following writer took the position the rogue writer had already taken');
    const verification = await auditService.verifyAuditChain();
    assert.equal(verification.valid, false, 'the fork is detectable by the full chain verification');
    assert.ok(verification.firstBrokenSequence >= 4);
  });

  test('a fork buried in history AFTER the cutover (written around the protocol with the indexes dropped) does not make the head check fail or the next append refuse; the full verification still reports it: verifyHead is a head/tail comparison, not a chain walk', async () => {
    await makePreProtocolChain(4);
    const plan = await planHeadInitialization(quiet);
    await applyHeadInitialization({ expectedDigest: plan.digest, operator: 'tester', ...quiet });
    await AuditLog.collection.dropIndexes();
    const { _id, ...copy } = await AuditLog.collection.findOne({ sequenceNumber: 2 });
    await AuditLog.collection.insertOne({ ...copy, headVersion: 77 });
    assert.equal((await auditService.verifyHead()).ok, true, 'the head still agrees with the newest record');
    await auditService.logStandalone(params(5));
    assert.equal((await auditService.verifyHead()).ok, true);
    const verification = await auditService.verifyAuditChain();
    assert.equal(verification.valid, false);
    assert.equal(verification.firstBrokenSequence, 2);
  });

  // ── cloning a cut-over database ──
  test('copy-database clones a database that has been cut over: it loads documents BEFORE applying the validator, so records that predate headVersion do not stop it; documents are byte-identical, indexes recreated, the validator in force', async () => {
    await makePreProtocolChain(3);
    const plan = await planHeadInitialization(quiet);
    await applyHeadInitialization({ expectedDigest: plan.digest, operator: 'tester', ...quiet });
    await auditService.logStandalone(params(4));
    const targetUri = TEST_DB_URI.replace(/\/[^/?]+\?/, '/payguard_audit_head_copy_target?');
    const target = await mongoose.createConnection(targetUri, { autoIndex: false, autoCreate: false }).asPromise();
    try {
      await target.dropDatabase();
      const result = await new Promise((resolve) => {
        execFile(process.execPath, [path.join(BACKEND, 'scripts/copy-database.mjs'), TEST_DB_URI, targetUri], { cwd: BACKEND, env: process.env }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
      });
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
      const sourceRecords = await records();
      const copiedRecords = await target.collection('auditlogs').find({}).sort({ sequenceNumber: 1, _id: 1 }).toArray();
      assert.deepEqual(copiedRecords, sourceRecords, 'every audit record is byte-identical, including those that predate headVersion');
      assert.deepEqual(await target.collection('auditchainheads').find({}).toArray(), [await headDoc()]);
      const info = await target.db.listCollections({ name: 'auditlogs' }).toArray();
      assert.equal(evaluateValidator(info[0].options).status, 'OK', 'the validator is in force on the copy');
      assert.deepEqual(evaluateIndexes(await target.collection('auditlogs').indexes()).map((row) => row.status), ['OK', 'OK', 'OK']);
      await assert.rejects(target.collection('auditlogs').insertOne({ sequenceNumber: 99, hash: 'x', previousHash: 'y' }), (e) => e.code === 121, 'and it refuses an old writer there as well');
    } finally {
      await target.dropDatabase();
      await target.close();
    }
  });

  // ── the CLI leaves evidence of an irreversible step, and refuses what it cannot vouch for ──
  test('CLI apply writes its evidence: --report creates a NEW file (never overwrites), --json prints the same record; --commit is validated; --accept-unobservable-index-builds is refused for --status; --quiet-seconds 0 warns', async () => {
    await makePreProtocolChain(3);
    const DB = mongoose.connection.name;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payguard-head-report-'));
    const reportPath = path.join(dir, 'cutover-report.json');
    try {
      const dry = await cli(['--json', '--quiet-seconds', '0']);
      assert.match(dry.stderr, /WARNING: --quiet-seconds 0 turns off the only guard/);
      const plan = JSON.parse(dry.stdout).plan;
      assert.deepEqual(plan.target.hosts, [EXPECTED_HOST]);
      const base = ['--apply', '--plan-digest', plan.digest, '--confirm-database', DB, '--operator', 'tester', '--quiet-seconds', '0'];
      const refused = [
        [[...base, '--commit', 'x'.repeat(101)], /--commit must be at most 100 printable characters/],
        [['--status', '--accept-unobservable-index-builds'], /only meaningful for a dry run or --apply/],
      ];
      for (const [args, reason] of refused) {
        const result = await cli(args);
        assert.equal(result.code, 1, args.join(' '));
        assert.match(result.stderr, reason);
      }
      assert.equal(await headDoc(), null);
      const applied = await cli([...base, '--commit', 'abc123', '--report', reportPath, '--json']);
      assert.equal(applied.code, 0, applied.stderr);
      const printed = JSON.parse(applied.stdout);
      assert.deepEqual([printed.mode, printed.database, printed.operator, printed.commit, printed.planDigest, printed.headSequence, printed.status.ok], ['APPLIED', DB, 'tester', 'abc123', plan.digest, 3, true]);
      assert.deepEqual(printed.target, plan.target);
      assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, 'utf8')), printed, 'the evidence file holds the same record');
      const second = await cli(['--json', '--report', reportPath]);
      assert.equal(second.code, 1, 'an existing report is never overwritten');
      assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, 'utf8')), printed);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('G — strict mode, readiness, the development fallback', () => {
  beforeEach(() => resetAll());

  test('STRICT mode never creates a head: an append on a chain without one is refused (AUDIT_CHAIN_NOT_INITIALIZED) and nothing is written', async () => {
    auditService._modeOverride = 'strict';
    try {
      await assert.rejects(auditService.logStandalone(params(1)), (e) => e.code === 'AUDIT_CHAIN_NOT_INITIALIZED' && e.statusCode === 503 && e.retryable === false);
    } finally {
      auditService._modeOverride = null;
    }
    assert.equal(await AuditLog.collection.countDocuments({}), 0);
    assert.equal(await headDoc(), null);
  });

  test('relaxed mode refuses to invent a head over a NON-empty chain', async () => {
    await makePreProtocolChain(2);
    await assert.rejects(auditService.logStandalone(params(1)), (e) => e.code === 'AUDIT_CHAIN_NOT_INITIALIZED' && /records but no head/.test(e.message));
    assert.equal(await AuditLog.collection.countDocuments({}), 2);
    assert.equal(await headDoc(), null);
  });

  test('first appends racing on an empty chain (relaxed): exactly ONE head is created and every committed append is linear', async () => {
    const settled = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => runInTransaction((session) => auditService.log(params(i), session), { label: 'g-bootstrap', maxAttempts: 40, maxWaitMs: 15000 })));
    const committed = settled.filter((r) => r.status === 'fulfilled').length;
    assert.ok(committed > 0);
    assert.equal(await heads().countDocuments({}), 1);
    await assertSound('bootstrap race', { expectedRecords: committed });
  });

  // A writer that read "no head" is overtaken by a first append that commits; the server's answer is recorded, not assumed.
  const overtakenFirstAppend = async (t, { dropIndexes }) => {
    if (dropIndexes) await AuditLog.collection.dropIndexes(); // the head document alone must arbitrate
    transactionLane.enabled = false; // two writers of one process must be able to be mid-transaction together, as two processes can
    const originalInsert = heads().insertOne;
    const originalUpdate = heads().updateOne;
    const originalSave = AuditLog.prototype.save;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let reached;
    const reachedInsert = new Promise((resolve) => { reached = resolve; });
    let headInserts = 0;
    let step = 'start';
    let slowIsRunning = false;
    heads().insertOne = async function gated(...args) {
      headInserts += 1;
      if (headInserts > 1 || !slowIsRunning) return originalInsert.apply(this, args);
      step = 'head-insert';
      reached();
      await gate;
      return originalInsert.apply(this, args);
    };
    heads().updateOne = async function tracked(...args) { if (slowIsRunning) step = 'head-update'; return originalUpdate.apply(this, args); };
    AuditLog.prototype.save = async function tracked(...args) { if (slowIsRunning) step = 'record-insert'; return originalSave.apply(this, args); };
    let executions = 0;
    const refusals = [];
    const commitFailures = [];
    const originalStart = mongoose.startSession.bind(mongoose);
    mongoose.startSession = async (...args) => {
      const session = await originalStart(...args);
      const commit = session.commitTransaction.bind(session);
      session.commitTransaction = async () => { try { return await commit(); } catch (error) { commitFailures.push(error); throw error; } };
      return session;
    };
    try {
      slowIsRunning = true;
      const slow = runInTransaction(async (session) => {
        executions += 1;
        try { return await auditService.log(params(1), session); } catch (error) { refusals.push({ error, step }); throw error; }
      }, { label: 'g3-slow', maxAttempts: 10, maxWaitMs: 15000 });
      await reachedInsert; // the slow writer has read "no head" and is about to create it
      slowIsRunning = false;
      await auditService.logStandalone(params(2)); // the fast writer creates the head and commits record 1
      slowIsRunning = true;
      release();
      await slow;
    } finally {
      mongoose.startSession = originalStart;
      heads().insertOne = originalInsert;
      heads().updateOne = originalUpdate;
      AuditLog.prototype.save = originalSave;
      transactionLane.enabled = true;
    }
    const failures = [...refusals.map(({ error, step: at }) => ({ error, at })), ...commitFailures.map((error) => ({ error, at: 'commit' }))];
    t.diagnostic(`unique indexes ${dropIndexes ? 'ABSENT' : 'present'}; attempts: ${executions}; refusals: ${failures.map(({ error, at }) => `${error.code ?? error.name}/${error.codeName ?? ''} at ${at}`).join(' | ') || 'none'}`);
    assert.ok(failures.length >= 1, 'the overtaken unit was refused somewhere (a step of the append, or the commit) before it could succeed');
    for (const { error, at } of failures) assert.ok(error.code === 112 || error.code === 'AUDIT_CHAIN_HEAD_CONFLICT' || error.errorLabels?.has?.('TransientTransactionError'), `a retryable refusal was expected (at ${at}), got ${error.code}: ${error.message}`);
    assert.equal(executions, failures.length + 1, 'the unit re-ran once per refusal, then committed');
    assert.equal(await heads().countDocuments({}), 1);
    assert.equal((await headDoc()).version, 3);
    await assertSound('overtaken first append', { expectedRecords: 2 });
  };

  test('a transaction that read "no head" and is OVERTAKEN by a committed first append retries from the winner\'s head and appends after it (REAL server, a writer held at the head creation; the refusal it gets is recorded)', (t) => overtakenFirstAppend(t, { dropIndexes: false }));

  test('the same overtaking with EVERY unique index on the audit collection ABSENT: the head document alone still forces the overtaken writer to retry; no fork, one head, two linear records (REAL server)', (t) => overtakenFirstAppend(t, { dropIndexes: true }));

  test('losing the head-creation race with a DUPLICATE KEY (SIMULATED server reply) is a retryable conflict, never a raw E11000: the unit re-runs and appends after the winner', async () => {
    const original = heads().insertOne;
    let calls = 0;
    heads().insertOne = async function simulated(doc, options) {
      calls += 1;
      if (calls === 1) {
        await original.call(this, doc); // the "winner" commits the head outside this transaction...
        throw Object.assign(new Error(`E11000 duplicate key error collection: ${mongoose.connection.name}.auditchainheads index: _id_ dup key: { _id: "global" }`), { code: 11000, keyPattern: { _id: 1 } }); // ...and this one is told so
      }
      return original.call(this, doc, options);
    };
    let executions = 0;
    try {
      await runInTransaction(async (session) => { executions += 1; return auditService.log(params(1), session); }, { label: 'g4' });
    } finally {
      heads().insertOne = original;
    }
    assert.equal(executions, 2);
    assert.equal(await heads().countDocuments({}), 1);
    assert.equal((await headDoc()).version, 2);
    await assertSound('simulated duplicate key', { expectedRecords: 1 });
  });

  test('readiness fails while the chain has records but no head, and reports the audit-chain issue; it recovers after initialization', async () => {
    await makePreProtocolChain(3);
    app.locals.resetAuditReadiness();
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/ready`;
    try {
      let response = await fetch(url);
      let body = await response.json();
      assert.equal(response.status, 503);
      assert.equal(body.auditChain.ok, false);
      assert.ok(body.auditChain.issues.includes('error:HEAD_MISSING'));
      const plan = await planHeadInitialization({ quietSeconds: 0 });
      await applyHeadInitialization({ expectedDigest: plan.digest, operator: 'tester', quietSeconds: 0 });
      app.locals.resetAuditReadiness();
      response = await fetch(url);
      body = await response.json();
      assert.equal(body.auditChain.ok, true, JSON.stringify(body.auditChain));
      assert.equal(response.status, 200);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('DEVELOPMENT FALLBACK (SIMULATED standalone server, opt-out honoured): an append without a session advances the head and inserts the record (NOT atomic); a failed insert reverts the head; with a real replica set the same call is refused', async () => {
    await auditService.logStandalone(params(0)); // creates the head on the real replica set
    // with real transactions available a missing session is a bug even when the opt-out flag is set
    const flag = config.requireTransactions;
    config.requireTransactions = false;
    try {
      await assert.rejects(auditService.log(params(1)), (e) => e.code === 'AUDIT_SESSION_REQUIRED');
      const originalAdmin = Object.getOwnPropertyDescriptor(mongoose.connection.db, 'admin');
      resetTransactionCapabilityCache();
      mongoose.connection.db.admin = () => ({ command: async () => ({ isWritablePrimary: true }) }); // no setName, not mongos: a standalone
      try {
        const entry = await auditService.log(params(1));
        assert.equal(entry.sequenceNumber, 2);
        assert.equal((await headDoc()).version, 3);
        const headBefore = await headDoc();
        const save = AuditLog.prototype.save;
        AuditLog.prototype.save = async function failing() { throw new Error('injected'); };
        try { await assert.rejects(auditService.log(params(2)), /injected/); } finally { AuditLog.prototype.save = save; }
        const headAfter = await headDoc();
        assert.deepEqual([headAfter.sequence, headAfter.hash, headAfter.version], [headBefore.sequence, headBefore.hash, headBefore.version], 'the failed insert\'s head advance was reverted');
      } finally {
        if (originalAdmin) Object.defineProperty(mongoose.connection.db, 'admin', originalAdmin); else delete mongoose.connection.db.admin;
        resetTransactionCapabilityCache();
      }
    } finally {
      config.requireTransactions = flag;
    }
    await assertSound('after the fallback', { expectedRecords: 2 });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('G2 — the development fallback under concurrency (SIMULATED standalone server): the conditional head update is then the ONLY arbiter', () => {
  beforeEach(async () => { await resetAll(); await auditService.logStandalone(params(0)); });

  test('20 concurrent appends WITHOUT transactions (stubbed standalone, opt-out honoured): none lost, none duplicated, contiguous, head consistent, no fork', async () => {
    const flag = config.requireTransactions;
    const originalAdmin = Object.getOwnPropertyDescriptor(mongoose.connection.db, 'admin');
    config.requireTransactions = false;
    resetTransactionCapabilityCache();
    mongoose.connection.db.admin = () => ({ command: async () => ({ isWritablePrimary: true }) });
    try {
      const settled = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => auditService.log(params(i + 1))));
      const refused = settled.filter((r) => r.status === 'rejected');
      assert.deepEqual(refused.map((r) => r.reason.code), [], 'the fallback retries until it wins');
    } finally {
      if (originalAdmin) Object.defineProperty(mongoose.connection.db, 'admin', originalAdmin); else delete mongoose.connection.db.admin;
      config.requireTransactions = flag;
      resetTransactionCapabilityCache();
    }
    await assertSound('fallback concurrency', { expectedRecords: 21 });
    assert.equal((await headDoc()).version, 22);
  });

  test('FIRST appends racing on an EMPTY chain WITHOUT transactions (stubbed standalone): every caller has read "no head" before any creates it (barrier), one creates it, the losers take another turn: none refused, none lost, one head', async () => {
    await resetAll(); // an empty chain: the relaxed mode lets the first append create its own head
    const N = 6;
    const flag = config.requireTransactions;
    const originalAdmin = Object.getOwnPropertyDescriptor(mongoose.connection.db, 'admin');
    const originalInsert = heads().insertOne;
    config.requireTransactions = false;
    resetTransactionCapabilityCache();
    mongoose.connection.db.admin = () => ({ command: async () => ({ isWritablePrimary: true }) });
    let arrived = 0;
    let open;
    const everyoneArrived = new Promise((resolve) => { open = resolve; });
    heads().insertOne = async function barrier(...args) {
      arrived += 1;
      if (arrived === N) open();
      if (arrived <= N) await everyoneArrived; // nobody creates the head until all N have found none
      return originalInsert.apply(this, args);
    };
    try {
      const settled = await Promise.allSettled(Array.from({ length: N }, (_, i) => auditService.log(params(i + 1))));
      assert.deepEqual(settled.filter((r) => r.status === 'rejected').map((r) => r.reason.code ?? r.reason.message), [], 'the losers retry from the winner\'s head');
      assert.equal(arrived, N, 'exactly the N first callers tried to create the head');
    } finally {
      heads().insertOne = originalInsert;
      if (originalAdmin) Object.defineProperty(mongoose.connection.db, 'admin', originalAdmin); else delete mongoose.connection.db.admin;
      config.requireTransactions = flag;
      resetTransactionCapabilityCache();
    }
    assert.equal(await heads().countDocuments({}), 1);
    await assertSound('fallback first appends', { expectedRecords: N });
    assert.equal((await headDoc()).version, N + 1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('G3 — the mode policy, readiness that fails closed, the bootstrap on loopback only, nested audited transactions, the retry budget, a consistent verifyHead, the validator and the specification pins', () => {
  beforeEach(() => resetAll());

  const CONFIG_URL = pathToFileURL(path.join(BACKEND, 'src/config/environment.js')).href;
  const ready = async () => {
    app.locals.resetAuditReadiness();
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ready`);
      const text = await response.text();
      return { status: response.status, text, body: JSON.parse(text) };
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => { server.close(resolve); });
    }
  };

  // ── the mode policy ──
  test('the protocol-mode policy is an ALLOW-LIST: only development/test with an unset or explicit false flag are relaxed; production, anything unrecognized and any flag value it does not understand are strict', () => {
    const FORCING = ['true', 'TRUE', ' True ', '1', 'yes'];
    const NOT_FORCING = [undefined, '', 'false', 'FALSE', '0', 'no'];
    const UNKNOWN = ['maybe', 'enabled', 'on', 'y', '2'];
    for (const environmentClass of ['production', 'unrecognized', undefined, 'staging']) {
      for (const strictFlag of [...FORCING, ...NOT_FORCING, ...UNKNOWN]) assert.equal(resolveAuditChainPolicy({ environmentClass, strictFlag }).strict, true, `${environmentClass} ${strictFlag}`);
    }
    for (const environmentClass of ['development', 'test']) {
      for (const strictFlag of NOT_FORCING) assert.equal(resolveAuditChainPolicy({ environmentClass, strictFlag }).strict, false, `${environmentClass} ${strictFlag}`);
      for (const strictFlag of [...FORCING, ...UNKNOWN]) assert.equal(resolveAuditChainPolicy({ environmentClass, strictFlag }).strict, true, `${environmentClass} ${strictFlag}`);
    }
    assert.ok(resolveAuditChainPolicy({ environmentClass: 'test', strictFlag: 'maybe' }).notes.some((note) => /not understood/.test(note)), 'a flag it does not understand says so');
    const requested = resolveAuditChainPolicy({ environmentClass: 'test', strictFlag: 'true' }).notes;
    assert.ok(requested.some((note) => /requests the strict/.test(note)) && !requested.some((note) => /not understood/.test(note)), 'a flag it understands is reported as a request, not as an error');
    assert.ok(resolveAuditChainPolicy({ environmentClass: 'production' }).notes.some((note) => /not "development" or "test"/.test(note)));
    assert.throws(() => { resolveAuditChainPolicy({}).notes.push('x'); }, TypeError, 'the policy is immutable');
  });

  test('the REAL config module derives the mode from NODE_ENV and AUDIT_CHAIN_STRICT (child processes): production, unset, unrecognized and misspelled environments are strict whatever the flag says', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'payguard-head-config-')); // no .env here: nothing but the passed environment
    try {
      const strictOf = (env) => {
        const script = `const { default: c } = await import(${JSON.stringify(CONFIG_URL)}); console.log('R=' + JSON.stringify({ strict: c.auditChainStrict }));`;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
          cwd, encoding: 'utf8',
          env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, FRONTEND_URL: 'http://localhost:5173', JWT_SECRET: 'x'.repeat(40), MONGO_URI: 'mongodb://127.0.0.1:27018/payguard_config_probe', ...env },
        });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(/R=(.*)/.exec(result.stdout)[1]).strict;
      };
      const cases = [
        [{ NODE_ENV: 'production' }, true],
        [{ NODE_ENV: 'production', AUDIT_CHAIN_STRICT: 'false' }, true],
        [{}, true],
        [{ AUDIT_CHAIN_STRICT: 'false' }, true],
        [{ NODE_ENV: 'staging', AUDIT_CHAIN_STRICT: 'false' }, true],
        [{ NODE_ENV: 'Production' }, true],
        [{ NODE_ENV: 'productoin', AUDIT_CHAIN_STRICT: 'false' }, true],
        [{ NODE_ENV: 'development' }, false],
        [{ NODE_ENV: 'test' }, false],
        [{ NODE_ENV: 'test', AUDIT_CHAIN_STRICT: 'false' }, false],
        [{ NODE_ENV: 'development', AUDIT_CHAIN_STRICT: 'true' }, true],
        [{ NODE_ENV: 'development', AUDIT_CHAIN_STRICT: '1' }, true],
        [{ NODE_ENV: 'development', AUDIT_CHAIN_STRICT: 'maybe' }, true],
      ];
      for (const [env, expected] of cases) assert.equal(strictOf(env), expected, JSON.stringify(env));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('an unknown protocol mode is an ERROR, never silently relaxed: nothing is bootstrapped, nothing is written', async () => {
    auditService._modeOverride = 'Strict';
    try {
      assert.throws(() => auditService.protocolMode(), /unknown audit chain protocol mode "Strict"/);
      await assert.rejects(auditService.logStandalone(params(1)), /unknown audit chain protocol mode/);
      await assert.rejects(auditService.protocolStatus({ checkBuilds: false }), /unknown audit chain protocol mode/);
    } finally {
      auditService._modeOverride = null;
    }
    assert.equal(await heads().countDocuments({}), 0);
    assert.equal(await AuditLog.collection.countDocuments({}), 0);
  });

  test('the relaxed genesis bootstrap happens only on a LOOPBACK database: connected to anything else an empty chain is NOT given a head (AUDIT_CHAIN_NOT_INITIALIZED) and the status calls it an error, not a warning', async () => {
    await withReportedHosts([{ host: 'db.shared.example.invalid', port: 27017 }], async () => {
      await assert.rejects(auditService.logStandalone(params(1)), (e) => e.code === 'AUDIT_CHAIN_NOT_INITIALIZED' && /loopback/.test(e.message));
      const status = await auditService.protocolStatus({ checkBuilds: false });
      assert.ok(status.issues.some((i) => i.severity === 'error' && i.code === 'HEAD_MISSING'), JSON.stringify(status.issues));
      assert.ok(!status.issues.some((i) => i.code === 'HEAD_NOT_YET_CREATED'));
      assert.equal(status.ok, false);
    });
    await withReportedHosts([{ host: '127.0.0.1', port: 27018 }, { host: 'db.shared.example.invalid', port: 27017 }], async () => {
      await assert.rejects(auditService.logStandalone(params(1)), (e) => e.code === 'AUDIT_CHAIN_NOT_INITIALIZED' && /loopback/.test(e.message), 'one loopback host among remote ones is not a local database');
    });
    assert.equal(await heads().countDocuments({}), 0, 'no head was invented');
    const first = await auditService.logStandalone(params(2));
    assert.equal(first.sequenceNumber, 1, 'on the loopback database the same call bootstraps');
  });

  // ── readiness ──
  test('readiness fails CLOSED when the status computation throws: 503, a fixed code, and no driver text (hosts, namespaces) reaches an unauthenticated caller', async () => {
    const original = auditService.protocolStatus;
    auditService.protocolStatus = async () => { throw new Error('connect ECONNREFUSED 10.1.2.3:27017 while reading secret-host.internal/payroll.auditlogs'); };
    try {
      const { status, body, text } = await ready();
      assert.equal(status, 503);
      assert.deepEqual(body.auditChain.issues, ['error:STATUS_UNAVAILABLE']);
      assert.equal(body.auditChain.ok, false);
      assert.ok(!/secret-host|10\.1\.2\.3|auditlogs/.test(text), 'the response carries no infrastructure detail');
    } finally {
      auditService.protocolStatus = original;
    }
    assert.equal((await ready()).status, 200, 'and it recovers when the status works again');
  });

  test('readiness fails closed when the status does not finish in time (STATUS_TIMEOUT), and a probe that arrives while that run is still going SHARES it instead of starting another', async () => {
    const original = auditService.protocolStatus;
    const real = await original.call(auditService, { checkBuilds: false });
    let calls = 0;
    let slow;
    auditService.protocolStatus = () => { calls += 1; slow = new Promise((resolve) => { setTimeout(() => resolve(real), 3600); }); return slow; };
    try {
      const first = await ready();
      assert.equal(first.status, 503);
      assert.deepEqual(first.body.auditChain.issues, ['error:STATUS_TIMEOUT']);
      const second = await ready(); // the first run is still in progress
      assert.equal(calls, 1, 'one computation, however many probes');
      assert.equal(second.status, 200, 'the shared run finished and answered');
    } finally {
      await slow;
      auditService.protocolStatus = original;
    }
  });

  test('concurrent readiness probes share ONE status computation (single flight)', async () => {
    const original = auditService.protocolStatus;
    const real = await original.call(auditService, { checkBuilds: false });
    let calls = 0;
    auditService.protocolStatus = async () => { calls += 1; await sleep(300); return real; };
    app.locals.resetAuditReadiness();
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/api/ready`;
      const responses = await Promise.all(Array.from({ length: 6 }, () => fetch(url)));
      assert.deepEqual(responses.map((r) => r.status), [200, 200, 200, 200, 200, 200]);
      assert.equal(calls, 1);
    } finally {
      auditService.protocolStatus = original;
      server.closeAllConnections?.();
      await new Promise((resolve) => { server.close(resolve); });
    }
  });

  test('readiness reports the transaction lane (enabled, busy, queued, heldMs) without letting it decide; the unauthenticated response carries no label of the work holding it', async () => {
    let started;
    const holderStarted = new Promise((resolve) => { started = resolve; });
    let finish;
    const holder = runInTransaction(async () => { started(); await new Promise((resolve) => { finish = resolve; }); }, { label: 'secret-internal-label' });
    await holderStarted;
    const waiter = runInTransaction(async () => 'late', { label: 'waiting-work' });
    const deadline = Date.now() + 5000;
    while (transactionLaneStatus().queued < 1 && Date.now() < deadline) await sleep(5);
    try {
      const { status, body, text } = await ready();
      assert.equal(status, 200, 'a busy lane is information, not unreadiness');
      assert.deepEqual(Object.keys(body.transactionLane).sort(), ['busy', 'enabled', 'heldMs', 'queued']);
      assert.equal(body.transactionLane.enabled, true);
      assert.equal(body.transactionLane.busy, true);
      assert.equal(body.transactionLane.queued, 1);
      assert.equal(typeof body.transactionLane.heldMs, 'number');
      assert.ok(!/secret-internal-label|waiting-work/.test(text));
      assert.equal(transactionLaneStatus().holder.label, 'secret-internal-label', 'operators inside the process can see who holds it');
    } finally {
      finish();
      await Promise.all([holder, waiter]);
    }
    assert.deepEqual({ busy: transactionLaneStatus().busy, queued: transactionLaneStatus().queued, holder: transactionLaneStatus().holder }, { busy: false, queued: 0, holder: null });
  });

  // ── transactions ──
  test('an audited append inside a transaction that was started from inside another transaction callback is refused (AUDIT_NESTED_TRANSACTION): nothing is written, the outer business write rolls back; a nested transaction WITHOUT an audit event is still allowed', async () => {
    await auditService.logStandalone(params(0));
    const before = [await records(), await headDoc()];
    await assert.rejects(runInTransaction(async (outer) => {
      await scratch().insertOne({ marker: 'outer' }, { session: outer });
      await runInTransaction(async (inner) => { await auditService.log(params(1), inner); }, { label: 'inner' });
    }, { label: 'outer' }), (e) => e.code === 'AUDIT_NESTED_TRANSACTION' && /started from inside another transaction callback/.test(e.message));
    assert.deepEqual([await records(), await headDoc()], before);
    assert.equal(await scratch().countDocuments({ marker: 'outer' }), 0);
    const outcome = await runInTransaction(async () => runInTransaction(async (session) => { await scratch().insertOne({ nested: 'ok' }, { session }); return 'done'; }, { label: 'inner-ok' }), { label: 'outer-ok' });
    assert.equal(outcome, 'done');
    assert.equal(await scratch().countDocuments({ nested: 'ok' }), 1);
  });

  test('a FAILED capability probe is not remembered as "no transactions": the next call asks again and gets the truth', async () => {
    const original = Object.getOwnPropertyDescriptor(mongoose.connection.db, 'admin');
    resetTransactionCapabilityCache();
    mongoose.connection.db.admin = () => ({ command: async () => { throw new Error('simulated network blip'); } });
    try {
      assert.equal(await supportsTransactions(), false, 'unknown is reported as unavailable for THIS call');
    } finally {
      if (original) Object.defineProperty(mongoose.connection.db, 'admin', original); else delete mongoose.connection.db.admin;
    }
    assert.equal(await supportsTransactions(), true, 'and the failure was not cached');
  });

  test('logStandalone honours the retry budget it is given: with maxAttempts 2 against a held head it makes exactly 2 attempts and fails fast with the bounded 503, not the 40-attempt default', async () => {
    await auditService.logStandalone(params(0));
    const holder = await mongoose.startSession();
    holder.startTransaction();
    await auditService.log(params(1), holder); // the head is now write-locked by an uncommitted transaction
    const original = auditService.log;
    let attempts = 0;
    auditService.log = function counted(...args) { attempts += 1; return original.apply(this, args); };
    const startedAt = Date.now();
    try {
      await assert.rejects(auditService.logStandalone(params(2), { maxAttempts: 2, maxWaitMs: 60_000 }), (e) => e.code === 'AUDIT_CHAIN_CONTENTION' && e.statusCode === 503 && e.attempts === 2);
    } finally {
      auditService.log = original;
      await holder.abortTransaction();
      await holder.endSession();
    }
    assert.equal(attempts, 2);
    assert.ok(Date.now() - startedAt < 8000, 'it did not spend the default budget');
    await assertSound('after the bounded refusal', { expectedRecords: 1 });
  });

  // ── verifyHead is one snapshot ──
  test('verifyHead reads the head and the newest record in ONE snapshot: an append that commits between the two reads cannot make a healthy chain look broken', async () => {
    await auditService.logStandalone(params(0));
    const original = heads().findOne;
    let injected = false;
    heads().findOne = async function racing(...args) {
      const result = await original.apply(this, args);
      if (!injected) { injected = true; await auditService.logStandalone(params(99)); } // commits AFTER the head was read, BEFORE the tail is read
      return result;
    };
    let status;
    try {
      status = await auditService.verifyHead();
    } finally {
      heads().findOne = original;
    }
    assert.equal(injected, true);
    assert.equal(status.ok, true, status.reason);
    assert.equal(status.head.sequence, 1, 'both reads saw the state before the concurrent append');
    assert.equal((await auditService.verifyHead()).head.sequence, 2, 'and the next check sees the new state');
  });

  // ── the validator and the specification, independent of the module that defines them ──
  test('the VALIDATOR itself (REAL server): a missing, null, string, boolean, zero, negative, below-one, array or object headVersion is refused (code 121); numbers of at least one are accepted', async () => {
    await resetAll({ validator: true });
    const doc = (n, headVersion) => ({ sequenceNumber: n, previousHash: `p${n}`, hash: `h${n}`, action: 'X', ...(headVersion !== undefined && { headVersion }) });
    let n = 1000;
    for (const [label, value] of [['missing', undefined], ['null', null], ['string', '2'], ['boolean', true], ['zero', 0], ['negative', -1], ['below one', 0.5], ['array', [2]], ['object', { a: 1 }]]) {
      await assert.rejects(AuditLog.collection.insertOne(doc(n += 1, value)), (e) => e.code === 121, `${label} must be refused`);
    }
    for (const value of [1, 2, 2.5, 1e9]) await AuditLog.collection.insertOne(doc(n += 1, value));
    assert.equal(await AuditLog.collection.countDocuments({}), 4, 'only the four numbers of at least one were stored');
  });

  test('the SPECIFICATION is pinned literally in this file, independent of the module under test: three unique indexes with exactly these options, this exact validator, these exact validation options', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(REQUIRED_VALIDATOR)), { $jsonSchema: { bsonType: 'object', required: ['headVersion'], properties: { headVersion: { bsonType: ['int', 'long', 'double', 'decimal'], minimum: 1 } } } });
    assert.deepEqual({ ...VALIDATION_OPTIONS }, { validationLevel: 'moderate', validationAction: 'error' });
    assert.deepEqual(REQUIRED_INDEXES.map((r) => ({ key: { ...r.key }, name: r.name, unique: r.unique, partial: r.partialFilterExpression && JSON.parse(JSON.stringify(r.partialFilterExpression)) })), [
      { key: { sequenceNumber: 1 }, name: 'sequenceNumber_1', unique: true, partial: null },
      { key: { previousHash: 1 }, name: 'previousHash_unique_successor', unique: true, partial: { previousHash: { $type: 'string' } } },
      { key: { headVersion: 1 }, name: 'headVersion_unique_transition', unique: true, partial: { headVersion: { $type: 'number' } } },
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('H — the per-process transaction lane (liveness only; safety never depends on it)', () => {
  beforeEach(async () => { await resetAll(); await auditService.logStandalone(params(0)); });

  const auditedTransaction = (executions, i) => runInTransaction(async (session) => {
    executions.count += 1;
    await scratch().insertOne({ i }, { session });
    return auditService.log(params(i), session);
  }, { label: 'h' });

  test('WITH the lane, 40 concurrent audited transactions of one process commit with exactly ONE callback execution each: no write conflicts, no re-runs', async () => {
    const executions = { count: 0 };
    const settled = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => auditedTransaction(executions, i)));
    assert.deepEqual(settled.filter((r) => r.status === 'rejected').map((r) => r.reason.code), []);
    assert.equal(executions.count, 40, 'every callback ran exactly once');
    assert.equal(await scratch().countDocuments({}), 40);
    await assertSound('lane on', { expectedRecords: 41 });
  });

  test('WITHOUT the lane the same load is still SAFE (no fork, no duplicate business write) but re-runs callbacks: the lane buys throughput, not correctness', async () => {
    transactionLane.enabled = false;
    try {
      const executions = { count: 0 };
      const settled = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => auditedTransaction(executions, i)));
      const committed = settled.filter((r) => r.status === 'fulfilled').length;
      for (const r of settled.filter((x) => x.status === 'rejected')) assert.equal(r.reason.code, 'AUDIT_CHAIN_CONTENTION');
      assert.ok(committed > 0, 'progress is made even without the lane');
      assert.ok(executions.count >= committed, 'callbacks were re-run to resolve conflicts');
      assert.equal(await scratch().countDocuments({}), committed, 'but each committed operation wrote its business document exactly once');
      await assertSound('lane off', { expectedRecords: 1 + committed });
    } finally {
      transactionLane.enabled = true;
    }
  });

  test('the lane is FIFO and a waiter that waits too long gets a retryable 503 TRANSACTION_LANE_BUSY with nothing written (a long transaction cannot block its process forever)', async () => {
    let finishFirst;
    const firstMayFinish = new Promise((resolve) => { finishFirst = resolve; });
    let started;
    const firstStarted = new Promise((resolve) => { started = resolve; });
    const order = [];
    const first = runInTransaction(async (session) => { started(); await firstMayFinish; order.push('first'); await scratch().insertOne({ who: 'first' }, { session }); }, { label: 'long' });
    const queued = [];
    await firstStarted;
    const savedWait = transactionLane.maxQueueWaitMs;
    transactionLane.maxQueueWaitMs = 150;
    try {
      await assert.rejects(runInTransaction(async (session) => { order.push('late'); await scratch().insertOne({ who: 'late' }, { session }); }, { label: 'short' }), (e) => e.code === 'TRANSACTION_LANE_BUSY' && e.statusCode === 503 && e.retryable === true);
      transactionLane.maxQueueWaitMs = savedWait;
      const second = runInTransaction(async (session) => { order.push('second'); await scratch().insertOne({ who: 'second' }, { session }); }, { label: 'second' });
      const third = runInTransaction(async (session) => { order.push('third'); await scratch().insertOne({ who: 'third' }, { session }); }, { label: 'third' });
      queued.push(second, third);
      finishFirst();
      await Promise.all([first, second, third]);
    } finally {
      transactionLane.maxQueueWaitMs = savedWait;
      finishFirst(); // a failed assertion above must never leave the lane held for the tests that follow
      await Promise.allSettled([first, ...queued]);
    }
    assert.deepEqual(order, ['first', 'second', 'third'], 'first come, first served; the refused waiter never ran its callback');
    assert.deepEqual((await scratch().find({}).toArray()).map((d) => d.who).sort(), ['first', 'second', 'third']);
  });

  test('a transaction started from INSIDE another does not wait for the lane its caller holds (no deadlock); it still runs as an independent transaction, as before', async () => {
    const result = await Promise.race([
      runInTransaction(async () => runInTransaction(async (session) => { await scratch().insertOne({ nested: true }, { session }); return 'inner done'; }, { label: 'inner' }), { label: 'outer' }),
      sleep(10_000).then(() => 'DEADLOCK'),
    ]);
    assert.equal(result, 'inner done');
    assert.equal(await scratch().countDocuments({ nested: true }), 1);
  });

  test('the lane is released after a failure and after a refusal: a failing transaction does not block the next one', async () => {
    await assert.rejects(runInTransaction(async () => { throw new Error('boom'); }, { label: 'fails' }), /boom/);
    await assert.rejects(runInTransaction(async () => { throw Object.assign(new Error('conflict'), { code: 112, errorLabels: new Set(['TransientTransactionError']) }); }, { label: 'conflicts', maxAttempts: 2, maxWaitMs: 1000 }), (e) => e.code === 112);
    const after = await Promise.race([runInTransaction(async () => 'ok', { label: 'after' }), sleep(5000).then(() => 'STUCK')]);
    assert.equal(after, 'ok');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('I — head verification and the specification evaluators, one disagreement / one option at a time', () => {
  beforeEach(async () => { await resetAll(); for (let i = 1; i <= 3; i += 1) await auditService.logStandalone(params(i)); });

  const expectHead = async (mutate, code, { restoredIsConsistent = true } = {}) => {
    const original = await headDoc();
    await mutate();
    try {
      const result = await auditService.verifyHead();
      assert.equal(result.ok, false);
      assert.equal(result.code, code, result.reason);
      assert.ok(result.reason.length > 10, 'a human-readable reason');
    } finally {
      await heads().replaceOne({ _id: 'global' }, original, { upsert: true });
    }
    if (restoredIsConsistent) assert.equal((await auditService.verifyHead()).ok, true, 'restored');
  };

  test('verifyHead names each kind of disagreement between the head and the chain', async () => {
    assert.equal((await auditService.verifyHead()).ok, true);
    await expectHead(() => heads().updateOne({ _id: 'global' }, { $set: { sequence: 4 } }), 'HEAD_SEQUENCE_MISMATCH');
    await expectHead(() => heads().updateOne({ _id: 'global' }, { $set: { hash: 'd'.repeat(64) } }), 'HEAD_HASH_MISMATCH');
    await expectHead(() => heads().updateOne({ _id: 'global' }, { $set: { version: 9 } }), 'HEAD_VERSION_MISMATCH');
    await expectHead(() => heads().deleteOne({ _id: 'global' }), 'HEAD_MISSING');
    await AuditLog.collection.deleteMany({});
    await expectHead(() => heads().updateOne({ _id: 'global' }, { $set: { sequence: 5 } }), 'HEAD_AHEAD_OF_CHAIN', { restoredIsConsistent: false }); // the records are gone, so the original head is itself ahead of an empty chain
  });

  test('after a cutover with no new record, the head must still be at version 1 with the baseline at the tail; anything else is reported', async () => {
    await heads().deleteMany({});
    await AuditLog.collection.updateMany({}, { $unset: { headVersion: 1 } });
    const plan = await planHeadInitialization({ quietSeconds: 0 });
    await applyHeadInitialization({ expectedDigest: plan.digest, operator: 'tester', quietSeconds: 0 });
    assert.equal((await auditService.verifyHead()).ok, true);
    await expectHead(() => heads().updateOne({ _id: 'global' }, { $set: { version: 2 } }), 'HEAD_VERSION_MISMATCH');
    await expectHead(() => heads().updateOne({ _id: 'global' }, { $set: { 'baseline.sequence': 2 } }), 'HEAD_VERSION_MISMATCH');
  });

  const REQUIRED = Object.fromEntries(REQUIRED_INDEXES.map((r) => [r.id, r]));
  const liveOf = (id, overrides = {}) => {
    const r = REQUIRED[id];
    const live = { v: 2, key: { ...r.key }, name: r.name, unique: true, ...(r.partialFilterExpression && { partialFilterExpression: JSON.parse(JSON.stringify(r.partialFilterExpression)) }) };
    return Object.assign(live, overrides);
  };
  const statusOf = (id, overrides) => evaluateIndexes(REQUIRED_INDEXES.map((r) => (r.id === id ? liveOf(id, overrides) : liveOf(r.id)))).find((row) => row.id === id).status;

  test('every option that changes WHICH documents an index constrains makes it INCOMPATIBLE, for each of the three indexes; the name does not matter', () => {
    for (const id of ['sequence', 'predecessor', 'headVersion']) {
      assert.equal(statusOf(id, {}), 'OK', `${id} exact`);
      assert.equal(statusOf(id, { name: 'some_other_name' }), 'OK', `${id}: a different name with the exact specification is fine`);
      assert.equal(statusOf(id, { unique: false }), 'INCOMPATIBLE', `${id}: not unique`);
      assert.equal(statusOf(id, { unique: undefined }), 'INCOMPATIBLE', `${id}: unique absent`);
      assert.equal(statusOf(id, { sparse: true }), 'INCOMPATIBLE', `${id}: sparse`);
      assert.equal(statusOf(id, { collation: { locale: 'en' } }), 'INCOMPATIBLE', `${id}: collation`);
      assert.equal(statusOf(id, { expireAfterSeconds: 60 }), 'INCOMPATIBLE', `${id}: TTL`);
      assert.equal(statusOf(id, { hidden: true }), 'INCOMPATIBLE', `${id}: hidden`);
      assert.equal(statusOf(id, { buildUUID: 'abc' }), 'INCOMPATIBLE', `${id}: unfinished build marker`);
      assert.equal(statusOf(id, { partialFilterExpression: { somethingElse: { $type: 'string' } } }), 'INCOMPATIBLE', `${id}: a different partial filter`);
      const key = Object.keys(REQUIRED[id].key)[0];
      assert.equal(statusOf(id, { key: { [key]: -1 } }), 'MISSING', `${id}: a descending key is a different index`);
      assert.equal(statusOf(id, { key: { [key]: 1, extra: 1 } }), 'MISSING', `${id}: a compound key is a different index`);
    }
    assert.equal(statusOf('sequence', { partialFilterExpression: { sequenceNumber: { $type: 'number' } } }), 'INCOMPATIBLE', 'a partial filter where none is allowed');
    assert.deepEqual(evaluateIndexes([]).map((r) => r.status), ['MISSING', 'MISSING', 'MISSING']);
  });

  test('the validator must be EXACTLY the required one: absent, different, a warning-only action, or switched off are all refused', () => {
    assert.equal(evaluateValidator(undefined).status, 'MISSING');
    assert.equal(evaluateValidator({}).status, 'MISSING');
    const exact = { validator: JSON.parse(JSON.stringify(REQUIRED_VALIDATOR)), validationLevel: 'moderate', validationAction: 'error' };
    assert.equal(evaluateValidator(exact).status, 'OK');
    assert.equal(evaluateValidator({ ...exact, validator: { $jsonSchema: { bsonType: 'object', required: ['other'] } } }).status, 'INCOMPATIBLE');
    assert.equal(evaluateValidator({ ...exact, validationAction: 'warn' }).status, 'INCOMPATIBLE');
    assert.equal(evaluateValidator({ ...exact, validationLevel: 'off' }).status, 'INCOMPATIBLE');
    assert.equal(evaluateValidator({ validator: exact.validator }).status, 'OK', 'defaults (strict level, error action) are acceptable');
  });

  test('key ORDER matters for a compound key: the same fields in another order (or another direction) is a different index (indexMismatch is generic; the three required keys are single-field)', () => {
    const required = { key: { a: 1, b: 1 }, partialFilterExpression: null };
    const live = (key) => ({ key, unique: true });
    assert.equal(indexMismatch(live({ a: 1, b: 1 }), required), null);
    assert.match(indexMismatch(live({ b: 1, a: 1 }), required), /different key/);
    assert.match(indexMismatch(live({ a: 1, b: -1 }), required), /different key/);
    assert.match(indexMismatch(live({ a: 1 }), required), /different key/);
  });
});
