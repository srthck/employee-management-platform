/**
 * test_wave15.js — Wave 1.5: foundation hardening.
 *
 * Runner: node:test (Node >= 18 built-in)
 * Run:    npm test   (full suite on a replica set)
 *
 * Covers:
 *   - one email pattern for every model, accepting modern top-level domains
 *   - transactions required by default in every environment (only an explicit,
 *     non-production REQUIRE_TRANSACTIONS=false opts out)
 *   - the browser test server refuses to reset any database not named *_e2e
 *   - copying a database (standalone → replica set) preserves every document
 *     byte-for-byte, recreates indexes and never writes into a non-empty target
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mongoose from 'mongoose';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'wave15-test-secret-that-is-long-enough';

const BACKEND = path.dirname(fileURLToPath(import.meta.url));
const BASE_URI = process.env.WAVE15_MONGO_URI || 'mongodb://127.0.0.1:27018/payguard_wave15_test?replicaSet=rs0';
const databaseUri = (name) => {
  const uri = new URL(BASE_URI);
  uri.pathname = `/${name}`;
  return uri.toString();
};

const { isValidEmail } = await import('./src/utils/email.js');
const { default: Admin } = await import('./src/models/Admin.js');
const { default: Employee } = await import('./src/models/Employee.js');
const { default: EmployeeAccount } = await import('./src/models/EmployeeAccount.js');

describe('email validation', () => {
  const emailError = (Model, email) => new Model({ email }).validateSync(['email'])?.errors?.email;

  test('modern and long top-level domains are accepted by every model', () => {
    const valid = [
      'meera@payguard.technology',
      'first.last+payroll@company.co.in',
      'hr@startup.email',
      'a_b-c@sub.domain.museum',
      "o'neil@example.org",
      'x@example.io',
    ];
    for (const email of valid) {
      assert.ok(isValidEmail(email), email);
      for (const Model of [Admin, Employee, EmployeeAccount]) {
        assert.equal(emailError(Model, email), undefined, `${Model.modelName} rejected ${email}`);
      }
    }
  });

  test('malformed addresses are rejected', () => {
    const invalid = [
      'plain', 'a@b', 'a@b.c', 'a..b@example.com', '.a@example.com', 'a.@example.com',
      'a@-example.com', 'a@example..com', 'a b@example.com', 'a@example.c0m', '@example.com', 'a@',
    ];
    for (const email of invalid) {
      assert.equal(isValidEmail(email), false, email);
      assert.ok(emailError(Admin, email), `Admin accepted ${email}`);
    }
  });
});

describe('transaction requirement', () => {
  // A clean working directory, so no .env file influences the result.
  const cwd = mkdtempSync(path.join(tmpdir(), 'payguard-config-'));
  after(() => rmSync(cwd, { recursive: true, force: true }));

  const requireTransactions = (env) => {
    const configUrl = pathToFileURL(path.join(BACKEND, 'src/config/environment.js')).href;
    const script = `const { default: c } = await import(${JSON.stringify(configUrl)}); console.log('RESULT=' + c.requireTransactions);`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        MONGO_URI: 'mongodb://127.0.0.1:27018/config_probe?replicaSet=rs0',
        FRONTEND_URL: 'http://localhost:5173',
        JWT_SECRET: 'x'.repeat(40),
        ...env,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return /RESULT=(true|false)/.exec(result.stdout)[1] === 'true';
  };

  test('transactions are required by default in development, test and production', () => {
    assert.equal(requireTransactions({}), true);
    assert.equal(requireTransactions({ NODE_ENV: 'development' }), true);
    assert.equal(requireTransactions({ NODE_ENV: 'test' }), true);
    assert.equal(requireTransactions({ NODE_ENV: 'production' }), true);
  });

  test('only an explicit opt-out outside production disables them', () => {
    assert.equal(requireTransactions({ NODE_ENV: 'development', REQUIRE_TRANSACTIONS: 'false' }), false);
    assert.equal(requireTransactions({ NODE_ENV: 'production', REQUIRE_TRANSACTIONS: 'false' }), true);
    assert.equal(requireTransactions({ REQUIRE_TRANSACTIONS: 'no' }), true);
  });
});

describe('browser test server', () => {
  test('refuses to reset a database whose name does not end with _e2e', () => {
    const result = spawnSync(process.execPath, ['scripts/e2e-server.mjs'], {
      cwd: BACKEND,
      encoding: 'utf8',
      env: { ...process.env, MONGO_URI: databaseUri('employee_management'), PORT: '0' },
      timeout: 30_000,
    });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /Refusing to reset "employee_management"/);
  });
});

describe('database copy (standalone → replica set migration)', () => {
  const SOURCE = 'payguard_wave15_copy_source';
  const TARGET = 'payguard_wave15_copy_target';
  let connection;

  before(async () => {
    connection = await mongoose.createConnection(databaseUri(SOURCE), { serverSelectionTimeoutMS: 5000 }).asPromise();
    await connection.useDb(SOURCE).dropDatabase();
    await connection.useDb(TARGET).dropDatabase();

    const source = connection.useDb(SOURCE).db;
    await source.collection('admins').createIndex({ email: 1 }, { unique: true });
    await source.collection('admins').insertMany([
      { email: 'owner@example.com', role: 'admin', createdAt: new Date('2026-01-01T00:00:00Z') },
      { email: 'approver@example.com', role: 'payroll_approver', createdAt: new Date('2026-01-02T00:00:00Z') },
    ]);
    await source.collection('auditlogs').insertMany([
      { sequenceNumber: 1, previousHash: '0'.repeat(64), hash: 'a'.repeat(64), meta: { nested: { amount: 1234.5 } } },
      { sequenceNumber: 2, previousHash: 'a'.repeat(64), hash: 'b'.repeat(64), meta: { list: [1, 2, 3] } },
    ]);
  });

  after(async () => {
    await connection.useDb(SOURCE).dropDatabase();
    await connection.useDb(TARGET).dropDatabase();
    await connection.close();
  });

  const copy = () => spawnSync(process.execPath, ['scripts/copy-database.mjs', databaseUri(SOURCE), databaseUri(TARGET)], {
    cwd: BACKEND,
    encoding: 'utf8',
    timeout: 60_000,
  });

  test('documents and indexes arrive unchanged; a non-empty target is never written to', async () => {
    const first = copy();
    assert.equal(first.status, 0, first.stdout + first.stderr);

    const source = connection.useDb(SOURCE).db;
    const target = connection.useDb(TARGET).db;
    for (const name of ['admins', 'auditlogs']) {
      const [from, to] = await Promise.all([
        source.collection(name).find().sort({ _id: 1 }).toArray(),
        target.collection(name).find().sort({ _id: 1 }).toArray(),
      ]);
      assert.deepEqual(to, from, `${name} documents differ`);
    }
    const emailIndex = (await target.collection('admins').indexes()).find((index) => index.name === 'email_1');
    assert.equal(emailIndex?.unique, true);

    const second = copy();
    assert.equal(second.status, 1);
    assert.match(second.stderr, /already has 2 collection\(s\)/);
    assert.equal(await target.collection('admins').countDocuments(), 2);
  });
});
