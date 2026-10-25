#!/usr/bin/env node
/**
 * Initialize (cut over to) the transactional audit-chain head, and report its status.
 * See docs/integrity/AUDIT-CHAIN-HEAD.md for the full cutover procedure.
 *
 *   node scripts/audit-chain-head.mjs                    DRY RUN (default): verify the history and the database shape, print exactly what apply would do; writes nothing
 *   node scripts/audit-chain-head.mjs --status           read-only: judge head, indexes, validator and running index builds as PRODUCTION would (strict)
 *   node scripts/audit-chain-head.mjs --json             any of the above as JSON
 *   node scripts/audit-chain-head.mjs --report <file>    also write the report (dry run, status AND apply) to a NEW file (never overwrites)
 *   node scripts/audit-chain-head.mjs --apply --plan-digest <sha256> --confirm-database <name> --operator <name> [--commit <id>]
 *   --accept-unobservable-index-builds   dry run / apply: proceed although this database user cannot run $currentOp, i.e. cannot
 *                                        tell whether an index build is running. YOU confirm that none is. The acknowledgement is
 *                                        part of the plan digest.
 *   --quiet-seconds <n>                  refuse while the newest audit record is younger than n seconds (default 60). 0 turns this
 *                                        guard off (a warning is printed).
 *
 * The plan digest also covers WHICH cluster was inspected (database name, hosts, replica set): a plan reviewed against one cluster
 * cannot be applied to another, even if a restored copy has the same database name and the same data.
 *
 * Run it ONLY with every application instance, job and script that can write audit records stopped. Apply sets a
 * collection validator that makes the database refuse new audit records from writers that do not know the head
 * protocol, then creates the head from the verified tail in one transaction; it never modifies an existing record.
 *
 * The dry run and --status open the connection with autoIndex/autoCreate off: they create no collection and no index.
 * Exit status: 0 = done (dry run: plan acceptable), 1 = refused or failed.
 */
import fs from 'node:fs';
import mongoose from 'mongoose';
import config from '../src/config/environment.js';
import auditService from '../src/services/auditService.js';
import { planHeadInitialization, applyHeadInitialization, HeadInitializationRefused } from '../src/services/auditChainHeadService.js';
import { parseStrictArgs, CliUsageError } from './lib/cliArgs.mjs';

const usage = 'usage: audit-chain-head.mjs [--status] [--json] [--report <new-file>] [--quiet-seconds <n>] [--accept-unobservable-index-builds] [--apply --plan-digest <sha256> --confirm-database <name> --operator <name> [--commit <id>]]';
const SHA256 = /^[0-9a-f]{64}$/;
const PRINTABLE_SHORT = (text) => typeof text === 'string' && text.length > 0 && text.length <= 100 && !/[\u0000-\u001f\u007f]/.test(text);

function parseArgs(argv) {
  const options = parseStrictArgs(argv, {
    booleans: ['apply', 'status', 'json', 'accept-unobservable-index-builds'],
    values: ['report', 'plan-digest', 'confirm-database', 'operator', 'commit', 'quiet-seconds'],
    usage,
  });
  if (options.quietSeconds !== undefined) {
    if (!/^\d{1,6}$/.test(options.quietSeconds)) throw new CliUsageError(`--quiet-seconds must be a whole number of seconds. ${usage}`);
    options.quietSeconds = Number(options.quietSeconds);
  }
  if (options.apply && options.status) throw new CliUsageError(`--apply and --status cannot be combined. ${usage}`);
  if (options.status && options.acceptUnobservableIndexBuilds) throw new CliUsageError(`--accept-unobservable-index-builds is only meaningful for a dry run or --apply. ${usage}`);
  if (!options.apply) {
    for (const flag of ['planDigest', 'confirmDatabase', 'operator', 'commit']) {
      if (options[flag] !== undefined) throw new CliUsageError(`--${flag.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is only meaningful with --apply. ${usage}`);
    }
  } else {
    if (!options.planDigest || !SHA256.test(options.planDigest)) throw new CliUsageError(`--apply needs --plan-digest <64-hex sha256 of the reviewed plan>. ${usage}`);
    if (!options.confirmDatabase) throw new CliUsageError(`--apply needs --confirm-database <the database name you mean>. ${usage}`);
    if (!PRINTABLE_SHORT(options.operator)) throw new CliUsageError(`--apply needs --operator <name> (at most 100 printable characters). ${usage}`);
    if (options.commit !== undefined && !PRINTABLE_SHORT(options.commit)) throw new CliUsageError(`--commit must be at most 100 printable characters. ${usage}`);
  }
  return options;
}

const printTarget = (target) => console.log(`  target: database ${target.database}; hosts ${target.hosts.join(', ') || '(none resolved)'}${target.replicaSet ? `; replica set ${target.replicaSet}` : ''}${target.srvHost ? `; SRV ${target.srvHost}` : ''}`);

