/**
 * Pure territorial and establishment applicability resolver (Phase 1D scaffold, UNWIRED).
 *
 * Question it answers: for this establishment, on this date (or across this period), is there
 * verified evidence that a Code-era territorial notification applies, and is every dependency of
 * that conclusion established? When it cannot say so, it returns a BLOCKED outcome with a named
 * code. It never returns a regime by default.
 *
 * Four layers are kept separate and never inferred from one another:
 *   1. national Code commencement                 (supplied by the caller; not decided here)
 *   2. territorial Chapter IV implementation      (verified notification records, per unit/date)
 *   3. establishment-level facts                  (location, category state)
 *   4. legal continuation/saving of a legacy regime (only from an approved decision record)
 *
 * Context: `context` is 'TEST' or 'PRODUCTION'; OMITTING IT MEANS PRODUCTION and an unknown value
 * throws EXECUTION_CONTEXT_INVALID. In PRODUCTION nothing resolves today:
 *   - an inventory that is not complete (literal `enumerationComplete: true`) blocks EVERY
 *     determination that depends on it, an apparent match included -> ENUMERATION_INCOMPLETE;
 *   - even a complete, fully verified inventory is a caller-supplied claim: there is no trusted
 *     territorial register, and a caller-supplied `approved` flag, `decisionRef`, `provenance` label
 *     or hash is not proof -> PRODUCTION_AUTHORITY_UNAVAILABLE.
 * TEST resolves from fixture records so that the matching logic itself can be exercised.
 *
 * Fail-closed rules (all contexts unless stated):
 *   - No work-location evidence for the date          -> ESTABLISHMENT_LOCATION_UNRESOLVED
 *     (a residential address is never a substitute; a state without a district is not enough;
 *      names are matched as exact canonical identities, never by prefix or substring)
 *   - A matching record that is not primary-verified  -> TERRITORIAL_INSTRUMENT_UNVERIFIED
 *   - A matching record touched by a supersession with
 *     no complete, approved decision                  -> SUPERSESSION_UNRESOLVED
 *   - No matching record, inventory not complete      -> ENUMERATION_INCOMPLETE
 *     (absence from an incomplete corpus is NEVER "not covered"); PRODUCTION: also with a match
 *   - A date before the effective date, or a period
 *     crossing it, with no approved transition        -> TRANSITION_TREATMENT_UNRESOLVED
 *   - Establishment category state not established    -> ESTABLISHMENT_COVERAGE_STATE_UNRESOLVED
 *   - A legacy regime is NEVER assigned merely because no notification was found; it needs an
 *     approved decision record.
 *
 * Input objects are strict: an unrecognized key is APPLICABILITY_INPUT_INVALID, never ignored.
 *
 * Pure: no database, no clock, no network. It reads only what the caller passes in.
 */

import { APPLICABILITY_BLOCK_CODES as B, STATUTORY_WAGE_ERROR_CODES as C, StatutoryWageError, fail } from './errors.js';
import { resolveExecutionContext, EXECUTION_CONTEXTS } from './context.js';
import { toOwnData } from './ownData.js';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const isLeap = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** A real calendar date in YYYY-MM-DD form (not merely something shaped like one). */
const isDate = (value) => {
  const match = typeof value === 'string' ? ISO_DATE.exec(value) : null;
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return month >= 1 && month <= 12 && day >= 1 && day <= (month === 2 && isLeap(year) ? 29 : DAYS[month - 1]);
};

/** A plain data object: its prototype is Object.prototype or null, so nothing is inherited from a caller-built prototype. */
const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
/** An array. (A sparse array, or one with extra or symbol-keyed properties, never gets here: toOwnData replaces it with a NotPlainData marker.) */
const isDenseArray = (value) => Array.isArray(value);
/** The requested context, read only from an OWN property: an inherited `context` can never select TEST. */
const requestedContext = (input) => (isPlainObject(input) && Object.prototype.hasOwnProperty.call(input, 'context') ? input.context : undefined);
const nonEmptyText = (value) => typeof value === 'string' && value.trim() !== '';
/** An open end (null or omitted), or a REAL date on or after `date`. A malformed end date never counts as open-ended. */
const endsOnOrAfter = (effectiveTo, date) => effectiveTo == null || (isDate(effectiveTo) && effectiveTo >= date);

