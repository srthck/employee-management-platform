/**
 * test_phase1d_hostile.js — structural hostile-input fuzz of the Phase 1D scaffold.
 *
 * The other Phase 1D tests show each hostile class once. This one applies every class at EVERY node of a valid input and asserts
 * the governing property, with a seeded generator so a failure can be replayed:
 *
 *   PRODUCTION  never returns a result, whatever is supplied (engine), and never resolves (applicability).
 *   TEST        a hostile variant either fails closed with a NAMED outcome, or is indistinguishable from the clean input.
 *
 * Every rule and record is a fixture. Nothing here says anything about the law, and no database is touched.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { computeStatutoryWage, assertRuleUsable, roundContribution, validateRuleDefinition } from './src/statutoryWage/wageEngine.js';
import { requireProductionRuleAuthority } from './src/statutoryWage/productionAuthority.js';
import { resolveEstablishmentApplicability, resolveEmployeeApplicability } from './src/statutoryWage/applicability.js';
import { StatutoryWageError, STATUTORY_WAGE_ERROR_CODES as C } from './src/statutoryWage/errors.js';
import { CanonicalizationError } from './src/statutoryWage/canonical.js';
import { fixtureRule, engineLines, prng, randomCase } from './test_support/wageFixtures.js';

const TEST = { context: 'TEST' };
const PRODUCTION = { context: 'PRODUCTION' };
const named = (error) => error instanceof StatutoryWageError || error instanceof CanonicalizationError;

const clauses = { FIXTURE_A: { d: '1/1', p: '1/1' }, FIXTURE_B: { d: '1/1', p: '0/1' } };
const cleanInput = () => ({
  rule: fixtureRule({ clauses }),
  lines: engineLines([
    { lineId: 'L1', amountPaise: 1_000_000, parts: [{ portion: '1/1' }] },
    { lineId: 'L2', amountPaise: 700_000, parts: [{ clauseId: 'FIXTURE_A', portion: '1/2' }, { clauseId: 'FIXTURE_B', portion: '1/2' }] },
  ]),
});

const fixtureRecord = () => ({
  recordId: 'FX-1', provenance: 'TEST_FIXTURE', instrument: 'FIXTURE_INSTRUMENT_1', state: 'Fixtureland', units: ['Alpha'],
  effectiveDate: '2026-10-01', supersedes: [], supersessionStatus: 'CLEAR',
  verification: { textStatus: 'PRIMARY_TEXT_VERIFIED', sourceArtifactHash: 'c'.repeat(64) },
});
const applicabilityInput = (context) => ({
  establishment: { establishmentId: 'EST-1', categoryState: 'ESTABLISHED', locations: [{ effectiveFrom: '2020-01-01', effectiveTo: null, state: 'Fixtureland', district: 'Alpha' }] },
  period: { start: '2026-10-01', end: '2026-10-31' },
  inventory: { enumerationComplete: true, records: [fixtureRecord()] },
  ...(context ? { context } : {}),
});

class Thing { constructor() { this.a = 1; } }

/** Each replaces a node with something that is not plain data. `original` is the value at that node. */
const HOSTILE = {
  'transparent Proxy': (original) => (original && typeof original === 'object' ? new Proxy(original, {}) : undefined),
  'Proxy that lies on every read': (original) => {
    if (!original || typeof original !== 'object') return undefined;
    let reads = 0;
    return new Proxy(original, { get(target, key, receiver) { reads += 1; return reads % 2 ? Reflect.get(target, key, receiver) : 'LIE'; } });
  },
  'Proxy whose descriptor trap flips': (original) => {
    if (!original || typeof original !== 'object') return undefined;
    let reads = 0;
    return new Proxy(original, { getOwnPropertyDescriptor(target, key) { reads += 1; const d = Reflect.getOwnPropertyDescriptor(target, key); return reads > 1 && d && 'value' in d ? { ...d, value: 'FLIPPED' } : d; } });
  },
  'Proxy that throws': () => new Proxy({}, { ownKeys() { throw new Error('caller code ran'); }, getPrototypeOf() { throw new Error('caller code ran'); } }),
  'accessor property': (original) => Object.defineProperty({}, 'x', { enumerable: true, get() { return original; } }),
  'symbol key': () => ({ [Symbol('s')]: 1 }),
  'non-enumerable key': () => Object.defineProperty({}, 'hidden', { value: 1, enumerable: false }),
  'sparse array': () => new Array(3),
  'array with an extra property': () => Object.assign([1], { extra: true }),
  Date: () => new Date(0),
  Map: () => new Map([['a', 1]]),
  'class instance': () => new Thing(),
  'caller-built prototype': (original) => Object.create(original && typeof original === 'object' ? original : { inherited: true }),
  function: () => () => 'caller code ran',
  'boxed String': (original) => new String(original), // eslint-disable-line no-new-wrappers
  'boxed Number': (original) => new Number(original), // eslint-disable-line no-new-wrappers
  'boxed Boolean': (original) => new Boolean(original), // eslint-disable-line no-new-wrappers
  symbol: () => Symbol('s'),
  NaN: () => NaN,
  Infinity: () => Infinity,
  'a cycle': () => { const a = {}; a.self = a; return a; },
  'own __proto__ key': () => JSON.parse('{"__proto__":{"approved":true},"constructor":{"prototype":{"approved":true}}}'),
  'deep nesting': () => { let node = {}; for (let i = 0; i < 80; i++) node = { node }; return node; },
};

