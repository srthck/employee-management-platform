import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { expect } from '@playwright/test';
import { API, E2E_MONGO_URI } from './env.js';

export const PASSWORD = 'E2ePass1234';

let counter = 0;
export const uniqueEmail = (prefix, domain = 'example.com') =>
  `${prefix}.${Date.now()}${(counter += 1)}@${domain}`;

/** JSON API client bound to a browser context's cookie jar. */
export function apiClient(request) {
  const call = async (method, path, data, { expectStatus } = {}) => {
    const response = await request.fetch(API + path, {
      method,
      data,
      timeout: 120_000,
      headers: {
        'content-type': 'application/json',
        ...(method === 'POST' && { 'Idempotency-Key': randomUUID() }),
      },
    });
    const body = await response.json().catch(() => null);
    if (expectStatus !== undefined) {
      expect(response.status(), `${method} ${path}: ${JSON.stringify(body)}`).toBe(expectStatus);
    } else if (!response.ok()) {
      throw new Error(`${method} ${path} → ${response.status()} ${JSON.stringify(body)}`);
    }
    return body;
  };
  return {
    get: (path, options) => call('GET', path, undefined, options),
    post: (path, data = {}, options) => call('POST', path, data, options),
    patch: (path, data = {}, options) => call('PATCH', path, data, options),
  };
}

/** A new browser context already signed in as `email` (cookie set via the API). */
export async function signedInContext(browser, email, password = PASSWORD) {
  const context = await browser.newContext();
  await apiClient(context.request).post('/auth/login', { email, password });
  return context;
}

/** Register an owner workspace through the API; returns its context and client. */
export async function createWorkspace(browser, { companyName = 'E2E Payroll Private Limited' } = {}) {
  const context = await browser.newContext();
  const api = apiClient(context.request);
  const email = uniqueEmail('owner');
  await api.post('/auth/register', {
    name: 'Owner Person', email, password: PASSWORD, confirmPassword: PASSWORD, companyName,
  });
  return { context, api, email };
}

export async function addTeamMember(ownerApi, name, role) {
  const email = uniqueEmail(role.replace('_', '-'));
  await ownerApi.post('/company/users', { name, email, role, password: PASSWORD });
  return email;
}

export async function addEmployeeWithSalary(ownerApi, firstName, lastName, specialAllowance) {
  const created = await ownerApi.post('/employees', {
    firstName, lastName, department: 'Engineering', position: 'Engineer',
    email: uniqueEmail(firstName.toLowerCase()), salary: 20000, hireDate: '2024-01-15', status: 'active',
  });
  const id = created.data.employee._id;
  await ownerApi.post(`/employees/${id}/salary`, {
    effectiveFrom: '2026-01-01',
    components: { basic: 12000, hra: 4000, specialAllowance },
    workState: 'MH', pfEnrolled: true, esiEnrolled: true, ptEnrolled: true,
  });
  return id;
}

/**
 * Edit an employee's current salary directly in the database, bypassing the
 * API (no new salary version). Simulates an out-of-band change that payroll
 * variance must report as UNEXPLAINED.
 */
export async function editCurrentSalaryInDatabase(employeeId, changes) {
  const require = createRequire(import.meta.url);
  const { MongoClient, ObjectId } = require('../../backend/node_modules/mongoose').mongo;
  const client = await MongoClient.connect(E2E_MONGO_URI);
  try {
    const result = await client.db().collection('salarystructures').updateOne(
      { employeeId: new ObjectId(employeeId), effectiveTo: null },
      { $set: changes }
    );
    expect(result.modifiedCount).toBe(1);
  } finally {
    await client.close();
  }
}

/** Collects uncaught page errors and server errors (5xx) for a page. */
export function watchForFailures(page) {
  const failures = [];
  page.on('pageerror', (error) => failures.push(`page error: ${error.message}`));
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 500) {
      failures.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  return failures;
}
