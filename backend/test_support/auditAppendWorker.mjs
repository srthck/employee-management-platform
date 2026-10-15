// Worker process for the audit-chain concurrency tests: appends to the shared chain from a SEPARATE process.
//   node test_support/auditAppendWorker.mjs <mongoUri> <count> [txn]
// Prints one JSON line: { fulfilled, rejected, rejectionCodes }. It never asserts: the parent test does.
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.REQUIRE_TRANSACTIONS = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'worker-secret-that-is-long-enough-for-config';

const [, , uri, countText, mode] = process.argv;
const { default: auditService } = await import('../src/services/auditService.js');
const { runInTransaction } = await import('../src/utils/transaction.js');

await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });

const actorId = new mongoose.Types.ObjectId();
const params = (i) => ({ action: 'WORKER_APPEND', actorId, entityType: 'TEST', entityId: new mongoose.Types.ObjectId(), meta: { i, pid: process.pid } });
const append = mode === 'txn'
  ? (i) => runInTransaction((session) => auditService.log(params(i), session), { label: 'worker' })
  : (i) => auditService.log(params(i));

const settled = await Promise.allSettled(Array.from({ length: Number(countText) }, (_, i) => append(i)));
const rejectionCodes = {};
for (const r of settled) if (r.status === 'rejected') { const key = String(r.reason?.code ?? r.reason?.name); rejectionCodes[key] = (rejectionCodes[key] || 0) + 1; }
console.log(JSON.stringify({ fulfilled: settled.filter((r) => r.status === 'fulfilled').length, rejected: settled.filter((r) => r.status === 'rejected').length, rejectionCodes }));
await mongoose.disconnect();
process.exit(0);
