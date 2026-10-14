/**
 * test_phase1d_rational.js — exact rational arithmetic, canonical serialization and hashing
 * (Phase 1D scaffold; pure, no database).
 *
 * Group G (exact rational math) and the serialization/hash-determinism part of group P.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import * as Q from './src/statutoryWage/rational.js';
import { canonicalJson, hashCanonical, sha256Hex, CanonicalizationError, CANONICAL_UNSUPPORTED_VALUE, CANONICAL_MAX_DEPTH } from './src/statutoryWage/canonical.js';
import { StatutoryWageError, STATUTORY_WAGE_ERROR_CODES as C } from './src/statutoryWage/errors.js';

const thrown = (fn) => { try { fn(); } catch (error) { return error; } return null; };
const assertCode = (fn, code) => {
  const error = thrown(fn);
  assert.ok(error instanceof StatutoryWageError, `expected a StatutoryWageError(${code}), got ${error && error.message}`);
  assert.equal(error.code, code);
};
const q = (text) => Q.fromCanonical(text);

describe('rational: normalization and canonical form', () => {
  test('values are reduced, the denominator is positive, and the sign is on the numerator', () => {
    assert.equal(Q.toCanonical(Q.rat(6n, 8n)), '3/4');
    assert.equal(Q.toCanonical(Q.rat(-6n, 8n)), '-3/4');
    assert.equal(Q.toCanonical(Q.rat(6n, -8n)), '-3/4');
    assert.equal(Q.toCanonical(Q.rat(-6n, -8n)), '3/4');
    assert.equal(Q.toCanonical(Q.rat(10n)), '10/1');
  });

  test('zero has exactly one representation, whatever produced it', () => {
    for (const zero of [Q.rat(0n, 5n), Q.rat(0n, -7n), Q.sub(q('3/4'), q('3/4')), Q.mul(q('5/9'), Q.ZERO), Q.rat(0)]) {
      assert.equal(Q.toCanonical(zero), '0/1');
      assert.equal(zero.d, 1n);
    }
  });

  test('0.75% is 3/400 and 3.25% is 13/400 in lowest terms', () => {
    assert.equal(Q.toCanonical(Q.ratio(75, 10000)), '3/400');
    assert.equal(Q.toCanonical(Q.ratio(325, 10000)), '13/400');
    assert.equal(Q.toCanonical(Q.ratio(12, 100)), '3/25');
  });

  test('a zero denominator and a non-integer are rejected, not coerced', () => {
    assertCode(() => Q.rat(1n, 0n), C.RATIONAL_INVALID);
    assertCode(() => Q.rat(1.5, 1), C.RATIONAL_INVALID);
    assertCode(() => Q.div(q('1/2'), Q.ZERO), C.RATIONAL_INVALID);
    assertCode(() => Q.add({ n: 1, d: 2 }, q('1/2')), C.RATIONAL_INVALID);
  });

  test('integer paise enter as exact rationals; floats and unsafe integers do not', () => {
    assert.equal(Q.toCanonical(Q.fromIntegerPaise(123456)), '123456/1');
    assert.equal(Q.toCanonical(Q.fromIntegerPaise(123456n)), '123456/1');
    assert.equal(Q.toCanonical(Q.fromIntegerPaise(0)), '0/1');
    for (const bad of [10.5, 0.1, NaN, Infinity, '100', null, undefined, 2 ** 53]) assertCode(() => Q.fromIntegerPaise(bad), C.INPUT_AMOUNT_NOT_INTEGER_PAISE);
  });
});

describe('rational: the parser accepts only the canonical string', () => {
  test('canonical strings round-trip exactly', () => {
    for (const text of ['0/1', '1/1', '-1/1', '3/4', '-3/4', '13/400', '9007199254740991/1', '1/9007199254740991', '123456789012345678901234567891/2']) {
      assert.equal(Q.toCanonical(Q.fromCanonical(text)), text);
    }
  });

  test('every non-canonical encoding is rejected, never silently normalized', () => {
    for (const bad of ['6/8', '0/5', '0/0', '3/-4', '+3/4', ' 3/4', '3/4 ', '3', '0.75', '1e2', '', '/4', '3/', '03/4', '3/04', '-0/1', '--3/4', '3/4/5', 'a/b', '１/２']) {
      assertCode(() => Q.fromCanonical(bad), C.RATIONAL_NOT_CANONICAL);
    }
    for (const bad of [null, undefined, 3, 0.75, 3n, {}, []]) assertCode(() => Q.fromCanonical(bad), C.RATIONAL_NOT_CANONICAL);
  });

  test('negative intermediates are representable and serialize with the sign on the numerator', () => {
    const negative = Q.sub(q('1/3'), q('1/2'));
    assert.equal(Q.toCanonical(negative), '-1/6');
    assert.equal(Q.isNegative(negative), true);
    assert.equal(Q.toCanonical(Q.max(Q.ZERO, negative)), '0/1');
  });
});

describe('rational: exact arithmetic', () => {
  test('hand-computed sums, differences, products and quotients', () => {
    assert.equal(Q.toCanonical(Q.add(q('1/3'), q('1/6'))), '1/2');
    assert.equal(Q.toCanonical(Q.sub(q('1/2'), q('1/3'))), '1/6');
    assert.equal(Q.toCanonical(Q.mul(q('3/400'), q('790000/1'))), '5925/1');
    assert.equal(Q.toCanonical(Q.mul(q('13/400'), q('790000/1'))), '25675/1');
    assert.equal(Q.toCanonical(Q.div(q('3/4'), q('3/8'))), '2/1');
    assert.equal(Q.toCanonical(Q.sum([q('1/2'), q('1/3'), q('1/6')])), '1/1');
  });

  test('comparison is exact: no floating-point equality tricks', () => {
    // 0.1 + 0.2 !== 0.3 in floating point; as rationals it is exact.
    assert.equal(Q.eq(Q.add(q('1/10'), q('1/5')), q('3/10')), true);
    assert.equal(Q.cmp(q('1/3'), q('333333333333/1000000000000')), 1);
    assert.equal(Q.cmp(q('20001/2'), q('10000/1')), 1);
    assert.equal(Q.cmp(q('10000/1'), Q.rat(20000n, 2n)), 0);
    assert.equal(Q.lt(q('-1/2'), q('-1/3')), true);
  });

  test('exhaustive small grid: field identities hold exactly', () => {
    const values = [];
    for (let n = -6; n <= 6; n++) for (let d = 1; d <= 6; d++) values.push(Q.rat(BigInt(n), BigInt(d)));
    let checked = 0;
    for (const a of values) {
      assert.equal(Q.toCanonical(Q.add(a, Q.ZERO)), Q.toCanonical(a));
      assert.equal(Q.toCanonical(Q.mul(a, Q.ONE)), Q.toCanonical(a));
      assert.equal(Q.toCanonical(Q.sub(a, a)), '0/1');
      for (const b of values) {
        assert.equal(Q.toCanonical(Q.add(a, b)), Q.toCanonical(Q.add(b, a)), 'addition commutes');
        assert.equal(Q.toCanonical(Q.mul(a, b)), Q.toCanonical(Q.mul(b, a)), 'multiplication commutes');
        assert.equal(Q.cmp(a, b) + Q.cmp(b, a), 0, 'comparison is antisymmetric');
        assert.equal(Q.toCanonical(Q.sub(Q.add(a, b), b)), Q.toCanonical(a), 'add then subtract returns the original');
        if (!Q.isZero(b)) assert.equal(Q.toCanonical(Q.div(Q.mul(a, b), b)), Q.toCanonical(a), 'multiply then divide returns the original');
        checked += 1;
      }
    }
    assert.equal(checked, 78 * 78, 'every ordered pair of the 78 grid values was exercised');
  });

  test('mathematically equal values have one serialization, however they were built', () => {
    const builds = [q('1/2'), Q.rat(2n, 4n), Q.rat(500n, 1000n), Q.add(q('1/4'), q('1/4')), Q.mul(q('1/2'), Q.ONE), Q.div(q('1/1'), q('2/1')), Q.ratio(50, 100)];
    assert.equal(new Set(builds.map(Q.toCanonical)).size, 1);
    assert.equal(new Set(builds.map((value) => hashCanonical({ v: Q.toCanonical(value) }))).size, 1);
  });

  test('huge values stay exact', () => {
    const big = Q.rat(10n ** 60n + 7n, 3n);
    assert.equal(Q.toCanonical(Q.sub(Q.add(big, q('1/7')), q('1/7'))), Q.toCanonical(big));
  });
});

describe('canonical JSON and hashing', () => {
  test('keys are sorted and the encoding is compact and deterministic', () => {
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 'x', c: null }], e: true }), '{"a":[2,{"c":null,"d":"x"}],"b":1,"e":true}');
    assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  });

  test('undefined, BigInt, floats and unsupported types are rejected, never substituted', () => {
    for (const bad of [{ a: undefined }, { a: 1n }, { a: 1.5 }, { a: NaN }, { a: () => 1 }, { a: Symbol('x') }]) {
      assert.throws(() => canonicalJson(bad), TypeError);
    }
  });

  test('an absent key and a null value hash differently (absence is not null, and not undefined)', () => {
    assert.notEqual(hashCanonical({ a: 1 }), hashCanonical({ a: 1, b: null }));
  });

  test('SHA-256 matches the published vectors', () => {
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(sha256Hex(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('final hardening 2 — canonical JSON rejects every representation that has no single canonical text', () => {
  const rejects = (value) => {
    let error = null;
    try { canonicalJson(value); } catch (e) { error = e; }
    assert.ok(error instanceof CanonicalizationError, `expected a CanonicalizationError, got ${error}`);
    assert.ok(error instanceof TypeError, 'still a TypeError for callers that catch TypeError');
    assert.equal(error.code, CANONICAL_UNSUPPORTED_VALUE);
    assert.equal(error.name, 'CanonicalizationError');
    assert.match(error.message, /^CANONICAL_UNSUPPORTED_VALUE: /);
    assert.equal(typeof error.path, 'string');
    return error;
  };

  test('sparse arrays and arrays with extra properties, symbol keys or accessor items', () => {
    rejects([1, , 3]); // eslint-disable-line no-sparse-arrays
    rejects(new Array(3));
    rejects({ a: [1, , 3] }); // eslint-disable-line no-sparse-arrays
    assert.equal(rejects(Object.assign([1, 2], { extra: true })).path, '$');
    rejects(Object.assign([1, 2], { [Symbol('s')]: 1 }));
    const accessorItem = rejects(Object.defineProperty([1, 2], '0', { get() { return 1; }, enumerable: true }));
    assert.match(accessorItem.message, /a hole or an accessor/);
    assert.equal(accessorItem.path, '$[0]');
    const arr = [1, 2, 3]; delete arr[1];
    rejects(arr);
    assert.equal(canonicalJson([1, [2, [3]], []]), '[1,[2,[3]],[]]', 'dense arrays are fine');
  });

  test('undefined anywhere, functions, symbols, BigInt, floats, NaN, infinities and negative zero', () => {
    for (const bad of [undefined, [undefined], { a: undefined }, { a: { b: [undefined] } }, () => 1, { a: () => 1 }, Symbol('x'), { a: Symbol('x') }, 1n, { a: 1n }, 1.5, { a: 0.1 }, NaN, Infinity, -Infinity, { a: NaN }, -0, { a: -0 }, [-0], 2 ** 53, -(2 ** 53)]) rejects(bad);
    assert.equal(canonicalJson(0), '0');
    assert.equal(canonicalJson(Number.MAX_SAFE_INTEGER), '9007199254740991');
    assert.equal(canonicalJson(-Number.MAX_SAFE_INTEGER), '-9007199254740991');
  });

  test('objects that are not plain data: Date, Map, Set, typed arrays, boxed values, class instances, caller prototypes', () => {
    class Thing { constructor() { this.a = 1; } }
    for (const bad of [new Date(0), new Map([[1, 2]]), new Set([1]), new Uint8Array([1, 2]), new ArrayBuffer(2), new Number(1), new String('x'), new Boolean(false), new Thing(), Object.create({ a: 1 }), /x/, new Error('x'), { a: new Date(0) }, [new Map()]]) rejects(bad);
    assert.equal(canonicalJson(Object.assign(Object.create(null), { b: 1, a: 2 })), '{"a":2,"b":1}');
  });

  test('symbol keys, non-enumerable properties and accessor properties', () => {
    assert.match(rejects({ [Symbol('s')]: 1 }).message, /symbol key/, 'a symbol key is named as such');
    rejects(Object.defineProperty({ a: 1 }, 'hidden', { value: 2, enumerable: false }));
    rejects({ get a() { return 1; } });
    rejects(Object.defineProperty({}, 'a', { get() { return 1; }, enumerable: true }));
  });

  test('strings that are not well-formed Unicode, as values or as keys', () => {
    rejects('\ud800');
    rejects({ a: 'x\udc00y' });
    rejects({ '\ud800': 1 });
    rejects(['ok', '\udbff']);
    assert.equal(canonicalJson('café \u{1f600}'), JSON.stringify('café \u{1f600}'), 'a well-formed astral character is fine');
    assert.notEqual(canonicalJson('é'), canonicalJson('é'), 'no Unicode normalization is applied: different code points stay different');
  });

  test('cycles and excessive nesting', () => {
    const self = {}; self.self = self;
    assert.match(rejects(self).message, /a cycle/, 'a cycle is named as a cycle, not merely as deep nesting');
    const loop = [1]; loop.push(loop);
    assert.match(rejects(loop).message, /a cycle/);
    const mutual = { a: {} }; mutual.a.b = { c: mutual };
    assert.match(rejects(mutual).message, /a cycle/);
    let ok = 'leaf'; for (let i = 0; i < CANONICAL_MAX_DEPTH; i++) ok = [ok];
    assert.doesNotThrow(() => canonicalJson(ok));
    rejects([ok]);
    // the same object twice (not a cycle) is fine
    const shared = { x: 1 };
    assert.equal(canonicalJson({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}');
  });

  test('the error says where the problem is', () => {
    assert.equal(rejects({ a: { b: [1, { c: 1.5 }] } }).path, '$.a.b[1].c');
    assert.equal(rejects({ a: undefined }).path, '$.a');
    assert.match(rejects({ a: undefined }).message, /the key "a" is undefined/, 'an undefined member is named as such, not just as an unsupported type');
  });

  test('hashCanonical inherits the strictness: the same inputs are rejected, so nothing ambiguous is ever hashed', () => {
    for (const bad of [[1, , 3], { a: undefined }, new Date(0), -0, '\ud800']) assert.throws(() => hashCanonical(bad), CanonicalizationError); // eslint-disable-line no-sparse-arrays
  });
});