const nodePaths = (value, prefix = []) => {
  const out = [];
  if (Array.isArray(value)) value.forEach((item, index) => { out.push([...prefix, index]); out.push(...nodePaths(item, [...prefix, index])); });
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { out.push([...prefix, key]); out.push(...nodePaths(item, [...prefix, key])); }
  return out;
};
const withNode = (root, path, make) => {
  const copy = structuredClone(root);
  const parent = path.slice(0, -1).reduce((node, part) => node[part], copy);
  const replacement = make(parent[path.at(-1)]);
  if (replacement === undefined) return null; // this class does not apply to a scalar
  parent[path.at(-1)] = replacement;
  return copy;
};

const replacer = (key, item) => (typeof item === 'bigint' ? item.toString() : item);
const outcome = (fn) => {
  try {
    return { returned: true, value: fn() };
  } catch (error) {
    return { returned: false, error };
  }
};

describe('Z1 — every hostile class at every node of a valid input', () => {
  const sample = cleanInput();
  const clean = computeStatutoryWage(cleanInput(), TEST);
  const paths = nodePaths(sample);

  test('PRODUCTION never returns, and fails with a named error, for all of them', () => {
    let cases = 0;
    for (const [name, make] of Object.entries(HOSTILE)) {
      for (const path of paths) {
        const input = withNode(sample, path, make);
        if (!input) continue;
        for (const options of [undefined, PRODUCTION]) {
          cases += 1;
          const result = outcome(() => computeStatutoryWage(input, options));
          assert.equal(result.returned, false, `${name} at ${path.join('.')} must not produce a production result`);
          assert.ok(named(result.error), `${name} at ${path.join('.')}: a raw ${result.error?.name}: ${result.error?.message}`);
        }
      }
    }
    assert.ok(cases > 500, `expected a thorough sweep, ran ${cases}`);
  });

  test('TEST: each variant fails closed with a named error or is indistinguishable from the clean result; none yields a different number', () => {
    let accepted = 0; let refused = 0;
    for (const [name, make] of Object.entries(HOSTILE)) {
      for (const path of paths) {
        const input = withNode(sample, path, make);
        if (!input) continue;
        const result = outcome(() => computeStatutoryWage(input, TEST));
        if (result.returned) {
          accepted += 1;
          assert.equal(result.value.resultHash, clean.resultHash, `${name} at ${path.join('.')} changed the result`);
        } else {
          refused += 1;
          assert.ok(named(result.error), `${name} at ${path.join('.')}: a raw ${result.error?.name}: ${result.error?.message}`);
        }
      }
    }
    assert.ok(refused > 300, `only ${refused} refused`);
    // The accepted ones are exactly the honest read-through wrappers.
    assert.ok(accepted > 0, 'a transparent Proxy over plain data is read as that data, once');
  });

  test('caller code is never run by a sanitized read: an accessor anywhere is refused before it fires', () => {
    let fired = 0;
    for (const path of paths) {
      const input = withNode(sample, path, () => Object.defineProperty({}, 'x', { enumerable: true, get() { fired += 1; return 1; } }));
      const result = outcome(() => computeStatutoryWage(input, TEST));
      assert.equal(result.returned, false);
      assert.ok(named(result.error));
    }
    assert.equal(fired, 0);
  });
});

