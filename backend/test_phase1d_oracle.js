/**
 * test_phase1d_oracle.js — the independent oracle, and the engine measured against it
 * (Phase 1D scaffold; pure, no database).
 *
 * Groups I (independent oracle), J (engine vs oracle), K (threshold boundaries) and the corrected
 * mathematical properties P1–P10.
 *
 * Every rule here is a MATHEMATICAL_FIXTURE. Passing proves the arithmetic, not any legal reading.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { oracleWage, HAND_VECTORS } from './test_support/wageOracle.js';
import { fixtureRule, engineLines, prng, randomCase } from './test_support/wageFixtures.js';
import { computeStatutoryWage } from './src/statutoryWage/wageEngine.js';
import * as Q from './src/statutoryWage/rational.js';

const FIELDS = ['includedPaise', 'allRemunerationPaise', 'poolPaise', 'unqualifiedPaise', 'thresholdAmountPaise', 'addBackPaise', 'wagePaise'];

// Mathematical fixtures run only in the explicit TEST context; omitting it would mean PRODUCTION.
const runEngine = ({ threshold, clauses, lines }) => computeStatutoryWage({ rule: fixtureRule({ threshold, clauses }), lines: engineLines(lines) }, { context: 'TEST' });
const totalsOf = (result) => Object.fromEntries(FIELDS.map((field) => [field, result.totals[field]]));
const q = Q.fromCanonical;

describe('the oracle is itself verified against hand-computed vectors', () => {
  for (const vector of HAND_VECTORS) {
    test(`oracle: ${vector.name}`, () => {
      assert.deepEqual(oracleWage(vector), vector.expected);
    });
  }

  test('the oracle shares no code with the engine', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./test_support/wageOracle.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from\s+['"][^'"]*src\//, 'the oracle imports nothing from src/');
    assert.doesNotMatch(source, /statutoryWage|rational\.js|wageEngine/, 'the oracle names none of the engine modules');
  });
});

describe('the engine reproduces every hand-computed vector exactly', () => {
  for (const vector of HAND_VECTORS) {
    test(`engine: ${vector.name}`, () => {
      assert.deepEqual(totalsOf(runEngine(vector)), vector.expected);
    });
  }
});

describe('engine versus oracle', () => {
  test('20,000 seeded random fixtures agree on every total, exactly', () => {
    const random = prng(20261013);
    for (let i = 0; i < 20000; i++) {
      const input = randomCase(random);
      const expected = oracleWage(input);
      const actual = totalsOf(runEngine(input));
      assert.deepEqual(actual, expected, `case ${i}: ${JSON.stringify(input)}`);
    }
  });

  test('exhaustive grid: every combination of small amounts, three thresholds and three clause shapes agrees', () => {
    let cases = 0;
    for (const threshold of ['1/2', '1/3', '3/10']) {
      for (let included = 0; included <= 9; included++) {
        for (let a = 0; a <= 9; a++) {
          for (let b = 0; b <= 5; b++) {
            const input = {
              threshold,
              clauses: { FIXTURE_A: { d: '1/1', p: '1/1' }, FIXTURE_B: { d: '1/1', p: '0/1' }, FIXTURE_C: { d: '1/2', p: '1/4' } },
              lines: [
                { amountPaise: included, parts: [{ portion: '1/1' }] },
                { amountPaise: a, parts: [{ clauseId: 'FIXTURE_A', portion: '1/1' }] },
                { amountPaise: b, parts: [{ clauseId: 'FIXTURE_B', portion: '1/2' }, { clauseId: 'FIXTURE_C', portion: '1/2' }] },
              ],
            };
            assert.deepEqual(totalsOf(runEngine(input)), oracleWage(input), JSON.stringify(input));
            cases += 1;
          }
        }
      }
    }
    assert.equal(cases, 3 * 10 * 10 * 6);
  });
});

describe('threshold boundaries (group K)', () => {
  const lines = (included, pool) => [
    { amountPaise: included, parts: [{ portion: '1/1' }] },
    { amountPaise: pool, parts: [{ clauseId: 'FIXTURE_A', portion: '1/1' }] },
  ];
  const run = (threshold, included, pool) => totalsOf(runEngine({ threshold, clauses: { FIXTURE_A: { d: '1/1', p: '1/1' } }, lines: lines(included, pool) }));

  test('below, exactly at and one paisa above the one-half threshold', () => {
    assert.equal(run('1/2', 10000, 9999).addBackPaise, '0/1');
    assert.equal(run('1/2', 10000, 10000).addBackPaise, '0/1', 'equality adds nothing back');
    assert.equal(run('1/2', 10000, 10001).addBackPaise, '1/2', 'one paisa above adds back half a paisa, exactly');
    assert.equal(run('1/2', 10000, 10001).wagePaise, '20001/2');
  });

  test('a non-one-half threshold: 3/10 and 2/5', () => {
    // t=3/10: pool P, included I: addBack = max(0, P - 3(I+P)/10) = max(0, 7P/10 - 3I/10); zero when 7P <= 3I.
    assert.equal(run('3/10', 7000, 3000).addBackPaise, '0/1');   // 7*3000=21000 = 3*7000 -> equality
    assert.equal(run('3/10', 7000, 3001).addBackPaise, '7/10');  // one paisa above: (7*3001-21000)/10 = 7/10
    assert.equal(run('2/5', 6000, 4000).addBackPaise, '0/1');    // 3*4000=12000 = 2*6000 -> equality
    assert.equal(run('2/5', 6000, 4001).addBackPaise, '3/5');    // (3*4001-12000)/5 = 3/5
  });

  test('the extreme thresholds: 0 adds the whole pool back, 1 never adds anything back', () => {
    assert.equal(run('0/1', 500, 700).addBackPaise, '700/1');
    assert.equal(run('1/1', 500, 700).addBackPaise, '0/1');
  });

  test('the comparison is exact at large magnitudes (no float rounding near the boundary)', () => {
    const big = 4503599627370495; // 2^52 - 1
    assert.equal(run('1/2', big, big).addBackPaise, '0/1');
    assert.equal(run('1/2', big, big + 1).addBackPaise, '1/2');
  });
});

describe('corrected mathematical properties P1-P10 (engine, random fixtures, exact)', () => {
  const random = prng(7);
  const cases = Array.from({ length: 3000 }, () => randomCase(random));
  const parsed = (result) => Object.fromEntries(FIELDS.map((field) => [field, q(result.totals[field])]));

  test('P1 non-negativity: W >= I >= 0 and addBack >= 0', () => {
    for (const input of cases) {
      const t = parsed(runEngine(input));
      assert.ok(Q.cmp(t.wagePaise, t.includedPaise) >= 0);
      assert.ok(Q.cmp(t.includedPaise, Q.ZERO) >= 0);
      assert.ok(Q.cmp(t.addBackPaise, Q.ZERO) >= 0);
    }
  });

  test('P2 pool within the threshold: W = I', () => {
    for (const input of cases) {
      const t = parsed(runEngine(input));
      if (Q.cmp(t.poolPaise, t.thresholdAmountPaise) <= 0) assert.equal(Q.toCanonical(t.wagePaise), Q.toCanonical(t.includedPaise));
    }
  });

  test('P3 pool above the threshold: W = I + P - t*R_all', () => {
    for (const input of cases) {
      const t = parsed(runEngine(input));
      if (Q.cmp(t.poolPaise, t.thresholdAmountPaise) > 0) {
        assert.equal(Q.toCanonical(t.wagePaise), Q.toCanonical(Q.sub(Q.add(t.includedPaise, t.poolPaise), t.thresholdAmountPaise)));
      }
    }
  });

  test('P4 bounds: I <= W <= R_all', () => {
    for (const input of cases) {
      const t = parsed(runEngine(input));
      assert.ok(Q.cmp(t.includedPaise, t.wagePaise) <= 0);
      assert.ok(Q.cmp(t.wagePaise, t.allRemunerationPaise) <= 0);
    }
  });

  test('P5 decomposition: R_all = I + sum(d*X), and sum(d*X) = P + U exactly', () => {
    for (const input of cases) {
      const result = runEngine(input);
      const t = parsed(result);
      const denominatorShare = Q.sum(result.clauses.map((clause) => q(clause.inDenominatorPaise)));
      assert.equal(Q.toCanonical(t.allRemunerationPaise), Q.toCanonical(Q.add(t.includedPaise, denominatorShare)));
      assert.equal(Q.toCanonical(denominatorShare), Q.toCanonical(Q.add(t.poolPaise, t.unqualifiedPaise)));
    }
  });

  test('P6 monotone in included remuneration: adding delta to an included line moves W by between (1-t)*delta and delta', () => {
    const delta = 137;
    for (const input of cases.slice(0, 1500)) {
      const base = parsed(runEngine(input));
      const bumped = { ...input, lines: [...input.lines, { lineId: 'L9999', amountPaise: delta, parts: [{ portion: '1/1' }] }] };
      const after = parsed(runEngine(bumped));
      const t = q(input.threshold);
      const moved = Q.sub(after.wagePaise, base.wagePaise);
      assert.ok(Q.cmp(moved, Q.mul(Q.sub(Q.ONE, t), Q.fromIntegerPaise(delta))) >= 0, 'at least (1-t)*delta');
      assert.ok(Q.cmp(moved, Q.fromIntegerPaise(delta)) <= 0, 'at most delta');
    }
  });

  test('P7 homogeneity before rounding: scaling every amount by an integer k scales every total by exactly k', () => {
    for (const k of [2, 3, 7, 1000]) {
      for (const input of cases.slice(0, 600)) {
        const scaled = { ...input, lines: input.lines.map((line) => ({ ...line, amountPaise: BigInt(line.amountPaise) * BigInt(k) })) };
        const a = parsed(runEngine(input));
        const b = parsed(runEngine(scaled));
        for (const field of FIELDS) assert.equal(Q.toCanonical(b[field]), Q.toCanonical(Q.mul(a[field], Q.ratio(k, 1))), `${field} x${k}`);
      }
    }
  });

  test('P8 order independence: shuffling the lines changes no total and not even the result hash', () => {
    const random2 = prng(99);
    for (const input of cases.slice(0, 800)) {
      const shuffled = { ...input, lines: [...input.lines].sort(() => random2() - 0.5) };
      const a = runEngine(input);
      const b = runEngine(shuffled);
      assert.deepEqual(a.totals, b.totals);
      assert.equal(a.resultHash, b.resultHash);
    }
  });

  test('P9 split invariance: splitting a line into two with the same classification changes no total', () => {
    for (const input of cases.slice(0, 800)) {
      const [first, ...rest] = input.lines;
      if (BigInt(first.amountPaise) < 2n) continue;
      const left = BigInt(first.amountPaise) / 2n;
      const right = BigInt(first.amountPaise) - left;
      const split = { ...input, lines: [{ ...first, lineId: 'L0000a', amountPaise: left }, { ...first, lineId: 'L0000b', amountPaise: right }, ...rest] };
      assert.deepEqual(totalsOf(runEngine(split)), totalsOf(runEngine(input)));
    }
  });

  test('P10 identity: W >= (1-t)*R_all - U, with equality exactly when P >= t*R_all', () => {
    for (const input of cases) {
      const t = parsed(runEngine(input));
      const rate = q(input.threshold);
      const lower = Q.sub(Q.mul(Q.sub(Q.ONE, rate), t.allRemunerationPaise), t.unqualifiedPaise);
      assert.ok(Q.cmp(t.wagePaise, lower) >= 0);
      const equal = Q.cmp(t.wagePaise, lower) === 0;
      assert.equal(equal, Q.cmp(t.poolPaise, t.thresholdAmountPaise) >= 0);
    }
  });
});

describe('the engine does not assume R_all = I + P or W = max(I, (1-t)*R_all)', () => {
  test('a clause that is in the denominator but not the pool breaks both shortcuts, and the engine is still exact', () => {
    // I=10000, A(d=1,p=1)=6000, B(d=1,p=0)=5000, t=1/2. R_all = 21000 (not I + P = 16000); W = 10000.
    const result = totalsOf(runEngine(HAND_VECTORS[5]));
    assert.equal(result.allRemunerationPaise, '21000/1');
    assert.notEqual(result.allRemunerationPaise, '16000/1');
    // max(I, (1-t)*R_all) = max(10000, 10500) = 10500, which is NOT the wage the model gives.
    assert.equal(result.wagePaise, '10000/1');
  });
});
