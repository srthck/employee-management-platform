import mongoose from 'mongoose';
import PayrollSnapshot from '../models/PayrollSnapshot.js';
import PayrollRun from '../models/PayrollRun.js';
import AuditLog from '../models/AuditLog.js';
import SnapshotRecoveryLease from '../models/SnapshotRecoveryLease.js';
import auditService from './auditService.js';
import { verifySnapshotHash } from '../models/PayrollSnapshot.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const FINALIZATION_ACTIONS = ['PAYROLL_FINALIZED', 'PAYROLL_SNAPSHOT_FINALIZED'];

const result = (classification, reasons, extra = {}) => ({
  eligible: classification === 'SAFE_ORPHAN_PENDING',
  classification,
  reasons,
  ...extra,
});

const invalidId = (value) => !mongoose.isValidObjectId(value);

export async function acquireRecoveryLease(resourceKey, { ownerToken = crypto.randomUUID(), leaseMs = 60_000 } = {}) {
  if (typeof resourceKey !== 'string' || resourceKey.length === 0 || resourceKey.length > 200) {
    throw Object.assign(new Error('A bounded recovery resource key is required.'), { code: 'RECOVERY_SCOPE_INVALID', statusCode: 400 });
  }
  if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 15 * 60_000) {
    throw Object.assign(new Error('Recovery lease duration is outside the permitted range.'), { code: 'RECOVERY_LEASE_INVALID', statusCode: 400 });
  }
  const now = new Date();
  try {
    return await SnapshotRecoveryLease.create({
      resourceKey,
      ownerToken,
      fence: 1,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      acquiredAt: now,
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
  return SnapshotRecoveryLease.findOneAndUpdate(
    { resourceKey, leaseExpiresAt: { $lte: now } },
    {
      $set: { ownerToken, leaseExpiresAt: new Date(now.getTime() + leaseMs), acquiredAt: now },
      $inc: { fence: 1 },
    },
    { new: true }
  ).exec();
}

export async function renewRecoveryLease(resourceKey, ownerToken, fence, leaseMs = 60_000) {
  return SnapshotRecoveryLease.findOneAndUpdate(
    {
      resourceKey,
      ownerToken,
      fence,
      leaseExpiresAt: { $gt: new Date() },
    },
    { $set: { leaseExpiresAt: new Date(Date.now() + leaseMs) } },
    { new: true }
  ).exec();
}

export async function releaseRecoveryLease(resourceKey, ownerToken, fence) {
  return SnapshotRecoveryLease.deleteOne({ resourceKey, ownerToken, fence });
}

export async function assertRecoveryFence(resourceKey, ownerToken, fence) {
  const lease = await SnapshotRecoveryLease.findOne({
    resourceKey,
    ownerToken,
    fence,
    leaseExpiresAt: { $gt: new Date() },
  }).lean();
  if (!lease) {
    throw Object.assign(new Error('Recovery lease is absent, expired, or fenced by a newer owner.'), {
      code: 'RECOVERY_FENCE_REJECTED',
      statusCode: 409,
    });
  }
  return lease;
}

/**
 * Inspect one snapshot without changing MongoDB or the filesystem.
 *
 * This is intentionally a proof collector, not a purge implementation.
 * Ambiguous evidence is never downgraded to an eligible orphan.
 */
export async function inspectSnapshotRecovery({ snapshotId, companyId } = {}) {
  if (invalidId(snapshotId) || invalidId(companyId)) {
    return result('INVESTIGATE', ['snapshotId and companyId must be valid ObjectIds']);
  }

  const snapshot = await PayrollSnapshot.findOne({ _id: snapshotId, companyId }).lean();
  if (!snapshot) return result('MISSING_EVIDENCE', ['snapshot does not exist in the requested tenant']);

  const reasons = [];
  const duplicates = await PayrollSnapshot.countDocuments({
    payrollRunId: snapshot.payrollRunId,
    companyId,
    'employeeSnapshot.employeeId': snapshot.employeeSnapshot?.employeeId,
  });
  const linkedRun = await PayrollRun.findOne({ _id: snapshot.payrollRunId, companyId }).lean();
  const finalizationEvents = await AuditLog.find({
    companyId,
    entityId: { $in: [snapshot._id, snapshot.payrollRunId] },
    action: { $in: FINALIZATION_ACTIONS },
  }).select('_id action entityId sequenceNumber hash').lean();
  let chain;
  let head;
  let hash;
  try {
    chain = await auditService.verifyAuditChain();
  } catch (error) {
    chain = { valid: false, reason: `verification error: ${error.message}` };
  }
  try {
    head = await auditService.verifyHead();
  } catch (error) {
    head = { ok: false, reason: `verification error: ${error.message}` };
  }
  try {
    hash = verifySnapshotHash(snapshot);
  } catch (error) {
    hash = { valid: false, storedHash: snapshot.snapshotHash || null, reason: `hash error: ${error.message}` };
  }

  if (snapshot.snapshotStatus !== 'PENDING_FINALIZATION') {
    reasons.push(`snapshot status is ${snapshot.snapshotStatus}, not PENDING_FINALIZATION`);
  }
  if (snapshot.finalizedAt != null || snapshot.finalizedBy != null) {
    reasons.push('finalization metadata exists');
  }
  if (!linkedRun) {
    reasons.push('linked payroll run is missing');
  } else {
    if (linkedRun.companyId.toString() !== snapshot.companyId.toString()) reasons.push('tenant mismatch');
    if (linkedRun.periodMonth !== snapshot.periodMonth || linkedRun.periodYear !== snapshot.periodYear) reasons.push('period mismatch');
    if (linkedRun.status === 'FINALIZED' || linkedRun.status === 'DISBURSED') reasons.push(`linked run is ${linkedRun.status}`);
    if (!['READY_FOR_FINALIZATION', 'FAILED', 'CANCELLED'].includes(linkedRun.status)) reasons.push(`linked run status ${linkedRun.status} is not recoverable evidence`);
  }
  if (duplicates !== 1) reasons.push(`expected exactly one snapshot for the run and employee, found ${duplicates}`);
  if (!hash.valid) reasons.push(hash.reason || 'snapshot hash does not match its canonical payload');
  if (finalizationEvents.length > 0) reasons.push('finalization audit evidence exists');
  if (!chain.valid) reasons.push(`audit chain invalid: ${chain.reason || 'unknown reason'}`);
  if (!head.ok) reasons.push(`audit head invalid: ${head.reason || 'unknown reason'}`);

  if (reasons.length === 0) {
    return result('SAFE_ORPHAN_PENDING', [], {
      snapshotId: snapshot._id,
      payrollRunId: snapshot.payrollRunId,
      beforeImageHash: hash.storedHash,
      chain,
      head,
    });
  }

  const finalizedEvidence = snapshot.snapshotStatus === 'FINALIZED'
    || snapshot.finalizedAt != null
    || snapshot.finalizedBy != null
    || finalizationEvents.length > 0
    || linkedRun?.status === 'FINALIZED'
    || linkedRun?.status === 'DISBURSED';
  return result(finalizedEvidence ? 'FINALIZED' : 'INCONSISTENT', reasons, {
    snapshotId: snapshot._id,
    payrollRunId: snapshot.payrollRunId,
    beforeImageHash: hash.storedHash,
    chain,
    head,
  });
}

export async function planSnapshotRecovery(input) {
  const inspection = await inspectSnapshotRecovery(input);
  const planDigest = crypto.createHash('sha256')
    .update(JSON.stringify({
      snapshotId: input?.snapshotId || null,
      companyId: input?.companyId || null,
      inspection,
    }))
    .digest('hex');
  return {
    mode: 'DRY_RUN',
    applyEnabled: false,
    planDigest,
    inspection,
    action: inspection.eligible ? 'EVIDENCE_REQUIRED_BEFORE_ANY_APPLY' : 'REFUSE',
  };
}

export async function createRecoveryEvidence({ plan, evidenceDirectory, filename } = {}) {
  if (!plan || plan.mode !== 'DRY_RUN' || !plan.planDigest || !plan.inspection?.eligible) {
    throw Object.assign(new Error('Only an eligible, digest-bound dry-run plan can produce evidence.'), {
      code: 'RECOVERY_EVIDENCE_REFUSED',
      statusCode: 409,
    });
  }
  if (typeof evidenceDirectory !== 'string' || typeof filename !== 'string'
    || filename.length === 0 || filename !== path.basename(filename) || filename.includes('\0')) {
    throw Object.assign(new Error('Evidence path must be a named file inside the approved evidence directory.'), {
      code: 'RECOVERY_EVIDENCE_PATH_INVALID',
      statusCode: 400,
    });
  }
  const directory = path.resolve(evidenceDirectory);
  const target = path.resolve(directory, filename);
  if (!target.startsWith(`${directory}${path.sep}`)) {
    throw Object.assign(new Error('Evidence path escapes its approved directory.'), {
      code: 'RECOVERY_EVIDENCE_PATH_INVALID',
      statusCode: 400,
    });
  }
  const parent = await fs.lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw Object.assign(new Error('The evidence directory must be a real directory.'), {
      code: 'RECOVERY_EVIDENCE_DIRECTORY_INVALID',
      statusCode: 400,
    });
  }
  const body = `${JSON.stringify({
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    planDigest: plan.planDigest,
    inspection: plan.inspection,
    beforeImageHash: plan.inspection.beforeImageHash,
  }, null, 2)}\n`;
  const digest = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  const handle = await fs.open(target, 'wx', 0o600);
  try {
    const written = await handle.write(body, 0, 'utf8');
    if (written.bytesWritten !== Buffer.byteLength(body)) {
      throw Object.assign(new Error('Evidence write length did not match the expected length.'), {
        code: 'RECOVERY_EVIDENCE_SHORT_WRITE',
      });
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  const file = await fs.lstat(target);
  if (!file.isFile() || file.isSymbolicLink()) {
    throw Object.assign(new Error('Evidence file is not a regular non-symlink file.'), {
      code: 'RECOVERY_EVIDENCE_FILE_INVALID',
    });
  }
  return { path: target, digest, bytes: Buffer.byteLength(body), planDigest: plan.planDigest };
}

export async function applySnapshotRecovery() {
  throw Object.assign(
    new Error('Snapshot recovery apply is disabled pending independent release-gate approval.'),
    { statusCode: 503, code: 'SNAPSHOT_RECOVERY_APPLY_DISABLED' }
  );
}

export default {
  acquireRecoveryLease,
  renewRecoveryLease,
  releaseRecoveryLease,
  assertRecoveryFence,
  inspectSnapshotRecovery,
  planSnapshotRecovery,
  createRecoveryEvidence,
  applySnapshotRecovery,
};