/**
 * Exact canonical identity of a state or district name: Unicode NFC, whitespace trimmed and
 * collapsed, lower-cased. Two names are the same place only if these keys are EQUAL; one being a
 * prefix, suffix or substring of the other is not a match.
 */
const identityKey = (text) => String(text).normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * A name whose identity cannot be established from its characters alone: empty, containing control
 * characters or pattern/wildcard characters, or containing compatibility-only forms (full-width
 * letters, ligatures ...) whose equivalence to a plain spelling nobody has approved. Such a name
 * never matches and never silently falls back to "not covered".
 */
const ambiguousName = (text) => !nonEmptyText(text) || identityKey(text) === ''
  || /[\u0000-\u001f\u007f-\u009f*%?\\|^$[\]{}]/.test(text)
  || text.normalize('NFC') !== text.normalize('NFKC');

const blocked = (code, detail, extra = {}) => ({ outcome: 'BLOCKED', code, detail, ...extra });

export const REGIMES = Object.freeze({
  TERRITORIALLY_NOTIFIED: 'CODE_CHAPTER_IV_TERRITORIALLY_NOTIFIED',
  LEGACY_CONTINUATION_DECIDED: 'LEGACY_ESI_ACT_CONTINUATION_DECIDED',
});

const INPUT_KEYS = new Set(['establishment', 'period', 'inventory', 'supersessionResolutions', 'legacyContinuation', 'context']);
const ESTABLISHMENT_KEYS = new Set(['establishmentId', 'locations', 'categoryState']);
const LOCATION_KEYS = new Set(['effectiveFrom', 'effectiveTo', 'state', 'district']);
const INVENTORY_KEYS = new Set(['enumerationComplete', 'records']);
const RECORD_KEYS = new Set(['recordId', 'provenance', 'instrument', 'state', 'units', 'effectiveDate', 'supersedes', 'supersessionStatus', 'verification']);
const VERIFICATION_KEYS = new Set(['textStatus', 'sourceArtifactHash']);
const DECISION_KEYS = new Set(['supersederId', 'supersededId', 'decisionRef', 'approved', 'approvedBy', 'approvedOn', 'effectiveDate', 'scope']);
const SCOPE_KEYS = new Set(['state']);
const LEGACY_KEYS = new Set(['decisionRef', 'approved']);
const EMPLOYEE_KEYS = new Set(['workAssignments', 'residentialAddress']);
const ASSIGNMENT_KEYS = new Set(['establishmentId', 'effectiveFrom', 'effectiveTo']);

const unknownKey = (object, allowed) => Object.keys(object).find((key) => !allowed.has(key));

