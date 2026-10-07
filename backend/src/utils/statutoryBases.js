/**
 * statutoryBases — the wage an ESI contribution and a professional tax slab are
 * calculated ON, derived from the same frozen compensation lines payroll uses.
 *
 * PURE. No database, no catalogue lookup, no clock, no rule lookup: everything
 * arrives as an argument, so payroll and the compensation preview call this one
 * function and, given the same context, cannot disagree.
 *
 * Vocabulary (one meaning each; none may stand in for another):
 *   esiContributionWage  the EARNED wage the ESI contribution is charged on
 *   ptSlabWage           the wage the professional tax slab is read from
 *   earnedGross          gross for the period. Drives net pay. NOT a statutory basis.
 *   fullMonthlyGross     the contractual monthly gross
 * ESI COVERAGE (who is covered) is a different question with a different wage
 * and is not derived here.
 *
 * Which lines count (Phase 1C, technical wiring):
 *   Until a rule carries an active inclusion matrix, inclusion follows the
 *   treatment flags FROZEN on each compensation line, and every result says so
 *   (inclusionSource LEGACY_TREATMENT_FLAGS). statutoryNature is NOT consulted:
 *   it is not authoritative yet, a null nature is not an error, and no legal
 *   class is assumed. Asking for any other inclusion mode is refused rather than
 *   guessed, because matrix activation is a separate, later gate.
 *
 * How the earned basis is built (no "full-month basis x factor"):
 *   frozen lines -> keep the included recurring earnings -> use each line's own
 *   prorated, individually rounded amount -> sum.
 *   Identity rule: when EVERY recurring earning is included, the basis IS
 *   earnedGross (or fullMonthlyGross for a full-month PT basis), exactly as
 *   payroll computed it before, so default compensation changes by no paisa.
 *
 * Rounding is the existing paise rounding (utils/money.js), unchanged.
 */

import { roundToPaise } from './money.js';

export const INCLUSION_MODES = Object.freeze({ LEGACY_TREATMENT_FLAGS: 'LEGACY_TREATMENT_FLAGS' });

const DIMENSIONS = Object.freeze({
  esiContribution: 'esiWage',
  ptSlab: 'ptWage',
});

const isGrossLine = (line) => line.type === 'EARNING' && line.recurrence === 'RECURRING';

const statutoryError = (code, message) => Object.assign(new Error(message), { code });

/** The frozen flag decides. A line with no frozen flag is refused, never defaulted. */
const includedByFrozenFlag = (line, dimension) => {
  const flag = DIMENSIONS[dimension];
  const value = line.treatments ? line.treatments[flag] : undefined;
  if (value === 'INCLUDED') return true;
  if (value === 'EXCLUDED') return false;
  throw statutoryError(
    'FROZEN_TREATMENT_MISSING',
    `${line.componentCode} has no frozen ${flag} treatment, so it cannot be classified. Nothing is assumed.`
  );
};

const sum = (lines, field) => roundToPaise(lines.reduce((total, line) => total + line[field], 0));

/**
 * Derive the statutory bases from frozen compensation lines.
 *
 * @param {object}   input
 * @param {object[]} input.lines             frozen lines: { componentCode, type, recurrence,
 *                                           treatments, amountMonthly, amountEarned }
 * @param {number}   input.earnedGross       gross for the period, as payroll calculated it
 * @param {number}   input.fullMonthlyGross  the contractual monthly gross
 * @param {string}   input.ptBasis           'EARNED_GROSS' | 'FULL_MONTHLY_GROSS' (company setting)
 * @param {string}   [input.inclusion]       only LEGACY_TREATMENT_FLAGS is available in this phase
 */
