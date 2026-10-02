import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import * as snapshotService from '../services/payrollSnapshotService';
import PayslipView from '../components/PayslipView';

export default function Snapshot() {
  const { id } = useParams();

  const [payslip, setPayslip] = useState(null);
  const [loading, setLoading] = useState(true);
  const [verification, setVerification] = useState(null);
  const [error, setError] = useState('');
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    setLoading(true);
    snapshotService
      .explainSnapshot(id)
      .then((r) => setPayslip(r.data?.payslip || null))
      .catch((e) =>
        setError(
          e.response?.data?.message || 'Unable to load payslip.'
        )
      )
      .finally(() => setLoading(false));
  }, [id]);

  const verify = async () => {
    setVerifying(true);
    setError('');

    try {
      const result = await snapshotService.verifySnapshot(id);
      setVerification(result.data || result);
    } catch (e) {
      // 409 carries the failed verification result.
      const failed = e.response?.data?.data;
      if (failed) {
        setVerification(failed);
      } else {
        setError(
          e.response?.data?.message || 'Snapshot verification failed.'
        );
      }
    } finally {
      setVerifying(false);
    }
  };

  if (loading) {
    return (
      <div className="panel py-16 text-center text-sm text-[#6F6565]">
        Loading payslip...
      </div>
    );
  }

  if (!payslip) {
    return (
      <div className="alert alert-danger">
        {error || 'Payslip not found.'}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <Link
        to={`/payroll/${payslip.payrollRunId}`}
        className="inline-flex items-center text-sm font-semibold text-[#A6192E] transition hover:text-[#7D1022]"
      >
        ← Payroll run
      </Link>

      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="eyebrow">Immutable payroll record</p>
          <h1 className="page-title">Payslip</h1>
          <p className="page-subtitle">
            {payslip.employee.name} · {payslip.period.label}
          </p>
        </div>

        <span
          className={`status ${
            payslip.status === 'FINALIZED' ? 'status-success' : 'status-warn'
          }`}
        >
          {payslip.status === 'FINALIZED' ? '✓ Finalized' : '⚠ Pending finalization'}
        </span>
      </div>

      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}

      <PayslipView payslip={payslip} />

      <section className="panel">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <p className="eyebrow">Audit / integrity</p>
            <h2 className="section-title">Tamper check</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[#6F6565]">
              Recomputes the SHA-256 hash of the stored record and compares it
              with the hash written when the payslip was created.
            </p>
            <p className="mt-2 break-all font-mono text-xs text-[#6F6565]">
              {payslip.integrity.snapshotHash}
            </p>
          </div>

          <button
            type="button"
            className="btn btn-primary"
            disabled={verifying}
            onClick={verify}
          >
            {verifying ? 'Verifying...' : 'Verify now'}
          </button>
        </div>

        {verification && (
          <div
            className={`mt-5 alert ${
              verification.valid ? 'alert-success' : 'alert-danger'
            }`}
            role="status"
          >
            {verification.valid
              ? '✓ Stored record matches its original hash. No tampering detected.'
              : `✕ ${verification.reason}`}
          </div>
        )}
      </section>
    </div>
  );
}
