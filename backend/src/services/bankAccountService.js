import mongoose from 'mongoose';
import EmployeeBankAccount from '../models/EmployeeBankAccount.js';
import auditService from './auditService.js';
import { runInTransaction } from '../utils/transaction.js';
import { encryptField, blindIndex } from '../utils/fieldEncryption.js';
import { validateIdentifier, lastFour, maskedFromLastFour } from '../utils/indianIdentifiers.js';
import { BANK_ACCOUNT_TYPES } from '../utils/workforce.js';
import {
  httpError,
  startOfUtcDay,
  dateOnly,
  isValidDate,
  loadCompanyEmployee,
  requireRevealReason,
  decryptSensitive,
} from './employeeScope.js';

/**
 * bankAccountService — versioned salary bank accounts.
 *
 * The account number is encrypted, masked in every read API and revealed
 * only through an audited reveal. A company-scoped blind index flags one
 * account used by several employees without decrypting anything.
 *
 * Who may change a bank account (employee.bank.write) is deliberately a
 * different duty from preparing or approving payroll.
 */

const contextFor = (companyId, employeeId) => `${companyId}:${employeeId}:bank.accountNumber`;
const accountScope = (companyId) => `company:${companyId}:bank.accountNumber`;

export const maskedBankView = (account) => ({
  id: String(account._id),
  version: account.version,
  isCurrent: account.isCurrent,
  effectiveFrom: account.effectiveFrom,
  supersededAt: account.supersededAt,
  accountHolderName: account.accountHolderName,
  bankName: account.bankName,
  ifsc: account.ifsc,
  accountType: account.accountType,
  accountNumberMasked: maskedFromLastFour(account.accountNumber?.last4, 12),
  reason: account.reason,
  recordedByEmail: account.recordedByEmail,
  recordedAt: account.createdAt,
});

const sharedWithCount = (companyId, index, employeeId, session = null) => {
  const query = EmployeeBankAccount.countDocuments({
    companyId,
    accountNumberBlindIndex: index,
    isCurrent: true,
    employeeId: { $ne: employeeId },
  });
  if (session) query.session(session);
  return query;
};

