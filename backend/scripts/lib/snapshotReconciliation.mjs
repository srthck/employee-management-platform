import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import PayrollSnapshot, { computeSnapshotHash } from '../../src/models/PayrollSnapshot.js';
import PayrollRun, { PAYROLL_STATUS } from '../../src/models/PayrollRun.js';
import AuditLog from '../../src/models/AuditLog.js';
import auditService from '../../src/services/auditService.js';
import payrollRunRepository from '../../src/repositories/payrollRunRepository.js';
import { buildSnapshotPayloadFromStaging } from '../../src/services/payrollSnapshotService.js';
import { SYSTEM_ACTOR } from '../../src/services/payrollRunService.js';
import { runInTransaction } from '../../src/utils/transaction.js';

/**
 * Pending-snapshot reconciliation (see docs/AUDIT-CHAIN-AND-SNAPSHOT-RECOVERY.md, section 3).
 *
 * scanPayrollSnapshots()  READ-ONLY. Classifies every snapshot (and every finalized run) against its run,
 *                         its hash, the staging it was built from and the audit chain. Never writes.
 * purgeOrphans()          The ONLY mutation, and only for class ORPHAN_PENDING: a PENDING snapshot whose
 *                         run is FAILED or CANCELLED and whose hash is intact. Each purge writes a
 *                         before-image to an evidence file FIRST, then deletes inside one transaction that
 *                         re-checks every condition and appends an audit event. Everything else is reported
 *                         and left alone; a finalized snapshot is never selected, deleted or rewritten.
 */

export const CLASSES = Object.freeze({
  OK: 'OK',
  IN_FLIGHT: 'IN_FLIGHT',
  PENDING_STALE: 'PENDING_STALE',
  ORPHAN_PENDING: 'ORPHAN_PENDING',
  PENDING_ON_ACTIVE_RUN: 'PENDING_ON_ACTIVE_RUN',
  PENDING_UNDER_FINALIZED_RUN: 'PENDING_UNDER_FINALIZED_RUN',
  FINALIZED_UNDER_UNFINALIZED_RUN: 'FINALIZED_UNDER_UNFINALIZED_RUN',
  HASH_INVALID: 'HASH_INVALID',
  DUPLICATE_SNAPSHOT: 'DUPLICATE_SNAPSHOT',
  RUN_MISSING: 'RUN_MISSING',
});

/** What an operator should do. Only PURGE_ELIGIBLE is ever acted on by this tool. */
export const ACTIONS = Object.freeze({
  NONE: 'NONE',
  FINALIZE_AGAIN: 'NO_ACTION_RE_RUN_FINALIZE',
  INVESTIGATE: 'INVESTIGATE',
  PURGE_ELIGIBLE: 'PURGE_ELIGIBLE',
});

const ORPHAN_RUN_STATES = new Set([PAYROLL_STATUS.FAILED, PAYROLL_STATUS.CANCELLED]);
const CLOSED_RUN_STATES = new Set([PAYROLL_STATUS.FINALIZED, PAYROLL_STATUS.DISBURSED]);
const PENDING = 'PENDING_FINALIZATION';
const FINALIZED = 'FINALIZED';
export const PURGE_ACTION = 'PAYROLL_SNAPSHOT_ORPHAN_PURGED';
export const LOCK_ID = 'payroll-snapshot-reconcile';

const oid = (value) => new mongoose.Types.ObjectId(String(value));
const str = (value) => (value == null ? null : String(value));

/**
 * Pure classification of one snapshot. Order matters: integrity problems and duplicates are never
 * downgraded by a friendlier-looking run state.
 */
