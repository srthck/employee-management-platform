/**
 * The audit chain's required database shape, and the pure functions that judge a live collection against it.
 *
 * Linearity of the chain does NOT depend on any of this: it comes from the transactional head protocol in
 * auditService (one head document, advanced by compare-and-set in the same transaction as the record). The three
 * unique indexes and the insert validator are DEFENCE IN DEPTH and the mechanism that blocks writers which do not
 * know the protocol:
 *
 *   sequenceNumber   unique                       one record per position
 *   previousHash     unique, partial $type string one successor per predecessor
 *   headVersion      unique, partial $type number one record per head transition (the one-to-one tie between a
 *                                                 head advance and its record)
 *   validator        every NEW record must carry a numeric headVersion >= 1. A writer from before the protocol
 *                    (an old binary, an old script) never sets it, so the database refuses its insert.
 *                    This blocks UNAWARE writers; it is not a security boundary (a writer that fakes the field
 *                    is not stopped), and it does not restrict updates of pre-existing records.
 */

export const HEAD_ID = 'global';
export const HEAD_COLLECTION = 'auditchainheads';
export const AUDIT_COLLECTION = 'auditlogs';

export const REQUIRED_INDEXES = Object.freeze([
  Object.freeze({ id: 'sequence', label: 'unique sequenceNumber', name: 'sequenceNumber_1', key: Object.freeze({ sequenceNumber: 1 }), unique: true, partialFilterExpression: null }),
  Object.freeze({ id: 'predecessor', label: 'unique previousHash (partial, string)', name: 'previousHash_unique_successor', key: Object.freeze({ previousHash: 1 }), unique: true, partialFilterExpression: Object.freeze({ previousHash: Object.freeze({ $type: 'string' }) }) }),
  Object.freeze({ id: 'headVersion', label: 'unique headVersion (partial, number)', name: 'headVersion_unique_transition', key: Object.freeze({ headVersion: 1 }), unique: true, partialFilterExpression: Object.freeze({ headVersion: Object.freeze({ $type: 'number' }) }) }),
]);

export const REQUIRED_VALIDATOR = Object.freeze({
  $jsonSchema: Object.freeze({
    bsonType: 'object',
    required: Object.freeze(['headVersion']),
    properties: Object.freeze({ headVersion: Object.freeze({ bsonType: Object.freeze(['int', 'long', 'double', 'decimal']), minimum: 1 }) }),
  }),
});
export const VALIDATION_OPTIONS = Object.freeze({ validationLevel: 'moderate', validationAction: 'error' });

const canon = (value) => JSON.stringify(value, (_k, v) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
  return v;
});
const sameKey = (a, b) => canon(a) === canon(b) && Object.keys(a).join() === Object.keys(b).join();

/**
 * Why a live index is not the required one, or null when it is an exact match. Name is irrelevant; everything that
 * changes WHICH documents the index constrains is compared: key and key order, uniqueness, partial filter, sparse,
 * collation, TTL, hidden, and an unfinished build.
 */
export function indexMismatch(live, required) {
  const reasons = [];
  if (!sameKey(live.key, required.key)) reasons.push('different key');
  if (live.unique !== true) reasons.push('not unique');
  const livePartial = live.partialFilterExpression ?? null;
  if (canon(livePartial) !== canon(required.partialFilterExpression)) reasons.push(`partial filter is ${livePartial === null ? 'absent' : canon(livePartial)}, required ${required.partialFilterExpression === null ? 'none' : canon(required.partialFilterExpression)}`);
  if (live.sparse) reasons.push('sparse');
  if (live.collation) reasons.push('has a collation');
  if (live.expireAfterSeconds !== undefined) reasons.push('is a TTL index');
  if (live.hidden) reasons.push('hidden');
  if (live.buildUUID !== undefined || live.building) reasons.push('build not finished');
  return reasons.length ? reasons.join('; ') : null;
}

/**
 * @param {object[]} liveIndexes result of collection.indexes() (empty when the collection does not exist)
 * @returns {Array<{ id: string, label: string, status: 'OK'|'MISSING'|'INCOMPATIBLE', detail: string|null }>}
 */
export function evaluateIndexes(liveIndexes) {
  return REQUIRED_INDEXES.map((required) => {
    const sameKeyed = liveIndexes.filter((live) => sameKey(live.key, required.key));
    if (sameKeyed.length === 0) return { id: required.id, label: required.label, status: 'MISSING', detail: null };
    const mismatches = sameKeyed.map((live) => indexMismatch(live, required));
    if (mismatches.includes(null)) return { id: required.id, label: required.label, status: 'OK', detail: null };
    return { id: required.id, label: required.label, status: 'INCOMPATIBLE', detail: `index ${sameKeyed.map((l) => l.name).join(', ')}: ${mismatches[0]}` };
  });
}

/** @returns {{ status: 'OK'|'MISSING'|'INCOMPATIBLE', detail: string|null }} for the collection's validator options */
export function evaluateValidator(collectionOptions) {
  const validator = collectionOptions?.validator;
  if (!validator || Object.keys(validator).length === 0) return { status: 'MISSING', detail: null };
  if (canon(validator) !== canon(REQUIRED_VALIDATOR)) return { status: 'INCOMPATIBLE', detail: `validator is ${canon(validator)}` };
  if (collectionOptions.validationAction && collectionOptions.validationAction !== 'error') return { status: 'INCOMPATIBLE', detail: `validationAction is ${collectionOptions.validationAction}` };
  if (collectionOptions.validationLevel === 'off') return { status: 'INCOMPATIBLE', detail: 'validationLevel is off' };
  return { status: 'OK', detail: null };
}
