/**
 * test_phase1d_engine.js — the pure statutory-wage engine fails closed (Phase 1D scaffold).
 *
 * Every named failure code is shown to be reachable AND to stop the calculation that must be
 * blocked. Fixture gating, in-kind, second-proviso and pool-interpretation blocks, determinism,
 * and the gated contribution-rounding stage are covered here.
 *
 * Every rule is a MATHEMATICAL_FIXTURE. Nothing here asserts what a real clause includes.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { fixtureRule, engineLines, pollutionDifferential, objectKeyPaths } from './test_support/wageFixtures.js';
import {
  computeStatutoryWage, validateRuleDefinition, assertRuleUsable, exactProduct, roundContribution,
  ENGINE_NAME, ENGINE_VERSION, RULE_SCHEMA,
} from './src/statutoryWage/wageEngine.js';
import { StatutoryWageError, STATUTORY_WAGE_ERROR_CODES as C } from './src/statutoryWage/errors.js';
import * as Q from './src/statutoryWage/rational.js';
import { canonicalJson, hashCanonical } from './src/statutoryWage/canonical.js';
import { toOwnData, MAX_DEPTH, NotPlainData } from './src/statutoryWage/ownData.js';
import { mappingEntryHash, registerSnapshotHash, verifyRegisterSnapshot, MAPPING_ENTRY_SCHEMA } from './src/statutoryWage/provenance.js';

const clausesAB = { FIXTURE_A: { d: '1/1', p: '1/1' }, FIXTURE_B: { d: '1/1', p: '0/1' } };
// A line states `inKind: false` explicitly: an omitted inKind is an unknown state and is blocked.
const included = (amountPaise, lineId = 'L1') => ({ lineId, amountPaise, inKind: false, classification: { status: 'CLASSIFIED', parts: [{ target: 'INCLUDED', portion: '1/1' }] } });
const inClause = (clauseId, amountPaise, lineId = 'L2', extra = {}) => ({ lineId, amountPaise, inKind: false, classification: { status: 'CLASSIFIED', parts: [{ target: 'CLAUSE', clauseId, portion: '1/1' }] }, ...extra });

// Mathematical fixtures run only when the test says so: omitting the context would mean PRODUCTION.
const TEST = Object.freeze({ context: 'TEST' });
const PRODUCTION = Object.freeze({ context: 'PRODUCTION' });
const run = (lines, rule = fixtureRule({ clauses: clausesAB }), options = TEST) => computeStatutoryWage({ rule, lines }, options);
const reached = new Set(); // every named code the tests actually provoked (checked at the end of the file)
const expectCode = (fn, code) => {
  let error = null;
  try { fn(); } catch (e) { error = e; }
  assert.ok(error instanceof StatutoryWageError, `expected ${code}, got ${error ? error.message : 'no error'}`);
  assert.equal(error.code, code, error.message);
  reached.add(error.code);
  return error;
};

describe('a valid fixture computes, with a deterministic, fully attributed breakdown', () => {
  test('result shape: engine identity, rule provenance, per-line parts, per-clause totals, stages', () => {
    const rule = fixtureRule({ clauses: clausesAB });
    const result = run([included(10000), inClause('FIXTURE_A', 12000)], rule);
    assert.deepEqual(result.engine, { name: ENGINE_NAME, version: ENGINE_VERSION });
    assert.equal(result.unit, 'PAISE_EXACT_RATIONAL');
    assert.equal(result.rule.ruleId, 'FIXTURE_RULE');
    assert.deepEqual(result.rule.provenance, { source: 'MATHEMATICAL_FIXTURE', verification: 'UNVERIFIED_TEST_ONLY', legalStatus: 'NOT_LEGALLY_APPROVED' });
    assert.match(result.rule.ruleHash, /^[0-9a-f]{64}$/);
    assert.match(result.inputDigest, /^[0-9a-f]{64}$/);
    assert.match(result.resultHash, /^[0-9a-f]{64}$/);
    assert.equal(result.totals.wagePaise, '11000/1');
    assert.deepEqual(result.stages, { contributionRounding: 'NOT_APPLIED_UNAPPROVED' });
    const a = result.clauses.find((clause) => clause.clauseId === 'FIXTURE_A');
    assert.deepEqual(a, { clauseId: 'FIXTURE_A', amountPaise: '12000/1', denominator: '1/1', pool: '1/1', inDenominatorPaise: '12000/1', inPoolPaise: '12000/1', notInPoolPaise: '0/1' });
    assert.deepEqual(result.lines.map((line) => line.lineId), ['L1', 'L2']);
    assert.deepEqual(result.lines[1].parts, [{ target: 'CLAUSE', clauseId: 'FIXTURE_A', portion: '1/1', portionAmountPaise: '12000/1' }]);
  });

  test('the same input always yields the same hash; a different rule version or amount changes it', () => {
    const lines = [included(10000), inClause('FIXTURE_A', 12000)];
    const first = run(lines);
    assert.equal(run(JSON.parse(JSON.stringify(lines), (k, v) => v)).resultHash, first.resultHash);
    assert.notEqual(run(lines, fixtureRule({ clauses: clausesAB, version: 2 })).resultHash, first.resultHash);
    assert.notEqual(run([included(10001), inClause('FIXTURE_A', 12000)]).resultHash, first.resultHash);
  });

  test('clause order in the rule does not matter', () => {
    const forward = fixtureRule({ clauses: { FIXTURE_A: clausesAB.FIXTURE_A, FIXTURE_B: clausesAB.FIXTURE_B } });
    const reverse = fixtureRule({ clauses: { FIXTURE_B: clausesAB.FIXTURE_B, FIXTURE_A: clausesAB.FIXTURE_A } });
    const lines = [included(10000), inClause('FIXTURE_A', 12000, 'L2'), inClause('FIXTURE_B', 500, 'L3')];
    assert.deepEqual(run(lines, forward).totals, run(lines, reverse).totals);
  });

  test('there is no gross fallback: a line with no classification is blocked, never counted as wage', () => {
    expectCode(() => run([{ lineId: 'L1', amountPaise: 10000 }]), C.STATUTORY_NATURE_MISSING);
    expectCode(() => run([{ lineId: 'L1', amountPaise: 10000, gross: 10000, classification: { status: 'UNCLASSIFIED' } }]), C.STATUTORY_NATURE_MISSING);
  });
});

describe('classification and mapping failures are named and block the calculation', () => {
  test('STATUTORY_NATURE_MISSING: unclassified line', () => {
    expectCode(() => run([included(1), { lineId: 'L2', amountPaise: 5, classification: { status: 'UNCLASSIFIED' } }]), C.STATUTORY_NATURE_MISSING);
  });

  test('CLASSIFICATION_AMBIGUOUS: an ambiguous classification is never resolved by choosing one', () => {
    const error = expectCode(() => run([{ lineId: 'L1', amountPaise: 5, classification: { status: 'AMBIGUOUS', candidates: ['FIXTURE_A', 'FIXTURE_B'] } }]), C.CLASSIFICATION_AMBIGUOUS);
    assert.deepEqual(error.details.candidates, ['FIXTURE_A', 'FIXTURE_B']);
    expectCode(() => run([{ lineId: 'L1', amountPaise: 5, classification: { status: 'SOMETHING_NEW' } }]), C.CLASSIFICATION_AMBIGUOUS);
  });

  test('CLAUSE_MATCH_CONFLICT: two matching clauses and no declared split; the first is never chosen', () => {
    const error = expectCode(() => run([{ lineId: 'L1', amountPaise: 5, classification: { status: 'MATCHED', matchedClauses: ['FIXTURE_A', 'FIXTURE_B'] } }]), C.CLAUSE_MATCH_CONFLICT);
    assert.deepEqual(error.details.matched, ['FIXTURE_A', 'FIXTURE_B']);
  });

  test('a single matched clause is the whole amount; an empty match list is a missing classification', () => {
    const result = run([{ lineId: 'L1', amountPaise: 700, inKind: false, classification: { status: 'MATCHED', matchedClauses: ['FIXTURE_B'] } }]);
    assert.equal(result.totals.unqualifiedPaise, '700/1');
    expectCode(() => run([{ lineId: 'L1', amountPaise: 5, classification: { status: 'MATCHED', matchedClauses: [] } }]), C.STATUTORY_NATURE_MISSING);
  });

  test('STATUTORY_CLASSIFICATION_OVERLAP: the same money counted twice', () => {
    // Same target twice.
    expectCode(() => run([{ lineId: 'L1', amountPaise: 9, classification: { status: 'CLASSIFIED', parts: [{ target: 'CLAUSE', clauseId: 'FIXTURE_A', portion: '1/2' }, { target: 'CLAUSE', clauseId: 'FIXTURE_A', portion: '1/2' }] } }]), C.STATUTORY_CLASSIFICATION_OVERLAP);
    expectCode(() => run([{ lineId: 'L1', amountPaise: 9, classification: { status: 'CLASSIFIED', parts: [{ target: 'INCLUDED', portion: '1/2' }, { target: 'INCLUDED', portion: '1/2' }] } }]), C.STATUTORY_CLASSIFICATION_OVERLAP);
    // Portions that add to more than the whole.
    expectCode(() => run([{ lineId: 'L1', amountPaise: 9, classification: { status: 'CLASSIFIED', parts: [{ target: 'INCLUDED', portion: '3/4' }, { target: 'CLAUSE', clauseId: 'FIXTURE_A', portion: '1/2' }] } }]), C.STATUTORY_CLASSIFICATION_OVERLAP);
  });

  test('MAPPING_PARTITION_INVALID: portions that leave part of the amount unassigned (no silent default)', () => {
    const error = expectCode(() => run([{ lineId: 'L1', amountPaise: 9, classification: { status: 'CLASSIFIED', parts: [{ target: 'INCLUDED', portion: '1/2' }, { target: 'CLAUSE', clauseId: 'FIXTURE_A', portion: '1/4' }] } }]), C.MAPPING_PARTITION_INVALID);
    assert.equal(error.details.total, '3/4');
    expectCode(() => run([{ lineId: 'L1', amountPaise: 9, classification: { status: 'CLASSIFIED', parts: [] } }]), C.MAPPING_PARTITION_INVALID);
    expectCode(() => run([{ lineId: 'L1', amountPaise: 9, classification: { status: 'CLASSIFIED', parts: [{ target: 'INCLUDED', portion: '0/1' }, { target: 'CLAUSE', clauseId: 'FIXTURE_A', portion: '1/1' }] } }]), C.MAPPING_PARTITION_INVALID);
    expectCode(() => run([{ lineId: 'L1', amountPaise: 9, classification: { status: 'CLASSIFIED', parts: [{ target: 'ELSEWHERE', portion: '1/1' }] } }]), C.MAPPING_PARTITION_INVALID);
  });

  test('MAPPING_PARTITION_INVALID: a clause that violates 0 <= p <= d <= 1 is rejected when the rule is loaded', () => {
    for (const [d, p] of [['1/2', '1/1'], ['3/2', '1/1'], ['1/1', '3/2']]) {
      const error = expectCode(() => run([included(1)], fixtureRule({ clauses: { FIXTURE_BAD: { d, p } } })), C.MAPPING_PARTITION_INVALID);
      assert.equal(error.details.clauseId, 'FIXTURE_BAD');
    }
    // The boundary itself is allowed.
    assert.doesNotThrow(() => validateRuleDefinition(fixtureRule({ clauses: { FIXTURE_OK: { d: '1/1', p: '1/1' }, FIXTURE_Z: { d: '0/1', p: '0/1' } } })));
  });

  test('STATUTORY_NATURE_NOT_IN_RULE: a clause the rule does not define', () => {
    const error = expectCode(() => run([inClause('FIXTURE_UNKNOWN', 5)]), C.STATUTORY_NATURE_NOT_IN_RULE);
    assert.equal(error.details.clauseId, 'FIXTURE_UNKNOWN');
  });

  test('REMUNERATION_FACT_MISSING: a clause that needs a fact the line does not carry', () => {
    const rule = fixtureRule({ clauses: { FIXTURE_NEEDS_FACT: { d: '1/1', p: '1/1', extra: { requiredFacts: [{ name: 'employerPaid', type: 'BOOLEAN' }, { name: 'madeToEmployee', type: 'BOOLEAN' }] } } } });
    const error = expectCode(() => run([inClause('FIXTURE_NEEDS_FACT', 100)], rule), C.REMUNERATION_FACT_MISSING);
    assert.equal(error.details.fact, 'employerPaid');
    expectCode(() => run([inClause('FIXTURE_NEEDS_FACT', 100, 'L2', { facts: { employerPaid: true } })], rule), C.REMUNERATION_FACT_MISSING);
    expectCode(() => run([inClause('FIXTURE_NEEDS_FACT', 100, 'L2', { facts: { employerPaid: true, madeToEmployee: null } })], rule), C.REMUNERATION_FACT_MISSING);
    // With every fact present it computes (facts of `false` count as supplied).
    const ok = run([inClause('FIXTURE_NEEDS_FACT', 100, 'L2', { facts: { employerPaid: true, madeToEmployee: false } })], rule);
    assert.equal(ok.totals.poolPaise, '100/1');
  });
});

describe('open legal questions block the calculations that depend on them', () => {
  test('WAGE_POOL_INTERPRETATION_UNRESOLVED: a used clause whose pool interpretation is unresolved', () => {
    const rule = fixtureRule({ clauses: { FIXTURE_P: { d: '1/1', p: '1/1', extra: { poolInterpretation: 'UNRESOLVED' } } } });
    expectCode(() => run([inClause('FIXTURE_P', 100)], rule), C.WAGE_POOL_INTERPRETATION_UNRESOLVED);
    // An unused unresolved clause does not block lines that never touch it.
    assert.equal(run([included(100)], rule).totals.wagePaise, '100/1');
  });

  test('WAGE_SECOND_PROVISO_SCOPE_UNRESOLVED: a dependent clause blocks until a decision is cited', () => {
    const dependent = (secondProviso) => fixtureRule({ secondProviso, clauses: { FIXTURE_S: { d: '1/1', p: '1/1', extra: { secondProvisoDependent: true } } } });
    expectCode(() => run([inClause('FIXTURE_S', 100)], dependent({ status: 'UNRESOLVED' })), C.WAGE_SECOND_PROVISO_SCOPE_UNRESOLVED);
    // DECIDED needs a decisionRef: a bare DECIDED is an incomplete definition, not an approval.
    expectCode(() => run([inClause('FIXTURE_S', 100)], dependent({ status: 'DECIDED' })), C.WAGE_DEFINITION_INCOMPLETE);
    assert.equal(run([inClause('FIXTURE_S', 100)], dependent({ status: 'DECIDED', decisionRef: 'FIXTURE_DECISION_1' })).totals.poolPaise, '100/1');
    // Lines that never touch the dependent clause are unaffected.
    assert.equal(run([included(100)], dependent({ status: 'UNRESOLVED' })).totals.wagePaise, '100/1');
  });

  test('IN_KIND_RULE_UNRESOLVED: in-kind remuneration is blocked, whatever else the line says', () => {
    expectCode(() => run([{ ...included(100), inKind: true }]), C.IN_KIND_RULE_UNRESOLVED);
    expectCode(() => run([{ ...inClause('FIXTURE_A', 100), inKind: true }]), C.IN_KIND_RULE_UNRESOLVED);
    // (the full in-kind matrix, including malformed states, is in "in-kind states are strict" below)
  });

  test('a rule cannot enable in-kind calculation: the only status is DISABLED', () => {
    for (const status of ['ENABLED', 'APPROVED', 'ENABLED_FOR_TEST']) {
      expectCode(() => run([included(1)], fixtureRule({ clauses: clausesAB, inKind: { status } })), C.RULE_DEFINITION_INVALID);
    }
  });
});

describe('the rule definition is explicit, complete, versioned and strict', () => {
  test('WAGE_DEFINITION_INCOMPLETE: every required part is demanded, with no defaults', () => {
    const base = fixtureRule({ clauses: clausesAB });
    for (const field of ['ruleId', 'version', 'threshold', 'clauses', 'inKind', 'secondProviso']) {
      const rule = { ...base }; delete rule[field];
      expectCode(() => validateRuleDefinition(rule), C.WAGE_DEFINITION_INCOMPLETE);
    }
    for (const field of ['denominator', 'pool', 'poolInterpretation', 'secondProvisoDependent', 'requiredFacts']) {
      const rule = fixtureRule({ clauses: clausesAB });
      delete rule.clauses[0][field];
      expectCode(() => validateRuleDefinition(rule), C.WAGE_DEFINITION_INCOMPLETE);
    }
    expectCode(() => validateRuleDefinition({ ...base, version: 0 }), C.WAGE_DEFINITION_INCOMPLETE);
    expectCode(() => validateRuleDefinition({ ...base, ruleId: '' }), C.WAGE_DEFINITION_INCOMPLETE);
  });

  test('RULE_DEFINITION_UNSUPPORTED_VERSION: an unknown schema is not guessed at', () => {
    expectCode(() => validateRuleDefinition({ ...fixtureRule({ clauses: clausesAB }), schema: 'PAYGUARD_STATUTORY_WAGE_RULE_V2' }), C.RULE_DEFINITION_UNSUPPORTED_VERSION);
    expectCode(() => validateRuleDefinition({ ...fixtureRule({ clauses: clausesAB }), schema: undefined }), C.RULE_DEFINITION_UNSUPPORTED_VERSION);
    assert.equal(RULE_SCHEMA, 'PAYGUARD_STATUTORY_WAGE_RULE_V1');
  });

  test('RULE_DEFINITION_INVALID: unknown fields, duplicate clauses, bad thresholds and non-canonical numbers', () => {
    const base = fixtureRule({ clauses: clausesAB });
    expectCode(() => validateRuleDefinition({ ...base, defaultToGross: true }), C.RULE_DEFINITION_INVALID);
    expectCode(() => validateRuleDefinition({ ...base, clauses: [{ ...base.clauses[0], extraField: 1 }] }), C.RULE_DEFINITION_INVALID);
    expectCode(() => validateRuleDefinition({ ...base, clauses: [base.clauses[0], base.clauses[0]] }), C.RULE_DEFINITION_INVALID);
    expectCode(() => validateRuleDefinition({ ...base, threshold: '3/2' }), C.RULE_DEFINITION_INVALID);
    expectCode(() => validateRuleDefinition({ ...base, threshold: '-1/2' }), C.RULE_DEFINITION_INVALID);
    expectCode(() => validateRuleDefinition({ ...base, threshold: '2/4' }), C.RATIONAL_NOT_CANONICAL);
    expectCode(() => validateRuleDefinition({ ...base, threshold: 0.5 }), C.RATIONAL_NOT_CANONICAL);
    expectCode(() => validateRuleDefinition({ ...base, secondProviso: { status: 'MAYBE' } }), C.RULE_DEFINITION_INVALID);
    expectCode(() => validateRuleDefinition(null), C.RULE_DEFINITION_INVALID);
    expectCode(() => validateRuleDefinition([]), C.RULE_DEFINITION_INVALID);
  });

  test('RULE_PROVENANCE_MISSING: a rule must say where it came from', () => {
    const base = fixtureRule({ clauses: clausesAB });
    expectCode(() => validateRuleDefinition({ ...base, provenance: undefined }), C.RULE_PROVENANCE_MISSING);
    expectCode(() => validateRuleDefinition({ ...base, provenance: { kind: 'MATHEMATICAL_FIXTURE' } }), C.RULE_PROVENANCE_MISSING);
    expectCode(() => validateRuleDefinition({ ...base, provenance: { kind: 'SOMEWHERE_ELSE' } }), C.RULE_PROVENANCE_MISSING);
    expectCode(() => validateRuleDefinition({ ...base, provenance: { kind: 'REGISTER_APPROVED' } }), C.RULE_PROVENANCE_MISSING);
    expectCode(() => validateRuleDefinition({ ...base, provenance: { kind: 'REGISTER_APPROVED', registerSnapshotHash: 'abc', mappingEntryHashes: ['abc'] } }), C.RULE_PROVENANCE_MISSING);
  });

  test('a fixture clause cannot pose as a real clause', () => {
    const rule = fixtureRule({ clauses: { A: { d: '1/1', p: '1/1' } } });
    expectCode(() => validateRuleDefinition(rule), C.RULE_DEFINITION_INVALID);
  });
});

describe('fixtures are never loadable for production; production authority is unavailable today', () => {
  const approvedProvenance = (approval) => ({ kind: 'REGISTER_APPROVED', registerSnapshotHash: 'a'.repeat(64), mappingEntryHashes: ['b'.repeat(64)], ...(approval ? { approval } : {}) });
  // A rule that is not labelled a fixture in any way: no FIXTURE_ clause, no fixture provenance.
  const nonFixtureRule = (approval) => ({ ...fixtureRule({ clauses: {}, ruleId: 'SYNTHETIC_NOT_A_REGISTER_RULE' }), provenance: approvedProvenance(approval) });
  const APPROVED_CLAIM = { interpretation: 'COMPLIANCE_APPROVED', enablement: 'ENABLED' };

  test('MATHEMATICAL_FIXTURE_NOT_ALLOWED: the production context rejects a fixture outright', () => {
    expectCode(() => assertRuleUsable(fixtureRule({ clauses: clausesAB }), PRODUCTION), C.MATHEMATICAL_FIXTURE_NOT_ALLOWED);
    expectCode(() => run([included(1)], fixtureRule({ clauses: clausesAB }), PRODUCTION), C.MATHEMATICAL_FIXTURE_NOT_ALLOWED);
  });

  test('RULE_NOT_APPROVED: a hashed register rule that does not even claim approval is rejected', () => {
    for (const approval of [undefined, {}, { interpretation: 'OPEN', enablement: 'ENABLED' }, { interpretation: 'COMPLIANCE_APPROVED', enablement: 'NOT_ENABLED' }, { interpretation: 'COMPLIANCE_APPROVED', enablement: 'BLOCKED' }]) {
      expectCode(() => assertRuleUsable(nonFixtureRule(approval), PRODUCTION), C.RULE_NOT_APPROVED);
    }
  });

  test('PRODUCTION_RULE_AUTHORITY_UNAVAILABLE: a caller-supplied approval is a claim, never proof: even a fully approved-looking rule fails', () => {
    // This replaces the earlier test that asserted such a rule WAS usable: that was the self-asserted gate.
    expectCode(() => assertRuleUsable(nonFixtureRule(APPROVED_CLAIM), PRODUCTION), C.PRODUCTION_RULE_AUTHORITY_UNAVAILABLE);
    expectCode(() => computeStatutoryWage({ rule: nonFixtureRule(APPROVED_CLAIM), lines: [included(500)] }, PRODUCTION), C.PRODUCTION_RULE_AUTHORITY_UNAVAILABLE);
    expectCode(() => computeStatutoryWage({ rule: nonFixtureRule(APPROVED_CLAIM), lines: [included(500)] }), C.PRODUCTION_RULE_AUTHORITY_UNAVAILABLE); // omitted context
  });
});

describe('inputs are integer paise, non-negative and uniquely identified', () => {
  test('INPUT_AMOUNT_NOT_INTEGER_PAISE: a float or string amount is refused, never rounded', () => {
    for (const amount of [100.5, 0.01, '100', NaN, null, undefined]) {
      expectCode(() => run([included(amount)]), C.INPUT_AMOUNT_NOT_INTEGER_PAISE);
    }
  });

  test('INPUT_AMOUNT_NEGATIVE', () => {
    expectCode(() => run([included(-1)]), C.INPUT_AMOUNT_NEGATIVE);
    expectCode(() => run([included(-1n)]), C.INPUT_AMOUNT_NEGATIVE);
  });

  test('INPUT_LINE_INVALID: duplicate ids, missing ids, a non-array', () => {
    expectCode(() => run([included(1, 'L1'), included(2, 'L1')]), C.INPUT_LINE_INVALID);
    expectCode(() => run([{ amountPaise: 1, classification: { status: 'UNCLASSIFIED' } }]), C.INPUT_LINE_INVALID);
    expectCode(() => run('not an array'), C.INPUT_LINE_INVALID);
  });

  test('zero lines is a valid, all-zero calculation; bigint and safe-integer amounts agree', () => {
    assert.equal(run([]).totals.wagePaise, '0/1');
    assert.equal(run([included(123456789)]).resultHash, run([included(123456789n)]).resultHash);
  });
});

describe('the contribution stage is separate and gated', () => {
  test('exactProduct is a pure exact product, not a contribution: it multiplies an exact wage by an exact rate and applies no rounding', () => {
    // 7,900.00 rupees = 790000 paise, x 3/400 (0.75%) = 5925 paise = 59.25 rupees exactly
    assert.equal(exactProduct({ wagePaise: '790000/1', rate: '3/400' }), '5925/1');
    assert.equal(exactProduct({ wagePaise: '790000/1', rate: '13/400' }), '25675/1');
    // a fractional-paise result stays fractional
    assert.equal(exactProduct({ wagePaise: '20001/2', rate: '3/400' }), '60003/800');
  });

  test('CONTRIBUTION_ROUNDING_UNAPPROVED: rounding never returns an amount, for any argument', () => {
    expectCode(() => roundContribution(), C.CONTRIBUTION_ROUNDING_UNAPPROVED);
    expectCode(() => roundContribution({ amountPaise: '5925/1' }, 'CEIL_RUPEE'), C.CONTRIBUTION_ROUNDING_UNAPPROVED);
    expectCode(() => roundContribution('60003/800', 'NEAREST_RUPEE'), C.CONTRIBUTION_ROUNDING_UNAPPROVED);
  });

  test('the engine result states that no contribution rounding was applied', () => {
    assert.equal(run([included(1)]).stages.contributionRounding, 'NOT_APPLIED_UNAPPROVED');
    assert.ok(!('contributionPaise' in run([included(1)]).totals), 'the wage result carries no contribution amount');
  });
});

describe('B1 — the context fails closed: an omitted context means PRODUCTION', () => {
  const fixture = () => fixtureRule({ clauses: clausesAB });
  const input = () => ({ rule: fixture(), lines: [included(10000)] });

  test('A: an explicit TEST context evaluates a valid mathematical fixture', () => {
    assert.equal(computeStatutoryWage(input(), { context: 'TEST' }).totals.wagePaise, '10000/1');
    assert.doesNotThrow(() => assertRuleUsable(fixture(), { context: 'TEST' }));
  });

  test('B: every way of omitting the context is PRODUCTION and never authorizes a fixture', () => {
    expectCode(() => computeStatutoryWage(input()), C.MATHEMATICAL_FIXTURE_NOT_ALLOWED);
    expectCode(() => assertRuleUsable(fixture()), C.MATHEMATICAL_FIXTURE_NOT_ALLOWED);
    for (const options of [undefined, {}, { context: undefined }, Object.create({ context: 'TEST' })]) {
      expectCode(() => computeStatutoryWage(input(), options), C.MATHEMATICAL_FIXTURE_NOT_ALLOWED);
      expectCode(() => assertRuleUsable(fixture(), options), C.MATHEMATICAL_FIXTURE_NOT_ALLOWED);
    }
  });

  test('B: a polluted Object.prototype cannot select TEST (only an own `context` option counts)', () => {
    Object.prototype.context = 'TEST'; // eslint-disable-line no-extend-native
    try {
      expectCode(() => computeStatutoryWage(input(), {}), C.MATHEMATICAL_FIXTURE_NOT_ALLOWED);
      expectCode(() => assertRuleUsable(fixture(), {}), C.MATHEMATICAL_FIXTURE_NOT_ALLOWED);
    } finally {
      delete Object.prototype.context;
    }
    assert.equal(Object.prototype.context, undefined);
  });

  test('C: an explicit PRODUCTION context rejects a mathematical fixture', () => {
    expectCode(() => computeStatutoryWage(input(), { context: 'PRODUCTION' }), C.MATHEMATICAL_FIXTURE_NOT_ALLOWED);
    expectCode(() => assertRuleUsable(fixture(), { context: 'PRODUCTION' }), C.MATHEMATICAL_FIXTURE_NOT_ALLOWED);
  });

  test('D: an unknown context, or malformed options, is a named validation error and is never coerced', () => {
    for (const context of ['STAGING', 'test', 'Test', 'production', 'PRODUCTION ', ' TEST', '', null, 0, false, true, {}, ['TEST'], 'ALL']) {
      expectCode(() => assertRuleUsable(fixture(), { context }), C.EXECUTION_CONTEXT_INVALID);
      expectCode(() => computeStatutoryWage(input(), { context }), C.EXECUTION_CONTEXT_INVALID);
    }
    for (const options of [null, 'TEST', 7, true, [], ['context'], { context: 'TEST', force: true }, { ctx: 'TEST' }]) {
      expectCode(() => assertRuleUsable(fixture(), options), C.EXECUTION_CONTEXT_INVALID);
      expectCode(() => computeStatutoryWage(input(), options), C.EXECUTION_CONTEXT_INVALID);
    }
  });

  test('E: neither the rule, the lines, the arguments nor the package index can select a context or skip the gate', async () => {
    expectCode(() => computeStatutoryWage({ ...input(), context: 'TEST' }, { context: 'TEST' }), C.RULE_DEFINITION_INVALID);
    expectCode(() => computeStatutoryWage({ rule: { ...fixture(), context: 'TEST' }, lines: [] }, { context: 'TEST' }), C.RULE_DEFINITION_INVALID);
    expectCode(() => computeStatutoryWage({ rule: { ...fixture(), context: 'TEST' }, lines: [] }), C.MATHEMATICAL_FIXTURE_NOT_ALLOWED);
    expectCode(() => run([{ ...included(1), context: 'TEST' }]), C.INPUT_LINE_INVALID);
    expectCode(() => computeStatutoryWage(undefined), C.RULE_DEFINITION_INVALID);
    expectCode(() => computeStatutoryWage(null, TEST), C.RULE_DEFINITION_INVALID);

    const index = await import('./src/statutoryWage/index.js');
    assert.equal(index.computeStatutoryWage, computeStatutoryWage);
    assert.equal(index.assertRuleUsable, assertRuleUsable);
    expectCode(() => index.computeStatutoryWage(input()), C.MATHEMATICAL_FIXTURE_NOT_ALLOWED);
    assert.deepEqual(Object.keys(index).filter((name) => /unsafe|unchecked|force|bypass|skip|noGate|override/i.test(name)), [], 'no export offers a way around the gates');
    // The structural validator evaluates nothing and authorizes nothing: it returns only the parsed definition.
    assert.deepEqual(Object.keys(validateRuleDefinition(fixture())).sort(), ['clauses', 'provenance', 'threshold']);
  });
});

describe('B5 — a caller-supplied approval, label or hash is never proof of legal authority', () => {
  const APPROVED_CLAIM = { interpretation: 'COMPLIANCE_APPROVED', enablement: 'ENABLED' };
  const provenanceOf = (over = {}) => ({ kind: 'REGISTER_APPROVED', registerSnapshotHash: 'a'.repeat(64), mappingEntryHashes: ['b'.repeat(64)], approval: APPROVED_CLAIM, ...over });
  const syntheticRule = (over = {}) => ({ ...fixtureRule({ clauses: {}, ruleId: 'SYNTHETIC_NOT_A_REGISTER_RULE' }), provenance: provenanceOf(), ...over });
  const inProduction = (rule) => computeStatutoryWage({ rule, lines: [included(500)] }, PRODUCTION);

  test('invented hashes with a self-written approval fail in PRODUCTION', () => {
    expectCode(() => inProduction(syntheticRule()), C.PRODUCTION_RULE_AUTHORITY_UNAVAILABLE);
    expectCode(() => assertRuleUsable(syntheticRule(), PRODUCTION), C.PRODUCTION_RULE_AUTHORITY_UNAVAILABLE);
  });

  test('forged approvals of every shape fail: extra approver fields, signatures, extra statuses', () => {
    for (const approval of [
      { ...APPROVED_CLAIM, approvedBy: 'Chief Compliance Officer', approvedOn: '2026-10-13' },
      { ...APPROVED_CLAIM, signature: 'a'.repeat(128), legalOpinionRef: 'LEGAL-2026-1' },
      { interpretation: 'COMPLIANCE_APPROVED', enablement: 'ENABLED', lifecycle: 'FINAL', evidence: 'SIGNATURE_VERIFIED' },
    ]) {
      expectCode(() => inProduction(syntheticRule({ provenance: provenanceOf({ approval }) })), C.PRODUCTION_RULE_AUTHORITY_UNAVAILABLE);
    }
    for (const approval of [undefined, {}, { interpretation: 'COMPLIANCE_APPROVED' }, { enablement: 'ENABLED' }]) {
      expectCode(() => inProduction(syntheticRule({ provenance: provenanceOf({ approval }) })), C.RULE_NOT_APPROVED);
    }
    // a claim that is not even an object is a malformed rule, not a claim
    for (const approval of [null, 'APPROVED', true, [], 7]) {
      expectCode(() => inProduction(syntheticRule({ provenance: provenanceOf({ approval }) })), C.RULE_DEFINITION_INVALID);
    }
  });

  test('a relabelled fixture fails: a fixture does not become real by changing its provenance label', () => {
    const relabelled = { ...fixtureRule({ clauses: clausesAB }), provenance: provenanceOf() }; // clauses are still FIXTURE_*
    expectCode(() => inProduction(relabelled), C.MATHEMATICAL_FIXTURE_NOT_ALLOWED);
    expectCode(() => inProduction({ ...fixtureRule({ clauses: clausesAB }), provenance: { ...provenanceOf(), fixtureId: 'FIXTURE_RULE@1' } }), C.MATHEMATICAL_FIXTURE_NOT_ALLOWED);
    expectCode(() => inProduction({ ...syntheticRule(), provenance: { kind: 'MATHEMATICAL_FIXTURE', fixtureId: 'X', approval: APPROVED_CLAIM } }), C.MATHEMATICAL_FIXTURE_NOT_ALLOWED);
  });

  test('correct-looking references still fail: genuine, self-consistent hashes prove byte identity, not approval', () => {
    const entry = {
      schema: MAPPING_ENTRY_SCHEMA, mappingId: 'SYNTHETIC_MAPPING', mappingVersion: 1, instrument: 'SYNTHETIC', provision: 'SYNTHETIC', exactText: 'synthetic text',
      sourceArtifactHashes: ['c'.repeat(64)], status: { evidence: 'PRIMARY_TEXT_VERIFIED', lifecycle: 'FINAL', interpretation: 'COMPLIANCE_APPROVED', enablement: 'ENABLED' },
    };
    const register = { metadata: { name: 'synthetic register' }, entries: [entry] };
    const snapshotHash = registerSnapshotHash(register);
    assert.ok(verifyRegisterSnapshot(register, snapshotHash), 'the hashes really are self-consistent');
    const rule = syntheticRule({ provenance: provenanceOf({ registerSnapshotHash: snapshotHash, mappingEntryHashes: [mappingEntryHash(entry)] }) });
    expectCode(() => inProduction(rule), C.PRODUCTION_RULE_AUTHORITY_UNAVAILABLE);
    // the rule even cites the hash of its own canonical content: still only a claim
    expectCode(() => inProduction(syntheticRule({ provenance: provenanceOf({ mappingEntryHashes: [hashCanonical(rule)] }) })), C.PRODUCTION_RULE_AUTHORITY_UNAVAILABLE);
  });

  test('mismatched content and stale references fail the same way: nothing is verified because nothing can be', () => {
    const cited = syntheticRule({ threshold: '1/2' });
    const mismatched = syntheticRule({ threshold: '1/3', provenance: provenanceOf({ mappingEntryHashes: [hashCanonical(cited)] }) });
    expectCode(() => inProduction(mismatched), C.PRODUCTION_RULE_AUTHORITY_UNAVAILABLE);
    expectCode(() => inProduction(syntheticRule({ version: 2 })), C.PRODUCTION_RULE_AUTHORITY_UNAVAILABLE); // a "newer" version citing a "stale" snapshot
    expectCode(() => inProduction(syntheticRule({ version: 1, provenance: provenanceOf({ registerSnapshotHash: '0'.repeat(64) }) })), C.PRODUCTION_RULE_AUTHORITY_UNAVAILABLE);
  });

  test('incomplete provenance is rejected as incomplete', () => {
    for (const provenance of [
      { kind: 'REGISTER_APPROVED', mappingEntryHashes: ['b'.repeat(64)], approval: APPROVED_CLAIM },
      { kind: 'REGISTER_APPROVED', registerSnapshotHash: 'a'.repeat(64), approval: APPROVED_CLAIM },
      provenanceOf({ mappingEntryHashes: [] }),
      provenanceOf({ registerSnapshotHash: 'A'.repeat(64) }),
      provenanceOf({ mappingEntryHashes: ['b'.repeat(63)] }),
      { approval: APPROVED_CLAIM },
    ]) {
      expectCode(() => inProduction(syntheticRule({ provenance })), C.RULE_PROVENANCE_MISSING);
    }
    expectCode(() => inProduction(syntheticRule({ provenance: provenanceOf({ extraClaim: true }) })), C.RULE_DEFINITION_INVALID);
  });

  test('no combination of the above ever returns a result in PRODUCTION', () => {
    const variants = [
      fixtureRule({ clauses: clausesAB }), syntheticRule(), syntheticRule({ version: 7 }), syntheticRule({ threshold: '1/1' }),
      syntheticRule({ provenance: provenanceOf({ approval: undefined }) }), { ...fixtureRule({ clauses: clausesAB }), provenance: provenanceOf() },
      syntheticRule({ provenance: provenanceOf({ approval: { ...APPROVED_CLAIM, extra: 1 } }) }), syntheticRule({ provenance: { kind: 'x' } }), {}, null, [],
    ];
    for (const rule of variants) {
      let result = null; let error = null;
      try { result = inProduction(rule); } catch (e) { error = e; }
      assert.equal(result, null, 'PRODUCTION must never return a wage today');
      assert.ok(error instanceof StatutoryWageError, String(error));
    }
  });

  test('explicit TEST-only mathematical evaluation is unaffected by the production gate', () => {
    assert.equal(run([included(10000), inClause('FIXTURE_A', 12000)]).totals.wagePaise, '11000/1');
  });
});

describe('B2 — in-kind states are strict: only an explicit false is "not in kind"', () => {
  const withInKind = (value) => ({ ...included(100), inKind: value });
  const omitted = () => { const line = included(100); delete line.inKind; return line; };

  test('true is in-kind remuneration and is blocked (included and clause lines alike)', () => {
    expectCode(() => run([withInKind(true)]), C.IN_KIND_RULE_UNRESOLVED);
    expectCode(() => run([{ ...inClause('FIXTURE_B', 100), inKind: true }]), C.IN_KIND_RULE_UNRESOLVED);
    expectCode(() => run([included(5, 'L0'), withInKind(true)]), C.IN_KIND_RULE_UNRESOLVED); // one in-kind line blocks the whole calculation
  });

  test('false is the one permitted not-in-kind form and is counted normally', () => {
    assert.equal(run([withInKind(false)]).totals.wagePaise, '100/1');
  });

  test('every other value is an UNKNOWN state: blocked, and never interpreted as false', () => {
    const malformed = ['true', 'false', 'TRUE', 'yes', 'no', 'in-kind', 'cash', '', ' ', 1, 0, -1, NaN, null, undefined, {}, [], [false], { value: false }, 1n];
    for (const value of malformed) {
      const error = expectCode(() => run([withInKind(value)]), C.IN_KIND_STATUS_INVALID);
      assert.match(error.message, /inKind/);
    }
    const missing = expectCode(() => run([omitted()]), C.IN_KIND_STATUS_INVALID);
    assert.equal(missing.details.received, 'omitted');
    assert.equal(expectCode(() => run([withInKind('false')]), C.IN_KIND_STATUS_INVALID).details.received, 'string');
  });

  test('a malformed line blocks the whole calculation even when other lines are fine', () => {
    expectCode(() => run([included(5, 'L0'), omitted()]), C.IN_KIND_STATUS_INVALID);
  });

  test('in-kind is not a classification or part attribute: such a key is rejected, not read', () => {
    expectCode(() => run([{ ...included(100), classification: { status: 'CLASSIFIED', inKind: false, parts: [{ target: 'INCLUDED', portion: '1/1' }] } }]), C.INPUT_LINE_INVALID);
    expectCode(() => run([{ ...included(100), classification: { status: 'CLASSIFIED', parts: [{ target: 'INCLUDED', portion: '1/1', inKind: false }] } }]), C.INPUT_LINE_INVALID);
  });

  test('no in-kind formula exists: a rule can never enable it, and the result carries no in-kind figure', () => {
    expectCode(() => run([included(1)], fixtureRule({ clauses: clausesAB, inKind: { status: 'ENABLED' } })), C.RULE_DEFINITION_INVALID);
    assert.ok(!JSON.stringify(run([included(1)])).toLowerCase().includes('inkindpaise'));
  });
});

describe('strict remuneration facts: typed, in range, declared, non-contradictory', () => {
  const spec = (name, type, extra = {}) => ({ name, type, ...extra });
  const rule = (specs, contradictions) => fixtureRule({ clauses: { FIXTURE_F: { d: '1/1', p: '1/1', extra: { requiredFacts: specs, ...(contradictions ? { factContradictions: contradictions } : {}) } } } });
  const factLine = (facts, lineId = 'L1') => inClause('FIXTURE_F', 100, lineId, { facts });
  const ok = (specs, facts, contradictions) => run([factLine(facts)], rule(specs, contradictions));
  const bad = (specs, facts, code = C.REMUNERATION_FACT_INVALID, contradictions) => expectCode(() => run([factLine(facts)], rule(specs, contradictions)), code);

  test('TEXT: non-empty, trimmed, never the explicit UNKNOWN marker', () => {
    const specs = [spec('note', 'TEXT')];
    assert.doesNotThrow(() => ok(specs, { note: 'paid under agreement 7' }));
    for (const note of ['', ' ', '   ', '\t\n', ' padded', 'padded ', 'UNKNOWN', 'unknown', 'Unknown', 'unknown ', 5, true, [], {}, ['x']]) bad(specs, { note });
  });

  test('TEXT_LIST: a non-empty list of valid, distinct text', () => {
    const specs = [spec('items', 'TEXT_LIST')];
    assert.doesNotThrow(() => ok(specs, { items: ['a'] }));
    for (const items of [[], ['a', 'a'], ['a', ''], ['a', ' '], ['a', 5], [null], [['a']], 'a', 5, {}, true, ['UNKNOWN']]) bad(specs, { items });
  });

  test('BOOLEAN: only real booleans; false is a value, strings and numbers are not', () => {
    const specs = [spec('flag', 'BOOLEAN')];
    assert.doesNotThrow(() => ok(specs, { flag: true }));
    assert.doesNotThrow(() => ok(specs, { flag: false }));
    for (const flag of ['true', 'false', 'yes', 'UNKNOWN', 1, 0, [], {}, [true], { status: 'UNKNOWN' }, NaN, '']) bad(specs, { flag });
  });

  test('INTEGER: safe integers within the stated range; zero is valid where the range permits it', () => {
    const permitsZero = [spec('count', 'INTEGER', { min: 0, max: 10 })];
    for (const count of [0, 1, 5, 10]) assert.doesNotThrow(() => ok(permitsZero, { count }));
    for (const count of [-1, 11, 0.5, 5.5, NaN, Infinity, -Infinity, '5', '0', true, [], {}, 2 ** 53, 1n]) bad(permitsZero, { count });
    const excludesZero = [spec('count', 'INTEGER', { min: 1, max: 3 })];
    bad(excludesZero, { count: 0 }); // zero is not universally accepted either
    assert.doesNotThrow(() => ok(excludesZero, { count: 1 }));
    assert.doesNotThrow(() => ok([spec('delta', 'INTEGER', { min: -5, max: 5 })], { delta: -5 }));
  });

  test('ENUM: one of the listed values, never UNKNOWN', () => {
    const specs = [spec('mode', 'ENUM', { values: ['MONTHLY', 'QUARTERLY'] })];
    assert.doesNotThrow(() => ok(specs, { mode: 'MONTHLY' }));
    for (const mode of ['monthly', 'ANNUAL', '', 'UNKNOWN', 5, true, [], {}, ['MONTHLY']]) bad(specs, { mode });
  });

  test('REMUNERATION_FACT_MISSING: absent, undefined and null are all missing (an inherited value is rejected outright: see the independent-review tests)', () => {
    const specs = [spec('flag', 'BOOLEAN')];
    for (const facts of [{}, { flag: undefined }, { flag: null }, undefined]) bad(specs, facts, C.REMUNERATION_FACT_MISSING);
  });

  test('REMUNERATION_FACT_UNDECLARED: a key no clause of the line declares is rejected, never ignored', () => {
    const specs = [spec('flag', 'BOOLEAN')];
    assert.equal(bad(specs, { flag: true, extra: 1 }, C.REMUNERATION_FACT_UNDECLARED).details.fact, 'extra');
    bad(specs, { flag: true, flagg: true }, C.REMUNERATION_FACT_UNDECLARED); // a misspelling
    // facts on a line with no clause part have nothing to describe
    expectCode(() => run([{ ...included(100), facts: { flag: true } }], rule(specs)), C.REMUNERATION_FACT_UNDECLARED);
    expectCode(() => run([{ ...inClause('FIXTURE_A', 100), facts: { anything: true } }]), C.REMUNERATION_FACT_UNDECLARED);
    for (const facts of [null, 'x', 5, true, [], ['flag']]) expectCode(() => run([factLine(facts)], rule(specs)), C.INPUT_LINE_INVALID);
  });

  test('REMUNERATION_FACT_CONTRADICTORY: a declared impossible combination blocks; other combinations do not', () => {
    const specs = [spec('paid', 'BOOLEAN'), spec('received', 'BOOLEAN'), spec('mode', 'ENUM', { values: ['A', 'B'] })];
    const contradictions = [{ paid: false, received: true }, { paid: true, mode: 'B', received: false }];
    assert.doesNotThrow(() => ok(specs, { paid: true, received: true, mode: 'A' }, contradictions));
    assert.doesNotThrow(() => ok(specs, { paid: false, received: false, mode: 'A' }, contradictions));
    bad(specs, { paid: false, received: true, mode: 'A' }, C.REMUNERATION_FACT_CONTRADICTORY, contradictions);
    bad(specs, { paid: true, received: false, mode: 'B' }, C.REMUNERATION_FACT_CONTRADICTORY, contradictions);
    // a contradiction must refer to declared facts and to valid values, and name at least two
    for (const broken of [[{ paid: true }], [{ paid: true, ghost: true }], [{ paid: 'yes', received: true }], [{ mode: 'C', paid: true }], ['paid'], 'paid']) {
      expectCode(() => validateRuleDefinition(rule(specs, broken)), C.RULE_DEFINITION_INVALID);
    }
  });

  test('a typed spec is required: a bare name, an unknown type, extra keys, missing bounds or UNKNOWN as a value are rejected', () => {
    for (const requiredFacts of [
      ['employerPaid'], [{ name: 'x' }], [{ name: 'x', type: 'DATE' }], [{ name: 'x', type: 'BOOLEAN', min: 0 }], [{ type: 'BOOLEAN' }], [{ name: '', type: 'BOOLEAN' }], [{ name: ' x', type: 'BOOLEAN' }],
      [spec('x', 'BOOLEAN'), spec('x', 'TEXT')],
      [{ name: 'n', type: 'INTEGER' }], [spec('n', 'INTEGER', { min: 5, max: 1 })], [spec('n', 'INTEGER', { min: 0.5, max: 1 })], [spec('n', 'INTEGER', { min: 0, max: Infinity })],
      [{ name: 'm', type: 'ENUM' }], [spec('m', 'ENUM', { values: [] })], [spec('m', 'ENUM', { values: ['A', 'A'] })], [spec('m', 'ENUM', { values: ['A', 'unknown'] })], [spec('m', 'ENUM', { values: ['A', ' B'] })],
    ]) {
      expectCode(() => validateRuleDefinition(rule(requiredFacts)), C.RULE_DEFINITION_INVALID);
    }
    expectCode(() => validateRuleDefinition(rule('flag')), C.WAGE_DEFINITION_INCOMPLETE);
  });

  test('the facts recorded in a result are copies: changing the caller list afterwards cannot change the result', () => {
    const items = ['a', 'b'];
    const result = ok([spec('items', 'TEXT_LIST')], { items });
    const before = JSON.stringify(result);
    items.push('c');
    assert.equal(JSON.stringify(result), before);
  });

  test('the validated facts are part of the input digest: a different fact is a different calculation', () => {
    const specs = [spec('flag', 'BOOLEAN')];
    const a = ok(specs, { flag: true });
    const b = ok(specs, { flag: false });
    assert.deepEqual(a.lines[0].facts, { flag: true });
    assert.notEqual(a.inputDigest, b.inputDigest);
    assert.notEqual(a.resultHash, b.resultHash);
    assert.equal(a.totals.wagePaise, b.totals.wagePaise, 'the facts gate the calculation; they do not change the arithmetic');
  });
});

describe('strict input objects: unrecognized fields are rejected, never silently ignored', () => {
  test('a line carrying `gross: 999999` is rejected and never triggers a gross fallback', () => {
    for (const extra of [{ gross: 999999 }, { nature: 'BONUS' }, { component: 'BASIC' }, { bonus: 1 }, { amount: 5 }, { amountRupees: 5 }, { inkind: false }, { fallback: 'GROSS' }]) {
      const error = expectCode(() => run([{ ...included(100), ...extra }]), C.INPUT_LINE_INVALID);
      assert.equal(error.details.field, Object.keys(extra)[0]);
    }
    // an unclassified line with a gross key is blocked as unclassified, and its gross is never used as wage
    expectCode(() => run([{ lineId: 'L1', amountPaise: 100, inKind: false, gross: 999999, classification: { status: 'UNCLASSIFIED' } }]), C.STATUTORY_NATURE_MISSING);
    let result = null;
    try { result = run([{ ...included(100), gross: 999999 }]); } catch { /* expected */ }
    assert.equal(result, null, 'no result exists to carry a gross-based wage');
  });

  test('classifications, parts and arguments are strict too', () => {
    expectCode(() => run([{ ...included(1), classification: { status: 'CLASSIFIED', parts: [{ target: 'INCLUDED', portion: '1/1' }], default: 'INCLUDED' } }]), C.INPUT_LINE_INVALID);
    expectCode(() => run([{ ...included(1), classification: { status: 'UNCLASSIFIED', default: 'INCLUDED' } }]), C.INPUT_LINE_INVALID);
    expectCode(() => run([{ ...included(1), classification: { status: 'MATCHED', matchedClauses: ['FIXTURE_A'], parts: [] } }]), C.INPUT_LINE_INVALID);
    expectCode(() => run([{ ...included(1), classification: { status: 'AMBIGUOUS', candidates: [], pick: 'FIXTURE_A' } }]), C.INPUT_LINE_INVALID);
    expectCode(() => run([{ ...included(1), classification: { status: 'CLASSIFIED', parts: [{ target: 'INCLUDED', portion: '1/1', note: 'x' }] } }]), C.INPUT_LINE_INVALID);
    expectCode(() => run([{ ...included(1), classification: { status: 'CLASSIFIED', parts: [{ target: 'INCLUDED', clauseId: 'FIXTURE_A', portion: '1/1' }] } }]), C.INPUT_LINE_INVALID);
    expectCode(() => run([{ ...included(1), classification: { status: 'CLASSIFIED', parts: [{ target: 'CLAUSE', portion: '1/1' }] } }]), C.MAPPING_PARTITION_INVALID);
    expectCode(() => run([{ ...included(1), classification: { status: 'MATCHED', matchedClauses: [5] } }]), C.INPUT_LINE_INVALID);
    expectCode(() => computeStatutoryWage({ rule: fixtureRule({ clauses: clausesAB }), lines: [], extra: 1 }, TEST), C.RULE_DEFINITION_INVALID);
    // statuses that are inherited property names are unknown statuses, not crashes
    for (const status of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) expectCode(() => run([{ ...included(1), classification: { status } }]), C.CLASSIFICATION_AMBIGUOUS);
  });

  test('rule definitions, provenance and clauses reject unsupported fields', () => {
    const base = fixtureRule({ clauses: clausesAB });
    expectCode(() => validateRuleDefinition({ ...base, provenance: { ...base.provenance, note: 'x' } }), C.RULE_DEFINITION_INVALID);
    expectCode(() => validateRuleDefinition({ ...base, defaultThreshold: '1/2' }), C.RULE_DEFINITION_INVALID);
    expectCode(() => validateRuleDefinition({ ...base, clauses: [{ ...base.clauses[0], gross: true }] }), C.RULE_DEFINITION_INVALID);
  });

  test('W4: a rule that cannot be canonicalized or a missing argument is a named error, not a raw TypeError', () => {
    // an undefined-valued key inside a free-form claim cannot be canonicalized: a named error, not a raw TypeError
    const withUndefined = { ...fixtureRule({ clauses: {}, ruleId: 'SYNTHETIC_RULE' }), provenance: { kind: 'REGISTER_APPROVED', registerSnapshotHash: 'a'.repeat(64), mappingEntryHashes: ['b'.repeat(64)], approval: { note: undefined } } };
    expectCode(() => run([included(1)], withUndefined), C.RULE_DEFINITION_INVALID);
    expectCode(() => run([included(1)], { ...fixtureRule({ clauses: clausesAB }), secondProviso: { status: 'UNRESOLVED', note: undefined } }), C.RULE_DEFINITION_INVALID);
    expectCode(() => computeStatutoryWage(), C.RULE_DEFINITION_INVALID);
    expectCode(() => computeStatutoryWage({ lines: [] }, TEST), C.RULE_DEFINITION_INVALID);
  });
});

