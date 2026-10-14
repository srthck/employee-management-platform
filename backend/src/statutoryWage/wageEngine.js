/**
 * Generic, pure statutory-wage engine (Phase 1D scaffold).
 *
 * WHAT THIS IS: the arithmetic of a clause-level wage definition, parameterized by an explicit,
 * versioned rule definition that the caller supplies. It decides nothing about the law.
 *
 * WHAT THIS IS NOT: it is not wired to payroll (no caller exists), it reads no database and no legal
 * catalogue, it makes no external call, it has no production activation path, it has no gross
 * fallback, and it supplies no default for any legal parameter. Every rule it can run today is a
 * MATHEMATICAL_FIXTURE, and only in the explicit TEST context: a synthetic definition for proving the
 * arithmetic. A fixture is never evidence that a real clause is, or is not, part of an ESI wage.
 *
 * Context: omitting the context option means PRODUCTION (see context.js). PRODUCTION cannot evaluate
 * anything today: it needs a trusted legal register that does not exist (see productionAuthority.js).
 * Labels and approval objects carried inside a rule are claims, never proof.
 *
 * Model (all amounts in exact rational paise; line inputs are integer paise):
 *   I        included remuneration
 *   X_c      the amount portion classified under exclusion clause c
 *   d_c      share of X_c that participates in the denominator            0 <= p_c <= d_c <= 1
 *   p_c      share of X_c that participates in the add-back pool
 *   t        the threshold, an exact rational
 *   R_all    = I + sum(d_c * X_c)
 *   P        = sum(p_c * X_c)
 *   U        = sum((d_c - p_c) * X_c)
 *   addBack  = max(0, P - t * R_all)
 *   W        = I + addBack
 *
 * Nothing is rounded. Contribution rounding is a separate stage and no rounding mode is approved:
 * roundContribution always fails with CONTRIBUTION_ROUNDING_UNAPPROVED.
 *
 * Hashes in a result (they are different things and never interchangeable):
 *   rule.ruleHash   identifies the RULE MAPPING: the canonical rule definition (clauses sorted by id,
 *                   fact specs sorted by name, object keys sorted). It changes when any
 *                   calculation-relevant rule content changes, even if the totals would not.
 *   inputDigest     identifies the classified INPUT: every line's amount, classification parts and
 *                   validated facts.
 *   resultHash      identifies the MATHEMATICAL RESULT: engine identity, ruleHash, inputDigest and
 *                   every total. The complete REGISTER SNAPSHOT hash is a different hash, produced by
 *                   provenance.js (registerSnapshotHash); it covers the whole legal register, not one
 *                   calculation.
 *
 * Input contract (strict): every external object is checked against an explicit key list. A key that
 * is not part of the contract (a misspelling, `gross`, `nature`, `default` ...) is rejected, never
 * silently ignored. Each line must state `inKind` explicitly: `false` is the only permitted
 * not-in-kind form, `true` is in-kind remuneration (blocked), and an omitted, null, string, number,
 * object or array value is an unknown state that is blocked and never read as false.
 */

import { fail, StatutoryWageError, STATUTORY_WAGE_ERROR_CODES as C } from './errors.js';
import * as Q from './rational.js';
import { canonicalJson, CanonicalizationError, hashCanonical, isSha256Hex } from './canonical.js';
import { guardPublic, toOwnData } from './ownData.js';
import { contextFromOptions, EXECUTION_CONTEXTS } from './context.js';
import { describeProvenance, requireProductionRuleAuthority } from './productionAuthority.js';

export const ENGINE_NAME = 'PAYGUARD_STATUTORY_WAGE_ENGINE';
export const ENGINE_VERSION = '1';
export const RULE_SCHEMA = 'PAYGUARD_STATUTORY_WAGE_RULE_V1';
export const FIXTURE_KIND = 'MATHEMATICAL_FIXTURE';
export const APPROVED_KIND = 'REGISTER_APPROVED';
export const FIXTURE_CLAUSE_PREFIX = 'FIXTURE_';
export const FACT_TYPES = Object.freeze(['BOOLEAN', 'TEXT', 'TEXT_LIST', 'INTEGER', 'ENUM']);

