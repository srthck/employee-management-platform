import mongoose from 'mongoose';

/**
 * ComplianceRuleVersion — versioned statutory rule parameters.
 *
 * Design principles:
 * - Each document is a snapshot of compliance rules for a jurisdiction on a date.
 * - `ruleType`: 'EPF' | 'ESI' | 'PT' — one document per type per jurisdiction per period.
 * - `effectiveFrom` / `effectiveTo` define the valid-time interval.
 * - Rules are resolved by: ruleType + jurisdiction + payroll date.
 * - TDS rules are NOT stored here (TDS is explicitly deferred to a future phase).
 *
 * EPF rules (India, nationwide):
 *   jurisdiction = 'IN'
 *   employeeContributionRate: 0.12  (12% of PF wage)
 *   employerContributionRate: 0.12  (12% — split internally into EPS + EPF diff)
 *   wageCapForContribution: 15000   (PF wage capped at ₹15,000/month for statutory)
 *   voluntaryContributionAllowed: true
 *
 * ESI rules (India, nationwide):
 *   jurisdiction = 'IN'
 *   employeeContributionRate: 0.0075  (0.75%)
 *   employerContributionRate: 0.0325  (3.25%)
 *   grossWageCeiling: 21000           (ESI applies only if gross ≤ ₹21,000/month)
 *
 * PT rules (India, per-state):
 *   jurisdiction = 'MH' | 'KA' | 'AP' | 'TN' | etc.
 *   slabs: [ { upTo: Number, monthlyTax: Number } ]
 *   — upTo: null on the last slab means "above all other slabs"
 */

// ─── EPF sub-schema ──────────────────────────────────────────────────────────
const epfParamsSchema = new mongoose.Schema(
  {
    employeeContributionRate: { type: Number, required: true }, // e.g. 0.12
    employerContributionRate: { type: Number, required: true }, // e.g. 0.12
    wageCapForContribution: { type: Number, required: true },   // e.g. 15000
    epsRate: { type: Number, default: 0.0833 },                  // 8.33% of employer share goes to EPS
    voluntaryContributionAllowed: { type: Boolean, default: true },
  },
  { _id: false }
);

// ─── ESI sub-schema ──────────────────────────────────────────────────────────
const esiParamsSchema = new mongoose.Schema(
  {
    employeeContributionRate: { type: Number, required: true }, // e.g. 0.0075
    employerContributionRate: { type: Number, required: true }, // e.g. 0.0325
    grossWageCeiling: { type: Number, required: true },         // e.g. 21000
  },
  { _id: false }
);

// ─── PT slab sub-schema ───────────────────────────────────────────────────────
const ptSlabSchema = new mongoose.Schema(
  {
    upTo: { type: Number, default: null }, // null = top slab (no upper bound)
    monthlyTax: { type: Number, required: true },
  },
  { _id: false }
);

// ─── Main schema ─────────────────────────────────────────────────────────────
const complianceRuleVersionSchema = new mongoose.Schema(
  {
    ruleType: {
      type: String,
      required: [true, 'Rule type is required'],
      enum: {
        values: ['EPF', 'ESI', 'PT'],
        message: '{VALUE} is not a valid rule type. Must be EPF, ESI, or PT.',
      },
    },

    jurisdiction: {
      type: String,
      required: [true, 'Jurisdiction is required'],
      uppercase: true,
      trim: true,
      // 'IN' for nationwide (EPF, ESI), state codes for PT ('MH', 'KA', 'AP', etc.)
    },

    effectiveFrom: {
      type: Date,
      required: [true, 'Effective from date is required'],
    },
    effectiveTo: {
      type: Date,
      default: null, // null = currently active
    },

    // ─── Rule parameters (only one will be populated per ruleType) ────────
    epfParams: {
      type: epfParamsSchema,
      default: null,
    },
    esiParams: {
      type: esiParamsSchema,
      default: null,
    },
    ptSlabs: {
      type: [ptSlabSchema],
      default: undefined,
    },

    // ─── Metadata ─────────────────────────────────────────────────────────
    description: {
      type: String,
      trim: true,
      maxlength: [500, 'Description cannot exceed 500 characters'],
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────
complianceRuleVersionSchema.index({ ruleType: 1, jurisdiction: 1, effectiveFrom: 1 });
complianceRuleVersionSchema.index({ ruleType: 1, jurisdiction: 1, effectiveTo: 1 });

// ─── Static: resolve rule valid for a given date ─────────────────────────────
/**
 * Find the compliance rule version that was valid on a specific date.
 *
 * @param {string} ruleType - 'EPF' | 'ESI' | 'PT'
 * @param {string} jurisdiction - 'IN' | 'MH' | 'KA' | etc.
 * @param {Date} onDate
 * @returns {Promise<ComplianceRuleVersionDocument|null>}
 */
complianceRuleVersionSchema.statics.findValidForDate = function (ruleType, jurisdiction, onDate) {
  return this.findOne({
    ruleType,
    jurisdiction,
    effectiveFrom: { $lte: onDate },
    $or: [
      { effectiveTo: null },
      { effectiveTo: { $gte: onDate } },
    ],
  }).sort({ effectiveFrom: -1 });
};

export default mongoose.model('ComplianceRuleVersion', complianceRuleVersionSchema);
