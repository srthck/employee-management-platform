/**
 * test_integrity_phase0.js — Phase 0 containment of the integrity program (docs/integrity/CLAIMS-LEDGER.md).
 *
 * Runner: node:test.  Run: node --test test_integrity_phase0.js   (or the full suite: npm test)
 * Real MongoDB replica set, isolated database (INTEGRITY_P0_MONGO_URI), dropped before and after.
 *
 * A — transaction policy: the non-transactional fallback needs BOTH an exact development/test NODE_ENV AND a
 *     loopback-only database; an unknown or misspelled environment is strict; tools that destroy data need REAL
 *     transactions whatever the configuration says; readiness shows the policy.
 * B — startup never rewrites audit history; legacy records are only reported.
 * C — the explicit legacy-chain migration: preflight refusals, an exact reviewed plan, conditional per-record
 *     fills, interruption and resume, never touching a record that is already chained.
 * D — the migration CLI: dry run by default, creates no collection, apply bound to the reviewed digest and the
 *     named database.
 *
 * Tests assert persisted state (documents, collection listings), never merely "an error was thrown".
 * Failure SIMULATIONS are named as such in the test title; nothing here claims a real server fault it did not cause.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mongoose from 'mongoose';

const TEST_DB_URI = process.env.INTEGRITY_P0_MONGO_URI || 'mongodb://127.0.0.1:27018/payguard_integrity_p0_test?replicaSet=rs0';

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.MONGO_URI = TEST_DB_URI;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'integrity-phase0-test-secret-long-enough';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.FIELD_ENCRYPTION_KEYS = `v1:${crypto.randomBytes(32).toString('base64')}`;
process.env.FIELD_ENCRYPTION_ACTIVE_KEY = 'v1';
process.env.FIELD_BLIND_INDEX_KEY = crypto.randomBytes(32).toString('hex');

const BACKEND = fileURLToPath(new URL('.', import.meta.url));
const SERVER = path.join(BACKEND, 'server.js');
const BACKFILL_CLI = path.join(BACKEND, 'scripts/audit-chain-legacy-backfill.mjs');
const CONFIG_URL = pathToFileURL(path.join(BACKEND, 'src/config/environment.js')).href;

const { default: app } = await import('./src/app.js');
const { default: AuditLog } = await import('./src/models/AuditLog.js');
const { default: auditService, GENESIS_HASH } = await import('./src/services/auditService.js');
const { assertRealTransactions, supportsTransactions, resetTransactionCapabilityCache, runInTransaction } = await import('./src/utils/transaction.js');
const { resolveTransactionPolicy, mongoHosts, isLoopbackOnlyUri } = await import('./src/config/transactionPolicy.js');

const dbNameOf = (uri) => new URL(uri.replace(/^mongodb:\/\//, 'http://')).pathname.slice(1);
const withDb = (uri, name) => uri.replace(`/${dbNameOf(uri)}`, `/${name}`);
const sha = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

let server;
let baseUrl;

before(async () => {
  await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 5000 });
  await mongoose.connection.dropDatabase();
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
// A — transaction policy
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe('A — transaction policy: no silent fallback', () => {
  const LOOPBACK = 'mongodb://127.0.0.1:27018/x?replicaSet=rs0';
  const REMOTE = 'mongodb://db.prod.example.com:27017/payroll?replicaSet=rs0';

  test('the opt-out is honoured ONLY for an exact development/test NODE_ENV against a loopback-only database; every other combination is strict', () => {
    const honoured = [
      ['development', 'false', LOOPBACK],
      ['test', 'false', LOOPBACK],
      ['development', 'false', 'mongodb://localhost:27017/x'],
      ['test', 'false', 'mongodb://u:p%40ss@[::1]:27017,127.0.0.2:27018/x?replicaSet=rs0'],
    ];
    for (const [nodeEnv, flag, uri] of honoured) {
      const policy = resolveTransactionPolicy({ nodeEnv, requireTransactionsFlag: flag, mongoUri: uri });
      assert.equal(policy.requireTransactions, false, `${nodeEnv} ${uri}`);
      assert.equal(policy.optOutHonoured, true);
    }
    const strict = [
      // environment
      [undefined, 'false', LOOPBACK], ['', 'false', LOOPBACK], ['production', 'false', LOOPBACK], ['Production', 'false', LOOPBACK],
      ['prod', 'false', LOOPBACK], ['productoin', 'false', LOOPBACK], ['staging', 'false', LOOPBACK], ['Development', 'false', LOOPBACK],
      [' development', 'false', LOOPBACK], ['test ', 'false', LOOPBACK], ['__proto__', 'false', LOOPBACK], ['constructor', 'false', LOOPBACK],
      // database
      ['development', 'false', REMOTE], ['test', 'false', REMOTE], ['development', 'false', undefined], ['development', 'false', ''],
      ['development', 'false', 'mongodb+srv://cluster0.example.mongodb.net/x'], ['development', 'false', 'mongodb://localhost:1,db.example.com:2/x'],
      ['development', 'false', 'mongodb://127.0.0.1.evil.example.com/x'], ['development', 'false', 'mongodb://localhost.evil.example.com/x'],
      ['development', 'false', 'postgres://127.0.0.1/x'], ['development', 'false', 'not a uri'],
      // flag
      ['development', undefined, LOOPBACK], ['development', 'true', LOOPBACK], ['development', 'no', LOOPBACK], ['development', 'FALSE', LOOPBACK], ['development', ' false', LOOPBACK],
    ];
    for (const [nodeEnv, flag, uri] of strict) {
      const policy = resolveTransactionPolicy({ nodeEnv, requireTransactionsFlag: flag, mongoUri: uri });
      assert.equal(policy.requireTransactions, true, `${JSON.stringify([nodeEnv, flag, uri])} must be strict`);
      assert.equal(policy.optOutHonoured, false);
    }
    assert.equal(resolveTransactionPolicy({}).requireTransactions, true, 'no input at all is strict');
  });

  test('an unrecognized NODE_ENV is reported, and a requested but ignored opt-out says WHY (visible in the policy, hence in logs and readiness)', () => {
    const unknown = resolveTransactionPolicy({ nodeEnv: 'staging', requireTransactionsFlag: 'false', mongoUri: LOOPBACK });
    assert.equal(unknown.environmentClass, 'unrecognized');
    assert.equal(unknown.optOutRequested, true);
    assert.ok(unknown.notes.some((note) => /not exactly "production", "development" or "test"/.test(note)));
    assert.ok(unknown.notes.some((note) => /REQUIRE_TRANSACTIONS=false ignored: NODE_ENV "staging"/.test(note)));
    const remote = resolveTransactionPolicy({ nodeEnv: 'development', requireTransactionsFlag: 'false', mongoUri: REMOTE });
    assert.ok(remote.notes.some((note) => /ignored: the database URI is not loopback-only/.test(note)));
    const honoured = resolveTransactionPolicy({ nodeEnv: 'test', requireTransactionsFlag: 'false', mongoUri: LOOPBACK });
    assert.ok(honoured.notes.some((note) => /honoured/.test(note)));
    assert.equal(resolveTransactionPolicy({ nodeEnv: 'production' }).environmentClass, 'production');
    assert.deepEqual(mongoHosts('mongodb://u:p@a:1,b:2/db?x=1'), ['a', 'b']);
    assert.equal(isLoopbackOnlyUri('mongodb://127.0.0.1.evil.example.com/x'), false);
    assert.throws(() => { resolveTransactionPolicy({}).notes.push('x'); }, TypeError, 'the policy is immutable');
  });

  test('the REAL config module applies the policy: staging, unset, Production, prod, a typo and a remote database stay strict with REQUIRE_TRANSACTIONS=false; development/test + loopback is the only opt-out', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'payguard-p0-config-')); // no .env here: nothing but the passed environment
    try {
      const load = (env) => {
        const script = `const { default: c } = await import(${JSON.stringify(CONFIG_URL)}); console.log('R=' + JSON.stringify({ r: c.requireTransactions, e: c.transactionPolicy.environmentClass, h: c.transactionPolicy.optOutHonoured }));`;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
          cwd, encoding: 'utf8',
          env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, FRONTEND_URL: 'http://localhost:5173', JWT_SECRET: 'x'.repeat(40), ...env },
        });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(/R=(.*)/.exec(result.stdout)[1]);
      };
      const off = { REQUIRE_TRANSACTIONS: 'false' };
      assert.deepEqual(load({ ...off, NODE_ENV: 'development', MONGO_URI: LOOPBACK }), { r: false, e: 'development', h: true });
      assert.deepEqual(load({ ...off, NODE_ENV: 'test', MONGO_URI: LOOPBACK }), { r: false, e: 'test', h: true });
      for (const nodeEnv of [undefined, 'staging', 'Production', 'prod', 'productoin']) {
        const result = load({ ...off, ...(nodeEnv && { NODE_ENV: nodeEnv }), MONGO_URI: LOOPBACK });
        assert.equal(result.r, true, `NODE_ENV=${nodeEnv}`);
        assert.equal(result.h, false);
      }
      assert.equal(load({ ...off, NODE_ENV: 'production', MONGO_URI: LOOPBACK }).r, true);
      assert.equal(load({ ...off, NODE_ENV: 'development', MONGO_URI: REMOTE }).r, true, 'a remote database never gets the fallback');
      assert.equal(load({ ...off, NODE_ENV: 'development' }).r, true, 'an unknown database never gets the fallback');
      assert.equal(load({ NODE_ENV: 'development', MONGO_URI: LOOPBACK }).r, true, 'without the explicit opt-out: strict');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('destructive tools need REAL transactions whatever the configuration says; ordinary requests refuse too (SIMULATED standalone server: the hello reply is stubbed)', async () => {
    assert.equal(await supportsTransactions(), true, 'precondition: the test server is a replica set');
    await assertRealTransactions(); // does not throw on a replica set
    const original = Object.getOwnPropertyDescriptor(mongoose.connection.db, 'admin');
    resetTransactionCapabilityCache();
    mongoose.connection.db.admin = () => ({ command: async () => ({ isWritablePrimary: true }) }); // no setName, not mongos: a standalone
    try {
      await assert.rejects(assertRealTransactions(), (error) => error.code === 'TRANSACTIONS_UNAVAILABLE' && error.statusCode === 503 && error.retryable === false);
      await assert.rejects(runInTransaction(async () => 'must not run'), (error) => error.statusCode === 503 && /requires MongoDB transactions/.test(error.message));
      const ready = await fetch(`${baseUrl.replace('/api', '')}/api/ready`);
      assert.equal(ready.status, 503, 'readiness fails while transactions are unavailable and required');
      const body = await ready.json();
      assert.equal(body.status, 'not_ready');
      assert.equal(body.transactions, 'unavailable');
      assert.deepEqual(Object.keys(body.transactionPolicy).sort(), ['environmentClass', 'optOutHonoured', 'optOutRequested', 'requireTransactions']);
      assert.equal(body.transactionPolicy.requireTransactions, true);
    } finally {
      if (original) Object.defineProperty(mongoose.connection.db, 'admin', original); else delete mongoose.connection.db.admin;
      resetTransactionCapabilityCache();
    }
    assert.equal(await supportsTransactions(), true, 'restored');
    const ready = await fetch(`${baseUrl.replace('/api', '')}/api/ready`);
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).transactions, 'supported');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Audit fixtures shared by B, C and D
// ════════════════════════════════════════════════════════════════════════════════════════════════

const actorId = new mongoose.Types.ObjectId();
const resetAudit = async () => { await AuditLog.collection.drop().catch(() => {}); auditService._resetIndexGuard(); };
const dropAuditIndexes = () => AuditLog.collection.dropIndexes().catch(() => {});
const appendChained = async (count, prefix = 'CHAINED') => {
  for (let i = 1; i <= count; i += 1) await auditService.log({ action: `${prefix}_${i}`, actorId, entityType: 'TEST', entityId: new mongoose.Types.ObjectId(), meta: { i } });
};
const legacy = (action, createdAt, extra = {}) => ({ action, actorId, entityType: 'TEST', entityId: new mongoose.Types.ObjectId(), meta: {}, createdAt, updatedAt: createdAt, ...extra });
const insertLegacy = (...docs) => AuditLog.collection.insertMany(docs);
const rawAudit = () => AuditLog.collection.find({}).sort({ _id: 1 }).toArray();
const futureAt = (seconds) => new Date(Date.now() + 60_000 + seconds * 1000);
const dbShape = async (name = null) => {
  const db = name ? mongoose.connection.useDb(name, { useCache: false }).db : mongoose.connection.db;
  const shape = {};
  for (const { name: collection } of await db.listCollections().toArray()) {
    const docs = await db.collection(collection).find({}).sort({ _id: 1 }).toArray();
    shape[collection] = { count: docs.length, sha: sha(docs), indexes: (await db.collection(collection).indexes()).map((index) => index.name).sort() };
  }
  return shape;
};

// ════════════════════════════════════════════════════════════════════════════════════════════════
// B — startup never rewrites audit history
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe('B — startup never rewrites, repairs or re-seals audit history', () => {
  const freePort = () => new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });

  /** Start the REAL server.js against the test database; resolves once it logs "Server ready". */
  async function startServer(extraEnv = {}) {
    const port = await freePort();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'payguard-p0-server-')); // no .env
    const env = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      NODE_ENV: 'test', PORT: String(port), MONGO_URI: TEST_DB_URI, JWT_SECRET: process.env.JWT_SECRET, FRONTEND_URL: 'http://localhost:5173',
      RATE_LIMIT_ENABLED: 'false', LOG_LEVEL: 'info', REQUIRE_TRANSACTIONS: 'true',
      STUCK_RUN_MONITOR_INTERVAL_MS: '0', COMPENSATION_ACTIVATION_INTERVAL_MS: '0',
      FIELD_ENCRYPTION_KEYS: process.env.FIELD_ENCRYPTION_KEYS, FIELD_ENCRYPTION_ACTIVE_KEY: 'v1', FIELD_BLIND_INDEX_KEY: process.env.FIELD_BLIND_INDEX_KEY,
      ...extraEnv,
    };
    const child = spawn(process.execPath, [SERVER], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = [];
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => String(chunk).split(/\r?\n/).filter(Boolean).forEach((line) => lines.push(line)));
    const stop = async () => {
      child.kill();
      await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
      fs.rmSync(cwd, { recursive: true, force: true });
    };
    const deadline = Date.now() + 30_000;
    while (!lines.some((line) => line.includes('"Server ready"')) && Date.now() < deadline) {
      if (child.exitCode !== null) break;
      await sleep(100);
    }
    const up = lines.some((line) => line.includes('"Server ready"'));
    if (!up) { await stop(); assert.fail(`server.js did not become ready:\n${lines.join('\n')}`); }
    return { port, lines, stop };
  }

  test('server.js and the audit service contain no startup backfill any more', () => {
    const source = fs.readFileSync(SERVER, 'utf8');
    assert.doesNotMatch(source, /backfillLegacyChain|applyLegacyBackfill|planLegacyBackfill/, 'startup does not call any migration');
    assert.equal(typeof auditService.backfillLegacyChain, 'undefined', 'the old, history-resealing function no longer exists');
    assert.equal(typeof auditService.planLegacyBackfill, 'function');
    assert.equal(typeof auditService.applyLegacyBackfill, 'function');
  });

  test('the REAL server, started on a database with a MIXED legacy history (2 chained + 2 older unchained records), leaves every audit document byte-identical, reports the legacy records, and shows the transaction policy in readiness', async () => {
    await resetAudit();
    await appendChained(2);
    await dropAuditIndexes();
    await insertLegacy(legacy('LEGACY_OLD_1', new Date('2020-01-01T00:00:00Z')), legacy('LEGACY_OLD_2', new Date('2020-01-02T00:00:00Z')));
    const before = await rawAudit();
    const running = await startServer();
    try {
      await sleep(1500); // time for any startup migration to (wrongly) run
      const ready = await fetch(`http://127.0.0.1:${running.port}/api/ready`);
      assert.equal(ready.status, 200);
      const body = await ready.json();
      assert.equal(body.transactions, 'supported');
      assert.equal(body.transactionPolicy.requireTransactions, true);
      assert.equal(body.transactionPolicy.environmentClass, 'test');
      assert.deepEqual(await rawAudit(), before, 'startup changed an audit document');
      const warning = running.lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((entry) => entry && /predate the hash chain/.test(entry.message || ''));
      assert.ok(warning, `a warning about the legacy records is logged:\n${running.lines.join('\n')}`);
      assert.equal(warning.unchainedRecords, 2);
      assert.ok(running.lines.some((line) => line.includes('"Transaction policy"')), 'the policy is logged at startup');
    } finally {
      await running.stop();
    }
  });

  test('an unrecognized NODE_ENV with REQUIRE_TRANSACTIONS=false is IGNORED at startup: the server runs strict, says so in the log, and readiness reports the refused opt-out', async () => {
    const running = await startServer({ NODE_ENV: 'staging', REQUIRE_TRANSACTIONS: 'false' });
    try {
      const body = await (await fetch(`http://127.0.0.1:${running.port}/api/ready`)).json();
      assert.deepEqual(body.transactionPolicy, { environmentClass: 'unrecognized', requireTransactions: true, optOutRequested: true, optOutHonoured: false });
      assert.ok(running.lines.some((line) => /REQUIRE_TRANSACTIONS=false ignored: NODE_ENV \\"staging\\"/.test(line)), `the refusal is logged:\n${running.lines.join('\n')}`);
      assert.ok(running.lines.some((line) => /is not exactly \\"production\\", \\"development\\" or \\"test\\"/.test(line)));
    } finally {
      await running.stop();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// C — the explicit legacy-chain migration (library)
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe('C — legacy audit backfill: reviewed plan, preflight refusals, conditional fills, never touches chained history', () => {
  const verified = async () => { const v = await auditService.verifyAuditChain(); assert.equal(v.valid, true, `${v.reason}`); return v; };

  test('an all-legacy history: the plan is exact and deterministic, planning writes nothing, apply is bound to the plan digest, the chain verifies, and a second apply changes nothing', async () => {
    await resetAudit();
    await insertLegacy(legacy('L3', new Date('2021-03-01T00:00:00Z')), legacy('L1', new Date('2021-01-01T00:00:00Z')), legacy('L2', new Date('2021-02-01T00:00:00Z')));
    const before = await rawAudit();
    const plan = await auditService.planLegacyBackfill();
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.counts, { chained: 0, unchained: 3, wouldChange: 3 });
    assert.equal(plan.tail, null);
    assert.deepEqual(plan.changes.map((c) => [c.action, c.sequenceNumber]), [['L1', 1], ['L2', 2], ['L3', 3]], 'in createdAt order, not insertion order');
    assert.equal(plan.changes[0].previousHash, GENESIS_HASH);
    plan.changes.slice(1).forEach((change, i) => assert.equal(change.previousHash, plan.changes[i].hash, 'linked'));
    assert.equal((await auditService.planLegacyBackfill()).digest, plan.digest, 'deterministic');
    assert.deepEqual(await rawAudit(), before, 'planning writes nothing');

    for (const bad of [undefined, '', 'f'.repeat(64)]) {
      await assert.rejects(auditService.applyLegacyBackfill({ expectedDigest: bad }), (error) => error.code === 'LEGACY_BACKFILL_DIGEST_MISMATCH');
    }
    assert.deepEqual(await rawAudit(), before, 'a refused apply writes nothing');

    const result = await auditService.applyLegacyBackfill({ expectedDigest: plan.digest });
    assert.equal(result.applied, 3);
    assert.equal(result.verification.valid, true);
    assert.equal((await verified()).checkedRecords, 3);
    const after = await rawAudit();
    assert.deepEqual(after.map((d) => d.action), ['L3', 'L1', 'L2'], 'documents keep their identity; only chain fields were added');
    after.forEach((doc, i) => { const { sequenceNumber, previousHash, hash, ...rest } = doc; assert.deepEqual(rest, (({ sequenceNumber: s, previousHash: p, hash: h, ...r }) => r)(before[i]), 'nothing but the three chain fields changed'); });

    const second = await auditService.planLegacyBackfill();
    assert.deepEqual(second.counts, { chained: 3, unchained: 0, wouldChange: 0 });
    const again = await auditService.applyLegacyBackfill({ expectedDigest: second.digest });
    assert.equal(again.applied, 0);
    assert.deepEqual(await rawAudit(), after, 'idempotent: a second apply writes nothing');
  });

  test('a MIXED history (valid chained records + newer legacy records): only the legacy records are filled; every already-chained record stays byte-identical and its hash unchanged', async () => {
    await resetAudit();
    await appendChained(2);
    await dropAuditIndexes();
    const chainedBefore = await rawAudit();
    await insertLegacy(legacy('NEW_1', futureAt(1)), legacy('NEW_2', futureAt(2)));
    const plan = await auditService.planLegacyBackfill();
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.counts, { chained: 2, unchained: 2, wouldChange: 2 });
    assert.deepEqual(plan.tail, { sequenceNumber: 2, hash: chainedBefore[1].hash });
    assert.deepEqual(plan.changes.map((c) => c.sequenceNumber), [3, 4]);
    assert.equal(plan.changes[0].previousHash, chainedBefore[1].hash, 'extends the existing tail');
    await auditService.applyLegacyBackfill({ expectedDigest: plan.digest });
    const after = await rawAudit();
    assert.deepEqual(after.slice(0, 2), chainedBefore, 'chained history is byte-identical');
    assert.equal((await verified()).checkedRecords, 4);
  });

  const refusalCases = [
    ['an unchained record OLDER than the chain tail (filling it would re-seal chained records)', 'UNCHAINED_BEFORE_CHAIN_TAIL', async () => { await appendChained(2); await dropAuditIndexes(); await insertLegacy(legacy('OLD', new Date('2020-01-01T00:00:00Z'))); }],
    ['a fork: two records claim the same sequence', 'CHAIN_GAP_OR_DUPLICATE', async () => { await appendChained(3); await dropAuditIndexes(); const { _id, ...second } = await AuditLog.collection.findOne({ sequenceNumber: 2 }); await AuditLog.collection.insertOne(second); }],
    ['a gap: a middle record is missing', 'CHAIN_GAP_OR_DUPLICATE', async () => { await appendChained(3); await AuditLog.collection.deleteOne({ sequenceNumber: 2 }); }],
    ['an edited record: its hash no longer matches', 'CHAIN_HASH_MISMATCH', async () => { await appendChained(3); await AuditLog.collection.updateOne({ sequenceNumber: 2 }, { $set: { action: 'EDITED' } }); }],
    ['a broken link: previousHash does not match the predecessor', 'CHAIN_LINK_BROKEN', async () => { await appendChained(3); await AuditLog.collection.updateOne({ sequenceNumber: 3 }, { $set: { previousHash: 'e'.repeat(64) } }); }],
    ['a chained record with a garbage createdAt (the old verifier threw RangeError)', 'CHAIN_RECORD_MALFORMED', async () => { await appendChained(2); await AuditLog.collection.updateOne({ sequenceNumber: 2 }, { $set: { createdAt: 'garbage' } }); }],
    ['a partially chained record', 'PARTIALLY_CHAINED', async () => { await appendChained(1); await dropAuditIndexes(); await insertLegacy(legacy('PARTIAL', futureAt(1), { hash: 'a'.repeat(64) })); }],
    ['a legacy record without createdAt', 'RECORD_MALFORMED', async () => { await dropAuditIndexes(); const { createdAt, updatedAt, ...noDates } = legacy('NO_DATE', null); await insertLegacy(noDates); }],
    ['a legacy record with an invalid createdAt', 'RECORD_MALFORMED', async () => { await dropAuditIndexes(); await insertLegacy(legacy('BAD_DATE', 'not-a-date')); }],
    ['a legacy record without its actor', 'RECORD_MALFORMED', async () => { await dropAuditIndexes(); await insertLegacy({ ...legacy('NO_ACTOR', new Date('2020-01-01T00:00:00Z')), actorId: undefined }); }],
  ];
  for (const [title, code, build] of refusalCases) {
    test(`preflight REFUSES ${title}: structured finding ${code}, nothing is written, apply refuses even with the matching digest`, async () => {
      await resetAudit();
      await build();
      const before = await rawAudit();
      const plan = await auditService.planLegacyBackfill();
      assert.equal(plan.ok, false);
      assert.ok(plan.findings.some((finding) => finding.code === code), `expected ${code}, got ${JSON.stringify(plan.findings.map((f) => f.code))}`);
      await assert.rejects(auditService.applyLegacyBackfill({ expectedDigest: plan.digest }), (error) => error.code === 'LEGACY_BACKFILL_REFUSED' && error.findings.some((finding) => finding.code === code));
      assert.deepEqual(await rawAudit(), before, 'a refused migration writes nothing');
    });
  }

  test('an interrupted apply (SIMULATED: the 3rd conditional update throws) leaves a valid chained prefix, never touches it again, and a re-run completes from it', async () => {
    await resetAudit();
    await insertLegacy(...[1, 2, 3, 4, 5].map((n) => legacy(`R${n}`, new Date(`2022-0${n}-01T00:00:00Z`))));
    const plan = await auditService.planLegacyBackfill();
    const original = AuditLog.collection.updateOne;
    let calls = 0;
    AuditLog.collection.updateOne = function interrupted(...args) {
      calls += 1;
      if (calls === 3) throw Object.assign(new Error('simulated crash'), { simulated: true });
      return original.apply(this, args);
    };
    try {
      await assert.rejects(auditService.applyLegacyBackfill({ expectedDigest: plan.digest }), (error) => error.simulated === true && error.applied === 2 && error.stoppedAt === plan.changes[2].recordId);
    } finally {
      AuditLog.collection.updateOne = original;
    }
    const interrupted = await rawAudit();
    assert.deepEqual(interrupted.filter((d) => d.sequenceNumber != null).map((d) => d.sequenceNumber).sort(), [1, 2]);
    assert.equal(interrupted.filter((d) => d.sequenceNumber == null).length, 3);
    const resumed = await auditService.planLegacyBackfill();
    assert.equal(resumed.ok, true, 'the chained prefix passes the preflight');
    assert.deepEqual(resumed.counts, { chained: 2, unchained: 3, wouldChange: 3 });
    assert.equal(resumed.tail.sequenceNumber, 2);
    await auditService.applyLegacyBackfill({ expectedDigest: resumed.digest });
    const done = await rawAudit();
    for (const doc of interrupted.filter((d) => d.sequenceNumber != null)) assert.deepEqual(done.find((d) => String(d._id) === String(doc._id)), doc, 'the prefix written before the interruption is untouched');
    assert.equal((await verified()).checkedRecords, 5);
  });

  test('a record that changes between planning and its fill stops the migration at that record (conditional update), without touching anything else', async () => {
    await resetAudit();
    await insertLegacy(legacy('C1', new Date('2023-01-01T00:00:00Z')), legacy('C2', new Date('2023-02-01T00:00:00Z')), legacy('C3', new Date('2023-03-01T00:00:00Z')));
    const plan = await auditService.planLegacyBackfill();
    const original = AuditLog.collection.updateOne;
    let first = true;
    AuditLog.collection.updateOne = async function competing(filter, ...rest) {
      if (first) { first = false; await original.call(this, { _id: filter._id }, { $set: { sequenceNumber: 999, hash: 'b'.repeat(64), previousHash: 'c'.repeat(64) } }); } // someone else chains it first
      return original.call(this, filter, ...rest);
    };
    try {
      await assert.rejects(auditService.applyLegacyBackfill({ expectedDigest: plan.digest }), (error) => error.code === 'LEGACY_BACKFILL_CONFLICT' && error.applied === 0 && error.stoppedAt === plan.changes[0].recordId);
    } finally {
      AuditLog.collection.updateOne = original;
    }
    const docs = await rawAudit();
    assert.equal(docs.filter((d) => d.sequenceNumber === 999).length, 1, 'the competing write is untouched');
    assert.equal(docs.filter((d) => d.sequenceNumber == null).length, 2, 'the other records were not modified');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// D — the migration CLI
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe('D — legacy backfill CLI: dry run by default and creates nothing; apply bound to the reviewed digest and the named database', () => {
  const run = (args, env = {}) => new Promise((resolve) => {
    execFile(process.execPath, [BACKFILL_CLI, ...args], { cwd: BACKEND, env: { ...process.env, MONGO_URI: TEST_DB_URI, ...env } }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
  const DB = dbNameOf(TEST_DB_URI);

  test('a dry run against a brand-new EMPTY database creates no collection and no index (autoCreate/autoIndex off) and reports nothing to do', async () => {
    const emptyUri = withDb(TEST_DB_URI, 'payguard_integrity_p0_cli_empty');
    const probe = await mongoose.createConnection(emptyUri, { autoIndex: false, autoCreate: false }).asPromise();
    try {
      await probe.dropDatabase();
      assert.deepEqual(await probe.db.listCollections().toArray(), []);
      const result = await run([], { MONGO_URI: emptyUri });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /would change: 0/);
      assert.match(result.stdout, /DRY RUN: nothing was written/);
      assert.deepEqual(await probe.db.listCollections().toArray(), [], 'a dry run created a collection');
    } finally {
      await probe.dropDatabase();
      await probe.close();
    }
  });

  test('dry run on a populated database: exact plan and digest in the output, every document/collection/index unchanged, the report file is exclusive-create', async () => {
    await resetAudit();
    await appendChained(2);
    await dropAuditIndexes();
    await insertLegacy(legacy('CLI_1', futureAt(1)), legacy('CLI_2', futureAt(2)));
    const before = await dbShape();
    const asJson = await run(['--json']);
    assert.equal(asJson.code, 0, asJson.stderr);
    const output = JSON.parse(asJson.stdout);
    assert.equal(output.mode, 'DRY_RUN');
    assert.equal(output.database, DB);
    assert.equal(output.plan.ok, true);
    assert.equal(output.plan.counts.wouldChange, 2);
    assert.equal(output.plan.changes.length, 2);
    assert.ok(output.plan.changes.every((change) => change.id === undefined && /^[0-9a-f]{24}$/.test(change.recordId) && change.sequenceNumber >= 3), 'every record that would change is enumerated');
    assert.equal(output.plan.digest, (await auditService.planLegacyBackfill()).digest);
    const reportPath = path.join(os.tmpdir(), `payguard-p0-backfill-report-${process.pid}.json`);
    fs.rmSync(reportPath, { force: true });
    const withReport = await run(['--report', reportPath]);
    assert.equal(withReport.code, 0, withReport.stderr);
    assert.equal(JSON.parse(fs.readFileSync(reportPath, 'utf8')).plan.digest, output.plan.digest);
    const second = await run(['--report', reportPath]);
    assert.equal(second.code, 1);
    assert.match(second.stderr, /EEXIST/, 'an existing report is never overwritten');
    fs.rmSync(reportPath);
    assert.deepEqual(await dbShape(), before, 'the dry run changed nothing');
  });

  test('apply is guarded: it needs the reviewed digest, the database name and an operator; a wrong digest or wrong database writes nothing; the right ones chain the records exactly once', async () => {
    await resetAudit();
    await appendChained(2);
    await dropAuditIndexes();
    await insertLegacy(legacy('GUARD_1', futureAt(1)));
    const plan = await auditService.planLegacyBackfill();
    const before = await dbShape();
    const good = ['--apply', '--plan-digest', plan.digest, '--confirm-database', DB, '--operator', 'tester'];
    const cases = [
      [['--apply'], /--apply needs --plan-digest/],
      [['--apply', '--plan-digest', 'abc', '--confirm-database', DB, '--operator', 'x'], /--apply needs --plan-digest <64-hex/],
      [['--apply', '--plan-digest', plan.digest, '--operator', 'x'], /--apply needs --confirm-database/],
      [['--apply', '--plan-digest', plan.digest, '--confirm-database', DB], /--apply needs --operator/],
      [['--apply', '--plan-digest', plan.digest, '--confirm-database', 'some_other_database', '--operator', 'x'], /does not match the connected database/],
      [['--apply', '--plan-digest', 'f'.repeat(64), '--confirm-database', DB, '--operator', 'x'], /plan digest does not match/],
      [['--plan-digest', plan.digest], /only meaningful with --apply/],
      [['--confirm-database', DB], /only meaningful with --apply/],
      [['--operator', 'x'], /only meaningful with --apply/],
      [[...good, '--apply'], /--apply was given more than once/],
      [['--bogus'], /unknown argument --bogus/],
      [['--apply', ...good.slice(1), '--operator', ''], /was given more than once|must not be blank/],
    ];
    for (const [args, reason] of cases) {
      const result = await run(args);
      assert.equal(result.code, 1, args.join(' '));
      assert.match(result.stderr, reason, args.join(' '));
    }
    assert.deepEqual(await dbShape(), before, 'every refusal left the database untouched');
    const applied = await run(good);
    assert.equal(applied.code, 0, applied.stderr);
    assert.match(applied.stdout, /APPLIED by tester on .*: 1 record\(s\) chained/);
    assert.match(applied.stdout, /verifyAuditChain: valid \(3 records\)/);
    assert.equal((await auditService.verifyAuditChain()).valid, true);
    const again = await run(['--json']);
    assert.equal(JSON.parse(again.stdout).plan.counts.wouldChange, 0, 'nothing left to do');
    const reuse = await run(good);
    assert.equal(reuse.code, 1, 'the digest of the reviewed plan cannot be replayed after the data changed');
    assert.match(reuse.stderr, /plan digest does not match/);
  });

  test('on a history that must be refused, the dry run exits 1 listing the findings, and apply with that very digest is refused with nothing written', async () => {
    await resetAudit();
    await appendChained(2);
    await dropAuditIndexes();
    await insertLegacy(legacy('TOO_OLD', new Date('2019-01-01T00:00:00Z')));
    const before = await dbShape();
    const dry = await run([]);
    assert.equal(dry.code, 1);
    assert.match(dry.stdout, /Preflight: REFUSED/);
    assert.match(dry.stdout, /UNCHAINED_BEFORE_CHAIN_TAIL/);
    const digest = /Plan digest: ([0-9a-f]{64})/.exec(dry.stdout)[1];
    const apply = await run(['--apply', '--plan-digest', digest, '--confirm-database', DB, '--operator', 'tester']);
    assert.equal(apply.code, 1);
    assert.match(apply.stderr, /Legacy audit backfill refused: UNCHAINED_BEFORE_CHAIN_TAIL/);
    assert.deepEqual(await dbShape(), before);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// E — reconcile CLI dry-run purity on an empty database (the pre-fix defect: it created 10 collections)
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe('E — reconcile CLI: a dry run against a brand-new empty database creates no collection and no index', () => {
  const RECONCILE_CLI = path.join(BACKEND, 'scripts/reconcile-payroll-snapshots.mjs');
  test('before and after listings of an empty database are both empty, for every dry-run form', async () => {
    const emptyUri = withDb(TEST_DB_URI, 'payguard_integrity_p0_reconcile_empty');
    const probe = await mongoose.createConnection(emptyUri, { autoIndex: false, autoCreate: false }).asPromise();
    try {
      for (const args of [[], ['--json'], ['--company', String(new mongoose.Types.ObjectId()), '--run', String(new mongoose.Types.ObjectId())]]) {
        await probe.dropDatabase();
        assert.deepEqual(await probe.db.listCollections().toArray(), []);
        const result = await new Promise((resolve) => {
          execFile(process.execPath, [RECONCILE_CLI, ...args], { cwd: BACKEND, env: { ...process.env, MONGO_URI: emptyUri } }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
        });
        assert.equal(result.code, 0, result.stderr);
        const created = (await probe.db.listCollections().toArray()).map((entry) => entry.name);
        assert.deepEqual(created, [], `a dry run (${args.join(' ') || 'no arguments'}) created collections: ${created}`);
      }
    } finally {
      await probe.dropDatabase();
      await probe.close();
    }
  });
});