const RULE_KEYS = new Set(['schema', 'ruleId', 'version', 'provenance', 'threshold', 'inKind', 'secondProviso', 'clauses']);
const CLAUSE_KEYS = new Set(['clauseId', 'denominator', 'pool', 'poolInterpretation', 'secondProvisoDependent', 'requiredFacts', 'factContradictions']);
const FIXTURE_PROVENANCE_KEYS = new Set(['kind', 'fixtureId']);
const APPROVED_PROVENANCE_KEYS = new Set(['kind', 'registerSnapshotHash', 'mappingEntryHashes', 'approval']);
const LINE_KEYS = new Set(['lineId', 'amountPaise', 'classification', 'facts', 'inKind']);
const CLASSIFICATION_KEYS = {
  UNCLASSIFIED: new Set(['status']),
  AMBIGUOUS: new Set(['status', 'candidates']),
  MATCHED: new Set(['status', 'matchedClauses']),
  CLASSIFIED: new Set(['status', 'parts']),
};
const PART_KEYS = { INCLUDED: new Set(['target', 'portion']), CLAUSE: new Set(['target', 'clauseId', 'portion']) };
const FACT_SPEC_KEYS = {
  BOOLEAN: new Set(['name', 'type']),
  TEXT: new Set(['name', 'type']),
  TEXT_LIST: new Set(['name', 'type']),
  INTEGER: new Set(['name', 'type', 'min', 'max']),
  ENUM: new Set(['name', 'type', 'values']),
};

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
/** A plain data object: its prototype is Object.prototype or null, so nothing is inherited from a caller-built prototype. */
const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
/** An array. (A sparse array, or one with extra or symbol-keyed properties, never gets here: toOwnData replaces it with a NotPlainData marker.) */
const isDenseArray = (value) => Array.isArray(value);
const invalid = (message, details) => fail(C.RULE_DEFINITION_INVALID, message, details);
const rejectUnknownKeys = (object, allowed, code, what) => {
  for (const key of Object.keys(object)) if (!allowed.has(key)) fail(code, `unknown ${what} field "${key}"`, { field: key });
};
/** Compatibility-folded, so full-width and similar spellings of UNKNOWN are recognized too. */
const isUnknownMarker = (text) => text.normalize('NFKC').trim().toUpperCase() === 'UNKNOWN';
/** Control, format (zero-width), default-ignorable (variation selectors, tag characters ...), unassigned, private-use, lone-surrogate, line/paragraph-separator, non-ASCII space and blank-glyph characters: invisible content is not content. (Fail-closed: this also rejects ZWJ/ZWNJ and tabs/newlines, which a future, approved text type could admit.) */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\u115f\u1160\u2800\u3164\uffa0]/u;

/** A non-empty text with no surrounding whitespace that is not the explicit marker UNKNOWN. */
const textProblem = (value) => {
  if (typeof value !== 'string') return 'must be a string';
  if (value.trim() === '') return 'must not be empty or whitespace only';
  if (INVISIBLE.test(value)) return 'must not contain control, zero-width or invisible characters';
  if (value !== value.trim()) return 'must not have leading or trailing whitespace';
  if (isUnknownMarker(value)) return 'is the explicit marker UNKNOWN';
  return null;
};

/**
 * Problem with one fact value against its spec, or null when valid. `null`/`undefined` are "missing"
 * and handled by the caller; everything else is judged by type and range, never by truthiness: a
 * `false` BOOLEAN and a `0` INTEGER (when in range) are real values.
 */
function factValueProblem(spec, value) {
  switch (spec.type) {
    case 'BOOLEAN': return typeof value === 'boolean' ? null : 'must be a boolean';
    case 'TEXT': return textProblem(value);
    case 'TEXT_LIST': {
      if (!isDenseArray(value)) return 'must be an array of text';
      if (value.length === 0) return 'must not be an empty list';
      for (const item of value) { const problem = textProblem(item); if (problem) return `item ${problem}`; }
      if (new Set(value.map((item) => item.normalize('NFC'))).size !== value.length) return 'must not repeat an item';
      return null;
    }
    case 'INTEGER':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) return 'must be a safe integer';
      return value >= spec.min && value <= spec.max ? null : `must be between ${spec.min} and ${spec.max}`;
    case 'ENUM':
      if (typeof value !== 'string') return 'must be one of the listed values';
      if (isUnknownMarker(value)) return 'is the explicit marker UNKNOWN';
      return spec.values.includes(value) ? null : 'must be one of the listed values';
    default: return 'has an unsupported type';
  }
}

