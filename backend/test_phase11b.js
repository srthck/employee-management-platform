import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');

test('salary API exposes versioned read and revision routes', () => {
  const routes = read('./src/routes/salaryRoutes.js');
  assert.match(routes, /getCurrentSalary/);
  assert.match(routes, /getSalaryHistory/);
  assert.match(routes, /createSalaryRevision/);
  assert.match(routes, /requirePermission\(PERMISSIONS\.SALARY_REVISE\)/);
});

test('generic employee updates reject salary and protected fields', () => {
  const validator = read('./src/validators/employeeValidator.js');
  const controller = read('./src/controllers/employeeController.js');
  assert.match(validator, /Salary changes must use the salary version endpoint/);
  assert.match(controller, /employeeCode.*isDeleted.*deletedAt.*deletedBy.*createdBy.*salary/);
});

test('compliance and audit APIs are read-only', () => {
  const compliance = read('./src/routes/complianceRuleRoutes.js');
  const audit = read('./src/routes/auditRoutes.js');
  assert.match(compliance, /router\.get/);
  assert.doesNotMatch(compliance, /router\.(post|put|patch|delete)/);
  assert.match(audit, /listAuditLogs/);
  assert.match(audit, /getEntityAuditHistory/);
  assert.match(audit, /verifyAuditChain/);
  assert.match(audit, /router\.get\('\/verify'/);
  assert.doesNotMatch(audit, /router\.(post|put|patch|delete)/);
});

test('audit service contains deterministic SHA-256 chain verification', () => {
  const service = read('./src/services/auditService.js');
  assert.match(service, /createHash\('sha256'\)/);
  assert.match(service, /GENESIS_HASH/);
  assert.match(service, /sequenceNumber/);
  assert.match(service, /previousHash/);
  assert.match(service, /verifyAuditChain/);
});

test('authentication uses cookie flags and does not return token fields', () => {
  const controller = read('./src/controllers/authController.js');
  const middleware = read('./src/middleware/authMiddleware.js');
  assert.match(controller, /HttpOnly/);
  assert.match(controller, /SameSite=/);
  assert.match(controller, /setAuthCookie/);
  assert.match(controller, /clearAuthCookie/);
  assert.match(middleware, /config\.authCookieName/);
  assert.doesNotMatch(controller, /data:\s*\{[\s\S]{0,120}token,/);
});

test('frontend does not persist authentication tokens', () => {
  const client = fs.readFileSync(new URL('../frontend/src/services/axiosInstance.js', import.meta.url), 'utf8');
  const context = fs.readFileSync(new URL('../frontend/src/contexts/AuthContext.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(client, /localStorage|sessionStorage|Authorization/);
  assert.doesNotMatch(context, /localStorage|sessionStorage|setAuthToken/);
});
