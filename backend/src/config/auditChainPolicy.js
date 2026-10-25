/**
 * Audit chain protocol mode — STRICT or RELAXED?
 *
 *   strict   the head document must have been created by the operator (scripts/audit-chain-head.mjs). A missing head, a
 *            missing index or validator, an index build in progress are ERRORS and make readiness fail. No code path ever
 *            creates a head by itself.
 *   relaxed  development/test conveniences: an EMPTY chain may create its own genesis head (on a loopback database only,
 *            see auditService) and a missing index/validator is a warning.
 *
 * Fail closed: relaxed is the exception that must be earned. It needs NODE_ENV to be EXACTLY "development" or "test" and
 * AUDIT_CHAIN_STRICT to be unset or an explicit "false"/"0"/"no". Production, an unset or misspelled NODE_ENV, and any
 * AUDIT_CHAIN_STRICT value we do not understand are strict. Nothing can make production relaxed.
 *
 * Pure function: no I/O, no process state, so every combination is tested exhaustively.
 */

const ENVIRONMENT_CLASSES_THAT_MAY_BE_RELAXED = new Set(['development', 'test']);
const FORCES_STRICT = new Set(['true', '1', 'yes']);
const DOES_NOT_FORCE = new Set(['', 'false', '0', 'no']);

/**
 * @param {{ environmentClass?: string, strictFlag?: string }} input raw values, exactly as found
 * @returns {Readonly<{ strict: boolean, notes: readonly string[] }>}
 */
export function resolveAuditChainPolicy({ environmentClass, strictFlag } = {}) {
  const notes = [];
  let strict = false;
  if (!ENVIRONMENT_CLASSES_THAT_MAY_BE_RELAXED.has(environmentClass)) {
    strict = true;
    notes.push(`environment class ${JSON.stringify(environmentClass ?? null)} is not "development" or "test": strict audit chain protocol.`);
  }
  const flag = typeof strictFlag === 'string' ? strictFlag.trim().toLowerCase() : '';
  if (FORCES_STRICT.has(flag)) {
    strict = true;
    notes.push('AUDIT_CHAIN_STRICT requests the strict audit chain protocol.');
  } else if (!DOES_NOT_FORCE.has(flag)) {
    strict = true;
    notes.push(`AUDIT_CHAIN_STRICT=${JSON.stringify(strictFlag)} is not understood (use true or false): strict audit chain protocol.`);
  }
  return Object.freeze({ strict, notes: Object.freeze(notes) });
}
