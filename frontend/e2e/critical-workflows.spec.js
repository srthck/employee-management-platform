import { test, expect } from '@playwright/test';
import {
  PASSWORD,
  apiClient,
  uniqueEmail,
  signedInContext,
  createWorkspace,
  addTeamMember,
  addEmployeeWithSalary,
  editCurrentSalaryInDatabase,
  watchForFailures,
} from './helpers.js';

/**
 * Critical PayGuard workflows, driven through the real UI:
 *   1. Owner registration (modern TLD) creates a company workspace
 *   2. Maker-checker payroll close: preparer calculates, approver must record
 *      an override for an unexplained change, the result is locked and audited
 *   3. Permission-based UI: a read-only auditor gets no mutating actions
 */

const nav = (page) => page.getByRole('navigation', { name: 'Primary navigation' });

test('an owner registers with a modern top-level domain and gets a company workspace', async ({ page }) => {
  const failures = watchForFailures(page);
  const email = uniqueEmail('meera', 'payguard.technology');

  await page.goto('/register');
  await page.getByLabel('Full name').fill('Meera Owner');
  await page.getByLabel('Company name (optional)').fill('Meera Payroll Private Limited');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: /Create account/ }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(nav(page).getByRole('link', { name: /Payroll runs/ })).toBeVisible();

  const company = await apiClient(page.request).get('/company');
  expect(company.data.company.name).toBe('Meera Payroll Private Limited');
  expect(company.data.company.settings.approvalMode).toBe('single');

  await page.goto('/settings');
  await expect(page.getByText('Add a team member')).toBeVisible();
  expect(failures).toEqual([]);
});