/** The problem with the structure of the whole input, or null. Judged before any resolution. */
function structuralProblem({ establishment, period, inventory, supersessionResolutions, legacyContinuation }) {
  const check = (object, allowed, what) => {
    if (!isPlainObject(object)) return `${what} must be an object`;
    const extra = unknownKey(object, allowed);
    return extra === undefined ? null : `${what} has the unrecognized field "${extra}"`;
  };
  let problem = check(establishment, ESTABLISHMENT_KEYS, 'establishment');
  if (problem) return problem;
  if (establishment.locations !== undefined) {
    if (!isDenseArray(establishment.locations)) return 'establishment.locations must be an array';

    for (const location of establishment.locations) {
      problem = check(location, LOCATION_KEYS, 'a location');
      if (problem) return problem;
    }
  }
  problem = check(period, new Set(['start', 'end']), 'period');
  if (problem) return problem;
  problem = check(inventory, INVENTORY_KEYS, 'inventory');
  if (problem) return problem;
  if (!isDenseArray(inventory.records)) return 'inventory.records must be an array';
  const recordIds = new Set();
  for (const record of inventory.records) {
    problem = check(record, RECORD_KEYS, 'an inventory record');
    if (problem) return problem;
    if (!nonEmptyText(record.recordId)) return 'every inventory record needs a recordId';
    if (recordIds.has(record.recordId)) return `duplicate recordId ${record.recordId}`;
    recordIds.add(record.recordId);
    if (record.provenance !== undefined && typeof record.provenance !== 'string') return `record ${record.recordId} provenance must be text`;
    if (record.supersessionStatus !== undefined && !['CLEAR', 'UNRESOLVED'].includes(record.supersessionStatus)) return `record ${record.recordId} supersessionStatus must be CLEAR or UNRESOLVED`;
    if (record.verification !== undefined) {
      problem = check(record.verification, VERIFICATION_KEYS, 'a record verification');
      if (problem) return problem;
    }
    if (record.units !== undefined && !(isDenseArray(record.units) && record.units.every((unit) => typeof unit === 'string'))) return `record ${record.recordId} units must be an array of text`;
    if (record.supersedes !== undefined && !(isDenseArray(record.supersedes) && record.supersedes.every(nonEmptyText))) return `record ${record.recordId} supersedes must be an array of record ids`;
  }
  if (!isDenseArray(supersessionResolutions)) return 'supersessionResolutions must be an array';
  for (const decision of supersessionResolutions) {
    problem = check(decision, DECISION_KEYS, 'a supersession decision');
    if (problem) return problem;
    if (decision.scope !== undefined) {
      problem = check(decision.scope, SCOPE_KEYS, 'a supersession decision scope');
      if (problem) return problem;
    }
  }
  if (legacyContinuation !== null) {
    problem = check(legacyContinuation, LEGACY_KEYS, 'legacyContinuation');
    if (problem) return problem;
  }
  return null;
}

function locationFor(locations, from, to) {
  if (!Array.isArray(locations)) return { location: null, code: B.ESTABLISHMENT_LOCATION_UNRESOLVED, detail: 'no effective-dated establishment location was supplied' };
  const covering = locations.filter((location) => isDate(location.effectiveFrom)
    && location.effectiveFrom <= from && endsOnOrAfter(location.effectiveTo, to));
  if (covering.length === 1) {
    const location = covering[0];
    if (!nonEmptyText(location.state) || !nonEmptyText(location.district)) {
      return { location: null, code: B.ESTABLISHMENT_LOCATION_UNRESOLVED, detail: 'the establishment location lacks a state and district' };
    }
    if (ambiguousName(location.state) || ambiguousName(location.district)) {
      return { location: null, code: B.ESTABLISHMENT_LOCATION_UNRESOLVED, detail: 'the establishment state or district name cannot be matched as an exact canonical identity (control, pattern or compatibility-only characters)' };
    }
    return { location, code: null, detail: null };
  }
  if (covering.length > 1) return { location: null, code: B.ESTABLISHMENT_LOCATION_UNRESOLVED, detail: 'more than one location is effective for the whole period' };
  const touching = locations.filter((location) => isDate(location.effectiveFrom) && location.effectiveFrom <= to && endsOnOrAfter(location.effectiveTo, from));
  return touching.length > 1
    ? { location: null, code: B.TRANSITION_TREATMENT_UNRESOLVED, detail: 'the establishment location changes inside the period' }
    : { location: null, code: B.ESTABLISHMENT_LOCATION_UNRESOLVED, detail: 'no establishment location is effective for the period' };
}

/** Exact identity match on state and on one unit; never a prefix or substring match. */
const covers = (record, state, district) => typeof record.state === 'string'
  && identityKey(record.state) === identityKey(state)
  && Array.isArray(record.units) && record.units.some((unit) => identityKey(unit) === identityKey(district));

/**
 * The problem with a supersession decision for the exact pair (superseder, superseded), or null when
 * the decision is complete and approved. A decision reference alone is not an approval.
 */
