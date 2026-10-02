import employmentService from '../services/employmentService.js';
import statutoryProfileService from '../services/statutoryProfileService.js';
import bankAccountService from '../services/bankAccountService.js';
import employeeDocumentService from '../services/employeeDocumentService.js';
import payrollReadinessService from '../services/payrollReadinessService.js';
import { actorFromRequest, companyIdFromRequest } from '../utils/tenant.js';

/**
 * Employee 360 — employment history, statutory profile, bank accounts,
 * documents and payroll readiness. Business rules live in the services.
 */

const context = (req) => [req.params.employeeId, companyIdFromRequest(req)];

// Decrypted values: never cached anywhere, including intermediaries.
const noStore = (res) => res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });

export const getEmployment = async (req, res) => {
  const data = await employmentService.getHistory(...context(req));
  return res.status(200).json({ success: true, data });
};

export const recordEmploymentChange = async (req, res) => {
  const data = await employmentService.recordChange(...context(req), req.body, actorFromRequest(req));
  return res.status(201).json({ success: true, message: 'Employment change recorded.', data });
};

export const getStatutoryProfile = async (req, res) => {
  const profile = await statutoryProfileService.getProfile(...context(req));
  return res.status(200).json({ success: true, data: { profile } });
};

export const updateStatutoryProfile = async (req, res) => {
  const profile = await statutoryProfileService.updateProfile(...context(req), req.body, actorFromRequest(req));
  return res.status(201).json({ success: true, message: 'Statutory profile updated.', data: { profile } });
};

export const revealStatutoryField = async (req, res) => {
  const data = await statutoryProfileService.reveal(...context(req), req.body.field, req.body.reason, actorFromRequest(req));
  noStore(res);
  return res.status(200).json({ success: true, data });
};

export const getBankAccounts = async (req, res) => {
  const data = await bankAccountService.list(...context(req));
  return res.status(200).json({ success: true, data });
};

export const addBankAccount = async (req, res) => {
  const data = await bankAccountService.addAccount(...context(req), req.body, actorFromRequest(req));
  return res.status(201).json({ success: true, message: 'Salary bank account recorded.', data });
};

export const revealBankAccountNumber = async (req, res) => {
  const data = await bankAccountService.reveal(...context(req), req.params.accountId, req.body.reason, actorFromRequest(req));
  noStore(res);
  return res.status(200).json({ success: true, data });
};

export const getDocuments = async (req, res) => {
  const data = await employeeDocumentService.list(...context(req));
  return res.status(200).json({ success: true, data });
};

export const submitDocument = async (req, res) => {
  const data = await employeeDocumentService.submit(...context(req), req.body, actorFromRequest(req));
  return res.status(201).json({ success: true, message: 'Document recorded.', data });
};

export const decideDocument = async (req, res) => {
  const data = await employeeDocumentService.decide(...context(req), req.params.documentId, req.body, actorFromRequest(req));
  return res.status(200).json({ success: true, message: `Document ${data.document.status.toLowerCase()}.`, data });
};

export const getEmployeeReadiness = async (req, res) => {
  const data = await payrollReadinessService.forEmployee(...context(req), req.query);
  return res.status(200).json({ success: true, data });
};

export const getCompanyReadiness = async (req, res) => {
  const data = await payrollReadinessService.evaluate(companyIdFromRequest(req), req.query);
  return res.status(200).json({ success: true, data });
};