describe('X16 — portions are validated one by one, with their own named code', () => {
  const partsOf = (...parts) => [{ lineId: 'L1', amountPaise: 100, inKind: false, classification: { status: 'CLASSIFIED', parts } }];
  const whole = (portion) => partsOf({ target: 'CLAUSE', clauseId: 'FIXTURE_A', portion });

  test('a portion above one is MAPPING_PARTITION_INVALID, alone or inside a sum that equals one', () => {
    for (const portion of ['3/2', '2/1', '101/100', '1000000/1']) {
      const error = expectCode(() => run(whole(portion)), C.MAPPING_PARTITION_INVALID);
      assert.equal(error.details.portion, portion);
    }
    expectCode(() => run(partsOf({ target: 'INCLUDED', portion: '3/2' }, { target: 'CLAUSE', clauseId: 'FIXTURE_A', portion: '-1/2' })), C.MAPPING_PARTITION_INVALID);
    expectCode(() => run(partsOf({ target: 'INCLUDED', portion: '2/1' }, { target: 'CLAUSE', clauseId: 'FIXTURE_A', portion: '-1/1' })), C.MAPPING_PARTITION_INVALID);
  });

  test('negative and zero portions are MAPPING_PARTITION_INVALID; exactly one is accepted', () => {
    for (const portion of ['-1/2', '-1/1', '0/1']) expectCode(() => run(whole(portion)), C.MAPPING_PARTITION_INVALID);
    assert.equal(run(whole('1/1')).totals.poolPaise, '100/1');
  });

  test('a negative portion cannot be used to offset a double count: parts that sum to exactly one are still rejected', () => {
    // 1 + 1 - 1 = 1 and every positive portion is <= 1, so only the per-portion check can stop this.
    const offsetting = [{ lineId: 'L1', amountPaise: 100, inKind: false, classification: { status: 'CLASSIFIED', parts: [
      { target: 'INCLUDED', portion: '1/1' }, { target: 'CLAUSE', clauseId: 'FIXTURE_A', portion: '1/1' }, { target: 'CLAUSE', clauseId: 'FIXTURE_B', portion: '-1/1' }] } }];
    expectCode(() => run(offsetting), C.MAPPING_PARTITION_INVALID);
    const halves = [{ lineId: 'L1', amountPaise: 100, inKind: false, classification: { status: 'CLASSIFIED', parts: [
      { target: 'INCLUDED', portion: '1/1' }, { target: 'CLAUSE', clauseId: 'FIXTURE_A', portion: '1/2' }, { target: 'CLAUSE', clauseId: 'FIXTURE_B', portion: '-1/2' }] } }];
    expectCode(() => run(halves), C.MAPPING_PARTITION_INVALID);
  });

  test('invalid numeric representations are RATIONAL_NOT_CANONICAL (never coerced into a number)', () => {
    for (const portion of ['1.5', '0.5', '', '1/0', '2/4', '+1/2', ' 1/2', '1/-2', 'abc', '01/2', '1e0', 1.5, 1, 0.5, null, undefined, true, {}, [], 2n]) {
      expectCode(() => run(whole(portion)), C.RATIONAL_NOT_CANONICAL);
    }
  });

  test('portions that overlap or leave a gap keep their own distinct codes', () => {
    expectCode(() => run(partsOf({ target: 'INCLUDED', portion: '3/4' }, { target: 'CLAUSE', clauseId: 'FIXTURE_A', portion: '1/2' })), C.STATUTORY_CLASSIFICATION_OVERLAP);
    expectCode(() => run(partsOf({ target: 'INCLUDED', portion: '1/4' }, { target: 'CLAUSE', clauseId: 'FIXTURE_A', portion: '1/2' })), C.MAPPING_PARTITION_INVALID);
  });
});

