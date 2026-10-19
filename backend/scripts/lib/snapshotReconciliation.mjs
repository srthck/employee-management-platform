import mongoose from 'mongoose';
import PayrollSnapshot, { computeSnapshotHash } from '../../src/models/PayrollSnapshot.js';
import PayrollRun, { PAYROLL_STATUS } from '../../src/models/PayrollRun.js';
import AuditLog from '../../src/models/AuditLog.js';
import auditService from '../../src/services/auditService.js';
import payrollRunRepository from '../../src/repositories/payrollRunRepository.js';
import { buildSnapshotPayloadFromStaging } from '../../src/services/payrollSnapshotService.js';
import { assertRealTransactions } from '../../src/utils/transaction.js';
import { OBJECT_ID } from './cliArgs.mjs';

/**
 * Pending-snapshot reconciliation (see docs/AUDIT-CHAIN-AND-SNAPSHOT-RECOVERY.md and docs/integrity/).
 *
 * scanPayrollSnapshots()  READ-ONLY. Classifies every snapshot (and every finalized run) against its run,
 *                         its hash, the staging it was built from and the audit chain. Never writes.
 * purgeOrphans()          DISABLED. Destructive recovery is withdrawn: this module contains NO code that
 *                         deletes or modifies a snapshot, a run, staging or an audit record. The previous
 *                         implementation (commit 04c872b) was found to purge on stale run state and to ignore
 *                         finalization history; it returns only through a proof-based rebuild with run-revision
 *                         protection, fencing and an evidence protocol, independently verified. Until then
 *                         purgeOrphans() refuses unconditionally and reports every reason it can establish.
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

// ─── Apply is disabled ────────────────────────────────────────────────────────────────────────────

export class ReconciliationRefused extends Error {
  constructor(message, reasons) {
    super(message);
    this.name = 'ReconciliationRefused';
    this.reasons = reasons;
  }
}

export const APPLY_DISABLED_REASON =
  'APPLY_DISABLED: destructive snapshot recovery is withdrawn until proof-based eligibility, run-revision protection, fencing and the evidence protocol are implemented and independently verified (docs/integrity/CLAIMS-LEDGER.md, Phase 4); no flag, environment variable or entry point enables it';

/**
 * Pure: every reason an apply request must be refused that can be established WITHOUT touching the
 * database. APPLY_DISABLED is always among them.
 */
export function staticApplyRefusals({ operator, company, run } = {}) {
  const reasons = [APPLY_DISABLED_REASON];
  if (typeof operator !== 'string' || operator.trim() === '' || operator.length > 100 || /[ -]/.test(operator)) {
    reasons.push('OPERATOR_INVALID: a non-blank operator name of at most 100 printable characters is required');
  }
  if (!company || !OBJECT_ID.test(String(company))) reasons.push('SCOPE_REQUIRED: --company must be an explicit 24-hex company id (no default scope)');
  if (!run || !OBJECT_ID.test(String(run))) reasons.push('SCOPE_REQUIRED: --run must be an explicit 24-hex run id (no default scope)');
  return reasons;
}

/**
 * Refuses, always. Computes the dynamic reasons too (real transactions, chain, guards) so an operator
 * sees everything that is wrong, not just that apply is withdrawn. The `scan` is caller-supplied and is
 * NEVER trusted to authorize anything: it can only add reasons.
 */
export async function purgeOrphans({ scan, operator, company, run } = {}) {
  const reasons = staticApplyRefusals({ operator, company, run });
  try {
    await assertRealTransactions();
  } catch {
    reasons.push('TRANSACTIONS_UNAVAILABLE: real MongoDB transactions cannot be established (application configuration is not consulted)');
  }
  if (scan?.auditChain?.valid !== true) reasons.push('CHAIN_UNVERIFIED: the audit chain is invalid or was not verified');
  if (scan?.auditChainGuards?.ok !== true) reasons.push('CHAIN_GUARDS_UNVERIFIED: the audit chain guards are missing or were not verified');
  throw new ReconciliationRefused(`Refusing to apply: ${reasons.join('; ')}.`, reasons);
}