function parseFactSpecs(clauseId, requiredFacts) {
  if (!isDenseArray(requiredFacts)) fail(C.WAGE_DEFINITION_INCOMPLETE, `clause ${clauseId} must list its requiredFacts (it may be empty)`);
  const specs = new Map();
  for (const raw of requiredFacts) {
    if (!isPlainObject(raw)) invalid(`clause ${clauseId}: a required fact must be a typed spec object { name, type }`);
    if (!FACT_TYPES.includes(raw.type)) invalid(`clause ${clauseId}: fact type must be one of ${FACT_TYPES.join('|')}`, { type: raw.type ?? null });
    rejectUnknownKeys(raw, FACT_SPEC_KEYS[raw.type], C.RULE_DEFINITION_INVALID, `fact spec (${raw.type})`);
    if (typeof raw.name !== 'string' || raw.name === '' || raw.name !== raw.name.trim() || INVISIBLE.test(raw.name)) invalid(`clause ${clauseId}: a fact needs a trimmed, non-empty name`);
    if (specs.has(raw.name)) invalid(`clause ${clauseId}: duplicate fact ${raw.name}`);
    const spec = { name: raw.name, type: raw.type };
    if (raw.type === 'INTEGER') {
      if (!Number.isSafeInteger(raw.min) || !Number.isSafeInteger(raw.max) || raw.min > raw.max) invalid(`clause ${clauseId}: INTEGER fact ${raw.name} needs safe-integer min <= max`);
      spec.min = raw.min; spec.max = raw.max;
    }
    if (raw.type === 'ENUM') {
      if (!isDenseArray(raw.values) || raw.values.length === 0 || raw.values.some((v) => typeof v !== 'string' || v === '' || v !== v.trim() || INVISIBLE.test(v) || isUnknownMarker(v)) || new Set(raw.values).size !== raw.values.length) {
        invalid(`clause ${clauseId}: ENUM fact ${raw.name} needs a non-empty list of distinct, trimmed values that does not include UNKNOWN`);
      }
      spec.values = [...raw.values];
    }
    specs.set(raw.name, spec);
  }
  return specs;
}

/** Facts compare by value: lists of text by their canonical form, everything else strictly. */
const sameFactValue = (a, b) => (Array.isArray(a) && Array.isArray(b) ? canonicalJson(a) === canonicalJson(b) : a === b);

function parseContradictions(clauseId, raw, specs) {
  if (raw === undefined) return [];
  if (!isDenseArray(raw)) invalid(`clause ${clauseId}: factContradictions must be an array`);
  return raw.map((entry) => {
    if (!isPlainObject(entry) || Object.keys(entry).length < 2) invalid(`clause ${clauseId}: a contradiction names at least two fact values`);
    for (const [name, value] of Object.entries(entry)) {
      const spec = specs.get(name);
      if (!spec) invalid(`clause ${clauseId}: a contradiction refers to undeclared fact ${name}`);
      if (factValueProblem(spec, value)) invalid(`clause ${clauseId}: a contradiction value for ${name} is not valid for its type`);
    }
    return { ...entry };
  });
}

/**
 * Validate a rule definition's structure and internal consistency. This is STRUCTURAL ONLY: it never
 * decides whether the rule may be USED, and a rule that passes it is not thereby approved or trusted.
 * Usability is decided by assertRuleUsable. Returns the parsed, typed form.
 */
export const validateRuleDefinition = guardPublic('validateRuleDefinition', validateRuleDefinitionCore);

