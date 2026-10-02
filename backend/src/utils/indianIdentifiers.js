/**
 * Format rules for Indian statutory and banking identifiers.
 *
 * Validation messages describe the expected FORMAT only and never echo the
 * submitted value, so they are safe to return to clients and to write to logs.
 *
 * Aadhaar is deliberately not collected: payroll does not need it, and storing
 * it brings obligations under the Aadhaar Act that PayGuard does not take on.
 */

export const IDENTIFIERS = Object.freeze({
  pan: {
    label: 'PAN',
    pattern: /^[A-Z]{5}[0-9]{4}[A-Z]$/,
    format: 'five letters, four digits and a letter (for example ABCDE1234F)',
  },
  uan: {
    label: 'UAN',
    pattern: /^\d{12}$/,
    format: '12 digits',
  },
  esicNumber: {
    label: 'ESIC insurance number',
    pattern: /^\d{10}$/,
    format: '10 digits',
  },
  pfMemberId: {
    label: 'PF member ID',
    pattern: /^[A-Z]{5}\d{17}$/,
    format: 'region and office code (five letters) followed by 17 digits',
  },
  bankAccountNumber: {
    label: 'Bank account number',
    pattern: /^\d{9,18}$/,
    format: '9 to 18 digits',
  },
  ifsc: {
    label: 'IFSC',
    pattern: /^[A-Z]{4}0[A-Z0-9]{6}$/,
    format: 'four letters, the digit 0, then six letters or digits',
  },
});

/** Remove spaces and hyphens and uppercase, the way these numbers are printed. */
export const normalizeIdentifier = (value) => String(value ?? '').replace(/[\s-]/g, '').toUpperCase();

/**
 * @param {keyof IDENTIFIERS} kind
 * @param {unknown} value
 * @returns {{ valid: boolean, normalized: string, message: string | null }}
 */
export function validateIdentifier(kind, value) {
  const rule = IDENTIFIERS[kind];
  if (!rule) throw new Error(`Unknown identifier kind: ${kind}`);
  const normalized = normalizeIdentifier(value);
  const valid = typeof value === 'string' && rule.pattern.test(normalized);
  return {
    valid,
    normalized,
    message: valid ? null : `${rule.label} must be ${rule.format}.`,
  };
}

/** Last four characters, stored beside the ciphertext so masked views never decrypt. */
export const lastFour = (normalized) => normalized.slice(-4);

/** Masked display, e.g. "••••••1234F" for a PAN ending in 234F. */
export const maskedFromLastFour = (last4, length) =>
  (last4 ? `${'•'.repeat(Math.max(length - last4.length, 4))}${last4}` : null);