describe('X09 — what each hash identifies, and what changes it', () => {
  const reverseKeys = (value) => (Array.isArray(value) ? value.map(reverseKeys)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseKeys(v)])) : value);
  const rule = (over = {}) => fixtureRule({ clauses: { FIXTURE_A: { d: '1/1', p: '1/1' }, FIXTURE_B: { d: '1/1', p: '0/1' } }, ...over });
  const lines = () => [included(10000, 'L1'), inClause('FIXTURE_A', 12000, 'L2')];
  const base = () => run(lines(), rule());

  test('resultHash is the hash of the complete result body, ruleHash of the rule mapping, inputDigest of the classified input', () => {
    const result = base();
    const { resultHash, ...body } = result;
    assert.equal(hashCanonical(body), resultHash, 'resultHash covers everything else in the result');
    assert.equal(hashCanonical({ lines: result.lines }), result.inputDigest);
    assert.equal(result.rule.ruleHash, hashCanonical(rule()), 'for a rule already in canonical order, ruleHash is the canonical hash of the definition');
    assert.equal(new Set([result.rule.ruleHash, result.inputDigest, result.resultHash]).size, 3, 'three different hashes of three different things');
  });

  test('changing calculation-relevant rule content changes ruleHash and resultHash, with identical input lines', () => {
    const before = base();
    const changes = {
      threshold: rule({ threshold: '1/3' }),
      version: rule({ version: 2 }),
      ruleId: rule({ ruleId: 'FIXTURE_RULE_OTHER' }),
      secondProviso: rule({ secondProviso: { status: 'DECIDED', decisionRef: 'FIXTURE_DECISION' } }),
      clauseDenominator: rule({ clauses: { FIXTURE_A: { d: '1/1', p: '1/1' }, FIXTURE_B: { d: '1/2', p: '0/1' } } }),
      clausePool: rule({ clauses: { FIXTURE_A: { d: '1/1', p: '1/2' }, FIXTURE_B: { d: '1/1', p: '0/1' } } }),
      poolInterpretation: rule({ clauses: { FIXTURE_A: { d: '1/1', p: '1/1' }, FIXTURE_B: { d: '1/1', p: '0/1', extra: { poolInterpretation: 'UNRESOLVED' } } } }),
      secondProvisoDependent: rule({ clauses: { FIXTURE_A: { d: '1/1', p: '1/1' }, FIXTURE_B: { d: '1/1', p: '0/1', extra: { secondProvisoDependent: true } } } }),
      requiredFacts: rule({ clauses: { FIXTURE_A: { d: '1/1', p: '1/1' }, FIXTURE_B: { d: '1/1', p: '0/1', extra: { requiredFacts: [{ name: 'f', type: 'BOOLEAN' }] } } } }),
    };
    for (const [name, changed] of Object.entries(changes)) {
      const after = run(lines(), changed);
      assert.notEqual(after.rule.ruleHash, before.rule.ruleHash, `${name}: ruleHash`);
      assert.notEqual(after.resultHash, before.resultHash, `${name}: resultHash`);
      assert.equal(after.inputDigest, before.inputDigest, `${name}: the input digest does not depend on the rule`);
    }
  });

  test('a clause treatment change that does not move any total still changes the hashes (the hash tracks the rule, not just the numbers)', () => {
    const before = run([included(10000)], rule());
    const after = run([included(10000)], rule({ clauses: { FIXTURE_A: { d: '1/2', p: '1/4' }, FIXTURE_B: { d: '1/1', p: '0/1' } } }));
    assert.deepEqual(after.totals, before.totals, 'no line touches the changed clause');
    assert.notEqual(after.resultHash, before.resultHash);
    assert.notEqual(after.rule.ruleHash, before.rule.ruleHash);
  });

  test('changing only the input changes inputDigest and resultHash but not ruleHash', () => {
    const before = base();
    const after = run([included(10001, 'L1'), inClause('FIXTURE_A', 12000, 'L2')], rule());
    assert.equal(after.rule.ruleHash, before.rule.ruleHash);
    assert.notEqual(after.inputDigest, before.inputDigest);
    assert.notEqual(after.resultHash, before.resultHash);
    // moving money between clauses with the same total is a different classification, hence a different hash
    const moved = run([included(10000, 'L1'), inClause('FIXTURE_B', 12000, 'L2')], rule());
    assert.notEqual(moved.inputDigest, before.inputDigest);
  });

  test('object property order never changes any hash (rule, lines or result)', () => {
    const before = base();
    const reordered = run(reverseKeys(lines()), reverseKeys(rule()));
    assert.equal(reordered.rule.ruleHash, before.rule.ruleHash);
    assert.equal(reordered.inputDigest, before.inputDigest);
    assert.equal(reordered.resultHash, before.resultHash);
    assert.deepEqual(reordered, before);
  });

  test('array order that carries no meaning never changes a hash: line order, clause order, fact spec order, enum value order', () => {
    const before = base();
    assert.equal(run([...lines()].reverse(), rule()).resultHash, before.resultHash);
    const swapped = rule(); swapped.clauses.reverse();
    assert.equal(run(lines(), swapped).resultHash, before.resultHash);
    const facted = (specs) => fixtureRule({ clauses: { FIXTURE_A: { d: '1/1', p: '1/1', extra: { requiredFacts: specs } } } });
    const specs = [{ name: 'a', type: 'BOOLEAN' }, { name: 'm', type: 'ENUM', values: ['X', 'Y'] }];
    const reorderedSpecs = [{ name: 'm', type: 'ENUM', values: ['Y', 'X'] }, { name: 'a', type: 'BOOLEAN' }];
    const factLines = [inClause('FIXTURE_A', 100, 'L1', { facts: { a: true, m: 'X' } })];
    assert.equal(run(factLines, facted(specs)).resultHash, run(factLines, facted(reorderedSpecs)).resultHash);
  });

  test('identical canonical inputs and rule produce identical hashes, run after run, with bigint or number amounts', () => {
    const first = base();
    for (let i = 0; i < 3; i++) assert.deepEqual(base(), first);
    assert.equal(run([included(10000n, 'L1'), inClause('FIXTURE_A', 12000n, 'L2')], rule()).resultHash, first.resultHash);
  });
});

