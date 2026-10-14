/**
 * test_phase1d_isolation.js — the Phase 1D scaffold is isolated, and nothing historical moved.
 *
 * Groups P (historical hash stability), Q (legacy calculation equality, byte for byte),
 * U (contribution rounding golden vectors, kept separately gated) and the structural proof that no
 * payroll path calls the scaffold, that it reads no database, clock, randomness or environment, and
 * that no activation switch exists.
 *
 * The goldens below were captured from the Phase 1C checkpoint (HEAD a6a8432) code. They are
 * characterization values: they detect any later movement. They are not statements of the law.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeSnapshotHash } from './src/models/PayrollSnapshot.js';
import complianceCalculationService from './src/services/complianceCalculationService.js';
import { applyStatutoryRounding } from './src/utils/money.js';
import { shapes } from './test_support/snapshotShapes.js';
import { roundContribution, exactProduct } from './src/statutoryWage/wageEngine.js';
import * as Q from './src/statutoryWage/rational.js';
import { StatutoryWageError, STATUTORY_WAGE_ERROR_CODES as C } from './src/statutoryWage/errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const walk = (dir, out = []) => {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    if (name.name === 'node_modules' || name.name === 'dist') continue;
    const full = path.join(dir, name.name);
    if (name.isDirectory()) walk(full, out);
    else if (/\.(js|jsx|mjs|cjs|ts)$/.test(name.name)) out.push(full);
  }
  return out;
};
const rel = (file) => path.relative(path.join(here, '..'), file).split(path.sep).join('/');

describe('isolation: no payroll path calls the scaffold', () => {
  test('nothing outside src/statutoryWage and the Phase 1D tests refers to it', () => {
    const root = path.join(here, '..');
    const offenders = [];
    for (const dir of [path.join(here, 'src'), path.join(here, 'scripts'), path.join(root, 'frontend', 'src')]) {
      if (!fs.existsSync(dir)) continue;
      for (const file of walk(dir)) {
        if (rel(file).startsWith('backend/src/statutoryWage/')) continue;
        if (/statutoryWage/.test(fs.readFileSync(file, 'utf8'))) offenders.push(rel(file));
      }
    }
    for (const file of fs.readdirSync(here).filter((name) => /\.(js|mjs)$/.test(name))) {
      if (/^test_phase1d_|^server\.js$/.test(file) && file !== 'server.js') continue;
      if (/statutoryWage|wageOracle|wageFixtures/.test(fs.readFileSync(path.join(here, file), 'utf8')) && !/^test_phase1d_/.test(file)) offenders.push(`backend/${file}`);
    }
    assert.deepEqual(offenders, [], 'no live caller exists');
  });

  test('the server entry point and the application do not import it', () => {
    for (const file of ['server.js', 'src/app.js']) {
      const source = fs.readFileSync(path.join(here, file), 'utf8');
      assert.doesNotMatch(source, /statutoryWage/);
    }
  });
});

describe('purity: the scaffold reads no database, clock, randomness, environment or network', () => {
  const files = fs.readdirSync(path.join(here, 'src', 'statutoryWage')).filter((name) => name.endsWith('.js')).map((name) => path.join(here, 'src', 'statutoryWage', name));
  const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('imports are limited to sibling modules and node:crypto', () => {
    assert.ok(files.length >= 6);
    for (const file of files) {
      const imports = [...stripComments(fs.readFileSync(file, 'utf8')).matchAll(/(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const specifier of imports) assert.ok(specifier.startsWith('./') || specifier === 'node:crypto', `${rel(file)} imports ${specifier}`);
    }
  });

  test('no database driver, filesystem, network, process, clock or random source is used', () => {
    for (const file of files) {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      for (const forbidden of [/\bmongoose\b/, /\brequire\(/, /\bprocess\./, /\bDate\.now\b/, /\bnew Date\b/, /\bMath\.random\b/, /\bfetch\(/, /\bnode:(fs|http|https|net|child_process|os)\b/, /\bsetTimeout\b|\bsetInterval\b/]) {
        assert.doesNotMatch(code, forbidden, `${rel(file)} must not use ${forbidden}`);
      }
    }
  });

  test('there is no activation switch: no environment flag, no enable/activate/switch export, no default rule', () => {
    for (const file of files) {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      assert.doesNotMatch(code, /process\.env/);
      assert.doesNotMatch(code, /export\s+(const|function)\s+(enable|activate|switchOn|isEnabled|isActive|setActive|enableStatutoryWage|activateStatutoryWage|useCodeEraWage)/);
      assert.doesNotMatch(code, /DEFAULT_(RULE|THRESHOLD|CEILING)|defaultRule|defaultThreshold/i);
    }
    // and nothing in the application's configuration or model layer mentions one
    for (const dir of ['src/config', 'src/models']) {
      if (!fs.existsSync(path.join(here, dir))) continue;
      for (const file of walk(path.join(here, dir))) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /STATUTORY_WAGE|statutoryWage/);
    }
  });
});

describe('no production register, legal value or approval is embedded in the scaffold', () => {
  const files = fs.readdirSync(path.join(here, 'src', 'statutoryWage')).filter((name) => name.endsWith('.js')).map((name) => path.join(here, 'src', 'statutoryWage', name));
  const code = (file) => fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('no hash literal, no real instrument number, no legal rate or ceiling, no approver name', () => {
    for (const file of files) {
      const text = code(file);
      assert.doesNotMatch(text, /[0-9a-f]{64}/, `${rel(file)} embeds a hash`);
      assert.doesNotMatch(text, /(5206|5310|5313|5319|5936|2060|2351|1648|1649|1650|2144)/, `${rel(file)} names a real instrument`);
      assert.doesNotMatch(text, /(21000|0\.0075|0\.0325|3\/400|13\/400)/, `${rel(file)} embeds a legal rate or ceiling`);
    }
  });

  test('the production gate has no parameter, setter, environment switch or hard-coded register: it takes the rule and always throws', async () => {
    const authority = await import('./src/statutoryWage/productionAuthority.js');
    assert.deepEqual(Object.keys(authority).sort(), ['describeProvenance', 'requireProductionRuleAuthority']);
    // it accepts only the rule: an extra argument (a register, a flag) is ignored and changes nothing
    assert.throws(() => authority.requireProductionRuleAuthority({}, { register: { trusted: true } }, true), (error) => error instanceof StatutoryWageError);
    for (const rule of [undefined, null, {}, { provenance: { approval: { interpretation: 'COMPLIANCE_APPROVED', enablement: 'ENABLED' } } }]) {
      assert.throws(() => authority.requireProductionRuleAuthority(rule), (error) => error instanceof StatutoryWageError);
    }
    assert.doesNotMatch(code(path.join(here, 'src', 'statutoryWage', 'productionAuthority.js')), /(register|REGISTER)\w*\s*=/, 'no register is assigned in the gate');
  });
});

describe('P — historical hashes: every snapshot vintage still hashes exactly as it did at the Phase 1C checkpoint', () => {
  const GOLDEN = {
    preWave3: 'ca97dc1e8e700cc297ebc75811b5d0ae668d3460a0ccf08918f4a5e83ded2868',
    wave3: '7862477beea240bfc802fe956be391606b7caf6c312b765edd9b0cac9387023a',
    wave35: 'b87e19f8dc97468cf8ffffc7a31918ada6be3c127deb38869b727c2469c76600',
    phase1c: 'ea10ab63b2b071a125a772df40cc30ff45ff5750d7780547efff699e49d2bb4d',
    phase1cDiffering: '22cc3768b3abe41f2afa56eaea81ce78a3bb8bbb2543919e0e49af6046ca6892',
    preWave3WithUndefinedStatutoryBases: 'fd15a061cf51278dc2ec22beffb147fcc8c35cf8d9bb7bb344810956eab71598',
  };

  for (const [name, expected] of Object.entries(GOLDEN)) {
    test(`${name} hashes to its golden`, () => {
      assert.equal(computeSnapshotHash(shapes()[name]), expected);
    });
  }

  test('an absent optional key and a key set to undefined are different records (and stay different)', () => {
    assert.notEqual(GOLDEN.preWave3, GOLDEN.preWave3WithUndefinedStatutoryBases);
    const absent = shapes().preWave3;
    assert.ok(!('statutoryBases' in absent.payrollInputs), 'a pre-Phase-1C record has no statutoryBases key at all');
  });

  test('the scaffold never changes a snapshot: hashing before and after exercising it is identical', async () => {
    const { computeStatutoryWage } = await import('./src/statutoryWage/wageEngine.js');
    const { fixtureRule, engineLines } = await import('./test_support/wageFixtures.js');
    const snapshot = shapes().phase1c;
    const before = computeSnapshotHash(snapshot);
    computeStatutoryWage({ rule: fixtureRule({ clauses: { FIXTURE_A: { d: '1/1', p: '1/1' } } }), lines: engineLines([{ amountPaise: snapshot.payrollInputs.grossMonthly * 100, parts: [{ portion: '1/1' }] }]) }, { context: 'TEST' });
    assert.equal(computeSnapshotHash(snapshot), before);
    assert.equal(before, GOLDEN.phase1c);
  });
});

describe('Q — the legacy ESI/PT/EPF calculation path is unchanged, value for value', () => {
  const esiRule = { employeeContributionRate: 0.0075, employerContributionRate: 0.0325, grossWageCeiling: 21000, roundingMode: 'CEIL_RUPEE' };
  const epfRule = { employeeContributionRate: 0.12, employerContributionRate: 0.12, wageCapForContribution: 15000, epsRate: 0.0833, epsWageCeiling: 15000, roundingMode: 'NEAREST_RUPEE' };
  const slabs = [{ upTo: 7500, monthlyTax: 0 }, { upTo: 10000, monthlyTax: 175 }, { upTo: null, monthlyTax: 200 }];
  const input = (over) => ({ grossMonthly: 20000, basicSalary: 12000, pfEnrolled: true, esiEnrolled: true, ptEnrolled: true, epfRule, esiRule, ptSlabs: slabs, periodMonth: 3, ...over });

  const CASES = [
    ['bases differ from gross', input({ grossMonthly: 10400, basicSalary: 4000, esiCeilingWage: 10400, esiContributionWage: 7900, ptGross: 8900 }),
      { esi: { enrolled: true, applicable: true, employeeEsi: 60, employerEsi: 257, totalEsi: 317 }, pt: { enrolled: true, applicable: true, pt: 175 }, epf: { enrolled: true, pfWageUsed: 4000, employeeEpf: 480, employerEpf: 480, epsContribution: 333, totalEpf: 960 }, totalEmployeeDeductions: 715 }],
    ['legacy gross only (no bases passed)', input(),
      { esi: { enrolled: true, applicable: true, employeeEsi: 150, employerEsi: 650, totalEsi: 800 }, pt: { enrolled: true, applicable: true, pt: 200 }, epf: { enrolled: true, pfWageUsed: 12000, employeeEpf: 1440, employerEpf: 1440, epsContribution: 1000, totalEpf: 2880 }, totalEmployeeDeductions: 1790 }],
    ['above the ESI ceiling', input({ grossMonthly: 25000 }),
      { esi: { enrolled: true, applicable: false, employeeEsi: 0, employerEsi: 0, totalEsi: 0 }, pt: { enrolled: true, applicable: true, pt: 200 }, epf: { enrolled: true, pfWageUsed: 12000, employeeEpf: 1440, employerEpf: 1440, epsContribution: 1000, totalEpf: 2880 }, totalEmployeeDeductions: 1640 }],
    ['exactly at the ESI ceiling', input({ grossMonthly: 21000 }),
      { esi: { enrolled: true, applicable: true, employeeEsi: 158, employerEsi: 683, totalEsi: 841 }, pt: { enrolled: true, applicable: true, pt: 200 }, epf: { enrolled: true, pfWageUsed: 12000, employeeEpf: 1440, employerEpf: 1440, epsContribution: 1000, totalEpf: 2880 }, totalEmployeeDeductions: 1798 }],
    ['fractional paise gross, no EPF', input({ grossMonthly: 8000.41, basicSalary: 4000, pfEnrolled: false }),
      { esi: { enrolled: true, applicable: true, employeeEsi: 60, employerEsi: 261, totalEsi: 321 }, pt: { enrolled: true, applicable: true, pt: 175 }, epf: { enrolled: false, pfWageUsed: 0, employeeEpf: 0, employerEpf: 0, epsContribution: 0, totalEpf: 0 }, totalEmployeeDeductions: 235 }],
    ['prorated: coverage on the full month, contribution on the earned basis', input({ grossMonthly: 4025.81, basicSalary: 1548.39, esiCeilingWage: 10400, esiContributionWage: 3058.08, ptGross: 3445.17 }),
      { esi: { enrolled: true, applicable: true, employeeEsi: 23, employerEsi: 100, totalEsi: 123 }, pt: { enrolled: true, applicable: false, pt: 0 }, epf: { enrolled: true, pfWageUsed: 1548.39, employeeEpf: 186, employerEpf: 186, epsContribution: 129, totalEpf: 372 }, totalEmployeeDeductions: 209 }],
  ];

  for (const [name, args, expected] of CASES) {
    test(name, () => {
      const result = complianceCalculationService.calculate(args);
      assert.deepEqual(result.esi, expected.esi);
      assert.deepEqual(result.pt, expected.pt);
      assert.deepEqual(result.epf, expected.epf);
      assert.equal(result.totalEmployeeDeductions, expected.totalEmployeeDeductions);
    });
  }

  test('a rule version with no Code-era wage-definition configuration takes the unchanged legacy path', () => {
    const args = input({ grossMonthly: 10400, basicSalary: 4000, esiCeilingWage: 10400, esiContributionWage: 7900, ptGross: 8900 });
    assert.deepEqual(args.esiRule, esiRule, 'the legacy rule carries no wage-definition field');
    assert.ok(!('statutoryWageRule' in args.esiRule) && !('wageDefinition' in args.esiRule));
    assert.deepEqual(complianceCalculationService.calculate(args), complianceCalculationService.calculate(JSON.parse(JSON.stringify(args))));
  });
});

describe('U — contribution rounding: golden vectors kept separately gated', () => {
  const GOLDEN_LEGACY = {
    '59.99': { CEIL_RUPEE: 60, NEAREST_RUPEE: 60, PAISE: 59.99 },
    '60': { CEIL_RUPEE: 60, NEAREST_RUPEE: 60, PAISE: 60 },
    '60.001': { CEIL_RUPEE: 60, NEAREST_RUPEE: 60, PAISE: 60 },
    '60.009': { CEIL_RUPEE: 61, NEAREST_RUPEE: 60, PAISE: 60.01 },
    '60.499': { CEIL_RUPEE: 61, NEAREST_RUPEE: 61, PAISE: 60.5 },
    '60.5': { CEIL_RUPEE: 61, NEAREST_RUPEE: 61, PAISE: 60.5 },
    '60.999': { CEIL_RUPEE: 61, NEAREST_RUPEE: 61, PAISE: 61 },
    '61': { CEIL_RUPEE: 61, NEAREST_RUPEE: 61, PAISE: 61 },
  };

  test('legacy PayGuard rounding is unchanged: round to paise first, then apply the rule version\'s mode', () => {
    for (const [value, expected] of Object.entries(GOLDEN_LEGACY)) {
      for (const mode of ['CEIL_RUPEE', 'NEAREST_RUPEE', 'PAISE']) assert.equal(applyStatutoryRounding(Number(value), mode), expected[mode], `${value} ${mode}`);
    }
  });

  test('CHARACTERIZATION (not a selection): the legacy rounding and a literal ceiling of the exact product disagree, and neither is adopted', () => {
    // A wage of 8,000.10 rupees (800010 paise) at 0.75% (3/400): the exact product is 240003/40 paise,
    // that is 60.00075 rupees. Legacy PayGuard rounds the product to paise first (60.00) and then up
    // (60). A literal "next higher rupee" of the exact product would be 61. Which reading Rule 19
    // requires is an open legal question: this test records the disagreement and selects neither.
    const exact = exactProduct({ wagePaise: '800010/1', rate: '3/400' });
    assert.equal(exact, '240003/40');
    const rupees = Q.mul(Q.fromCanonical(exact), Q.ratio(1, 100));
    assert.equal(Q.toCanonical(rupees), '240003/4000');
    const literalCeil = rupees.n % rupees.d === 0n ? rupees.n / rupees.d : rupees.n / rupees.d + 1n; // candidate reading B, UNAPPROVED, test-only
    assert.equal(literalCeil, 61n);
    assert.equal(applyStatutoryRounding(8000.10 * 0.0075, 'CEIL_RUPEE'), 60, 'legacy PayGuard behavior, unchanged');
    assert.notEqual(Number(literalCeil), applyStatutoryRounding(8000.10 * 0.0075, 'CEIL_RUPEE'));
  });

  test('the engine offers no rounding: the gate is closed', () => {
    for (const args of [[], [{ amountPaise: '5925/1' }, 'CEIL_RUPEE'], ['60003/800', 'NEAREST_RUPEE'], [60.001, 'CEIL_RUPEE']]) {
      let error = null;
      try { roundContribution(...args); } catch (e) { error = e; }
      assert.ok(error instanceof StatutoryWageError);
      assert.equal(error.code, C.CONTRIBUTION_ROUNDING_UNAPPROVED);
    }
  });
});