describe('Z2 — forged authority', () => {
  const approval = { interpretation: 'COMPLIANCE_APPROVED', enablement: 'ENABLED', approvedBy: 'Chief Legal Officer', decisionRef: 'D-1' };
  const hash = 'a'.repeat(64);
  const relabel = (mutate) => { const input = cleanInput(); mutate(input.rule); return input; };

  const FORGERIES = {
    'REGISTER_APPROVED with an approval object': (rule) => { rule.provenance = { kind: 'REGISTER_APPROVED', registerSnapshotHash: hash, mappingEntryHashes: [hash], approval }; },
    'REGISTER_APPROVED without an approval object': (rule) => { rule.provenance = { kind: 'REGISTER_APPROVED', registerSnapshotHash: hash, mappingEntryHashes: [hash] }; },
    'fixture relabelled and clause ids renamed': (rule) => {
      rule.provenance = { kind: 'REGISTER_APPROVED', registerSnapshotHash: hash, mappingEntryHashes: [hash], approval };
      rule.ruleId = 'ESI_WAGE_RULE';
      rule.clauses = rule.clauses.map((clause) => ({ ...clause, clauseId: clause.clauseId.replace('FIXTURE_', 'CLAUSE_') }));
    },
    'kind with trailing space': (rule) => { rule.provenance.kind = 'MATHEMATICAL_FIXTURE '; },
    'kind in lower case': (rule) => { rule.provenance.kind = 'register_approved'; },
    'kind in full-width letters': (rule) => { rule.provenance.kind = 'ＲＥＧＩＳＴＥＲ_ＡＰＰＲＯＶＥＤ'; },
    'kind with a zero-width joiner': (rule) => { rule.provenance.kind = 'REGISTER‍_APPROVED'; },
    'approved flag beside provenance': (rule) => { rule.approved = true; },
    'production label beside provenance': (rule) => { rule.environment = 'PRODUCTION'; },
    'context smuggled into the rule': (rule) => { rule.context = 'TEST'; },
  };

  for (const [name, forge] of Object.entries(FORGERIES)) {
    test(`${name}: never a production result`, () => {
      const input = relabel(forge);
      for (const options of [undefined, PRODUCTION]) {
        const result = outcome(() => computeStatutoryWage(input, options));
        assert.equal(result.returned, false);
        assert.ok(named(result.error), String(result.error));
      }
      assert.throws(() => assertRuleUsable(input.rule), named);
      assert.throws(() => requireProductionRuleAuthority(input.rule), named);
    });
  }

  test('a TEST result never echoes a claimed approval, whatever the rule says about itself', () => {
    const input = relabel((rule) => { rule.provenance = { kind: 'REGISTER_APPROVED', registerSnapshotHash: hash, mappingEntryHashes: [hash], approval }; rule.ruleId = 'ESI_WAGE_RULE'; rule.clauses = rule.clauses.map((clause) => ({ ...clause, clauseId: clause.clauseId.replace('FIXTURE_', 'CLAUSE_') })); });
    const result = outcome(() => computeStatutoryWage(input, TEST));
    if (result.returned) {
      const text = JSON.stringify(result.value, replacer);
      assert.doesNotMatch(text, /COMPLIANCE_APPROVED|REGISTER_APPROVED|Chief Legal Officer/);
      assert.equal(result.value.rule.provenance.legalStatus, 'NOT_LEGALLY_APPROVED');
    } else {
      assert.ok(named(result.error));
    }
  });

  test('no spelling of the context selects TEST except the exact string in an own data property', () => {
    const input = cleanInput();
    const hostile = [
      'test', 'Test', ' TEST', 'TEST ', 'ＴＥＳＴ', new String('TEST'), ['TEST'], { toString() { return 'TEST'; } }, // eslint-disable-line no-new-wrappers
      Symbol('TEST'), 1, true, null,
    ];
    for (const context of hostile) {
      const result = outcome(() => computeStatutoryWage(input, { context }));
      assert.equal(result.returned, false);
      assert.equal(result.error.code, C.EXECUTION_CONTEXT_INVALID, String(context?.toString?.() ?? context));
    }
    for (const options of [
      Object.create({ context: 'TEST' }),
      new Proxy({}, { get: () => 'TEST' }),
      Object.defineProperty({}, 'context', { enumerable: true, get() { return 'TEST'; } }),
    ]) {
      const result = outcome(() => computeStatutoryWage(input, options));
      assert.equal(result.returned, false, 'an inherited, proxied or computed context is not an explicit TEST');
      assert.ok(named(result.error));
    }
  });

  test('polluting Object.prototype cannot open anything', () => {
    const input = cleanInput();
    const polluted = { context: 'TEST', approved: true, approval, enablement: 'ENABLED', interpretation: 'COMPLIANCE_APPROVED', enumerationComplete: true };
    try {
      Object.assign(Object.prototype, polluted); // eslint-disable-line no-extend-native
      for (const options of [undefined, {}, PRODUCTION]) assert.equal(outcome(() => computeStatutoryWage(input, options)).returned, false);
      assert.throws(() => requireProductionRuleAuthority({ schema: 'x' }), named);
      const resolved = resolveEstablishmentApplicability(applicabilityInput());
      assert.notEqual(resolved.outcome, 'RESOLVED');
    } finally {
      for (const key of Object.keys(polluted)) delete Object.prototype[key];
    }
    assert.equal({}.context, undefined);
  });

  test('roundContribution has no input that returns an amount', () => {
    for (const args of [[], [1], [{ mode: 'NEAREST_RUPEE' }], [{ approved: true, approval }], [null], [new Proxy({}, {})]]) {
      assert.throws(() => roundContribution(...args), (error) => error.code === C.CONTRIBUTION_ROUNDING_UNAPPROVED);
    }
  });
});

