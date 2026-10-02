import mongoose from 'mongoose';

/**
 * statutoryBases — the statutory wage bases a payroll result was calculated on,
 * and where they came from (Wave 3.5).
 *
 * STRUCTURE ONLY, in Phase 1B. Nothing calculates or writes these values yet:
 * payroll still calculates ESI and PT exactly as before. The structure exists so
 * the later phases have a place to freeze them, and so a snapshot that carries
 * them verifies.
 *
 * Every field is optional, and the whole sub-document is absent (not an empty
 * object) on every record written so far. It is shared by the staging result and
 * the snapshot so the two cannot drift apart. In a snapshot it sits inside
 * payrollInputs, which the canonical hash already covers, so it is hashed when
 * present and a snapshot without it hashes exactly as it always did.
 *
 * Vocabulary (one meaning each, no substitution):
 *   esiCoverageWage       full-month wage tested against the ESI ceiling
 *   esiContributionWage   earned wage the ESI contribution is charged on
 *   ptSlabWage            the wage the professional tax slab is read from
 */

export const INCLUSION_SOURCES = Object.freeze(['RULE_MATRIX', 'LEGACY_TREATMENT_FLAGS', 'LEGACY_SALARY_BUCKETS']);
export const BASIS_SOURCES = Object.freeze(['COMPENSATION_LINES', 'SALARY_STRUCTURE_BUCKETS', 'UNRESOLVED_PROJECTION_DRIFT']);
export const ESI_COVERAGE_DECISIONS = Object.freeze(['COVERED', 'NOT_COVERED', 'NOT_ENROLLED']);
export const ESI_COVERAGE_MODES = Object.freeze(['PER_PERIOD', 'CONTRIBUTION_PERIOD_CONTINUITY']);

const esiCoverageSchema = new mongoose.Schema(
  {
    decision: { type: String, enum: ESI_COVERAGE_DECISIONS },
    coverageWage: { type: Number },
    ceiling: { type: Number },
    mode: { type: String, enum: ESI_COVERAGE_MODES },
    anchorDate: { type: Date },
    contributionPeriod: {
      type: new mongoose.Schema(
        { start: { type: Date }, end: { type: Date } },
        { _id: false }
      ),
      default: undefined,
    },
    continuityApplied: { type: Boolean },
  },
  { _id: false }
);

const inclusionSourceSchema = new mongoose.Schema(
  {
    esiCoverage: { type: String, enum: INCLUSION_SOURCES },
    esiContribution: { type: String, enum: INCLUSION_SOURCES },
    ptSlab: { type: String, enum: INCLUSION_SOURCES },
  },
  { _id: false }
);

const statutoryBasesSchema = new mongoose.Schema(
  {
    esiCoverageWage: { type: Number },
    esiContributionWage: { type: Number },
    ptSlabWage: { type: Number },
    esiCoverage: { type: esiCoverageSchema, default: undefined },
    inclusionSource: { type: inclusionSourceSchema, default: undefined },
    basisSource: { type: String, enum: BASIS_SOURCES },
    // Sum of the earned gross lines minus the earned gross, in whole paise.
    lineRoundingResidual: { type: Number },
  },
  { _id: false }
);

export default statutoryBasesSchema;
