import { useCallback, useEffect, useState } from 'react';
import * as profileService from '../../services/employeeProfileService';
import { can } from '../../utils/permissions';
import RevealDialog from './RevealDialog';
import { Dialog, FieldError, Rows, SectionHeader, apiError, formatDate } from './shared';

const FIELDS = [
  ['pan', 'PAN', 'ABCDE1234F'],
  ['uan', 'UAN', '12 digits'],
  ['esicNumber', 'ESIC insurance number', '10 digits'],
  ['pfMemberId', 'PF member ID', 'For example MHBAN00000640000000125'],
];

export default function StatutorySection({ employeeId, user, onChanged }) {
  const canWrite = can(user, 'employee.statutory.write');
  const canReveal = can(user, 'sensitive.read');
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [revealing, setRevealing] = useState(null);

  const load = useCallback(() => {
    profileService
      .getStatutoryProfile(employeeId)
      .then((result) => setProfile(result.data.profile))
      .catch((err) => setError(apiError(err, 'Unable to load statutory identifiers.').message));
  }, [employeeId]);

  useEffect(load, [load]);

  return (
    <section className="panel" aria-labelledby="statutory-title">
      <SectionHeader
        eyebrow="Statutory identifiers"
        title="Tax and social security"
        id="statutory-title"
        subtitle="Encrypted at rest and shown masked. Revealing a value is recorded in the audit trail."
      >
        {canWrite && (
          <button type="button" className="btn" onClick={() => setEditing(true)}>
            Update identifiers
          </button>
        )}
      </SectionHeader>

      {error && <div className="alert alert-danger mt-5" role="alert">{error}</div>}

      {profile && (
        <>
          <Rows
            rows={FIELDS.map(([field, label]) => {
              const value = profile.fields[field];
              return [
                label,
                value.isSet ? <span className="font-mono tracking-wider">{value.masked}</span> : 'Not recorded',
                canReveal && value.isSet ? (
                  <button type="button" className="btn btn-small" aria-label={`Reveal ${label}`} onClick={() => setRevealing([field, label])}>
                    Reveal
                  </button>
                ) : null,
              ];
            })}
          />
          <p className="mt-3 text-xs text-[#6F6565]">
            {profile.version > 0
              ? `Version ${profile.version} · updated ${formatDate(profile.updatedAt)} by ${profile.updatedByEmail || 'unknown'}`
              : 'Nothing recorded yet.'}
          </p>
        </>
      )}

      {editing && (
        <StatutoryDialog
          employeeId={employeeId}
          profile={profile}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false);
            setProfile(saved);
            onChanged();
          }}
        />
      )}

      {revealing && (
        <RevealDialog
          label={revealing[1]}
          onClose={() => setRevealing(null)}
          onReveal={(reason) =>
            profileService.revealStatutoryField(employeeId, revealing[0], reason).then((result) => result.data.value)}
        />
      )}
    </section>
  );
}

function StatutoryDialog({ employeeId, profile, onClose, onSaved }) {
  const [values, setValues] = useState({ pan: '', uan: '', esicNumber: '', pfMemberId: '' });
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    const changes = Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim()));
    if (Object.keys(changes).length === 0) {
      setError({ message: 'Enter at least one identifier to record.', fields: {} });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await profileService.updateStatutoryProfile(employeeId, { ...changes, ...(reason.trim() && { reason: reason.trim() }) });
      onSaved(result.data.profile);
    } catch (err) {
      setError(apiError(err, 'The identifiers could not be saved.'));
      setSaving(false);
    }
  };

  return (
    <Dialog
      eyebrow="Versioned and encrypted"
      title="Update statutory identifiers"
      onClose={onClose}
      onSubmit={submit}
      submitLabel="Save identifiers"
      submitting={saving}
      wide
    >
      <p className="mt-3 text-sm leading-6 text-[#6F6565]">
        Leave a field blank to keep its current value. Values are encrypted before they are stored and are never shown in full again without an audited reveal.
      </p>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {FIELDS.map(([field, label, example]) => {
          const current = profile?.fields?.[field];
          return (
            <label key={field} className="label">
              {label}
              <input
                name={field}
                className="field mt-2 font-mono"
                autoComplete="off"
                spellCheck={false}
                value={values[field]}
                placeholder={current?.isSet ? `Keep ${current.masked}` : example}
                onChange={(event) => setValues((previous) => ({ ...previous, [field]: event.target.value }))}
              />
              <FieldError message={error?.fields?.[field]} />
            </label>
          );
        })}
      </div>
      <label className="label mt-4 block">
        Reason (optional)
        <input className="field mt-2" maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      {error?.message && <div className="alert alert-danger mt-4" role="alert">{error.message}</div>}
    </Dialog>
  );
}