describe('Z3 — applicability under the same attack', () => {
  const sample = applicabilityInput();
  const paths = nodePaths(sample);

  test('with a complete inventory and a fixture record, PRODUCTION resolves nothing at any node, for any hostile class', () => {
    let cases = 0;
    for (const [name, make] of Object.entries(HOSTILE)) {
      for (const path of paths) {
        const input = withNode(sample, path, make);
        if (!input) continue;
        cases += 1;
        const result = outcome(() => resolveEstablishmentApplicability(input));
        if (result.returned) assert.equal(result.value.outcome, 'BLOCKED', `${name} at ${path.join('.')}`);
        else assert.ok(named(result.error), `${name} at ${path.join('.')}: raw ${result.error?.name}`);
      }
    }
    assert.ok(cases > 200, `ran ${cases}`);
  });

  test('forged completeness, verification, approvals and provenance do not produce a production resolution', () => {
    const record = { ...fixtureRecord(), provenance: 'OFFICIAL_GAZETTE', recordId: 'REAL-LOOKING', instrument: 'S.O. 9999(E)', state: 'Fixtureland' };
    for (const extras of [
      {}, { legacyContinuation: { decisionRef: 'D-1', approved: true } },
      { supersessionResolutions: [{ supersederId: 'A', supersededId: 'B', decisionRef: 'D-2', approved: true, approvedBy: 'General Counsel', approvedOn: '2026-09-01', effectiveDate: '2026-09-15', scope: { state: 'Fixtureland' } }] },
    ]) {
      for (const context of [undefined, 'PRODUCTION']) {
        const result = resolveEstablishmentApplicability({ ...applicabilityInput(context), inventory: { enumerationComplete: true, records: [record] }, ...extras });
        assert.equal(result.outcome, 'BLOCKED', JSON.stringify(result));
      }
    }
  });

  test('the employee path reaches the same block, and a residential address never substitutes for a work assignment', () => {
    const base = applicabilityInput();
    const employee = { workAssignments: [{ establishmentId: 'EST-1', effectiveFrom: '2026-01-01', effectiveTo: null }], residentialAddress: { state: 'Fixtureland', district: 'Alpha' } };
    const production = resolveEmployeeApplicability({ employee, establishments: [base.establishment], period: base.period, inventory: base.inventory });
    assert.equal(production.outcome, 'BLOCKED');
    const noAssignment = resolveEmployeeApplicability({ employee: { residentialAddress: employee.residentialAddress }, establishments: [base.establishment], period: base.period, inventory: base.inventory, context: 'TEST' });
    assert.equal(noAssignment.outcome, 'BLOCKED');
  });
});

