/**
 * Exact rational arithmetic for the statutory-wage scaffold.
 *
 * Representation: a frozen object { n, d } where n is a BigInt (any sign) and d is a positive
 * BigInt, always in lowest terms. Zero has one representation, 0/1. No floating-point number is
 * ever created from, or compared against, a rational.
 *
 * Canonical serialization is the string "n/d": the sign (only ever "-") is on the numerator, the
 * denominator is always present (integers serialize as "5/1"), digits are base-10 ASCII with no
 * leading zeros and no "+" sign, and zero is exactly "0/1". The parser accepts ONLY that form: it
 * never silently normalizes, so two different encodings of one value cannot both be stored and
 * hashed. Mathematically equal values therefore have exactly one serialized representation.
 *
 * Nothing here rounds. Rounding of a statutory amount is a separate, gated stage that no code in
 * this module performs.
 */

import { fail, STATUTORY_WAGE_ERROR_CODES as C } from './errors.js';

const gcd = (a, b) => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) { [x, y] = [y, x % y]; }
  return x;
};

/** Build a normalized rational from two BigInts (or integer-valued inputs convertible to BigInt). */
export function rat(n, d = 1n) {
  let num; let den;
  try {
    num = typeof n === 'bigint' ? n : BigInt(n);
    den = typeof d === 'bigint' ? d : BigInt(d);
  } catch {
    return fail(C.RATIONAL_INVALID, 'a rational needs integer numerator and denominator');
  }
  if (den === 0n) fail(C.RATIONAL_INVALID, 'a rational cannot have a zero denominator');
  if (num === 0n) return ZERO;
  const sign = den < 0n ? -1n : 1n;
  const g = gcd(num, den);
  return Object.freeze({ n: (sign * num) / g, d: (sign * den) / g });
}

export const ZERO = Object.freeze({ n: 0n, d: 1n });
export const ONE = Object.freeze({ n: 1n, d: 1n });

export const isRational = (value) =>
  !!value && typeof value === 'object' && typeof value.n === 'bigint' && typeof value.d === 'bigint' && value.d > 0n;

const assertRational = (value) => {
  if (!isRational(value)) fail(C.RATIONAL_INVALID, 'expected a rational');
  return value;
};

export const add = (a, b) => rat(assertRational(a).n * b.d + assertRational(b).n * a.d, a.d * b.d);
export const sub = (a, b) => rat(assertRational(a).n * b.d - assertRational(b).n * a.d, a.d * b.d);
export const mul = (a, b) => rat(assertRational(a).n * assertRational(b).n, a.d * b.d);
export const div = (a, b) => {
  assertRational(a); assertRational(b);
  if (b.n === 0n) fail(C.RATIONAL_INVALID, 'division by zero');
  return rat(a.n * b.d, a.d * b.n);
};

/** -1, 0 or 1. Compares by cross-multiplication; no division, no floating point. */
export const cmp = (a, b) => {
  const left = assertRational(a).n * assertRational(b).d;
  const right = b.n * a.d;
  return left < right ? -1 : left > right ? 1 : 0;
};

export const eq = (a, b) => cmp(a, b) === 0;
export const lt = (a, b) => cmp(a, b) < 0;
export const lte = (a, b) => cmp(a, b) <= 0;
export const gt = (a, b) => cmp(a, b) > 0;
export const isZero = (a) => assertRational(a).n === 0n;
export const isNegative = (a) => assertRational(a).n < 0n;
export const max = (a, b) => (cmp(a, b) >= 0 ? a : b);
export const min = (a, b) => (cmp(a, b) <= 0 ? a : b);
export const sum = (values) => values.reduce((total, value) => add(total, value), ZERO);

const CANONICAL = /^(0|-?[1-9][0-9]*)\/([1-9][0-9]*)$/;

/** Canonical "n/d" string. */
export function toCanonical(value) {
  assertRational(value);
  return `${value.n}/${value.d}`;
}

/**
 * Parse a canonical string. Rejects every non-canonical encoding ("6/8", "0/5", "3/-4", "+3/4",
 * " 3/4", "3", "0.75", "1e2", "") with RATIONAL_NOT_CANONICAL.
 */
export function fromCanonical(text) {
  if (typeof text !== 'string') fail(C.RATIONAL_NOT_CANONICAL, 'a canonical rational is a string "n/d"');
  const match = CANONICAL.exec(text);
  if (!match) fail(C.RATIONAL_NOT_CANONICAL, `"${text}" is not a canonical rational`, { text });
  const value = rat(BigInt(match[1]), BigInt(match[2]));
  if (toCanonical(value) !== text) fail(C.RATIONAL_NOT_CANONICAL, `"${text}" is not in lowest terms`, { text });
  return value;
}

/** An integer number of paise (a JS safe integer or a BigInt) as a rational. */
export function fromIntegerPaise(amount) {
  if (typeof amount === 'bigint') return rat(amount, 1n);
  if (typeof amount === 'number' && Number.isSafeInteger(amount)) return rat(BigInt(amount), 1n);
  return fail(C.INPUT_AMOUNT_NOT_INTEGER_PAISE, 'an amount must be an integer number of paise', { amount: String(amount) });
}

/** The rational for a ratio of two non-negative integers, such as a percentage in lowest terms. */
export const ratio = (numerator, denominator) => rat(BigInt(numerator), BigInt(denominator));
