/**
 * complianceCalculationService — Phase 7 deterministic statutory calculator.
 *
 * Responsibilities:
 * - Accept resolved salary inputs + compliance rule versions.
 * - Calculate EPF, ESI, PT deductions deterministically.
 * - Return a structured compliance result without side effects.
 * - TDS is explicitly DEFERRED (not calculated here).
 *
 * IMPORTANT:
 * - This service does NOT query the database.
 * - All rule documents and salary data must be resolved and passed in by the caller.
 * - This makes the calculations pure and fully testable.
 * - PayrollRunService orchestrates (calls this); this service computes.
 * - Do NOT duplicate logic from this service in PayrollRunService.
 *
 * MONETARY PRECISION & ROUNDING:
 * - Intermediate products are rounded to paise with an epsilon guard, so
 *   binary floating point artefacts (e.g. 1.005 → 1.00) cannot leak into pay.
 * - Each rule version carries a roundingMode:
 *     PAISE          round to 2 decimals (default, backward compatible)
 *     NEAREST_RUPEE  round to the nearest rupee (EPFO ECR practice)
 *     CEIL_RUPEE     round up to the next rupee (ESIC practice)
 *   Rounding is part of the versioned rule, so a change in practice is a new
 *   rule version and never alters historical results.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EPF CALCULATION (India):
 *   PF wage = min(pfWage, wageCapForContribution) [default cap: ₹15,000]
 *   Employee EPF deduction = PF wage × employeeContributionRate (12%)
 *   Employer EPF contribution = PF wage × employerContributionRate (12%)
 *     of which EPS portion = min(PF wage, epsWageCeiling) × epsRate (8.33%)
 *
 * ESI CALCULATION (India):
 *   Applies only if grossMonthly ≤ grossWageCeiling (₹21,000)
 *   Employee ESI = gross × employeeContributionRate (0.75%)
 *   Employer ESI = gross × employerContributionRate (3.25%)
 *
 * PT CALCULATION (India, per-state slabs):
 *   Find the slab where gross ≤ upTo (or upTo is null for top slab)
 *   PT = slab.monthOverrides[periodMonth] if defined, else slab.monthlyTax
 *
 * TDS: DEFERRED. Returns tdsDeferred: true in all results.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// Rounding lives in utils/money.js. This calculator uses the STRICT variant on
// purpose: a missing amount stays NaN instead of silently becoming zero.
import {
  roundToPaiseStrict as round2,
  applyStatutoryRounding as applyRounding,
  ROUNDING_MODES,
} from '../utils/money.js';

export { ROUNDING_MODES };

const complianceCalculationService = {
  /**
   * Calculate EPF contributions.
   *
   * @param {object} params
   * @param {number}  params.pfWage         - Gross PF wage (basic or override)
   * @param {object}  params.epfRule        - ComplianceRuleVersion.epfParams document
   * @param {boolean} params.pfEnrolled     - Whether employee is PF enrolled
   * @returns {{ employeeEpf, employerEpf, epsContribution, totalEpf, pfWageUsed, enrolled }}
   */
  calculateEpf({ pfWage, epfRule, pfEnrolled }) {
    if (!pfEnrolled) {
      return {
        enrolled: false,
        pfWageUsed: 0,
        employeeEpf: 0,
        employerEpf: 0,
        epsContribution: 0,
        totalEpf: 0,
      };
    }

    if (!epfRule) {
      throw new Error('EPF rule parameters are required for EPF calculation');
    }

    const {
      employeeContributionRate,
      employerContributionRate,
      wageCapForContribution,
      epsRate = 0.0833,
      epsWageCeiling = null,
      roundingMode = ROUNDING_MODES.PAISE,
    } = epfRule;

    const cappedWage = Math.min(pfWage, wageCapForContribution);
    const epsWage = epsWageCeiling != null ? Math.min(cappedWage, epsWageCeiling) : cappedWage;
    const employeeEpf = applyRounding(cappedWage * employeeContributionRate, roundingMode);
    const employerEpf = applyRounding(cappedWage * employerContributionRate, roundingMode);
    // EPS is carved out of the employer share and can never exceed it.
    const epsContribution = Math.min(applyRounding(epsWage * epsRate, roundingMode), employerEpf);
    const totalEpf = round2(employeeEpf + employerEpf);

    return {
      enrolled: true,
      pfWageUsed: cappedWage,
      employeeEpf,
      employerEpf,
      epsContribution,
      totalEpf,
    };
  },

  /**
   * Calculate ESI contributions.
   *
   * @param {object} params
   * @param {number}  params.grossMonthly  - Employee's gross monthly salary
   * @param {object}  params.esiRule       - ComplianceRuleVersion.esiParams document
   * @param {boolean} params.esiEnrolled   - Whether employee is ESI enrolled
   * @returns {{ employeeEsi, employerEsi, totalEsi, applicable, enrolled }}
   */
  calculateEsi({ grossMonthly, esiRule, esiEnrolled, ceilingWage = null }) {
    if (!esiEnrolled) {
      return {
        enrolled: false,
        applicable: false,
        employeeEsi: 0,
        employerEsi: 0,
        totalEsi: 0,
      };
    }

    if (!esiRule) {
      throw new Error('ESI rule parameters are required for ESI calculation');
    }

    const {
      employeeContributionRate,
      employerContributionRate,
      grossWageCeiling,
      roundingMode = ROUNDING_MODES.PAISE,
    } = esiRule;

    // Eligibility is decided by the wage for the period (the contractual
    // monthly wage), while the contribution is charged on what was earned.
    // They differ only when a period is prorated; ceilingWage defaults to the
    // same figure, so existing behaviour is unchanged.
    if ((ceilingWage != null ? ceilingWage : grossMonthly) > grossWageCeiling) {
      return {
        enrolled: true,
        applicable: false, // Gross exceeds ceiling — not eligible
        employeeEsi: 0,
        employerEsi: 0,
        totalEsi: 0,
      };
    }

    const employeeEsi = applyRounding(grossMonthly * employeeContributionRate, roundingMode);
    const employerEsi = applyRounding(grossMonthly * employerContributionRate, roundingMode);
    const totalEsi = round2(employeeEsi + employerEsi);

    return {
      enrolled: true,
      applicable: true,
      employeeEsi,
      employerEsi,
      totalEsi,
    };
  },

  /**
   * Calculate Professional Tax.
   *
   * @param {object} params
   * @param {number}   params.grossMonthly  - Employee's gross monthly salary
   * @param {object[]} params.ptSlabs       - Array of { upTo, monthlyTax, monthOverrides? }
   * @param {boolean}  params.ptEnrolled    - Whether employee is PT enrolled
   * @param {number}   [params.periodMonth] - 1–12; selects month-specific amounts
   * @returns {{ pt, applicable, enrolled }}
   */
  calculatePt({ grossMonthly, ptSlabs, ptEnrolled, periodMonth = null }) {
    if (!ptEnrolled) {
      return { enrolled: false, applicable: false, pt: 0 };
    }

    if (!ptSlabs || ptSlabs.length === 0) {
      return { enrolled: true, applicable: false, pt: 0 };
    }

    // Sort slabs: finite upTo values ascending, null-upTo last
    const sorted = [...ptSlabs].sort((a, b) => {
      if (a.upTo === null) return 1;
      if (b.upTo === null) return -1;
      return a.upTo - b.upTo;
    });

    let pt = 0;
    for (const slab of sorted) {
      if (slab.upTo === null || grossMonthly <= slab.upTo) {
        const override = periodMonth && Array.isArray(slab.monthOverrides)
          ? slab.monthOverrides.find((entry) => entry.month === periodMonth)
          : null;
        pt = override ? override.monthlyTax : slab.monthlyTax;
        break;
      }
    }

    return { enrolled: true, applicable: pt > 0, pt: round2(pt) };
  },

  /**
   * Full compliance calculation for one employee in one payroll period.
   *
   * @param {object} input
   * @param {number}   input.grossMonthly     - Gross monthly salary
   * @param {number}   input.basicSalary      - Basic component (for PF wage)
   * @param {number}   [input.pfWageOverride] - Optional PF wage override
   * @param {boolean}  input.pfEnrolled
   * @param {boolean}  input.esiEnrolled
   * @param {boolean}  input.ptEnrolled
   * @param {object}   input.epfRule          - ComplianceRuleVersion.epfParams (or null)
   * @param {object}   input.esiRule          - ComplianceRuleVersion.esiParams (or null)
   * @param {object[]} input.ptSlabs          - ComplianceRuleVersion.ptSlabs (or [])
   * @param {number}   [input.periodMonth]    - 1–12, for month-specific PT
   *
   * @returns {{ epf, esi, pt, tdsDeferred, totalEmployeeDeductions, netPay }}
   */
  calculate(input) {
    const {
      grossMonthly,
      basicSalary,
      pfWageOverride = null,
      pfEnrolled,
      esiEnrolled,
      ptEnrolled,
      epfRule,
      esiRule,
      ptSlabs,
      periodMonth = null,
      // Prorated periods: the wage that decides ESI eligibility, and the gross
      // the professional tax slab is read from. Both default to grossMonthly.
      esiCeilingWage = null,
      ptGross = null,
    } = input;

    const pfWage = pfWageOverride !== null ? pfWageOverride : basicSalary;

    const epf = this.calculateEpf({ pfWage, epfRule, pfEnrolled });
    const esi = this.calculateEsi({ grossMonthly, esiRule, esiEnrolled, ceilingWage: esiCeilingWage });
    const pt  = this.calculatePt({ grossMonthly: ptGross != null ? ptGross : grossMonthly, ptSlabs, ptEnrolled, periodMonth });

    const totalEmployeeDeductions = round2(
      (epf.employeeEpf || 0) +
      (esi.employeeEsi || 0) +
      (pt.pt || 0)
    );

    const netPay = round2(grossMonthly - totalEmployeeDeductions);

    return {
      epf,
      esi,
      pt,
      tdsDeferred: true, // Explicitly deferred per Phase 8 scope
      grossMonthly,
      totalEmployeeDeductions,
      netPay,
    };
  },
};

export default complianceCalculationService;
