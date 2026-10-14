/**
 * Execution context for the isolated statutory-wage scaffold.
 *
 * Two contexts exist: TEST (mathematical fixtures may be evaluated, to prove the arithmetic) and
 * PRODUCTION. The context is selected by an explicit option and OMITTING IT MEANS PRODUCTION: nothing
 * becomes usable as a fixture by accident. Any other value is a programming error and throws a named
 * validation error; it is never coerced to either context.
 *
 * Nothing in a rule definition, a line, a record or a decision can select a context. A rule or record
 * that labels itself a fixture, or approved, or production, changes nothing here.
 */

import { fail, STATUTORY_WAGE_ERROR_CODES as C } from './errors.js';
import { guardPublic } from './ownData.js';

export const EXECUTION_CONTEXTS = Object.freeze({ TEST: 'TEST', PRODUCTION: 'PRODUCTION' });

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/** Validate a requested context. `undefined` (omitted) is PRODUCTION. Anything not on the allowlist throws. */
export function resolveExecutionContext(requested) {
  if (requested === undefined) return EXECUTION_CONTEXTS.PRODUCTION;
  if (requested === EXECUTION_CONTEXTS.TEST || requested === EXECUTION_CONTEXTS.PRODUCTION) return requested;
  return fail(C.EXECUTION_CONTEXT_INVALID, `unknown execution context ${JSON.stringify(requested)}; allowed: TEST, PRODUCTION`, { allowed: Object.keys(EXECUTION_CONTEXTS) });
}

/**
 * The options argument of an engine function: omitted, or a plain object whose only key is `context`.
 * An unrecognized option key throws rather than being ignored.
 */
export const contextFromOptions = guardPublic('contextFromOptions', contextFromOptionsCore);

function contextFromOptionsCore(options) {
  if (options === undefined) return EXECUTION_CONTEXTS.PRODUCTION;
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    return fail(C.EXECUTION_CONTEXT_INVALID, 'options must be omitted or an object with an optional context');
  }
  for (const key of Object.keys(options)) {
    if (key !== 'context') fail(C.EXECUTION_CONTEXT_INVALID, `unknown option "${key}"; only context is supported`);
  }
  if (!hasOwn(options, 'context')) return resolveExecutionContext(undefined);
  const descriptor = Object.getOwnPropertyDescriptor(options, 'context');
  if (!('value' in descriptor)) fail(C.INPUT_MALFORMED, 'the context option is an accessor: reading it would run caller code'); // as the resolvers do
  return resolveExecutionContext(descriptor.value);
}