describe('independent-review findings: invisible text, inherited properties, sparse arrays, shapes and hashes', () => {
  const spec = (name, type, extra = {}) => ({ name, type, ...extra });
  const factRule = (specs, contradictions) => fixtureRule({ clauses: { FIXTURE_F: { d: '1/1', p: '1/1', extra: { requiredFacts: specs, ...(contradictions ? { factContradictions: contradictions } : {}) } } } });
  const factLine = (facts) => inClause('FIXTURE_F', 100, 'L1', { facts });

  test('TEXT and TEXT_LIST: zero-width, invisible, control and full-width UNKNOWN spellings are not content', () => {
    const invisible = ['​', 'UNKNOWN​', 'ＵＮＫＮＯＷＮ', ' ', '⁠', 'ㅤ', '⠀', 'ᅟ', 'a\u0000b', 'a​b', 'a b', '﻿note', ' '];
    for (const note of invisible) {
      expectCode(() => run([factLine({ note })], factRule([spec('note', 'TEXT')])), C.REMUNERATION_FACT_INVALID);
      expectCode(() => run([factLine({ items: ['ok', note] })], factRule([spec('items', 'TEXT_LIST')])), C.REMUNERATION_FACT_INVALID);
    }
    // ordinary internal spaces are fine
    assert.equal(run([factLine({ note: 'paid under agreement 7' })], factRule([spec('note', 'TEXT')])).totals.wagePaise, '50/1'); // 100 in the pool, half of it under the 1/2 threshold
    // and an ENUM may not list an invisible or full-width UNKNOWN value
    expectCode(() => validateRuleDefinition(factRule([spec('m', 'ENUM', { values: ['A', 'ＵＮＫＮＯＷＮ'] })])), C.RULE_DEFINITION_INVALID);
  });

  test('default-ignorable, unassigned, private-use and lone-surrogate characters are not content either', () => {
    const hidden = ['͏', '឴', '᠋', '️', '︀', '\u{e0001}', '\u{e0020}', '⁥', '', '\ud800', '\u{10ffff}', 'a️', '\u{1f3fb}\u{e0067}'];
    for (const note of hidden) {
      expectCode(() => run([factLine({ note })], factRule([spec('note', 'TEXT')])), C.REMUNERATION_FACT_INVALID);
    }
    // names and enum values may not hide either, and NFC/NFD twins are the same list item
    expectCode(() => validateRuleDefinition(factRule([spec('na​me', 'TEXT')])), C.RULE_DEFINITION_INVALID);
    expectCode(() => validateRuleDefinition(factRule([spec('m', 'ENUM', { values: ['A', 'B️'] })])), C.RULE_DEFINITION_INVALID);
    expectCode(() => run([factLine({ items: ['Café', 'Café'] })], factRule([spec('items', 'TEXT_LIST')])), C.REMUNERATION_FACT_INVALID);
    assert.doesNotThrow(() => run([factLine({ note: 'Café – paid' })], factRule([spec('note', 'TEXT')])));
  });

  test('a declared contradiction that involves a list of text fires, by value', () => {
    const specs = [spec('l', 'TEXT_LIST'), spec('b', 'BOOLEAN')];
    const rule = factRule(specs, [{ l: ['x'], b: true }]);
    expectCode(() => run([factLine({ l: ['x'], b: true })], rule), C.REMUNERATION_FACT_CONTRADICTORY);
    assert.doesNotThrow(() => run([factLine({ l: ['x'], b: false })], rule));
    assert.doesNotThrow(() => run([factLine({ l: ['x', 'y'], b: true })], rule));
  });

  test('nothing is read from an inherited property: caller-built prototypes are rejected, and a polluted prototype cannot supply inKind', () => {
    expectCode(() => run([Object.create({ ...included(1000) })]), C.INPUT_LINE_INVALID);
    expectCode(() => computeStatutoryWage({ rule: Object.create({ ...fixtureRule({ clauses: clausesAB }) }), lines: [] }, TEST), C.RULE_DEFINITION_INVALID);
    expectCode(() => run([included(1)], fixtureRule({ clauses: clausesAB, inKind: Object.create({ status: 'DISABLED' }) })), C.WAGE_DEFINITION_INCOMPLETE);
    expectCode(() => run([factLine(Object.create({ flag: true }))], factRule([spec('flag', 'BOOLEAN')])), C.INPUT_LINE_INVALID);
    const omitted = included(100); delete omitted.inKind;
    const rule = fixtureRule({ clauses: clausesAB }); // built before the pollution: the fixture builder itself reads default parameters
    Object.prototype.inKind = false; // eslint-disable-line no-extend-native
    try {
      expectCode(() => run([omitted], rule), C.IN_KIND_STATUS_INVALID);
    } finally {
      delete Object.prototype.inKind;
    }
    // null-prototype data objects are plain data and work
    const bare = Object.assign(Object.create(null), included(100));
    assert.equal(run([bare]).totals.wagePaise, '100/1');
  });

  test('a polluted Object.prototype cannot supply a fact: only an own property is a supplied fact', () => {
    const specs = [spec('flag', 'BOOLEAN')];
    const rule = factRule(specs);
    const lines = [factLine({})];
    Object.prototype.flag = true; // eslint-disable-line no-extend-native
    try {
      expectCode(() => run(lines, rule), C.REMUNERATION_FACT_MISSING);
    } finally {
      delete Object.prototype.flag;
    }
  });

  test('rule.inKind, rule.secondProviso and provenance.approval are strict shapes', () => {
    expectCode(() => run([included(1)], fixtureRule({ clauses: clausesAB, inKind: { status: 'DISABLED', enabled: true, valuation: 'MARKET' } })), C.RULE_DEFINITION_INVALID);
    expectCode(() => run([included(1)], fixtureRule({ clauses: clausesAB, secondProviso: { status: 'UNRESOLVED', approved: true } })), C.RULE_DEFINITION_INVALID);
    expectCode(() => run([included(1)], fixtureRule({ clauses: clausesAB, secondProviso: { status: 'UNRESOLVED', decisionRef: 'FIXTURE_D' } })), C.RULE_DEFINITION_INVALID);
    expectCode(() => run([included(1)], fixtureRule({ clauses: clausesAB, secondProviso: { status: 'DECIDED', decisionRef: '' } })), C.WAGE_DEFINITION_INCOMPLETE);
    const approved = (approval) => ({ ...fixtureRule({ clauses: {}, ruleId: 'SYNTHETIC_RULE' }), provenance: { kind: 'REGISTER_APPROVED', registerSnapshotHash: 'a'.repeat(64), mappingEntryHashes: ['b'.repeat(64)], approval } });
    for (const approval of ['lol', true, 7, null, []]) expectCode(() => validateRuleDefinition(approved(approval)), C.RULE_DEFINITION_INVALID);
    assert.doesNotThrow(() => validateRuleDefinition(approved({ anything: 'is only a claim' })));
  });

  test('sparse arrays (holes) are rejected wherever an array is required', () => {
    const hole = (...items) => { const a = new Array(items.length + 1); items.forEach((v, i) => { a[i] = v; }); return a; };
    expectCode(() => validateRuleDefinition({ ...fixtureRule({ clauses: clausesAB }), clauses: hole(fixtureRule({ clauses: clausesAB }).clauses[0]) }), C.WAGE_DEFINITION_INCOMPLETE);
    expectCode(() => validateRuleDefinition(factRule([spec('m', 'ENUM', { values: hole('A') })])), C.RULE_DEFINITION_INVALID);
    expectCode(() => validateRuleDefinition(factRule(hole(spec('x', 'BOOLEAN')))), C.WAGE_DEFINITION_INCOMPLETE);
    expectCode(() => run(hole(included(1))), C.INPUT_LINE_INVALID);
    expectCode(() => run([{ ...included(1), classification: { status: 'CLASSIFIED', parts: hole({ target: 'INCLUDED', portion: '1/1' }) } }]), C.MAPPING_PARTITION_INVALID);
    expectCode(() => validateRuleDefinition({ ...fixtureRule({ clauses: {}, ruleId: 'SYNTHETIC_RULE' }), provenance: { kind: 'REGISTER_APPROVED', registerSnapshotHash: 'a'.repeat(64), mappingEntryHashes: hole('b'.repeat(64)) } }), C.RULE_PROVENANCE_MISSING);
    expectCode(() => run([factLine({ items: hole('a') })], factRule([spec('items', 'TEXT_LIST')])), C.REMUNERATION_FACT_INVALID);
  });

  test('in-kind remuneration blocks before anything else about the line is judged', () => {
    expectCode(() => run([{ lineId: 'L1', amountPaise: 100, inKind: true, classification: { status: 'UNCLASSIFIED' } }]), C.IN_KIND_RULE_UNRESOLVED);
    expectCode(() => run([{ lineId: 'L1', amountPaise: -1, inKind: true, classification: { status: 'AMBIGUOUS' } }]), C.IN_KIND_RULE_UNRESOLVED);
  });

  test('INPUT_MALFORMED: an input that would crash raw code is a named, fail-closed error, never a bare TypeError', () => {
    const bare = Object.create(null);
    expectCode(() => run([{ ...included(1), lineId: bare }, included(2, 'L2')]), C.INPUT_MALFORMED);
    const circular = {}; circular.self = circular;
    const rule = { ...fixtureRule({ clauses: {}, ruleId: 'SYNTHETIC_RULE' }), provenance: { kind: 'REGISTER_APPROVED', registerSnapshotHash: 'a'.repeat(64), mappingEntryHashes: ['b'.repeat(64)], approval: circular } };
    expectCode(() => run([included(1)], rule), C.INPUT_MALFORMED);
  });

  test('hash identity is semantic: an empty contradiction list equals none, an empty facts object equals none', () => {
    const none = fixtureRule({ clauses: { FIXTURE_A: { d: '1/1', p: '1/1' } } });
    const empty = fixtureRule({ clauses: { FIXTURE_A: { d: '1/1', p: '1/1', extra: { factContradictions: [] } } } });
    assert.equal(run([included(5)], none).rule.ruleHash, run([included(5)], empty).rule.ruleHash);
    const withEmptyFacts = run([{ ...included(5), facts: {} }]);
    assert.equal(withEmptyFacts.inputDigest, run([included(5)]).inputDigest);
  });

  test('the result states the context it was evaluated in (a TEST result is never mistaken for a trusted one)', () => {
    assert.equal(run([included(1)]).evaluationContext, 'TEST');
    assert.equal(run([included(1)]).resultHash, hashCanonical((({ resultHash, ...body }) => body)(run([included(1)]))));
  });

  test('canonical JSON refuses anything that is not plain data (Date, Map, Set, typed arrays, class instances)', () => {
    for (const value of [new Date(0), new Map([[1, 2]]), new Set([1]), new Uint8Array([1, 2]), { a: new Date(0) }, [new Map()], new (class X { constructor() { this.a = 1; } })()]) {
      assert.throws(() => canonicalJson(value), TypeError);
    }
    assert.equal(canonicalJson(Object.assign(Object.create(null), { b: 1, a: 2 })), '{"a":2,"b":1}');
  });
});