export function deriveStatutoryBasesFromLines({
  lines, earnedGross, fullMonthlyGross, ptBasis = 'EARNED_GROSS', inclusion = INCLUSION_MODES.LEGACY_TREATMENT_FLAGS,
}) {
  if (inclusion !== INCLUSION_MODES.LEGACY_TREATMENT_FLAGS) {
    throw statutoryError('INCLUSION_MODE_NOT_ACTIVE', `Inclusion mode ${inclusion} is not active. Matrix activation is a separate gate.`);
  }
  if (!Array.isArray(lines)) throw statutoryError('LINES_REQUIRED', 'Frozen compensation lines are required.');

  const gross = lines.filter(isGrossLine);

  const select = (dimension) => {
    const included = gross.filter((line) => includedByFrozenFlag(line, dimension));
    return { included, everything: included.length === gross.length };
  };
  const esi = select('esiContribution');
  const pt = select('ptSlab');

  const esiContributionWage = esi.everything ? earnedGross : sum(esi.included, 'amountEarned');
  const fullMonth = ptBasis === 'FULL_MONTHLY_GROSS';
  const ptSlabWage = pt.everything
    ? (fullMonth ? fullMonthlyGross : earnedGross)
    : sum(pt.included, fullMonth ? 'amountMonthly' : 'amountEarned');

  // Individually rounded earned lines need not add up to the gross that was
  // prorated as one number. The difference is recorded, in whole paise. Each line
  // and the gross is rounded by at most half a paisa, so it can never exceed
  // floor((lines + 1) / 2): beyond that something is wrong, which is a defect and not a tolerance.
  const lineRoundingResidual = Math.round(sum(gross, 'amountEarned') * 100) - Math.round(earnedGross * 100);
  const bound = Math.floor((gross.length + 1) / 2);
  if (Math.abs(lineRoundingResidual) > bound) {
    throw statutoryError('RESIDUAL_OUT_OF_BOUND', `Line rounding residual ${lineRoundingResidual} paise exceeds the mathematical bound ${bound}.`);
  }

  return {
    esiContributionWage,
    ptSlabWage,
    inclusionSource: { esiContribution: inclusion, ptSlab: inclusion },
    basisSource: 'COMPENSATION_LINES',
    lineRoundingResidual,
    // Lineage for explanations and tests. Not persisted as such.
    lineage: {
      esiContribution: { identity: esi.everything, included: esi.included.map((line) => line.componentCode) },
      ptSlab: { identity: pt.everything, included: pt.included.map((line) => line.componentCode), basis: ptBasis },
    },
  };
}

/**
 * Compensation recorded before compensation existed: only the salary structure's
 * buckets are known, no treatment flags were ever recorded, and ESI and PT were
 * always calculated on the whole gross. That is reproduced, and said so.
 */
export function deriveStatutoryBasesFromSalaryBuckets({ earnedGross, fullMonthlyGross, ptBasis = 'EARNED_GROSS' }) {
  return {
    esiContributionWage: earnedGross,
    ptSlabWage: ptBasis === 'FULL_MONTHLY_GROSS' ? fullMonthlyGross : earnedGross,
    inclusionSource: { esiContribution: 'LEGACY_SALARY_BUCKETS', ptSlab: 'LEGACY_SALARY_BUCKETS' },
    basisSource: 'SALARY_STRUCTURE_BUCKETS',
  };
}

/**
 * A compensation version exists but does not reconcile with its payroll
 * projection. Policy for that state is a separate, later design, so this slice
 * leaves the existing behaviour exactly as it was, labelled and never silent:
 * the same wages as before, no inclusion decision claimed.
 */
export function deriveUnresolvedDriftBases({ earnedGross, fullMonthlyGross, ptBasis = 'EARNED_GROSS' }) {
  return {
    esiContributionWage: earnedGross,
    ptSlabWage: ptBasis === 'FULL_MONTHLY_GROSS' ? fullMonthlyGross : earnedGross,
    basisSource: 'UNRESOLVED_PROJECTION_DRIFT',
  };
}

/**
 * The shape stored in payrollInputs.statutoryBases: only the fields that were
 * actually derived. Nothing is ever written as undefined, because an undefined
 * key hashes differently from an absent one.
 */
export function toStatutoryBasesDocument(derived) {
  const document = {
    esiContributionWage: derived.esiContributionWage,
    ptSlabWage: derived.ptSlabWage,
    basisSource: derived.basisSource,
  };
  if (derived.inclusionSource) document.inclusionSource = { ...derived.inclusionSource };
  if (derived.lineRoundingResidual !== undefined) document.lineRoundingResidual = derived.lineRoundingResidual;
  return document;
}

/** Treat lines as one full month, as the preview does: nothing is prorated. */
export const asFullMonthLines = (lines) => lines.map((line) => ({ ...line, amountEarned: line.amountMonthly }));
