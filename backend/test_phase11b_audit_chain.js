import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import AuditLog from './src/models/AuditLog.js';
import auditService, { GENESIS_HASH, calculateAuditHash } from './src/services/auditService.js';

const uri = process.env.AUDIT_TEST_MONGO_URI || 'mongodb://127.0.0.1:27017/payguard_phase11b_audit_test';
const actorId = new mongoose.Types.ObjectId();
const entityId = new mongoose.Types.ObjectId();

before(async () => {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  await AuditLog.deleteMany({});
});

after(async () => {
  await AuditLog.deleteMany({});
  await mongoose.disconnect();
});

test('audit chain detects historical tampering', async () => {
  const params = { actorId, actorEmail: 'audit-test@example.invalid', actorRole: 'admin', entityType: 'TEST', entityId, meta: { token: 'should-not-persist' } };
  const first = await auditService.log({ ...params, action: 'TEST_ONE' });
  const second = await auditService.log({ ...params, action: 'TEST_TWO' });
  const third = await auditService.log({ ...params, action: 'TEST_THREE' });

  assert.equal(first.sequenceNumber, 1);
  assert.equal(first.previousHash, GENESIS_HASH);
  assert.equal(second.previousHash, first.hash);
  assert.equal(third.previousHash, second.hash);
  assert.equal(first.meta.token, '[REDACTED]');
  assert.equal(calculateAuditHash({
    sequenceNumber: first.sequenceNumber,
    action: first.action,
    actorId: String(first.actorId),
    actorEmail: first.actorEmail,
    actorRole: first.actorRole,
    entityType: first.entityType,
    entityId: String(first.entityId),
    previousStatus: null,
    newStatus: null,
    meta: first.meta,
    ipAddress: null,
    createdAt: first.createdAt,
    previousHash: first.previousHash,
  }), first.hash);

  const valid = await auditService.verifyAuditChain();
  assert.equal(valid.valid, true);
  assert.equal(valid.checkedRecords, 3);

  await AuditLog.updateOne({ _id: first._id }, { $set: { action: 'TAMPERED_ACTION' } });
  const invalid = await auditService.verifyAuditChain();
  assert.equal(invalid.valid, false);
  assert.equal(invalid.firstBrokenSequence, 1);
  assert.match(invalid.reason, /hash/i);
});
