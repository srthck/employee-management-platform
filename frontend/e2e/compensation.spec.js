import { test, expect } from '@playwright/test';
import {
  apiClient,
  signedInContext,
  createWorkspace,
  addTeamMember,
  addEmployeeWithSalary,
  watchForFailures,
} from './helpers.js';

/**
 * Compensation control plane through the real UI:
 *   - the compensation section shows cost to company, components and how each
 *     amount was calculated
 *   - a preparer proposes a change, sees its financial impact, and sends it for
 *     approval; nobody is paid differently yet
 *   - the preparer cannot approve; an approver approves from the compensation
 *     queue and the new pay takes effect
 */

const section = (page, id) => page.locator(`section[aria-labelledby="${id}"]`);

test('a pay change is proposed with its impact, approved by a second person, and then takes effect', async ({ browser }) => {
  const { context: ownerContext, api: owner } = await createWorkspace(browser);
  const preparerEmail = await addTeamMember(owner, 'Pavan Preparer', 'payroll_admin');
  const approverEmail = await addTeamMember(owner, 'Anita Approver', 'payroll_approver');
  const employeeId = await addEmployeeWithSalary(owner, 'Neha', 'Joshi', 4000);

  // Pay changes need a second person in this company.
  await owner.patch('/company/settings', { settings: { compensationApprovalMode: 'maker_checker' } });

  // ── Preparer proposes ─────────────────────────────────────────────────────
  const preparerContext = await signedInContext(browser, preparerEmail);
  const preparer = await preparerContext.newPage();
  const preparerFailures = watchForFailures(preparer);
  await preparer.goto(`/employees/${employeeId}`);

  const compensation = section(preparer, 'compensation-title');
  await expect(compensation.getByText('₹20,000.00').first()).toBeVisible();
  await expect(compensation.getByRole('table', { name: 'Compensation components' }).getByText('Basic', { exact: true })).toBeVisible();

  await compensation.getByRole('button', { name: 'Propose a change' }).click();
  const dialog = preparer.getByRole('dialog', { name: 'Propose a pay change' });
  await dialog.getByLabel('Amount for BASIC').fill('30000');
  await dialog.getByRole('combobox', { name: /^Calculation for HRA/ }).selectOption('PERCENT_OF_BASIC');
  await dialog.getByLabel('Percentage for HRA').fill('40');
  await dialog.getByLabel(/^Reason/).fill('Promotion to senior engineer after the annual review');

  await dialog.getByRole('button', { name: 'Preview impact' }).click();
  await expect(dialog.getByText('New monthly gross ₹46,000.00')).toBeVisible();
  const impact = dialog.getByRole('table', { name: 'Financial impact' });
  await expect(impact.getByRole('row', { name: /Gross pay/ })).toContainText('₹46,000.00');
  // Cost to company before: gross 20,000 + employer PF 1,440 + employer ESI 650.
  await expect(impact.getByRole('row', { name: /Cost to company/ }).first()).toContainText('₹22,090.00');
  await expect(impact.getByRole('row', { name: /Cost to company/ }).first()).toContainText('₹47,800.00');

  await dialog.getByRole('button', { name: 'Send for approval' }).click();
  await expect(compensation.getByText('Compensation change sent for approval.')).toBeVisible();
  await expect(compensation.getByRole('table', { name: 'Compensation changes' }).getByText('Awaiting approval')).toBeVisible();
  await expect(compensation.getByText('₹20,000.00').first()).toBeVisible();

  // The preparer may not approve their own proposal.
  await preparer.goto('/compensation');
  const queue = section(preparer, 'awaiting-title');
  await expect(queue.getByRole('row', { name: /Neha Joshi/ })).toBeVisible();
  await expect(queue.getByRole('button', { name: 'Approve' })).toHaveCount(0);

  // ── Approver decides ──────────────────────────────────────────────────────
  const approverContext = await signedInContext(browser, approverEmail);
  const approver = await approverContext.newPage();
  const approverFailures = watchForFailures(approver);
  await approver.goto('/compensation');

  const approverQueue = section(approver, 'awaiting-title');
  const row = approverQueue.getByRole('row', { name: /Neha Joshi/ });
  await expect(row).toContainText('₹');
  await row.getByRole('button', { name: 'Approve' }).click();
  await expect(approver.getByText('Compensation change approved and applied.')).toBeVisible();
  await expect(section(approver, 'awaiting-title').getByText('Nothing is waiting for a decision.')).toBeVisible();

  // ── The new pay is in effect, with its lineage ────────────────────────────
  await approver.goto(`/employees/${employeeId}`);
  const approverCompensation = section(approver, 'compensation-title');
  await expect(approverCompensation.getByText('₹46,000.00').first()).toBeVisible();
  await expect(approverCompensation.getByText('40% of BASIC ₹30,000.00 = ₹12,000.00')).toBeVisible();
  await expect(approverCompensation.getByRole('table', { name: 'Compensation history' })).toContainText('Approved change');

  const compensationApi = await apiClient(approverContext.request).get(`/employees/${employeeId}/compensation`);
  expect(compensationApi.data.current.version).toBe(2);
  expect(compensationApi.data.current.totals.monthlyGross).toBe(46000);

  const salaryApi = await apiClient(approverContext.request).get(`/employees/${employeeId}/salary/current`);
  expect(salaryApi.data.salary.grossMonthly).toBe(46000);

  expect([...preparerFailures, ...approverFailures]).toEqual([]);
  await Promise.all([ownerContext.close(), preparerContext.close(), approverContext.close()]);
});
