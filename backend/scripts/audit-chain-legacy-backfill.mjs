#!/usr/bin/env node
/**
 * One-time, explicit migration: put audit records that PREDATE the hash chain into the chain.
 * Never runs at application startup (startup only reports how many such records exist).
 *
 *   node scripts/audit-chain-legacy-backfill.mjs                       DRY RUN (default): preflight + the exact plan, writes nothing
 *   node scripts/audit-chain-legacy-backfill.mjs --json                the same, plan as JSON on stdout
 *   node scripts/audit-chain-legacy-backfill.mjs --report <new-file>   also write the full plan (every record that would change) to a NEW file
 *   node scripts/audit-chain-legacy-backfill.mjs --apply --plan-digest <sha256> --confirm-database <name> --operator <name>
 *
 * What it does and does not do:
 *   - It only FILLS records that have none of sequenceNumber / previousHash / hash. A record that is already
 *     chained is never modified, so no stored hash of existing history changes.
 *   - The preflight REFUSES (exit 1, no write) on: a chain that is forked, has a gap/duplicate/bad link or a
 *     hash mismatch; a partially chained or un-hashable record; an unchained record that sorts before the
 *     chain tail (filling it would mean re-sealing chained records). Refusals are listed, never repaired.
 *   - Apply is bound to the plan you reviewed (--plan-digest), to the database you meant (--confirm-database
 *     must equal the connected database name) and to a named operator. Records are filled one at a time in
 *     chain order with conditional updates, so an interruption leaves a valid chained prefix and a re-run
 *     continues from it. Run it with application writers drained.
 *   - Dry run opens the connection with autoIndex/autoCreate off: it creates no collection and no index.
 *
 * Exit status: 0 = completed, 1 = refused or failed.
 */
import fs from 'node:fs';
import mongoose from 'mongoose';
import config from '../src/config/environment.js';
import auditService from '../src/services/auditService.js';
import { parseStrictArgs, CliUsageError } from './lib/cliArgs.mjs';

const usage = 'usage: audit-chain-legacy-backfill.mjs [--json] [--report <new-file>] [--apply --plan-digest <sha256> --confirm-database <name> --operator <name>]';
const SHA256 = /^[0-9a-f]{64}$/;

function parseArgs(argv) {
  const options = parseStrictArgs(argv, {
    booleans: ['apply', 'json'],
    values: ['report', 'plan-digest', 'confirm-database', 'operator'],
    usage,
  });
  if (!options.apply) {
    for (const flag of ['planDigest', 'confirmDatabase', 'operator']) {
      if (options[flag] !== undefined) throw new CliUsageError(`--${flag.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is only meaningful with --apply. ${usage}`);
    }
  } else {
    if (!options.planDigest || !SHA256.test(options.planDigest)) throw new CliUsageError(`--apply needs --plan-digest <64-hex sha256 of the reviewed plan>. ${usage}`);
    if (!options.confirmDatabase) throw new CliUsageError(`--apply needs --confirm-database <the database name you mean>. ${usage}`);
    if (!options.operator || options.operator.length > 100 || /[\u0000-\u001f\u007f]/.test(options.operator)) throw new CliUsageError(`--apply needs --operator <name> (at most 100 printable characters). ${usage}`);
  }
  return options;
}

const printPlan = (plan) => {
  console.log(`Chained records (verified): ${plan.counts.chained}; records without chain fields: ${plan.counts.unchained}; would change: ${plan.counts.wouldChange}`);
  console.log(`Chain tail: ${plan.tail ? `sequence ${plan.tail.sequenceNumber}` : 'none (migration would start at genesis)'}`);
  console.log(`Preflight: ${plan.ok ? 'OK' : `REFUSED (${plan.findings.length} finding(s))`}`);
  for (const finding of plan.findings.slice(0, 20)) console.log(`  ${finding.code} record=${finding.recordId} seq=${finding.sequenceNumber}: ${finding.detail}`);
  console.log(`Plan digest: ${plan.digest}`);
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!config.mongoUri) throw new Error('MONGO_URI is not configured.');
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 5000, autoIndex: false, autoCreate: false });
  const databaseName = mongoose.connection.name;

  if (!options.apply) {
    const plan = await auditService.planLegacyBackfill();
    const output = { mode: 'DRY_RUN', database: databaseName, plan: { ...plan, changes: plan.changes.map(({ id, ...change }) => change) } };
    if (options.report) fs.writeFileSync(options.report, JSON.stringify(output, null, 2), { flag: 'wx' }); // never overwrites
    if (options.json) console.log(JSON.stringify(output, null, 2));
    else {
      console.log(`[audit-backfill] mode: DRY_RUN, database: ${databaseName}`);
      printPlan(plan);
      console.log('[audit-backfill] DRY RUN: nothing was written.');
    }
    if (!plan.ok) process.exitCode = 1;
    return;
  }

  if (options.confirmDatabase !== databaseName) {
    throw new CliUsageError(`--confirm-database ${JSON.stringify(options.confirmDatabase)} does not match the connected database ${JSON.stringify(databaseName)}; nothing was written.`);
  }
  const result = await auditService.applyLegacyBackfill({ expectedDigest: options.planDigest });
  console.log(`[audit-backfill] APPLIED by ${options.operator} on ${databaseName}: ${result.applied} record(s) chained; plan ${result.digest}`);
  console.log(`[audit-backfill] verifyAuditChain: ${result.verification.valid ? 'valid' : `INVALID (${result.verification.reason})`} (${result.verification.checkedRecords} records)`);
  if (!result.verification.valid) process.exitCode = 1;
}

main()
  .catch((error) => {
    const known = error instanceof CliUsageError || error.code === 'LEGACY_BACKFILL_REFUSED' || error.code === 'LEGACY_BACKFILL_DIGEST_MISMATCH' || error.code === 'LEGACY_BACKFILL_CONFLICT';
    console.error(known ? `[audit-backfill] ${error.message}` : `[audit-backfill] failed: ${error.message}`);
    if (error.applied !== undefined) console.error(`[audit-backfill] ${error.applied} record(s) were chained before it stopped (stopped at ${error.stoppedAt}); the chained prefix is valid and a re-run continues from it.`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