describe('final hardening 1 — exactProduct is a pure product, not a contribution', () => {
  test('there is no exactContribution, and the only contribution function is the gated rounding stage', async () => {
    const index = await import('./src/statutoryWage/index.js');
    assert.equal(index.exactContribution, undefined);
    assert.deepEqual(Object.keys(index).filter((name) => /contribution/i.test(name)), ['roundContribution']);
    for (const args of [[], [{ wagePaise: '790000/1', rate: '3/400' }], ['5925/1', 'CEIL_RUPEE']]) expectCode(() => index.roundContribution(...args), C.CONTRIBUTION_ROUNDING_UNAPPROVED);
    assert.equal(typeof index.exactProduct, 'function');
  });

  test('exactProduct validates its input and stays exact: no rounding, no negative wage, rate within [0, 1], no extra keys', () => {
    assert.equal(exactProduct({ wagePaise: '790000/1', rate: '3/400' }), '5925/1');
    assert.equal(exactProduct({ wagePaise: '0/1', rate: '1/1' }), '0/1');
    assert.equal(exactProduct({ wagePaise: '5/3', rate: '1/1' }), '5/3');
    expectCode(() => exactProduct({ wagePaise: '-1/1', rate: '1/2' }), C.INPUT_AMOUNT_NEGATIVE);
    for (const rate of ['-1/2', '3/2', '2/1']) expectCode(() => exactProduct({ wagePaise: '1/1', rate }), C.RULE_DEFINITION_INVALID);
    for (const bad of [{ wagePaise: '1/1', rate: '1/2', extra: 1 }, { wagePaise: '1/1', rate: '1/2', context: 'TEST' }]) expectCode(() => exactProduct(bad), C.INPUT_MALFORMED);
    for (const bad of [undefined, null, 'x', 5, [], new Map()]) expectCode(() => exactProduct(bad), C.INPUT_MALFORMED);
    for (const bad of [{ wagePaise: 100, rate: '1/2' }, { wagePaise: '100', rate: '1/2' }, { wagePaise: '2/4', rate: '1/2' }, { rate: '1/2' }, { wagePaise: '1/1' }]) expectCode(() => exactProduct(bad), C.RATIONAL_NOT_CANONICAL);
  });

  test('the wage result never carries a contribution figure or a rounded amount', () => {
    const text = JSON.stringify(run([included(10000), inClause('FIXTURE_A', 12000)])).toLowerCase();
    for (const word of ['contributionpaise', 'employeecontribution', 'employercontribution', 'esi']) assert.ok(!text.includes(word), word);
  });
});

