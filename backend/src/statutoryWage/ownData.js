/**
 * Own-data sanitizer: the one place where caller input becomes something the scaffold may read.
 *
 * Every public entry point passes its external input through `toOwnData` before anything is read.
 * The result is a deep copy in which every plain object has a NULL prototype and only its own,
 * enumerable, data properties. Reading a property that the caller did not supply therefore yields
 * `undefined`, whatever `Object.prototype` (or any other prototype) has been polluted with: an
 * inherited value can never satisfy a required property, and the rule applies at every depth.
 *
 * Anything that is not plain data is REPLACED by an inert NotPlainData marker (never passed through):
 * a Date, Map, class instance, object with a caller-built prototype, sparse array, array with extra
 * or symbol-keyed properties. The marker is neither a plain object nor an array, so every validator
 * rejects it, and the original, which could be a Proxy answering differently on each read, is never
 * read again. Input that cannot be read safely at all (an accessor property, a symbol or
 * non-enumerable property on an object, a cycle, nesting deeper than MAX_DEPTH) is a named
 * INPUT_MALFORMED error: reading a getter would run caller code.
 */

import { fail, StatutoryWageError, STATUTORY_WAGE_ERROR_CODES as C } from './errors.js';
import { CanonicalizationError } from './canonical.js';

export const MAX_DEPTH = 64;

/** Stands in for any value that was not plain data. It is rejected by every validator. */
export class NotPlainData {
  constructor(kind) {
    this.kind = kind;
    Object.freeze(this);
  }
}

const isPlainProto = (value) => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

function copy(value, depth, active) {
  if (value === null || typeof value !== 'object') return value;
  const isArray = Array.isArray(value);
  if (!isArray && !isPlainProto(value)) return new NotPlainData('an object that is not plain data');
  if (depth > MAX_DEPTH) fail(C.INPUT_MALFORMED, `the input is nested deeper than ${MAX_DEPTH} levels`);
  if (active.has(value)) fail(C.INPUT_MALFORMED, 'the input contains a cycle');
  active.add(value);
  try {
    if (isArray) {
      // `length` is read exactly ONCE: a Proxy could answer differently on each read and leave holes in the copy.
      const length = value.length;
      // A sparse array, or one carrying extra or symbol-keyed properties, is not an array of items.
      if (!Number.isSafeInteger(length) || Reflect.ownKeys(value).length !== length + 1) return new NotPlainData('a sparse array or an array with extra properties');
      const out = [];
      for (let i = 0; i < length; i++) out.push(copy(dataValue(value, String(i)), depth + 1, active));
      return out;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== Object.keys(value).length) fail(C.INPUT_MALFORMED, 'the input has a symbol or non-enumerable property');
    const out = Object.create(null);
    for (const key of keys) out[key] = copy(dataValue(value, key), depth + 1, active);
    return out;
  } finally {
    active.delete(value);
  }
}

function dataValue(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !('value' in descriptor)) fail(C.INPUT_MALFORMED, `the input property "${key}" is an accessor: reading it would run caller code`);
  return descriptor.value;
}

/** Deep copy of plain data into null-prototype objects with own properties only; anything else becomes a NotPlainData marker. */
export const toOwnData = (value) => copy(value, 0, new Set());

/**
 * Wrap a public function so that an unexpected crash (a hostile Proxy trap, a throwing callback ...) is a named,
 * fail-closed error and never the caller's raw one. Named errors pass through unchanged.
 */
export const guardPublic = (name, fn) => function guarded(...args) {
  try {
    return fn(...args);
  } catch (error) {
    if (error instanceof StatutoryWageError || error instanceof CanonicalizationError) throw error;
    return fail(C.INPUT_MALFORMED, `${name}: the input could not be processed safely (${error && error.name ? error.name : 'unknown error'})`, { cause: error && error.name ? error.name : null });
  }
};
