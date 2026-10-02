/**
 * money — the one home for monetary rounding and its display.
 *
 * This module CENTRALIZES the rounding PayGuard already performs. It does not
 * change it: every function below reproduces, character for character, the
 * arithmetic of the private copy it replaces. Where those copies differed
 * (null handling, the epsilon term) the difference is kept, as a separate
 * named export, so no result anywhere moves by a paisa.
 *
 * Four kinds of rounding are kept apart on purpose:
 *
 *   money rounding         roundToPaise, roundToPaiseStrict, roundToPaiseNoEpsilon
 *   statutory rounding     applyStatutoryRounding (the rule version's roundingMode)
 *   proration-factor       roundProrationFactor (six decimals, not money)
 *   display                formatRupees, formatRatePercent
 *
 * The rounding ALGORITHM (round half up with an epsilon guard) is unchanged
 * here. Replacing it is a separate, separately approved step that needs a
 * golden-value comparison against stored results first.
 */

/**
 * Round to paise. Null, undefined and NaN count as zero.
 * Used for component amounts, proration, totals, CTC and net pay.
 */
export const roundToPaise = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

/**
 * Round to paise WITHOUT coercion: undefined and NaN stay NaN, so a missing
 * input surfaces instead of becoming a zero. The statutory calculator relies
 * on this and must keep it.
 */
export const roundToPaiseStrict = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Round to paise without the epsilon term. Kept for the one place that has
 * always used it (the employer contribution total frozen into a snapshot).
 * On the sums of already-rounded amounts that site feeds it, the epsilon never
 * changes the result (see test_rounding.js), but it is not merged until that
 * is a decision and not an observation.
 */
export const roundToPaiseNoEpsilon = (x) => Math.round(x * 100) / 100;

/** Round a proration factor to six decimals. This is a ratio, not money. */
export const roundProrationFactor = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 1e6) / 1e6;

export const ROUNDING_MODES = Object.freeze({
  PAISE: 'PAISE',
  NEAREST_RUPEE: 'NEAREST_RUPEE',
  CEIL_RUPEE: 'CEIL_RUPEE',
});

/**
 * Round a statutory contribution as its rule version says:
 *   PAISE          two decimals (default, backward compatible)
 *   NEAREST_RUPEE  nearest rupee (EPFO ECR practice)
 *   CEIL_RUPEE     up to the next rupee (ESIC practice)
 * The mode is part of the versioned rule, so a change in practice is a new rule
 * version and never alters historical results.
 */
export const applyStatutoryRounding = (amount, mode = ROUNDING_MODES.PAISE) => {
  const paise = roundToPaiseStrict(amount);
  if (mode === ROUNDING_MODES.NEAREST_RUPEE) return Math.round(paise);
  if (mode === ROUNDING_MODES.CEIL_RUPEE) return Math.ceil(paise);
  return paise;
};

/** "₹12,345.60": paise rounded, Indian digit grouping. Display only. */
export const formatRupees = (value) =>
  `₹${roundToPaise(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A rate such as 0.0075 as "0.75%". Display only. */
export const formatRatePercent = (rate) => `${Number((Number(rate) * 100).toFixed(4))}%`;