const bankAccountService = {
  async list(employeeId, companyId) {
    const employee = await loadCompanyEmployee(employeeId, companyId, { lean: true });
    const accounts = await EmployeeBankAccount.find({ employeeId: employee._id }).sort({ version: -1 }).lean();
    const current = accounts.find((account) => account.isCurrent) || null;
    const sharedWithOtherEmployees = current
      ? await sharedWithCount(companyId, current.accountNumberBlindIndex, employee._id)
      : 0;
    return {
      current: current ? { ...maskedBankView(current), sharedWithOtherEmployees } : null,
      history: accounts.map(maskedBankView),
    };
  },

  async addAccount(employeeId, companyId, payload, actor) {
    const errors = [];
    const accountNumber = validateIdentifier('bankAccountNumber', payload.accountNumber);
    if (!accountNumber.valid) errors.push({ field: 'accountNumber', message: accountNumber.message });
    const ifsc = validateIdentifier('ifsc', payload.ifsc);
    if (!ifsc.valid) errors.push({ field: 'ifsc', message: ifsc.message });

    const holder = typeof payload.accountHolderName === 'string' ? payload.accountHolderName.trim() : '';
    if (holder.length < 2 || holder.length > 100) errors.push({ field: 'accountHolderName', message: 'Account holder name must be 2 to 100 characters.' });
    const bankName = typeof payload.bankName === 'string' && payload.bankName.trim() ? payload.bankName.trim() : null;
    if (bankName && bankName.length > 100) errors.push({ field: 'bankName', message: 'Bank name cannot exceed 100 characters.' });
    const accountType = payload.accountType ?? 'SAVINGS';
    if (!BANK_ACCOUNT_TYPES.includes(accountType)) errors.push({ field: 'accountType', message: `Account type must be one of: ${BANK_ACCOUNT_TYPES.join(', ')}.` });
    if (payload.effectiveFrom !== undefined && !isValidDate(payload.effectiveFrom)) errors.push({ field: 'effectiveFrom', message: 'effectiveFrom must be a valid date.' });
    if (errors.length > 0) throw httpError(422, 'VALIDATION_FAILED', 'Validation failed', { errors });

    const effectiveFrom = startOfUtcDay(payload.effectiveFrom ?? new Date());
    const reason = typeof payload.reason === 'string' && payload.reason.trim() ? payload.reason.trim().slice(0, 300) : null;
    const index = blindIndex(accountNumber.normalized, { scope: accountScope(companyId) });

    const { account, sharedWithOtherEmployees } = await runInTransaction(async (session) => {
      const employee = await loadCompanyEmployee(employeeId, companyId, { session });
      const current = await EmployeeBankAccount.findOne({ employeeId: employee._id, isCurrent: true }).session(session);

      if (current && current.accountNumberBlindIndex === index && current.ifsc === ifsc.normalized) {
        throw httpError(422, 'NO_CHANGE', 'This is already the current salary account.');
      }
      if (current && effectiveFrom < current.effectiveFrom) {
        throw httpError(409, 'EFFECTIVE_DATE_BEFORE_CURRENT', `The new account must take effect on or after ${dateOnly(current.effectiveFrom)}.`);
      }

      if (current) {
        current.isCurrent = false;
        current.supersededAt = new Date();
        await current.save({ session });
      }

      const [created] = await EmployeeBankAccount.create([{
        employeeId: employee._id,
        companyId,
        version: (current?.version ?? 0) + 1,
        effectiveFrom,
        accountHolderName: holder,
        bankName,
        ifsc: ifsc.normalized,
        accountType,
        accountNumber: {
          ciphertext: encryptField(accountNumber.normalized, { context: contextFor(companyId, employee._id) }),
          last4: lastFour(accountNumber.normalized),
        },
        accountNumberBlindIndex: index,
        reason,
        recordedBy: actor.id,
        recordedByEmail: actor.email || null,
      }], { session });

      const shared = await sharedWithCount(companyId, index, employee._id, session);

      await auditService.log({
        action: 'BANK_ACCOUNT_CHANGED',
        actorId: actor.id,
        actorEmail: actor.email,
        actorRole: actor.role,
        entityType: 'EMPLOYEE',
        entityId: employee._id,
        companyId,
        meta: {
          version: created.version,
          previousVersion: current?.version ?? null,
          effectiveFrom: dateOnly(effectiveFrom),
          accountType,
          bankName,
          sharedWithOtherEmployees: shared,
          reason,
        },
      }, session);

      return { account: created, sharedWithOtherEmployees: shared };
    }, { label: 'bank.change' });

    const warnings = sharedWithOtherEmployees > 0
      ? [{
        code: 'BANK_ACCOUNT_SHARED',
        message: `This account is also the current salary account of ${sharedWithOtherEmployees} other employee(s). Confirm it before paying.`,
      }]
      : [];

    return { account: { ...maskedBankView(account.toObject()), sharedWithOtherEmployees }, warnings };
  },

  async reveal(employeeId, companyId, accountId, reason, actor) {
    const trimmedReason = requireRevealReason(reason);
    const employee = await loadCompanyEmployee(employeeId, companyId, { lean: true });
    if (!mongoose.isValidObjectId(accountId)) throw httpError(400, 'BAD_REQUEST', 'Invalid bank account ID.');
    const account = await EmployeeBankAccount.findOne({ _id: accountId, employeeId: employee._id, companyId }).lean();
    if (!account) throw httpError(404, 'NOT_FOUND', 'Bank account not found.');

    const value = await decryptSensitive(account.accountNumber.ciphertext, {
      context: contextFor(companyId, employee._id),
      actor,
      companyId,
      employeeId: employee._id,
      field: 'bank.accountNumber',
    });

    await auditService.log({
      action: 'SENSITIVE_FIELD_REVEALED',
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      entityType: 'EMPLOYEE',
      entityId: employee._id,
      companyId,
      meta: { field: 'bank.accountNumber', accountVersion: account.version, reason: trimmedReason },
    });

    return { accountId: String(account._id), value, version: account.version };
  },
};

export default bankAccountService;
