/**
 * Independent mathematical oracle for the Phase 1D statutory-wage engine.
 *
 * INDEPENDENCE: this file imports NOTHING from src/. It does not use the engine's rational type,
 * its parser, its helpers or its error codes, and it uses a deliberately different algorithm:
 *
 *   - values are UNREDUCED fractions [numerator, denominator] of BigInts; nothing is normalized
 *     while computing, so every intermediate keeps its full numerator and denominator;
 *   - comparison is by cross-multiplication of those unreduced pairs;
 *   - the only reduction happens once, at the end, with this file's own recursive Euclid.
 *
 * (The engine normalizes by gcd after every operation with an iterative loop.) Agreement between
 * two structurally different implementations is the point of an oracle.
 *
 * Everything here is MATHEMATICAL_FIXTURE arithmetic. It says nothing about what any real legal
 * clause includes or excludes.
 */

const euclid = (a, b) => (b === 0n ? (a < 0n ? -a : a) : euclid(b, a % b));

const parse = (text) => {
  const slash = text.indexOf('/');
  return [BigInt(text.slice(0, slash)), BigInt(text.slice(slash + 1))];
};

const plus = ([an, ad], [bn, bd]) => [an * bd + bn * ad, ad * bd];
const minus = ([an, ad], [bn, bd]) => [an * bd - bn * ad, ad * bd];
const times = ([an, ad], [bn, bd]) => [an * bn, ad * bd];
const greaterThan = ([an, ad], [bn, bd]) => an * bd > bn * ad; // denominators are all positive

const reduceToCanonical = ([n, d]) => {
  if (n === 0n) return '0/1';
  const g = euclid(n, d);
  const sign = d < 0n ? -1n : 1n;
  return `${(sign * n) / g}/${(sign * d) / g}`;
};

/**
 * @param {object} input
 * @param {string} input.threshold                 "n/d"
 * @param {Object<string,{d:string,p:string}>} input.clauses
 * @param {Array<{amountPaise:(number|bigint), parts:Array<{clauseId?:string, portion:string}>}>} input.lines
 *        A part with no clauseId is INCLUDED remuneration.
 * @returns {Object<string,string>} canonical "n/d" strings
 */
export function oracleWage({ threshold, clauses, lines }) {
  const zero = [0n, 1n];
  let included = zero;
  const byClause = {};
  for (const id of Object.keys(clauses)) byClause[id] = zero;

  for (const line of lines) {
    const amount = [BigInt(line.amountPaise), 1n];
    for (const part of line.parts) {
      const share = times(amount, parse(part.portion));
      if (part.clauseId === undefined) included = plus(included, share);
      else byClause[part.clauseId] = plus(byClause[part.clauseId], share);
    }
  }

  let denominatorTotal = zero;
  let pool = zero;
  let unqualified = zero;
  for (const [id, amount] of Object.entries(byClause)) {
    const d = parse(clauses[id].d);
    const p = parse(clauses[id].p);
    denominatorTotal = plus(denominatorTotal, times(d, amount));
    pool = plus(pool, times(p, amount));
    unqualified = plus(unqualified, times(minus(d, p), amount));
  }

  const everything = plus(included, denominatorTotal);
  const limit = times(parse(threshold), everything);
  const excess = minus(pool, limit);
  const addBack = greaterThan(excess, zero) ? excess : zero;
  const wage = plus(included, addBack);

  return {
    includedPaise: reduceToCanonical(included),
    allRemunerationPaise: reduceToCanonical(everything),
    poolPaise: reduceToCanonical(pool),
    unqualifiedPaise: reduceToCanonical(unqualified),
    thresholdAmountPaise: reduceToCanonical(limit),
    addBackPaise: reduceToCanonical(addBack),
    wagePaise: reduceToCanonical(wage),
  };
}

/**
 * Hand-computed vectors. Each `expected` was worked out on paper (see the comment above each), not
 * produced by either implementation.
 */
