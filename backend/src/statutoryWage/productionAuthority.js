/**
 * Production authority gate. Today it has no way to open.
 *
 * A rule, mapping, territorial record or decision is legally usable in PRODUCTION only if it is
 * verified against a TRUSTED, independently validated legal register. No such register exists in this
 * repository: the evidence directory is not wired, the compliance catalogue holds no approved Code-era
 * wage mapping, and nothing here fabricates one. Therefore every PRODUCTION evaluation fails closed
 * with a named code, whatever the caller supplies.
 *
 * What a caller supplies is a CLAIM and never proof:
 *   - an `approval` object, an `approved: true` flag, a `decisionRef`, a `provenance` label,
 *     a `kind: 'REGISTER_APPROVED'` label, or the absence of a fixture label;
 *   - hashes of any kind. A hash proves byte identity of what it covers, not that the content is
 *     correct, current, in scope or approved by anyone competent to approve it.
 *
 * What a future trusted verifier must establish, from a source the caller cannot write to, before
 * this gate may open (these are obligations, not checks that exist today):
 *   1. rule identity: ruleId and version exist in the register and are the current effective version;
 *   2. canonical content: the rule's canonical hash equals the register's stored hash for that entry;
 *   3. source hashes: every cited source artifact hash is in the register's manifest and the stored
 *      bytes re-hash to it;
 *   4. mapping approval: each mapping entry's interpretation is COMPLIANCE_APPROVED and its enablement
 *      is ENABLED, recorded in the register itself by an authorized approver;
 *   5. effective dates and applicable scope (territory, establishment category, period) cover the
 *      calculation being requested.
 *
 * There is no register parameter, no environment switch and no setter: the gate cannot be opened by
 * a caller or by configuration. Opening it is a deliberate code change that must ship together with
 * the verifier and its tests.
 */

import { fail, STATUTORY_WAGE_ERROR_CODES as C } from './errors.js';
import { guardPublic, toOwnData } from './ownData.js';

/**
 * What this module can honestly say about a rule's provenance. It is DERIVED from the verification state, never echoed from
 * the caller's label: no trusted register exists, so nothing is ever verified and nothing is ever legally approved. A rule that is
 * a mathematical fixture says so; a rule that merely CLAIMS to be register-approved is reported as an unverified claim, and the
 * words REGISTER_APPROVED / COMPLIANCE_APPROVED never appear in a result.
 */
export function describeProvenance(isFixture) {
  return isFixture === true
    ? { source: 'MATHEMATICAL_FIXTURE', verification: 'UNVERIFIED_TEST_ONLY', legalStatus: 'NOT_LEGALLY_APPROVED' }
    : { source: 'UNVERIFIED_REGISTER_CLAIM', verification: 'UNVERIFIED_NO_TRUSTED_REGISTER', legalStatus: 'NOT_LEGALLY_APPROVED' };
}

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Always throws. The code reflects what the caller CLAIMED, but both outcomes are failures and the
 * claim is never relied on: an unapproved claim is RULE_NOT_APPROVED, and an approved-looking claim
 * is PRODUCTION_RULE_AUTHORITY_UNAVAILABLE because it cannot be verified.
 */
export const requireProductionRuleAuthority = guardPublic('requireProductionRuleAuthority', requireProductionRuleAuthorityCore);

function requireProductionRuleAuthorityCore(candidate) {
  const rule = toOwnData(candidate);
  const claim = rule && rule.provenance && rule.provenance.approval;
  const claimsApproval = isPlainObject(claim) && claim.interpretation === 'COMPLIANCE_APPROVED' && claim.enablement === 'ENABLED';
  if (!claimsApproval) {
    return fail(C.RULE_NOT_APPROVED, 'the rule carries no approval claim, and a claim would not be trusted anyway: production needs a trusted register');
  }
  return fail(C.PRODUCTION_RULE_AUTHORITY_UNAVAILABLE, 'the rule claims approval, but no trusted legal register exists to verify its identity, content, sources, approval and scope; a caller-supplied claim is never proof');
}