function validateRuleDefinitionCore(candidate) {
  const rule = toOwnData(candidate); // own properties only: nothing inherited can satisfy a required field
  if (!isPlainObject(rule)) invalid('a rule definition must be an object');
  if (rule.schema !== RULE_SCHEMA) fail(C.RULE_DEFINITION_UNSUPPORTED_VERSION, `unsupported rule schema ${JSON.stringify(rule.schema)}`, { supported: RULE_SCHEMA });
  rejectUnknownKeys(rule, RULE_KEYS, C.RULE_DEFINITION_INVALID, 'rule');

  if (typeof rule.ruleId !== 'string' || rule.ruleId === '') fail(C.WAGE_DEFINITION_INCOMPLETE, 'ruleId is required');
  if (INVISIBLE.test(rule.ruleId)) invalid('ruleId must not contain invisible characters');
  if (!(Number.isSafeInteger(rule.version) && rule.version >= 1)) fail(C.WAGE_DEFINITION_INCOMPLETE, 'version must be a positive integer');
  if (rule.threshold === undefined) fail(C.WAGE_DEFINITION_INCOMPLETE, 'threshold is required and has no default');
  if (!isDenseArray(rule.clauses)) fail(C.WAGE_DEFINITION_INCOMPLETE, 'clauses is required (it may be empty)');
  if (!isPlainObject(rule.inKind)) fail(C.WAGE_DEFINITION_INCOMPLETE, 'inKind status is required');
  if (!isPlainObject(rule.secondProviso)) fail(C.WAGE_DEFINITION_INCOMPLETE, 'secondProviso status is required');

  const provenance = rule.provenance;
  if (!isPlainObject(provenance)) fail(C.RULE_PROVENANCE_MISSING, 'a rule definition must carry its provenance');
  if (provenance.kind === FIXTURE_KIND) {
    rejectUnknownKeys(provenance, FIXTURE_PROVENANCE_KEYS, C.RULE_DEFINITION_INVALID, 'provenance');
    if (typeof provenance.fixtureId !== 'string' || provenance.fixtureId === '') fail(C.RULE_PROVENANCE_MISSING, 'a fixture must name its fixtureId');
    if (INVISIBLE.test(provenance.fixtureId)) invalid('fixtureId must not contain invisible characters');
  } else if (provenance.kind === APPROVED_KIND) {
    rejectUnknownKeys(provenance, APPROVED_PROVENANCE_KEYS, C.RULE_DEFINITION_INVALID, 'provenance');
    if (!isSha256Hex(provenance.registerSnapshotHash)) fail(C.RULE_PROVENANCE_MISSING, 'an approved rule must cite a registerSnapshotHash');
    if (provenance.approval !== undefined && !isPlainObject(provenance.approval)) invalid('provenance.approval, when present, must be an object (it is only a claim and is never trusted)');
    if (!isDenseArray(provenance.mappingEntryHashes) || provenance.mappingEntryHashes.length === 0 || !provenance.mappingEntryHashes.every(isSha256Hex)) {
      fail(C.RULE_PROVENANCE_MISSING, 'an approved rule must cite its mappingEntryHashes');
    }
  } else {
    fail(C.RULE_PROVENANCE_MISSING, `unknown provenance kind ${JSON.stringify(provenance.kind)}`);
  }

  const threshold = Q.fromCanonical(rule.threshold);
  if (Q.isNegative(threshold) || Q.gt(threshold, Q.ONE)) invalid('threshold must satisfy 0 <= t <= 1', { threshold: rule.threshold });

  const clauses = new Map();
  for (const clause of rule.clauses) {
    if (!isPlainObject(clause)) invalid('a clause must be an object');
    rejectUnknownKeys(clause, CLAUSE_KEYS, C.RULE_DEFINITION_INVALID, 'clause');
    if (typeof clause.clauseId !== 'string' || clause.clauseId === '') fail(C.WAGE_DEFINITION_INCOMPLETE, 'every clause needs a clauseId');
    if (INVISIBLE.test(clause.clauseId)) invalid('a clauseId must not contain invisible characters');
    if (clauses.has(clause.clauseId)) invalid(`duplicate clauseId ${clause.clauseId}`);
    if (provenance.kind === FIXTURE_KIND && !clause.clauseId.startsWith(FIXTURE_CLAUSE_PREFIX)) {
      invalid(`a fixture clause id must start with ${FIXTURE_CLAUSE_PREFIX}: it may not pose as a real clause`, { clauseId: clause.clauseId });
    }
    if (clause.denominator === undefined || clause.pool === undefined) fail(C.WAGE_DEFINITION_INCOMPLETE, `clause ${clause.clauseId} must state its denominator and pool shares`);
    const d = Q.fromCanonical(clause.denominator);
    const p = Q.fromCanonical(clause.pool);
    const unit = (value) => !Q.isNegative(value) && Q.lte(value, Q.ONE);
    if (!unit(d) || !unit(p) || Q.gt(p, d)) {
      fail(C.MAPPING_PARTITION_INVALID, `clause ${clause.clauseId} violates 0 <= p <= d <= 1`, { clauseId: clause.clauseId, denominator: clause.denominator, pool: clause.pool });
    }
    if (!['DEFINED', 'UNRESOLVED'].includes(clause.poolInterpretation)) fail(C.WAGE_DEFINITION_INCOMPLETE, `clause ${clause.clauseId} must state poolInterpretation DEFINED or UNRESOLVED`);
    if (typeof clause.secondProvisoDependent !== 'boolean') fail(C.WAGE_DEFINITION_INCOMPLETE, `clause ${clause.clauseId} must state secondProvisoDependent`);
    const facts = parseFactSpecs(clause.clauseId, clause.requiredFacts);
    const contradictions = parseContradictions(clause.clauseId, clause.factContradictions, facts);
    clauses.set(clause.clauseId, { clauseId: clause.clauseId, d, p, poolInterpretation: clause.poolInterpretation, secondProvisoDependent: clause.secondProvisoDependent, facts, contradictions });
  }

  rejectUnknownKeys(rule.inKind, new Set(['status']), C.RULE_DEFINITION_INVALID, 'inKind');
  rejectUnknownKeys(rule.secondProviso, new Set(['status', 'decisionRef']), C.RULE_DEFINITION_INVALID, 'secondProviso');
  if (!['DISABLED'].includes(rule.inKind.status)) invalid('inKind.status can only be DISABLED: in-kind calculation is not approved', { inKind: rule.inKind });
  if (!['UNRESOLVED', 'DECIDED'].includes(rule.secondProviso.status)) invalid('secondProviso.status must be UNRESOLVED or DECIDED');
  if (rule.secondProviso.status === 'UNRESOLVED' && rule.secondProviso.decisionRef !== undefined) invalid('an UNRESOLVED second proviso cannot cite a decision');
  if (rule.secondProviso.status === 'DECIDED' && (typeof rule.secondProviso.decisionRef !== 'string' || rule.secondProviso.decisionRef === '')) fail(C.WAGE_DEFINITION_INCOMPLETE, 'a DECIDED second proviso must cite its decisionRef');

  return { threshold, clauses, provenance };
}

