import axiosInstance from './axiosInstance';
import { postIdempotent } from './idempotency';

/**
 * Employee 360: employment history, statutory identifiers, bank accounts,
 * documents and payroll readiness.
 *
 * Reveal calls are plain POSTs on purpose: they are never retried
 * automatically and never sent with an Idempotency-Key, because the server
 * stores idempotent responses and a decrypted value must not be stored.
 */

const data = (response) => response.data;

export const getEmployment = (employeeId) =>
  axiosInstance.get(`/employees/${employeeId}/employment`).then(data);

export const recordEmploymentChange = (employeeId, payload) =>
  postIdempotent(`/employees/${employeeId}/employment`, payload);

export const getStatutoryProfile = (employeeId) =>
  axiosInstance.get(`/employees/${employeeId}/statutory`).then(data);

export const updateStatutoryProfile = (employeeId, payload) =>
  postIdempotent(`/employees/${employeeId}/statutory`, payload);

export const revealStatutoryField = (employeeId, field, reason) =>
  axiosInstance.post(`/employees/${employeeId}/statutory/reveal`, { field, reason }).then(data);

export const getBankAccounts = (employeeId) =>
  axiosInstance.get(`/employees/${employeeId}/bank-accounts`).then(data);

export const addBankAccount = (employeeId, payload) =>
  postIdempotent(`/employees/${employeeId}/bank-accounts`, payload);

export const revealBankAccountNumber = (employeeId, accountId, reason) =>
  axiosInstance.post(`/employees/${employeeId}/bank-accounts/${accountId}/reveal`, { reason }).then(data);

export const getDocuments = (employeeId) =>
  axiosInstance.get(`/employees/${employeeId}/documents`).then(data);

export const submitDocument = (employeeId, payload) =>
  postIdempotent(`/employees/${employeeId}/documents`, payload);

export const decideDocument = (employeeId, documentId, payload) =>
  postIdempotent(`/employees/${employeeId}/documents/${documentId}/decision`, payload);

export const getEmployeeReadiness = (employeeId, params = {}) =>
  axiosInstance.get(`/employees/${employeeId}/payroll-readiness`, { params }).then(data);

export const getCompanyReadiness = (params = {}) =>
  axiosInstance.get('/payroll-readiness', { params }).then(data);