function decisionProblem(decision, supersededRecord, period) {
  if (!nonEmptyText(decision.decisionRef)) return 'the decision has no decisionRef';
  if (decision.approved !== true) return 'the decision is not explicitly approved (approved must be the boolean true)';
  if (!nonEmptyText(decision.approvedBy)) return 'the decision names no approver';
  if (!isDate(decision.approvedOn)) return 'the decision has no valid approval date';
  if (!isDate(decision.effectiveDate)) return 'the decision has no valid effective date';
  if (decision.effectiveDate > period.start) return 'the decision takes effect after the start of the period';
  if (!isPlainObject(decision.scope) || !nonEmptyText(decision.scope.state)) return 'the decision states no scope';
  if (typeof supersededRecord.state !== 'string' || identityKey(decision.scope.state) !== identityKey(supersededRecord.state)) return 'the decision scope does not cover the superseded record\'s state';
  return null;
}

/**
 * @param {object} input
 * @param {object} input.establishment   { establishmentId, locations:[{effectiveFrom,effectiveTo,state,district}], categoryState }
 * @param {{start:string,end:string}} input.period  ISO dates (YYYY-MM-DD), inclusive
 * @param {object} input.inventory       { enumerationComplete:boolean, records:[territorial records] }
 * @param {object[]} [input.supersessionResolutions]  approved decisions: { supersederId, supersededId,
 *        decisionRef, approved:true, approvedBy, approvedOn, effectiveDate, scope:{state} }
 * @param {object} [input.legacyContinuation]         { decisionRef, approved:true } — an approved decision, never inferred
 * @param {string} [input.context]       'TEST' (fixture records allowed) or 'PRODUCTION'; omitted = PRODUCTION
 */
/** Run a resolver body; an unexpected crash (a hostile getter or Proxy ...) becomes a named, fail-closed error, never a raw one. */
function guarded(body) {
  try {
    return body();
  } catch (error) {
    if (error instanceof StatutoryWageError) throw error;
    return fail(C.INPUT_MALFORMED, `the input could not be processed safely (${error && error.name ? error.name : 'unknown error'}); nothing is resolved`, { cause: error && error.name ? error.name : null });
  }
}

export function resolveEstablishmentApplicability(input) {
  return guarded(() => resolveEstablishmentCore(input));
}

function resolveEstablishmentCore(rawInput) {
  const context = resolveExecutionContext(requestedContext(rawInput));
  const input = toOwnData(rawInput); // own data only, at every depth: an inherited value never satisfies a required property
  if (!isPlainObject(input)) return blocked(B.APPLICABILITY_INPUT_INVALID, 'an input object is required');
  const extra = unknownKey(input, INPUT_KEYS);
  if (extra !== undefined) return blocked(B.APPLICABILITY_INPUT_INVALID, `the input has the unrecognized field "${extra}"`);
  const { establishment, period, inventory, supersessionResolutions = [], legacyContinuation = null } = input;
  if (!establishment || !period || !inventory || !isDate(period.start) || !isDate(period.end) || period.start > period.end || !Array.isArray(inventory.records)) {
    return blocked(B.APPLICABILITY_INPUT_INVALID, 'establishment, an ISO period and an inventory with records are required');
  }
  const structure = structuralProblem({ establishment, period, inventory, supersessionResolutions, legacyContinuation });
  if (structure) return blocked(B.APPLICABILITY_INPUT_INVALID, structure);

  const located = locationFor(establishment.locations, period.start, period.end);
  if (!located.location) return blocked(located.code, located.detail);
  const { state, district } = located.location;

  if (establishment.categoryState !== 'ESTABLISHED') {
    return blocked(B.ESTABLISHMENT_COVERAGE_STATE_UNRESOLVED, 'the establishment category facts are not established (a negative would need positive evidence and an approved rule)', { categoryState: establishment.categoryState ?? null });
  }

  // PRODUCTION: an incomplete inventory blocks every determination that depends on it, a match included.
  if (context === EXECUTION_CONTEXTS.PRODUCTION && inventory.enumerationComplete !== true) {
    return blocked(B.ENUMERATION_INCOMPLETE, 'the territorial inventory is not complete: no production determination can rely on it, and an apparent match is not enough', { state, district });
  }

  const outcome = resolveFromInventory({ state, district, period, inventory, supersessionResolutions, legacyContinuation, context });
  if (context === EXECUTION_CONTEXTS.PRODUCTION && outcome.outcome === 'RESOLVED') {
    return blocked(B.PRODUCTION_AUTHORITY_UNAVAILABLE, 'no trusted territorial register exists to verify this inventory or any decision; caller-supplied completeness, approval, provenance or hashes are claims, not proof', { state, district });
  }
  // A TEST resolution is explicitly unverified and not legally approved; it carries no claimed provenance from the caller.
  return outcome.outcome === 'RESOLVED' ? { ...outcome, evaluationContext: context, verification: 'UNVERIFIED_TEST_ONLY', legalStatus: 'NOT_LEGALLY_APPROVED' } : outcome;
}

