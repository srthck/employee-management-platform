/**
 * test_atomicity.js — business/audit atomicity and at-most-once operations (F-05, F-04). See docs/integrity/IDEMPOTENCY.md.
 *
 * Runner: node:test.  Run: node --test test_atomicity.js   (or the full suite: npm test)
 * Real MongoDB replica set, isolated database (ATOMICITY_MONGO_URI), dropped before and after.
 *
 * A — every former post-commit audit site commits its business change and its event together. The audit append is made to
 *     fail for real by removing the chain head (the server then refuses every append); anything else is named SIMULATED.
 * B — one logical operation applies at most once: evidence written inside the transaction, fencing by lock token, a 5xx frees
 *     the key only when nothing committed, unconfirmed commits. Faults injected into the driver session are named SIMULATED;
 *     the real server faults are in test_commit_ambiguity.js.
 *
 * Tests assert persisted state, never merely the response.
 */

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import mongoose from 'mongoose';

const TEST_DB_URI = process.env.ATOMICITY_MONGO_URI || 'mongodb://127.0.0.1:27018/payguard_atomicity_test?replicaSet=rs0';

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.LOG_LEVEL = 'silent';
process.env.MONGO_URI = TEST_DB_URI;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'atomicity-test-secret-long-enough-for-validation';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.FIELD_ENCRYPTION_KEYS = `v1:${crypto.randomBytes(32).toString('base64')}`;
process.env.FIELD_ENCRYPTION_ACTIVE_KEY = 'v1';
process.env.FIELD_BLIND_INDEX_KEY = crypto.randomBytes(32).toString('hex');
process.env.LOGIN_MAX_ATTEMPTS = '3';

const { default: app } = await import('./src/app.js');
const { default: Admin } = await import('./src/models/Admin.js');
const { default: AuditLog } = await import('./src/models/AuditLog.js');
const { default: AuditChainHead } = await import('./src/models/AuditChainHead.js');
const { HEAD_COLLECTION } = await import('./src/services/auditChainSpec.js');
const { default: PayrollRun } = await import('./src/models/PayrollRun.js');
const { default: IdempotencyRecord } = await import('./src/models/IdempotencyRecord.js');
const { default: auditService } = await import('./src/services/auditService.js');
const { default: payrollRunService } = await import('./src/services/payrollRunService.js');
const { idempotent } = await import('./src/middleware/idempotency.js');
const { errorHandler } = await import('./src/middleware/errorHandler.js');
const { runInTransaction } = await import('./src/utils/transaction.js');

const PASSWORD = 'AtomicPass123';
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

let server;
let baseUrl;
let opsServer;
let opsUrl;

const heads = () => mongoose.connection.collection(HEAD_COLLECTION);
const auditCount = (action) => AuditLog.countDocuments({ action });

/** A real audit outage: without a head, a non-empty chain refuses every append. */
async function withoutHead(body) {
  const head = await heads().findOne({});
  await heads().deleteMany({});
  try { return await body(); } finally { await heads().insertOne(head); }
}

const api = (path, { cookie, ...options } = {}) => fetch(`${baseUrl}/api${path}`, {
  ...options,
  headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }), ...(options.headers || {}) },
  ...(options.json && { method: options.method || 'POST', body: JSON.stringify(options.json) }),
});

