import { useEffect, useState } from 'react';
import * as auditService from '../services/auditService';

export default function Audit() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [verification, setVerification] = useState(null);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    auditService
      .listAuditLogs({ limit: 100 })
      .then((result) => setLogs(result.data?.logs || []))
      .catch((err) =>
        setError(
          err.response?.data?.message || 'Unable to load audit logs.'
        )
      )
      .finally(() => setLoading(false));
  }, []);

  const verify = async () => {
    setVerifying(true);

    try {
      const result = await auditService.verifyAuditChain();
      setVerification(result.data || result);
    } catch (err) {
      setVerification(
        err.response?.data || {
          valid: false,
          reason: 'Audit verification request failed.',
        }
      );
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* PAGE HEADER */}
      <div>
        <p className="eyebrow">Tamper-evident history</p>

        <h1 className="page-title">
          Audit Trail
        </h1>

        <p className="page-subtitle">
          Critical business operations recorded by the backend audit subsystem.
        </p>
      </div>

      {/* ERROR */}
      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}

      {/* AUDIT HISTORY */}
      <section className="panel">
        <div className="flex flex-col justify-between gap-4 border-b border-[#E7D8D5] pb-5 sm:flex-row sm:items-center">
          <div>
            <p className="eyebrow">Audit history</p>

            <h2 className="section-title">
              Recorded events
            </h2>
          </div>

          <span className="status status-info">
            {loading ? 'Loading' : `${logs.length} events loaded`}
          </span>
        </div>

        {loading ? (
          <div className="py-14 text-center text-sm text-[#6F6565]">
            Loading audit events...
          </div>
        ) : logs.length === 0 ? (
          <div className="empty-state">
            <p className="font-semibold text-[#241F20]">
              No audit events found.
            </p>

            <p className="mt-1 text-sm text-[#6F6565]">
              No events were returned for this company context.
            </p>
          </div>
        ) : (
          <div className="pg-scrollbar mt-5 overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Actor</th>
                  <th>Entity</th>
                  <th>Action</th>
                  <th>Result</th>
                  <th />
                </tr>
              </thead>

              <tbody>
                {logs.map((log) => (
                  <tr key={log._id}>
                    <td className="text-xs text-[#241F20]">
                      {formatDate(log.createdAt)}
                    </td>

                    <td>
                      <span className="font-medium text-[#241F20]">
                        {log.actorEmail || 'Not available'}
                      </span>

                      <span className="block text-xs text-[#6F6565]">
                        {log.actorRole || 'Not available'}
                      </span>
                    </td>

                    <td>
                      <span className="font-medium text-[#241F20]">
                        {log.entityType}
                      </span>

                      <span className="block text-xs text-[#6F6565]">
                        {log.entityId}
                      </span>
                    </td>

                    <td className="font-semibold text-[#A6192E]">
                      {log.action}
                    </td>

                    <td>
                      <span className="status status-neutral">
                        {log.newStatus || 'Recorded'}
                      </span>
                    </td>

                    <td className="text-right">
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => setSelected(log)}
                      >
                        View detail
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* CHAIN VERIFICATION */}
      <section className="panel">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <p className="eyebrow">Chain verification</p>

            <h2 className="section-title">
              Audit chain integrity
            </h2>

            <p className="mt-2 max-w-2xl text-sm leading-6 text-[#6F6565]">
              Verify that the tamper-evident audit records remain consistent
              with their stored cryptographic chain.
            </p>
          </div>

          <button
            type="button"
            className="btn btn-primary"
            disabled={verifying}
            onClick={verify}
          >
            {verifying
              ? 'Verifying audit chain...'
              : 'Verify audit chain'}
          </button>
        </div>

        {verification && (
          <div
            className={`mt-5 alert ${
              verification.valid
                ? 'alert-success'
                : 'alert-danger'
            }`}
            role="status"
          >
            {verification.valid
              ? `✓ AUDIT CHAIN VALID · ${verification.checkedRecords} records checked`
              : `✕ AUDIT CHAIN INVALID · ${
                  verification.reason || 'Verification failed'
                }${
                  verification.firstBrokenSequence
                    ? ` · Sequence ${verification.firstBrokenSequence}`
                    : ''
                }`}
          </div>
        )}
      </section>

      {/* DETAIL MODAL */}
      {selected && (
        <AuditDetail
          log={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function AuditDetail({ log, onClose }) {
  return (
    <div className="dialog-backdrop">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="audit-detail-title"
      >
        <div className="flex items-start justify-between">
          <div>
            <p className="eyebrow">Event detail</p>

            <h2
              id="audit-detail-title"
              className="section-title"
            >
              {log.action}
            </h2>
          </div>

          <button
            type="button"
            className="icon-button"
            aria-label="Close audit detail"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <dl className="mt-6 divide-y divide-[#E7D8D5] text-sm">
          {[
            ['Actor', log.actorEmail],
            ['Timestamp', formatDate(log.createdAt)],
            [
              'Entity',
              `${log.entityType} · ${log.entityId}`,
            ],
            [
              'Previous status',
              log.previousStatus || 'Not provided',
            ],
            [
              'New status',
              log.newStatus || 'Not provided',
            ],
          ].map(([label, value]) => (
            <div
              key={label}
              className="flex justify-between gap-4 py-3"
            >
              <dt className="text-[#6F6565]">
                {label}
              </dt>

              <dd className="max-w-[65%] text-right font-medium text-[#241F20]">
                {value}
              </dd>
            </div>
          ))}
        </dl>

        {log.meta && (
          <pre className="mt-5 max-h-48 overflow-auto rounded-[10px] border border-[#E7D8D5] bg-[#FFF7F0] p-4 text-xs text-[#5F5555]">
            {JSON.stringify(log.meta, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

function formatDate(value) {
  return value
    ? new Date(value).toLocaleString('en-IN')
    : 'Not available';
}