/** True when a rule labels itself, or any of its parts, as a mathematical fixture. */
const looksLikeFixture = (rule) => {
  if (!isPlainObject(rule)) return false;
  const marked = (text) => typeof text === 'string' && text.toUpperCase().startsWith('FIXTURE');
  return (isPlainObject(rule.provenance) && (rule.provenance.kind === FIXTURE_KIND || rule.provenance.fixtureId !== undefined))
    || (Array.isArray(rule.clauses) && rule.clauses.some((clause) => isPlainObject(clause) && marked(clause.clauseId)));
};

/**
 * May this rule be used in this context? `options` is omitted or `{ context }`. Omitted means
 * PRODUCTION. TEST accepts a structurally valid rule (including a MATHEMATICAL_FIXTURE). PRODUCTION
 * never succeeds today: a fixture is rejected outright (whatever it is labelled), and anything else
 * needs a trusted legal register that does not exist.
 */
export const assertRuleUsable = guardPublic('assertRuleUsable', assertRuleUsableCore);

function assertRuleUsableCore(candidate, options) {
  const context = contextFromOptions(options);
  const rule = toOwnData(candidate);
  if (context === EXECUTION_CONTEXTS.TEST) return validateRuleDefinition(rule);
  if (looksLikeFixture(rule)) fail(C.MATHEMATICAL_FIXTURE_NOT_ALLOWED, 'a MATHEMATICAL_FIXTURE can never be loaded for production');
  validateRuleDefinition(rule);
  return requireProductionRuleAuthority(rule);
}

const lineProblem = (lineId, message, details) => fail(C.INPUT_LINE_INVALID, `line ${lineId}: ${message}`, details);

function resolveParts(line, clauses) {
  const { classification } = line;
  const lineId = line.lineId;
  if (!isPlainObject(classification) || typeof classification.status !== 'string') {
    return fail(C.STATUTORY_NATURE_MISSING, `line ${lineId} has no statutory classification`);
  }
  const allowedKeys = hasOwn(CLASSIFICATION_KEYS, classification.status) ? CLASSIFICATION_KEYS[classification.status] : undefined;
  if (allowedKeys) rejectUnknownKeys(classification, allowedKeys, C.INPUT_LINE_INVALID, `line ${lineId} classification`);
  switch (classification.status) {
    case 'UNCLASSIFIED':
      return fail(C.STATUTORY_NATURE_MISSING, `line ${lineId} is unclassified`);
    case 'AMBIGUOUS':
      return fail(C.CLASSIFICATION_AMBIGUOUS, `line ${lineId} has an ambiguous classification and none is chosen for it`, { candidates: classification.candidates || null });
    case 'MATCHED': {
      const matched = classification.matchedClauses;
      if (!isDenseArray(matched) || matched.length === 0) return fail(C.STATUTORY_NATURE_MISSING, `line ${lineId} matched no clause`);
      if (matched.length > 1) return fail(C.CLAUSE_MATCH_CONFLICT, `line ${lineId} matches ${matched.length} clauses with no declared split; the first is never chosen`, { matched });
      if (typeof matched[0] !== 'string' || matched[0] === '') return fail(C.INPUT_LINE_INVALID, `line ${lineId} names a malformed matched clause`);
      return [{ target: 'CLAUSE', clauseId: matched[0], portion: Q.ONE }];
    }
    case 'CLASSIFIED': {
      if (!isDenseArray(classification.parts) || classification.parts.length === 0) return fail(C.MAPPING_PARTITION_INVALID, `line ${lineId} states no parts`);
      const parts = [];
      const targets = new Set();
      for (const part of classification.parts) {
        if (!isPlainObject(part) || !['INCLUDED', 'CLAUSE'].includes(part.target)) return fail(C.MAPPING_PARTITION_INVALID, `line ${lineId} has a malformed part`);
        rejectUnknownKeys(part, PART_KEYS[part.target], C.INPUT_LINE_INVALID, `line ${lineId} part`);
        if (part.target === 'CLAUSE' && (typeof part.clauseId !== 'string' || part.clauseId === '')) return fail(C.MAPPING_PARTITION_INVALID, `line ${lineId} has a clause part with no clauseId`);
        const targetKey = part.target === 'INCLUDED' ? 'INCLUDED' : `CLAUSE:${part.clauseId}`;
        if (targets.has(targetKey)) return fail(C.STATUTORY_CLASSIFICATION_OVERLAP, `line ${lineId} claims ${targetKey} twice`, { target: targetKey });
        targets.add(targetKey);
        const portion = Q.fromCanonical(part.portion);
        if (Q.isNegative(portion) || Q.isZero(portion) || Q.gt(portion, Q.ONE)) return fail(C.MAPPING_PARTITION_INVALID, `line ${lineId} has a portion outside (0, 1]`, { portion: part.portion });
        parts.push({ target: part.target, clauseId: part.target === 'CLAUSE' ? part.clauseId : undefined, portion });
      }
      const total = Q.sum(parts.map((part) => part.portion));
      if (Q.gt(total, Q.ONE)) return fail(C.STATUTORY_CLASSIFICATION_OVERLAP, `line ${lineId}'s portions add to more than the whole amount`, { total: Q.toCanonical(total) });
      if (Q.lt(total, Q.ONE)) return fail(C.MAPPING_PARTITION_INVALID, `line ${lineId}'s portions leave part of the amount unassigned; no silent default is applied`, { total: Q.toCanonical(total) });
      return parts;
    }
    default:
      return fail(C.CLASSIFICATION_AMBIGUOUS, `line ${lineId} has an unknown classification status ${JSON.stringify(classification.status)}`);
  }
}