function resolveFromInventory({ state, district, period, inventory, supersessionResolutions, legacyContinuation, context }) {
  const matching = inventory.records.filter((record) => covers(record, state, district));

  if (matching.length === 0) {
    if (inventory.enumerationComplete !== true) {
      return blocked(B.ENUMERATION_INCOMPLETE, 'no verified territorial notification matches, and the inventory is not complete: absence is not evidence of non-applicability', { state, district });
    }
    if (legacyContinuation && legacyContinuation.approved === true && nonEmptyText(legacyContinuation.decisionRef)) {
      return { outcome: 'RESOLVED', regime: REGIMES.LEGACY_CONTINUATION_DECIDED, decisionRef: legacyContinuation.decisionRef, layers: { territorial: 'NOT_ESTABLISHED' } };
    }
    return blocked(B.TRANSITION_TREATMENT_UNRESOLVED, 'no territorial notification matches in a complete inventory, but whether a legacy regime continues needs an approved decision', { state, district });
  }

  for (const record of matching) {
    const verified = record.verification?.textStatus === 'PRIMARY_TEXT_VERIFIED' && /^[0-9a-f]{64}$/.test(record.verification?.sourceArtifactHash || '');
    if (!verified) return blocked(B.TERRITORIAL_INSTRUMENT_UNVERIFIED, `record ${record.recordId} is not primary-text verified with a source artifact hash`, { recordId: record.recordId });
    if (context === EXECUTION_CONTEXTS.PRODUCTION && record.provenance === 'TEST_FIXTURE') return blocked(B.TERRITORIAL_INSTRUMENT_UNVERIFIED, `record ${record.recordId} is a test fixture`, { recordId: record.recordId });
  }

  for (const record of matching) {
    const superseders = inventory.records.filter((other) => Array.isArray(other.supersedes) && other.supersedes.includes(record.recordId));
    for (const superseder of superseders) {
      const decisions = supersessionResolutions.filter((decision) => decision.supersederId === superseder.recordId && decision.supersededId === record.recordId);
      const unresolved = (detail) => blocked(B.SUPERSESSION_UNRESOLVED, `record ${record.recordId} is named as superseded by ${superseder.recordId}: ${detail}`, { recordId: record.recordId, supersederId: superseder.recordId });
      if (decisions.length === 0) return unresolved('the legal effect has no approved decision');
      if (decisions.length > 1) return unresolved('more than one decision names this supersession and none is chosen');
      const problem = decisionProblem(decisions[0], record, period);
      if (problem) return unresolved(problem);
    }
    if (record.supersessionStatus === 'UNRESOLVED') {
      return blocked(B.SUPERSESSION_UNRESOLVED, `record ${record.recordId} carries an unresolved supersession status`, { recordId: record.recordId });
    }
  }

  // Effective dates. A record is relied on only when its date is on or before the period start.
  const dates = [...new Set(matching.map((record) => record.effectiveDate))];
  if (dates.length !== 1 || !isDate(dates[0])) {
    return blocked(B.SUPERSESSION_UNRESOLVED, 'matching records disagree on the effective date; none is chosen', { dates });
  }
  const effectiveDate = dates[0];
  if (period.end < effectiveDate) {
    return blocked(B.TRANSITION_TREATMENT_UNRESOLVED, 'the period ends before the territorial effective date and no prior-regime decision is applied', { effectiveDate });
  }
  if (period.start < effectiveDate) {
    return blocked(B.TRANSITION_TREATMENT_UNRESOLVED, 'the period crosses the territorial effective date and no approved transition rule segments it', { effectiveDate });
  }

  return {
    outcome: 'RESOLVED',
    regime: REGIMES.TERRITORIALLY_NOTIFIED,
    recordIds: matching.map((record) => record.recordId).sort(),
    effectiveDate,
    layers: { territorial: 'ESTABLISHED', establishmentCategory: 'ESTABLISHED' },
  };
}

