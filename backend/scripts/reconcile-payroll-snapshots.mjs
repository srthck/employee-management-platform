#!/usr/bin/env node
/**
 * Reconcile pending payroll snapshots (see docs/AUDIT-CHAIN-AND-SNAPSHOT-RECOVERY.md).
 *
 *   node scripts/reconcile-payroll-snapshots.mjs                          DRY RUN (the default): reads, reports, writes nothing
 *   node scripts/reconcile-payroll-snapshots.mjs --json                   the same, as JSON on stdout
 *   node scripts/reconcile-payroll-snapshots.mjs --company <id> --run <id>   narrow the scope
 *   node scripts/reconcile-payroll-snapshots.mjs --apply --purge-orphans --operator "<name>" [--evidence-dir <dir>]
 *
 * The ONLY thing apply mode can do is purge ORPHAN_PENDING snapshots (a PENDING snapshot under a FAILED or
 * CANCELLED run, with an intact hash). It never finalizes anything, never touches a finalized snapshot, a run,
 * staging or an existing audit record, and it refuses to run when the audit chain is invalid or its guards
 * are missing. Every purge writes a before-image to the evidence directory first and an audit event with it.
 *
 * Exit status: 0 = completed (check the report), 1 = refused or failed.
 */
import fs from 'node:fs';
import mongoose from 'mongoose';
import config from '../src/config/environment.js';
import {
  scanPayrollSnapshots, purgeOrphans, ReconciliationRefused, CLASSES, ACTIONS,
} from './lib/snapshotReconciliation.mjs';

const usage = 'usage: reconcile-payroll-snapshots.mjs [--json] [--company <id>] [--run <id>] [--report <file>] [--apply --purge-orphans --operator <name> [--evidence-dir <dir>]]';

function parseArgs(argv) {
  const options = { apply: false, purgeOrphans: false, json: false, company: null, run: null, operator: null, evidenceDir: './reconcile-evidence', report: null };
  const takesValue = new Set(['--company', '--run', '--operator', '--evidence-dir', '--report']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--purge-orphans') options.purgeOrphans = true;
    else if (arg === '--json') options.json = true;
    else if (takesValue.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value. ${usage}`);
      options[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      i += 1;
    } else throw new Error(`unknown argument ${arg}. ${usage}`);
  }
  if (options.apply && !options.purgeOrphans) throw new Error(`--apply needs to be told what to apply: add --purge-orphans. ${usage}`);
  return options;
}

const summarize = (report) => {
  const lines = [
    `Scope: company ${report.scope.companyId}, run ${report.scope.runId}`,
    `Audit chain: ${report.auditChain.valid ? 'valid' : `INVALID (${report.auditChain.reason})`} (${report.auditChain.checkedRecords} records); guards: ${report.auditChainGuards.ok ? 'present' : `MISSING ${report.auditChainGuards.missing.join(', ')}`}`,
    `Snapshots scanned: ${report.totals.snapshots} across ${report.totals.runsWithSnapshots} run(s); finalized runs checked: ${report.totals.closedRuns}`,
    ...Object.values(CLASSES).filter((c) => report.byClass[c]).map((c) => `  ${c.padEnd(34)} ${report.byClass[c]}`),
    `Eligible for purge: ${report.purgeEligible.length}; needing investigation: ${report.items.filter((i) => i.action === ACTIONS.INVESTIGATE).length}; audit gaps (report only): ${report.auditGaps.length + report.runFindings.length}`,
  ];
  return lines.join('\n');
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!config.mongoUri) throw new Error('MONGO_URI is not configured.');
  // autoIndex off: a reconciliation run must never build indexes as a side effect.
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 5000, autoIndex: false });

  const before = await scanPayrollSnapshots({ companyId: options.company, runId: options.run });
  const output = { mode: options.apply ? 'APPLY' : 'DRY_RUN', before };

  if (options.apply) {
    const purge = await purgeOrphans({ scan: before, evidenceDir: options.evidenceDir, operator: options.operator });
    output.purge = purge;
    output.after = await scanPayrollSnapshots({ companyId: options.company, runId: options.run });
  } else {
    output.note = 'DRY RUN: nothing was written. Re-run with --apply --purge-orphans --operator <name> to purge the eligible orphans.';
  }

  if (options.report) fs.writeFileSync(options.report, JSON.stringify(output, null, 2));
  if (options.json) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(`[reconcile] mode: ${output.mode}`);
    console.log(summarize(before));
    if (output.purge) {
      console.log(`[reconcile] purged ${output.purge.purged} of ${output.purge.results.length} eligible; evidence: ${output.purge.evidenceFile}`);
      console.log('[reconcile] after:'); console.log(summarize(output.after));
    } else console.log(`[reconcile] ${output.note}`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof ReconciliationRefused ? `[reconcile] ${error.message}` : `[reconcile] failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
