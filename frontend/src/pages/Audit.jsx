import { useContext, useEffect, useRef, useState } from 'react';
import { AuthContext } from '../contexts/AuthContext';
import { can } from '../utils/permissions';
import * as auditService from '../services/auditService';
import Icon from '../components/ui/Icon';
import StatusBadge from '../components/ui/StatusBadge';
import { PageHeader, EmptyState, LoadingState } from '../components/ui/PageParts';

/** "AUTH_LOGIN_SUCCEEDED" → "Auth login succeeded"; the raw code stays visible beneath it. */
const humanize = (code) => {
  const text = String(code || '').toLowerCase().replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export default function Audit() {
  const { user } = useContext(AuthContext);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [verification, setVerification] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const canVerify = can(user, 'audit.verify');

  useEffect(() => {
    auditService
      .listAuditLogs({ limit: 100 })
      .then((result) => setLogs(result.data?.logs || []))
      .catch((err) => setError(err.response?.data?.message || 'Unable to load audit logs.'))
      .finally(() => setLoading(false));
  }, []);

  const verify = async () => {
    setVerifying(true);
    try {
      const result = await auditService.verifyAuditChain();
      setVerification({ ...(result.data || result), checkedAt: new Date() });
    } catch (err) {
      // A broken chain answers 409 with the verification result in data.
      const body = err.response?.data;
      setVerification(body?.data
        ? { ...body.data, checkedAt: new Date() }
        : { failedRequest: true, reason: body?.message || 'The verification request did not complete.', checkedAt: new Date() });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Tamper-evident history"
        title="Audit Trail"
        subtitle="Business operations recorded by the backend, each linked by hash to the record before it."
      />

      <section className="panel" aria-labelledby="verify-title">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-2xl">
            <p className="eyebrow">Chain verification</p>
            <h2 className="section-title" id="verify-title">Audit chain integrity</h2>
            <p className="mt-1.5 text-sm leading-6 text-ink-2">
              Recomputes every record’s hash and its link to the previous record. A pass means the stored records are
              consistent with their hashes and sequence. It is tamper-evident, not tamper-proof, and it does not check
              payroll results, compliance or connectivity.
            </p>
          </div>
          {canVerify ? (
            <button type="button" className="btn btn-primary shrink-0" disabled={verifying} onClick={verify}>
              {verifying ? 'Verifying…' : verification ? 'Verify again' : 'Verify audit chain'}
            </button>
          ) : (
            <StatusBadge tone="unknown">Needs audit verify permission</StatusBadge>
          )}
        </div>

        <div role="status" aria-live="polite">
          {verification && (
            <div className={`mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[12px] border px-4 py-3 text-sm ${
              verification.failedRequest ? 'border-line-strong bg-canvas-2' : verification.valid ? 'border-ok-line bg-ok-tint' : 'border-bad-line bg-bad-tint'}`}
            >
              <StatusBadge tone={verification.failedRequest ? 'unknown' : verification.valid ? 'verified' : 'failed'}>
                {verification.failedRequest ? 'Not completed' : verification.valid ? 'Chain verified' : 'Chain broken'}
              </StatusBadge>
              {!verification.failedRequest && (
                <span className="text-ink"><span className="tabular">{verification.checkedRecords}</span> records checked</span>
              )}
              {!verification.valid && !verification.failedRequest && verification.firstBrokenSequence != null && (
                <span className="text-ink">First broken record <span className="tabular font-semibold">#{verification.firstBrokenSequence}</span></span>
              )}
              {verification.reason && <span className="text-ink">{verification.reason}</span>}
              <span className="text-ink-2 sm:ml-auto">at {verification.checkedAt.toLocaleTimeString('en-IN')}</span>
            </div>
          )}
        </div>
      </section>

      {error && <div className="alert alert-danger" role="alert">{error}</div>}

      <section className="panel !p-0" aria-labelledby="events-title">
        <div className="flex flex-wrap items-end justify-between gap-3 px-5 pt-5 sm:px-6 sm:pt-6">
          <div>
            <p className="eyebrow">Audit history</p>
            <h2 className="section-title" id="events-title">Recorded events</h2>
          </div>
          {!loading && <p className="text-[13px] text-ink-2">Most recent {logs.length} {logs.length === 1 ? 'event' : 'events'}, newest first</p>}
        </div>

        {loading ? (
          <div className="px-6 py-6"><LoadingState label="Loading audit events" /></div>
        ) : logs.length === 0 ? (
          <EmptyState title="No audit events">No events were returned for this company.</EmptyState>
        ) : (
          <div tabIndex={0} className="pg-scrollbar mt-4 overflow-x-auto border-t border-line">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="!rounded-none">When</th>
                  <th>Event</th>
                  <th>Actor</th>
                  <th>Record</th>
                  <th>Status after</th>
                  <th className="!rounded-none"><span className="sr-only">Detail</span></th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log._id}>
                    <td className="whitespace-nowrap">
                      <span className="block text-ink">{formatDay(log.createdAt)}</span>
                      <span className="block text-xs text-ink-2">{formatTime(log.createdAt)}</span>
                    </td>
                    <td>
                      <span className="block font-medium text-ink">{humanize(log.action)}</span>
                      <span className="block font-mono text-[11px] text-ink-2">
                        {log.sequenceNumber != null && <>#{log.sequenceNumber} · </>}{log.action}
                      </span>
                    </td>
                    <td>
                      <span className="block text-ink">{log.actorEmail || 'Not recorded'}</span>
                      <span className="block text-xs text-ink-2">{log.actorRole || 'Role not recorded'}</span>
                    </td>
                    <td>
                      <span className="block text-ink">{humanize(log.entityType)}</span>
                      <span className="block font-mono text-[11px] text-ink-2">{String(log.entityId || '').slice(-12)}</span>
                    </td>
                    <td>
                      {log.newStatus
                        ? <span className="status status-neutral">{humanize(log.newStatus)}</span>
                        : <span className="text-xs text-ink-2">No status change</span>}
                    </td>
                    <td className="text-right">
                      <button type="button" className="btn btn-small" onClick={() => setSelected(log)}>
                        Details<span className="sr-only"> for {humanize(log.action)}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selected && <AuditDetail log={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function AuditDetail({ log, onClose }) {
  const closeRef = useRef(null);
  useEffect(() => {
    const opener = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); opener?.focus?.(); };
  }, [onClose]);

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="audit-detail-title">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="eyebrow">Event detail</p>
            <h2 id="audit-detail-title" className="section-title">{humanize(log.action)}</h2>
            <p className="mt-0.5 font-mono text-[11.5px] text-ink-2">{log.action}</p>
          </div>
          <button ref={closeRef} type="button" className="icon-button" aria-label="Close event detail" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>

        <dl className="mt-5 divide-y divide-line text-sm">
          {[
            ['Sequence', log.sequenceNumber != null ? `#${log.sequenceNumber}` : 'Not recorded'],
            ['Actor', log.actorEmail || 'Not recorded'],
            ['When', formatDate(log.createdAt)],
            ['Record', `${humanize(log.entityType)} · ${log.entityId}`],
            ['Status before', log.previousStatus ? humanize(log.previousStatus) : 'Not recorded'],
            ['Status after', log.newStatus ? humanize(log.newStatus) : 'Not recorded'],
          ].map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4 py-2.5">
              <dt className="text-ink-2">{label}</dt>
              <dd className="max-w-[65%] break-words text-right font-medium text-ink">{value}</dd>
            </div>
          ))}
        </dl>

        {log.meta && (
          <>
            <p className="mt-5 text-[12.5px] font-semibold text-ink">Recorded details</p>
            <pre className="mt-1.5 max-h-56 overflow-auto rounded-[10px] border border-line bg-canvas-2 p-4 font-mono text-xs leading-5 text-ink">
              {JSON.stringify(log.meta, null, 2)}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'medium' }) : 'Not recorded';
}

function formatDay(value) {
  return value ? new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Not recorded';
}

function formatTime(value) {
  return value ? new Date(value).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
}
