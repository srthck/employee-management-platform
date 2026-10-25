import EmployeeStatutoryProfile from '../models/EmployeeStatutoryProfile.js';
import auditService from './auditService.js';
import { runInTransaction } from '../utils/transaction.js';
import { encryptField, decryptField, blindIndex } from '../utils/fieldEncryption.js';
import { validateIdentifier, lastFour, maskedFromLastFour } from '../utils/indianIdentifiers.js';
import { httpError, loadCompanyEmployee, requireRevealReason, decryptSensitive } from './employeeScope.js';

/**
 * statutoryProfileService — PAN, UAN, ESIC number and PF member ID.
 *
 * Sensitive-data rules:
 *   - stored only as AES-256-GCM ciphertext bound to company, employee and field
 *   - every read API returns masked values (last four characters)
 *   - plaintext leaves only through reveal(), which needs sensitive.read and a
 *     reason, and is audited BEFORE the value is returned
 *   - audit events and errors carry field names, never values
 *   - PAN is unique among current employees of a company (blind index)
 */

export const STATUTORY_FIELDS = Object.freeze(['pan', 'uan', 'esicNumber', 'pfMemberId']);
const DISPLAY_LENGTH = Object.freeze({ pan: 10, uan: 12, esicNumber: 10, pfMemberId: 22 });

const contextFor = (companyId, employeeId, field) => `${companyId}:${employeeId}:statutory.${field}`;
const panScope = (companyId) => `company:${companyId}:employee.pan`;

const panInUse = () =>
  httpError(409, 'PAN_ALREADY_REGISTERED', 'This PAN is already recorded for another current employee of the company.');

export function maskedStatutoryView(profile) {
  const fields = Object.fromEntries(STATUTORY_FIELDS.map((field) => {
    const value = profile?.[field];
    return [field, { isSet: Boolean(value), masked: value ? maskedFromLastFour(value.last4, DISPLAY_LENGTH[field]) : null }];
  }));
  return {
    version: profile?.version ?? 0,
    updatedAt: profile?.createdAt ?? null,
    updatedByEmail: profile?.recordedByEmail ?? null,
    fields,
  };
}

const copyValue = (value) => (value ? { ciphertext: value.ciphertext, last4: value.last4 } : null);

const statutoryProfileService = {
  async getProfile(employeeId, companyId) {
    const employee = await loadCompanyEmployee(employeeId, companyId, { lean: true });
    const profile = await EmployeeStatutoryProfile.findOne({ employeeId: employee._id, isCurrent: true }).lean();
    return maskedStatutoryView(profile);
  },

  /**
   * Set or clear identifiers. A string sets a value, null clears it, and
   * fields left out are kept. Appends a new version.
   */
  async updateProfile(employeeId, companyId, payload, actor) {
    const provided = STATUTORY_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(payload, field));
    if (provided.length === 0) {
      throw httpError(422, 'NO_CHANGE', 'Provide at least one of: pan, uan, esicNumber, pfMemberId.');
    }

    const normalized = {};
    const errors = [];
    for (const field of provided) {
      const value = payload[field];
      if (value === null || value === '') {
        normalized[field] = null;
        continue;
      }
      const result = validateIdentifier(field, value);
      if (result.valid) normalized[field] = result.normalized;
      else errors.push({ field, message: result.message });
    }
    if (errors.length > 0) throw httpError(422, 'VALIDATION_FAILED', 'Validation failed', { errors });

    const reason = typeof payload.reason === 'string' && payload.reason.trim() ? payload.reason.trim().slice(0, 300) : null;

    try {
      return await runInTransaction(async (session) => {
        const employee = await loadCompanyEmployee(employeeId, companyId, { session });
        const current = await EmployeeStatutoryProfile.findOne({ employeeId: employee._id, isCurrent: true }).session(session);

        const next = {
          pan: copyValue(current?.pan),
          panBlindIndex: current?.panBlindIndex ?? null,
          uan: copyValue(current?.uan),
          esicNumber: copyValue(current?.esicNumber),
          pfMemberId: copyValue(current?.pfMemberId),
        };

        const changedFields = [];
        for (const field of provided) {
          const value = normalized[field];
          const context = contextFor(companyId, employee._id, field);
          const existing = current?.[field] ? decryptField(current[field].ciphertext, { context }) : null;
          if (existing === value) continue;

          changedFields.push(field);
          next[field] = value === null ? null : { ciphertext: encryptField(value, { context }), last4: lastFour(value) };
          if (field === 'pan') next.panBlindIndex = value === null ? null : blindIndex(value, { scope: panScope(companyId) });
        }
        if (changedFields.length === 0) {
          throw httpError(422, 'NO_CHANGE', 'The submitted values match the current statutory profile.');
        }

        if (changedFields.includes('pan') && next.panBlindIndex) {
          const duplicate = await EmployeeStatutoryProfile.exists({
            companyId,
            panBlindIndex: next.panBlindIndex,
            isCurrent: true,
            employeeId: { $ne: employee._id },
          }).session(session);
          if (duplicate) throw panInUse();
        }

        if (current) {
          current.isCurrent = false;
          current.supersededAt = new Date();
          await current.save({ session });
        }

        const [profile] = await EmployeeStatutoryProfile.create([{
          employeeId: employee._id,
          companyId,
          version: (current?.version ?? 0) + 1,
          ...next,
          reason,
          recordedBy: actor.id,
          recordedByEmail: actor.email || null,
        }], { session });

        await auditService.log({
          action: 'STATUTORY_PROFILE_UPDATED',
          actorId: actor.id,
          actorEmail: actor.email,
          actorRole: actor.role,
          entityType: 'EMPLOYEE',
          entityId: employee._id,
          companyId,
          meta: {
            version: profile.version,
            changedFields,
            clearedFields: changedFields.filter((field) => next[field] === null),
            reason,
          },
        }, session);

        return maskedStatutoryView(profile.toObject());
      }, { label: 'statutory.update' });
    } catch (err) {
      if (err.code === 11000 && /unique_current_pan_per_company/.test(err.message || '')) throw panInUse();
      throw err;
    }
  },

  /** Decrypted value of one identifier. Audited before it is returned. */
  async reveal(employeeId, companyId, field, reason, actor) {
    if (!STATUTORY_FIELDS.includes(field)) {
      throw httpError(422, 'VALIDATION_FAILED', `field must be one of: ${STATUTORY_FIELDS.join(', ')}.`);
    }
    const trimmedReason = requireRevealReason(reason);
    const employee = await loadCompanyEmployee(employeeId, companyId, { lean: true });
    const profile = await EmployeeStatutoryProfile.findOne({ employeeId: employee._id, isCurrent: true }).lean();
    if (!profile?.[field]) throw httpError(404, 'FIELD_NOT_SET', 'This identifier is not recorded.');

    const value = await decryptSensitive(profile[field].ciphertext, {
      context: contextFor(companyId, employee._id, field),
      actor,
      companyId,
      employeeId: employee._id,
      field: `statutory.${field}`,
    });

    await auditService.logStandalone({
      action: 'SENSITIVE_FIELD_REVEALED',
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      entityType: 'EMPLOYEE',
      entityId: employee._id,
      companyId,
      meta: { field: `statutory.${field}`, version: profile.version, reason: trimmedReason },
    });

    return { field, value, version: profile.version };
  },
};

export default statutoryProfileService;
