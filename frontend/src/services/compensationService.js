import axiosInstance from './axiosInstance';
import { postIdempotent } from './idempotency';

/**
 * Compensation control plane: the component catalogue, an employee's
 * effective-dated compensation, impact previews and the change workflow.
 *
 * Proposing and approving move money, so they carry an Idempotency-Key: a
 * retried approval replays the first result instead of applying a second
 * pay change.
 */

const data = (response) => response.data;

// ─── Component catalogue ─────────────────────────────────────────────────────
export const getComponents = (params = {}) =>
  axiosInstance.get('/compensation/components', { params }).then(data);

export const createComponent = (payload) => postIdempotent('/compensation/components', payload);

export const updateComponent = (code, payload) =>
  axiosInstance.patch(`/compensation/components/${code}`, payload).then(data);

export const archiveComponent = (code) =>
  axiosInstance.delete(`/compensation/components/${code}`).then(data);

// ─── Employee compensation ───────────────────────────────────────────────────
export const getCompensation = (employeeId) =>
  axiosInstance.get(`/employees/${employeeId}/compensation`).then(data);

export const previewImpact = (employeeId, payload) =>
  axiosInstance.post(`/employees/${employeeId}/compensation/impact-preview`, payload).then(data);

export const getEmployeeChanges = (employeeId) =>
  axiosInstance.get(`/employees/${employeeId}/compensation/changes`).then(data);

export const proposeChange = (employeeId, payload) =>
  postIdempotent(`/employees/${employeeId}/compensation/changes`, payload);

// ─── Change workflow ─────────────────────────────────────────────────────────
export const getChanges = (params = {}) =>
  axiosInstance.get('/compensation/changes', { params }).then(data);

export const getChange = (changeId) =>
  axiosInstance.get(`/compensation/changes/${changeId}`).then(data);

export const submitChange = (changeId) =>
  axiosInstance.post(`/compensation/changes/${changeId}/submit`).then(data);

export const approveChange = (changeId, note) =>
  postIdempotent(`/compensation/changes/${changeId}/approve`, note ? { note } : {});

export const rejectChange = (changeId, note) =>
  axiosInstance.post(`/compensation/changes/${changeId}/reject`, { note }).then(data);

export const cancelChange = (changeId) =>
  axiosInstance.post(`/compensation/changes/${changeId}/cancel`).then(data);
