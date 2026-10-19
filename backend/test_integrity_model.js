/**
 * test_integrity_model.js — Phase 1 of the integrity program: executable invariant models.
 *
 * Runner: node:test.  Needs no database.  Run: node --test test_integrity_model.js
 *
 * These tests check the MODELS and the EXPLORER, not the implementation:
 *   A — the explorer finds a known counterexample, finds none in a correct system, reports truncation, is deterministic
 *   B — every scenario violates exactly the invariants it is expected to, and was explored completely
 *   C — every reported counterexample is a real execution of its model (replayed step by step)
 *   D — the integrity program's named invariants are each checked, fail in the current design where the audit said
 *       they would, and hold in the proposed design
 *   E — docs/integrity/MODEL-RESULTS.md is exactly what the models produce
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { explore, isStep, clone } from './test_support/integrityModel/explorer.mjs';
import { SCENARIOS, MANDATED_INVARIANTS } from './test_support/integrityModel/scenarios.mjs';
import { runAll, renderMarkdown } from './test_support/integrityModel/report.mjs';
import { DOC_PATH } from './test_support/integrityModel/run.mjs';

const results = runAll();

describe('A — the explorer, on systems whose answer is known', () => {
  // two threads each: read x, then write x := read + 1. The classic lost update.
  const lostUpdate = (atomic) => {
    const init = { x: 0, t: [{ pc: 'start', v: 0 }, { pc: 'start', v: 0 }] };
    const actions = (s) => {
      const out = [];
      s.t.forEach((thread, i) => {
        if (atomic && thread.pc === 'start') { const n = clone(s); n.x += 1; n.t[i].pc = 'done'; out.push([`t${i}: atomic increment`, n]); }
        if (!atomic && thread.pc === 'start') { const n = clone(s); n.t[i].v = s.x; n.t[i].pc = 'read'; out.push([`t${i}: reads x (${s.x})`, n]); }
        if (!atomic && thread.pc === 'read') { const n = clone(s); n.x = thread.v + 1; n.t[i].pc = 'done'; out.push([`t${i}: writes x := ${thread.v + 1}`, n]); }
      });
      return out;
    };
    const invariants = [{ name: 'NoLostUpdate', check: (s) => (s.t.every((x) => x.pc === 'done') && s.x !== 2 ? `both threads finished but x = ${s.x}` : true) }];
    return { init, actions, invariants };
  };

  test('finds the lost update, with a SHORTEST trace (read, read, write, write), and the trace is a real execution', () => {
    const model = lostUpdate(false);
    const result = explore(model);
    assert.equal(result.complete, true);
    assert.equal(result.violations.length, 1);
    const [violation] = result.violations;
    assert.equal(violation.invariant, 'NoLostUpdate');
    assert.equal(violation.trace.length, 5, 'initial state + 4 steps is the shortest way to lose an update');
    assert.match(violation.detail, /x = 1/);
    for (let i = 1; i < violation.trace.length; i += 1) assert.ok(isStep(model.actions, violation.trace[i - 1].state, violation.trace[i].action, violation.trace[i].state));
  });

  test('finds nothing in the atomic version, and says the exploration was complete', () => {
    const result = explore(lostUpdate(true));
    assert.equal(result.complete, true);
    assert.deepEqual(result.violations, []);
    assert.ok(result.states > 1);
  });

  test('reports truncation honestly: a state limit makes the result incomplete, never silently clean', () => {
    const result = explore({ ...lostUpdate(false), maxStates: 3 });
    assert.equal(result.complete, false);
    assert.equal(result.states, 3);
  });

  test('an invariant violated in the INITIAL state is reported with a one-step trace', () => {
    const result = explore({ init: { n: 1 }, actions: () => [], invariants: [{ name: 'AlwaysZero', check: (s) => (s.n === 0 ? true : 'n is not zero') }] });
    assert.equal(result.violations[0].trace.length, 1);
    assert.equal(result.violations[0].trace[0].action, '(initial state)');
  });

  test('isStep rejects a trace step that is not a real transition', () => {
    const model = lostUpdate(false);
    assert.equal(isStep(model.actions, model.init, 't0: reads x (0)', { ...clone(model.init), x: 99 }), false);
    assert.equal(isStep(model.actions, model.init, 'not an action', model.init), false);
  });

  test('exploration is deterministic: two runs of every scenario give identical sizes and traces', () => {
    const again = runAll();
    assert.deepEqual(again.map((r) => [r.scenario.id, r.result.states, r.result.transitions, r.result.maxDepth, r.violated]), results.map((r) => [r.scenario.id, r.result.states, r.result.transitions, r.result.maxDepth, r.violated]));
    assert.equal(renderMarkdown(again), renderMarkdown(results));
  });
});

describe('B — every scenario violates exactly what it is expected to, and was explored completely', () => {
  for (const { scenario, result, violated } of results) {
    test(`${scenario.id} (${scenario.role}): ${scenario.title}`, () => {
      assert.equal(result.complete, true, `${scenario.id} hit the state limit: a truncated exploration proves nothing`);
      assert.ok(result.states > 1, 'the model actually did something');
      assert.deepEqual(violated, [...scenario.expect].sort(), `${scenario.id}: violated invariants differ from the expectation`);
    });
  }
  test('scenario ids are unique, and each role is one of the known roles', () => {
    assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, SCENARIOS.length);
    for (const s of SCENARIOS) assert.ok(['current', 'proposed', 'sensitivity', 'partial', 'boundary'].includes(s.role), s.id);
  });
  test('every proposed-design scenario is clean and every current-design scenario that the audit predicted to fail does fail', () => {
    for (const r of results.filter((x) => x.scenario.role === 'proposed')) assert.deepEqual(r.violated, [], `${r.scenario.id} (proposed) must be clean`);
    for (const id of ['A4', 'B1', 'B2', 'C1', 'C2', 'D1', 'E1']) assert.ok(results.find((r) => r.scenario.id === id).violated.length > 0, `${id} must reach its known failure`);
    for (const id of ['A1', 'A2', 'A3', 'D2']) assert.deepEqual(results.find((r) => r.scenario.id === id).violated, [], `${id}: the audit found this configuration safe`);
  });
  test('either unique index alone prevents the fork (A2, A3) but not neither (A4): the audit\'s claim, reproduced in the model', () => {
    const by = (id) => results.find((r) => r.scenario.id === id).violated;
    assert.deepEqual(by('A2'), []);
    assert.deepEqual(by('A3'), []);
    assert.ok(by('A4').includes('OneSuccessorPerPredecessor'));
  });
  test('each protection of the recovery protocol is load-bearing: removing exactly one brings back exactly its violation', () => {
    const by = (id) => results.find((r) => r.scenario.id === id).violated;
    assert.deepEqual(by('C5'), ['NoPurgeAfterEligibilityChanges']);
    assert.deepEqual(by('C6'), ['NoPurgeOfEverFinalized']);
    assert.deepEqual(by('C7'), ['ExpiredOwnerCannotDelete']);
  });
});

describe('C — every counterexample is a real execution of its model', () => {
  for (const { scenario, model, result } of results) {
    for (const violation of result.violations) {
      test(`${scenario.id} ${violation.invariant}: ${violation.trace.length - 1} steps, each a transition the model offers, ending in a state that violates the invariant`, () => {
        const { trace } = violation;
        assert.equal(trace[0].action, '(initial state)');
        assert.deepEqual(trace[0].state, model.init);
        for (let i = 1; i < trace.length; i += 1) {
          assert.ok(isStep(model.actions, trace[i - 1].state, trace[i].action, trace[i].state), `step ${i} (${trace[i].action}) is not an enabled transition`);
        }
        const invariant = model.invariants.find((x) => x.name === violation.invariant);
        assert.notEqual(invariant.check(trace.at(-1).state), true, 'the final state really violates the invariant');
        for (const earlier of trace.slice(0, -1)) assert.equal(invariant.check(earlier.state), true, 'a SHORTEST trace violates the invariant only at its end');
      });
    }
  }
});

describe('D — the integrity program\'s named invariants', () => {
  test('each mandated invariant is implemented in the model that is supposed to check it, and appears in at least one scenario', () => {
    for (const [name, model] of Object.entries(MANDATED_INVARIANTS)) {
      const rows = results.filter((r) => r.scenario.id.startsWith(model) && r.model.invariants.some((i) => i.name === name));
      assert.ok(rows.length > 0, `${name} is not checked by any model-${model} scenario`);
    }
  });
  test('every invariant that is reported violated somewhere is also reported HOLDING somewhere (it can discriminate)', () => {
    const names = new Set(results.flatMap((r) => r.model.invariants.map((i) => i.name)));
    for (const name of names) {
      const checked = results.filter((r) => r.model.invariants.some((i) => i.name === name));
      assert.ok(checked.some((r) => r.violated.includes(name)), `${name} is never violated: it may be vacuous`);
      assert.ok(checked.some((r) => !r.violated.includes(name)), `${name} is always violated: it may be unsatisfiable`);
    }
  });
  test('the named invariants fail in the current design where the independent audit said they would, and hold in the proposed design', () => {
    const state = (name, role) => results.filter((r) => r.scenario.role === role && r.model.invariants.some((i) => i.name === name)).map((r) => r.violated.includes(name));
    for (const name of ['OneSuccessorPerPredecessor', 'NoCommittedCriticalMutationWithoutRequiredAudit', 'NoDuplicateLogicalOperation', 'NoPurgeOfEverFinalized', 'NoPurgeAfterEligibilityChanges', 'ExpiredOwnerCannotDelete', 'HistoricalHashesRemainStable']) {
      assert.ok(state(name, 'current').some(Boolean), `${name} should be violated by some current-design scenario`);
      assert.ok(state(name, 'proposed').every((v) => !v), `${name} should hold in every proposed-design scenario`);
    }
    assert.ok(results.some((r) => r.violated.includes('HeadMatchesLastCommittedEntry')), 'HeadMatchesLastCommittedEntry is violated by a legacy writer (rollout condition)');
    assert.ok(results.filter((r) => r.scenario.role === 'proposed').every((r) => !r.violated.includes('HeadMatchesLastCommittedEntry')));
  });
});

describe('E — the committed results document is exactly what the models produce', () => {
  test('docs/integrity/MODEL-RESULTS.md is up to date (regenerate with: node test_support/integrityModel/run.mjs --write)', () => {
    const committed = fs.readFileSync(DOC_PATH, 'utf8').replace(/\r\n/g, '\n');
    assert.equal(committed, renderMarkdown(results));
  });
  test('the document states that it is not TLC and that TLC/Apalache were not run', () => {
    const text = renderMarkdown(results);
    assert.match(text, /\*\*not\*\* TLA\+\/TLC/);
    assert.match(text, /TLA\+\/TLC and Apalache were not run: `UNVERIFIED`/);
    assert.match(text, /Assumptions and limitations/);
  });
  test('a truncated scenario would be flagged in the document, never rendered as clean', () => {
    const fake = results.map((r) => ({ ...r }));
    fake[0] = { ...fake[0], result: { ...fake[0].result, complete: false } };
    assert.match(renderMarkdown(fake), /\*\*NO \(truncated\)\*\*/);
  });
});