describe('Z4 — inputs are not touched, and results do not depend on hostile ordering', () => {
  const deepFreeze = (value) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
    return value;
  };

  test('seeded random cases: deep-frozen input gives the same result as an unfrozen copy, line order does not matter, and PRODUCTION still refuses', () => {
    const random = prng(0x1d0057);
    for (let i = 0; i < 300; i += 1) {
      const generated = randomCase(random);
      const input = { rule: fixtureRule({ threshold: generated.threshold, clauses: generated.clauses }), lines: engineLines(generated.lines) };
      const plain = computeStatutoryWage(input, TEST);
      const frozen = computeStatutoryWage(deepFreeze(structuredClone(input)), TEST);
      assert.equal(frozen.resultHash, plain.resultHash);
      const reversed = computeStatutoryWage({ rule: input.rule, lines: [...input.lines].reverse() }, TEST);
      assert.equal(reversed.resultHash, plain.resultHash);
      assert.throws(() => computeStatutoryWage(input), named);
    }
  });

  test('a rule validated once cannot be changed underneath the calculation: the one value copied is the one validated and the one used', () => {
    // The descriptor trap runs twice during the single sanitizing copy: the enumerability probe, then the data read. Anything later would be a re-read.
    let reads = 0;
    const input = cleanInput();
    const shifting = new Proxy(input.rule, {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key !== 'threshold' || !descriptor) return descriptor;
        reads += 1;
        return { ...descriptor, value: reads === 2 ? '1/3' : '0/1' };
      },
    });
    const result = computeStatutoryWage({ rule: shifting, lines: input.lines }, TEST);
    const honest = cleanInput(); honest.rule.threshold = '1/3';
    assert.equal(result.resultHash, computeStatutoryWage(honest, TEST).resultHash);
    assert.equal(reads, 2, 'no read happens after the copy');
  });

  test('validateRuleDefinition on a forged rule returns no authority: the only success is a structural one, in TEST', () => {
    const rule = cleanInput().rule;
    assert.ok(validateRuleDefinition(rule));
    assert.throws(() => assertRuleUsable(rule), (error) => error.code === C.MATHEMATICAL_FIXTURE_NOT_ALLOWED);
  });
});