describe('final hardening 4 — provenance in a result is derived from the verification state, never echoed from a claim', () => {
  const MARKER = 'XYZ-CALLER-CLAIM-MARKER';
  const claimed = (over = {}) => ({
    ...fixtureRule({ clauses: {}, ruleId: 'SYNTHETIC_RULE' }),
    provenance: { kind: 'REGISTER_APPROVED', registerSnapshotHash: 'a'.repeat(64), mappingEntryHashes: ['b'.repeat(64)], approval: { interpretation: 'COMPLIANCE_APPROVED', enablement: 'ENABLED', note: MARKER } },
    ...over,
  });

  test('a fixture reports explicit untrusted, test-only provenance and is never legally approved', () => {
    const result = run([included(1)]);
    assert.deepEqual(result.rule.provenance, { source: 'MATHEMATICAL_FIXTURE', verification: 'UNVERIFIED_TEST_ONLY', legalStatus: 'NOT_LEGALLY_APPROVED' });
    assert.equal(result.rule.provenanceKind, undefined, 'the claimed kind is not echoed');
    assert.equal(result.evaluationContext, 'TEST');
  });

  test('a rule that merely claims REGISTER_APPROVED is reported as an unverified claim in TEST', () => {
    const result = run([included(1)], claimed());
    assert.deepEqual(result.rule.provenance, { source: 'UNVERIFIED_REGISTER_CLAIM', verification: 'UNVERIFIED_NO_TRUSTED_REGISTER', legalStatus: 'NOT_LEGALLY_APPROVED' });
  });

  test('a fixture relabelled REGISTER_APPROVED is still reported as a fixture', () => {
    const relabelled = { ...fixtureRule({ clauses: clausesAB }), provenance: { kind: 'REGISTER_APPROVED', registerSnapshotHash: 'a'.repeat(64), mappingEntryHashes: ['b'.repeat(64)], approval: { interpretation: 'COMPLIANCE_APPROVED', enablement: 'ENABLED' } } };
    assert.equal(run([included(1)], relabelled).rule.provenance.source, 'MATHEMATICAL_FIXTURE');
    assert.equal(run([included(1)], relabelled).rule.provenance.legalStatus, 'NOT_LEGALLY_APPROVED');
  });

  test('no approval wording, claimed hash or claim content appears anywhere in a result', () => {
    for (const rule of [claimed(), fixtureRule({ clauses: clausesAB })]) {
      const text = JSON.stringify(run([included(1)], rule));
      for (const forbidden of ['REGISTER_APPROVED', 'COMPLIANCE_APPROVED', 'ENABLED', MARKER, 'a'.repeat(64), 'b'.repeat(64)]) assert.ok(!text.includes(forbidden), forbidden);
    }
  });

  test('the derivation takes only a fixture flag: a claim cannot change what is reported', async () => {
    const { describeProvenance } = await import('./src/statutoryWage/productionAuthority.js');
    assert.deepEqual(describeProvenance(true), { source: 'MATHEMATICAL_FIXTURE', verification: 'UNVERIFIED_TEST_ONLY', legalStatus: 'NOT_LEGALLY_APPROVED' });
    for (const claim of [false, undefined, null, 'REGISTER_APPROVED', { kind: 'REGISTER_APPROVED' }, 0]) {
      assert.deepEqual(describeProvenance(claim), { source: 'UNVERIFIED_REGISTER_CLAIM', verification: 'UNVERIFIED_NO_TRUSTED_REGISTER', legalStatus: 'NOT_LEGALLY_APPROVED' });
    }
  });
});

