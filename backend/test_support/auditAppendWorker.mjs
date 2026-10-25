// Worker process for the audit-chain concurrency tests: appends to the shared chain from a SEPARATE process.
//   node test_support/auditAppendWorker.mjs <mongoUri> <count> [plain|plain-noqueue|txn]
//   plain          audit-only appends (logStandalone), the per-process transaction lane ON (the production configuration)
//   plain-noqueue  the same with the lane OFF: this process contends with itself AND with the others
//   txn            a business-style transaction (scratch write + audit append) per operation, lane OFF
//   txn-lane       the same with the lane ON (the production configuration)
// Prints one JSON line: { fulfilled, rejected, rejectionCodes }. It never asserts: the parent test does.
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.REQUIRE_TRANSACTIONS = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'worker-secret-that-is-long-enough-for-config';

const [, , uri, countText, mode] = process.argv;
const { default: auditService } = await import('../src/services/auditService.js');
const { runInTransaction, transactionLane } = await import('../src/utils/transaction.js');

// autoIndex/autoCreate OFF: a worker must never rebuild indexes the test has dropped or replaced (see auditHeadRaceWorker.mjs)
await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, autoIndex: false, autoCreate: false });

const actorId = new mongoose.Types.ObjectId();
const params = (i) => ({ action: 'WORKER_APPEND', actorId, entityType: 'TEST', entityId: new mongoose.Types.ObjectId(), meta: { i, pid: process.pid } });
if (mode === 'plain-noqueue' || mode === 'txn') transactionLane.enabled = false; // the lane is liveness only; switch it off so these writers truly contend
const scratch = mongoose.connection.collection('audit_hardening_scratch');
const append = (mode === 'txn' || mode === 'txn-lane')
  ? (i) => runInTransaction(async (session) => { await scratch.insertOne({ i, pid: process.pid }, { session }); return auditService.log(params(i), session); }, { label: 'worker' })
  : (i) => auditService.logStandalone(params(i));

const settled = await Promise.allSettled(Array.from({ length: Number(countText) }, (_, i) => append(i)));
const rejectionCodes = {};
for (const r of settled) if (r.status === 'rejected') { const key = String(r.reason?.code ?? r.reason?.name); rejectionCodes[key] = (rejectionCodes[key] || 0) + 1; }
console.log(JSON.stringify({ fulfilled: settled.filter((r) => r.status === 'fulfilled').length, rejected: settled.filter((r) => r.status === 'rejected').length, rejectionCodes }));
await mongoose.disconnect();
process.exit(0);
