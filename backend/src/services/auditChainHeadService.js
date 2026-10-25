import crypto from 'node:crypto';
import mongoose from 'mongoose';
import AuditLog from '../models/AuditLog.js';
import AuditChainHead from '../models/AuditChainHead.js';
import auditService, { GENESIS_HASH } from './auditService.js';
import { AUDIT_COLLECTION, HEAD_ID, REQUIRED_INDEXES, REQUIRED_VALIDATOR, VALIDATION_OPTIONS } from './auditChainSpec.js';

/**
 * Controlled initialization (cutover) of the audit chain head. See docs/integrity/AUDIT-CHAIN-HEAD.md.
 *
 * planHeadInitialization()   READ-ONLY. Verifies the visible history and the database shape and reports exactly what
 *                            apply would do. Creates nothing: no head, no collection, no index, no validator.
 * applyHeadInitialization()  Refuses unless the plan is acceptable AND its digest equals the one the operator reviewed.
 *                            Then, in this order: create the collection/indexes that are missing, set the collection
 *                            validator (from this moment writers that do not know the protocol are refused by the
 *                            database), and in ONE transaction re-read the tail, require it to equal the planned
 *                            tail, and insert the single head document. No existing record is ever modified.
 *
 * LIMITATION (stated, not hidden): without an external checkpoint nothing can prove that records after the
 * visible tail were not removed BEFORE this point. The head records the visible, verified tail as the starting
 * trusted baseline; it says nothing about the completeness of older history.
 */

const stableJson = (value) => JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
const unchained = () => ({ $or: [{ sequenceNumber: null }, { hash: null }, { previousHash: null }] });
const heads = () => AuditChainHead.collection;

/**
 * WHICH database the plan was made against: name, the hosts this process is connected to, replica set, SRV host. A
 * --confirm-database name alone cannot tell a production cluster from a restored copy that uses the same name; the target is part
 * of the plan digest, so a plan reviewed against one cluster cannot be applied to another.
 */
export function connectionTarget() {
  const options = mongoose.connection.getClient().options;
  const hosts = (options.hosts || []).map((entry) => (entry.socketPath ? entry.socketPath : `${String(entry.host).toLowerCase()}:${entry.port}`)).sort();
  return { database: mongoose.connection.name, hosts, replicaSet: options.replicaSet ?? null, srvHost: options.srvHost ?? null };
}

export async function planHeadInitialization({ quietSeconds = 60, now = new Date(), acceptUnobservableIndexBuilds = false } = {}) {
  const findings = [];
  const finding = (code, detail) => findings.push({ code, detail });
  const actions = [];

  const existingHead = await heads().findOne({ _id: HEAD_ID });
  const collections = await mongoose.connection.db.listCollections({ name: AUDIT_COLLECTION }).toArray();
  const collectionExists = collections.length > 0;
  if (!collectionExists) actions.push('CREATE_COLLECTION');

  const shape = await auditService.databaseShape();
  for (const index of shape.indexes) {
    if (index.status === 'INCOMPATIBLE') finding('INDEX_INCOMPATIBLE', `${index.label}: ${index.detail}. Resolve it by hand (drop the look-alike), then re-run; this tool never replaces an existing index.`);
    else if (index.status === 'MISSING') actions.push(`CREATE_INDEX ${index.label}`);
  }
  if (shape.validator.status === 'INCOMPATIBLE') finding('VALIDATOR_INCOMPATIBLE', `${shape.validator.detail}. Resolve it by hand, then re-run.`);
  else if (shape.validator.status === 'MISSING') actions.push('SET_VALIDATOR');

  let tail = null;
  let records = 0;
  let verification = { valid: true, checkedRecords: 0, firstBrokenSequence: null, reason: null };
  if (collectionExists) {
    records = await AuditLog.collection.countDocuments({});
    if (await AuditLog.collection.countDocuments(unchained(), { limit: 1 }) > 0) {
      finding('UNCHAINED_RECORDS', 'records without chain fields exist: run scripts/audit-chain-legacy-backfill.mjs first (the migration must happen BEFORE the head exists)');
    }
    if (!existingHead && await AuditLog.collection.countDocuments({ headVersion: { $exists: true } }, { limit: 1 }) > 0) {
      finding('HEAD_MISSING_BUT_PROTOCOL_RECORDS', 'records written under the head protocol exist but the head document does not: it was removed. This is an integrity incident, not an initialization; the tool will not guess a head.');
    }
    try {
      verification = await auditService.verifyAuditChain();
    } catch (error) {
      // verifyAuditChain throws on a record it cannot even hash (for example an unparseable createdAt): a finding, not a crash.
      verification = { valid: true, checkedRecords: 0, firstBrokenSequence: null, reason: null };
      finding('CHAIN_RECORD_MALFORMED', `a record could not be verified (${error.message}). Investigate the audit collection; the tool will not choose a head over history it cannot read.`);
    }
    if (!verification.valid) finding('CHAIN_INVALID', `${verification.reason} (first broken sequence ${verification.firstBrokenSequence}). A fork, gap, bad link or edited record: investigate; the tool will not choose a head.`);
    const last = await AuditLog.collection.find({}, { sort: { sequenceNumber: -1 }, limit: 1, projection: { sequenceNumber: 1, hash: 1, createdAt: 1 } }).next();
    if (last) {
      tail = { sequence: last.sequenceNumber, hash: last.hash, createdAt: new Date(last.createdAt).toISOString() };
      const ageSeconds = (now.getTime() - new Date(last.createdAt).getTime()) / 1000;
      if (quietSeconds > 0 && ageSeconds < quietSeconds) finding('RECENT_WRITES', `the newest record is ${ageSeconds.toFixed(0)} s old (< ${quietSeconds} s): writers may still be running. Drain every application instance, job and script first, then re-run`);
    }
  }
  const build = await auditService.indexBuildState();
  if (build.state === 'RUNNING') finding('INDEX_BUILD_RUNNING', 'an index build on the audit collection is running');
  else if (build.state === 'UNAVAILABLE' && !acceptUnobservableIndexBuilds) {
    finding('INDEX_BUILD_UNOBSERVABLE', `running index builds cannot be observed by this database user (${build.detail}). Run the tool as a user that may run $currentOp, or confirm yourself that no index build is running on ${AUDIT_COLLECTION} and re-run with --accept-unobservable-index-builds.`);
  }
  const unobservableAccepted = build.state === 'UNAVAILABLE' && acceptUnobservableIndexBuilds;

  if (existingHead) {
    const status = await auditService.verifyHead();
    finding('HEAD_ALREADY_EXISTS', `a head already exists (sequence ${existingHead.sequence}, version ${existingHead.version}); it is ${status.ok ? 'consistent with the chain' : `INCONSISTENT: ${status.reason}`}. Initialization does not run twice.`);
  } else if (findings.length === 0) {
    actions.push(`CREATE_HEAD at sequence ${tail ? tail.sequence : 0}`);
  }

  const target = connectionTarget();
  const digest = crypto.createHash('sha256').update(stableJson({ target, tail, records, actions, existingHead: Boolean(existingHead), unobservableAccepted })).digest('hex');
  return { ok: findings.length === 0, findings, alreadyInitialized: Boolean(existingHead), counts: { records, verifiedRecords: verification.checkedRecords }, tail, actions, target, indexBuild: build, unobservableAccepted, digest, limitation: 'The head records the verified tail as the starting trusted baseline. Without an external checkpoint this cannot prove that records after it were not removed before this point.' };
}

