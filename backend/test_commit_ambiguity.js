/**
 * test_commit_ambiguity.js — unconfirmed commits against REAL server faults (F-04).
 *
 * Starts its own disposable single-node replica set with enableTestCommands=1 (never the shared server) and uses MongoDB's
 * failCommand failpoint on commitTransaction:
 *   writeConcernError   the server APPLIES the commit, then answers with an error: the classic ambiguous commit
 *   closeConnection     the server drops the connection WITHOUT applying the commit
 * The driver labels both UnknownTransactionCommitResult, so to the application they look identical. Only durable evidence can
 * tell them apart, which is what these tests exercise. Nothing here is mocked.
 *
 * Skips with an explicit reason when no mongod binary is found (set MONGOD_PATH).
 */

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import express from 'express';
import mongoose from 'mongoose';

function findMongod() {
  if (process.env.MONGOD_PATH) return process.env.MONGOD_PATH;
  const server = 'C:/Program Files/MongoDB/Server';
  if (fs.existsSync(server)) {
    for (const version of fs.readdirSync(server).sort().reverse()) {
      const candidate = path.join(server, version, 'bin/mongod.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  try { execFileSync('mongod', ['--version'], { stdio: 'ignore' }); return 'mongod'; } catch { return null; }
}

const freePort = () => new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

const MONGOD = findMongod();
const TRANSACTION_LIFETIME_SECONDS = 4;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

describe('unconfirmed commits against a real server', { skip: MONGOD ? false : 'no mongod binary found (set MONGOD_PATH)' }, () => {
  let dbPath;
  let mongod;
  let port;
  let opsServer;
  let opsUrl;
  let admin;
  let IdempotencyRecord;
  let runInTransaction;
  let handler;

  const USER = new mongoose.Types.ObjectId();
  const scratch = () => mongoose.connection.collection('ambiguity_scratch');
  const record = (key) => IdempotencyRecord.findOne({ userId: USER, key }).lean();
  const newKey = () => `key-${crypto.randomUUID()}`;
  const send = (key) => fetch(`${opsUrl}/op`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key && { 'Idempotency-Key': key }) },
    body: '{}',
  });
  const failCommit = (data) => admin.command({
    configureFailPoint: 'failCommand',
    mode: { times: 50 },
    data: { failCommands: ['commitTransaction'], ...data },
  });
  const clearFailPoint = () => admin.command({ configureFailPoint: 'failCommand', mode: 'off' });
  const commitApplied = { writeConcernError: { code: 64, errmsg: 'failpoint: waiting for replication timed out', errInfo: { wtimeout: true } } };
  const commitNeverApplied = { closeConnection: true };

  const commitOnce = async (req, res) => {
    await runInTransaction((session) => scratch().insertOne({ at: new Date() }, { session }), { label: 'ambiguity.op' });
    res.status(201).json({ success: true });
  };

  before(async () => {
    dbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'payguard-ambiguity-'));
    port = await freePort();
    mongod = spawn(MONGOD, [
      '--replSet', 'ambiguity', '--port', String(port), '--bind_ip', '127.0.0.1', '--dbpath', dbPath,
      '--logpath', path.join(dbPath, 'mongod.log'),
      '--setParameter', 'enableTestCommands=1',
      '--setParameter', `transactionLifetimeLimitSeconds=${TRANSACTION_LIFETIME_SECONDS}`,
      '--setParameter', 'ttlMonitorSleepSecs=1', // the real TTL monitor, every second, for the retention tests
    ], { stdio: 'ignore' });

    const direct = `mongodb://127.0.0.1:${port}/?directConnection=true`;
    const client = new mongoose.mongo.MongoClient(direct, { serverSelectionTimeoutMS: 20000 });
    await client.connect();
    await client.db('admin').command({ replSetInitiate: { _id: 'ambiguity', members: [{ _id: 0, host: `127.0.0.1:${port}` }] } });
    for (let i = 0; i < 100; i += 1) {
      if ((await client.db('admin').command({ hello: 1 })).isWritablePrimary) break;
      await sleep(200);
    }
    await client.close();

    process.env.NODE_ENV = 'test';
    process.env.LOG_LEVEL = 'silent';
    process.env.MONGO_URI = `mongodb://127.0.0.1:${port}/payguard_ambiguity?replicaSet=ambiguity`;
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'ambiguity-test-secret-long-enough-for-validation';
    process.env.FRONTEND_URL = 'http://localhost:5173';
    process.env.FIELD_ENCRYPTION_KEYS = `v1:${crypto.randomBytes(32).toString('base64')}`;
    process.env.FIELD_ENCRYPTION_ACTIVE_KEY = 'v1';
    process.env.FIELD_BLIND_INDEX_KEY = crypto.randomBytes(32).toString('hex');

    ({ default: IdempotencyRecord } = await import('./src/models/IdempotencyRecord.js'));
    ({ runInTransaction } = await import('./src/utils/transaction.js'));
    const { idempotent } = await import('./src/middleware/idempotency.js');
    const { errorHandler } = await import('./src/middleware/errorHandler.js');

    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    await IdempotencyRecord.init();
    await mongoose.connection.createCollection('ambiguity_scratch');
    admin = mongoose.connection.db.admin();

    const ops = express();
    ops.use(express.json());
    ops.use((req, res, next) => { req.user = { id: USER, companyId: null }; next(); });
    ops.post('/op', idempotent(), async (req, res, next) => {
      try { await handler(req, res); } catch (err) { next(err); }
    });
    ops.use(errorHandler);
    opsServer = ops.listen(0);
    await new Promise((resolve) => opsServer.once('listening', resolve));
    opsUrl = `http://127.0.0.1:${opsServer.address().port}`;
  });

  after(async () => {
    if (opsServer) { opsServer.closeAllConnections(); await new Promise((resolve) => opsServer.close(resolve)); }
    await mongoose.disconnect().catch(() => {});
    if (mongod) {
      const exited = new Promise((resolve) => mongod.once('exit', resolve));
      mongod.kill();
      await exited;
    }
    if (dbPath) fs.rmSync(dbPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  beforeEach(async () => {
    await clearFailPoint();
    await scratch().deleteMany({});
    await IdempotencyRecord.deleteMany({});
    handler = commitOnce;
  });

  test('REAL FAULT: the server applies the commit but every reply is an error; the operation record proves it committed, so the request succeeds and a retry replays', async () => {
    const key = newKey();
    await failCommit(commitApplied);
    const response = await send(key);
    await clearFailPoint();

    assert.equal(response.status, 201, await response.clone().text());
    assert.equal(await scratch().countDocuments({}), 1);
    const row = await record(key);
    assert.equal(row.status, 'COMPLETED');
    assert.equal(row.committedTransactions, 1);

    const replay = await send(key);
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('idempotent-replayed'), 'true');
    assert.equal(await scratch().countDocuments({}), 1, 'applied exactly once');
  });

  test('REAL FAULT: a commit the server REFUSES with a transient label is a definite failure: the transaction is retried as a whole and applies exactly once, never reported as unknown', async () => {
    const key = newKey();
    // The failpoint answers the first commit with WriteConflict + TransientTransactionError (no UnknownTransactionCommitResult).
    await admin.command({ configureFailPoint: 'failCommand', mode: { times: 1 }, data: { failCommands: ['commitTransaction'], errorCode: 112, errorLabels: ['TransientTransactionError'] } });
    const response = await send(key);
    await clearFailPoint();
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal(await scratch().countDocuments({}), 1);
    const row = await record(key);
    assert.equal(row.status, 'COMPLETED');
    assert.equal(row.committedTransactions, 1);
  });

  test('REAL FAULT: the commit is applied but the request has no Idempotency-Key: the caller is told the outcome is unknown, and the change is in fact there', async () => {
    await failCommit(commitApplied);
    const response = await send(null);
    await clearFailPoint();
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, 'COMMIT_OUTCOME_UNKNOWN');
    assert.doesNotMatch(body.message, /nothing was written/i);
    assert.equal(await scratch().countDocuments({}), 1);
  });

  test('REAL FAULT: the connection drops and the commit is never applied: COMMIT_OUTCOME_UNKNOWN, no duplicate on retry, and the key cannot be re-run while the outcome is open', async () => {
    const key = newKey();
    await failCommit(commitNeverApplied);
    const response = await send(key);
    await clearFailPoint();

    assert.equal(response.status, 503, await response.clone().text());
    const body = await response.json();
    assert.equal(body.code, 'COMMIT_OUTCOME_UNKNOWN');
    assert.doesNotMatch(body.message, /nothing was written/i);
    assert.ok(body.operationId);

    const retry = await send(key);
    assert.equal(retry.status, 409, await retry.clone().text());
    assert.ok(['IDEMPOTENCY_OUTCOME_UNKNOWN', 'IDEMPOTENCY_REQUEST_IN_PROGRESS'].includes((await retry.json()).code));
    await sleep((TRANSACTION_LIFETIME_SECONDS + 3) * 1000); // the server discards the abandoned transaction
    assert.equal(await scratch().countDocuments({}), 0, 'it was never applied');
    assert.equal((await record(key)).committedTransactions, 0, 'and the evidence agrees');
  });

  test('REAL FAULT: after an abandoned commit the server discards the transaction, and the operation record it held can be written again', async () => {
    const key = newKey();
    await failCommit(commitNeverApplied);
    await send(key);
    await clearFailPoint();
    await sleep((TRANSACTION_LIFETIME_SECONDS + 3) * 1000);
    const update = await IdempotencyRecord.updateOne({ userId: USER, key }, { $set: { lockExpiresAt: new Date(0) } }, { maxTimeMS: 2000 });
    assert.equal(update.matchedCount, 1);
  });

  describe('retention: only settled records expire (the REAL TTL monitor, running every second)', () => {
    const DAY = 24 * 3600 * 1000;
    // The fingerprint the middleware computes for the request send() makes, so a retry is recognised as the same request.
    const SEND_FINGERPRINT = crypto.createHash('sha256').update(JSON.stringify({ method: 'POST', url: '/op', body: {} })).digest('hex');
    const row = (status, extra = {}) => ({
      operationId: crypto.randomUUID(), key: newKey(), userId: USER, companyId: null, method: 'POST', path: '/op',
      requestHash: SEND_FINGERPRINT, status, lockExpiresAt: new Date(Date.now() - DAY), lockToken: null, committedTransactions: 0, commits: [],
      responseStatus: null, responseBody: null, createdAt: new Date(Date.now() - 30 * DAY), ...extra,
    });
    const waitFor = async (predicate, ms = 20_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await predicate()) return true; await sleep(250); }
      return false;
    };

    test('a month-old COMPLETED record expires; month-old UNKNOWN_COMMIT and committed IN_PROGRESS records are kept, so their keys can never run again', async () => {
      const completed = row('COMPLETED', { responseStatus: 201, responseBody: '{}' });
      const unknown = row('UNKNOWN_COMMIT', { responseStatus: 503 });
      const committed = row('IN_PROGRESS', { committedTransactions: 1, commits: [{ marker: 'm', label: 'x', at: new Date() }] });
      await IdempotencyRecord.collection.insertMany([completed, unknown, committed]);

      assert.ok(await waitFor(async () => !(await IdempotencyRecord.exists({ key: completed.key }))), 'the settled record expired');
      await sleep(3000); // several more monitor passes
      assert.ok(await IdempotencyRecord.exists({ key: unknown.key }), 'UNKNOWN_COMMIT is kept');
      assert.ok(await IdempotencyRecord.exists({ key: committed.key }), 'an attempt that committed work is kept');

      // And the kept records still do their job: a retry with the same key is refused, not run.
      handler = commitOnce;
      for (const [k, code] of [[unknown.key, 'IDEMPOTENCY_OUTCOME_UNKNOWN'], [committed.key, 'IDEMPOTENCY_PRIOR_ATTEMPT_COMMITTED']]) {
        const retry = await send(k);
        assert.equal(retry.status, 409, await retry.clone().text());
        assert.equal((await retry.json()).code, code);
      }
      assert.equal(await scratch().countDocuments({}), 0, 'nothing ran');
    });

    test('the migration replaces the old TTL index that expired every record; the dry run changes nothing and no document is removed', async () => {
      const name = 'idempotency_ttl';
      await IdempotencyRecord.collection.dropIndex('idempotency_ttl_completed');
      await IdempotencyRecord.collection.createIndex({ createdAt: 1 }, { name, expireAfterSeconds: 10 * 365 * 24 * 3600 }); // long enough that nothing expires during the test
      await IdempotencyRecord.collection.insertMany([row('UNKNOWN_COMMIT', { createdAt: new Date() }), row('COMPLETED', { createdAt: new Date() })]);
      const before = await IdempotencyRecord.countDocuments({});
      const indexNames = async () => (await IdempotencyRecord.collection.indexes()).map((index) => index.name).sort();
      const migrate = (args) => spawnSync(process.execPath, ['scripts/migrate.js', ...args], {
        cwd: path.dirname(fileURLToPath(import.meta.url)),
        encoding: 'utf8', timeout: 120_000, env: { ...process.env, MONGO_URI: process.env.MONGO_URI },
      });

      const dry = migrate(['--dry-run']);
      assert.equal(dry.status, 0, dry.stdout + dry.stderr);
      assert.match(dry.stdout, /idempotencyrecords: drop index idempotency_ttl\b/);
      assert.ok((await indexNames()).includes(name), 'the dry run dropped nothing');

      const real = migrate([]);
      assert.equal(real.status, 0, real.stdout + real.stderr);
      const indexes = await IdempotencyRecord.collection.indexes();
      assert.ok(!indexes.some((index) => index.name === name), 'the old index is gone');
      const replacement = indexes.find((index) => index.name === 'idempotency_ttl_completed');
      assert.ok(replacement, 'the replacement exists');
      assert.deepEqual(replacement.partialFilterExpression, { status: 'COMPLETED' });
      assert.equal(await IdempotencyRecord.countDocuments({}), before, 'no document was removed by the migration');
    });
  });
});
