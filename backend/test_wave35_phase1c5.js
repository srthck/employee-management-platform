/**
 * test_wave35_phase1c5.js — Wave 3.5 Phase 1C.5: the payslip explains the basis that was
 * actually recorded, and claims nothing it did not record.
 *
 * Phase 1C made the ESI contribution basis and the PT slab basis independent of gross.
 * The payslip still said "Gross × rate" and read the PT slab from gross, which is
 * wrong whenever those bases differ from gross, even though every amount reconciles.
 * Phase 1C.5 also stops the legacy explanation from implying more than PayGuard recorded:
 * a legacy calculation basis is named as such (never a "statutory ESI wage"), a basis the
 * snapshot did not record is reported as not recorded (never assumed to be gross), a legacy
 * zero is described as what PayGuard calculated (never as statutory ineligibility), and the
 * ESI and Professional Tax explanations carry separate, non-overlapping disclaimers.
 *
 * Scope: payslipService.js only. Explanations are built ONLY from values recorded in
 * the snapshot. Nothing is recomputed from live compensation, the catalogue or rules,
 * and no calculation, hash or stored value changes.
 *
 * Part 1 is pure (snapshot-shaped inputs, new and old). Part 2 is one end-to-end case
 * from a real payroll run (WAVE35C5_MONGO_URI, default payguard_wave35c5_test).
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'wave35c5-test-secret-that-is-long-enough';
process.env.FIELD_ENCRYPTION_KEYS = `v1:${crypto.randomBytes(32).toString('base64')}`;
process.env.FIELD_ENCRYPTION_ACTIVE_KEY = 'v1';
process.env.FIELD_BLIND_INDEX_KEY = crypto.randomBytes(32).toString('hex');

const TEST_DB_URI = process.env.WAVE35C5_MONGO_URI || 'mongodb://127.0.0.1:27018/payguard_wave35c5_test?replicaSet=rs0';

const { default: app } = await import('./src/app.js');
const { default: ComplianceRuleVersion } = await import('./src/models/ComplianceRuleVersion.js');
const { computeSnapshotHash } = await import('./src/models/PayrollSnapshot.js');
const { default: payslipService } = await import('./src/services/payslipService.js');
const { supportsTransactions } = await import('./src/utils/transaction.js');

const PASSWORD = 'StrongPass123';
const fixed = (componentCode, amount) => ({ componentCode, calculationMethod: 'FIXED_AMOUNT', basis: { amount } });

// ═══════════════════════════════════════════════════════════════════════════
// Part 1 — pure: what the payslip says, for snapshots of every vintage
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 1C.5 — payslip ESI and PT explanations, from recorded snapshot values', () => {
  const id = (n) => n.toString(16).padStart(24, '0');
  const SLABS = [{ upTo: 7500, monthlyTax: 0 }, { upTo: 10000, monthlyTax: 175 }, { upTo: null, monthlyTax: 200 }];
  const ESI_PARAMS = { employeeContributionRate: 0.0075, employerContributionRate: 0.0325, grossWageCeiling: 21000, roundingMode: 'CEIL_RUPEE' };
  const EPF_PARAMS = { employeeContributionRate: 0.12, employerContributionRate: 0.12, wageCapForContribution: 15000, epsRate: 0.0833, epsWageCeiling: 15000, voluntaryContributionAllowed: true, roundingMode: 'NEAREST_RUPEE' };

  const deepFreeze = (value) => {
    Object.values(value).forEach((child) => { if (child && typeof child === 'object' && !(child instanceof Date)) deepFreeze(child); });
    return Object.freeze(value);
  };

  /**
   * A snapshot as payroll writes it. `inputs` and `results` override the defaults, and the hash
   * is computed over the whole record, so integrity.verified is true for an untouched snapshot.
   */
  const snapshot = ({ inputs = {}, results = {}, lines = null, hashed = true } = {}) => {
    const payrollInputs = {
      grossMonthly: 20000, basicSalary: 12000, pfWageOverride: null, pfEnrolled: true, esiEnrolled: true, ptEnrolled: true,
      workState: 'MH', payrollDate: new Date('2026-03-31T00:00:00.000Z'), attendanceAdjustment: 'DEFERRED', ...inputs,
    };
    const doc = {
      _id: id(9), payrollRunId: id(2), companyId: id(1), stagingResultId: id(3), snapshotStatus: 'FINALIZED',
      periodMonth: 3, periodYear: 2026, periodStart: new Date('2026-03-01T00:00:00.000Z'), periodEnd: new Date('2026-03-31T00:00:00.000Z'),
      processingVersion: 1,
      employeeSnapshot: { employeeId: id(4), fullName: 'Asha Verma', email: 'asha.verma@example.com', department: 'Engineering', position: 'Engineer', employmentStatus: 'active', hireDate: new Date('2024-01-15T00:00:00.000Z') },
      salarySnapshot: {
        salaryStructureId: id(5), effectiveFrom: new Date('2026-01-01T00:00:00.000Z'), effectiveTo: null,
        components: { basic: 12000, hra: 4800, conveyanceAllowance: 0, medicalAllowance: 0, specialAllowance: 3200, otherAllowances: 0 },
        grossMonthly: payrollInputs.grossMonthly, currency: 'INR', payFrequency: 'monthly', workState: 'MH', pfEnrolled: true, esiEnrolled: true, ptEnrolled: true, pfWageOverride: null,
      },
      complianceProvenance: [
        { ruleType: 'EPF', ruleId: id(6), jurisdiction: 'IN', effectiveFrom: new Date('2014-09-01T00:00:00.000Z'), effectiveTo: null, sourceReference: 'EPF', parameters: EPF_PARAMS },
        { ruleType: 'ESI', ruleId: id(7), jurisdiction: 'IN', effectiveFrom: new Date('2019-07-01T00:00:00.000Z'), effectiveTo: null, sourceReference: 'ESI', parameters: ESI_PARAMS },
        { ruleType: 'PT', ruleId: id(8), jurisdiction: 'MH', effectiveFrom: new Date('2000-01-01T00:00:00.000Z'), effectiveTo: null, sourceReference: 'MH PT', parameters: { slabs: SLABS } },
      ],
      payrollInputs,
      payrollResults: {
        epf: { enrolled: true, pfWageUsed: 12000, employeeEpf: 1440, employerEpf: 1440, epsContribution: 1000, totalEpf: 2880 },
        esi: { enrolled: true, applicable: true, employeeEsi: 150, employerEsi: 650, totalEsi: 800 },
        pt: { enrolled: true, applicable: true, pt: 200 },
        totalEmployeeDeductions: 1790, employerTotalContribution: 2090, netPayBeforeTDS: 18210, tdsStatus: 'DEFERRED', tdsAmount: null,
        ...results,
      },
      ...(lines && { compensationSnapshot: { compensationVersionId: id(10), version: 1, effectiveFrom: new Date('2026-01-01T00:00:00.000Z'), payBasis: 'MONTHLY', lines } }),
    };
    if (hashed) doc.snapshotHash = computeSnapshotHash(doc);
    return doc;
  };

  const line = (payslip, code) => [...payslip.deductions, ...payslip.employerContributions].find((entry) => entry.code === code);

  const ROUNDING_TEXT = ' (PayGuard rounding setting: to paise, then up to the next whole rupee)';
  const COMPANY_FLAGS = ' by the company\'s compensation settings';

  // The canonical case from Phase 1C: gross 10,400 | ESI contribution basis 7,900 | PT slab basis 8,900.
  const canonical = () => snapshot({
    inputs: {
      grossMonthly: 10400, basicSalary: 4000, fullMonthlyGross: 10400, payableDays: 31, paidDays: 31, prorationFactor: 1, payableDaysBasis: 'CALENDAR_DAYS', professionalTaxBasis: 'EARNED_GROSS',
      statutoryBases: {
        esiContributionWage: 7900, ptSlabWage: 8900, basisSource: 'COMPENSATION_LINES', lineRoundingResidual: 0,
        inclusionSource: { esiContribution: 'LEGACY_TREATMENT_FLAGS', ptSlab: 'LEGACY_TREATMENT_FLAGS' },
      },
    },
    results: {
      epf: { enrolled: true, pfWageUsed: 4000, employeeEpf: 480, employerEpf: 480, epsContribution: 333, totalEpf: 960 },
      esi: { enrolled: true, applicable: true, employeeEsi: 60, employerEsi: 257, totalEsi: 317 },
      pt: { enrolled: true, applicable: true, pt: 175 },
      totalEmployeeDeductions: 715, employerTotalContribution: 737, netPayBeforeTDS: 9685,
    },
  });

  const everyText = (payslip) => [...payslip.deductions, ...payslip.employerContributions].map((entry) => entry.formula).concat(payslip.notes);

  test('recorded basis differs from gross: ESI and PT name the legacy calculation basis that was recorded', () => {
    const payslip = payslipService.buildPayslip(canonical());

    const employee = line(payslip, 'ESI_EMPLOYEE');
    assert.equal(employee.formula, `Legacy calculation basis ₹7,900.00 (gross for this period ₹10,400.00 less ₹2,500.00 not included in this basis${COMPANY_FLAGS}) × 0.75% = ₹60.00${ROUNDING_TEXT}`);
    assert.equal(employee.amount, 60);
    assert.equal(employee.basisAmount, 7900);
    assert.equal(employee.basisSource, 'RECORDED_ON_SNAPSHOT');
    assert.equal(employee.basisDerivation, 'COMPENSATION_LINES', 'the stored statutoryBases.basisSource is exposed separately, as basisDerivation');
    assert.equal(employee.calculationModel, 'PAYGUARD_LEGACY_CONFIGURED_RULE');
    assert.deepEqual(employee.coverageCheck, {
      model: 'PAYGUARD_LEGACY_GROSS_VS_CONFIGURED_CEILING', comparedAmount: 10400, comparedAmountSource: 'RECORDED_FULL_MONTHLY_GROSS', configuredCeiling: 21000, legacyOutcome: 'CONTRIBUTION_CALCULATED',
    });
    assert.deepEqual(employee.roundingModel, {
      mode: 'CEIL_RUPEE', description: 'PayGuard\'s configured rounding step for this rule version. It is not a statement of the rounding the Code or Rules require.',
    });

    const employer = line(payslip, 'ESI_EMPLOYER');
    assert.equal(employer.formula, `Legacy calculation basis ₹7,900.00 (gross for this period ₹10,400.00 less ₹2,500.00 not included in this basis${COMPANY_FLAGS}) × 3.25% = ₹257.00${ROUNDING_TEXT}`);
    assert.equal(employer.amount, 257);

    const pt = line(payslip, 'PT');
    assert.equal(pt.formula, `Legacy calculation basis ₹8,900.00 (gross for this period ₹10,400.00 less ₹1,500.00 not included in this basis${COMPANY_FLAGS}) falls in the MH slab ₹7,500.00 – ₹10,000.00 → ₹175.00`);
    assert.equal(pt.amount, 175);
    assert.equal(pt.basisAmount, 8900);
    assert.equal(pt.basisSource, 'RECORDED_ON_SNAPSHOT');
    assert.equal(pt.calculationModel, 'PAYGUARD_LEGACY_CONFIGURED_RULE');
    assert.equal(pt.ptBasisSetting, 'EARNED_GROSS');

    assert.deepEqual(payslip.checks, { earningsMatchGross: false, deductionsMatchTotal: true, netPayMatchesFormula: true },
      'amounts reconcile (earnings are not part of this synthetic snapshot)');
    assert.equal(payslip.integrity.verified, true, 'explaining it changes nothing that is hashed');
  });

  test('basis recorded and equal to gross: the wording still identifies the legacy calculation basis, never a bare "Gross"', () => {
    const payslip = payslipService.buildPayslip(snapshot({
      inputs: { grossMonthly: 20000, fullMonthlyGross: 20000, statutoryBases: { esiContributionWage: 20000, ptSlabWage: 20000, basisSource: 'COMPENSATION_LINES', lineRoundingResidual: 0 } },
    }));
    assert.equal(line(payslip, 'ESI_EMPLOYEE').formula, `Legacy calculation basis ₹20,000.00 (recorded; equal to gross for this period) × 0.75% = ₹150.00${ROUNDING_TEXT}`);
    assert.equal(line(payslip, 'PT').formula, 'Legacy calculation basis ₹20,000.00 (recorded; equal to gross for this period) falls in the MH slab above ₹10,000.00 → ₹200.00');
    assert.equal(line(payslip, 'ESI_EMPLOYEE').basisAmount, 20000);
    for (const text of everyText(payslip)) assert.doesNotMatch(text, /^Gross /, 'no formula presents "Gross" as the calculation subject');
  });

  test('a prorated joiner: the comparison used the recorded full-month gross, the contribution the recorded basis', () => {
    const payslip = payslipService.buildPayslip(snapshot({
      inputs: {
        grossMonthly: 4025.81, basicSalary: 1548.39, fullMonthlyGross: 10400, payableDays: 31, paidDays: 12, prorationFactor: 0.387097, payableDaysBasis: 'CALENDAR_DAYS', professionalTaxBasis: 'EARNED_GROSS',
        statutoryBases: { esiContributionWage: 3058.08, ptSlabWage: 3445.17, basisSource: 'COMPENSATION_LINES', lineRoundingResidual: 1 },
      },
      results: {
        epf: { enrolled: true, pfWageUsed: 1548.39, employeeEpf: 186, employerEpf: 186, epsContribution: 129, totalEpf: 372 },
        esi: { enrolled: true, applicable: true, employeeEsi: 23, employerEsi: 100, totalEsi: 123 },
        pt: { enrolled: true, applicable: false, pt: 0 },
        totalEmployeeDeductions: 209, employerTotalContribution: 286, netPayBeforeTDS: 3816.81,
      },
    }));
    const esi = line(payslip, 'ESI_EMPLOYEE');
    assert.equal(esi.formula, `Legacy calculation basis ₹3,058.08 (gross for this period ₹4,025.81 less ₹967.73 not included in this basis) × 0.75% = ₹23.00${ROUNDING_TEXT}`);
    assert.equal(esi.coverageCheck.comparedAmount, 10400, 'the full-month gross was what was compared with the ceiling');
    assert.equal(esi.coverageCheck.comparedAmountSource, 'RECORDED_FULL_MONTHLY_GROSS');
    assert.equal(line(payslip, 'PT'), undefined, 'no PT line is produced');
    assert.ok(payslip.notes.includes(
      'PayGuard\'s configured MH slab calculation produced ₹0.00 on a legacy calculation basis of ₹3,445.17. Professional tax is a State levy under the applicable State law; this payslip records PayGuard\'s configured slab result and is not a determination of liability.'
    ), 'the PT note states what PayGuard calculated and names the basis');
  });

  test('legacy zero ESI: the note says what PayGuard calculated and never asserts statutory ineligibility', () => {
    const marked = payslipService.buildPayslip(snapshot({
      inputs: { grossMonthly: 10322.58, fullMonthlyGross: 22000, payableDays: 31, paidDays: 16, prorationFactor: 0.516129, payableDaysBasis: 'CALENDAR_DAYS', professionalTaxBasis: 'EARNED_GROSS', statutoryBases: { esiContributionWage: 10322.58, ptSlabWage: 10322.58, basisSource: 'COMPENSATION_LINES', lineRoundingResidual: -1 } },
      results: { esi: { enrolled: true, applicable: false, employeeEsi: 0, employerEsi: 0, totalEsi: 0 }, totalEmployeeDeductions: 1640, netPayBeforeTDS: 8682.58 },
    }));
    assert.ok(marked.notes.includes(
      'PayGuard\'s legacy check compared full-month gross ₹22,000.00 with the ESI ceiling of ₹21,000.00 configured in this company\'s rule and calculated no ESI contribution. This is PayGuard\'s legacy gross-based check; it is not a determination of statutory coverage under the Code on Social Security, 2020.'
    ));
    assert.equal(line(marked, 'ESI_EMPLOYEE'), undefined);

    const unmarked = payslipService.buildPayslip(snapshot({
      inputs: { grossMonthly: 25000, fullMonthlyGross: 25000 },
      results: { esi: { enrolled: true, applicable: false, employeeEsi: 0, employerEsi: 0, totalEsi: 0 }, totalEmployeeDeductions: 1640, netPayBeforeTDS: 23360 },
    }));
    assert.ok(unmarked.notes.includes(
      'PayGuard calculated no ESI contribution for this period. The wage it compared with the ESI ceiling of ₹21,000.00 configured in this company\'s rule was not recorded on this payroll record (recorded gross for this period ₹25,000.00). This is PayGuard\'s legacy check; it is not a determination of statutory coverage under the Code on Social Security, 2020.'
    ), 'a snapshot that did not record the compared wage says so, instead of claiming it was the gross');
    for (const payslip of [marked, unmarked]) {
      for (const note of payslip.notes) assert.doesNotMatch(note, /no ESI contribution applies/i);
    }
  });

  test('full-month PT basis recorded on the snapshot: the slab is explained from the recorded basis', () => {
    const payslip = payslipService.buildPayslip(snapshot({
      inputs: {
        grossMonthly: 4025.81, fullMonthlyGross: 10400, payableDays: 31, paidDays: 12, prorationFactor: 0.387097, payableDaysBasis: 'CALENDAR_DAYS', professionalTaxBasis: 'FULL_MONTHLY_GROSS',
        statutoryBases: { esiContributionWage: 3058.08, ptSlabWage: 8900, basisSource: 'COMPENSATION_LINES', lineRoundingResidual: 1 },
      },
      results: { esi: { enrolled: true, applicable: true, employeeEsi: 23, employerEsi: 100, totalEsi: 123 }, pt: { enrolled: true, applicable: true, pt: 175 }, totalEmployeeDeductions: 384, netPayBeforeTDS: 3641.81 },
    }));
    const pt = line(payslip, 'PT');
    assert.match(pt.formula, /^Legacy calculation basis ₹8,900\.00 /);
    assert.match(pt.formula, /falls in the MH slab ₹7,500\.00 – ₹10,000\.00 → ₹175\.00$/);
    assert.equal(pt.ptBasisSetting, 'FULL_MONTHLY_GROSS');
    assert.equal(pt.basisAmount, 8900);
    assert.equal(pt.basisSource, 'RECORDED_ON_SNAPSHOT');
  });

  test('a Wave-3.5 snapshot (pay basis recorded, no statutoryBases): PT names the recorded setting; the ESI basis is not recorded', () => {
    const payslip = payslipService.buildPayslip(snapshot({
      inputs: { grossMonthly: 7741.94, basicSalary: 4645.16, fullMonthlyGross: 20000, payableDays: 31, paidDays: 12, prorationFactor: 0.387097, payableDaysBasis: 'CALENDAR_DAYS', professionalTaxBasis: 'FULL_MONTHLY_GROSS' },
      results: { esi: { enrolled: true, applicable: true, employeeEsi: 59, employerEsi: 252, totalEsi: 311 }, pt: { enrolled: true, applicable: true, pt: 200 }, totalEmployeeDeductions: 816, netPayBeforeTDS: 6925.94 },
    }));
    const pt = line(payslip, 'PT');
    assert.equal(pt.formula, 'Legacy calculation basis ₹20,000.00 (full-month gross, per the recorded professional tax basis setting) falls in the MH slab above ₹10,000.00 → ₹200.00');
    assert.equal(pt.basisSource, 'RECORDED_PT_BASIS_SETTING');
    assert.equal(pt.basisAmount, 20000);

    const esi = line(payslip, 'ESI_EMPLOYEE');
    assert.equal(esi.formula, 'ESI employee contribution ₹59.00 as stored. The wage it was calculated on was not recorded on this payroll record (recorded gross for this period ₹7,741.94; rate 0.75%; rounding setting CEIL_RUPEE).',
      'the missing basis is reported as not recorded, never assumed to be the earned gross');
    assert.equal(esi.basisSource, 'NOT_RECORDED');
    assert.equal(esi.basisAmount, null);
    assert.equal(esi.coverageCheck.comparedAmount, null);
    assert.equal(esi.coverageCheck.comparedAmountSource, 'NOT_RECORDED');
    assert.equal(esi.coverageCheck.configuredCeiling, 21000);
    assert.equal(payslip.integrity.verified, true);
  });

  test('the oldest snapshots (no pay basis, no statutoryBases) claim nothing they never recorded', () => {
    const payslip = payslipService.buildPayslip(snapshot());
    assert.equal(line(payslip, 'ESI_EMPLOYEE').formula, 'ESI employee contribution ₹150.00 as stored. The wage it was calculated on was not recorded on this payroll record (recorded gross for this period ₹20,000.00; rate 0.75%; rounding setting CEIL_RUPEE).');
    assert.equal(line(payslip, 'PT').formula, 'Professional tax for MH: ₹200.00 as stored. The wage the state slab was read from was not recorded on this payroll record (recorded gross for this period ₹20,000.00).');
    assert.equal(line(payslip, 'PT').basisSource, 'NOT_RECORDED');
    assert.equal(line(payslip, 'PT').basisAmount, null);
    assert.equal(line(payslip, 'PT').ptBasisSetting, null);
    assert.equal(payslip.payPeriodDays, null, 'no pay basis is claimed');
    // This exact record is the one whose canonical hash was captured at the Phase 1A checkpoint
    // (the same golden used in test_wave35_phase1b). Explaining it leaves that hash valid.
    assert.equal(payslip.integrity.snapshotHash, 'ca97dc1e8e700cc297ebc75811b5d0ae668d3460a0ccf08918f4a5e83ded2868');
    assert.equal(payslip.integrity.verified, true);
  });

  test('a missing basis key never proves what a payroll used: a post-Phase-1C snapshot without it is also "not recorded"', () => {
    const payslip = payslipService.buildPayslip(snapshot({
      inputs: { grossMonthly: 20000, fullMonthlyGross: 20000, statutoryBases: { basisSource: 'COMPENSATION_LINES' } },
    }));
    const esi = line(payslip, 'ESI_EMPLOYEE');
    assert.equal(esi.basisSource, 'NOT_RECORDED');
    assert.equal(esi.basisAmount, null);
    assert.equal(esi.basisDerivation, null);
    assert.match(esi.formula, /was not recorded on this payroll record/);
    assert.equal(line(payslip, 'PT').basisSource, 'NOT_RECORDED');
  });

  test('a basis a paisa above gross (rounding residual) is described without a negative "less"', () => {
    const payslip = payslipService.buildPayslip(snapshot({
      inputs: { grossMonthly: 100, fullMonthlyGross: 100, statutoryBases: { esiContributionWage: 100.01, ptSlabWage: 100, basisSource: 'COMPENSATION_LINES', lineRoundingResidual: 1 } },
      results: { esi: { enrolled: true, applicable: true, employeeEsi: 1, employerEsi: 4, totalEsi: 5 }, pt: { enrolled: true, applicable: false, pt: 0 }, totalEmployeeDeductions: 1441, netPayBeforeTDS: -1341 },
    }));
    const formula = line(payslip, 'ESI_EMPLOYEE').formula;
    assert.match(formula, /^Legacy calculation basis ₹100\.01 \(the included lines, each rounded; gross for this period ₹100\.00\) × /);
    assert.doesNotMatch(formula, /less ₹-/);
  });

  test('ESI and PT disclaimers are separate: the ESI copy never speaks for PT, and the PT copy never cites the Code', () => {
    const esiZero = payslipService.buildPayslip(snapshot({
      inputs: { grossMonthly: 25000, fullMonthlyGross: 25000, statutoryBases: { esiContributionWage: 25000, ptSlabWage: 25000, basisSource: 'COMPENSATION_LINES' } },
      results: { esi: { enrolled: true, applicable: false, employeeEsi: 0, employerEsi: 0, totalEsi: 0 }, pt: { enrolled: true, applicable: false, pt: 0 }, totalEmployeeDeductions: 0, netPayBeforeTDS: 25000 },
    }));
    const esiNote = esiZero.notes.find((note) => /ESI contribution/.test(note));
    const ptNote = esiZero.notes.find((note) => /slab calculation/i.test(note));
    assert.ok(esiNote && ptNote, 'both notes are present');
    assert.match(esiNote, /Code on Social Security, 2020/);
    assert.doesNotMatch(esiNote, /professional tax|State levy|slab/i, 'the ESI note says nothing about PT');
    assert.doesNotMatch(ptNote, /Code on Social Security|2\(88\)|section 2|statutory ESI/i, 'the PT note does not borrow the Code or the ESI wage definition');
    assert.match(ptNote, /State levy under the applicable State law/);
  });

  test('no payslip text claims a statutory ESI wage, a statutory ineligibility, or the old "ESI wage" label', () => {
    const slips = [
      canonical(),
      snapshot(),
      snapshot({ inputs: { grossMonthly: 25000, fullMonthlyGross: 25000, statutoryBases: { esiContributionWage: 25000, ptSlabWage: 25000, basisSource: 'COMPENSATION_LINES' } }, results: { esi: { enrolled: true, applicable: false, employeeEsi: 0, employerEsi: 0, totalEsi: 0 } } }),
    ].map((doc) => payslipService.buildPayslip(doc));
    for (const payslip of slips) {
      for (const text of everyText(payslip)) {
        assert.doesNotMatch(text, /statutory ESI wage/i);
        assert.doesNotMatch(text, /no ESI contribution applies/i);
        assert.doesNotMatch(text, /\bESI wage\b/, 'the legacy "ESI wage" label is gone');
        assert.doesNotMatch(text, /rounded up to the next rupee/, 'legacy rounding is described as PayGuard\'s setting, not as the statutory rule');
      }
    }
  });

  test('response contract: the new fields exist, the draft names do not, and every earlier field is still there', () => {
    const payslip = payslipService.buildPayslip(canonical());
    const esi = line(payslip, 'ESI_EMPLOYEE');
    const pt = line(payslip, 'PT');
    // Fields that existed on these lines before Phase 1C.5 (committed contract): still present, same names.
    for (const key of ['code', 'label', 'amount', 'formula', 'source', 'rateDerivedFromAmounts']) assert.ok(key in esi, `ESI line keeps ${key}`);
    for (const key of ['code', 'label', 'amount', 'formula', 'source']) assert.ok(key in pt, `PT line keeps ${key}`);
    // The added, additive fields.
    for (const key of ['calculationModel', 'basisAmount', 'basisSource', 'basisDerivation', 'recordedGrossMonthly', 'coverageCheck', 'roundingModel']) assert.ok(key in esi, `ESI line has ${key}`);
    for (const key of ['calculationModel', 'basisAmount', 'basisSource', 'basisDerivation', 'ptBasisSetting', 'recordedGrossMonthly']) assert.ok(key in pt, `PT line has ${key}`);
    // The uncommitted draft's names must not survive anywhere.
    for (const entry of [esi, pt]) for (const key of ['wage', 'wageSource', 'coverage', 'basis']) assert.ok(!(key in entry), `${entry.code} must not carry the draft field "${key}"`);
  });

  test('numbers never move: amounts, totals and checks are exactly what the snapshot recorded', () => {
    const payslip = payslipService.buildPayslip(canonical());
    assert.deepEqual(payslip.deductions.map((entry) => [entry.code, entry.amount]), [['EPF_EMPLOYEE', 480], ['ESI_EMPLOYEE', 60], ['PT', 175]]);
    assert.deepEqual(payslip.employerContributions.map((entry) => [entry.code, entry.amount]), [['EPF_EMPLOYER', 480], ['EPS', 333], ['ESI_EMPLOYER', 257]]);
    assert.equal(payslip.totals.gross, 10400);
    assert.equal(payslip.totals.totalDeductions, 715);
    assert.equal(payslip.totals.netPayBeforeTDS, 9685);
    assert.equal(payslip.totals.statutoryEmployerContributions, 737);
    assert.equal(payslip.totals.costToCompany, 11137);
    assert.equal(payslip.totals.netPayFormula, '₹10,400.00 − ₹715.00 = ₹9,685.00');
    assert.deepEqual(payslip.checks, { earningsMatchGross: false, deductionsMatchTotal: true, netPayMatchesFormula: true });
  });

  test('explaining is read-only and deterministic: the snapshot is untouched and the answer repeats', () => {
    const frozen = deepFreeze(canonical());
    const first = payslipService.buildPayslip(frozen);
    const second = payslipService.buildPayslip(frozen);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(computeSnapshotHash(frozen), frozen.snapshotHash, 'the stored hash still matches the record');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Part 2 — one real payroll run, explained end to end
// ═══════════════════════════════════════════════════════════════════════════

let server;
let baseUrl;

function createClient() {
  let cookie = '';
  const request = async (method, url, body) => {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { 'content-type': 'application/json', ...(method !== 'GET' && { 'Idempotency-Key': `test-${globalThis.crypto.randomUUID()}` }), ...(cookie && { cookie }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: response.status, body: json };
  };
  return {
    get: (url) => request('GET', url),
    post: (url, body = {}) => request('POST', url, body),
  };
}

const login = async (email) => {
  const client = createClient();
  const res = await client.post('/auth/login', { email, password: PASSWORD });
  assert.equal(res.status, 200, `login ${email}: ${JSON.stringify(res.body)}`);
  return client;
};

const expectStatus = (res, status) => assert.equal(res.status, status, JSON.stringify(res.body));

before(async () => {
  await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 5000 });
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  assert.equal(await supportsTransactions(), true, 'Wave 3.5 Phase 1C.5 tests need a replica set');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  try {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  } finally {
    await mongoose.disconnect();
  }
});

describe('Phase 1C.5 — the payslip of a real payroll run', () => {
  test('gross, ESI basis and PT basis differ: the payslip says what the run recorded, and the amounts reconcile', async () => {
    const owner = createClient();
    expectStatus(await owner.post('/auth/register', {
      name: 'Owner One', email: 'owner@example.com', password: PASSWORD, confirmPassword: PASSWORD, companyName: 'Acme Payroll',
    }), 201);
    for (const [name, email, role] of [
      ['Pavan Preparer', 'payroll@example.com', 'payroll_admin'],
      ['Anita Approver', 'approver@example.com', 'payroll_approver'],
    ]) expectStatus(await owner.post('/company/users', { name, email, role, password: PASSWORD }), 201);
    const payrollAdmin = await login('payroll@example.com');
    const approver = await login('approver@example.com');

    const createdBy = new mongoose.Types.ObjectId();
    await ComplianceRuleVersion.create([
      { ruleType: 'EPF', jurisdiction: 'IN', effectiveFrom: new Date('2014-09-01'), createdBy, description: 'EPF', epfParams: { employeeContributionRate: 0.12, employerContributionRate: 0.12, wageCapForContribution: 15000, epsRate: 0.0833, epsWageCeiling: 15000, roundingMode: 'NEAREST_RUPEE' } },
      { ruleType: 'ESI', jurisdiction: 'IN', effectiveFrom: new Date('2019-07-01'), createdBy, description: 'ESI', esiParams: { employeeContributionRate: 0.0075, employerContributionRate: 0.0325, grossWageCeiling: 21000, roundingMode: 'CEIL_RUPEE' } },
      { ruleType: 'PT', jurisdiction: 'MH', effectiveFrom: new Date('2000-01-01'), createdBy, description: 'MH PT', ptSlabs: [{ upTo: 7500, monthlyTax: 0 }, { upTo: 10000, monthlyTax: 175 }, { upTo: null, monthlyTax: 200 }] },
    ]);
    for (const component of [
      { code: 'ESI_OUT', name: 'Outside ESI wage', treatments: { esiWage: 'EXCLUDED', ptWage: 'INCLUDED' } },
      { code: 'PT_OUT', name: 'Outside PT wage', treatments: { esiWage: 'INCLUDED', ptWage: 'EXCLUDED' } },
    ]) expectStatus(await payrollAdmin.post('/compensation/components', { type: 'EARNING', ...component }), 201);

    const employee = await owner.post('/employees', {
      firstName: 'Kavya', lastName: 'Rao', email: 'kavya.rao@example.com', department: 'Engineering', position: 'Engineer', salary: 20000, hireDate: '2024-01-15', status: 'active',
    });
    expectStatus(employee, 201);
    const employeeId = employee.body.data.employee._id;
    const proposal = await payrollAdmin.post(`/employees/${employeeId}/compensation/changes`, {
      effectiveFrom: '2026-01-01', reason: 'Phase 1C.5 fixture', workState: 'MH',
      lines: [fixed('BASIC', 4000), fixed('HRA', 1600), fixed('SPECIAL', 800), fixed('ESI_OUT', 2500), fixed('PT_OUT', 1500)],
    });
    expectStatus(proposal, 201);
    const changeId = proposal.body.data.change.id;
    expectStatus(await payrollAdmin.post(`/compensation/changes/${changeId}/submit`), 200);
    expectStatus(await approver.post(`/compensation/changes/${changeId}/approve`), 200);

    const run = await payrollAdmin.post('/payroll-runs', { periodMonth: 3, periodYear: 2026 });
    expectStatus(run, 201);
    const runId = run.body.data.run._id;
    expectStatus(await payrollAdmin.post(`/payroll-runs/${runId}/process`), 200);
    expectStatus(await approver.post(`/payroll-runs/${runId}/finalize`), 200);

    const snapshots = (await approver.get(`/payroll-runs/${runId}/snapshots?limit=50`)).body.data.snapshots;
    const stored = snapshots[0];
    const explained = await approver.get(`/payroll-snapshots/${stored._id}/explain`);
    expectStatus(explained, 200);
    const { payslip } = explained.body.data;

    const esi = payslip.deductions.find((entry) => entry.code === 'ESI_EMPLOYEE');
    const pt = payslip.deductions.find((entry) => entry.code === 'PT');
    assert.equal(payslip.totals.gross, 10400);
    assert.equal(esi.formula, 'Legacy calculation basis ₹7,900.00 (gross for this period ₹10,400.00 less ₹2,500.00 not included in this basis by the company\'s compensation settings) × 0.75% = ₹60.00 (PayGuard rounding setting: to paise, then up to the next whole rupee)');
    assert.equal(esi.basisAmount, 7900);
    assert.equal(esi.basisSource, 'RECORDED_ON_SNAPSHOT');
    assert.equal(esi.calculationModel, 'PAYGUARD_LEGACY_CONFIGURED_RULE');
    assert.equal(pt.formula, 'Legacy calculation basis ₹8,900.00 (gross for this period ₹10,400.00 less ₹1,500.00 not included in this basis by the company\'s compensation settings) falls in the MH slab ₹7,500.00 – ₹10,000.00 → ₹175.00');
    assert.equal(pt.basisAmount, 8900);
    assert.equal(payslip.totals.netPayBeforeTDS, 9685);
    assert.deepEqual(payslip.checks, { earningsMatchGross: true, deductionsMatchTotal: true, netPayMatchesFormula: true });
    assert.equal(payslip.integrity.verified, true);

    // Explaining wrote nothing: the stored snapshot still verifies.
    assert.equal((await approver.get(`/payroll-snapshots/${stored._id}/verify`)).body.data.valid, true);
  });
});
