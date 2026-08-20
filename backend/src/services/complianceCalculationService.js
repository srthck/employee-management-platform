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
 * MONETARY PRECISION:
 * - All amounts are stored as Number (INR paise not used here for MVP).
 * - Amounts are rounded to 2 decimal places using Math.round(x * 100) / 100.
 * - Full arbitrary-precision library (decimal.js) is a Phase 9 upgrade.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EPF CALCULATION (India):
 *   PF wage = min(pfWage, wageCapForContribution) [default cap: ₹15,000]
 *   Employee EPF deduction = PF wage × employeeContributionRate (12%)
 *   Employer EPF contribution = PF wage × employerContributionRate (12%)
 *     of which EPS portion = PF wage × epsRate (8.33%)
 *
 * ESI CALCULATION (India):
 *   Applies only if grossMonthly ≤ grossWageCeiling (₹21,000)
 *   Employee ESI = gross × employeeContributionRate (0.75%)
 *   Employer ESI = gross × employerContributionRate (3.25%)
 *
 * PT CALCULATION (India, per-state slabs):
 *   Find the slab where gross ≤ upTo (or upTo is null for top slab)
 *   PT = slab.monthlyTax
 *
 * TDS: DEFERRED. Returns tdsDeferred: true in all results.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const round2 = (n) => Math.round(n * 100) / 100;

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
    } = epfRule;

    const cappedWage = Math.min(pfWage, wageCapForContribution);
    const employeeEpf = round2(cappedWage * employeeContributionRate);
    const employerEpf = round2(cappedWage * employerContributionRate);
    const epsContribution = round2(cappedWage * epsRate);
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
  calculateEsi({ grossMonthly, esiRule, esiEnrolled }) {
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

    const { employeeContributionRate, employerContributionRate, grossWageCeiling } = esiRule;

    // ESI only applies if gross ≤ ceiling
    if (grossMonthly > grossWageCeiling) {
      return {
        enrolled: true,
        applicable: false, // Gross exceeds ceiling — not eligible
        employeeEsi: 0,
        employerEsi: 0,
        totalEsi: 0,
      };
    }

    const employeeEsi = round2(grossMonthly * employeeContributionRate);
    const employerEsi = round2(grossMonthly * employerContributionRate);
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
   * @param {number}   params.grossMonthly - Employee's gross monthly salary
   * @param {object[]} params.ptSlabs      - Array of { upTo, monthlyTax } (sorted ascending by upTo)
   * @param {boolean}  params.ptEnrolled   - Whether employee is PT enrolled
   * @returns {{ pt, applicable, enrolled }}
   */
  calculatePt({ grossMonthly, ptSlabs, ptEnrolled }) {
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
        pt = slab.monthlyTax;
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
    } = input;

    const pfWage = pfWageOverride !== null ? pfWageOverride : basicSalary;

    const epf = this.calculateEpf({ pfWage, epfRule, pfEnrolled });
    const esi = this.calculateEsi({ grossMonthly, esiRule, esiEnrolled });
    const pt  = this.calculatePt({ grossMonthly, ptSlabs, ptEnrolled });

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
