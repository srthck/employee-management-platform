import mongoose from 'mongoose';
import { STATUTORY_NATURE_PATTERN, STATUTORY_NATURE_MESSAGE } from '../utils/compensation.js';

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
    // EPS is computed on wages up to this ceiling even when PF is paid on a
    // higher wage. null = same as wageCapForContribution.
    epsWageCeiling: { type: Number, default: null },
    voluntaryContributionAllowed: { type: Boolean, default: true },
    // PAISE: round to 2 decimals. NEAREST_RUPEE: EPFO ECR practice.
    roundingMode: { type: String, enum: ['PAISE', 'NEAREST_RUPEE', 'CEIL_RUPEE'], default: 'PAISE' },
  },
  { _id: false }
);

// ─── Statutory inclusion containers (Wave 3.5, Phase 1B) ─────────────────────
//
// CONTAINERS ONLY. A rule version MAY carry an inclusion matrix that maps a
// component's statutory nature key to INCLUDED or EXCLUDED for a wage kind. No
// payroll, preview, readiness or payslip code reads it yet, and NO production
// rule carries one: the keys and their meaning are a compliance decision that is
// still pending. When absent (every rule today) nothing about calculation changes.
//
// Entries are an ARRAY, not a map, so the stored order is explicit and a frozen
// copy of the rule hashes deterministically. A nature may appear once.
const inclusionEntrySchema = new mongoose.Schema(
  {
    nature: { type: String, required: true, trim: true, uppercase: true, match: [STATUTORY_NATURE_PATTERN, STATUTORY_NATURE_MESSAGE] },
    inclusion: { type: String, required: true, enum: ['INCLUDED', 'EXCLUDED'] },
  },
  { _id: false }
);

const uniqueNatures = {
  validator: (entries) => !Array.isArray(entries) || new Set(entries.map((entry) => entry.nature)).size === entries.length,
  message: 'A statutory nature may appear only once in an inclusion matrix.',
};

const inclusionMatrix = () => ({ type: [inclusionEntrySchema], default: undefined, validate: uniqueNatures });

// ESI separates who is COVERED from what contribution is CHARGED on.
const esiInclusionSchema = new mongoose.Schema(
  {
    coverage: inclusionMatrix(),
    contribution: inclusionMatrix(),
  },
  { _id: false }
);

// How long ESI coverage lasts once decided. Mechanism only: contribution-period
// months and whether continuity applies are rule-version values that need
// compliance approval. Without this, coverage is decided each period as today.
const coverageContinuitySchema = new mongoose.Schema(
  {
    mode: { type: String, required: true, enum: ['NONE', 'CONTRIBUTION_PERIOD'] },
    periods: {
      type: [new mongoose.Schema(
        {
          startMonth: { type: Number, required: true, min: 1, max: 12 },
          endMonth: { type: Number, required: true, min: 1, max: 12 },
        },
        { _id: false }
      )],
      default: undefined,
    },
  },
  { _id: false }
);

// ─── ESI sub-schema ──────────────────────────────────────────────────────────
const esiParamsSchema = new mongoose.Schema(
  {
    employeeContributionRate: { type: Number, required: true }, // e.g. 0.0075
    employerContributionRate: { type: Number, required: true }, // e.g. 0.0325
    grossWageCeiling: { type: Number, required: true },         // e.g. 21000
    // CEIL_RUPEE: ESIC rounds contributions up to the next rupee.
    roundingMode: { type: String, enum: ['PAISE', 'NEAREST_RUPEE', 'CEIL_RUPEE'], default: 'PAISE' },
    // Optional, absent today. Not read by payroll yet (see the containers note above).
    statutoryInclusion: { type: esiInclusionSchema, default: undefined },
    coverageContinuity: { type: coverageContinuitySchema, default: undefined },
  },
  { _id: false }
);

// ─── PT slab sub-schema ───────────────────────────────────────────────────────
const ptSlabSchema = new mongoose.Schema(
  {
    upTo: { type: Number, default: null }, // null = top slab (no upper bound)
    monthlyTax: { type: Number, required: true },
    // Month-specific amounts, e.g. Maharashtra collects a higher amount in
    // February so the annual total reaches the statutory cap.
    monthOverrides: {
      type: [new mongoose.Schema(
        {
          month: { type: Number, required: true, min: 1, max: 12 },
          monthlyTax: { type: Number, required: true },
        },
        { _id: false }
      )],
      default: undefined,
    },
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
    // Optional PT inclusion matrix (container only, absent today; see the note above).
    ptInclusion: inclusionMatrix(),

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