async function register(tag) {
  const email = `owner-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const res = await api('/auth/register', { json: { name: 'Atomic Owner', email, password: PASSWORD, confirmPassword: PASSWORD } });
  assert.equal(res.status, 201, await res.clone().text());
  const body = await res.json();
  return { email, id: body.data.user.id, cookie: res.headers.get('set-cookie').split(';')[0] };
}

const login = (email, password) => api('/auth/login', { json: { email, password } });
const adminRow = (id) => Admin.findById(id).select('+failedLoginAttempts +lockUntil').lean();

before(async () => {
  await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 5000 });
  await mongoose.connection.dropDatabase();
  await Promise.all([AuditLog.init(), AuditChainHead.init(), IdempotencyRecord.init()]);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('A. a business change and its audit event commit together', () => {
  test('login: the sign-in state and AUTH_LOGIN_SUCCEEDED commit together; when the audit append is refused neither persists and no session cookie is issued', async () => {
    const owner = await register('login');
    const before = await adminRow(owner.id);
    await sleep(5);
    const events = await auditCount('AUTH_LOGIN_SUCCEEDED');

    await withoutHead(async () => {
      const refused = await login(owner.email, PASSWORD);
      assert.equal(refused.status, 503);
      assert.equal(refused.headers.get('set-cookie'), null, 'no cookie without the event');
    });
    assert.equal((await adminRow(owner.id)).lastLoginAt.getTime(), before.lastLoginAt.getTime(), 'the business change rolled back');
    assert.equal(await auditCount('AUTH_LOGIN_SUCCEEDED'), events);

    const ok = await login(owner.email, PASSWORD);
    assert.equal(ok.status, 200);
    assert.ok((await adminRow(owner.id)).lastLoginAt > before.lastLoginAt);
    assert.equal(await auditCount('AUTH_LOGIN_SUCCEEDED'), events + 1);
  });

  test('lockout: the lock and AUTH_ACCOUNT_LOCKED commit together; during an audit outage the attempt budget still holds, and at the threshold a wrong and a right password are indistinguishable', async () => {
    const owner = await register('lock');
    assert.equal((await login(owner.email, 'WrongPass123')).status, 401);
    assert.equal((await login(owner.email, 'WrongPass123')).status, 401);
    const locked = await auditCount('AUTH_ACCOUNT_LOCKED');

    await withoutHead(async () => {
      const wrong = await login(owner.email, 'WrongPass123'); // this attempt would lock, and the lock needs its event
      const right = await login(owner.email, PASSWORD);
      assert.equal(wrong.status, 503);
      assert.equal(right.status, 503);
      assert.equal((await wrong.json()).code, (await right.json()).code);
      assert.equal(right.headers.get('set-cookie'), null);
    });
    const row = await adminRow(owner.id);
    assert.ok(!row.lockUntil, 'the lock did not commit without its event');
    assert.equal(row.failedLoginAttempts, 2, 'the refused attempt rolled back and did not count');
    assert.equal(await auditCount('AUTH_ACCOUNT_LOCKED'), locked);

    assert.equal((await login(owner.email, 'WrongPass123')).status, 401);
    assert.ok((await adminRow(owner.id)).lockUntil > new Date());
    assert.equal(await auditCount('AUTH_ACCOUNT_LOCKED'), locked + 1);
  });

  test('logout-all: the token version and AUTH_SESSIONS_REVOKED commit together; when the append is refused the sessions stay valid', async () => {
    const owner = await register('logoutall');
    const before = (await adminRow(owner.id)).tokenVersion;
    const events = await auditCount('AUTH_SESSIONS_REVOKED');
    await withoutHead(async () => {
      assert.equal((await api('/auth/logout-all', { method: 'POST', cookie: owner.cookie })).status, 503);
    });
    assert.equal((await adminRow(owner.id)).tokenVersion, before);
    assert.equal(await auditCount('AUTH_SESSIONS_REVOKED'), events);

    assert.equal((await api('/auth/logout-all', { method: 'POST', cookie: owner.cookie })).status, 200);
    assert.equal((await adminRow(owner.id)).tokenVersion, before + 1);
    assert.equal(await auditCount('AUTH_SESSIONS_REVOKED'), events + 1);
  });

  describe('payroll runs', () => {
    const actor = (owner) => ({ id: owner.id, email: owner.email, role: 'admin' });
    let period = 0;

    async function newRun(owner) {
      period += 1;
      const result = await payrollRunService.createPayrollRun({ companyId: owner.id, periodYear: 2030, periodMonth: period, actorId: owner.id, actorEmail: owner.email, actorRole: 'admin' });
      return result.run || result;
    }

    test('preflight: the stored result and PAYROLL_PREFLIGHT_COMPLETED commit together', async () => {
      const owner = await register('preflight');
      const run = await newRun(owner);
      await withoutHead(async () => {
        await assert.rejects(payrollRunService.runPreflight(run._id, owner.id, actor(owner)), (e) => e.statusCode === 503);
      });
      assert.ok(!(await PayrollRun.findById(run._id).lean()).preflightResult?.resolvedAt, 'no result without the event');
      assert.equal(await AuditLog.countDocuments({ action: 'PAYROLL_PREFLIGHT_COMPLETED', entityId: run._id }), 0);

      await payrollRunService.runPreflight(run._id, owner.id, actor(owner));
      assert.ok((await PayrollRun.findById(run._id).lean()).preflightResult?.resolvedAt);
      assert.equal(await AuditLog.countDocuments({ action: 'PAYROLL_PREFLIGHT_COMPLETED', entityId: run._id }), 1);
    });

    test('processing start: the claim, the version and PAYROLL_PROCESSING_STARTED commit together; a refused append leaves the run DRAFT and untouched', async () => {
      const owner = await register('start');
      const run = await newRun(owner);
      await withoutHead(async () => {
        await assert.rejects(payrollRunService.processPayrollRun(run._id, owner.id, actor(owner)), (e) => e.statusCode === 503);
      });
      const row = await PayrollRun.findById(run._id).lean();
      assert.equal(row.status, 'DRAFT');
      assert.equal(row.processingVersion, run.processingVersion);
      assert.equal(row.startedAt ?? null, null);
      assert.equal(await AuditLog.countDocuments({ action: 'PAYROLL_PROCESSING_STARTED', entityId: run._id }), 0);
    });

    test('failing a run: FAILED and PAYROLL_PROCESSING_FAILED commit together; a refused append (SIMULATED for this one event) leaves the run PROCESSING for the stuck-run monitor, with no event', async () => {
      const owner = await register('fail');
      const run = await newRun(owner);
      const original = auditService.log;
      auditService.log = async function failing(params, session) {
        if (params.action === 'PAYROLL_PROCESSING_FAILED') throw Object.assign(new Error('simulated audit refusal'), { statusCode: 503 });
        return original.call(this, params, session);
      };
      try {
        await assert.rejects(payrollRunService.processPayrollRun(run._id, owner.id, actor(owner)), (e) => e.statusCode === 503);
      } finally {
        auditService.log = original;
      }
      assert.equal((await PayrollRun.findById(run._id).lean()).status, 'PROCESSING');
      assert.equal(await AuditLog.countDocuments({ action: 'PAYROLL_PROCESSING_FAILED', entityId: run._id }), 0);

      await payrollRunService._failRun(run._id, 'second try', actor(owner), owner.id);
      assert.equal((await PayrollRun.findById(run._id).lean()).status, 'FAILED');
      assert.equal(await AuditLog.countDocuments({ action: 'PAYROLL_PROCESSING_FAILED', entityId: run._id }), 1);
    });

    test('stuck-run recovery: FAILED and its event commit together; a refused append leaves the run stuck, so the next sweep still recovers it and records the event (it used to be lost for good)', async () => {
      const owner = await register('stuck');
      const run = await newRun(owner);
      const stale = new Date(Date.now() - 3_600_000);
      await PayrollRun.collection.updateOne({ _id: run._id }, { $set: { status: 'PROCESSING', lastActivityAt: stale, startedAt: stale } });

      await withoutHead(async () => {
        await assert.rejects(payrollRunService.autoRecoverStuckRuns({ thresholdMs: 60_000 }), (e) => e.statusCode === 503);
      });
      assert.equal((await PayrollRun.findById(run._id).lean()).status, 'PROCESSING');

      assert.equal(await payrollRunService.autoRecoverStuckRuns({ thresholdMs: 60_000 }), 1);
      assert.equal((await PayrollRun.findById(run._id).lean()).status, 'FAILED');
      assert.equal(await AuditLog.countDocuments({ action: 'PAYROLL_PROCESSING_FAILED', entityId: run._id }), 1);
    });
  });

  test('the audit chain is intact after every failure above', async () => {
    const result = await auditService.verifyAuditChain();
    assert.equal(result.valid, true, JSON.stringify(result));
  });
});

describe('B. one logical operation applies at most once', () => {
  const USER = new mongoose.Types.ObjectId();
  const scratch = () => mongoose.connection.collection('atomicity_scratch');
  const scratchCount = () => scratch().countDocuments({});
  const record = (key) => IdempotencyRecord.findOne({ userId: USER, key }).lean();
  const applied = (session, marker) => scratch().insertOne({ marker }, { session });

  // Handlers registered per test: the request is routed to whatever `handler` is set to.
  let handler;
  const key = () => `key-${crypto.randomUUID()}`;
  const send = (idempotencyKey, body = { a: 1 }) => fetch(`${opsUrl}/op`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(idempotencyKey && { 'Idempotency-Key': idempotencyKey }) },
    body: JSON.stringify(body),
  });

  before(async () => {
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
    opsServer.closeAllConnections();
    await new Promise((resolve) => opsServer.close(resolve));
  });

  beforeEach(async () => { await scratch().deleteMany({}); await IdempotencyRecord.deleteMany({}); });

  const commitOnce = async (req, res) => {
    await runInTransaction((session) => applied(session, 'done'), { label: 'test.op' });
    res.status(201).json({ success: true });
  };

  test('the commit is recorded inside the transaction: a completed operation carries its evidence and replays its response', async () => {
    handler = commitOnce;
    const k = key();
    assert.equal((await send(k)).status, 201);
    const row = await record(k);
    assert.equal(row.status, 'COMPLETED');
    assert.equal(row.committedTransactions, 1);
    assert.equal(row.commits.length, 1);
    assert.equal(row.commits[0].label, 'test.op');
    assert.match(row.operationId, /^[0-9a-f-]{36}$/);

    const replay = await send(k);
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('idempotent-replayed'), 'true');
    assert.equal(await scratchCount(), 1);
  });

  test('a rolled-back transaction leaves no evidence: a failure after the work aborts the marker with it', async () => {
    handler = async () => {
      await runInTransaction(async (session) => { await applied(session, 'x'); throw Object.assign(new Error('business refusal'), { statusCode: 422 }); }, { label: 'test.refused' });
    };
    const k = key();
    assert.equal((await send(k)).status, 422);
    const row = await record(k);
    assert.equal(row.committedTransactions, 0);
    assert.equal(await scratchCount(), 0);
  });

  test('a 5xx with nothing committed frees the key, and the retry executes exactly once', async () => {
    const k = key();
    handler = async () => { throw Object.assign(new Error('contention'), { statusCode: 503, code: 'AUDIT_CHAIN_CONTENTION' }); };
    assert.equal((await send(k)).status, 503);
    assert.equal(await record(k), null, 'nothing committed: the key is free');
    handler = commitOnce;
    assert.equal((await send(k)).status, 201);
    assert.equal(await scratchCount(), 1);
  });

  test('a 5xx after a transaction committed keeps the key: the retry is refused and does not apply the work twice', async () => {
    const k = key();
    handler = async () => {
      await runInTransaction((session) => applied(session, 'first'), { label: 'test.first' });
      throw new Error('crash after the commit');
    };
    assert.equal((await send(k)).status, 500);
    const row = await record(k);
    assert.equal(row.committedTransactions, 1);

    handler = commitOnce;
    const retry = await send(k);
    assert.equal(retry.status, 409);
    const body = await retry.json();
    assert.equal(body.code, 'IDEMPOTENCY_PRIOR_ATTEMPT_COMMITTED');
    assert.equal(body.operationId, row.operationId);
    assert.equal(await scratchCount(), 1, 'the work was not applied again');
  });

  test('a process that dies after its commit, before responding (connection destroyed, nothing persisted): once the lock expires the retry is refused, not re-run', async () => {
    const k = key();
    handler = async (req) => {
      await runInTransaction((session) => applied(session, 'first'), { label: 'test.crash' });
      req.socket.destroy(); // no response: nothing after the commit runs
    };
    await assert.rejects(send(k));
    const row = await record(k);
    assert.equal(row.status, 'IN_PROGRESS');
    assert.equal(row.committedTransactions, 1, 'the evidence survived without any response');

    handler = commitOnce;
    assert.equal((await send(k)).status, 409, 'while the lock is live the retry waits');
    assert.equal((await (await send(k)).json()).code, 'IDEMPOTENCY_REQUEST_IN_PROGRESS');

    await IdempotencyRecord.updateOne({ userId: USER, key: k }, { $set: { lockExpiresAt: new Date(Date.now() - 1000) } });
    const retry = await send(k);
    assert.equal(retry.status, 409);
    assert.equal((await retry.json()).code, 'IDEMPOTENCY_PRIOR_ATTEMPT_COMMITTED');
    assert.equal(await scratchCount(), 1);
  });

  test('a crash before any commit: after the lock expires a retry takes over and the work applies once', async () => {
    const k = key();
    handler = async (req) => { req.socket.destroy(); };
    await assert.rejects(send(k));
    await IdempotencyRecord.updateOne({ userId: USER, key: k }, { $set: { lockExpiresAt: new Date(Date.now() - 1000) } });
    handler = commitOnce;
    assert.equal((await send(k)).status, 201);
    assert.equal(await scratchCount(), 1);
  });

  test('FENCING: an attempt whose lock was taken over cannot commit; its transaction aborts and only the newer attempt applies', async () => {
    const k = key();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let reached;
    const atGate = new Promise((resolve) => { reached = resolve; });
    handler = async (req, res) => {
      reached();
      await gate; // the stale attempt stalls here while its lock expires
      await runInTransaction((session) => applied(session, 'stale'), { label: 'test.stale' });
      res.status(201).json({ success: true, from: 'stale' });
    };
    const stale = send(k);
    await atGate;
    await IdempotencyRecord.updateOne({ userId: USER, key: k }, { $set: { lockExpiresAt: new Date(Date.now() - 1000) } });

    handler = async (req, res) => {
      await runInTransaction((session) => applied(session, 'newer'), { label: 'test.newer' });
      res.status(201).json({ success: true, from: 'newer' });
    };
    assert.equal((await send(k)).status, 201);

    release();
    const staleResponse = await stale;
    assert.equal(staleResponse.status, 409);
    assert.equal((await staleResponse.json()).code, 'IDEMPOTENCY_LOCK_LOST');

    assert.deepEqual((await scratch().find({}).toArray()).map((d) => d.marker), ['newer']);
    const row = await record(k);
    assert.equal(row.status, 'COMPLETED');
    assert.match(row.responseBody, /newer/, 'the stale attempt did not overwrite the stored response');
  });

  test('FENCING while the newer attempt is still running: the record is still IN_PROGRESS, and only the lock token stops the superseded attempt from committing', async () => {
    const k = key();
    const gate = () => { let open; const opened = new Promise((resolve) => { open = resolve; }); let arrive; const arrived = new Promise((resolve) => { arrive = resolve; }); return { open, opened, arrive, arrived }; };
    const staleGate = gate();
    const newerGate = gate();
    handler = async (req, res) => {
      staleGate.arrive();
      await staleGate.opened;
      await runInTransaction((session) => applied(session, 'stale'), { label: 'test.stale' });
      res.status(201).json({ success: true, from: 'stale' });
    };
    const stale = send(k);
    await staleGate.arrived;
    await IdempotencyRecord.updateOne({ userId: USER, key: k }, { $set: { lockExpiresAt: new Date(Date.now() - 1000) } });

    handler = async (req, res) => {
      newerGate.arrive();
      await newerGate.opened;
      await runInTransaction((session) => applied(session, 'newer'), { label: 'test.newer' });
      res.status(201).json({ success: true, from: 'newer' });
    };
    const newer = send(k);
    await newerGate.arrived; // the newer attempt holds the lock and has not committed
    assert.equal((await record(k)).status, 'IN_PROGRESS');

    staleGate.open();
    const staleResponse = await stale;
    assert.equal(staleResponse.status, 409, await staleResponse.clone().text());
    assert.equal((await staleResponse.json()).code, 'IDEMPOTENCY_LOCK_LOST');
    assert.equal(await scratchCount(), 0, 'the superseded attempt wrote nothing');
    assert.equal((await record(k)).committedTransactions, 0);

    newerGate.open();
    assert.equal((await newer).status, 201);
    assert.deepEqual((await scratch().find({}).toArray()).map((d) => d.marker), ['newer']);
    const row = await record(k);
    assert.equal(row.status, 'COMPLETED');
    assert.equal(row.committedTransactions, 1);
  });

  test('the same key with a different request is refused and does not run the handler', async () => {
    const k = key();
    handler = commitOnce;
    assert.equal((await send(k, { a: 1 })).status, 201);
    const reused = await send(k, { a: 2 });
    assert.equal(reused.status, 422);
    assert.equal((await reused.json()).code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(await scratchCount(), 1);
  });

  test('work a handler does AFTER responding is not part of the operation: it commits on its own and leaves the finished record alone', async () => {
    const k = key();
    let proceed;
    const responded = new Promise((resolve) => { proceed = resolve; });
    let done;
    const finished = new Promise((resolve) => { done = resolve; });
    handler = async (req, res) => {
      res.status(201).json({ success: true });
      await responded;
      try { await runInTransaction((session) => applied(session, 'after'), { label: 'test.after' }); done(null); } catch (err) { done(err); }
    };
    assert.equal((await send(k)).status, 201);
    proceed();
    assert.equal(await finished, null);
    assert.deepEqual((await scratch().find({}).toArray()).map((d) => d.marker), ['after']);
    const row = await record(k);
    assert.equal(row.status, 'COMPLETED');
    assert.equal(row.committedTransactions, 0, 'the post-response transaction is not attributed to the operation');
  });

  test('a transaction nested inside another during a keyed request is refused, nothing is written, and the key stays usable', async () => {
    const k = key();
    handler = async (req, res) => {
      await runInTransaction(async (session) => {
        await applied(session, 'outer');
        await runInTransaction((inner) => applied(inner, 'inner'), { label: 'test.inner' });
      }, { label: 'test.outer' });
      res.status(201).json({ success: true });
    };
    const response = await send(k);
    assert.equal(response.status, 500, await response.clone().text());
    assert.equal((await response.json()).code, 'IDEMPOTENCY_NESTED_TRANSACTION');
    assert.equal(await scratchCount(), 0);
    assert.equal(await record(k), null, 'nothing committed, so the key was released');
    handler = commitOnce;
    assert.equal((await send(k)).status, 201);
    assert.equal(await scratchCount(), 1);
  });

  test('records written before this change (no token, no operation id, no counters) still replay, and several of them coexist under the partial unique index', async () => {
    const requestHash = crypto.createHash('sha256').update(JSON.stringify({ method: 'POST', url: '/op', body: { a: 1 } })).digest('hex');
    const legacy = (k) => ({ key: k, userId: USER, method: 'POST', path: '/op', requestHash, status: 'COMPLETED', lockExpiresAt: new Date(), responseStatus: 200, responseBody: '{"success":true,"legacy":true}', createdAt: new Date() });
    await IdempotencyRecord.collection.insertMany([legacy('legacy-key-1'), legacy('legacy-key-2')]);
    assert.equal(await IdempotencyRecord.collection.countDocuments({ requestHash }), 2);

    handler = commitOnce;
    const replay = await send('legacy-key-1');
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).legacy, true);
    assert.equal(await scratchCount(), 0);
  });

  describe('unconfirmed commits (SIMULATED at the driver session; the real server cases are in test_commit_ambiguity.js)', () => {
    const withCommit = (behave) => async (body) => {
      const originalStart = mongoose.startSession.bind(mongoose);
      mongoose.startSession = async (...args) => {
        const session = await originalStart(...args);
        const commit = session.commitTransaction.bind(session);
        session.commitTransaction = () => behave(commit);
        return session;
      };
      try { return await body(); } finally { mongoose.startSession = originalStart; }
    };
    const unknown = (message) => Object.assign(new Error(message), { errorLabels: new Set(['UnknownTransactionCommitResult']) });
    const appliedButReplyLost = async (commit) => { await commit().catch(() => {}); throw unknown('simulated: reply lost'); };
    const neverReachedTheServer = async () => { throw unknown('simulated: commit never sent'); };

    test('the commit was applied but never confirmed: the operation record proves it, so the request succeeds normally', async () => {
      handler = commitOnce;
      const k = key();
      const response = await withCommit(appliedButReplyLost)(() => send(k));
      assert.equal(response.status, 201);
      assert.equal((await record(k)).status, 'COMPLETED');
      assert.equal(await scratchCount(), 1);
    });

    test('the commit was never applied: 503 COMMIT_OUTCOME_UNKNOWN that does not claim nothing was written; the key is kept and a retry is refused, not re-run', async () => {
      handler = commitOnce;
      const k = key();
      const response = await withCommit(neverReachedTheServer)(() => send(k));
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.code, 'COMMIT_OUTCOME_UNKNOWN');
      assert.doesNotMatch(body.message, /nothing was written/i);
      assert.ok(body.operationId);

      const row = await record(k);
      assert.equal(row.status, 'UNKNOWN_COMMIT');
      const retry = await send(k);
      assert.equal(retry.status, 409);
      assert.equal((await retry.json()).code, 'IDEMPOTENCY_OUTCOME_UNKNOWN');
      assert.equal(await scratchCount(), 0);
    });

    test('without an Idempotency-Key there is no evidence to consult: the caller gets COMMIT_OUTCOME_UNKNOWN even when the commit was applied', async () => {
      handler = commitOnce;
      const response = await withCommit(appliedButReplyLost)(() => send(null));
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, 'COMMIT_OUTCOME_UNKNOWN');
      assert.equal(await scratchCount(), 1, 'the response is honest: it may have been saved, and it was');
    });
  });
});
