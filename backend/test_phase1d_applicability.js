/**
 * test_phase1d_applicability.js — the pure territorial/establishment applicability resolver
 * (Phase 1D scaffold; unwired, no database).
 *
 * Groups D (resolution by establishment and date), E (incomplete inventory blocks), F (superseding
 * notification ambiguity blocks) and T (rule effective-date boundaries).
 *
 * Every record below is a TEST_FIXTURE with invented state and district names. None describes a real
 * notification, and none is evidence of what any real notification does.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveEstablishmentApplicability, resolveEmployeeApplicability, REGIMES } from './src/statutoryWage/applicability.js';
import { pollutionDifferential, objectKeyPaths, outcomeSignature } from './test_support/wageFixtures.js';
import { APPLICABILITY_BLOCK_CODES as B, STATUTORY_WAGE_ERROR_CODES as C, StatutoryWageError } from './src/statutoryWage/errors.js';

const HASH = 'c'.repeat(64);
const record = (overrides = {}) => ({
  recordId: 'FX-1', provenance: 'TEST_FIXTURE', instrument: 'FIXTURE_INSTRUMENT_1', state: 'Fixtureland', units: ['Alpha', 'Beta'],
  effectiveDate: '2026-10-01', supersedes: [], supersessionStatus: 'CLEAR',
  verification: { textStatus: 'PRIMARY_TEXT_VERIFIED', sourceArtifactHash: HASH }, ...overrides,
});
const establishment = (overrides = {}) => ({
  establishmentId: 'EST-1', categoryState: 'ESTABLISHED',
  locations: [{ effectiveFrom: '2020-01-01', effectiveTo: null, state: 'Fixtureland', district: 'Alpha' }], ...overrides,
});
const inventory = (records, enumerationComplete = false) => ({ enumerationComplete, records });
const OCT = { start: '2026-10-01', end: '2026-10-31' };
// Fixture records are evaluated only when the test says TEST: an omitted context means PRODUCTION.
const resolve = (overrides = {}) => resolveEstablishmentApplicability({ establishment: establishment(), period: OCT, inventory: inventory([record()]), context: 'TEST', ...overrides });
const TEST = 'TEST';
// A complete, approved supersession decision (every field the resolver requires).
const decision = (overrides = {}) => ({
  supersederId: 'FX-G', supersededId: 'FX-P', decisionRef: 'FX-D', approved: true, approvedBy: 'FIXTURE_APPROVER', approvedOn: '2026-09-01',
  effectiveDate: '2026-09-15', scope: { state: 'Fixtureland' }, ...overrides,
});
const blockedWith = (result, code) => {
  assert.equal(result.outcome, 'BLOCKED', JSON.stringify(result));
  assert.equal(result.code, code, JSON.stringify(result));
  return result;
};

describe('D — resolution by establishment, district and effective date', () => {
  test('a verified notification covering the establishment district, effective on the period start, resolves', () => {
    const result = resolve();
    assert.equal(result.outcome, 'RESOLVED');
    assert.equal(result.regime, REGIMES.TERRITORIALLY_NOTIFIED);
    assert.deepEqual(result.recordIds, ['FX-1']);
    assert.equal(result.effectiveDate, '2026-10-01');
    assert.deepEqual(result.layers, { territorial: 'ESTABLISHED', establishmentCategory: 'ESTABLISHED' });
  });

  test('two establishments of one company in different districts resolve independently', () => {
    const records = [record({ recordId: 'FX-ALPHA', units: ['Alpha'] }), record({ recordId: 'FX-OTHER', state: 'Otherland', units: ['Gamma'], effectiveDate: '2026-11-01' })];
    const alpha = resolve({ inventory: inventory(records, true) });
    assert.deepEqual(alpha.recordIds, ['FX-ALPHA']);
    const gamma = resolveEstablishmentApplicability({
      establishment: establishment({ establishmentId: 'EST-2', locations: [{ effectiveFrom: '2020-01-01', effectiveTo: null, state: 'Otherland', district: 'Gamma' }] }),
      period: OCT, inventory: inventory(records, true), context: TEST,
    });
    blockedWith(gamma, B.TRANSITION_TREATMENT_UNRESOLVED); // Gamma's notification is effective 2026-11-01: later than this period
  });

  test('state and district matching ignores case and spacing, but never matches a different district', () => {
    assert.equal(resolve({ establishment: establishment({ locations: [{ effectiveFrom: '2020-01-01', effectiveTo: null, state: '  FIXTURELAND ', district: ' alpha' }] }) }).outcome, 'RESOLVED');
    blockedWith(resolve({ establishment: establishment({ locations: [{ effectiveFrom: '2020-01-01', effectiveTo: null, state: 'Fixtureland', district: 'Alphabet' }] }) }), B.ENUMERATION_INCOMPLETE);
  });

  test('the employee is linked to an establishment only through an effective-dated work assignment', () => {
    const employee = { workAssignments: [{ establishmentId: 'EST-1', effectiveFrom: '2026-01-01', effectiveTo: null }], residentialAddress: { state: 'Elsewhere', district: 'Nowhere' } };
    const result = resolveEmployeeApplicability({ employee, establishments: [establishment()], period: OCT, inventory: inventory([record()]), context: TEST });
    assert.equal(result.outcome, 'RESOLVED');
    assert.deepEqual(result.recordIds, ['FX-1']);
  });

  test('a residential address is never a substitute for a work assignment', () => {
    const employee = { workAssignments: [], residentialAddress: { state: 'Fixtureland', district: 'Alpha' } };
    blockedWith(resolveEmployeeApplicability({ employee, establishments: [establishment()], period: OCT, inventory: inventory([record()], true), context: TEST }), B.ESTABLISHMENT_LOCATION_UNRESOLVED);
    // and a residential address in a covered district does not change which establishment applies
    const other = { workAssignments: [{ establishmentId: 'EST-9', effectiveFrom: '2026-01-01', effectiveTo: null }], residentialAddress: { state: 'Fixtureland', district: 'Alpha' } };
    blockedWith(resolveEmployeeApplicability({ employee: other, establishments: [establishment()], period: OCT, inventory: inventory([record()]), context: TEST }), B.ESTABLISHMENT_LOCATION_UNRESOLVED);
  });

  test('an employee who moves between establishments inside the period, or has overlapping assignments, is blocked', () => {
    const moving = { workAssignments: [{ establishmentId: 'EST-1', effectiveFrom: '2026-01-01', effectiveTo: '2026-10-14' }, { establishmentId: 'EST-1', effectiveFrom: '2026-10-15', effectiveTo: null }] };
    blockedWith(resolveEmployeeApplicability({ employee: moving, establishments: [establishment()], period: OCT, inventory: inventory([record()]), context: TEST }), B.TRANSITION_TREATMENT_UNRESOLVED);
    const overlapping = { workAssignments: [{ establishmentId: 'EST-1', effectiveFrom: '2026-01-01', effectiveTo: null }, { establishmentId: 'EST-1', effectiveFrom: '2026-02-01', effectiveTo: null }] };
    blockedWith(resolveEmployeeApplicability({ employee: overlapping, establishments: [establishment()], period: OCT, inventory: inventory([record()]), context: TEST }), B.ESTABLISHMENT_LOCATION_UNRESOLVED);
  });
});

describe('location and category facts fail closed', () => {
  test('ESTABLISHMENT_LOCATION_UNRESOLVED: no location, no district, or ambiguous locations', () => {
    blockedWith(resolve({ establishment: establishment({ locations: undefined }) }), B.ESTABLISHMENT_LOCATION_UNRESOLVED);
    blockedWith(resolve({ establishment: establishment({ locations: [] }) }), B.ESTABLISHMENT_LOCATION_UNRESOLVED);
    blockedWith(resolve({ establishment: establishment({ locations: [{ effectiveFrom: '2020-01-01', effectiveTo: null, state: 'Fixtureland' }] }) }), B.ESTABLISHMENT_LOCATION_UNRESOLVED);
    blockedWith(resolve({ establishment: establishment({ locations: [{ effectiveFrom: '2020-01-01', effectiveTo: null, state: 'Fixtureland', district: '' }] }) }), B.ESTABLISHMENT_LOCATION_UNRESOLVED);
    blockedWith(resolve({ establishment: establishment({ locations: [{ effectiveFrom: '2027-01-01', effectiveTo: null, state: 'Fixtureland', district: 'Alpha' }] }) }), B.ESTABLISHMENT_LOCATION_UNRESOLVED);
    const twice = [{ effectiveFrom: '2020-01-01', effectiveTo: null, state: 'Fixtureland', district: 'Alpha' }, { effectiveFrom: '2025-01-01', effectiveTo: null, state: 'Fixtureland', district: 'Beta' }];
    blockedWith(resolve({ establishment: establishment({ locations: twice }) }), B.ESTABLISHMENT_LOCATION_UNRESOLVED);
  });

  test('a location that changes inside the period is a transition, not a guess', () => {
    const moves = [{ effectiveFrom: '2020-01-01', effectiveTo: '2026-10-14', state: 'Fixtureland', district: 'Alpha' }, { effectiveFrom: '2026-10-15', effectiveTo: null, state: 'Fixtureland', district: 'Beta' }];
    blockedWith(resolve({ establishment: establishment({ locations: moves }) }), B.TRANSITION_TREATMENT_UNRESOLVED);
  });

  test('ESTABLISHMENT_COVERAGE_STATE_UNRESOLVED: only an ESTABLISHED category state proceeds', () => {
    for (const categoryState of [undefined, null, 'UNKNOWN', 'NOT_ESTABLISHED', 'established']) {
      blockedWith(resolve({ establishment: establishment({ categoryState }) }), B.ESTABLISHMENT_COVERAGE_STATE_UNRESOLVED);
    }
  });

  test('APPLICABILITY_INPUT_INVALID: malformed input is refused, not defaulted', () => {
    blockedWith(resolveEstablishmentApplicability(undefined), B.APPLICABILITY_INPUT_INVALID);
    blockedWith(resolve({ period: { start: '2026-10-31', end: '2026-10-01' } }), B.APPLICABILITY_INPUT_INVALID);
    blockedWith(resolve({ period: { start: '01/10/2026', end: '31/10/2026' } }), B.APPLICABILITY_INPUT_INVALID);
    blockedWith(resolve({ inventory: { enumerationComplete: true } }), B.APPLICABILITY_INPUT_INVALID);
  });
});

describe('E — an incomplete inventory never means "not covered"', () => {
  test('ENUMERATION_INCOMPLETE: no matching record in an incomplete inventory is a block, not a negative', () => {
    const result = blockedWith(resolve({ inventory: inventory([], false) }), B.ENUMERATION_INCOMPLETE);
    assert.deepEqual([result.state, result.district], ['Fixtureland', 'Alpha']);
    blockedWith(resolve({ inventory: inventory([record({ units: ['Gamma'] })], false) }), B.ENUMERATION_INCOMPLETE);
    blockedWith(resolve({ inventory: { enumerationComplete: 'yes', records: [] } }), B.ENUMERATION_INCOMPLETE); // only literal true counts
  });

  test('even a complete inventory with no match does not assign a legacy regime by itself', () => {
    const result = blockedWith(resolve({ inventory: inventory([record({ units: ['Gamma'] })], true) }), B.TRANSITION_TREATMENT_UNRESOLVED);
    assert.match(result.detail, /legacy regime continues needs an approved decision/);
  });

  test('a legacy continuation is assigned only from an approved decision record', () => {
    const inv = inventory([record({ units: ['Gamma'] })], true);
    blockedWith(resolve({ inventory: inv, legacyContinuation: { decisionRef: 'FX-DECISION', approved: false } }), B.TRANSITION_TREATMENT_UNRESOLVED);
    blockedWith(resolve({ inventory: inv, legacyContinuation: { approved: true } }), B.TRANSITION_TREATMENT_UNRESOLVED);
    const decided = resolve({ inventory: inv, legacyContinuation: { decisionRef: 'FX-DECISION', approved: true } });
    assert.equal(decided.outcome, 'RESOLVED');
    assert.equal(decided.regime, REGIMES.LEGACY_CONTINUATION_DECIDED);
    assert.equal(decided.decisionRef, 'FX-DECISION');
    assert.equal(decided.layers.territorial, 'NOT_ESTABLISHED');
  });

  test('a legacy decision never overrides a matching territorial notification', () => {
    const decided = resolve({ legacyContinuation: { decisionRef: 'FX-DECISION', approved: true } });
    assert.equal(decided.regime, REGIMES.TERRITORIALLY_NOTIFIED);
  });
});

describe('TERRITORIAL_INSTRUMENT_UNVERIFIED — only primary-verified, hashed records are relied on', () => {
  test('text not primary-verified, or no source artifact hash, blocks', () => {
    for (const verification of [
      { textStatus: 'PRIMARY_TEXT_PARTIAL', sourceArtifactHash: HASH },
      { textStatus: 'PRIMARY_TEXT_VERIFIED', sourceArtifactHash: 'abc' },
      { textStatus: 'PRIMARY_TEXT_VERIFIED' },
      { textStatus: 'ACQUIRED_HASHED', sourceArtifactHash: HASH },
      undefined,
    ]) {
      blockedWith(resolve({ inventory: inventory([record({ verification })]) }), B.TERRITORIAL_INSTRUMENT_UNVERIFIED);
    }
  });

  test('the production context refuses fixture records', () => {
    blockedWith(resolve({ context: 'PRODUCTION', inventory: inventory([record()], true) }), B.TERRITORIAL_INSTRUMENT_UNVERIFIED);
  });

  test('a relabelled record does NOT resolve in PRODUCTION (this replaces a test that asserted it did: that was the self-asserted gate)', () => {
    // A TEST_FIXTURE relabelled REGISTER_APPROVED, complete inventory, verified-looking: still only a claim.
    const relabelled = inventory([record({ provenance: 'REGISTER_APPROVED' })], true);
    blockedWith(resolve({ context: 'PRODUCTION', inventory: relabelled }), B.PRODUCTION_AUTHORITY_UNAVAILABLE);
    // the same input resolves in an explicit TEST context, which is what the matching logic is exercised in
    assert.equal(resolve({ context: 'TEST', inventory: relabelled }).outcome, 'RESOLVED');
  });
});

describe('F — superseding-notification ambiguity blocks until a legal effect is approved', () => {
  // Structural model of an anomaly: record P (state X) is named as superseded by record G (state Y)
  // although G's units do not include P's. Then P is re-notified, unchanged, as R without a supersession clause.
  const p = record({ recordId: 'FX-P', state: 'Fixtureland', units: ['Alpha', 'Beta'], effectiveDate: '2026-10-01' });
  const g = record({ recordId: 'FX-G', state: 'Otherland', units: ['Gamma'], supersedes: ['FX-P'], effectiveDate: '2026-10-01' });
  const r = record({ recordId: 'FX-R', state: 'Fixtureland', units: ['Alpha', 'Beta'], effectiveDate: '2026-10-01' });

  test('SUPERSESSION_UNRESOLVED: a district covered by a record that is named as superseded by another state\'s record', () => {
    const result = blockedWith(resolve({ inventory: inventory([p, g], true) }), B.SUPERSESSION_UNRESOLVED);
    assert.equal(result.recordId, 'FX-P');
    assert.equal(result.supersederId, 'FX-G');
  });

  test('re-notification does not resolve it: the block persists while any matching record is touched by the unresolved supersession', () => {
    blockedWith(resolve({ inventory: inventory([p, g, r], true) }), B.SUPERSESSION_UNRESOLVED);
  });

  test('the superseding record\'s own territory is unaffected by what it names as superseded', () => {
    const gamma = resolveEstablishmentApplicability({
      establishment: establishment({ locations: [{ effectiveFrom: '2020-01-01', effectiveTo: null, state: 'Otherland', district: 'Gamma' }] }),
      period: OCT, inventory: inventory([p, g, r], true), context: TEST,
    });
    assert.equal(gamma.outcome, 'RESOLVED');
    assert.deepEqual(gamma.recordIds, ['FX-G']);
  });

  test('only an approved decision on that exact supersession unblocks it', () => {
    const inv = inventory([p, g, r], true);
    blockedWith(resolve({ inventory: inv, supersessionResolutions: [decision({ supersededId: 'FX-OTHER' })] }), B.SUPERSESSION_UNRESOLVED);
    blockedWith(resolve({ inventory: inv, supersessionResolutions: [{ supersederId: 'FX-G', supersededId: 'FX-P' }] }), B.SUPERSESSION_UNRESOLVED);
    const cleared = resolve({ inventory: inv, supersessionResolutions: [decision()] });
    assert.equal(cleared.outcome, 'RESOLVED');
    assert.deepEqual(cleared.recordIds, ['FX-P', 'FX-R']);
  });

  test('a record flagged with an unresolved supersession status blocks even without a named superseder', () => {
    blockedWith(resolve({ inventory: inventory([record({ supersessionStatus: 'UNRESOLVED' })]) }), B.SUPERSESSION_UNRESOLVED);
  });

  test('matching records that disagree on the effective date are never reconciled by picking one', () => {
    blockedWith(resolve({ inventory: inventory([record({ recordId: 'A1' }), record({ recordId: 'A2', effectiveDate: '2026-10-05' })]) }), B.SUPERSESSION_UNRESOLVED);
  });
});

describe('T — effective-date boundaries are never decided by the period end', () => {
  test('a period that ends before the effective date, or crosses it, has no approved transition', () => {
    blockedWith(resolve({ period: { start: '2026-09-01', end: '2026-09-30' } }), B.TRANSITION_TREATMENT_UNRESOLVED);
    blockedWith(resolve({ period: { start: '2026-09-16', end: '2026-10-15' } }), B.TRANSITION_TREATMENT_UNRESOLVED);
    // the period end being after the effective date is not enough
    blockedWith(resolve({ period: { start: '2026-09-30', end: '2026-10-31' } }), B.TRANSITION_TREATMENT_UNRESOLVED);
  });

  test('a period that starts on or after the effective date resolves', () => {
    assert.equal(resolve({ period: { start: '2026-10-01', end: '2026-10-31' } }).outcome, 'RESOLVED');
    assert.equal(resolve({ period: { start: '2026-11-01', end: '2026-11-30' } }).outcome, 'RESOLVED');
  });
});

describe('the resolver is pure', () => {
  test('it does not mutate its inputs and returns the same answer twice', () => {
    const input = { establishment: establishment(), period: OCT, inventory: inventory([record()]), context: TEST };
    const frozen = JSON.stringify(input);
    const a = resolveEstablishmentApplicability(input);
    const b = resolveEstablishmentApplicability(input);
    assert.equal(JSON.stringify(input), frozen);
    assert.deepEqual(a, b);
  });
});

describe('B1 — the resolver context fails closed: an omitted context means PRODUCTION', () => {
  const base = (over = {}) => ({ establishment: establishment(), period: OCT, inventory: inventory([record()], true), ...over });
  const throwsContext = (fn) => {
    let error = null;
    try { fn(); } catch (e) { error = e; }
    assert.ok(error instanceof StatutoryWageError, `expected a named error, got ${error}`);
    assert.equal(error.code, C.EXECUTION_CONTEXT_INVALID);
  };

  test('A: an explicit TEST context evaluates fixture records', () => {
    assert.equal(resolveEstablishmentApplicability(base({ context: 'TEST' })).outcome, 'RESOLVED');
  });

  test('B: an omitted context is PRODUCTION: a fixture record never resolves', () => {
    for (const input of [base(), base({ context: undefined })]) {
      const result = resolveEstablishmentApplicability(input);
      blockedWith(result, B.TERRITORIAL_INSTRUMENT_UNVERIFIED);
    }
    blockedWith(resolveEstablishmentApplicability({ establishment: establishment(), period: OCT, inventory: inventory([record()]) }), B.ENUMERATION_INCOMPLETE);
  });

  test('B: a polluted Object.prototype cannot select TEST', () => {
    Object.prototype.context = 'TEST'; // eslint-disable-line no-extend-native
    try {
      blockedWith(resolveEstablishmentApplicability(base()), B.TERRITORIAL_INSTRUMENT_UNVERIFIED);
      blockedWith(resolveEmployeeApplicability({ employee: { workAssignments: [{ establishmentId: 'EST-1', effectiveFrom: '2026-01-01', effectiveTo: null }] }, establishments: [establishment()], period: OCT, inventory: inventory([record()], true) }), B.TERRITORIAL_INSTRUMENT_UNVERIFIED);
    } finally {
      delete Object.prototype.context;
    }
  });

  test('C: an explicit PRODUCTION context rejects a fixture record', () => {
    blockedWith(resolveEstablishmentApplicability(base({ context: 'PRODUCTION' })), B.TERRITORIAL_INSTRUMENT_UNVERIFIED);
  });

  test('D: an unknown context throws a named validation error, even before the input is examined', () => {
    for (const context of ['STAGING', 'test', 'Test', 'production', ' TEST', '', null, 0, false, true, {}, ['TEST'], 'ALL']) {
      throwsContext(() => resolveEstablishmentApplicability(base({ context })));
      throwsContext(() => resolveEstablishmentApplicability({ context }));
      throwsContext(() => resolveEmployeeApplicability({ context }));
    }
  });

  test('E: the employee path cannot reach a fixture without an explicit TEST, and cannot smuggle a context in', () => {
    const employee = { workAssignments: [{ establishmentId: 'EST-1', effectiveFrom: '2026-01-01', effectiveTo: null }] };
    const viaEmployee = (over = {}) => ({ employee, establishments: [establishment()], period: OCT, inventory: inventory([record()], true), ...over });
    blockedWith(resolveEmployeeApplicability(viaEmployee()), B.TERRITORIAL_INSTRUMENT_UNVERIFIED);
    blockedWith(resolveEmployeeApplicability(viaEmployee({ context: 'PRODUCTION' })), B.TERRITORIAL_INSTRUMENT_UNVERIFIED);
    assert.equal(resolveEmployeeApplicability(viaEmployee({ context: 'TEST' })).outcome, 'RESOLVED');
    throwsContext(() => resolveEmployeeApplicability(viaEmployee({ context: 'nope' })));
    // a context key inside a nested object is an unrecognized field, not a selector
    blockedWith(resolveEmployeeApplicability(viaEmployee({ employee: { ...employee, context: 'TEST' }, context: 'TEST' })), B.APPLICABILITY_INPUT_INVALID);
    blockedWith(resolveEstablishmentApplicability(base({ establishment: { ...establishment(), context: 'TEST' }, context: 'TEST' })), B.APPLICABILITY_INPUT_INVALID);
    blockedWith(resolveEstablishmentApplicability(base({ inventory: { ...inventory([record()], true), context: 'TEST' }, context: 'PRODUCTION' })), B.APPLICABILITY_INPUT_INVALID);
  });
});

describe('B3 — an incomplete inventory is a hard production block, an apparent match included', () => {
  const production = (over = {}) => resolve({ context: 'PRODUCTION', ...over });
  const verifiedMatch = (over = {}) => record({ provenance: 'REGISTER_APPROVED', ...over });

  test('a verified match in an INCOMPLETE inventory blocks in PRODUCTION (every way of being not-complete)', () => {
    for (const complete of [false, undefined, null, 'true', 'yes', 1, 0, {}, []]) {
      const result = blockedWith(production({ inventory: { enumerationComplete: complete, records: [verifiedMatch()] } }), B.ENUMERATION_INCOMPLETE);
      assert.equal(result.recordIds, undefined, 'no record is reported as the answer');
    }
  });

  test('an unmatched establishment in an incomplete inventory also blocks in PRODUCTION', () => {
    blockedWith(production({ inventory: inventory([verifiedMatch({ units: ['Gamma'] })], false) }), B.ENUMERATION_INCOMPLETE);
    blockedWith(production({ inventory: inventory([], false) }), B.ENUMERATION_INCOMPLETE);
  });

  test('a complete inventory still cannot resolve in PRODUCTION: completeness, approval and provenance are caller-supplied claims', () => {
    const complete = inventory([verifiedMatch()], true);
    blockedWith(production({ inventory: complete }), B.PRODUCTION_AUTHORITY_UNAVAILABLE);
    blockedWith(production({ inventory: complete, legacyContinuation: { decisionRef: 'FX-DECISION', approved: true } }), B.PRODUCTION_AUTHORITY_UNAVAILABLE);
    blockedWith(production({ inventory: inventory([verifiedMatch({ units: ['Gamma'] })], true), legacyContinuation: { decisionRef: 'FX-DECISION', approved: true } }), B.PRODUCTION_AUTHORITY_UNAVAILABLE);
  });

  test('PRODUCTION never returns RESOLVED, across a sweep of inventories, decisions and periods', () => {
    const p = verifiedMatch({ recordId: 'FX-P' });
    const g = verifiedMatch({ recordId: 'FX-G', state: 'Otherland', units: ['Gamma'], supersedes: ['FX-P'] });
    const inventories = [inventory([], true), inventory([], false), inventory([verifiedMatch()], true), inventory([verifiedMatch()], false), inventory([p, g], true), inventory([verifiedMatch({ units: ['Gamma'] })], true)];
    const resolutions = [[], [decision()]];
    const legacies = [null, { decisionRef: 'FX-DECISION', approved: true }];
    const periods = [OCT, { start: '2026-11-01', end: '2026-11-30' }, { start: '2026-09-01', end: '2026-09-30' }];
    for (const inv of inventories) for (const supersessionResolutions of resolutions) for (const legacyContinuation of legacies) for (const period of periods) {
      const result = production({ inventory: inv, supersessionResolutions, legacyContinuation, period });
      assert.equal(result.outcome, 'BLOCKED', JSON.stringify(result));
      assert.ok(Object.values(B).includes(result.code));
    }
  });

  test('missing or ambiguous locations, unverified instruments and unresolved supersession still block in PRODUCTION with their own codes', () => {
    const complete = (records) => inventory(records, true);
    blockedWith(production({ establishment: establishment({ locations: [] }), inventory: complete([verifiedMatch()]) }), B.ESTABLISHMENT_LOCATION_UNRESOLVED);
    blockedWith(production({ establishment: establishment({ categoryState: 'UNKNOWN' }), inventory: complete([verifiedMatch()]) }), B.ESTABLISHMENT_COVERAGE_STATE_UNRESOLVED);
    blockedWith(production({ inventory: complete([verifiedMatch({ verification: { textStatus: 'PRIMARY_TEXT_PARTIAL', sourceArtifactHash: HASH } })]) }), B.TERRITORIAL_INSTRUMENT_UNVERIFIED);
    blockedWith(production({ inventory: complete([verifiedMatch({ supersessionStatus: 'UNRESOLVED' })]) }), B.SUPERSESSION_UNRESOLVED);
    blockedWith(production({ inventory: complete([verifiedMatch()]), period: { start: '2026-09-16', end: '2026-10-15' } }), B.TRANSITION_TREATMENT_UNRESOLVED);
  });

  test('TEST context behavior is unchanged: a fixture match resolves, and an unmatched establishment in an incomplete inventory still blocks', () => {
    assert.equal(resolve({ context: 'TEST', inventory: inventory([record()], false) }).outcome, 'RESOLVED');
    blockedWith(resolve({ context: 'TEST', inventory: inventory([record({ units: ['Gamma'] })], false) }), B.ENUMERATION_INCOMPLETE);
  });

  test('the five stable blocking codes exist under their exact names', () => {
    for (const code of ['ENUMERATION_INCOMPLETE', 'ESTABLISHMENT_LOCATION_UNRESOLVED', 'TERRITORIAL_INSTRUMENT_UNVERIFIED', 'SUPERSESSION_UNRESOLVED', 'TRANSITION_TREATMENT_UNRESOLVED']) assert.equal(B[code], code);
  });
});

describe('B4 — a supersession decision needs explicit approval and complete provenance', () => {
  const p = record({ recordId: 'FX-P', state: 'Fixtureland', units: ['Alpha', 'Beta'], effectiveDate: '2026-10-01' });
  const g = record({ recordId: 'FX-G', state: 'Otherland', units: ['Gamma'], supersedes: ['FX-P'], effectiveDate: '2026-10-01' });
  const inv = () => inventory([p, g], true);
  const withDecisions = (...supersessionResolutions) => resolve({ inventory: inv(), supersessionResolutions });

  test('a decisionRef alone is not an approval', () => {
    blockedWith(withDecisions({ supersederId: 'FX-G', supersededId: 'FX-P', decisionRef: 'FX-D' }), B.SUPERSESSION_UNRESOLVED);
  });

  test('a complete, explicitly approved decision for the exact pair resolves in TEST', () => {
    assert.equal(withDecisions(decision()).outcome, 'RESOLVED');
  });

  test('absent, false, malformed or incomplete approval states are each named as unresolved', () => {
    const cases = {
      'approved is false': { approved: false },
      'approved is the string true': { approved: 'true' },
      'approved is 1': { approved: 1 },
      'approved is missing': { approved: undefined },
      'approved is an object': { approved: { value: true } },
      'decisionRef is empty': { decisionRef: '' },
      'decisionRef is whitespace': { decisionRef: '   ' },
      'decisionRef is missing': { decisionRef: undefined },
      'decisionRef is a number': { decisionRef: 7 },
      'no approver': { approvedBy: undefined },
      'empty approver': { approvedBy: ' ' },
      'no approval date': { approvedOn: undefined },
      'impossible approval date': { approvedOn: '2026-02-30' },
      'malformed approval date': { approvedOn: '13/10/2026' },
      'no effective date': { effectiveDate: undefined },
      'impossible effective date': { effectiveDate: '2026-13-01' },
      'takes effect after the period starts': { effectiveDate: '2026-10-02' },
      'no scope': { scope: undefined },
      'empty scope state': { scope: { state: '' } },
      'scope of another state': { scope: { state: 'Otherland' } },
    };
    for (const [name, over] of Object.entries(cases)) {
      const result = withDecisions(decision(over));
      assert.equal(result.outcome, 'BLOCKED', name);
      assert.equal(result.code, B.SUPERSESSION_UNRESOLVED, `${name}: ${JSON.stringify(result)}`);
      assert.equal(result.recordId, 'FX-P', name);
    }
  });

  test('the decision must name the exact relationship: a swapped or different pair does not clear it', () => {
    blockedWith(withDecisions(decision({ supersederId: 'FX-P', supersededId: 'FX-G' })), B.SUPERSESSION_UNRESOLVED);
    blockedWith(withDecisions(decision({ supersederId: 'FX-X' })), B.SUPERSESSION_UNRESOLVED);
    blockedWith(withDecisions(decision({ supersededId: 'FX-X' })), B.SUPERSESSION_UNRESOLVED);
  });

  test('two decisions for one supersession are ambiguous and none is chosen', () => {
    blockedWith(withDecisions(decision(), decision({ decisionRef: 'FX-D2' })), B.SUPERSESSION_UNRESOLVED);
  });

  test('unrecognized or non-object decision fields are rejected, not ignored', () => {
    blockedWith(withDecisions({ ...decision(), aproved: true }), B.APPLICABILITY_INPUT_INVALID);
    blockedWith(withDecisions({ ...decision(), scope: { state: 'Fixtureland', district: 'Alpha' } }), B.APPLICABILITY_INPUT_INVALID);
    blockedWith(withDecisions('FX-D'), B.APPLICABILITY_INPUT_INVALID);
    blockedWith(withDecisions(decision({ scope: 'Fixtureland' })), B.APPLICABILITY_INPUT_INVALID); // a scope that is not an object is malformed, not merely incomplete
    blockedWith(withDecisions(null), B.APPLICABILITY_INPUT_INVALID);
    blockedWith(resolve({ inventory: inv(), supersessionResolutions: 'FX-D' }), B.APPLICABILITY_INPUT_INVALID);
    blockedWith(resolve({ inventory: inv(), supersessionResolutions: { FX: decision() } }), B.APPLICABILITY_INPUT_INVALID);
  });

  test('a self-asserted, fully populated approval cannot authorize a production legal decision', () => {
    const records = inventory([{ ...p, provenance: 'REGISTER_APPROVED' }, { ...g, provenance: 'REGISTER_APPROVED' }], true);
    blockedWith(resolve({ context: 'PRODUCTION', inventory: records, supersessionResolutions: [decision()] }), B.PRODUCTION_AUTHORITY_UNAVAILABLE);
    blockedWith(resolve({ context: 'PRODUCTION', inventory: records }), B.SUPERSESSION_UNRESOLVED);
  });

  test('legacy continuation keeps its strict approval requirement and is strict about its fields', () => {
    const noMatch = inventory([record({ units: ['Gamma'] })], true);
    for (const legacyContinuation of [{ decisionRef: 'FX-DECISION', approved: 'true' }, { decisionRef: 'FX-DECISION', approved: 1 }, { decisionRef: '', approved: true }, { decisionRef: '  ', approved: true }, { decisionRef: 5, approved: true }, {}]) {
      blockedWith(resolve({ inventory: noMatch, legacyContinuation }), B.TRANSITION_TREATMENT_UNRESOLVED);
    }
    blockedWith(resolve({ inventory: noMatch, legacyContinuation: { decisionRef: 'FX-DECISION', approved: true, approvedBy: 'someone' } }), B.APPLICABILITY_INPUT_INVALID);
    blockedWith(resolve({ inventory: noMatch, legacyContinuation: 'FX-DECISION' }), B.APPLICABILITY_INPUT_INVALID);
  });
});

describe('X08 — places are matched by exact canonical identity, never by prefix or substring', () => {
  const ESTABLISHED_AT = (state, district) => establishment({ locations: [{ effectiveFrom: '2020-01-01', effectiveTo: null, state, district }] });
  const at = (state, district, records, complete = false, over = {}) => resolve({ establishment: ESTABLISHED_AT(state, district), inventory: inventory(records, complete), ...over });

  test('a district that is a prefix, suffix or fragment of a listed unit does not match it (both directions)', () => {
    const listed = [record({ units: ['Alpha', 'Beta Nagar'] })];
    for (const district of ['Alp', 'A', 'lph', 'ha', 'Alph', 'Beta', 'Nagar', 'Alphabet', 'Alpha Nagar', 'Alpha Beta Nagar']) {
      blockedWith(at('Fixtureland', district, listed), B.ENUMERATION_INCOMPLETE);
      blockedWith(at('Fixtureland', district, listed, true), B.TRANSITION_TREATMENT_UNRESOLVED);
    }
    for (const state of ['Fixture', 'Fixtureland North', 'land', 'Fixtureland Alpha']) blockedWith(at(state, 'Alpha', listed), B.ENUMERATION_INCOMPLETE);
  });

  test('where one name is a prefix of another, each resolves only to its own record', () => {
    const records = [record({ recordId: 'FX-SHORT', units: ['Alp'] }), record({ recordId: 'FX-LONG', units: ['Alpha'] }), record({ recordId: 'FX-LONGER', units: ['Alpha Nagar'] })];
    assert.deepEqual(at('Fixtureland', 'Alp', records).recordIds, ['FX-SHORT']);
    assert.deepEqual(at('Fixtureland', 'Alpha', records).recordIds, ['FX-LONG']);
    assert.deepEqual(at('Fixtureland', 'ALPHA   nagar', records).recordIds, ['FX-LONGER']);
  });

  test('canonical identity: case, spacing and Unicode composition do not matter; different letters do', () => {
    const records = [record({ units: ['Café'] })];
    assert.equal(at('Fixtureland', 'Café', records).outcome, 'RESOLVED'); // decomposed e + combining acute, same place
    assert.equal(at('Fixtureland', '  CAFÉ ', records).outcome, 'RESOLVED');
    blockedWith(at('Fixtureland', 'Cafe', records), B.ENUMERATION_INCOMPLETE); // an unaccented spelling is not asserted to be the same
  });

  test('ambiguous normalization fails closed: wildcard, control, compatibility-only and empty names never match or fall through to "not covered"', () => {
    const records = [record({ units: ['Alpha'] })];
    for (const district of ['Alp*', 'Alp%', 'Al?ha', 'Alp\\ha', 'Alpha|Beta', '^Alpha$', 'Alpha\u0000', 'Alpha\u0007', 'Ａlpha', 'ﬁnd', ' ', '\t']) {
      const result = at('Fixtureland', district, records, true);
      assert.equal(result.outcome, 'BLOCKED', JSON.stringify(district));
      assert.equal(result.code, B.ESTABLISHMENT_LOCATION_UNRESOLVED, JSON.stringify(district));
    }
    blockedWith(at('Ｆixtureland', 'Alpha', records, true), B.ESTABLISHMENT_LOCATION_UNRESOLVED);
    // a record that lists a compatibility-only spelling never matches a plain one
    blockedWith(at('Fixtureland', 'Alpha', [record({ units: ['Ａlpha'] })]), B.ENUMERATION_INCOMPLETE);
  });

  test('production stays blocked while the inventory is incomplete, whatever the geography', () => {
    const records = [record({ provenance: 'REGISTER_APPROVED', units: ['Alp', 'Alpha'] })];
    for (const district of ['Alp', 'Alpha', 'Alph']) blockedWith(at('Fixtureland', district, records, false, { context: 'PRODUCTION' }), B.ENUMERATION_INCOMPLETE);
  });
});

describe('dates are real calendar dates, and every external object is strict', () => {
  test('impossible dates are rejected as invalid input, never compared as strings', () => {
    for (const period of [{ start: '2026-13-45', end: '2026-13-46' }, { start: '2026-02-30', end: '2026-03-01' }, { start: '2026-00-10', end: '2026-10-10' }, { start: '2026-10-01', end: '2026-10-32' }, { start: '2027-02-29', end: '2027-03-01' }]) {
      blockedWith(resolve({ period }), B.APPLICABILITY_INPUT_INVALID);
    }
    assert.equal(resolve({ period: { start: '2028-02-29', end: '2028-03-31' } }).outcome, 'RESOLVED'); // 2028 is a leap year
    blockedWith(resolve({ inventory: inventory([record({ effectiveDate: '2026-02-30' })]) }), B.SUPERSESSION_UNRESOLVED);
  });

  test('a malformed end date is never treated as open-ended coverage (locations and work assignments)', () => {
    for (const effectiveTo of ['zzz', '2026-13-01', '2026-02-30', '', 'never', 20261031, true]) {
      const located = establishment({ locations: [{ effectiveFrom: '2020-01-01', effectiveTo, state: 'Fixtureland', district: 'Alpha' }] });
      assert.equal(resolve({ establishment: located }).outcome, 'BLOCKED', String(effectiveTo));
      blockedWith(resolve({ establishment: located }), B.ESTABLISHMENT_LOCATION_UNRESOLVED);
      const employee = { workAssignments: [{ establishmentId: 'EST-1', effectiveFrom: '2026-01-01', effectiveTo }] };
      blockedWith(resolveEmployeeApplicability({ employee, establishments: [establishment()], period: OCT, inventory: inventory([record()]), context: TEST }), B.ESTABLISHMENT_LOCATION_UNRESOLVED);
    }
    // null and an omitted end are the open-ended forms
    const open = { workAssignments: [{ establishmentId: 'EST-1', effectiveFrom: '2026-01-01' }] };
    assert.equal(resolveEmployeeApplicability({ employee: open, establishments: [establishment()], period: OCT, inventory: inventory([record()]), context: TEST }).outcome, 'RESOLVED');
  });

  test('an unrecognized field anywhere in the input is APPLICABILITY_INPUT_INVALID, never ignored', () => {
    const bad = (over) => blockedWith(resolve(over), B.APPLICABILITY_INPUT_INVALID);
    bad({ inventoryy: {} });
    bad({ establishment: { ...establishment(), name: 'x' } });
    bad({ establishment: establishment({ locations: [{ effectiveFrom: '2020-01-01', effectiveTo: null, state: 'Fixtureland', district: 'Alpha', pincode: '1' }] }) });
    bad({ establishment: establishment({ locations: 'Alpha' }) });
    bad({ period: { start: '2026-10-01', end: '2026-10-31', note: 'x' } });
    bad({ inventory: { ...inventory([record()]), source: 'x' } });
    bad({ inventory: inventory([{ ...record(), recordID: 'typo' }]) });
    bad({ inventory: inventory([record({ verification: { textStatus: 'PRIMARY_TEXT_VERIFIED', sourceArtifactHash: HASH, signedBy: 'x' } })]) });
    bad({ inventory: inventory([record({ units: 'Alpha' })]) });
    bad({ inventory: inventory([record({ units: ['Alpha', 5] })]) });
    bad({ inventory: inventory([record({ supersedes: 'FX-P' })]) });
    const employee = { workAssignments: [{ establishmentId: 'EST-1', effectiveFrom: '2026-01-01', effectiveTo: null }] };
    const viaEmployee = (e) => resolveEmployeeApplicability({ employee: e, establishments: [establishment()], period: OCT, inventory: inventory([record()]), context: 'TEST' });
    blockedWith(viaEmployee({ ...employee, name: 'x' }), B.APPLICABILITY_INPUT_INVALID);
    blockedWith(viaEmployee({ workAssignments: [{ ...employee.workAssignments[0], role: 'x' }] }), B.APPLICABILITY_INPUT_INVALID);
    blockedWith(viaEmployee({ workAssignments: 'EST-1' }), B.APPLICABILITY_INPUT_INVALID);
    assert.equal(viaEmployee(employee).outcome, 'RESOLVED');
  });
});

describe('independent-review findings: the employee path, record identity and inherited properties', () => {
  const employee = { workAssignments: [{ establishmentId: 'EST-1', effectiveFrom: '2026-01-01', effectiveTo: null }] };
  const viaEmployee = (over = {}) => resolveEmployeeApplicability({ employee, establishments: [establishment()], period: OCT, inventory: inventory([record()]), context: TEST, ...over });

  test('an establishment cannot be supplied around the work assignment: it overrides nothing and is rejected', () => {
    const other = establishment({ establishmentId: 'EST-2', locations: [{ effectiveFrom: '2020-01-01', effectiveTo: null, state: 'Otherland', district: 'Gamma' }] });
    blockedWith(viaEmployee({ establishment: other }), B.APPLICABILITY_INPUT_INVALID);
    blockedWith(viaEmployee({ residentialAddress: { state: 'Fixtureland', district: 'Alpha' } }), B.APPLICABILITY_INPUT_INVALID);
    assert.equal(viaEmployee().outcome, 'RESOLVED');
  });

  test('the assigned establishment is found by a required, unique establishmentId', () => {
    const second = establishment({ locations: [{ effectiveFrom: '2020-01-01', effectiveTo: null, state: 'Otherland', district: 'Gamma' }] });
    blockedWith(viaEmployee({ establishments: [establishment(), second] }), B.ESTABLISHMENT_LOCATION_UNRESOLVED); // two with one id: none is chosen
    blockedWith(viaEmployee({ employee: { workAssignments: [{ effectiveFrom: '2026-01-01', effectiveTo: null }] }, establishments: [{ ...establishment(), establishmentId: undefined }] }), B.APPLICABILITY_INPUT_INVALID);
    blockedWith(viaEmployee({ employee: { workAssignments: [{ establishmentId: '', effectiveFrom: '2026-01-01', effectiveTo: null }] } }), B.APPLICABILITY_INPUT_INVALID);
    blockedWith(viaEmployee({ establishments: [{ ...establishment(), establishmentId: undefined }, establishment({ establishmentId: 'EST-9' })] }), B.ESTABLISHMENT_LOCATION_UNRESOLVED);
  });

  test('record identity is validated: every record has a unique recordId, supersedes names real ids, supersessionStatus is a known value', () => {
    const bad = (records) => blockedWith(resolve({ inventory: inventory(records) }), B.APPLICABILITY_INPUT_INVALID);
    bad([record(), record()]); // duplicate recordId
    bad([record({ recordId: undefined })]);
    bad([record({ recordId: '' })]);
    bad([record({ supersedes: [undefined] })]);
    bad([record({ supersedes: [''] })]);
    bad([record({ supersessionStatus: 'unresolved' })]);
    bad([record({ supersessionStatus: 'FINE' })]);
    bad([record({ provenance: 5 })]);
    bad(new Array(1)); // a sparse records list
  });

  test('a hostile getter or Proxy is a named, fail-closed error, never a raw one (both resolvers)', () => {
    const raw = (fn) => { let error = null; try { fn(); } catch (e) { error = e; } assert.ok(error instanceof StatutoryWageError, String(error)); assert.equal(error.code, C.INPUT_MALFORMED); };
    const hostile = () => { throw new Error('boom'); };
    const base = { establishment: establishment(), period: OCT, inventory: inventory([record()]), context: TEST };
    raw(() => resolveEstablishmentApplicability({ ...base, get period() { return hostile(); } }));
    raw(() => resolveEstablishmentApplicability({ ...base, establishment: { ...establishment(), locations: [{ effectiveFrom: '2020-01-01', effectiveTo: null, get state() { return hostile(); }, district: 'Alpha' }] } }));
    raw(() => resolveEmployeeApplicability({ get employee() { return hostile(); }, establishments: [], period: OCT, context: TEST }));
  });

  test('a hostile Proxy (a trap that throws) is a named, fail-closed error in both resolvers', () => {
    for (const trap of ['ownKeys', 'getOwnPropertyDescriptor']) {
      const hostile = new Proxy({ establishment: establishment(), period: OCT, inventory: inventory([record()]), context: TEST }, { [trap]() { throw new Error('boom'); } });
      for (const resolver of [resolveEstablishmentApplicability, resolveEmployeeApplicability]) {
        let error = null;
        try { resolver(hostile); } catch (e) { error = e; }
        assert.ok(error instanceof StatutoryWageError && error.code === C.INPUT_MALFORMED, `${resolver.name} / ${trap}: ${error}`);
        assert.match(error.message, /could not be processed safely/);
      }
    }
  });

  test('nothing is read from an inherited property: caller-built prototypes are rejected', () => {
    const inheritedInventory = Object.create({ enumerationComplete: true });
    inheritedInventory.records = [];
    for (const context of ['TEST', 'PRODUCTION']) blockedWith(resolve({ context, inventory: inheritedInventory }), B.APPLICABILITY_INPUT_INVALID);
    const inheritedDecision = Object.create({ approved: true });
    Object.assign(inheritedDecision, { supersederId: 'FX-G', supersededId: 'FX-P', decisionRef: 'FX-D' });
    const p = record({ recordId: 'FX-P' });
    const g = record({ recordId: 'FX-G', state: 'Otherland', units: ['Gamma'], supersedes: ['FX-P'] });
    blockedWith(resolve({ inventory: inventory([p, g], true), supersessionResolutions: [inheritedDecision] }), B.APPLICABILITY_INPUT_INVALID);
    const inheritedEstablishment = Object.create({ categoryState: 'ESTABLISHED' });
    Object.assign(inheritedEstablishment, { establishmentId: 'EST-1', locations: establishment().locations });
    blockedWith(resolve({ establishment: inheritedEstablishment }), B.APPLICABILITY_INPUT_INVALID);
    const inheritedLegacy = Object.create({ approved: true });
    inheritedLegacy.decisionRef = 'FX-DECISION';
    blockedWith(resolve({ inventory: inventory([record({ units: ['Gamma'] })], true), legacyContinuation: inheritedLegacy }), B.APPLICABILITY_INPUT_INVALID);
  });
});

describe('final hardening 4 and 5 — resolver results are explicitly unverified, and only own data is ever read', () => {
  const P = () => record({ recordId: 'FX-P' });
  const G = () => record({ recordId: 'FX-G', state: 'Otherland', units: ['Gamma'], supersedes: ['FX-P'] });
  const LEGACY = { decisionRef: 'FX-DECISION', approved: true };
  const employee = () => ({ workAssignments: [{ establishmentId: 'EST-1', effectiveFrom: '2026-01-01', effectiveTo: null }], residentialAddress: { state: 'Fixtureland', district: 'Alpha' } });
  const estSamples = (context) => [
    { name: 'match + supersession decision', input: { establishment: establishment(), period: OCT, inventory: inventory([P(), G()], true), supersessionResolutions: [decision()], legacyContinuation: LEGACY, context } },
    { name: 'no match + legacy decision', input: { establishment: establishment(), period: OCT, inventory: inventory([record({ units: ['Gamma'] })], true), legacyContinuation: LEGACY, context } },
  ];
  const empSamples = (context) => [{ name: 'employee path', input: { employee: employee(), establishments: [establishment()], period: OCT, inventory: inventory([P()], true), supersessionResolutions: [decision()], legacyContinuation: LEGACY, context } }];

  test('a TEST resolution says it is unverified and not legally approved, and carries no claimed provenance', () => {
    const resolved = resolve({ inventory: inventory([record({ provenance: 'REGISTER_APPROVED' })], true) });
    assert.equal(resolved.outcome, 'RESOLVED');
    assert.equal(resolved.evaluationContext, 'TEST');
    assert.equal(resolved.verification, 'UNVERIFIED_TEST_ONLY');
    assert.equal(resolved.legalStatus, 'NOT_LEGALLY_APPROVED');
    assert.ok(!JSON.stringify(resolved).includes('REGISTER_APPROVED'), 'the caller\'s label is not echoed');
    const legacy = resolve({ inventory: inventory([record({ units: ['Gamma'] })], true), legacyContinuation: { decisionRef: 'FX-DECISION', approved: true } });
    assert.equal(legacy.regime, REGIMES.LEGACY_CONTINUATION_DECIDED);
    assert.equal(legacy.legalStatus, 'NOT_LEGALLY_APPROVED');
    const viaEmployee = resolveEmployeeApplicability({ employee: employee(), establishments: [establishment()], period: OCT, inventory: inventory([P()], true), context: TEST });
    assert.equal(viaEmployee.verification, 'UNVERIFIED_TEST_ONLY');
    // a blocked outcome is not dressed up with these markers
    assert.equal(blockedWith(resolve({ inventory: inventory([], false) }), B.ENUMERATION_INCOMPLETE).legalStatus, undefined);
  });

  test('differential: for every key at every depth, deleting it and polluting Object.prototype with its original value changes nothing', () => {
    let total = 0;
    for (const context of ['TEST', 'PRODUCTION']) {
      for (const { name, input } of estSamples(context)) {
        const { findings, examined } = pollutionDifferential(input, (copy) => resolveEstablishmentApplicability(copy));
        assert.deepEqual(findings, [], `${name} / ${context}`);
        total += examined.length;
      }
      for (const { name, input } of empSamples(context)) {
        const { findings, examined } = pollutionDifferential(input, (copy) => resolveEmployeeApplicability(copy));
        assert.deepEqual(findings, [], `${name} / ${context}`);
        total += examined.length;
      }
    }
    assert.ok(total > 200, `the differential examined ${total} key paths`);
  });

  test('the differential covers the security-relevant keys by name, including nested ones', () => {
    const examined = new Set();
    for (const { input } of [...estSamples('TEST'), ...empSamples('TEST')]) for (const path of objectKeyPaths(input)) examined.add(String(path.at(-1)));
    for (const key of ['establishment', 'establishmentId', 'categoryState', 'locations', 'effectiveFrom', 'effectiveTo', 'state', 'district', 'period', 'start', 'end', 'inventory', 'enumerationComplete', 'records',
      'recordId', 'provenance', 'instrument', 'units', 'effectiveDate', 'supersedes', 'supersessionStatus', 'verification', 'textStatus', 'sourceArtifactHash',
      'supersessionResolutions', 'supersederId', 'supersededId', 'decisionRef', 'approved', 'approvedBy', 'approvedOn', 'scope', 'legacyContinuation', 'context',
      'employee', 'establishments', 'workAssignments', 'residentialAddress']) {
      assert.ok(examined.has(key), `the differential never examined "${key}"`);
    }
  });

  test('named cases: a missing categoryState, enumerationComplete, location, verification or decision field stays missing under a polluted prototype', () => {
    const base = (context) => ({ establishment: establishment(), period: OCT, inventory: inventory([P(), G()], true), supersessionResolutions: [decision()], context });
    const cases = [
      ['categoryState', 'TEST', (i) => { delete i.establishment.categoryState; }, B.ESTABLISHMENT_COVERAGE_STATE_UNRESOLVED, 'ESTABLISHED'],
      ['categoryState', 'PRODUCTION', (i) => { delete i.establishment.categoryState; }, B.ESTABLISHMENT_COVERAGE_STATE_UNRESOLVED, 'ESTABLISHED'],
      ['enumerationComplete', 'PRODUCTION', (i) => { delete i.inventory.enumerationComplete; }, B.ENUMERATION_INCOMPLETE, true],
      ['enumerationComplete', 'TEST', (i) => { i.inventory = inventory([record({ units: ['Gamma'] })], undefined); delete i.inventory.enumerationComplete; }, B.ENUMERATION_INCOMPLETE, true],
      ['state', 'TEST', (i) => { delete i.establishment.locations[0].state; }, B.ESTABLISHMENT_LOCATION_UNRESOLVED, 'Fixtureland'],
      ['district', 'TEST', (i) => { delete i.establishment.locations[0].district; }, B.ESTABLISHMENT_LOCATION_UNRESOLVED, 'Alpha'],
      ['effectiveFrom', 'TEST', (i) => { delete i.establishment.locations[0].effectiveFrom; }, B.ESTABLISHMENT_LOCATION_UNRESOLVED, '2020-01-01'],
      ['textStatus', 'TEST', (i) => { delete i.inventory.records[0].verification.textStatus; }, B.TERRITORIAL_INSTRUMENT_UNVERIFIED, 'PRIMARY_TEXT_VERIFIED'],
      ['verification', 'TEST', (i) => { delete i.inventory.records[0].verification; }, B.TERRITORIAL_INSTRUMENT_UNVERIFIED, { textStatus: 'PRIMARY_TEXT_VERIFIED', sourceArtifactHash: HASH }],
      ['approved', 'TEST', (i) => { delete i.supersessionResolutions[0].approved; }, B.SUPERSESSION_UNRESOLVED, true],
      ['approvedBy', 'TEST', (i) => { delete i.supersessionResolutions[0].approvedBy; }, B.SUPERSESSION_UNRESOLVED, 'FIXTURE_APPROVER'],
      ['scope', 'TEST', (i) => { delete i.supersessionResolutions[0].scope; }, B.SUPERSESSION_UNRESOLVED, { state: 'Fixtureland' }],
      ['decisionRef', 'TEST', (i) => { delete i.supersessionResolutions[0].decisionRef; }, B.SUPERSESSION_UNRESOLVED, 'FX-D'],
      ['supersessionStatus-less record is fine', 'TEST', () => {}, null, 'UNRESOLVED'],
    ];
    for (const [key, context, mutate, code, polluter] of cases) {
      const key2 = key.startsWith('supersessionStatus') ? 'supersessionStatus' : key;
      const input = base(context);
      mutate(input);
      const before = outcomeSignature(() => resolveEstablishmentApplicability(structuredClone(input)));
      Object.prototype[key2] = polluter; // eslint-disable-line no-extend-native
      let after;
      try { after = outcomeSignature(() => resolveEstablishmentApplicability(structuredClone(input))); } finally { delete Object.prototype[key2]; }
      assert.equal(after, before, `${key} (${context})`);
      if (code) assert.match(before, new RegExp(code), `${key} (${context}): ${before}`);
    }
  });

  test('internal result objects: the names the resolver builds its own answers from cannot be supplied by a polluted prototype', () => {
    const scenarios = [
      () => resolve({ establishment: establishment({ locations: [] }) }),
      () => resolve({ establishment: establishment({ locations: undefined }) }),
      () => resolve({ establishment: establishment({ locations: [{ effectiveFrom: '2020-01-01', effectiveTo: null, state: 'Fixtureland', district: '' }] }) }),
      () => resolve({ establishment: establishment({ locations: [{ effectiveFrom: '2020-01-01', effectiveTo: null, state: 'Fixtureland', district: 'Al*' }] }) }),
      () => resolve({ inventory: inventory([], false) }),
      () => resolve({ inventory: inventory([record({ units: ['Gamma'] })], true) }),
      () => resolve({ inventory: inventory([P(), G()], true) }),
      () => resolve({ period: { start: '2026-09-16', end: '2026-10-15' } }),
      () => resolve({ context: 'PRODUCTION', inventory: inventory([record({ provenance: 'REGISTER_APPROVED' })], true) }),
      () => resolve(),
      () => resolveEmployeeApplicability({ employee: { workAssignments: [] }, establishments: [establishment()], period: OCT, inventory: inventory([P()], true), context: TEST }),
    ];
    const names = ['location', 'code', 'detail', 'outcome', 'regime', 'recordIds', 'recordId', 'supersederId', 'state', 'district', 'layers', 'effectiveDate', 'dates', 'decisionRef', 'categoryState', 'evaluationContext', 'verification', 'legalStatus'];
    const baseline = scenarios.map((scenario) => outcomeSignature(scenario));
    for (const name of names) {
      Object.prototype[name] = { state: 'Fixtureland', district: 'Alpha' }; // eslint-disable-line no-extend-native
      let polluted;
      try { polluted = scenarios.map((scenario) => outcomeSignature(scenario)); } finally { delete Object.prototype[name]; }
      assert.deepEqual(polluted, baseline, `polluting "${name}" changed an outcome`);
    }
  });
});

describe('last review round — symbol-keyed arrays and lying Proxies in the resolvers', () => {
  const withSymbol = (array) => { array[Symbol('s')] = 1; return array; };

  test('a symbol-keyed records list, locations list, decision list or assignment list is rejected, so nothing in it is read through a prototype', () => {
    const records = withSymbol([record()]);
    for (const context of ['TEST', 'PRODUCTION']) blockedWith(resolve({ context, inventory: { enumerationComplete: true, records } }), B.APPLICABILITY_INPUT_INVALID);
    blockedWith(resolve({ establishment: establishment({ locations: withSymbol([{ effectiveFrom: '2020-01-01', effectiveTo: null, state: 'Fixtureland', district: 'Alpha' }]) }) }), B.APPLICABILITY_INPUT_INVALID);
    blockedWith(resolve({ supersessionResolutions: withSymbol([]) }), B.APPLICABILITY_INPUT_INVALID);
    blockedWith(resolve({ inventory: inventory([record({ units: withSymbol(['Alpha']) })]) }), B.APPLICABILITY_INPUT_INVALID);
    const employee = { workAssignments: withSymbol([{ establishmentId: 'EST-1', effectiveFrom: '2026-01-01', effectiveTo: null }]) };
    blockedWith(resolveEmployeeApplicability({ employee, establishments: [establishment()], period: OCT, inventory: inventory([record()]), context: TEST }), B.APPLICABILITY_INPUT_INVALID);
    // the reviewer's probe: polluted verification must not be read through such a list
    Object.prototype.verification = { textStatus: 'PRIMARY_TEXT_VERIFIED', sourceArtifactHash: HASH }; // eslint-disable-line no-extend-native
    try {
      const bare = record(); delete bare.verification;
      blockedWith(resolve({ inventory: { enumerationComplete: true, records: withSymbol([bare]) } }), B.APPLICABILITY_INPUT_INVALID);
      blockedWith(resolve({ inventory: { enumerationComplete: true, records: [bare] } }), B.TERRITORIAL_INSTRUMENT_UNVERIFIED); // the control
    } finally {
      delete Object.prototype.verification;
    }
  });

  test('a class instance (or any non-plain object) at any object position is rejected AS NOT AN OBJECT, not by accident because of a field it happens to carry', () => {
    class Thing { constructor() { this.a = 1; } }
    const notAnObject = (result) => {
      assert.equal(result.outcome, 'BLOCKED');
      assert.equal(result.code, B.APPLICABILITY_INPUT_INVALID);
      assert.doesNotMatch(result.detail, /unrecognized/, result.detail);
      assert.match(result.detail, /must be an object|required|must be an array/, result.detail);
    };
    notAnObject(resolve({ establishment: new Thing() }));
    notAnObject(resolve({ inventory: inventory([new Thing()]) }));
    notAnObject(resolve({ inventory: inventory([record({ verification: new Thing() })]) }));
    notAnObject(resolve({ establishment: establishment({ locations: [new Thing()] }) }));
    notAnObject(resolve({ period: new Thing() }));
    const p = record({ recordId: 'FX-P' });
    const g = record({ recordId: 'FX-G', state: 'Otherland', units: ['Gamma'], supersedes: ['FX-P'] });
    notAnObject(resolve({ inventory: inventory([p, g], true), supersessionResolutions: [new Thing()] }));
    notAnObject(resolve({ inventory: inventory([p, g], true), supersessionResolutions: [decision({ scope: new Thing() })] }));
    notAnObject(resolve({ legacyContinuation: new Thing() }));
    const employee = { workAssignments: [{ establishmentId: 'EST-1', effectiveFrom: '2026-01-01', effectiveTo: null }] };
    const viaEmployee = (over) => resolveEmployeeApplicability({ employee, establishments: [establishment()], period: OCT, inventory: inventory([record()]), context: TEST, ...over });
    notAnObject(viaEmployee({ employee: new Thing() }));
    notAnObject(viaEmployee({ employee: { workAssignments: [new Thing()] } }));
  });

  test('a lying Proxy is never read twice: it is replaced by a marker, so the resolver rejects it', () => {
    let reads = 0;
    const liar = new Proxy({ ...establishment() }, { getPrototypeOf() { reads += 1; return reads === 1 ? Date.prototype : Object.prototype; } });
    blockedWith(resolve({ establishment: liar }), B.APPLICABILITY_INPUT_INVALID);
  });
});
