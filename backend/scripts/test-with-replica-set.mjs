/**
 * Run the full backend test suite against a MongoDB replica set with
 * transactions REQUIRED, so atomicity is verified rather than assumed.
 *
 * Usage:
 *   npm run test:replset
 *   npm run test:replset -- mongodb://127.0.0.1:27018/?replicaSet=rs0
 *
 * Default target: mongodb://127.0.0.1:27018/?replicaSet=rs0
 * (start one locally with scripts/start-replica-set.ps1, or use Docker/Atlas).
 */

import { spawn } from 'node:child_process';

const TEST_FILES = [
  'test_phase8.js',
  'test_phase8_correction.js',
  'test_phase9.js',
  'test_phase10.js',
  'test_phase11b.js',
  'test_phase11b_audit_chain.js',
  'test_phase12.js',
  'test_phase13.js',
  'test_wave15.js',
  'test_wave2.js',
  'test_wave3.js',
  'test_wave35.js',
  'test_rounding.js',
];

const base = new URL(process.argv[2] || process.env.REPLICA_SET_URI || 'mongodb://127.0.0.1:27018/?replicaSet=rs0');
const databaseUri = (name) => {
  const uri = new URL(base);
  uri.pathname = `/${name}`;
  return uri.toString();
};

const env = {
  ...process.env,
  REQUIRE_TRANSACTIONS: 'true',
  PHASE10_MONGO_URI: databaseUri('payguard_phase10_test'),
  AUDIT_TEST_MONGO_URI: databaseUri('payguard_phase11b_audit_test'),
  PHASE12_MONGO_URI: databaseUri('payguard_phase12_test'),
  PHASE13_MONGO_URI: databaseUri('payguard_phase13_test'),
  WAVE15_MONGO_URI: databaseUri('payguard_wave15_test'),
  WAVE2_MONGO_URI: databaseUri('payguard_wave2_test'),
  WAVE3_MONGO_URI: databaseUri('payguard_wave3_test'),
  WAVE35_MONGO_URI: databaseUri('payguard_wave35_test'),
};

console.log(`Running ${TEST_FILES.length} suites against ${base.host} with REQUIRE_TRANSACTIONS=true`);

const child = spawn(
  process.execPath,
  ['--test', '--test-concurrency=1', '--test-timeout=120000', ...TEST_FILES],
  { env, stdio: 'inherit' }
);

child.on('exit', (code) => process.exit(code ?? 1));
