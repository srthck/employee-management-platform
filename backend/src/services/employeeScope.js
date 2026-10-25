import mongoose from 'mongoose';
import Employee from '../models/Employee.js';
import auditService from './auditService.js';
import { decryptField } from '../utils/fieldEncryption.js';

/**
 * Helpers shared by the Employee 360 services (employment, statutory, bank,
 * documents, readiness).
 */

export const httpError = (statusCode, code, message, extra = {}) =>
  Object.assign(new Error(message), { statusCode, code, ...extra });

export const startOfUtcDay = (value) => {
  const date = new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
};

export const dateOnly = (value) => (value ? new Date(value).toISOString().slice(0, 10) : null);

export const isValidDate = (value) => value !== null && value !== undefined && value !== '' && !Number.isNaN(new Date(value).getTime());

/**
 * The employee, if it belongs to the company. Another company's employee is
 * indistinguishable from a missing one (404). Archived employees are excluded
 * by the Employee model.
 */
export async function loadCompanyEmployee(employeeId, companyId, { session = null, lean = false } = {}) {
  if (!mongoose.isValidObjectId(employeeId)) throw httpError(400, 'BAD_REQUEST', 'Invalid employee ID.');
  const query = Employee.findOne({ _id: employeeId, createdBy: companyId });
  if (session) query.session(session);
  if (lean) query.lean();
  const employee = await query;
  if (!employee) throw httpError(404, 'NOT_FOUND', 'Employee not found.');
  return employee;
}

/** A reveal must say why; the reason is kept in the audit trail. */
export function requireRevealReason(reason) {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (trimmed.length < 10 || trimmed.length > 300) {
    throw httpError(422, 'REVEAL_REASON_REQUIRED', 'A reason of 10 to 300 characters is required to reveal sensitive data.');
  }
  return trimmed;
}

/**
 * Decrypt a stored value. An integrity failure (tampered ciphertext, value
 * moved to another record, unknown key) is audited and never returns data.
 */
export async function decryptSensitive(ciphertext, { context, actor, companyId, employeeId, field }) {
  try {
    return decryptField(ciphertext, { context });
  } catch (err) {
    await auditService.logStandalone({
      action: 'SENSITIVE_FIELD_INTEGRITY_FAILED',
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      entityType: 'EMPLOYEE',
      entityId: employeeId,
      companyId,
      meta: { field, errorCode: err.code || 'DECRYPTION_FAILED' },
    }).catch(() => {});
    throw httpError(500, err.code || 'DECRYPTION_FAILED', 'The stored value failed integrity verification and was not revealed.');
  }
}
