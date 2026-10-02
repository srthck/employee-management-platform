import { useCallback, useEffect, useState } from 'react';
import * as profileService from '../../services/employeeProfileService';
import { can } from '../../utils/permissions';
import { Dialog, FieldError, SectionHeader, apiError, formatDate } from './shared';

const DOCUMENT_TYPES = [
  ['PAN_CARD', 'PAN card'],
  ['PASSPORT', 'Passport'],
  ['OFFER_LETTER', 'Offer letter'],
  ['APPOINTMENT_LETTER', 'Appointment letter'],
  ['RELIEVING_LETTER', 'Relieving letter'],
  ['EDUCATION_CERTIFICATE', 'Education certificate'],
  ['ADDRESS_PROOF', 'Address proof'],
  ['BANK_PROOF', 'Bank proof (cancelled cheque or statement)'],
  ['PF_NOMINATION_FORM_2', 'PF nomination (Form 2)'],
  ['PF_DECLARATION_FORM_11', 'PF declaration (Form 11)'],
  ['OTHER', 'Other'],
];
const TYPE_LABELS = Object.fromEntries(DOCUMENT_TYPES);
const STATUS_TONE = { SUBMITTED: 'warn', VERIFIED: 'success', REJECTED: 'danger' };
const STATUS_LABEL = { SUBMITTED: 'Awaiting verification', VERIFIED: 'Verified', REJECTED: 'Rejected' };