export function classifySnapshot({ snapshot, run, hashValid, duplicate, stagingMatches }) {
  const result = (cls, action, reason) => ({ class: cls, action, reason });
  if (duplicate) return result(CLASSES.DUPLICATE_SNAPSHOT, ACTIONS.INVESTIGATE, 'more than one snapshot exists for this run and employee');
  if (!hashValid) return result(CLASSES.HASH_INVALID, ACTIONS.INVESTIGATE, 'the stored hash does not match the stored content (possible tampering); not touched');
  if (!run) return result(CLASSES.RUN_MISSING, ACTIONS.INVESTIGATE, 'the snapshot refers to a payroll run that does not exist');

  if (snapshot.snapshotStatus === FINALIZED) {
    return CLOSED_RUN_STATES.has(run.status)
      ? result(CLASSES.OK, ACTIONS.NONE, 'finalized snapshot under a finalized run; never modified')
      : result(CLASSES.FINALIZED_UNDER_UNFINALIZED_RUN, ACTIONS.INVESTIGATE, `finalized snapshot under a run in status ${run.status}`);
  }
  if (snapshot.snapshotStatus !== PENDING) return result(CLASSES.HASH_INVALID, ACTIONS.INVESTIGATE, `unknown snapshot status ${snapshot.snapshotStatus}`);

  if (ORPHAN_RUN_STATES.has(run.status)) return result(CLASSES.ORPHAN_PENDING, ACTIONS.PURGE_ELIGIBLE, `pending snapshot under a ${run.status} run, which cannot be finalized without reprocessing`);
  if (CLOSED_RUN_STATES.has(run.status)) return result(CLASSES.PENDING_UNDER_FINALIZED_RUN, ACTIONS.INVESTIGATE, `pending snapshot under a ${run.status} run; NEVER finalized automatically`);
  if (run.status === PAYROLL_STATUS.READY_FOR_FINALIZATION) {
    return stagingMatches
      ? result(CLASSES.IN_FLIGHT, ACTIONS.FINALIZE_AGAIN, 'pending snapshot matching its staging under a READY run; finalizing again completes it (idempotent)')
      : result(CLASSES.PENDING_STALE, ACTIONS.INVESTIGATE, 'pending snapshot differs from the payload staging would produce, or staging is missing; finalization would block with SNAPSHOT_CONFLICT');
  }
  return result(CLASSES.PENDING_ON_ACTIVE_RUN, ACTIONS.INVESTIGATE, `pending snapshot under a run in status ${run.status}`);
}

const chunk = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

async function eventCounts(actions, entityIds) {
  const counts = new Map();
  for (const ids of chunk(entityIds, 1000)) {
    const rows = await AuditLog.aggregate([
      { $match: { action: { $in: actions }, entityId: { $in: ids } } },
      { $group: { _id: { action: '$action', entityId: '$entityId' }, n: { $sum: 1 } } },
    ]);
    for (const row of rows) counts.set(`${row._id.action}:${row._id.entityId}`, row.n);
  }
  return (action, id) => counts.get(`${action}:${id}`) || 0;
}

/**
 * READ-ONLY. Writes nothing, takes no lock.
 * @returns the structured report (before-evidence when followed by an apply)
 */
export async function scanPayrollSnapshots({ companyId = null, runId = null, now = new Date() } = {}) {
  const snapshotFilter = {};
  if (companyId) snapshotFilter.companyId = oid(companyId);
  if (runId) snapshotFilter.payrollRunId = oid(runId);
  const snapshots = await PayrollSnapshot.find(snapshotFilter).lean();

  const runIds = [...new Set(snapshots.map((s) => String(s.payrollRunId)))];
  const runs = new Map((await PayrollRun.find({ _id: { $in: runIds.map(oid) } }).lean()).map((r) => [String(r._id), r]));
  const runFilter = { status: { $in: [...CLOSED_RUN_STATES] } };
  if (companyId) runFilter.companyId = oid(companyId);
  if (runId) runFilter._id = oid(runId);
  const closedRuns = await PayrollRun.find(runFilter).lean();

  const pairCount = new Map();
  for (const s of snapshots) {
    const key = `${s.payrollRunId}:${s.employeeSnapshot?.employeeId}`;
    pairCount.set(key, (pairCount.get(key) || 0) + 1);
  }

  const stagingByRun = new Map();
  const stagingFor = async (run) => {
    if (!stagingByRun.has(String(run._id))) {
      const rows = await payrollRunRepository.listStagingResults(run._id, run.processingVersion);
      stagingByRun.set(String(run._id), new Map(rows.map((row) => [String(row.employeeId), row])));
    }
    return stagingByRun.get(String(run._id));
  };

  const created = await eventCounts(['PAYROLL_SNAPSHOT_CREATED'], snapshots.map((s) => s._id));
  const finalEvents = await eventCounts(['PAYROLL_FINALIZED', 'PAYROLL_SNAPSHOT_FINALIZED'], closedRuns.map((r) => r._id));

  const items = [];
  for (const snapshot of snapshots) {
    const run = runs.get(String(snapshot.payrollRunId)) || null;
    const hashValid = computeSnapshotHash(snapshot) === snapshot.snapshotHash;
    const duplicate = pairCount.get(`${snapshot.payrollRunId}:${snapshot.employeeSnapshot?.employeeId}`) > 1;
    let stagingMatches = false;
    if (run && snapshot.snapshotStatus === PENDING && run.status === PAYROLL_STATUS.READY_FOR_FINALIZATION) {
      const staging = (await stagingFor(run)).get(String(snapshot.employeeSnapshot?.employeeId));
      if (staging && staging.employeeSnapshot && staging.salarySnapshot && staging.payrollInputs) {
        stagingMatches = computeSnapshotHash(buildSnapshotPayloadFromStaging(staging, run)) === snapshot.snapshotHash;
      }
    }
    const verdict = classifySnapshot({ snapshot, run, hashValid, duplicate, stagingMatches });
    items.push({
      snapshotId: str(snapshot._id),
      runId: str(snapshot.payrollRunId),
      employeeId: str(snapshot.employeeSnapshot?.employeeId),
      companyId: str(snapshot.companyId),
      snapshotStatus: snapshot.snapshotStatus,
      runStatus: run ? run.status : null,
      snapshotHash: snapshot.snapshotHash,
      hashValid,
      ...verdict,
      auditGap: created('PAYROLL_SNAPSHOT_CREATED', snapshot._id) === 0 ? 'no PAYROLL_SNAPSHOT_CREATED event' : null,
    });
  }

  const runFindings = [];
  for (const run of closedRuns) {
    const missing = ['PAYROLL_FINALIZED', 'PAYROLL_SNAPSHOT_FINALIZED'].filter((action) => finalEvents(action, run._id) === 0);
    const snapshotCount = snapshots.filter((s) => String(s.payrollRunId) === String(run._id)).length;
    if (missing.length > 0 || snapshotCount === 0) {
      runFindings.push({
        runId: str(run._id), runStatus: run.status, snapshotCount,
        missingAuditEvents: missing, action: ACTIONS.INVESTIGATE,
        note: 'report only: this tool never backfills or rewrites the audit chain',
      });
    }
  }

  const byClass = {};
  for (const item of items) byClass[item.class] = (byClass[item.class] || 0) + 1;
  const guards = await auditService.chainGuardStatus();
  const chain = await auditService.verifyAuditChain();

  return {
    tool: 'reconcile-payroll-snapshots',
    scannedAt: now.toISOString(),
    scope: { companyId: companyId ? String(companyId) : 'ALL', runId: runId ? String(runId) : 'ALL' },
    auditChain: { valid: chain.valid, checkedRecords: chain.checkedRecords, firstBrokenSequence: chain.firstBrokenSequence, reason: chain.reason },
    auditChainGuards: guards,
    totals: { snapshots: items.length, runsWithSnapshots: runIds.length, closedRuns: closedRuns.length },
    byClass,
    items,
    runFindings,
    auditGaps: items.filter((i) => i.auditGap).map((i) => ({ snapshotId: i.snapshotId, runId: i.runId, gap: i.auditGap })),
    purgeEligible: items.filter((i) => i.action === ACTIONS.PURGE_ELIGIBLE).map((i) => i.snapshotId),
  };
}