/**
 * Check a line's facts against the specs of the clauses its parts use: every declared fact present
 * (missing/null/undefined -> MISSING), of the declared type and range (INVALID, including an explicit
 * UNKNOWN), no undeclared key, and no declared contradiction.
 */
function validateLineFacts(line, clauseParts, clauses) {
  const declared = new Map(); // name -> [specs]
  for (const part of clauseParts) for (const spec of clauses.get(part.clauseId).facts.values()) {
    declared.set(spec.name, [...(declared.get(spec.name) || []), spec]);
  }
  if (line.facts !== undefined && !isPlainObject(line.facts)) lineProblem(line.lineId, 'facts must be an object');
  const supplied = line.facts === undefined ? Object.create(null) : line.facts; // never a literal: it would inherit from Object.prototype
  for (const key of Object.keys(supplied)) {
    if (!declared.has(key)) fail(C.REMUNERATION_FACT_UNDECLARED, `line ${line.lineId} supplies fact "${key}", which no clause of its parts declares`, { fact: key });
  }
  for (const part of clauseParts) {
    const clause = clauses.get(part.clauseId);
    for (const spec of clause.facts.values()) {
      if (supplied[spec.name] === undefined || supplied[spec.name] === null) {
        fail(C.REMUNERATION_FACT_MISSING, `line ${line.lineId} needs fact "${spec.name}" for clause ${clause.clauseId}`, { fact: spec.name, clauseId: clause.clauseId });
      }
      const problem = factValueProblem(spec, supplied[spec.name]);
      if (problem) fail(C.REMUNERATION_FACT_INVALID, `line ${line.lineId} fact "${spec.name}" ${problem}`, { fact: spec.name, clauseId: clause.clauseId, reason: problem });
    }
    for (const contradiction of clause.contradictions) {
      if (Object.entries(contradiction).every(([name, value]) => sameFactValue(supplied[name], value))) {
        fail(C.REMUNERATION_FACT_CONTRADICTORY, `line ${line.lineId} supplies a combination of facts that clause ${clause.clauseId} declares contradictory`, { clauseId: clause.clauseId, facts: Object.keys(contradiction) });
      }
    }
  }
  return supplied;
}

/** The canonical form of a rule for hashing: array order of clauses and fact specs is not meaningful. */
function canonicalRuleForm(rule) {
  const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    ...rule,
    clauses: [...rule.clauses].map(({ factContradictions, ...clause }) => ({
      ...clause,
      requiredFacts: [...clause.requiredFacts].map((spec) => (spec.values ? { ...spec, values: [...spec.values].sort(byText) } : spec)).sort((a, b) => byText(a.name, b.name)),
      ...(factContradictions && factContradictions.length > 0 ? { factContradictions: [...factContradictions].sort((a, b) => byText(hashCanonical(a), hashCanonical(b))) } : {}),
    })).sort((a, b) => byText(a.clauseId, b.clauseId)),
  };
}

function hashRule(rule) {
  try {
    return hashCanonical(canonicalRuleForm(rule));
  } catch (error) {
    if (error instanceof CanonicalizationError) return invalid(`the rule cannot be canonicalized: ${error.message}`);
    throw error;
  }
}

