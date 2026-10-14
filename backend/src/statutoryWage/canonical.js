/**
 * Canonical JSON and SHA-256 for the statutory-wage scaffold.
 *
 * The scaffold's own records (rule definitions, results, register entries) are hashed over this
 * canonical form: object keys sorted, no insignificant whitespace, strings, booleans, null and safe
 * integers only. Rationals travel as their canonical "n/d" strings, never as numbers.
 *
 * Anything with no single canonical text is REJECTED with a CanonicalizationError (code
 * CANONICAL_UNSUPPORTED_VALUE), never coerced, skipped or substituted:
 *   - undefined (as a value or an object member: "absent" and "present but undefined" must not be
 *     confused), functions, symbols, BigInt;
 *   - numbers that are not safe integers (floats, NaN, infinities) and negative zero;
 *   - strings that are not well-formed Unicode (a lone surrogate);
 *   - sparse arrays (holes), arrays carrying extra properties;
 *   - objects that are not plain data (Date, Map, Set, typed arrays, boxed values, class instances),
 *     objects with symbol keys, non-enumerable properties or accessor properties;
 *   - cycles, and nesting deeper than CANONICAL_MAX_DEPTH.
 * CanonicalizationError extends TypeError, so a caller that catches TypeError still catches it.
 */

import crypto from 'node:crypto';

export const CANONICAL_UNSUPPORTED_VALUE = 'CANONICAL_UNSUPPORTED_VALUE';
export const CANONICAL_MAX_DEPTH = 64;

export class CanonicalizationError extends TypeError {
  constructor(message, path) {
    super(`${CANONICAL_UNSUPPORTED_VALUE}: ${message} (at ${path})`);
    this.name = 'CanonicalizationError';
    this.code = CANONICAL_UNSUPPORTED_VALUE;
    this.path = path;
  }
}

const unsupported = (message, path) => { throw new CanonicalizationError(message, path); };

/** True when every surrogate is paired (equivalent to String.prototype.isWellFormed, which needs Node 20+). */
export const isWellFormedText = (text) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);

const wellFormed = (text, path) => {
  if (!isWellFormedText(text)) unsupported('a string with a lone surrogate has no single UTF-8 form', path);
  return JSON.stringify(text);
};

function write(value, path, depth, active) {
  if (depth > CANONICAL_MAX_DEPTH) unsupported(`nesting deeper than ${CANONICAL_MAX_DEPTH} levels`, path);
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string': return wellFormed(value, path);
    case 'boolean': return JSON.stringify(value);
    case 'number':
      if (!Number.isSafeInteger(value)) unsupported('only safe integers are allowed as numbers', path);
      if (Object.is(value, -0)) unsupported('negative zero is not canonical', path);
      return String(value);
    case 'object': {
      if (active.has(value)) unsupported('a cycle', path);
      active.add(value);
      try {
        if (Array.isArray(value)) {
          const keys = Reflect.ownKeys(value);
          if (keys.length !== value.length + 1) unsupported('a sparse array, or an array carrying extra properties or symbol keys', path);
          const items = [];
          for (let i = 0; i < value.length; i++) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
            if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) unsupported('an array item that is a hole or an accessor', `${path}[${i}]`);
            items.push(write(descriptor.value, `${path}[${i}]`, depth + 1, active));
          }
          return `[${items.join(',')}]`;
        }
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) unsupported('only plain objects and arrays are allowed (no Date, Map, Set, typed array, boxed value or class instance)', path);
        const keys = Reflect.ownKeys(value);
        if (keys.some((key) => typeof key === 'symbol')) unsupported('an object with a symbol key', path);
        const parts = keys.sort().map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!('value' in descriptor) || !descriptor.enumerable) unsupported(`the property "${key}" is an accessor or not enumerable`, `${path}.${key}`);
          if (descriptor.value === undefined) unsupported(`the key "${key}" is undefined`, `${path}.${key}`);
          return `${wellFormed(key, path)}:${write(descriptor.value, `${path}.${key}`, depth + 1, active)}`;
        });
        return `{${parts.join(',')}}`;
      } finally {
        active.delete(value);
      }
    }
    default:
      return unsupported(`unsupported type ${typeof value}`, path);
  }
}

export const canonicalJson = (value) => {
  try {
    return write(value, '$', 0, new Set());
  } catch (error) {
    if (error instanceof CanonicalizationError) throw error;
    return unsupported(`a value that cannot be read safely (${error && error.name ? error.name : 'unknown error'})`, '$');
  }
};

export const sha256Hex = (input) =>
  crypto.createHash('sha256').update(typeof input === 'string' ? Buffer.from(input, 'utf8') : input).digest('hex');

export const hashCanonical = (value) => sha256Hex(canonicalJson(value));

export const isSha256Hex = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