export const HAND_VECTORS = [
  {
    // I=10000, A(d=1,p=1)=6000, t=1/2: R=16000, P=6000, tR=8000, P<tR so addBack 0, W=10000
    name: 'pool below threshold',
    threshold: '1/2', clauses: { FIXTURE_A: { d: '1/1', p: '1/1' } },
    lines: [{ amountPaise: 10000, parts: [{ portion: '1/1' }] }, { amountPaise: 6000, parts: [{ clauseId: 'FIXTURE_A', portion: '1/1' }] }],
    expected: { includedPaise: '10000/1', allRemunerationPaise: '16000/1', poolPaise: '6000/1', unqualifiedPaise: '0/1', thresholdAmountPaise: '8000/1', addBackPaise: '0/1', wagePaise: '10000/1' },
  },
  {
    // I=10000, A=12000: R=22000, P=12000, tR=11000, addBack=1000, W=11000
    name: 'pool above threshold',
    threshold: '1/2', clauses: { FIXTURE_A: { d: '1/1', p: '1/1' } },
    lines: [{ amountPaise: 10000, parts: [{ portion: '1/1' }] }, { amountPaise: 12000, parts: [{ clauseId: 'FIXTURE_A', portion: '1/1' }] }],
    expected: { includedPaise: '10000/1', allRemunerationPaise: '22000/1', poolPaise: '12000/1', unqualifiedPaise: '0/1', thresholdAmountPaise: '11000/1', addBackPaise: '1000/1', wagePaise: '11000/1' },
  },
  {
    // I=10000, A=10000: R=20000, P=10000, tR=10000 exactly, addBack 0, W=10000
    name: 'pool exactly at threshold',
    threshold: '1/2', clauses: { FIXTURE_A: { d: '1/1', p: '1/1' } },
    lines: [{ amountPaise: 10000, parts: [{ portion: '1/1' }] }, { amountPaise: 10000, parts: [{ clauseId: 'FIXTURE_A', portion: '1/1' }] }],
    expected: { includedPaise: '10000/1', allRemunerationPaise: '20000/1', poolPaise: '10000/1', unqualifiedPaise: '0/1', thresholdAmountPaise: '10000/1', addBackPaise: '0/1', wagePaise: '10000/1' },
  },
  {
    // A=10001: R=20001, tR=20001/2=10000.5, P-tR=10001-10000.5=1/2, W=10000+1/2=20001/2
    name: 'one paisa above threshold',
    threshold: '1/2', clauses: { FIXTURE_A: { d: '1/1', p: '1/1' } },
    lines: [{ amountPaise: 10000, parts: [{ portion: '1/1' }] }, { amountPaise: 10001, parts: [{ clauseId: 'FIXTURE_A', portion: '1/1' }] }],
    expected: { includedPaise: '10000/1', allRemunerationPaise: '20001/1', poolPaise: '10001/1', unqualifiedPaise: '0/1', thresholdAmountPaise: '20001/2', addBackPaise: '1/2', wagePaise: '20001/2' },
  },
  {
    // t=3/10, I=7000, A=4000: R=11000, tR=3300, P-tR=700, W=7700
    name: 'non-one-half threshold',
    threshold: '3/10', clauses: { FIXTURE_A: { d: '1/1', p: '1/1' } },
    lines: [{ amountPaise: 7000, parts: [{ portion: '1/1' }] }, { amountPaise: 4000, parts: [{ clauseId: 'FIXTURE_A', portion: '1/1' }] }],
    expected: { includedPaise: '7000/1', allRemunerationPaise: '11000/1', poolPaise: '4000/1', unqualifiedPaise: '0/1', thresholdAmountPaise: '3300/1', addBackPaise: '700/1', wagePaise: '7700/1' },
  },
  {
    // I=10000, A(d=1,p=1)=6000, B(d=1,p=0)=5000: R=21000, P=6000, U=5000, tR=10500, addBack 0, W=10000
    name: 'clause in the denominator but not in the pool',
    threshold: '1/2', clauses: { FIXTURE_A: { d: '1/1', p: '1/1' }, FIXTURE_B: { d: '1/1', p: '0/1' } },
    lines: [{ amountPaise: 10000, parts: [{ portion: '1/1' }] }, { amountPaise: 6000, parts: [{ clauseId: 'FIXTURE_A', portion: '1/1' }] }, { amountPaise: 5000, parts: [{ clauseId: 'FIXTURE_B', portion: '1/1' }] }],
    expected: { includedPaise: '10000/1', allRemunerationPaise: '21000/1', poolPaise: '6000/1', unqualifiedPaise: '5000/1', thresholdAmountPaise: '10500/1', addBackPaise: '0/1', wagePaise: '10000/1' },
  },
  {
    // I=5000, C(d=1/2,p=1/4)=8000: d*X=4000, p*X=2000, U=2000, R=9000, tR=4500, addBack 0, W=5000
    name: 'fractional shares',
    threshold: '1/2', clauses: { FIXTURE_C: { d: '1/2', p: '1/4' } },
    lines: [{ amountPaise: 5000, parts: [{ portion: '1/1' }] }, { amountPaise: 8000, parts: [{ clauseId: 'FIXTURE_C', portion: '1/1' }] }],
    expected: { includedPaise: '5000/1', allRemunerationPaise: '9000/1', poolPaise: '2000/1', unqualifiedPaise: '2000/1', thresholdAmountPaise: '4500/1', addBackPaise: '0/1', wagePaise: '5000/1' },
  },
  {
    // one line of 9000 split 1/3 included (3000) and 2/3 under A (6000): R=9000, P=6000, tR=4500, addBack=1500, W=4500
    name: 'one line split between included and a clause',
    threshold: '1/2', clauses: { FIXTURE_A: { d: '1/1', p: '1/1' } },
    lines: [{ amountPaise: 9000, parts: [{ portion: '1/3' }, { clauseId: 'FIXTURE_A', portion: '2/3' }] }],
    expected: { includedPaise: '3000/1', allRemunerationPaise: '9000/1', poolPaise: '6000/1', unqualifiedPaise: '0/1', thresholdAmountPaise: '4500/1', addBackPaise: '1500/1', wagePaise: '4500/1' },
  },
  {
    name: 'zero amounts',
    threshold: '1/2', clauses: { FIXTURE_A: { d: '1/1', p: '1/1' } },
    lines: [{ amountPaise: 0, parts: [{ portion: '1/1' }] }, { amountPaise: 0, parts: [{ clauseId: 'FIXTURE_A', portion: '1/1' }] }],
    expected: { includedPaise: '0/1', allRemunerationPaise: '0/1', poolPaise: '0/1', unqualifiedPaise: '0/1', thresholdAmountPaise: '0/1', addBackPaise: '0/1', wagePaise: '0/1' },
  },
  {
    // 1 paisa split 1/3 included and 2/3 under A(d=1,p=1), t=1/2: I=1/3, X_A=2/3, R=1, P=2/3, tR=1/2, addBack=2/3-1/2=1/6, W=1/3+1/6=1/2
    name: 'one paisa split into thirds stays exact',
    threshold: '1/2', clauses: { FIXTURE_A: { d: '1/1', p: '1/1' } },
    lines: [{ amountPaise: 1, parts: [{ portion: '1/3' }, { clauseId: 'FIXTURE_A', portion: '2/3' }] }],
    expected: { includedPaise: '1/3', allRemunerationPaise: '1/1', poolPaise: '2/3', unqualifiedPaise: '0/1', thresholdAmountPaise: '1/2', addBackPaise: '1/6', wagePaise: '1/2' },
  },
  {
    // 1 paisa under clause B(d=1/3,p=1/3), I=0: R=1/3, P=1/3, tR=1/6, addBack=1/6, W=1/6
    name: 'fractional wage from fractional shares',
    threshold: '1/2', clauses: { FIXTURE_B: { d: '1/3', p: '1/3' } },
    lines: [{ amountPaise: 1, parts: [{ clauseId: 'FIXTURE_B', portion: '1/1' }] }],
    expected: { includedPaise: '0/1', allRemunerationPaise: '1/3', poolPaise: '1/3', unqualifiedPaise: '0/1', thresholdAmountPaise: '1/6', addBackPaise: '1/6', wagePaise: '1/6' },
  },
  {
    // maximum safe integer of paise as included remuneration
    name: 'large amount',
    threshold: '1/2', clauses: { FIXTURE_A: { d: '1/1', p: '1/1' } },
    lines: [{ amountPaise: '9007199254740991', parts: [{ portion: '1/1' }] }, { amountPaise: '9007199254740991', parts: [{ clauseId: 'FIXTURE_A', portion: '1/1' }] }],
    expected: { includedPaise: '9007199254740991/1', allRemunerationPaise: '18014398509481982/1', poolPaise: '9007199254740991/1', unqualifiedPaise: '0/1', thresholdAmountPaise: '9007199254740991/1', addBackPaise: '0/1', wagePaise: '9007199254740991/1' },
  },
];