describe('final hardening 5 — own data only: an inherited value never satisfies a required property, at any depth', () => {
  const FACT_SPECS = [{ name: 'flag', type: 'BOOLEAN' }, { name: 'note', type: 'TEXT' }, { name: 'items', type: 'TEXT_LIST' }, { name: 'count', type: 'INTEGER', min: 0, max: 9 }, { name: 'mode', type: 'ENUM', values: ['A', 'B'] }];
  const sampleRule = () => ({
    schema: 'PAYGUARD_STATUTORY_WAGE_RULE_V1', ruleId: 'FIXTURE_SAMPLE', version: 1,
    provenance: { kind: 'MATHEMATICAL_FIXTURE', fixtureId: 'FIXTURE_SAMPLE@1' },
    threshold: '1/2', inKind: { status: 'DISABLED' }, secondProviso: { status: 'DECIDED', decisionRef: 'FIXTURE_DECISION' },
    clauses: [
      { clauseId: 'FIXTURE_A', denominator: '1/1', pool: '1/2', poolInterpretation: 'DEFINED', secondProvisoDependent: true, requiredFacts: FACT_SPECS, factContradictions: [{ flag: true, mode: 'B' }] },
      { clauseId: 'FIXTURE_B', denominator: '1/1', pool: '0/1', poolInterpretation: 'DEFINED', secondProvisoDependent: false, requiredFacts: [] },
    ],
  });
  const sampleLines = () => [
    { lineId: 'L1', amountPaise: 10000, inKind: false, facts: { flag: false, note: 'agreement 7', items: ['x'], count: 0, mode: 'A' }, classification: { status: 'CLASSIFIED', parts: [{ target: 'INCLUDED', portion: '1/2' }, { target: 'CLAUSE', clauseId: 'FIXTURE_A', portion: '1/2' }] } },
    { lineId: 'L2', amountPaise: 500, inKind: false, classification: { status: 'MATCHED', matchedClauses: ['FIXTURE_B'] } },
  ];
  const approvedRule = () => ({
    ...fixtureRule({ clauses: {}, ruleId: 'SYNTHETIC_RULE' }),
    provenance: { kind: 'REGISTER_APPROVED', registerSnapshotHash: 'a'.repeat(64), mappingEntryHashes: ['b'.repeat(64)], approval: { interpretation: 'COMPLIANCE_APPROVED', enablement: 'ENABLED' } },
  });
  const samples = () => [
    { name: 'fixture rule, classified + matched lines', input: { rule: sampleRule(), lines: sampleLines() } },
    { name: 'ambiguous classification', input: { rule: sampleRule(), lines: [{ lineId: 'L1', amountPaise: 5, inKind: false, classification: { status: 'AMBIGUOUS', candidates: ['FIXTURE_A', 'FIXTURE_B'] } }] } },
    { name: 'claimed-approved rule', input: { rule: approvedRule(), lines: [included(500)] } },
  ];

  test('differential: for every key at every depth, deleting it and polluting Object.prototype with its original value changes nothing (TEST and PRODUCTION)', () => {
    let total = 0;
    for (const { name, input } of samples()) {
      for (const options of [TEST, PRODUCTION]) {
        const { findings, examined } = pollutionDifferential(input, (copy) => computeStatutoryWage(copy, options));
        assert.deepEqual(findings, [], `${name} / ${options.context}`);
        total += examined.length;
      }
      const viaValidate = pollutionDifferential(input.rule, (copy) => validateRuleDefinition(copy));
      assert.deepEqual(viaValidate.findings, [], `${name} / validateRuleDefinition`);
      const viaUsable = pollutionDifferential(input.rule, (copy) => assertRuleUsable(copy, PRODUCTION));
      assert.deepEqual(viaUsable.findings, [], `${name} / assertRuleUsable`);
    }
    assert.ok(total > 150, `the differential examined ${total} key paths`);
  });

  test('the differential covers the security-relevant keys by name, including nested ones', () => {
    const examined = new Set();
    for (const { input } of samples()) for (const path of objectKeyPaths(input)) examined.add(String(path.at(-1)));
    for (const key of ['threshold', 'inKind', 'secondProviso', 'decisionRef', 'provenance', 'kind', 'fixtureId', 'registerSnapshotHash', 'mappingEntryHashes', 'approval', 'interpretation', 'enablement',
      'clauses', 'clauseId', 'denominator', 'pool', 'poolInterpretation', 'secondProvisoDependent', 'requiredFacts', 'factContradictions', 'name', 'type', 'min', 'max', 'values',
      'lines', 'lineId', 'amountPaise', 'classification', 'status', 'parts', 'target', 'portion', 'matchedClauses', 'candidates', 'facts', 'flag', 'mode', 'rule', 'schema', 'ruleId', 'version']) {
      assert.ok(examined.has(key), `the differential never examined "${key}"`);
    }
  });

  test('negative control: the differential does catch a function that reads an inherited value', () => {
    const vulnerable = (input) => ({ threshold: input.threshold === undefined ? 'MISSING' : input.threshold, nested: input.rule === undefined ? 'MISSING' : input.rule.threshold });
    const { findings } = pollutionDifferential({ threshold: '1/2', rule: { threshold: '1/3' } }, vulnerable);
    assert.ok(findings.length >= 2, JSON.stringify(findings));
  });

  test('named cases: a missing threshold stays missing, and so does every other required own property, under a polluted prototype', () => {
    const build = (mutate) => { const input = { rule: sampleRule(), lines: sampleLines() }; mutate(input); return input; };
    const cases = {
      threshold: [(i) => { delete i.rule.threshold; }, C.WAGE_DEFINITION_INCOMPLETE, '1/3'],
      version: [(i) => { delete i.rule.version; }, C.WAGE_DEFINITION_INCOMPLETE, 1],
      inKindRule: [(i) => { delete i.rule.inKind; }, C.WAGE_DEFINITION_INCOMPLETE, { status: 'DISABLED' }],
      denominator: [(i) => { delete i.rule.clauses[0].denominator; }, C.WAGE_DEFINITION_INCOMPLETE, '1/1'],
      portion: [(i) => { delete i.lines[0].classification.parts[0].portion; }, C.RATIONAL_NOT_CANONICAL, '1/2'],
      classification: [(i) => { delete i.lines[1].classification; }, C.STATUTORY_NATURE_MISSING, { status: 'UNCLASSIFIED' }],
      amountPaise: [(i) => { delete i.lines[1].amountPaise; }, C.INPUT_AMOUNT_NOT_INTEGER_PAISE, 500],
      inKindLine: [(i) => { delete i.lines[1].inKind; }, C.IN_KIND_STATUS_INVALID, false],
      factsMissing: [(i) => { delete i.lines[0].facts.flag; }, C.REMUNERATION_FACT_MISSING, true],
    };
    for (const [name, [mutate, code, polluter]] of Object.entries(cases)) {
      const key = { threshold: 'threshold', version: 'version', inKindRule: 'inKind', denominator: 'denominator', portion: 'portion', classification: 'classification', amountPaise: 'amountPaise', inKindLine: 'inKind', factsMissing: 'flag' }[name];
      Object.prototype[key] = polluter; // eslint-disable-line no-extend-native
      try {
        expectCode(() => computeStatutoryWage(build(mutate), TEST), code);
      } finally {
        delete Object.prototype[key];
      }
    }
  });

  test('toOwnData: null-prototype deep copies of own data; accessors, symbols, cycles and excess depth are named errors; non-plain data becomes an inert marker the validators reject', () => {
    const source = { a: { b: [1, { c: 'x' }] }, d: null };
    const copy = toOwnData(source);
    assert.deepEqual(JSON.parse(JSON.stringify(copy)), source);
    assert.equal(Object.getPrototypeOf(copy), null);
    assert.equal(Object.getPrototypeOf(copy.a), null);
    assert.equal(Object.getPrototypeOf(copy.a.b[1]), null);
    assert.notEqual(copy.a, source.a, 'a copy, not the caller\'s object');
    Object.prototype.leak = 'LEAK'; // eslint-disable-line no-extend-native
    try { assert.equal(copy.leak, undefined); assert.equal(copy.a.leak, undefined); } finally { delete Object.prototype.leak; }
    assert.equal(Object.keys(toOwnData(toOwnData(source))).join(), 'a,d', 'idempotent');
    expectCode(() => toOwnData({ get x() { return 1; } }), C.INPUT_MALFORMED);
    expectCode(() => toOwnData({ [Symbol('s')]: 1 }), C.INPUT_MALFORMED);
    expectCode(() => toOwnData(Object.defineProperty({}, 'hidden', { value: 1, enumerable: false })), C.INPUT_MALFORMED);
    const cyclic = {}; cyclic.self = cyclic;
    assert.match(expectCode(() => toOwnData(cyclic), C.INPUT_MALFORMED).message, /cycle/, 'a cycle is named as a cycle');
    let deep = {}; const top = deep;
    for (let i = 0; i < MAX_DEPTH + 2; i++) { deep.next = {}; deep = deep.next; }
    assert.match(expectCode(() => toOwnData(top), C.INPUT_MALFORMED).message, /nested deeper than/, 'excess depth is named as such');
    // a hostile Proxy (a trap that throws) is a named error, not the caller's raw Error
    for (const trap of ['ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf']) {
      const hostile = new Proxy({ a: 1 }, { [trap]() { throw new Error('boom'); } });
      expectCode(() => computeStatutoryWage({ rule: hostile, lines: [] }, TEST), C.INPUT_MALFORMED);
      expectCode(() => computeStatutoryWage(hostile, TEST), C.INPUT_MALFORMED);
    }
    class Thing { constructor() { this.a = 1; } }
    const thing = new Thing(); const date = new Date(0); const map = new Map(); const sparse = new Array(2); const proto = Object.create({ a: 1 });
    const symbolArray = [1, 2]; symbolArray[Symbol('s')] = 1; const extraArray = Object.assign([1], { extra: true });
    for (const value of [thing, date, map, sparse, proto, symbolArray, extraArray]) {
      const replaced = toOwnData(value);
      assert.ok(replaced instanceof NotPlainData, 'replaced by an inert marker, never passed through');
      assert.notEqual(replaced, value);
      assert.ok(Object.isFrozen(replaced));
    }
    assert.ok(toOwnData({ nested: [thing] }).nested[0] instanceof NotPlainData, 'at every depth');
    const fn = () => 1;
    assert.equal(toOwnData(fn), fn, 'a function is not an object and is returned as is (every validator rejects it)');
    assert.equal(toOwnData('x'), 'x'); assert.equal(toOwnData(7), 7); assert.equal(toOwnData(null), null); assert.equal(toOwnData(undefined), undefined);
    assert.deepEqual(toOwnData([1, [2, { z: 3 }]]).flat().length, 3);
  });
});