async function sha256Hex(file) {
  const digest = await window.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export default function DocumentsSection({ employeeId, user, onChanged }) {
  const canWrite = can(user, 'employee.document.write');
  const canVerify = can(user, 'employee.document.verify');
  const [documents, setDocuments] = useState(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [rejecting, setRejecting] = useState(null);

  const load = useCallback(() => {
    profileService
      .getDocuments(employeeId)
      .then((result) => setDocuments(result.data.documents))
      .catch((err) => setError(apiError(err, 'Unable to load documents.').message));
  }, [employeeId]);

  useEffect(load, [load]);

  const decide = async (documentId, decision, note) => {
    setError('');
    try {
      await profileService.decideDocument(employeeId, documentId, { decision, ...(note && { note }) });
      setRejecting(null);
      load();
      onChanged();
    } catch (err) {
      setError(apiError(err, 'The decision could not be recorded.').message);
    }
  };

  return (
    <section className="panel" aria-labelledby="documents-title">
      <SectionHeader
        eyebrow="Documents"
        title="Employee documents"
        id="documents-title"
        subtitle="Verified by someone other than the person who recorded them. Decisions are final."
      >
        {canWrite && (
          <button type="button" className="btn" onClick={() => setSubmitting(true)}>
            Record document
          </button>
        )}
      </SectionHeader>

      {error && <div className="alert alert-danger mt-5" role="alert">{error}</div>}

      {documents && documents.length === 0 && (
        <div className="empty-state">
          <p className="font-semibold text-[#241F20]">No documents recorded.</p>
        </div>
      )}

      {documents?.length > 0 && (
        <div className="pg-scrollbar mt-5 overflow-x-auto">
          <table className="data-table" aria-label="Documents">
            <thead>
              <tr>
                <th>Document</th>
                <th>Validity</th>
                <th>Status</th>
                <th className="text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => {
                const ownSubmission = doc.submittedByEmail === user?.email;
                return (
                  <tr key={doc.id}>
                    <td>
                      <span className="font-semibold text-[#241F20]">{doc.title}</span>
                      <span className="block text-xs text-[#6F6565]">
                        {TYPE_LABELS[doc.documentType]} · recorded by {doc.submittedByEmail}
                      </span>
                      {doc.fileSha256 && (
                        <span className="block font-mono text-[10px] text-[#8A807C]" title="SHA-256 fingerprint of the file">
                          {doc.fileSha256.slice(0, 16)}…
                        </span>
                      )}
                    </td>
                    <td className="text-sm">
                      {doc.issuedOn ? `Issued ${formatDate(doc.issuedOn)}` : 'No issue date'}
                      {doc.expiresOn && (
                        <span className={`block text-xs ${doc.isExpired ? 'font-semibold text-[#A33D35]' : 'text-[#6F6565]'}`}>
                          {doc.isExpired ? 'Expired' : 'Expires'} {formatDate(doc.expiresOn)}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`status status-${STATUS_TONE[doc.status]}`}>{STATUS_LABEL[doc.status]}</span>
                      {doc.decision && (
                        <span className="mt-1 block text-xs text-[#6F6565]">
                          by {doc.decision.byEmail} · {formatDate(doc.decision.at)}
                          {doc.decision.note && ` · ${doc.decision.note}`}
                        </span>
                      )}
                    </td>
                    <td className="text-right">
                      {doc.status === 'SUBMITTED' && canVerify && !ownSubmission && (
                        <div className="flex justify-end gap-2">
                          <button type="button" className="btn btn-small" onClick={() => decide(doc.id, 'VERIFIED')}>
                            Verify
                          </button>
                          <button type="button" className="btn btn-small" onClick={() => setRejecting(doc)}>
                            Reject
                          </button>
                        </div>
                      )}
                      {doc.status === 'SUBMITTED' && ownSubmission && (
                        <span className="text-xs text-[#6F6565]">Another person verifies</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {submitting && (
        <DocumentDialog
          employeeId={employeeId}
          onClose={() => setSubmitting(false)}
          onSaved={() => {
            setSubmitting(false);
            load();
            onChanged();
          }}
        />
      )}

      {rejecting && (
        <RejectDialog
          document={rejecting}
          onClose={() => setRejecting(null)}
          onReject={(note) => decide(rejecting.id, 'REJECTED', note)}
        />
      )}
    </section>
  );
}

function DocumentDialog({ employeeId, onClose, onSaved }) {
  const [form, setForm] = useState({ documentType: 'PAN_CARD', title: '', issuedOn: '', expiresOn: '', notes: '' });
  const [fileSha256, setFileSha256] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const update = (event) => setForm((previous) => ({ ...previous, [event.target.name]: event.target.value }));

  const fingerprint = async (event) => {
    const file = event.target.files?.[0];
    setFileSha256(file ? await sha256Hex(file) : null);
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await profileService.submitDocument(employeeId, {
        documentType: form.documentType,
        title: form.title.trim(),
        ...(form.issuedOn && { issuedOn: form.issuedOn }),
        ...(form.expiresOn && { expiresOn: form.expiresOn }),
        ...(form.notes.trim() && { notes: form.notes.trim() }),
        ...(fileSha256 && { fileSha256 }),
      });
      onSaved();
    } catch (err) {
      setError(apiError(err, 'The document could not be recorded.'));
      setSaving(false);
    }
  };

  return (
    <Dialog eyebrow="Structured record" title="Record document" onClose={onClose} onSubmit={submit} submitLabel="Record document" submitting={saving} wide>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <label className="label">
          Document type
          <select name="documentType" className="field mt-2" value={form.documentType} onChange={update}>
            {DOCUMENT_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="label">
          Title
          <input name="title" required className="field mt-2" value={form.title} onChange={update} />
          <FieldError message={error?.fields?.title} />
        </label>
        <label className="label">
          Issued on
          <input name="issuedOn" type="date" className="field mt-2" value={form.issuedOn} onChange={update} />
        </label>
        <label className="label">
          Expires on
          <input name="expiresOn" type="date" className="field mt-2" value={form.expiresOn} onChange={update} />
        </label>
      </div>
      <label className="label mt-4 block">
        File fingerprint (optional)
        <input type="file" className="field mt-2" onChange={fingerprint} />
        <span className="mt-1 block text-xs text-[#6F6565]">
          {fileSha256
            ? `SHA-256 ${fileSha256.slice(0, 24)}… is recorded. The file itself is not uploaded.`
            : 'Only a SHA-256 fingerprint is computed in your browser and recorded; the file is not uploaded.'}
        </span>
      </label>
      <label className="label mt-4 block">
        Notes (optional)
        <input name="notes" className="field mt-2" maxLength={300} value={form.notes} onChange={update} />
      </label>
      {error?.message && <div className="alert alert-danger mt-4" role="alert">{error.message}</div>}
    </Dialog>
  );
}

function RejectDialog({ document, onClose, onReject }) {
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const valid = note.trim().length >= 5;

  return (
    <Dialog
      eyebrow="Final decision"
      title={`Reject ${document.title}`}
      onClose={onClose}
      onSubmit={async () => {
        setSaving(true);
        await onReject(note.trim());
        setSaving(false);
      }}
      submitLabel="Reject document"
      submitting={saving}
      submitDisabled={!valid}
    >
      <label className="label mt-5 block">
        Why is it rejected?
        <textarea className="field mt-2 min-h-[80px]" maxLength={300} value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
    </Dialog>
  );
}
