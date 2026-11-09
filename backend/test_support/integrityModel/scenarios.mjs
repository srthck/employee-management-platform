/**
 * Every model scenario, with the invariants it is EXPECTED to violate. A scenario of role
 *   'current'     : the design as committed (04c872b / ad2aa3f)       — known failures are expected to be reachable
 *   'proposed'    : the design the next phases will build             — expected to violate nothing
 *   'sensitivity' : the proposed design with ONE protection removed   — shows each protection is load-bearing
 *   'partial'     : ONE protection alone                              — shows what it does and does not cover
 *   'boundary'    : a rollout / environment condition                  — shows what the design needs from operations
 * `trace` marks scenarios whose shortest counterexamples are printed in MODEL-RESULTS.md.
 */
import { auditChainModel } from './auditChain.mjs';
import { businessAuditModel } from './businessAudit.mjs';
import { recoveryModel } from './recovery.mjs';
import { legacyBackfillModel, evidenceBoundaryModel } from './historyAndEvidence.mjs';
import { operationRecordModel } from './operationRecord.mjs';

const A = (params) => () => auditChainModel(params);
const B = (params) => () => businessAuditModel(params);
const C = (params) => () => recoveryModel(params);
const F = (params) => () => operationRecordModel(params);

const FORK = ['OneSuccessorPerPredecessor', 'SuccessNeverReportedForForkedPosition', 'UniqueSequence'];