// ─── Concurrency protection: a single expiring lease in a unique-keyed document ───────────────────

const locks = () => mongoose.connection.collection('maintenance_locks');

export async function acquireLock({ owner, leaseMs = 10 * 60 * 1000, now = () => new Date() }) {
  const t = now();
  const doc = { _id: LOCK_ID, owner, acquiredAt: t, expiresAt: new Date(t.getTime() + leaseMs) };
  try {
    await locks().insertOne(doc);
    return { acquired: true, doc };
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
  // an EXPIRED lease may be taken over, atomically: only one taker can match the expiry condition
  const result = await locks().findOneAndUpdate({ _id: LOCK_ID, expiresAt: { $lt: t } }, { $set: { owner, acquiredAt: t, expiresAt: doc.expiresAt } }, { returnDocument: 'after' });
  const taken = result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result; // driver 5 wraps the document in { value }; driver 6 returns it
  if (taken) return { acquired: true, doc: taken };
  const holder = await locks().findOne({ _id: LOCK_ID });
  return { acquired: false, holder };
}

export async function releaseLock(owner) {
  await locks().deleteOne({ _id: LOCK_ID, owner });
}

// ─── The one mutation ────────────────────────────────────────────────────────────────────────────

export class ReconciliationRefused extends Error {
  constructor(message, reasons) {
    super(message);
    this.name = 'ReconciliationRefused';
    this.reasons = reasons;
  }
}

function writeEvidence(file, record) {
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd); // the before-image is on disk before anything is deleted
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Purge the ORPHAN_PENDING snapshots found by `scan`. Requires: a valid audit chain with its guards, an
 * operator name, a writable evidence directory and the maintenance lease. Every other class is untouched.
 * Idempotent: a purged snapshot is gone, so a second call finds nothing eligible.
 */
export async function purgeOrphans({ scan, evidenceDir, operator, now = () => new Date(), leaseMs }) {
  const reasons = [];
  if (!operator || !String(operator).trim()) reasons.push('an --operator name is required to apply');
  if (!scan.auditChain.valid) reasons.push(`the audit chain is not valid (${scan.auditChain.reason}); resolve that first`);
  if (!scan.auditChainGuards.ok) reasons.push(`the audit chain guards are missing: ${scan.auditChainGuards.missing.join(', ')}`);
  // Decide on everything that needs no disk access FIRST: a refused apply must leave nothing behind,
  // not even an empty evidence directory.
  if (reasons.length > 0) throw new ReconciliationRefused(`Refusing to apply: ${reasons.join('; ')}.`, reasons);
  const eligible = scan.items.filter((i) => i.action === ACTIONS.PURGE_ELIGIBLE);
  if (eligible.length === 0) return { evidenceFile: null, results: [], purged: 0 }; // nothing to do: no lock, no directory, no file

  let evidenceFile = null;
  try {
    fs.mkdirSync(evidenceDir, { recursive: true });
    evidenceFile = path.join(evidenceDir, `payroll-snapshot-reconcile-${now().toISOString().replace(/[:.]/g, '-')}-${process.pid}.jsonl`);
    fs.accessSync(evidenceDir, fs.constants.W_OK);
  } catch (error) {
    throw new ReconciliationRefused(`Refusing to apply: the evidence directory is not writable (${error.message}).`, ['evidence directory']);
  }

  const owner = `${os.hostname()}:${process.pid}:${operator}`;
  const lock = await acquireLock({ owner, leaseMs, now });
  if (!lock.acquired) {
    throw new ReconciliationRefused(`Refusing to apply: another reconciliation holds the lock (${lock.holder?.owner}, until ${lock.holder?.expiresAt?.toISOString?.()}).`, ['lock held']);
  }

  const results = [];
  try {
    for (const item of eligible) {
      const before = await PayrollSnapshot.findById(item.snapshotId).lean();
      if (!before) { results.push({ snapshotId: item.snapshotId, outcome: 'SKIPPED', reason: 'already gone (idempotent)' }); continue; }
      writeEvidence(evidenceFile, { kind: 'BEFORE_IMAGE', at: now().toISOString(), operator, snapshotId: item.snapshotId, scannedClass: item.class, document: before });

      const outcome = await runInTransaction(async (session) => {
        const snapshot = await PayrollSnapshot.findOne({ _id: item.snapshotId }).session(session).lean();
        if (!snapshot) return { outcome: 'SKIPPED', reason: 'already gone' };
        const run = await PayrollRun.findById(snapshot.payrollRunId).session(session).lean();
        // Every eligibility condition is re-checked INSIDE the transaction, against current data.
        if (snapshot.snapshotStatus !== PENDING) return { outcome: 'SKIPPED', reason: `snapshot is now ${snapshot.snapshotStatus}` };
        if (snapshot.snapshotHash !== item.snapshotHash || computeSnapshotHash(snapshot) !== snapshot.snapshotHash) return { outcome: 'SKIPPED', reason: 'snapshot hash changed or is no longer valid' };
        if (!run || !ORPHAN_RUN_STATES.has(run.status)) return { outcome: 'SKIPPED', reason: `run is now ${run ? run.status : 'missing'}` };
        if (await PayrollSnapshot.exists({ payrollRunId: snapshot.payrollRunId, snapshotStatus: FINALIZED }).session(session)) {
          return { outcome: 'SKIPPED', reason: 'the run also has a FINALIZED snapshot: inconsistent, needs investigation' };
        }
        // The model's query hook adds snapshotStatus != FINALIZED; the filter below is stricter still.
        const deleted = await PayrollSnapshot.deleteOne({ _id: snapshot._id, snapshotStatus: PENDING, snapshotHash: item.snapshotHash }, { session });
        if (deleted.deletedCount !== 1) return { outcome: 'SKIPPED', reason: 'nothing matched the conditional delete' };
        await auditService.log({
          action: PURGE_ACTION,
          actorId: SYSTEM_ACTOR.id,
          actorEmail: SYSTEM_ACTOR.email,
          actorRole: SYSTEM_ACTOR.role,
          entityType: 'PAYROLL_SNAPSHOT',
          entityId: snapshot._id,
          companyId: snapshot.companyId,
          meta: {
            payrollRunId: String(snapshot.payrollRunId),
            employeeId: String(snapshot.employeeSnapshot?.employeeId),
            snapshotHash: snapshot.snapshotHash,
            runStatus: run.status,
            operator,
            evidenceFile: path.basename(evidenceFile),
            reason: 'pending snapshot under a FAILED/CANCELLED run (orphan)',
          },
        }, session);
        return { outcome: 'PURGED', reason: `run ${run.status}` };
      }, { label: 'payroll.snapshot.reconcile.purge' });

      results.push({ snapshotId: item.snapshotId, runId: item.runId, ...outcome });
      writeEvidence(evidenceFile, { kind: 'RESULT', at: now().toISOString(), snapshotId: item.snapshotId, ...outcome });
    }
  } finally {
    await releaseLock(owner);
  }
  return { evidenceFile, results, purged: results.filter((r) => r.outcome === 'PURGED').length };
}