export class HeadInitializationRefused extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'HeadInitializationRefused';
    this.code = code;
    Object.assign(this, extra);
  }
}

export async function applyHeadInitialization({ expectedDigest, operator, commit = null, quietSeconds = 60, now = new Date(), acceptUnobservableIndexBuilds = false } = {}) {
  if (!operator || !String(operator).trim()) throw new HeadInitializationRefused('OPERATOR_REQUIRED', 'an operator name is required');
  const plan = await planHeadInitialization({ quietSeconds, now, acceptUnobservableIndexBuilds });
  if (!plan.ok) throw new HeadInitializationRefused('PLAN_REFUSED', `Head initialization refused: ${plan.findings.map((f) => f.code).join(', ')}.`, { findings: plan.findings });
  if (!expectedDigest || expectedDigest !== plan.digest) throw new HeadInitializationRefused('DIGEST_MISMATCH', 'Head initialization refused: the plan digest does not match the reviewed plan (the data changed, or no digest was given).', { digest: plan.digest });

  const db = mongoose.connection.db;
  if (plan.actions.includes('CREATE_COLLECTION')) await db.createCollection(AUDIT_COLLECTION);
  for (const required of REQUIRED_INDEXES) {
    if (plan.actions.includes(`CREATE_INDEX ${required.label}`)) {
      await AuditLog.collection.createIndex(required.key, { name: required.name, unique: true, ...(required.partialFilterExpression && { partialFilterExpression: required.partialFilterExpression }) });
    }
  }
  // From here on the database refuses any new record that lacks headVersion: an old binary or script cannot append.
  await db.command({ collMod: AUDIT_COLLECTION, validator: REQUIRED_VALIDATOR, ...VALIDATION_OPTIONS });

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const last = await AuditLog.collection.find({}, { session, sort: { sequenceNumber: -1 }, limit: 1, projection: { sequenceNumber: 1, hash: 1 } }).next();
      const count = await AuditLog.collection.countDocuments({}, { session });
      const tail = last ? { sequence: last.sequenceNumber, hash: last.hash } : null;
      if (count !== plan.counts.records || (tail?.sequence ?? null) !== (plan.tail?.sequence ?? null) || (tail?.hash ?? null) !== (plan.tail?.hash ?? null)) {
        throw new HeadInitializationRefused('CHAIN_CHANGED_DURING_CUTOVER', 'Head initialization aborted: the chain changed between the plan and the head creation (a writer was still active). The collection validator is now set, so audited operations are refused until you re-run this tool.', { planned: plan.tail, found: tail, plannedRecords: plan.counts.records, foundRecords: count });
      }
      try {
        await heads().insertOne({
          _id: HEAD_ID, scope: 'global', formatVersion: 1,
          sequence: tail ? tail.sequence : 0, hash: tail ? tail.hash : GENESIS_HASH, version: 1,
          baseline: { sequence: tail ? tail.sequence : 0, hash: tail ? tail.hash : GENESIS_HASH, source: 'initialized-from-verified-history', at: new Date(), operator: String(operator), planDigest: plan.digest, commit },
        }, { session });
      } catch (error) {
        if (error?.code === 11000) throw new HeadInitializationRefused('HEAD_ALREADY_EXISTS', 'Head initialization lost the race: another initializer created the head first.');
        throw error;
      }
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
  } finally {
    await session.endSession();
  }
  const status = await auditService.protocolStatus({ checkBuilds: false });
  return { applied: true, planDigest: plan.digest, tail: plan.tail, target: plan.target, status };
}