/**
 * Compute the statutory wage for fully classified lines under an explicit rule definition.
 * `options` is omitted (PRODUCTION) or `{ context: 'TEST' | 'PRODUCTION' }`.
 * Throws StatutoryWageError (named, fail-closed) for any incomplete, ambiguous or unapproved input.
 */
export function computeStatutoryWage(args, options) {
  try {
    return computeCore(args, options);
  } catch (error) {
    if (error instanceof StatutoryWageError) throw error;
    return fail(C.INPUT_MALFORMED, `the input could not be processed safely (${error && error.name ? error.name : 'unknown error'}); nothing is computed`, { cause: error && error.name ? error.name : null });
  }
}

function computeCore(rawArgs, options) {
  const context = contextFromOptions(options);
  const args = toOwnData(rawArgs); // own data only, at every depth
  if (!isPlainObject(args)) invalid('computeStatutoryWage needs { rule, lines }');
  rejectUnknownKeys(args, new Set(['rule', 'lines']), C.RULE_DEFINITION_INVALID, 'argument');
  const { rule, lines } = args;
  const { threshold, clauses, provenance } = assertRuleUsable(rule, { context });
  if (!isDenseArray(lines)) fail(C.INPUT_LINE_INVALID, 'lines must be an array');
  const ruleHash = hashRule(rule);

  const seen = new Set();
  const ordered = [...lines].sort((a, b) => (String(a?.lineId) < String(b?.lineId) ? -1 : String(a?.lineId) > String(b?.lineId) ? 1 : 0));
  let included = Q.ZERO;
  const perClause = new Map([...clauses.keys()].sort().map((id) => [id, Q.ZERO]));
  const lineRecords = [];

  for (const line of ordered) {
    if (!isPlainObject(line) || typeof line.lineId !== 'string' || line.lineId === '' || INVISIBLE.test(line.lineId)) fail(C.INPUT_LINE_INVALID, 'every line needs a lineId (text without invisible characters)');
    if (seen.has(line.lineId)) lineProblem(line.lineId, 'duplicate lineId');
    seen.add(line.lineId);
    const inKind = line.inKind; // `line` is own data (toOwnData): an inherited value cannot appear here
    if (inKind === true) fail(C.IN_KIND_RULE_UNRESOLVED, `line ${line.lineId} is remuneration in kind; in-kind calculation is not approved`);
    const amount = Q.fromIntegerPaise(line.amountPaise);
    if (Q.isNegative(amount)) fail(C.INPUT_AMOUNT_NEGATIVE, `line ${line.lineId} has a negative amount`);

    const parts = resolveParts(line, clauses);
    rejectUnknownKeys(line, LINE_KEYS, C.INPUT_LINE_INVALID, `line ${line.lineId}`);

    // In-kind: `true` is in-kind remuneration (blocked). `false` is the only permitted not-in-kind form.
    // Omitted, null, strings, numbers, objects and arrays are an UNKNOWN state: blocked, never read as false.
    if (inKind !== false) fail(C.IN_KIND_STATUS_INVALID, `line ${line.lineId} must state inKind explicitly as the boolean false (or true, which is blocked); anything else is an unknown state`, { received: inKind === undefined ? 'omitted' : typeof inKind });

    const clauseParts = parts.filter((part) => part.target === 'CLAUSE');
    for (const part of clauseParts) {
      if (!clauses.has(part.clauseId)) fail(C.STATUTORY_NATURE_NOT_IN_RULE, `line ${line.lineId} refers to clause ${part.clauseId}, which this rule does not define`, { clauseId: part.clauseId });
    }
    const facts = validateLineFacts(line, clauseParts, clauses);

    const recordedParts = [];
    for (const part of parts) {
      const portionAmount = Q.mul(amount, part.portion);
      if (part.target === 'INCLUDED') {
        included = Q.add(included, portionAmount);
        recordedParts.push({ target: 'INCLUDED', portion: Q.toCanonical(part.portion), portionAmountPaise: Q.toCanonical(portionAmount) });
        continue;
      }
      const clause = clauses.get(part.clauseId);
      if (clause.poolInterpretation !== 'DEFINED') fail(C.WAGE_POOL_INTERPRETATION_UNRESOLVED, `clause ${clause.clauseId}'s pool interpretation is unresolved`, { clauseId: clause.clauseId });
      if (clause.secondProvisoDependent && rule.secondProviso.status !== 'DECIDED') {
        fail(C.WAGE_SECOND_PROVISO_SCOPE_UNRESOLVED, `clause ${clause.clauseId} depends on the second proviso, whose scope is unresolved`, { clauseId: clause.clauseId });
      }
      perClause.set(part.clauseId, Q.add(perClause.get(part.clauseId), portionAmount));
      recordedParts.push({ target: 'CLAUSE', clauseId: part.clauseId, portion: Q.toCanonical(part.portion), portionAmountPaise: Q.toCanonical(portionAmount) });
    }
    lineRecords.push({ lineId: line.lineId, amountPaise: Q.toCanonical(amount), parts: recordedParts, ...(Object.keys(facts).length === 0 ? {} : { facts: structuredClone(facts) }) });
  }

  let denominatorShare = Q.ZERO; // sum(d_c * X_c)
  let pool = Q.ZERO;             // P
  let unqualified = Q.ZERO;      // U
  const clauseRecords = [];
  for (const [clauseId, amount] of perClause) {
    const clause = clauses.get(clauseId);
    const inDenominator = Q.mul(clause.d, amount);
    const inPool = Q.mul(clause.p, amount);
    const notInPool = Q.mul(Q.sub(clause.d, clause.p), amount);
    denominatorShare = Q.add(denominatorShare, inDenominator);
    pool = Q.add(pool, inPool);
    unqualified = Q.add(unqualified, notInPool);
    clauseRecords.push({
      clauseId,
      amountPaise: Q.toCanonical(amount),
      denominator: Q.toCanonical(clause.d),
      pool: Q.toCanonical(clause.p),
      inDenominatorPaise: Q.toCanonical(inDenominator),
      inPoolPaise: Q.toCanonical(inPool),
      notInPoolPaise: Q.toCanonical(notInPool),
    });
  }

  const allRemuneration = Q.add(included, denominatorShare);          // R_all
  const thresholdAmount = Q.mul(threshold, allRemuneration);          // t * R_all
  const addBack = Q.max(Q.ZERO, Q.sub(pool, thresholdAmount));        // max(0, P - t R_all)
  const wage = Q.add(included, addBack);                              // W

  const body = {
    engine: { name: ENGINE_NAME, version: ENGINE_VERSION },
    unit: 'PAISE_EXACT_RATIONAL',
    evaluationContext: context, // today always TEST: a PRODUCTION evaluation cannot succeed
    rule: { ruleId: rule.ruleId, version: rule.version, provenance: describeProvenance(looksLikeFixture(rule)), ruleHash },
    inputDigest: hashCanonical({ lines: lineRecords }),
    threshold: Q.toCanonical(threshold),
    lines: lineRecords,
    clauses: clauseRecords,
    totals: {
      includedPaise: Q.toCanonical(included),
      allRemunerationPaise: Q.toCanonical(allRemuneration),
      poolPaise: Q.toCanonical(pool),
      unqualifiedPaise: Q.toCanonical(unqualified),
      thresholdAmountPaise: Q.toCanonical(thresholdAmount),
      addBackPaise: Q.toCanonical(addBack),
      wagePaise: Q.toCanonical(wage),
    },
    stages: { contributionRounding: 'NOT_APPLIED_UNAPPROVED' },
  };
  return { ...body, resultHash: hashCanonical(body) };
}

