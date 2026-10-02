/**
 * test_rounding.js — Wave 3.5 Phase 1A: rounding is centralized, not changed.
 *
 * Runner: node:test. Pure: no database, no HTTP.
 *
 * These are CHARACTERIZATION tests. The golden values below were captured from
 * the implementations that existed BEFORE src/utils/money.js was introduced, and
 * the oracle functions are the old private expressions copied verbatim. They
 * must pass against the old code and against the centralized code alike: that
 * is what "no numeric change" means.
 *
 *   - the old expressions (oracles) against every money.js export, over a large
 *     deterministic grid plus the awkward values: halves, negatives, zero,
 *     null, undefined, NaN, strings
 *   - null / undefined / NaN semantics, per variant (they differ on purpose)
 *   - statutory rounding in every rule-version mode
 *   - the public functions that consume rounding (statutory calculator,
 *     proration, the evaluator's exported rounding), against captured goldens
 *   - display formatting
 *   - the no-epsilon variant against the epsilon variant on the domain it serves
 *   - determinism
 *
 * Call sites that are private (payslip, insights, payroll run, snapshot
 * service) are covered by the existing suites, which compare their output.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'rounding-test-secret-that-is-long-enough-to-use';

const money = await import('./src/utils/money.js');
const { default: statutory } = await import('./src/services/complianceCalculationService.js');
const { proratedAmount, computePayPeriodDays, payrollBasisFrom } = await import('./src/utils/payBasis.js');
const { roundToPaise: evaluatorRound } = await import('./src/services/compensationEvaluator.js');

// ─── Oracles: the old private expressions, verbatim ──────────────────────────
const oracleCoercing = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const oracleStrict = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const oracleNoEpsilon = (x) => Math.round(x * 100) / 100;
const oracleFactor = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 1e6) / 1e6;
const oracleStatutory = (amount, mode = 'PAISE') => {
  const paise = oracleStrict(amount);
  if (mode === 'NEAREST_RUPEE') return Math.round(paise);
  if (mode === 'CEIL_RUPEE') return Math.ceil(paise);
  return paise;
};

const same = (actual, expected, label) => assert.ok(
  Object.is(actual, expected),
  `${label}: expected ${Object.is(expected, -0) ? '-0' : expected}, got ${Object.is(actual, -0) ? '-0' : actual}`
);

// Deterministic values: whole paise, half paise, and thirds, up to 200,000.
const numericGrid = () => {
  const values = [];
  for (let paise = 0; paise <= 20000000; paise += 997) {
    values.push(paise / 100, paise / 100 + 0.005, -paise / 100, -(paise / 100) - 0.005, paise / 300);
  }
  for (let i = 0; i < 2000; i += 1) values.push(i / 1000, -i / 1000, i * 1.005, 1.005 * i / 7);
  return values;
};

const AWKWARD = [
  1.005, 2.675, 1.255, 8.345, 0.285, 0.005, -0.005, 0.0049999, 0.0050001, -0.004, 1.5, -1.5, 0.5, 1e15 + 0.5, 1e-9,
  0, -0, undefined, null, NaN, '12.345', '', '0', '-7.125', Infinity, -Infinity, true, false, [], {},
];

describe('money.js reproduces the rounding it replaces', () => {
  const grid = numericGrid();

  test('roundToPaise equals the old coercing copy on a large grid and on awkward values', () => {
    assert.ok(grid.length > 20000, `the grid is large enough to mean something (${grid.length})`);
    for (const value of [...grid, ...AWKWARD]) same(money.roundToPaise(value), oracleCoercing(value), `roundToPaise(${String(value)})`);
  });

  test('roundToPaiseStrict equals the old statutory-calculator copy', () => {
    for (const value of [...grid, ...AWKWARD]) same(money.roundToPaiseStrict(value), oracleStrict(value), `strict(${String(value)})`);
  });

  test('roundToPaiseNoEpsilon equals the old snapshot-service expression', () => {
    for (const value of [...grid, ...AWKWARD]) same(money.roundToPaiseNoEpsilon(value), oracleNoEpsilon(value), `noEpsilon(${String(value)})`);
  });

  test('roundProrationFactor equals the old six-decimal copy', () => {
    for (const value of [...grid.map((v) => v / 1000), 0.322667, 0.516129, 1, 0, 1 / 3, 2 / 3, 29 / 31, ...AWKWARD]) {
      same(money.roundProrationFactor(value), oracleFactor(value), `factor(${String(value)})`);
    }
  });

  test('the evaluator\'s exported roundToPaise is the same rounding', () => {
    for (const value of [...grid, ...AWKWARD]) same(evaluatorRound(value), oracleCoercing(value), `evaluator(${String(value)})`);
  });

  test('repeating a calculation gives the same answer (deterministic)', () => {
    const first = [...grid, ...AWKWARD].map((value) => money.roundToPaise(value));
    const second = [...grid, ...AWKWARD].map((value) => money.roundToPaise(value));
    assert.equal(first.length, second.length);
    first.forEach((value, index) => same(value, second[index], `repeat[${index}]`));
  });
});

describe('golden values: half paise, negatives, zero', () => {
  test('roundToPaise', () => {
    const golden = [
      [1.005, 1.01], [2.675, 2.68], [1.255, 1.26], [8.345, 8.35], [0.285, 0.29],
      [-1.5, -1.5], [0, 0], ['12.345', 12.35], [1e15 + 0.5, 1e15 + 0.5], [1234.565, 1234.57],
    ];
    for (const [input, expected] of golden) same(money.roundToPaise(input), expected, `roundToPaise(${input})`);
  });

  test('negative half paise round toward positive infinity, exactly as before', () => {
    // Math.round semantics: this is the current behaviour and it is NOT being changed here.
    same(money.roundToPaise(-0.004), -0, '-0.004 rounds to negative zero');
    same(money.roundToPaise(-0.005), oracleCoercing(-0.005), '-0.005');
    same(money.roundToPaise(-2.675), oracleCoercing(-2.675), '-2.675');
  });

  test('zero and near-zero', () => {
    same(money.roundToPaise(0), 0, '0');
    same(money.roundToPaise(0.0049), 0, '0.0049');
    same(money.roundToPaise(0.005), oracleCoercing(0.005), '0.005');
  });
});

describe('null, undefined and NaN semantics differ by variant, on purpose', () => {
  test('coercing variants turn missing input into zero', () => {
    for (const bad of [undefined, null, NaN, '']) {
      same(money.roundToPaise(bad), 0, `roundToPaise(${String(bad)})`);
      same(money.roundProrationFactor(bad), 0, `roundProrationFactor(${String(bad)})`);
    }
  });

  test('the strict variant keeps a missing amount visible', () => {
    assert.ok(Number.isNaN(money.roundToPaiseStrict(undefined)));
    assert.ok(Number.isNaN(money.roundToPaiseStrict(NaN)));
    same(money.roundToPaiseStrict(null), 0, 'null is arithmetic zero, as before');
  });

  test('the strict variant propagates through the statutory calculator exactly as before', () => {
    const esiRule = { employeeContributionRate: 0.0075, employerContributionRate: 0.0325, grossWageCeiling: 21000, roundingMode: 'PAISE' };
    const missing = statutory.calculateEsi({ grossMonthly: undefined, esiRule, esiEnrolled: true });
    assert.ok(Number.isNaN(missing.employeeEsi) && Number.isNaN(missing.employerEsi) && Number.isNaN(missing.totalEsi));
    const nullGross = statutory.calculateEsi({ grossMonthly: null, esiRule, esiEnrolled: true });
    assert.deepEqual(nullGross, { enrolled: true, applicable: true, employeeEsi: 0, employerEsi: 0, totalEsi: 0 });
    const epf = statutory.calculateEpf({
      pfWage: undefined,
      epfRule: { employeeContributionRate: 0.12, employerContributionRate: 0.12, wageCapForContribution: 15000, roundingMode: 'PAISE' },
      pfEnrolled: true,
    });
    assert.ok(Number.isNaN(epf.pfWageUsed) && Number.isNaN(epf.employeeEpf) && Number.isNaN(epf.totalEpf));
  });
});

describe('statutory rounding follows the rule version\'s mode', () => {
  test('applyStatutoryRounding equals the old applyRounding for every mode', () => {
    const modes = [undefined, 'PAISE', 'NEAREST_RUPEE', 'CEIL_RUPEE', 'UNKNOWN_MODE'];
    for (const mode of modes) {
      for (const value of [...numericGrid().filter((_, index) => index % 11 === 0), ...AWKWARD]) {
        same(money.applyStatutoryRounding(value, mode), oracleStatutory(value, mode), `${mode}(${String(value)})`);
      }
    }
  });

  test('golden values per mode', () => {
    const golden = [
      // value, PAISE, NEAREST_RUPEE, CEIL_RUPEE
      [1440.055, 1440.06, 1440, 1441],
      [92.5875, 92.59, 93, 93],
      [401.225, 401.23, 401, 402],
      [148.148, 148.15, 148, 149],
      [0.01, 0.01, 0, 1],
      [0, 0, 0, 0],
      [2.5, 2.5, 3, 3],
    ];
    for (const [value, paise, nearest, ceil] of golden) {
      same(money.applyStatutoryRounding(value), paise, `default(${value})`);
      same(money.applyStatutoryRounding(value, 'PAISE'), paise, `PAISE(${value})`);
      same(money.applyStatutoryRounding(value, 'NEAREST_RUPEE'), nearest, `NEAREST_RUPEE(${value})`);
      same(money.applyStatutoryRounding(value, 'CEIL_RUPEE'), ceil, `CEIL_RUPEE(${value})`);
    }
  });

  test('the modes are the same three the rule schema allows', () => {
    assert.deepEqual({ ...money.ROUNDING_MODES }, { PAISE: 'PAISE', NEAREST_RUPEE: 'NEAREST_RUPEE', CEIL_RUPEE: 'CEIL_RUPEE' });
    assert.ok(Object.isFrozen(money.ROUNDING_MODES));
  });
});

describe('the public functions that consume rounding still return what they always did', () => {
  const epfRule = (roundingMode) => ({
    employeeContributionRate: 0.12, employerContributionRate: 0.12, wageCapForContribution: 15000,
    epsRate: 0.0833, epsWageCeiling: 15000, roundingMode,
  });
  const esiRule = (roundingMode) => ({ employeeContributionRate: 0.0075, employerContributionRate: 0.0325, grossWageCeiling: 21000, roundingMode });

  test('EPF in every rounding mode', () => {
    const epf = (pfWage, mode) => statutory.calculateEpf({ pfWage, epfRule: epfRule(mode), pfEnrolled: true });
    assert.deepEqual(epf(12000.5, 'PAISE'), { enrolled: true, pfWageUsed: 12000.5, employeeEpf: 1440.06, employerEpf: 1440.06, epsContribution: 999.64, totalEpf: 2880.12 });
    assert.deepEqual(epf(1234.565, 'PAISE'), { enrolled: true, pfWageUsed: 1234.565, employeeEpf: 148.15, employerEpf: 148.15, epsContribution: 102.84, totalEpf: 296.3 });
    assert.deepEqual(epf(14999.99, 'PAISE'), { enrolled: true, pfWageUsed: 14999.99, employeeEpf: 1800, employerEpf: 1800, epsContribution: 1249.5, totalEpf: 3600 });
    assert.deepEqual(epf(12000.5, 'NEAREST_RUPEE'), { enrolled: true, pfWageUsed: 12000.5, employeeEpf: 1440, employerEpf: 1440, epsContribution: 1000, totalEpf: 2880 });
    assert.deepEqual(epf(1234.565, 'NEAREST_RUPEE'), { enrolled: true, pfWageUsed: 1234.565, employeeEpf: 148, employerEpf: 148, epsContribution: 103, totalEpf: 296 });
    assert.deepEqual(epf(14999.99, 'NEAREST_RUPEE'), { enrolled: true, pfWageUsed: 14999.99, employeeEpf: 1800, employerEpf: 1800, epsContribution: 1250, totalEpf: 3600 });
    assert.deepEqual(epf(12000.5, 'CEIL_RUPEE'), { enrolled: true, pfWageUsed: 12000.5, employeeEpf: 1441, employerEpf: 1441, epsContribution: 1000, totalEpf: 2882 });
    assert.deepEqual(epf(1234.565, 'CEIL_RUPEE'), { enrolled: true, pfWageUsed: 1234.565, employeeEpf: 149, employerEpf: 149, epsContribution: 103, totalEpf: 298 });
    assert.deepEqual(epf(15000, 'CEIL_RUPEE'), { enrolled: true, pfWageUsed: 15000, employeeEpf: 1800, employerEpf: 1800, epsContribution: 1250, totalEpf: 3600 });
    assert.deepEqual(epf(20000, 'PAISE'), { enrolled: true, pfWageUsed: 15000, employeeEpf: 1800, employerEpf: 1800, epsContribution: 1249.5, totalEpf: 3600 });
    assert.deepEqual(epf(0.01, 'PAISE'), { enrolled: true, pfWageUsed: 0.01, employeeEpf: 0, employerEpf: 0, epsContribution: 0, totalEpf: 0 });
  });

  test('ESI in every rounding mode, including the ceiling', () => {
    const esi = (grossMonthly, mode) => statutory.calculateEsi({ grossMonthly, esiRule: esiRule(mode), esiEnrolled: true });
    assert.deepEqual(esi(12345.67, 'PAISE'), { enrolled: true, applicable: true, employeeEsi: 92.59, employerEsi: 401.23, totalEsi: 493.82 });
    assert.deepEqual(esi(3333.333, 'PAISE'), { enrolled: true, applicable: true, employeeEsi: 25, employerEsi: 108.33, totalEsi: 133.33 });
    assert.deepEqual(esi(21000, 'PAISE'), { enrolled: true, applicable: true, employeeEsi: 157.5, employerEsi: 682.5, totalEsi: 840 });
    assert.deepEqual(esi(21000.01, 'PAISE'), { enrolled: true, applicable: false, employeeEsi: 0, employerEsi: 0, totalEsi: 0 });
    assert.deepEqual(esi(12345.67, 'NEAREST_RUPEE'), { enrolled: true, applicable: true, employeeEsi: 93, employerEsi: 401, totalEsi: 494 });
    assert.deepEqual(esi(3333.333, 'NEAREST_RUPEE'), { enrolled: true, applicable: true, employeeEsi: 25, employerEsi: 108, totalEsi: 133 });
    assert.deepEqual(esi(12345.67, 'CEIL_RUPEE'), { enrolled: true, applicable: true, employeeEsi: 93, employerEsi: 402, totalEsi: 495 });
    assert.deepEqual(esi(3333.333, 'CEIL_RUPEE'), { enrolled: true, applicable: true, employeeEsi: 25, employerEsi: 109, totalEsi: 134 });
    assert.deepEqual(esi(0.01, 'CEIL_RUPEE'), { enrolled: true, applicable: true, employeeEsi: 0, employerEsi: 0, totalEsi: 0 });
  });

  test('professional tax rounds the slab amount to paise', () => {
    const slabs = [
      { upTo: 7500, monthlyTax: 0 },
      { upTo: 10000, monthlyTax: 175.555 },
      { upTo: null, monthlyTax: 200, monthOverrides: [{ month: 2, monthlyTax: 300.125 }] },
    ];
    const pt = (grossMonthly) => statutory.calculatePt({ grossMonthly, ptSlabs: slabs, ptEnrolled: true, periodMonth: 2 });
    assert.deepEqual(pt(5000), { enrolled: true, applicable: false, pt: 0 });
    assert.deepEqual(pt(7500), { enrolled: true, applicable: false, pt: 0 });
    assert.deepEqual(pt(7500.01), { enrolled: true, applicable: true, pt: 175.56 });
    assert.deepEqual(pt(10000), { enrolled: true, applicable: true, pt: 175.56 });
    assert.deepEqual(pt(10000.01), { enrolled: true, applicable: true, pt: 300.13 });
    const undefinedGross = statutory.calculatePt({ grossMonthly: undefined, ptSlabs: [{ upTo: 7500, monthlyTax: 0 }, { upTo: null, monthlyTax: 200.005 }], ptEnrolled: true });
    assert.deepEqual(undefinedGross, { enrolled: true, applicable: true, pt: 200.01 });
  });

  test('a whole calculation: totals and net pay are rounded after the parts', () => {
    const slabs = [{ upTo: 7500, monthlyTax: 0 }, { upTo: 10000, monthlyTax: 175.555 }, { upTo: null, monthlyTax: 200 }];
    const result = statutory.calculate({
      grossMonthly: 20000.555, basicSalary: 12000.005, pfEnrolled: true, esiEnrolled: true, ptEnrolled: true,
      epfRule: epfRule('NEAREST_RUPEE'), esiRule: esiRule('CEIL_RUPEE'), ptSlabs: slabs, periodMonth: 3,
    });
    assert.deepEqual(result, {
      epf: { enrolled: true, pfWageUsed: 12000.005, employeeEpf: 1440, employerEpf: 1440, epsContribution: 1000, totalEpf: 2880 },
      esi: { enrolled: true, applicable: true, employeeEsi: 150, employerEsi: 651, totalEsi: 801 },
      pt: { enrolled: true, applicable: true, pt: 200 },
      tdsDeferred: true,
      grossMonthly: 20000.555,
      totalEmployeeDeductions: 1790,
      netPay: 18210.56,
    });
  });

  test('proration: each amount is rounded to paise once', () => {
    const golden = [[10000, 0.322667, 3226.67], [1234.565, 0.5, 617.28], [20000, 0.516129, 10322.58], [0.01, 0.5, 0.01],
      [99999.99, 0.386923, 38692.3], [1.005, 1, 1.01], [2.675, 1, 2.68], [undefined, 0.5, 0], [null, 0.5, 0]];
    for (const [amount, factor, expected] of golden) same(proratedAmount(amount, factor), expected, `proratedAmount(${amount}, ${factor})`);
  });

  test('proration factor and paid days keep their precision', () => {
    const period = (basisSettings, hireDate, lastWorkingDay) => {
      const days = computePayPeriodDays({
        periodStart: new Date('2026-03-01T00:00:00Z'),
        periodEnd: new Date('2026-03-31T00:00:00Z'),
        basis: payrollBasisFrom(basisSettings),
        hireDate: hireDate ? new Date(hireDate) : null,
        lastWorkingDay: lastWorkingDay ? new Date(lastWorkingDay) : null,
      });
      return [days.payableDays, days.paidDays, days.prorationFactor];
    };
    assert.deepEqual(period({}, '2026-03-20', null), [31, 12, 0.387097]);
    assert.deepEqual(period({ payableDaysBasis: 'FIXED_DAYS', fixedPayableDays: 30 }, null, '2026-03-10'), [30, 9.68, 0.322667]);
    assert.deepEqual(period({ payableDaysBasis: 'FIXED_DAYS', fixedPayableDays: 26 }, '2026-03-16', null), [26, 13.42, 0.516154]);
    assert.deepEqual(period({ payableDaysBasis: 'WORKING_DAYS' }, null, '2026-03-10'), [26, 8, 0.307692]);
    assert.deepEqual(period({}, null, null), [31, 31, 1]);
  });
});

describe('display formatting', () => {
  test('formatRupees rounds to paise and groups digits the Indian way', () => {
    assert.equal(money.formatRupees(1234567.8), '₹12,34,567.80');
    assert.equal(money.formatRupees(0), '₹0.00');
    assert.equal(money.formatRupees(undefined), '₹0.00');
    assert.equal(money.formatRupees(1.005), '₹1.01');
    assert.equal(money.formatRupees(99999.995), oracleDisplay(99999.995));
    assert.equal(money.formatRupees(-1500.5), oracleDisplay(-1500.5));
  });

  test('formatRatePercent', () => {
    assert.equal(money.formatRatePercent(0.0075), '0.75%');
    assert.equal(money.formatRatePercent(0.12), '12%');
    assert.equal(money.formatRatePercent(0.0833), '8.33%');
    assert.equal(money.formatRatePercent(0.0325), '3.25%');
  });
});

function oracleDisplay(value) {
  return `₹${oracleCoercing(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

describe('the no-epsilon variant, on the domain it serves', () => {
  // payrollSnapshotService freezes employerTotalContribution = round(employer EPF + employer ESI).
  // Both addends are already rounded (to paise or to whole rupees), so the sum is a multiple of
  // 0.01 up to float noise. There, adding Number.EPSILON can never move a result across a half.
  // This is an OBSERVATION over a large deterministic grid, which is why the variant stays separate.
  test('agrees with the epsilon variant on sums of already-rounded amounts', () => {
    let compared = 0;
    for (let first = 0; first <= 3000000; first += 1009) {
      for (let second = 0; second <= 3000000; second += 7919) {
        const sum = first / 100 + second / 100;
        assert.ok(Object.is(money.roundToPaiseNoEpsilon(sum), money.roundToPaise(sum)), `sum ${sum}`);
        compared += 1;
      }
    }
    for (let rupees = 0; rupees <= 20000; rupees += 13) {
      for (let paise = 0; paise <= 1500000; paise += 997) {
        const sum = rupees + paise / 100;
        assert.ok(Object.is(money.roundToPaiseNoEpsilon(sum), money.roundToPaise(sum)), `sum ${sum}`);
        compared += 1;
      }
    }
    assert.ok(compared > 300000, `compared ${compared} sums`);
  });
});
