/**
 * A small bounded EXPLICIT-STATE model explorer.
 *
 * This is NOT TLC, Apalache or any other established model checker (none is installed in this environment),
 * and a result from it is not a proof about the implementation. It does exactly one thing: breadth-first
 * enumeration of every state reachable from `init` through every interleaving of the actions the model
 * offers, checking each invariant in each state. Because it is breadth-first, the trace reported for a
 * violated invariant is a SHORTEST counterexample. If the state limit is reached the result says
 * `complete: false` and must not be read as "no violation".
 *
 * The explorer itself is tested (test_integrity_model.js) against tiny systems with known answers.
 */
import crypto from 'node:crypto';

/** Canonical JSON: object keys sorted, so equal states always produce equal text. */
export const stable = (value) => JSON.stringify(value, (_key, v) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const sorted = {};
    for (const key of Object.keys(v).sort()) sorted[key] = v[key];
    return sorted;
  }
  return v;
});

const digest = (text) => crypto.createHash('sha1').update(text).digest('hex');

/** Deep copy for building a successor state (actions must never mutate the state they are given). */
export const clone = (state) => structuredClone(state);

/**
 * @param {object} spec
 * @param {object} spec.init                     the initial state (plain JSON-able data)
 * @param {(state) => Array<[string, object]>} spec.actions   every enabled action: [description, successor state]
 * @param {Array<{ name: string, check: (state) => true | string }>} spec.invariants   true, or a message explaining the violation
 * @param {number} [spec.maxStates]
 * @returns {{ complete: boolean, states: number, transitions: number, maxDepth: number, violations: Array<{ invariant: string, detail: string, trace: Array<{ action: string, state: object }> }> }}
 */
export function explore({ init, actions, invariants, maxStates = 750_000 }) {
  const states = new Map();
  const parent = new Map();
  const depth = new Map();
  const violations = new Map();
  const queue = [];
  let transitions = 0;
  let complete = true;
  let maxDepth = 0;

  const traceTo = (key) => {
    const steps = [];
    for (let cursor = key; cursor !== null;) {
      const link = parent.get(cursor);
      steps.push({ action: link ? link[1] : '(initial state)', state: states.get(cursor) });
      cursor = link ? link[0] : null;
    }
    return steps.reverse();
  };
  const check = (key, state) => {
    for (const invariant of invariants) {
      if (violations.has(invariant.name)) continue;
      const result = invariant.check(state);
      if (result !== true) violations.set(invariant.name, { invariant: invariant.name, detail: String(result), trace: traceTo(key) });
    }
  };

  const initKey = digest(stable(init));
  states.set(initKey, init);
  parent.set(initKey, null);
  depth.set(initKey, 0);
  queue.push(initKey);
  check(initKey, init);

  for (let head = 0; head < queue.length; head += 1) {
    const key = queue[head];
    const state = states.get(key);
    for (const [name, next] of actions(state)) {
      transitions += 1;
      const nextKey = digest(stable(next));
      if (states.has(nextKey)) continue;
      if (states.size >= maxStates) { complete = false; continue; }
      states.set(nextKey, next);
      parent.set(nextKey, [key, name]);
      const d = depth.get(key) + 1;
      depth.set(nextKey, d);
      if (d > maxDepth) maxDepth = d;
      queue.push(nextKey);
      check(nextKey, next);
    }
  }
  return { complete, states: states.size, transitions, maxDepth, violations: [...violations.values()] };
}

/** True if `next` is exactly one of the successors the model offers from `state` under action `name`. */
export function isStep(actions, state, name, next) {
  const wanted = stable(next);
  return actions(state).some(([actionName, candidate]) => actionName === name && stable(candidate) === wanted);
}