describe('last review round — sanitizer gaps, raw errors, invisible identifiers', () => {
  const FACT_RULE = (specs) => fixtureRule({ clauses: { FIXTURE_F: { d: '1/1', p: '1/1', extra: { requiredFacts: specs } } } });
  const withSymbol = (array) => { array[Symbol('s')] = 1; return array; };
  const rawBomb = () => { throw new Error('raw'); };
  const hostile = (trap) => new Proxy({ a: 1 }, { [trap]: rawBomb });

  test('a symbol-keyed array is not an array of items: it is rejected everywhere, so nothing inside it is read through a prototype', () => {
    const omitted = included(500); delete omitted.inKind;
    const rule = fixtureRule({ clauses: clausesAB });
    Object.prototype.inKind = false; // eslint-disable-line no-extend-native
    try {
      expectCode(() => computeStatutoryWage({ rule, lines: withSymbol([omitted]) }, TEST), C.INPUT_LINE_INVALID);
      expectCode(() => computeStatutoryWage({ rule, lines: [omitted] }, TEST), C.IN_KIND_STATUS_INVALID); // the control
    } finally {
      delete Object.prototype.inKind;
    }
    const base = fixtureRule({ clauses: clausesAB });
    expectCode(() => validateRuleDefinition({ ...base, clauses: withSymbol([...base.clauses]) }), C.WAGE_DEFINITION_INCOMPLETE);
    expectCode(() => run([{ ...included(1), classification: { status: 'CLASSIFIED', parts: withSymbol([{ target: 'INCLUDED', portion: '1/1' }]) } }]), C.MAPPING_PARTITION_INVALID);
    expectCode(() => validateRuleDefinition(FACT_RULE(withSymbol([{ name: 'f', type: 'BOOLEAN' }]))), C.WAGE_DEFINITION_INCOMPLETE);
    expectCode(() => validateRuleDefinition(FACT_RULE([{ name: 'm', type: 'ENUM', values: withSymbol(['A']) }])), C.RULE_DEFINITION_INVALID);
  });

  test('an omitted facts object cannot be satisfied from Object.prototype (the engine never reads a literal)', () => {
    const line = { lineId: 'L1', amountPaise: 500, inKind: false, classification: { status: 'CLASSIFIED', parts: [{ target: 'CLAUSE', clauseId: 'FIXTURE_F', portion: '1/1' }] } };
    // ONE required fact per rule, so the polluted value is the only thing that could satisfy it
    for (const [name, type, value] of [['t', 'TEXT', 'polluted-text'], ['b', 'BOOLEAN', true], ['toString', 'TEXT', 'polluted-text'], ['n', 'INTEGER', 0]]) {
      const rule = FACT_RULE([type === 'INTEGER' ? { name, type, min: 0, max: 9 } : { name, type }]);
      assert.doesNotThrow(() => computeStatutoryWage({ rule, lines: [{ ...line, facts: { [name]: value } }] }, TEST), `${name}: the control (supplied as an own fact)`);
      Object.prototype[name] = value; // eslint-disable-line no-extend-native
      try {
        expectCode(() => computeStatutoryWage({ rule, lines: [line] }, TEST), C.REMUNERATION_FACT_MISSING);
      } finally {
        delete Object.prototype[name];
      }
    }
  });

  test('the fixture check in PRODUCTION reads the caller rule as own data too: a polluted prototype cannot make a rule look like a fixture, or hide that it is one', () => {
    const noProvenance = { ...fixtureRule({ clauses: {}, ruleId: 'SYNTHETIC_RULE' }) };
    delete noProvenance.provenance;
    Object.prototype.provenance = { kind: 'MATHEMATICAL_FIXTURE', fixtureId: 'FIXTURE_X' }; // eslint-disable-line no-extend-native
    try {
      expectCode(() => assertRuleUsable(noProvenance, PRODUCTION), C.RULE_PROVENANCE_MISSING); // not MATHEMATICAL_FIXTURE_NOT_ALLOWED
    } finally {
      delete Object.prototype.provenance;
    }
    expectCode(() => assertRuleUsable(noProvenance, PRODUCTION), C.RULE_PROVENANCE_MISSING);
    // and a fixture whose own clauses carry the FIXTURE_ marker is still seen as one when the prototype supplies a different clauses list
    const fixture = fixtureRule({ clauses: clausesAB });
    Object.prototype.clauses = []; // eslint-disable-line no-extend-native
    try {
      expectCode(() => assertRuleUsable(fixture, PRODUCTION), C.MATHEMATICAL_FIXTURE_NOT_ALLOWED);
    } finally {
      delete Object.prototype.clauses;
    }
  });

  test('a lying Proxy (its prototype answers differently on each read) never reaches a validator: it is replaced by an inert marker', () => {
    const makeLiar = () => { let reads = 0; return new Proxy({ ...included(500) }, { getPrototypeOf() { reads += 1; return reads === 1 ? Date.prototype : Object.prototype; } }); };
    expectCode(() => run([makeLiar()]), C.INPUT_LINE_INVALID);
    const flipping = new Proxy({ ...included(500) }, { get(target, key) { return key === 'inKind' ? true : target[key]; } });
    assert.equal(run([flipping]).totals.wagePaise, '500/1', 'a transparent Proxy is read through its descriptors, once, as plain data (a get trap is never consulted)');
    assert.ok(toOwnData(makeLiar()) instanceof NotPlainData);
  });

  test('every public helper turns a crash (a hostile Proxy, a throwing callback) into a named error, never the caller\'s raw one', async () => {
    const { mappingEntryHash, validateMappingEntry, validateStatus, registerSnapshotHash, verifyRegisterSnapshot, validateManifest, verifyManifestBytes, orderEntries } = await import('./src/statutoryWage/provenance.js');
    const { requireProductionRuleAuthority } = await import('./src/statutoryWage/productionAuthority.js');
    const { contextFromOptions } = await import('./src/statutoryWage/context.js');
    const traps = ['ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf'];
    for (const trap of traps) {
      const bomb = hostile(trap);
      // contextFromOptions only enumerates own keys: it never asks for a prototype, so a getPrototypeOf trap is never reached there
      const optionFns = trap === 'getPrototypeOf' ? [] : [(x) => assertRuleUsable(fixtureRule({ clauses: {} }), x), contextFromOptions];
      for (const fn of [validateRuleDefinition, (x) => assertRuleUsable(x, TEST), ...optionFns, exactProduct, mappingEntryHash, validateMappingEntry, validateStatus, registerSnapshotHash,
        (x) => verifyRegisterSnapshot(x, 'h'), validateManifest, (x) => verifyManifestBytes(x, () => null), orderEntries, requireProductionRuleAuthority]) {
        let error = null;
        try { fn(bomb); } catch (e) { error = e; }
        assert.ok(error instanceof StatutoryWageError, `${trap}: ${error}`);
        reached.add(error.code);
        assert.ok([C.INPUT_MALFORMED, C.EXECUTION_CONTEXT_INVALID, C.RULE_DEFINITION_INVALID].includes(error.code), `${trap}: ${error.code}`);
      }
    }
    expectCode(() => orderEntries(null), C.RULE_DEFINITION_INVALID);
    expectCode(() => orderEntries([{ mappingId: 5, mappingVersion: 1 }]), C.RULE_DEFINITION_INVALID);
    expectCode(() => verifyManifestBytes({ artifacts: [] }), C.RULE_DEFINITION_INVALID);
    expectCode(() => verifyManifestBytes({ artifacts: [] }, 'not a function'), C.RULE_DEFINITION_INVALID);
    const acquired = { id: 'A', acquisitionStatus: 'OFFICIAL_EGAZETTE_ACQUIRED_HASHED', sha256: 'a'.repeat(64), byteCount: 3, sourceUrl: 'u', originalFilename: 'f', retrievedAt: 'r' };
    expectCode(() => verifyManifestBytes({ artifacts: [acquired] }, rawBomb), C.INPUT_MALFORMED);
    // canonicalJson itself reports an unreadable value as a CanonicalizationError
    assert.throws(() => canonicalJson(new Proxy({ a: 1 }, { ownKeys() { return ['a', 'ghost']; } })), (error) => error.code === 'CANONICAL_UNSUPPORTED_VALUE');
    assert.throws(() => canonicalJson(hostile('ownKeys')), (error) => error.code === 'CANONICAL_UNSUPPORTED_VALUE');
  });

  test('a Proxy array whose length answers differently on each read can never leave holes in the copy', () => {
    const lying = (items, lengths) => { const queue = [...lengths]; return new Proxy([...items], { get(target, key, receiver) { return key === 'length' ? (queue.length ? queue.shift() : target.length) : Reflect.get(target, key, receiver); } }); };
    const dense = (value) => Array.isArray(value) && Object.keys(value).length === value.length && value.every((item) => item !== undefined);
    // the first read is trusted for the whole copy, and the copy is confirmed dense
    const full = toOwnData(lying(['x', 'y', 'z'], [3, 3, 1, 1, 1]));
    assert.ok(dense(full)); assert.deepEqual(full, ['x', 'y', 'z']);
    for (const lengths of [[1, 3, 3], [0, 3], [2.5], [NaN], [-1], [Infinity], ['3'], [2 ** 40]]) {
      const replaced = toOwnData(lying(['x', 'y', 'z'], lengths));
      assert.ok(replaced instanceof NotPlainData || dense(replaced), `lengths ${lengths}: never a sparse array`);
    }
    assert.ok(toOwnData(lying(['x'], [true])) instanceof NotPlainData, 'a length that is not a safe integer is never trusted');
    // the reviewer's probes: invalid entries hidden behind a lying length are still validated
    const H = 'a'.repeat(64);
    const approved = (hashes) => ({ ...fixtureRule({ clauses: {}, ruleId: 'SYNTHETIC_RULE' }), provenance: { kind: 'REGISTER_APPROVED', registerSnapshotHash: H, mappingEntryHashes: hashes, approval: {} } });
    expectCode(() => validateRuleDefinition(approved(lying([H, 'not-a-hash', 'zz'], [3, 3, 1, 1]))), C.RULE_PROVENANCE_MISSING);
    const enumRule = (values) => fixtureRule({ clauses: { FIXTURE_F: { d: '1/1', p: '1/1', extra: { requiredFacts: [{ name: 'm', type: 'ENUM', values }] } } } });
    assert.doesNotThrow(() => validateRuleDefinition(enumRule(lying(['a', 'b', 'c'], [3, 3, 2, 2]))));
    expectCode(() => validateRuleDefinition(enumRule(lying(['a', 'UNKNOWN', 'c'], [3, 3, 1, 1]))), C.RULE_DEFINITION_INVALID);
  });

  test('the context option is read as own data only: an accessor is a named error in the engine, as in the resolvers', () => {
    const accessor = { get context() { return 'TEST'; } };
    expectCode(() => computeStatutoryWage({ rule: fixtureRule({ clauses: clausesAB }), lines: [] }, accessor), C.INPUT_MALFORMED);
    expectCode(() => assertRuleUsable(fixtureRule({ clauses: clausesAB }), accessor), C.INPUT_MALFORMED);
    expectCode(() => assertRuleUsable(fixtureRule({ clauses: clausesAB }), Object.defineProperty({}, 'context', { get() { return 'PRODUCTION'; }, enumerable: false })), C.INPUT_MALFORMED);
    assert.doesNotThrow(() => assertRuleUsable(fixtureRule({ clauses: clausesAB }), { context: 'TEST' }));
  });

  test('identifiers (ruleId, clauseId, fixtureId, lineId) may not hide invisible characters', () => {
    const base = fixtureRule({ clauses: clausesAB });
    expectCode(() => validateRuleDefinition({ ...base, ruleId: 'FIXTURE​RULE' }), C.RULE_DEFINITION_INVALID);
    expectCode(() => validateRuleDefinition({ ...base, provenance: { ...base.provenance, fixtureId: 'F️' } }), C.RULE_DEFINITION_INVALID);
    expectCode(() => validateRuleDefinition({ ...base, clauses: [{ ...base.clauses[0], clauseId: 'FIXTURE_A⁠' }] }), C.RULE_DEFINITION_INVALID);
    expectCode(() => run([{ ...included(1), lineId: 'L​1' }]), C.INPUT_LINE_INVALID);
    expectCode(() => run([{ ...included(1), lineId: 'ㅤ' }]), C.INPUT_LINE_INVALID);
    assert.equal(run([included(1, 'L-1 (a)')]).totals.wagePaise, '1/1', 'ordinary identifiers are fine');
  });

  test('isWellFormedText agrees with the native String.prototype.isWellFormed on every code unit and every surrogate pair', async () => {
    const { isWellFormedText } = await import('./src/statutoryWage/canonical.js');
    for (let unit = 0; unit <= 0xffff; unit++) {
      const text = String.fromCharCode(unit);
      assert.equal(isWellFormedText(text), text.isWellFormed(), `U+${unit.toString(16)}`);
      assert.equal(isWellFormedText(`a${text}b`), `a${text}b`.isWellFormed());
    }
    for (let high = 0xd800; high <= 0xdbff; high += 1) {
      for (let low = 0xdc00; low <= 0xdfff; low += 37) {
        const text = String.fromCharCode(high, low);
        assert.equal(isWellFormedText(text), true);
        assert.equal(isWellFormedText(String.fromCharCode(low, high)), false);
        assert.equal(isWellFormedText(`${text}${String.fromCharCode(high)}`), false);
      }
    }
    assert.equal(isWellFormedText(''), true);
    assert.equal(isWellFormedText('café \u{1f600} अ्‍क'), true);
  });
});

describe('every failure code is reachable (coverage of the named catalogue)', () => {
  test('each code in the catalogue is asserted somewhere in this file or the rational/applicability tests', async () => {
    const { readFileSync } = await import('node:fs');
    const here = readFileSync(new URL('./test_phase1d_engine.js', import.meta.url), 'utf8');
    const rational = readFileSync(new URL('./test_phase1d_rational.js', import.meta.url), 'utf8');
    for (const code of Object.values(C)) {
      assert.ok(here.includes(`C.${code}`) || rational.includes(`C.${code}`), `no test asserts ${code}`);
    }
  });

  test('every code in the catalogue was actually PROVOKED by a test in this file (execution, not text); this test must run last', () => {
    // RATIONAL_INVALID is raised only inside the rational module's own arithmetic and is provoked in test_phase1d_rational.js.
    const provokedElsewhere = new Set([C.RATIONAL_INVALID]);
    for (const code of Object.values(C)) {
      if (!provokedElsewhere.has(code)) assert.ok(reached.has(code), `${code} was never thrown by any test in this file`);
    }
  });

  test('Q is the rational module the engine itself uses (sanity: one canonical form)', () => {
    assert.equal(Q.toCanonical(Q.fromCanonical('3/400')), '3/400');
  });
});