/**
 * A pure exact-product helper: a wage (canonical rational paise, >= 0) times a rate (canonical rational, 0 <= rate <= 1), as an
 * exact canonical rational. It is NOT the ESI contribution and does not claim to be: it knows no approved rate, no contribution
 * period, no wage definition and no rounding rule, it takes no rule, and its result is not an amount that may be charged,
 * stored or shown. The final contribution can only come from a stage that applies an APPROVED rounding rule, and that stage
 * (roundContribution) always fails with CONTRIBUTION_ROUNDING_UNAPPROVED, so no contribution can bypass the rounding gate:
 * there is no function here that returns one.
 */
export const exactProduct = guardPublic('exactProduct', exactProductCore);

function exactProductCore(input) {
  const args = toOwnData(input);
  if (!isPlainObject(args)) fail(C.INPUT_MALFORMED, 'exactProduct needs { wagePaise, rate }');
  rejectUnknownKeys(args, new Set(['wagePaise', 'rate']), C.INPUT_MALFORMED, 'argument');
  const wage = Q.fromCanonical(args.wagePaise);
  const rate = Q.fromCanonical(args.rate);
  if (Q.isNegative(wage)) fail(C.INPUT_AMOUNT_NEGATIVE, 'wagePaise must not be negative');
  if (Q.isNegative(rate) || Q.gt(rate, Q.ONE)) invalid('rate must satisfy 0 <= rate <= 1', { rate: args.rate });
  return Q.toCanonical(Q.mul(wage, rate));
}

/** Gated: no contribution rounding mode is approved, so this never returns an amount. */
export function roundContribution() {
  return fail(C.CONTRIBUTION_ROUNDING_UNAPPROVED, 'the contribution rounding rule is not approved; no rounding mode is selected');
}