test('maker-checker: the preparer cannot finalize; the approver must record an override for an unexplained change', async ({ browser }) => {
  // ── Setup through the API: team, employees, a finalized February ─────────
  const { context: ownerContext, api: owner } = await createWorkspace(browser);
  const preparerEmail = await addTeamMember(owner, 'Priya Preparer', 'payroll_admin');
  const approverEmail = await addTeamMember(owner, 'Arjun Approver', 'payroll_approver');
  await addEmployeeWithSalary(owner, 'Asha', 'Verma', 4000);
  const ravi = await addEmployeeWithSalary(owner, 'Ravi', 'Kumar', 4001);

  const feb = (await owner.post('/payroll-runs', { periodMonth: 2, periodYear: 2026 })).data.run._id;
  await owner.post(`/payroll-runs/${feb}/process`);
  await owner.post(`/payroll-runs/${feb}/finalize`);
  await owner.patch('/company/settings', { settings: { approvalMode: 'maker_checker' } });

  // Out-of-band salary change with no salary revision behind it.
  await editCurrentSalaryInDatabase(ravi, { 'components.specialAllowance': 14001, grossMonthly: 30001 });

  // ── Preparer signs in through the login form, creates and calculates March ─
  const preparerContext = await browser.newContext();
  const preparer = await preparerContext.newPage();
  const preparerFailures = watchForFailures(preparer);

  await preparer.goto('/login');
  await preparer.getByLabel('Email address').fill(preparerEmail);
  await preparer.getByLabel('Password').fill(PASSWORD);
  await preparer.getByRole('button', { name: /Sign in/ }).click();
  await expect(preparer).toHaveURL(/\/dashboard$/);

  await nav(preparer).getByRole('link', { name: /Payroll runs/ }).click();
  await preparer.getByRole('button', { name: 'Create payroll run' }).click();
  const createDialog = preparer.locator('form.dialog');
  await createDialog.getByRole('combobox').selectOption({ label: 'March' });
  await createDialog.getByRole('spinbutton').fill('2026');
  await createDialog.getByRole('button', { name: 'Create payroll run' }).click();
  await expect(preparer).toHaveURL(/\/payroll\/[a-f0-9]{24}$/);
  const runUrl = new URL(preparer.url()).pathname;
  const runId = runUrl.split('/').pop();

  await preparer.getByRole('button', { name: 'Calculate payroll' }).click();
  await expect(preparer.getByText('Payroll calculated.', { exact: false })).toBeVisible({ timeout: 60_000 });
  await expect(preparer.getByText('Calculated and awaiting an approver with finalization permission.')).toBeVisible();
  await expect(preparer.getByRole('button', { name: 'Finalize and lock payslips' })).toHaveCount(0);

  // The API enforces the same rule the UI shows.
  const preparerFinalize = await apiClient(preparerContext.request).post(`/payroll-runs/${runId}/finalize`, {}, { expectStatus: 403 });
  expect(preparerFinalize.code).toBe('FORBIDDEN');

  // ── Approver reviews: unexplained blocks, expected does not ────────────────
  const approverContext = await signedInContext(browser, approverEmail);
  const approver = await approverContext.newPage();
  const approverFailures = watchForFailures(approver);
  await approver.goto(runUrl);

  await expect(approver.getByText('1 unexplained pay change(s) block finalization.', { exact: false })).toBeVisible();
  const raviRow = approver.getByRole('row').filter({ hasText: 'Ravi Kumar' });
  await expect(raviRow.getByText('UNEXPLAINED', { exact: true })).toBeVisible();
  await expect(raviRow.getByText('Blocks finalization')).toBeVisible();
  const ashaRow = approver.getByRole('row').filter({ hasText: 'Asha Verma' });
  await expect(ashaRow.getByText('EXPECTED', { exact: true })).toBeVisible();

  // ── Override requires review confirmation and a real reason ────────────────
  await approver.getByRole('button', { name: 'Finalize and lock payslips' }).click();
  const dialog = approver.getByRole('dialog');
  const confirm = dialog.getByRole('button', { name: 'Override and finalize' });
  await expect(confirm).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('textbox').fill('looks fine');
  await expect(confirm).toBeDisabled();

  const reason = 'Special allowance correction approved by finance, ticket FIN-2231';
  await dialog.getByRole('textbox').fill(reason);
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(approver.getByText('Payroll finalized.', { exact: false })).toBeVisible({ timeout: 60_000 });
  await expect(approver.getByText('Approval record')).toBeVisible();
  await expect(approver.getByText('Maker-checker: calculated and finalized by different people.', { exact: false })).toBeVisible();
  await expect(approver.getByText(reason, { exact: false })).toBeVisible();

  // ── The locked result and the audit chain agree with the UI ────────────────
  const approverApi = apiClient(approverContext.request);
  const run = (await approverApi.get(`/payroll-runs/${runId}`)).data.run;
  expect(run.status).toBe('FINALIZED');
  expect(run.finalizationControls.approvalMode).toBe('maker_checker');
  expect(run.finalizationControls.preparedBy).not.toBe(run.finalizationControls.approvedBy);
  expect(run.finalizationControls.override.reason).toBe(reason);

  const verification = await approverApi.get('/audit/verify');
  expect(JSON.stringify(verification)).toContain('"valid":true');

  expect([...preparerFailures, ...approverFailures]).toEqual([]);
  await Promise.all([ownerContext.close(), preparerContext.close(), approverContext.close()]);
});

test('a read-only auditor sees payroll and people data but no actions that change them', async ({ browser }) => {
  const { context: ownerContext, api: owner } = await createWorkspace(browser);
  const auditorEmail = await addTeamMember(owner, 'Anita Auditor', 'auditor');
  await addEmployeeWithSalary(owner, 'Kiran', 'Rao', 4000);

  const auditorContext = await signedInContext(browser, auditorEmail);
  const page = await auditorContext.newPage();
  const failures = watchForFailures(page);

  await page.goto('/payroll');
  await expect(page.getByRole('heading', { name: 'Payroll Runs' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create payroll run' })).toHaveCount(0);

  await page.goto('/employees');
  await expect(page.getByText('Kiran Rao')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add employee' })).toHaveCount(0);

  await page.goto('/settings');
  await expect(page.getByText('Add a team member')).toHaveCount(0);

  // Self-service pages are for employees; staff are sent to their workspace.
  await page.goto('/my/payslips');
  await expect(page).toHaveURL(/\/dashboard$/);

  const denied = await apiClient(auditorContext.request).post('/payroll-runs', { periodMonth: 1, periodYear: 2026 }, { expectStatus: 403 });
  expect(denied.code).toBe('FORBIDDEN');

  expect(failures).toEqual([]);
  await Promise.all([ownerContext.close(), auditorContext.close()]);
});
