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
 * Employee 360 through the real UI:
 *   - HR records statutory identifiers, a bank account, an employment change
 *     and a document; values are shown masked and never appear in the page
 *   - readiness moves from "Needs attention" to "Ready for payroll"
 *   - a payroll administrator reveals PAN only with a reason; the reveal is audited
 *   - an auditor sees masked values and no actions
 *   - the document is verified by someone other than the person who recorded it
 */

const PAN = 'ABCDE1234F';
const ACCOUNT_NUMBER = '123456789012';

const section = (page, id) => page.locator(`section[aria-labelledby="${id}"]`);

test('Employee 360: masked identity data, audited reveal, readiness and segregated verification', async ({ browser }) => {
  const { context: ownerContext, api: owner } = await createWorkspace(browser);
  const hrEmail = await addTeamMember(owner, 'Hema Manager', 'manager');
  const payrollEmail = await addTeamMember(owner, 'Pavan Preparer', 'payroll_admin');
  const auditorEmail = await addTeamMember(owner, 'Arti Auditor', 'auditor');
  const employeeId = await addEmployeeWithSalary(owner, 'Neha', 'Joshi', 4000);

  // ── HR manager records the employee's data ────────────────────────────────
  const hrContext = await signedInContext(browser, hrEmail);
  const hr = await hrContext.newPage();
  const hrFailures = watchForFailures(hr);
  await hr.goto(`/employees/${employeeId}`);
  await expect(hr.getByRole('heading', { name: 'Neha Joshi' })).toBeVisible();

  const readiness = section(hr, 'readiness-title');
  await expect(readiness.getByText('Needs attention')).toBeVisible();
  await expect(readiness.getByText(/PAN is not recorded/)).toBeVisible();
  await expect(readiness.getByText(/No salary bank account/)).toBeVisible();

  const statutory = section(hr, 'statutory-title');
  await statutory.getByRole('button', { name: 'Update identifiers' }).click();
  const statutoryDialog = hr.getByRole('dialog', { name: 'Update statutory identifiers' });
  await statutoryDialog.getByLabel('PAN', { exact: true }).fill('abcde1234f');
  await statutoryDialog.getByLabel('UAN', { exact: true }).fill('100200300400');
  await statutoryDialog.getByLabel('ESIC insurance number').fill('3100123456');
  await statutoryDialog.getByRole('button', { name: 'Save identifiers' }).click();
  await expect(statutory.getByText('••••••234F')).toBeVisible();
  await expect(statutory.getByRole('button', { name: /^Reveal/ })).toHaveCount(0);

  const bank = section(hr, 'bank-title');
  await bank.getByRole('button', { name: 'Add bank account' }).click();
  const bankDialog = hr.getByRole('dialog', { name: 'Salary bank account' });
  await bankDialog.getByLabel('Account holder name').fill('Neha Joshi');
  await bankDialog.getByLabel('IFSC').fill('HDFC0001234');
  await bankDialog.getByLabel('Account number', { exact: true }).fill(ACCOUNT_NUMBER);
  await bankDialog.getByLabel('Confirm account number').fill(ACCOUNT_NUMBER);
  await bankDialog.getByRole('button', { name: 'Save bank account' }).click();
  await expect(bank.getByText('••••••••9012')).toBeVisible();

  const employment = section(hr, 'employment-title');
  await employment.getByRole('button', { name: 'Record change' }).click();
  const changeDialog = hr.getByRole('dialog', { name: 'Record employment change' });
  // A select's accessible name includes its selected option ("Change Promotion").
  await changeDialog.getByRole('combobox', { name: /^Change/ }).selectOption('PROMOTION');
  await changeDialog.getByLabel('New designation').fill('Senior Engineer');
  await changeDialog.getByLabel(/^Reason/).fill('Promoted in the annual review');
  await changeDialog.getByRole('button', { name: 'Record change' }).click();
  const timeline = employment.getByRole('table', { name: 'Employment timeline' });
  await expect(timeline.getByText('Promotion', { exact: true })).toBeVisible();
  await expect(timeline.getByText('Joining', { exact: true })).toBeVisible();
  await expect(hr.getByText(/Senior Engineer · Engineering/)).toBeVisible();

  const documents = section(hr, 'documents-title');
  await documents.getByRole('button', { name: 'Record document' }).click();
  const documentDialog = hr.getByRole('dialog', { name: 'Record document' });
  await documentDialog.getByLabel('Title').fill('PAN card copy');
  await documentDialog.getByRole('button', { name: 'Record document' }).click();
  await expect(documents.getByText('Another person verifies')).toBeVisible();

  await expect(readiness.getByText('Ready for payroll')).toBeVisible();
  const hrPage = await hr.content();
  expect(hrPage).not.toContain(PAN);
  expect(hrPage).not.toContain(ACCOUNT_NUMBER);

  await hr.goto('/employees');
  await expect(hr.getByRole('row').filter({ hasText: 'Neha Joshi' }).getByText('Ready for payroll')).toBeVisible();
  await expect(hr.getByLabel('Payroll readiness summary')).toContainText('1 ready');

  // ── Payroll administrator reveals PAN with a reason ───────────────────────
  const payrollContext = await signedInContext(browser, payrollEmail);
  const payroll = await payrollContext.newPage();
  const payrollFailures = watchForFailures(payroll);
  await payroll.goto(`/employees/${employeeId}`);
  const payrollStatutory = section(payroll, 'statutory-title');
  await expect(payrollStatutory.getByText('••••••234F')).toBeVisible();
  expect(await payroll.content()).not.toContain(PAN);
  await expect(section(payroll, 'bank-title').getByRole('button', { name: /bank account/ })).toHaveCount(0);

  await payrollStatutory.getByRole('button', { name: 'Reveal PAN' }).click();
  const reveal = payroll.getByRole('dialog', { name: 'Reveal PAN' });
  const revealButton = reveal.getByRole('button', { name: 'Reveal value' });
  await expect(revealButton).toBeDisabled();
  await reveal.getByLabel('Reason').fill('Form 24Q correction for Q2');
  await expect(revealButton).toBeEnabled();
  await revealButton.click();
  await expect(reveal.getByTestId('revealed-value')).toHaveText(PAN);
  await reveal.getByRole('button', { name: 'Hide' }).click();
  await expect(payroll.getByTestId('revealed-value')).toHaveCount(0);
  expect(await payroll.content()).not.toContain(PAN);

  const audit = await owner.get('/audit/logs?action=SENSITIVE_FIELD_REVEALED');
  const auditJson = JSON.stringify(audit);
  expect(auditJson).toContain('statutory.pan');
  expect(auditJson).toContain('Form 24Q correction for Q2');
  expect(auditJson).not.toContain(PAN);

  // ── Auditor: masked values, no actions ────────────────────────────────────
  const auditorContext = await signedInContext(browser, auditorEmail);
  const auditor = await auditorContext.newPage();
  const auditorFailures = watchForFailures(auditor);
  await auditor.goto(`/employees/${employeeId}`);
  await expect(section(auditor, 'statutory-title').getByText('••••••234F')).toBeVisible();
  await expect(section(auditor, 'bank-title').getByText('••••••••9012')).toBeVisible();
  await expect(
    auditor.getByRole('button', { name: /Reveal|Update identifiers|bank account|Record change|Record document|Change salary|Verify/ })
  ).toHaveCount(0);
  const auditorPage = await auditor.content();
  expect(auditorPage).not.toContain(PAN);
  expect(auditorPage).not.toContain(ACCOUNT_NUMBER);

  // ── The owner verifies the document HR recorded ───────────────────────────
  const ownerPage = await ownerContext.newPage();
  const ownerFailures = watchForFailures(ownerPage);
  await ownerPage.goto(`/employees/${employeeId}`);
  const ownerDocuments = section(ownerPage, 'documents-title');
  await ownerDocuments.getByRole('button', { name: 'Verify' }).click();
  await expect(ownerDocuments.getByText('Verified', { exact: true })).toBeVisible();
  const documentsApi = await apiClient(ownerContext.request).get(`/employees/${employeeId}/documents`);
  expect(documentsApi.data.documents[0].decision.byEmail).not.toBe(hrEmail);

  expect([...hrFailures, ...payrollFailures, ...auditorFailures, ...ownerFailures]).toEqual([]);
  await Promise.all([ownerContext.close(), hrContext.close(), payrollContext.close(), auditorContext.close()]);
});
