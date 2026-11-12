/**
 * test_seed_compliance.js — the compliance-rule seed actually seeds (finding F-H01).
 *
 * Runs the REAL command (`node scripts/seed-compliance-rules.js`, i.e. `npm run seed:compliance`) against a disposable
 * database (SEED_MONGO_URI, default payguard_seed_test), dropped before and after, and checks what it inserted against
 * the schema and against pinned values. The pinned numbers are a tripwire, not a statement of law: changing any of them
 * must be a deliberate, reviewed decision (see docs/legal/SEED-RULES-REVIEW.md), so this test has to be edited with it.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

const BACKEND = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB_URI = process.env.SEED_MONGO_URI || 'mongodb://127.0.0.1:27018/payguard_seed_test?replicaSet=rs0';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'seed-test-secret-long-enough-for-validation';
const { default: ComplianceRuleVersion } = await import('./src/models/ComplianceRuleVersion.js');

const seed = () => spawnSync(process.execPath, ['scripts/seed-compliance-rules.js'], {
  cwd: BACKEND, encoding: 'utf8', timeout: 60_000, env: { ...process.env, MONGO_URI: TEST_DB_URI },
});

const PINNED = {
  EPF: {
    jurisdiction: 'IN', effectiveFrom: '2014-09-01T00:00:00.000Z',
    params: ['epfParams', { employeeContributionRate: 0.12, employerContributionRate: 0.12, wageCapForContribution: 15000, epsRate: 0.0833, epsWageCeiling: 15000, voluntaryContributionAllowed: true, roundingMode: 'NEAREST_RUPEE' }],
    mustSay: [/S\.O\. 5109\(E\)/, /₹25,000/, /undecided/],
  },
  ESI: {
    jurisdiction: 'IN', effectiveFrom: '2019-07-01T00:00:00.000Z',
    params: ['esiParams', { employeeContributionRate: 0.0075, employerContributionRate: 0.0325, grossWageCeiling: 21000, roundingMode: 'CEIL_RUPEE' }],
    mustSay: [/Rule 19/, /undecided/],
  },
  PT: {
    jurisdiction: 'MH', effectiveFrom: '2000-01-01T00:00:00.000Z',
    params: ['ptSlabs', [{ upTo: 7500, monthlyTax: 0 }, { upTo: 10000, monthlyTax: 175 }, { upTo: null, monthlyTax: 200, monthOverrides: [{ month: 2, monthlyTax: 300 }] }]],
    mustSay: [/not verified/, /placeholder/],
  },
};

// Only the fields the seed sets, without Mongoose bookkeeping (_id inside sub-documents).
const plain = (value) => JSON.parse(JSON.stringify(value, (key, v) => (key === '_id' ? undefined : v)));

describe('the compliance-rule seed', () => {
  before(async () => {
    await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 5000 });
    await mongoose.connection.dropDatabase();
  });
  after(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  test('the command inserts exactly the three baseline rule versions, each valid against the real schema', async () => {
    const run = seed();
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /3 rule version\(s\) created/);
    const docs = await ComplianceRuleVersion.find({}).lean();
    assert.deepEqual(docs.map((d) => d.ruleType).sort(), ['EPF', 'ESI', 'PT']);
    for (const doc of docs) {
      const error = new ComplianceRuleVersion(doc).validateSync();
      assert.equal(error, undefined, `${doc.ruleType}: ${error?.message}`);
    }
  });

  test('every value, effective date and description is the reviewed one; no number has moved', async () => {
    const maxLength = ComplianceRuleVersion.schema.path('description').options.maxlength[0];
    for (const [ruleType, expected] of Object.entries(PINNED)) {
      const doc = await ComplianceRuleVersion.findOne({ ruleType }).lean();
      assert.ok(doc, ruleType);
      assert.equal(doc.jurisdiction, expected.jurisdiction);
      assert.equal(doc.effectiveFrom.toISOString(), expected.effectiveFrom);
      assert.equal(doc.effectiveTo, null);
      const [field, values] = expected.params;
      assert.deepEqual(plain(doc[field]), values, `${ruleType} ${field}`);
      assert.ok(doc.description.length <= maxLength, `${ruleType} description is ${doc.description.length} > ${maxLength}`);
      for (const pattern of expected.mustSay) assert.match(doc.description, pattern, `${ruleType} description must state ${pattern}`);
    }
  });

  test('running it again changes nothing: rule versions are never edited or duplicated', async () => {
    const before = plain(await ComplianceRuleVersion.find({}).sort({ ruleType: 1 }).lean());
    const run = seed();
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /0 rule version\(s\) created/);
    assert.deepEqual(plain(await ComplianceRuleVersion.find({}).sort({ ruleType: 1 }).lean()), before);
  });
});
