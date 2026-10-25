// A competing writer in a SEPARATE process, released by a database barrier (no sleeps to "create" concurrency).
//   node test_support/auditHeadRaceWorker.mjs <mongoUri> <count> <mode>
//   mode: standalone | txn | multi3
//     standalone  audit-only appends (logStandalone) with the in-process queue OFF: this process contends with itself too
//     txn         a business-style transaction per operation: one scratch write + one audit event
//     multi3      a transaction per operation with THREE audit events (the payroll-finalization shape) + one scratch write
// Protocol: insert {_id:'ready-<pid>'} into the barrier collection (env RACE_BARRIER), then poll for {_id:'go'}; when
// released, fire all `count` operations at once. Prints one JSON line: { pid, mode, committed:[sequence numbers],
// committedOperations, refused, refusalCodes, causes, logCalls }. It never asserts: the parent test does.
//
// The connection is opened with autoIndex:false and autoCreate:false. Without that, Mongoose re-creates every schema index
// (including the three unique ones) in the background right after connecting, so a test that DROPPED an index to prove the
// head protocol does not need it would silently race against a rebuilt index (verified by probe, review finding T1).
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.REQUIRE_TRANSACTIONS = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'worker-secret-that-is-long-enough-for-config';

const [, , uri, countText, mode] = process.argv;
const { default: auditService } = await import('../src/services/auditService.js');
const { runInTransaction, transactionLane } = await import('../src/utils/transaction.js');

await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, autoIndex: false, autoCreate: false });
let logCalls = 0; // every attempt of every event calls log() once: logCalls above the number of committed events proves that attempts were rolled back and re-run
const originalLog = auditService.log;
auditService.log = function countedLog(...args) { logCalls += 1; return originalLog.apply(this, args); };
transactionLane.enabled = process.env.WORKER_LANE === '1'; // the per-process lane is a liveness mechanism only; the race tests keep it OFF so every writer truly contends

const barrier = mongoose.connection.collection(process.env.RACE_BARRIER || 'audit_race_barrier');
const scratch = mongoose.connection.collection('audit_race_scratch');
const actorId = new mongoose.Types.ObjectId();
const params = (i, k = 0) => ({ action: 'RACE_APPEND', actorId, entityType: 'TEST', entityId: new mongoose.Types.ObjectId(), meta: { i, k, pid: process.pid, mode } });

if (mode === 'hold') {
  // CRASH INJECTION: do the work of an audited transaction up to (but not including) the commit, announce it, then wait to be killed.
  // The parent SIGKILLs this process; the transaction is never committed and never aborted by the client.
  const session = await mongoose.startSession();
  session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
  await scratch.insertOne({ held: true, pid: process.pid }, { session });
  await auditService.log(params(0), session); // head advanced and record inserted, uncommitted
  await barrier.insertOne({ _id: `held-${process.pid}` });
  await new Promise(() => {}); // until killed
}

const operation = {
  // POSITIVE CONTROL, not the production algorithm: the way the chain was appended BEFORE the head existed. Read the newest record, insert
  // sequence+1 after it, inside a transaction. There is no head to arbitrate, so only the unique indexes can stop two of these writers
  // from taking the same position. It exists to prove that the race harness CAN observe a fork when the protection is missing.
  oldstyle: async (i) => {
    await runInTransaction(async (session) => {
      const auditlogs = mongoose.connection.collection('auditlogs');
      const tail = await auditlogs.find({}, { session, sort: { sequenceNumber: -1 }, limit: 1, projection: { sequenceNumber: 1, hash: 1 } }).next();
      await auditlogs.insertOne({ sequenceNumber: (tail?.sequenceNumber ?? 0) + 1, previousHash: tail?.hash ?? 'GENESIS', hash: `oldstyle-${process.pid}-${i}`, action: 'OLDSTYLE', actorId, entityType: 'TEST', entityId: new mongoose.Types.ObjectId(), meta: {}, createdAt: new Date() }, { session });
    }, { label: 'race.oldstyle', maxAttempts: 60, maxWaitMs: 30000 });
    return [i];
  },
  standalone: async (i) => [(await auditService.logStandalone(params(i))).sequenceNumber],
  // Inside a managed transaction log() returns a receipt that is filled in just before the commit: read it AFTER the transaction resolved.
  txn: async (i) => {
    const receipts = await runInTransaction(async (session) => {
      await scratch.insertOne({ i, pid: process.pid }, { session });
      return [await auditService.log(params(i), session)];
    }, { label: 'race.txn' });
    return receipts.map((r) => r.sequenceNumber);
  },
  multi3: async (i) => {
    const receipts = await runInTransaction(async (session) => {
      await scratch.insertOne({ i, pid: process.pid }, { session });
      const logged = [];
      for (let k = 0; k < 3; k += 1) logged.push(await auditService.log(params(i, k), session));
      return logged;
    }, { label: 'race.multi3' });
    return receipts.map((r) => r.sequenceNumber);
  },
}[mode];
if (!operation) throw new Error(`unknown mode ${mode}`);

await barrier.insertOne({ _id: `ready-${process.pid}` });
for (;;) {
  if (await barrier.findOne({ _id: 'go' })) break;
  await new Promise((resolve) => { setTimeout(resolve, 2); });
}

const settled = await Promise.allSettled(Array.from({ length: Number(countText) }, (_, i) => operation(i)));
const refusalCodes = {};
const causes = {};
for (const r of settled) {
  if (r.status !== 'rejected') continue;
  const key = String(r.reason?.code ?? r.reason?.name);
  refusalCodes[key] = (refusalCodes[key] || 0) + 1;
  const cause = r.reason?.cause;
  const text = `${cause?.codeName ?? cause?.code ?? cause?.name ?? 'none'}: ${String(cause?.message ?? '').slice(0, 110)}`;
  causes[text] = (causes[text] || 0) + 1; // what the bounded refusal was hiding: the last underlying error
}
console.log(JSON.stringify({
  pid: process.pid, mode,
  committed: settled.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value),
  committedOperations: settled.filter((r) => r.status === 'fulfilled').length,
  refused: settled.filter((r) => r.status === 'rejected').length,
  refusalCodes,
  causes,
  logCalls,
}));
await mongoose.disconnect();
process.exit(0);
