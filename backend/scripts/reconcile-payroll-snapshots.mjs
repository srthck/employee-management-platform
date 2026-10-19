#!/usr/bin/env node
/**
 * Reconcile pending payroll snapshots (see docs/AUDIT-CHAIN-AND-SNAPSHOT-RECOVERY.md and docs/integrity/).
 *
 *   node scripts/reconcile-payroll-snapshots.mjs                              DRY RUN (the only mode): reads, reports, writes nothing
 *   node scripts/reconcile-payroll-snapshots.mjs --json                       the same, as JSON on stdout
 *   node scripts/reconcile-payroll-snapshots.mjs --company <id> --run <id>    narrow the scope (24-hex ids)
 *   node scripts/reconcile-payroll-snapshots.mjs --report <file>              also write the report to a NEW file (never overwrites)
 *
 * --apply is DISABLED. Destructive snapshot recovery is withdrawn until its proof-based rebuild (docs/integrity,
 * Phase 4) is independently verified: this script, and the library it uses, contain no code that deletes or
 * modifies a snapshot, a run, staging or an audit record, and no flag, environment variable or configuration
 * enables one. Passing --apply exits with status 1 BEFORE connecting to any database.
 *
 * Dry-run purity: the connection is opened with autoIndex and autoCreate OFF, so no collection and no index is
 * created as a side effect of reading. Arguments are parsed strictly (see lib/cliArgs.mjs): unknown, duplicated,
 * blank or malformed arguments are refused.
 *
 * Exit status: 0 = completed (check the report), 1 = refused or failed.
 */
import fs from 'node:fs';
import mongoose from 'mongoose';
import config from '../src/config/environment.js';
import { scanPayrollSnapshots, staticApplyRefusals, ReconciliationRefused, CLASSES, ACTIONS } from './lib/snapshotReconciliation.mjs';
import { parseStrictArgs, requireObjectId, CliUsageError } from './lib/cliArgs.mjs';

const usage = 'usage: reconcile-payroll-snapshots.mjs [--json] [--company <id>] [--run <id>] [--report <new-file>]   (--apply is disabled)';
const BOOLEANS = ['apply', 'purge-orphans', 'json'];
const VALUES = ['company', 'run', 'operator', 'evidence-dir', 'report'];

function parseArgs(argv) {
  const options = parseStrictArgs(argv, { booleans: BOOLEANS, values: VALUES, usage });
  options.company = requireObjectId(options.company, '--company');
  options.run = requireObjectId(options.run, '--run');
  if (!options.apply) {
    for (const flag of ['purgeOrphans', 'operator', 'evidenceDir']) {
      if (options[flag] !== undefined) throw new CliUsageError(`--${flag.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is only meaningful with --apply, which is disabled. ${usage}`);
    }
  }
  return options;
}

const summarize = (report) => {
  const lines = [
    `Scope: company ${report.scope.companyId}, run ${report.scope.runId}`,
    `Audit chain: ${report.auditChain.valid ? 'valid' : `INVALID (${report.auditChain.reason})`} (${report.auditChain.checkedRecords} records); guards: ${report.auditChainGuards.ok ? 'present' : `MISSING ${report.auditChainGuards.missing.join(', ')}`}`,
    `Snapshots scanned: ${report.totals.snapshots} across ${report.totals.runsWithSnapshots} run(s); finalized runs checked: ${report.totals.closedRuns}`,
    ...Object.values(CLASSES).filter((c) => report.byClass[c]).map((c) => `  ${c.padEnd(34)} ${report.byClass[c]}`),
    `Classified purge-eligible (informational only; apply is disabled): ${report.purgeEligible.length}; needing investigation: ${report.items.filter((i) => i.action === ACTIONS.INVESTIGATE).length}; audit gaps (report only): ${report.auditGaps.length + report.runFindings.length}`,
  ];
  return lines.join('\n');
};

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.apply) {
    // Refused before any database access, whatever else was passed.
    const reasons = staticApplyRefusals({ operator: options.operator, company: options.company, run: options.run });
    throw new ReconciliationRefused(`Refusing to apply: ${reasons.join('; ')}.`, reasons);
  }

  if (!config.mongoUri) throw new Error('MONGO_URI is not configured.');
  // autoIndex AND autoCreate off: a dry run must never create an index or a collection as a side effect.
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 5000, autoIndex: false, autoCreate: false });

  const before = await scanPayrollSnapshots({ companyId: options.company, runId: options.run });
  const output = { mode: 'DRY_RUN', before, note: 'DRY RUN: nothing was written. Apply is disabled (see docs/integrity/).' };

  if (options.report) fs.writeFileSync(options.report, JSON.stringify(output, null, 2), { flag: 'wx' }); // never overwrites
  if (options.json) console.log(JSON.stringify(output, null, 2));
  else {
    console.log('[reconcile] mode: DRY_RUN');
    console.log(summarize(before));
    console.log(`[reconcile] ${output.note}`);
  }
}

main()
  .catch((error) => {
    const known = error instanceof ReconciliationRefused || error instanceof CliUsageError;
    console.error(known ? `[reconcile] ${error.message}` : `[reconcile] failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
