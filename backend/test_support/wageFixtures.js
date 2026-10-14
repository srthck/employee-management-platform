/**
 * Builders for the Phase 1D tests. EVERYTHING produced here is a MATHEMATICAL_FIXTURE: clause ids
 * are FIXTURE_*, provenance says so, and the production loader rejects it. None of it says what any
 * real legal clause includes or excludes.
 */

export const fixtureRule = ({
  threshold = '1/2',
  clauses = {},
  clauseDefaults = {},
  inKind = { status: 'DISABLED' },
  secondProviso = { status: 'UNRESOLVED' },
  ruleId = 'FIXTURE_RULE',
  version = 1,
} = {}) => ({
  schema: 'PAYGUARD_STATUTORY_WAGE_RULE_V1',
  ruleId,
  version,
  provenance: { kind: 'MATHEMATICAL_FIXTURE', fixtureId: `${ruleId}@${version}` },
  threshold,
  inKind,
  secondProviso,
  clauses: Object.entries(clauses).map(([clauseId, spec]) => ({
    clauseId,
    denominator: spec.d,
    pool: spec.p,
    poolInterpretation: 'DEFINED',
    secondProvisoDependent: false,
    requiredFacts: [],
    ...clauseDefaults,
    ...(spec.extra || {}),
  })),
});

/** Convert the oracle's line shape into the engine's explicit classification shape. */
export const engineLines = (oracleLines, { facts } = {}) => oracleLines.map((line, index) => ({
  lineId: line.lineId || `L${String(index).padStart(4, '0')}`,
  amountPaise: typeof line.amountPaise === 'string' ? BigInt(line.amountPaise) : line.amountPaise,
  inKind: false, // the explicit, only permitted not-in-kind form (an omitted inKind is an unknown state)
  ...(facts ? { facts } : {}),
  classification: {
    status: 'CLASSIFIED',
    parts: line.parts.map((part) => (part.clauseId === undefined
      ? { target: 'INCLUDED', portion: part.portion }
      : { target: 'CLAUSE', clauseId: part.clauseId, portion: part.portion })),
  },
}));

/** mulberry32: a small, seedable PRNG so random tests are reproducible. */
export const prng = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const THRESHOLDS = ['1/2', '1/3', '3/10', '2/5', '1/4', '0/1', '1/1', '7/20'];
const SHARES = [['1/1', '1/1'], ['1/1', '0/1'], ['1/1', '1/2'], ['1/2', '1/4'], ['2/3', '1/3'], ['2/3', '2/3'], ['1/4', '0/1'], ['0/1', '0/1'], ['3/5', '1/5']];
const SPLITS = [['1/1'], ['1/2', '1/2'], ['1/3', '2/3'], ['1/4', '3/4'], ['1/2', '1/4', '1/4'], ['1/5', '2/5', '2/5'], ['1/6', '1/3', '1/2']];

/** A random, fully classified fixture case: { threshold, clauses, lines } in the oracle's shape. */
export function randomCase(random) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const clauseCount = 1 + Math.floor(random() * 3);
  const clauses = {};
  for (let i = 0; i < clauseCount; i++) { const [d, p] = pick(SHARES); clauses[`FIXTURE_C${i}`] = { d, p }; }
  const ids = Object.keys(clauses);
  const lineCount = 1 + Math.floor(random() * 8);
  const lines = [];
  for (let i = 0; i < lineCount; i++) {
    const split = pick(SPLITS.filter((candidate) => candidate.length <= ids.length + 1));
    const targets = [undefined, ...ids].sort(() => random() - 0.5).slice(0, split.length);
    const big = random() < 0.05;
    const amountPaise = big ? Math.floor(random() * 9e12) : Math.floor(random() * 5_000_000);
    lines.push({ lineId: `L${String(i).padStart(4, '0')}`, amountPaise, parts: split.map((portion, k) => ({ ...(targets[k] === undefined ? {} : { clauseId: targets[k] }), portion })) });
  }
  return { threshold: pick(THRESHOLDS), clauses, lines };
}

/**
 * Prototype-pollution differential. For EVERY object key in a sample input (at any depth): delete that key, record the outcome
 * (baseline: the "missing required property" behaviour), then pollute Object.prototype with the key's ORIGINAL value, so that an
 * inherited read would satisfy the requirement, and run again. The outcome must be identical: a missing own property stays
 * missing. Returns the paths where it was not.
 */
export const objectKeyPaths = (value, prefix = []) => {
  const out = [];
  if (Array.isArray(value)) value.forEach((item, index) => out.push(...objectKeyPaths(item, [...prefix, index])));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { out.push([...prefix, key]); out.push(...objectKeyPaths(item, [...prefix, key])); }
  }
  return out;
};
const valueAtPath = (root, path) => path.reduce((node, part) => node[part], root);
const withoutPath = (root, path) => {
  const copy = structuredClone(root);
  delete valueAtPath(copy, path.slice(0, -1))[path.at(-1)];
  return copy;
};
export const outcomeSignature = (fn) => {
  try {
    return `OK ${JSON.stringify(fn(), (key, item) => (typeof item === 'bigint' ? item.toString() : item))}`;
  } catch (error) {
    return `ERR ${error.code || error.name}`;
  }
};
export function pollutionDifferential(sample, call) {
  const findings = [];
  const examined = [];
  for (const path of objectKeyPaths(sample)) {
    const key = path.at(-1);
    const input = withoutPath(sample, path);
    const original = valueAtPath(sample, path);
    const baseline = outcomeSignature(() => call(structuredClone(input)));
    const probe = structuredClone(input);
    Object.prototype[key] = original; // eslint-disable-line no-extend-native
    let polluted;
    try { polluted = outcomeSignature(() => call(probe)); } finally { delete Object.prototype[key]; }
    examined.push(path.join('.'));
    if (polluted !== baseline) findings.push({ path: path.join('.'), baseline, polluted });
  }
  return { findings, examined };
}