/**
 * Resolve for an employee through the effective-dated link from the employee to an establishment.
 * The residential address is deliberately ignored: only a work assignment links an employee to an
 * establishment. The context is validated here as well as in the establishment resolver, so no path
 * through this function can reach a fixture without an explicit TEST.
 */
export function resolveEmployeeApplicability(input) {
  return guarded(() => resolveEmployeeCore(input));
}

function resolveEmployeeCore(rawInput) {
  const context = resolveExecutionContext(requestedContext(rawInput));
  const input = toOwnData(rawInput);
  if (!isPlainObject(input)) return blocked(B.APPLICABILITY_INPUT_INVALID, 'an input object is required');
  const { employee, establishments, period, ...rest } = input;
  const extraInput = unknownKey(rest, new Set(['inventory', 'supersessionResolutions', 'legacyContinuation', 'context']));
  if (extraInput !== undefined) return blocked(B.APPLICABILITY_INPUT_INVALID, `the input has the unrecognized field "${extraInput}" (an establishment is found through the employee's work assignment, never supplied directly)`);
  if (!isPlainObject(employee) || !isDenseArray(establishments) || !isPlainObject(period) || !isDate(period.start) || !isDate(period.end)) {
    return blocked(B.APPLICABILITY_INPUT_INVALID, 'employee, establishments and an ISO period are required');
  }
  const extraEmployeeKey = unknownKey(employee, EMPLOYEE_KEYS);
  if (extraEmployeeKey !== undefined) return blocked(B.APPLICABILITY_INPUT_INVALID, `the employee has the unrecognized field "${extraEmployeeKey}"`);
  const workAssignments = employee.workAssignments === undefined ? [] : employee.workAssignments;
  if (!isDenseArray(workAssignments) || workAssignments.some((a) => !isPlainObject(a) || unknownKey(a, ASSIGNMENT_KEYS) !== undefined || !nonEmptyText(a.establishmentId))) {
    return blocked(B.APPLICABILITY_INPUT_INVALID, 'workAssignments must be an array of { establishmentId, effectiveFrom, effectiveTo }, each naming an establishment');
  }
  const assignments = workAssignments.filter((assignment) => isDate(assignment.effectiveFrom)
    && assignment.effectiveFrom <= period.start && endsOnOrAfter(assignment.effectiveTo, period.end));
  if (assignments.length === 0) {
    const touching = workAssignments.filter((a) => isDate(a.effectiveFrom) && a.effectiveFrom <= period.end && endsOnOrAfter(a.effectiveTo, period.start));
    return touching.length > 1
      ? blocked(B.TRANSITION_TREATMENT_UNRESOLVED, 'the employee moves between establishments inside the period')
      : blocked(B.ESTABLISHMENT_LOCATION_UNRESOLVED, 'no work assignment links the employee to an establishment for the period (a residential address is not a substitute)');
  }
  if (assignments.length > 1) return blocked(B.ESTABLISHMENT_LOCATION_UNRESOLVED, 'more than one work assignment is effective for the period');
  const candidates = establishments.filter((candidate) => isPlainObject(candidate) && nonEmptyText(candidate.establishmentId) && candidate.establishmentId === assignments[0].establishmentId);
  if (candidates.length === 0) return blocked(B.ESTABLISHMENT_LOCATION_UNRESOLVED, 'the assigned establishment is unknown');
  if (candidates.length > 1) return blocked(B.ESTABLISHMENT_LOCATION_UNRESOLVED, 'more than one establishment carries the assigned establishmentId; none is chosen');
  return resolveEstablishmentApplicability({ ...rest, establishment: candidates[0], period, context });
}
