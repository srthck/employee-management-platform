/**
 * test_idempotency_policy.js — which routes REQUIRE an Idempotency-Key (finding F-H02). No database.
 *
 * Policy: an operation that is financially material and irreversible, where a repeat would apply money or a payroll state
 * change twice, requires a key; the server answers 428 IDEMPOTENCY_KEY_REQUIRED without one. Every such route already has a
 * first-party caller that sends a key (frontend/src/services, postIdempotent), except finalize-run, which has no caller.
 * Operations whose repetition changes nothing more (preflight, recover, materialize) or that are not money-moving keep an
 * optional key. This file pins the inventory: changing it is a deliberate policy decision, so this test changes with it.
 * The behaviour of a required key is tested in test_atomicity.js; that a business-level guard backs each route is recorded
 * in docs/integrity/IDEMPOTENCY.md.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROUTES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src', 'routes');

/** Every state-changing route as [file, method, path, 'required' | 'optional' | 'none']. */
function inventory() {
  const out = [];
  for (const file of fs.readdirSync(ROUTES).filter((name) => name.endsWith('.js')).sort()) {
    const source = fs.readFileSync(path.join(ROUTES, file), 'utf8');
    const re = /\.(post|put|patch|delete)\(\s*'([^']+)'([\s\S]*?)\n?\);/g;
    for (let m = re.exec(source); m; m = re.exec(source)) {
      const body = m[3];
      const mode = /idempotent\(\{\s*required:\s*true\s*\}\)/.test(body) ? 'required' : /idempotent\(\)/.test(body) ? 'optional' : 'none';
      out.push([file, m[1].toUpperCase(), m[2], mode]);
    }
  }
  return out;
}

const REQUIRED = [
  ['compensationRoutes.js', 'POST', '/:employeeId/compensation/changes'],
  ['compensationRoutes.js', 'POST', '/changes/:changeId/approve'],
  ['employeeProfileRoutes.js', 'POST', '/:employeeId/bank-accounts'],
  ['payrollRunRoutes.js', 'POST', '/'],
  ['payrollRunRoutes.js', 'POST', '/:id/cancel'],
  ['payrollRunRoutes.js', 'POST', '/:id/finalize'],
  ['payrollRunRoutes.js', 'POST', '/:id/process'],
  ['payrollSnapshotRoutes.js', 'POST', '/finalize-run'],
  ['salaryRoutes.js', 'POST', '/:employeeId/salary'],
];

test('exactly the financially material, irreversible routes require an Idempotency-Key', () => {
  const required = inventory().filter((row) => row[3] === 'required').map((row) => row.slice(0, 3));
  assert.deepEqual(required.map((r) => r.join(' ')).sort(), REQUIRED.map((r) => r.join(' ')).sort());
});

test('the inventory is complete: every state-changing route is seen, and none of the required ones is missing from it', () => {
  const rows = inventory();
  assert.ok(rows.length >= 37, `found only ${rows.length} state-changing routes`);
  for (const [file, method, route] of REQUIRED) assert.ok(rows.some((r) => r[0] === file && r[1] === method && r[2] === route), `${file} ${method} ${route}`);
  for (const [file, , route, mode] of rows.filter((r) => ['/:id/recover', '/:id/preflight', '/materialize'].includes(r[2]))) {
    assert.equal(mode, 'none', `${file} ${route}: repeating it changes nothing more, so it takes no key`);
  }
});
