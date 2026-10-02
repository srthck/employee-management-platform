/**
 * Seed baseline statutory rule versions (EPF, ESI, Maharashtra PT).
 *
 * Usage:  npm run seed:compliance
 *
 * Why: payroll preflight blocks every employee until EPF/ESI/PT rule versions
 * exist, and there is intentionally no public API to create rules (rules are
 * platform data shared by every company). A fresh installation therefore
 * cannot run payroll without this seed.
 *
 * Idempotent: a rule with the same type, jurisdiction and effectiveFrom is
 * skipped, never overwritten. Changing a rule means adding a NEW version with a
 * later effectiveFrom; historical payroll keeps the version it used.
 *
 * IMPORTANT: statutory values change. Verify each rule against the current
 * EPFO / ESIC / state notifications before using this in production. Each
 * description states what it encodes and what it does not model.
 */

import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import config from '../src/config/environment.js';
import ComplianceRuleVersion from '../src/models/ComplianceRuleVersion.js';

const SYSTEM_ACTOR_ID = new mongoose.Types.ObjectId('000000000000000000000000');

const RULES = [
  {
    ruleType: 'EPF',
    jurisdiction: 'IN',
    effectiveFrom: new Date('2014-09-01T00:00:00Z'),
    description:
      'EPF & MP Act 1952: 12% employee and 12% employer on PF wages capped at ₹15,000/month; ' +
      'EPS 8.33% within the employer share (wage ceiling w.e.f. 01-09-2014). Contributions rounded to the nearest rupee.',
    epfParams: {
      employeeContributionRate: 0.12,
      employerContributionRate: 0.12,
      wageCapForContribution: 15000,
      epsRate: 0.0833,
      epsWageCeiling: 15000,
      voluntaryContributionAllowed: true,
      roundingMode: 'NEAREST_RUPEE',
    },
  },
  {
    ruleType: 'ESI',
    jurisdiction: 'IN',
    effectiveFrom: new Date('2019-07-01T00:00:00Z'),
    description:
      'ESI Act 1948: 0.75% employee and 3.25% employer (w.e.f. 01-07-2019), gross wage ceiling ₹21,000/month; ' +
      'contributions rounded up to the next rupee. Contribution-period continuity and the ₹25,000 ceiling for ' +
      'persons with disability are not modelled.',
    esiParams: {
      employeeContributionRate: 0.0075,
      employerContributionRate: 0.0325,
      grossWageCeiling: 21000,
      roundingMode: 'CEIL_RUPEE',
    },
  },
  {
    ruleType: 'PT',
    jurisdiction: 'MH',
    effectiveFrom: new Date('2000-01-01T00:00:00Z'),
    description:
      'Maharashtra professional tax baseline slabs: up to ₹7,500 nil; ₹7,501–₹10,000 ₹175; above ₹10,000 ₹200 ' +
      '(₹300 in February). The exemption for women earning up to ₹25,000/month is not modelled. ' +
      'effectiveFrom is a baseline placeholder: confirm dates against the state notification.',
    ptSlabs: [
      { upTo: 7500, monthlyTax: 0 },
      { upTo: 10000, monthlyTax: 175 },
      { upTo: null, monthlyTax: 200, monthOverrides: [{ month: 2, monthlyTax: 300 }] },
    ],
  },
];

/** Insert missing baseline rule versions on the current mongoose connection. */
export async function seedComplianceRules() {
  let created = 0;
  for (const rule of RULES) {
    const label = `${rule.ruleType}/${rule.jurisdiction} from ${rule.effectiveFrom.toISOString().slice(0, 10)}`;
    const existing = await ComplianceRuleVersion.findOne({
      ruleType: rule.ruleType,
      jurisdiction: rule.jurisdiction,
      effectiveFrom: rule.effectiveFrom,
    }).lean();

    if (existing) {
      console.log(`skip    ${label} (already present: ${existing._id})`);
      continue;
    }

    const doc = await ComplianceRuleVersion.create({ ...rule, effectiveTo: null, createdBy: SYSTEM_ACTOR_ID });
    created += 1;
    console.log(`created ${label} (${doc._id})`);
  }

  console.log(`\n${created} rule version(s) created. Verify values against current statutory notifications.`);
  return created;
}

// Run as a command (npm run seed:compliance), not when imported.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  (async () => {
    if (!config.mongoUri) throw new Error('MONGO_URI is not configured.');
    await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
    await seedComplianceRules();
  })()
    .catch((err) => {
      console.error(`Seeding failed: ${err.message}`);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}
