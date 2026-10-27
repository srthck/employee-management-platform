import { useCallback, useEffect, useState } from 'react';
import * as profileService from '../../services/employeeProfileService';
import { can } from '../../utils/permissions';
import RevealDialog from './RevealDialog';
import { Dialog, FieldError, Rows, SectionHeader, apiError, formatDate, todayInput } from './shared';

const ACCOUNT_TYPES = [['SAVINGS', 'Savings'], ['SALARY', 'Salary'], ['CURRENT', 'Current']];
const ACCOUNT_TYPE_LABELS = Object.fromEntries(ACCOUNT_TYPES);

export default function BankSection({ employeeId, user, onChanged }) {
  const canWrite = can(user, 'employee.bank.write');
  const canReveal = can(user, 'sensitive.read');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(false);
  const [revealing, setRevealing] = useState(false);

  const load = useCallback(() => {
    profileService
      .getBankAccounts(employeeId)
      .then((result) => setData(result.data))
      .catch((err) => setError(apiError(err, 'Unable to load bank accounts.').message));
  }, [employeeId]);

  useEffect(load, [load]);

  const current = data?.current;

  return (
    <section className="panel" aria-labelledby="bank-title">
      <SectionHeader
        eyebrow="Salary payment"
        title="Bank account"
        id="bank-title"
        subtitle="Account numbers are encrypted and masked. Every change is kept as a version."
      >
        {canWrite && (
          <button type="button" className="btn" onClick={() => setEditing(true)}>
            {current ? 'Change bank account' : 'Add bank account'}
          </button>
        )}
      </SectionHeader>

      {error && <div className="alert alert-danger mt-5" role="alert">{error}</div>}
      {notice && <div className="alert alert-warn mt-5" role="status">{notice}</div>}
      {current?.sharedWithOtherEmployees > 0 && (
        <div className="alert alert-warn mt-5">
          This account is also the salary account of {current.sharedWithOtherEmployees} other employee(s). Confirm it before paying.
        </div>
      )}

      {data && !current && (
        <div className="empty-state">
          <p className="font-semibold text-ink">No salary bank account recorded.</p>
          <p className="mt-1 text-sm">Salary cannot be paid by bank transfer until one is added.</p>
        </div>
      )}

      {current && (
        <Rows
          rows={[
            ['Account holder', current.accountHolderName],
            ['Account number', <span key="number" className="font-mono tracking-wider">{current.accountNumberMasked}</span>,
              canReveal ? (
                <button type="button" className="btn btn-small" aria-label="Reveal account number" onClick={() => setRevealing(true)}>
                  Reveal
                </button>
              ) : null],
            ['IFSC', current.ifsc],
            ['Bank', current.bankName],
            ['Account type', ACCOUNT_TYPE_LABELS[current.accountType]],
            ['Paid into from', formatDate(current.effectiveFrom)],
          ]}
        />
      )}

      {data?.history?.length > 1 && (
        <div tabIndex={0} className="pg-scrollbar mt-6 overflow-x-auto">
          <table className="data-table" aria-label="Bank account history">
            <thead>
              <tr>
                <th>Version</th>
                <th>Account</th>
                <th>Recorded</th>
              </tr>
            </thead>
            <tbody>
              {data.history.map((account) => (
                <tr key={account.id}>
                  <td>
                    {account.version}
                    <span className="block text-xs text-ink-2">{account.isCurrent ? 'Current' : `Replaced ${formatDate(account.supersededAt)}`}</span>
                  </td>
                  <td className="font-mono text-sm">
                    {account.accountNumberMasked} · {account.ifsc}
                    {account.reason && <span className="block font-sans text-xs text-ink-2">{account.reason}</span>}
                  </td>
                  <td className="text-xs text-ink-2">
                    {account.recordedByEmail}
                    <span className="block">{formatDate(account.recordedAt)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <BankAccountDialog
          employeeId={employeeId}
          onClose={() => setEditing(false)}
          onSaved={(result) => {
            setEditing(false);
            setNotice((result.warnings || []).map((warning) => warning.message).join(' '));
            load();
            onChanged();
          }}
        />
      )}

      {revealing && current && (
        <RevealDialog
          label="account number"
          onClose={() => setRevealing(false)}
          onReveal={(reason) =>
            profileService.revealBankAccountNumber(employeeId, current.id, reason).then((result) => result.data.value)}
        />
      )}
    </section>
  );
}

function BankAccountDialog({ employeeId, onClose, onSaved }) {
  const [form, setForm] = useState({
    accountHolderName: '',
    accountNumber: '',
    confirmAccountNumber: '',
    ifsc: '',
    bankName: '',
    accountType: 'SAVINGS',
    effectiveFrom: todayInput(),
    reason: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const update = (event) => setForm((previous) => ({ ...previous, [event.target.name]: event.target.value }));

  const submit = async () => {
    if (form.accountNumber.replace(/\s/g, '') !== form.confirmAccountNumber.replace(/\s/g, '')) {
      setError({ message: '', fields: { confirmAccountNumber: 'The account numbers do not match.' } });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { confirmAccountNumber, reason, bankName, ...fields } = form;
      const result = await profileService.addBankAccount(employeeId, {
        ...fields,
        ...(bankName.trim() && { bankName: bankName.trim() }),
        ...(reason.trim() && { reason: reason.trim() }),
      });
      onSaved(result.data);
    } catch (err) {
      setError(apiError(err, 'The bank account could not be saved.'));
      setSaving(false);
    }
  };

  const text = (name, label, props = {}) => (
    <label className="label">
      {label}
      <input name={name} className="field mt-2" value={form[name]} onChange={update} {...props} />
      <FieldError message={error?.fields?.[name]} />
    </label>
  );

  return (
    <Dialog
      eyebrow="Versioned and encrypted"
      title="Salary bank account"
      onClose={onClose}
      onSubmit={submit}
      submitLabel="Save bank account"
      submitting={saving}
      wide
    >
      <p className="mt-3 text-sm leading-6 text-ink-2">
        The previous account is kept in history. Confirm a new account with the employee through a channel other than the one the request came from.
      </p>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {text('accountHolderName', 'Account holder name', { required: true })}
        {text('ifsc', 'IFSC', { required: true, placeholder: 'HDFC0001234', autoComplete: 'off' })}
        {text('accountNumber', 'Account number', { required: true, inputMode: 'numeric', autoComplete: 'off' })}
        {text('confirmAccountNumber', 'Confirm account number', { required: true, inputMode: 'numeric', autoComplete: 'off' })}
        {text('bankName', 'Bank name (optional)')}
        <label className="label">
          Account type
          <select name="accountType" className="field mt-2" value={form.accountType} onChange={update}>
            {ACCOUNT_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        {text('effectiveFrom', 'Pay into this account from', { type: 'date', required: true })}
        {text('reason', 'Reason (optional)', { maxLength: 300 })}
      </div>
      {error?.message && <div className="alert alert-danger mt-4" role="alert">{error.message}</div>}
    </Dialog>
  );
}