const printStatus = (status) => {
  console.log(`Audit chain protocol (judged as ${status.mode}): ${status.ok ? 'OK' : 'NOT OK'}`);
  console.log(`  head: ${status.head.ok ? `consistent (sequence ${status.head.sequence}, version ${status.head.version})` : `${status.head.code}: ${status.head.reason}`}`);
  for (const index of status.indexes) console.log(`  index ${index.label}: ${index.status}${index.detail ? ` (${index.detail})` : ''}`);
  console.log(`  validator: ${status.validator.status}${status.validator.detail ? ` (${status.validator.detail})` : ''}`);
  console.log(`  index build: ${status.build.state}`);
  for (const issue of status.issues) console.log(`  ${issue.severity.toUpperCase()} ${issue.code}: ${issue.detail}`);
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!config.mongoUri) throw new Error('MONGO_URI is not configured.');
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 5000, autoIndex: false, autoCreate: false });
  const databaseName = mongoose.connection.name;

  if (options.status) {
    auditService._modeOverride = 'strict';
    const status = await auditService.protocolStatus();
    const output = { mode: 'STATUS', database: databaseName, status };
    if (options.report) fs.writeFileSync(options.report, JSON.stringify(output, null, 2), { flag: 'wx' });
    if (options.json) console.log(JSON.stringify(output, null, 2)); else { console.log(`[audit-chain-head] database: ${databaseName}`); printStatus(status); }
    if (!status.ok) process.exitCode = 1;
    return;
  }

  if (options.quietSeconds === 0) console.error('[audit-chain-head] WARNING: --quiet-seconds 0 turns off the only guard against writers that are still running. Make sure every application instance, job and script is stopped.');

  if (!options.apply) {
    const plan = await planHeadInitialization({ quietSeconds: options.quietSeconds ?? 60, acceptUnobservableIndexBuilds: Boolean(options.acceptUnobservableIndexBuilds) });
    const output = { mode: 'DRY_RUN', database: databaseName, plan };
    if (options.report) fs.writeFileSync(options.report, JSON.stringify(output, null, 2), { flag: 'wx' });
    if (options.json) console.log(JSON.stringify(output, null, 2));
    else {
      console.log(`[audit-chain-head] mode: DRY_RUN, database: ${databaseName}`);
      printTarget(plan.target);
      console.log(`Records: ${plan.counts.records} (verified: ${plan.counts.verifiedRecords}); tail: ${plan.tail ? `sequence ${plan.tail.sequence}, ${plan.tail.createdAt}` : 'none (empty chain)'}`);
      console.log(`Index build on the audit collection: ${plan.indexBuild.state}${plan.unobservableAccepted ? ' (accepted by the operator: --accept-unobservable-index-builds)' : ''}`);
      console.log(`Plan: ${plan.ok ? 'ACCEPTABLE' : `REFUSED (${plan.findings.length} finding(s))`}`);
      for (const action of plan.actions) console.log(`  would: ${action}`);
      for (const finding of plan.findings) console.log(`  ${finding.code}: ${finding.detail}`);
      console.log(`Plan digest: ${plan.digest}`);
      console.log(`Limitation: ${plan.limitation}`);
      console.log('[audit-chain-head] DRY RUN: nothing was written.');
    }
    if (!plan.ok) process.exitCode = 1;
    return;
  }

  if (options.confirmDatabase !== databaseName) {
    throw new CliUsageError(`--confirm-database ${JSON.stringify(options.confirmDatabase)} does not match the connected database ${JSON.stringify(databaseName)}; nothing was written.`);
  }
  const result = await applyHeadInitialization({ expectedDigest: options.planDigest, operator: options.operator, commit: options.commit ?? null, quietSeconds: options.quietSeconds ?? 60, acceptUnobservableIndexBuilds: Boolean(options.acceptUnobservableIndexBuilds) });
  auditService._modeOverride = 'strict';
  const status = await auditService.protocolStatus();
  const output = { mode: 'APPLIED', database: databaseName, target: result.target, operator: options.operator, commit: options.commit ?? null, planDigest: result.planDigest, tail: result.tail, headSequence: result.tail ? result.tail.sequence : 0, appliedAt: new Date().toISOString(), status };
  if (options.report) fs.writeFileSync(options.report, JSON.stringify(output, null, 2), { flag: 'wx' }); // the evidence of an irreversible step
  if (options.json) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(`[audit-chain-head] APPLIED by ${options.operator} on ${databaseName}; plan ${result.planDigest}; head at sequence ${output.headSequence}`);
    printTarget(result.target);
    printStatus(status);
  }
  if (!status.ok) process.exitCode = 1;
}

main()
  .catch((error) => {
    const known = error instanceof CliUsageError || error instanceof HeadInitializationRefused;
    console.error(known ? `[audit-chain-head] ${error.message}` : `[audit-chain-head] failed: ${error.message}`);
    if (error instanceof HeadInitializationRefused && error.findings) for (const f of error.findings) console.error(`  ${f.code}: ${f.detail}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