export const SCENARIOS = [
  // ── A. audit chain append ──
  { id: 'A1', area: 'Audit chain', role: 'current', title: 'current design, both unique indexes stay present', params: 'writers=2, no index drops', build: A({ design: 'current', drops: [] }), expect: [] },
  { id: 'A2', area: 'Audit chain', role: 'current', title: 'current design, only the sequenceNumber index can be dropped', params: 'writers=2, drop {seq}', build: A({ design: 'current', drops: ['seq'] }), expect: [] },
  { id: 'A3', area: 'Audit chain', role: 'current', title: 'current design, only the previousHash index can be dropped', params: 'writers=2, drop {prev}', build: A({ design: 'current', drops: ['prev'] }), expect: [] },
  { id: 'A4', area: 'Audit chain', role: 'current', title: 'current design, both indexes can be dropped (the guard cache hides it)', params: 'writers=2, drop {seq, prev}', build: A({ design: 'current' }), expect: FORK, trace: true },
  { id: 'A5', area: 'Audit chain', role: 'proposed', title: 'transactional head compare-and-set, both indexes can be dropped', params: 'writers=2, drop {seq, prev}', build: A({ design: 'head-cas' }), expect: [] },
  { id: 'A6', area: 'Audit chain', role: 'proposed', title: 'transactional head compare-and-set, three writers', params: 'writers=3, drop {seq, prev}', build: A({ design: 'head-cas', writers: 3 }), expect: [] },
  { id: 'A7', area: 'Audit chain', role: 'sensitivity', title: 'head document updated WITHOUT the version condition, indexes dropped', params: 'writers=2, drop {seq, prev}', build: A({ design: 'head-cas', blindHead: true }), expect: [...FORK, 'HeadMatchesLastCommittedEntry'].sort() },
  { id: 'A8', area: 'Audit chain', role: 'partial', title: 'head document updated WITHOUT the version condition, indexes present (defence in depth)', params: 'writers=2, no drops', build: A({ design: 'head-cas', blindHead: true, drops: [] }), expect: [] },
  { id: 'A9', area: 'Audit chain', role: 'boundary', title: 'new protocol + an OLD writer that bypasses the head document, indexes present', params: 'writers=2, 1 legacy writer, no drops', build: A({ design: 'head-cas', drops: [], legacyWriter: true }), expect: ['HeadMatchesLastCommittedEntry'], trace: true },
  { id: 'A10', area: 'Audit chain', role: 'boundary', title: 'new protocol + an OLD writer, indexes dropped', params: 'writers=2, 1 legacy writer, drop {seq, prev}', build: A({ design: 'head-cas', legacyWriter: true }), expect: [...FORK, 'HeadMatchesLastCommittedEntry'].sort(), trace: true },

  // ── B. business mutation, audit event, client retries ──
  { id: 'B1', area: 'Business/audit', role: 'current', title: 'plain path: business commit, then a separate audit append (payroll lifecycle, auth call sites)', params: '1 logical operation, ≤2 attempts', build: B({ path: 'plain' }), expect: ['ErrorsAreTruthful', 'NoCommittedCriticalMutationWithoutRequiredAudit', 'NoDuplicateLogicalOperation'], trace: true },
  { id: 'B2', area: 'Business/audit', role: 'current', title: 'transactional path (business + event in one transaction), no operation id', params: '1 logical operation, ≤2 attempts, ambiguous commit possible', build: B({ path: 'transactional' }), expect: ['NoDuplicateLogicalOperation'], trace: true },
  { id: 'B3', area: 'Business/audit', role: 'partial', title: 'plain path with a durable obligation (outbox), no operation id', params: '1 logical operation, ≤2 attempts', build: B({ path: 'plain', outbox: true }), expect: ['NoDuplicateLogicalOperation'] },
  { id: 'B4', area: 'Business/audit', role: 'proposed', title: 'transactional path with an operation id checked in the same transaction', params: '1 logical operation, ≤2 attempts, ambiguous commit possible', build: B({ path: 'transactional', idempotent: true }), expect: [] },
  { id: 'B5', area: 'Business/audit', role: 'sensitivity', title: 'operation record written but never consulted', params: '1 logical operation, ≤2 attempts', build: B({ path: 'transactional', idempotent: true, idemLookup: false }), expect: ['NoDuplicateLogicalOperation'] },

  // ── C. recovery: purge, run retry, lease ──
  { id: 'C1', area: 'Recovery', role: 'current', title: 'purge as built in 04c872b, a genuine orphan run', params: '2 workers; lease may expire once; run may be retried once', build: C({ init: 'orphan' }), expect: ['ExpiredOwnerCannotDelete', 'NoPurgeAfterEligibilityChanges'], trace: true },
  { id: 'C2', area: 'Recovery', role: 'current', title: 'purge as built in 04c872b, a previously finalized snapshot whose status fields were flipped', params: 'as C1, finalization evidence exists', build: C({ init: 'finalized-corrupted' }), expect: ['ExpiredOwnerCannotDelete', 'NoPurgeAfterEligibilityChanges', 'NoPurgeOfEverFinalized'], trace: true },
  { id: 'C3', area: 'Recovery', role: 'proposed', title: 'run revision written + evidence checked + fencing token, orphan run', params: 'as C1', build: C({ init: 'orphan', writeRun: true, checkEvidence: true, fence: true }), expect: [] },
  { id: 'C4', area: 'Recovery', role: 'proposed', title: 'run revision written + evidence checked + fencing token, finalized-then-corrupted snapshot', params: 'as C2', build: C({ init: 'finalized-corrupted', writeRun: true, checkEvidence: true, fence: true }), expect: [] },
  { id: 'C5', area: 'Recovery', role: 'sensitivity', title: 'proposed protocol WITHOUT the run write', params: 'as C1', build: C({ init: 'orphan', checkEvidence: true, fence: true }), expect: ['NoPurgeAfterEligibilityChanges'] },
  { id: 'C6', area: 'Recovery', role: 'sensitivity', title: 'proposed protocol WITHOUT the evidence check', params: 'as C2', build: C({ init: 'finalized-corrupted', writeRun: true, fence: true }), expect: ['NoPurgeOfEverFinalized'] },
  { id: 'C7', area: 'Recovery', role: 'sensitivity', title: 'proposed protocol WITHOUT fencing', params: 'as C1', build: C({ init: 'orphan', writeRun: true, checkEvidence: true }), expect: ['ExpiredOwnerCannotDelete'] },
  { id: 'C8', area: 'Recovery', role: 'partial', title: 'only the run write (no fencing, no evidence check)', params: 'as C1', build: C({ init: 'orphan', writeRun: true }), expect: ['ExpiredOwnerCannotDelete'] },
  { id: 'C9', area: 'Recovery', role: 'partial', title: 'only fencing (no run write, no evidence check)', params: 'as C1', build: C({ init: 'orphan', fence: true }), expect: ['NoPurgeAfterEligibilityChanges'] },

  // ── D. history ──
  { id: 'D1', area: 'History', role: 'current', title: 'startup backfill of 04c872b, a legacy record OLDER than the chained records', params: '2 chained records + 1 older unchained', build: () => legacyBackfillModel({ design: 'old', legacyIsOlder: true }), expect: ['HistoricalHashesRemainStable'], trace: true },
  { id: 'D2', area: 'History', role: 'current', title: 'startup backfill of 04c872b, a legacy record NEWER than the chained records', params: '2 chained records + 1 newer unchained', build: () => legacyBackfillModel({ design: 'old', legacyIsOlder: false }), expect: [] },
  { id: 'D3', area: 'History', role: 'proposed', title: 'explicit migration (Phase 0), legacy record older than the chain tail', params: '2 chained records + 1 older unchained', build: () => legacyBackfillModel({ design: 'new', legacyIsOlder: true }), expect: [] },
  { id: 'D4', area: 'History', role: 'proposed', title: 'explicit migration (Phase 0), legacy record newer than the chain tail', params: '2 chained records + 1 newer unchained', build: () => legacyBackfillModel({ design: 'new', legacyIsOlder: false }), expect: [] },

  // ── E. database / filesystem boundary ──
  { id: 'E1', area: 'Evidence', role: 'current', title: 'before-image: fsync(file) only, then the database transaction (04c872b)', params: 'power loss at most once, at any time', build: () => evidenceBoundaryModel({ dirFsync: false }), expect: ['EvidenceDurableBeforeDelete'], trace: true },
  { id: 'E3', area: 'Evidence', role: 'boundary', title: 'non-transactional fallback (REQUIRE_TRANSACTIONS=false on a standalone server): delete and audit event are separate writes, directory fsync present', params: 'power loss at most once, at any time', build: () => evidenceBoundaryModel({ dirFsync: true, atomicCommit: false }), expect: ['NoDeleteWithoutAudit'], trace: true },
  { id: 'E2', area: 'Evidence', role: 'proposed', title: 'before-image: fsync(file) and fsync(directory) before the database transaction', params: 'power loss at most once, at any time', build: () => evidenceBoundaryModel({ dirFsync: true }), expect: [] },

  // ── F. the operation-record protocol as implemented in Phase 3 (added 2026-11-09) ──
  { id: 'F1', area: 'Operation record', role: 'current', title: 'the implemented protocol: token fencing, takeover only with nothing committed, COMPLETED-only TTL, UNKNOWN kept, nested transactions refused', params: '1 key, ≤2 attempts; lost acks, lagging evidence reads, crashes, lock expiry, TTL', build: F({}), expect: [] },
  { id: 'F2', area: 'Operation record', role: 'current', title: 'as F1 with three attempts', params: '1 key, ≤3 attempts', build: F({ attempts: 3 }), expect: [] },
  { id: 'F3', area: 'Operation record', role: 'sensitivity', title: 'the in-transaction record update does not check the lock token', params: 'as F1', build: F({ fence: false }), expect: ['NoDuplicateLogicalOperation'], trace: true },
  { id: 'F4', area: 'Operation record', role: 'sensitivity', title: 'an expired lock can be taken over although the attempt committed work', params: 'as F1', build: F({ takeoverCheck: false }), expect: ['NoDuplicateLogicalOperation'] },
  { id: 'F5', area: 'Operation record', role: 'sensitivity', title: 'every record expires (the TTL index before 2026-11-09)', params: 'as F1', build: F({ ttlSettledOnly: false }), expect: ['NoDuplicateLogicalOperation'], trace: true },
  { id: 'F6', area: 'Operation record', role: 'sensitivity', title: 'an unconfirmed commit releases the key as if nothing happened', params: 'as F1', build: F({ unknownKept: false }), expect: ['NoDuplicateLogicalOperation'] },
  { id: 'F7', area: 'Operation record', role: 'sensitivity', title: 'a nested transaction may commit on its own, unrecorded', params: 'as F1', build: F({ nestedRefused: false }), expect: ['NoDuplicateLogicalOperation'] },
  { id: 'F9', area: 'Operation record', role: 'sensitivity', title: 'an unconfirmed commit is reported as a success without evidence', params: 'as F1', build: F({ trustUnconfirmed: true }), expect: ['SuccessOnlyIfApplied'] },
  { id: 'F8', area: 'Operation record', role: 'boundary', title: 'a request stays in flight longer than the TTL (24 h)', params: 'as F1, TTL may fire mid-flight', build: F({ ttlWhileInFlight: true }), expect: ['NoDuplicateLogicalOperation'] },
];

/** The invariants named by the integrity program, and the model that checks each. */
export const MANDATED_INVARIANTS = {
  OneSuccessorPerPredecessor: 'A',
  HeadMatchesLastCommittedEntry: 'A',
  NoCommittedCriticalMutationWithoutRequiredAudit: 'B',
  NoDuplicateLogicalOperation: 'B',
  NoPurgeOfEverFinalized: 'C',
  NoPurgeAfterEligibilityChanges: 'C',
  ExpiredOwnerCannotDelete: 'C',
  HistoricalHashesRemainStable: 'D',
};
