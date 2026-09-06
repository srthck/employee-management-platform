import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import * as payrollRunService from '../services/payrollRunService';

const statusTone = {
  DRAFT: 'neutral',
  PROCESSING: 'info',
  READY_FOR_FINALIZATION: 'warn',
  FINALIZED: 'success',
  DISBURSED: 'success',
  FAILED: 'danger',
  CANCELLED: 'neutral',
};

function StatusBadge({ value }) {
  const tone = statusTone[value] || 'neutral';

  const icon =
    tone === 'success'
      ? '✓'
      : tone === 'warn'
        ? '⚠'
        : tone === 'danger'
          ? '✕'
          : '●';

  return (
    <span className={`status status-${tone}`}>
      <span aria-hidden="true">{icon}</span>
      {value?.replaceAll('_', ' ') || 'UNKNOWN'}
    </span>
  );
}

function monthName(month, year) {
  if (!month || !year) return 'Unknown period';

  return new Date(year, month - 1, 1).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
  });
}

function Metric({ label, value, note }) {
  return (
    <div className="border-l-2 border-[#A6192E] pl-4">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#6F6565]">
        {label}
      </p>

      <p className="mt-2 text-2xl font-semibold tracking-tight text-[#241F20]">
        {value}
      </p>

      {note && (
        <p className="mt-1 text-xs text-[#6F6565]">
          {note}
        </p>
      )}
    </div>
  );
}

export default function PayrollDetails() {
  const { id } = useParams();

  const [run, setRun] = useState(null);
  const [loading, setLoading] = useState(true);

  const [actionLoading, setActionLoading] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const loadRun = async () => {
    try {
      setLoading(true);
      setError('');

      const response = await payrollRunService.getPayrollRun(id);

      setRun(response?.data?.run || response?.run || null);
    } catch (err) {
      console.error(err);

      setError(
        err.response?.data?.message ||
          err.message ||
          'Unable to load payroll run.'
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRun();
  }, [id]);

  const runAction = async (action, actionFunction, successMessage) => {
    try {
      setActionLoading(action);
      setError('');
      setSuccess('');

      await actionFunction(id);

      setSuccess(successMessage);

      await loadRun();
    } catch (err) {
      console.error(err);

      setError(
        err.response?.data?.message ||
          err.message ||
          `Unable to ${action.toLowerCase()} payroll run.`
      );
    } finally {
      setActionLoading('');
    }
  };

  const handlePreflight = () =>
    runAction(
      'Preflight',
      payrollRunService.preflightPayrollRun,
      'Preflight completed successfully.'
    );

  const handleProcess = () =>
    runAction(
      'Process',
      payrollRunService.processPayrollRun,
      'Payroll processing completed successfully.'
    );

  const handleFinalize = () =>
    runAction(
      'Finalize',
      payrollRunService.finalizePayrollRun,
      'Payroll run finalized successfully.'
    );

  if (loading) {
    return (
      <div className="panel py-16 text-center text-sm text-[#6F6565]">
        Loading payroll run...
      </div>
    );
  }

  if (!run) {
    return (
      <div className="space-y-6">
        <Link
          to="/payroll"
          className="text-sm font-semibold text-[#A6192E] transition hover:text-[#7D1022]"
        >
          ← Back to payroll runs
        </Link>

        <div className="alert alert-danger">
          {error || 'Payroll run not found.'}
        </div>
      </div>
    );
  }

  const canPreflight =
    run.status === 'DRAFT' ||
    run.status === 'FAILED';

  const canProcess =
    run.status === 'DRAFT' ||
    run.status === 'READY_FOR_FINALIZATION';

  const canFinalize =
    run.status === 'READY_FOR_FINALIZATION';

  return (
    <div className="space-y-8">

      {/* Header */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">

        <div>
          <Link
            to="/payroll"
            className="text-sm font-semibold text-[#A6192E] transition hover:text-[#7D1022]"
          >
            ← Back to payroll runs
          </Link>

          <p className="eyebrow mt-5">
            Payroll operation
          </p>

          <h1 className="page-title">
            {monthName(run.periodMonth, run.periodYear)}
          </h1>

          <p className="page-subtitle">
            Review, preflight, process and finalize this payroll run.
          </p>
        </div>

        <StatusBadge value={run.status} />

      </div>

      {/* Messages */}
      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}

      {success && (
        <div className="alert alert-success" role="status">
          {success}
        </div>
      )}

      {/* Summary */}
      <section className="panel">

        <div className="border-b border-[#E7D8D5] pb-5">
          <p className="eyebrow">
            Run summary
          </p>

          <h2 className="section-title">
            Payroll status
          </h2>
        </div>

        <div className="mt-7 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">

          <Metric
            label="Employees"
            value={run.employeeCount ?? 0}
            note="Employees included in run"
          />

          <Metric
            label="Eligible"
            value={run.successfulEmployeeCount ?? 0}
            note="Server-confirmed"
          />

          <Metric
            label="Processed"
            value={`${run.processedEmployeeCount ?? 0} / ${run.employeeCount ?? 0}`}
            note="Processing progress"
          />

          <Metric
            label="Snapshots"
            value={run.durableResultCount ?? 0}
            note="Durable payroll results"
          />

        </div>

      </section>

      {/* Preflight */}
      <section className="panel">

        <div>
          <p className="eyebrow">
            Step 1
          </p>

          <h2 className="section-title">
            Preflight checks
          </h2>

          <p className="mt-2 text-sm text-[#6F6565]">
            Validate employee eligibility, salary configuration and
            compliance requirements before processing payroll.
          </p>
        </div>

        {run.preflightResult && (
          <div className="mt-5 rounded-[10px] border border-[#E7D8D5] bg-[#FFF7F0] p-5">

            <p className="text-sm font-semibold text-[#241F20]">
              Preflight result
            </p>

            <p className="mt-2 text-sm text-[#6F6565]">
              {run.preflightResult.canProcess === false
                ? 'Action required before payroll can be processed.'
                : 'Payroll is eligible for processing.'}
            </p>

          </div>
        )}

        <div className="mt-6">

          <button
            type="button"
            onClick={handlePreflight}
            disabled={!canPreflight || actionLoading !== ''}
            className="btn btn-primary"
          >
            {actionLoading === 'Preflight'
              ? 'Running preflight...'
              : 'Run Preflight'}
          </button>

        </div>

      </section>

      {/* Processing */}
      <section className="panel">

        <div>
          <p className="eyebrow">
            Step 2
          </p>

          <h2 className="section-title">
            Process payroll
          </h2>

          <p className="mt-2 text-sm text-[#6F6565]">
            Calculate payroll for all eligible employees and create
            durable payroll results.
          </p>
        </div>

        <div className="mt-6">

          <button
            type="button"
            onClick={handleProcess}
            disabled={!canProcess || actionLoading !== ''}
            className="btn btn-primary"
          >
            {actionLoading === 'Process'
              ? 'Processing payroll...'
              : 'Process Payroll'}
          </button>

        </div>

      </section>

      {/* Finalization */}
      <section className="panel">

        <div>
          <p className="eyebrow">
            Step 3
          </p>

          <h2 className="section-title">
            Finalize payroll
          </h2>

          <p className="mt-2 text-sm text-[#6F6565]">
            Lock the completed payroll run after successful processing.
          </p>
        </div>

        <div className="mt-6">

          <button
            type="button"
            onClick={handleFinalize}
            disabled={!canFinalize || actionLoading !== ''}
            className="btn btn-primary"
          >
            {actionLoading === 'Finalize'
              ? 'Finalizing...'
              : 'Finalize Payroll'}
          </button>

        </div>

      </section>

      {/* Snapshots */}
      <section className="panel">

        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">

          <div>
            <p className="eyebrow">
              Payroll results
            </p>

            <h2 className="section-title">
              Payroll Snapshots
            </h2>

            <p className="mt-2 text-sm text-[#6F6565]">
              View the immutable payroll results generated for this run.
            </p>
          </div>

          <Link
            to={`/snapshots?payrollRunId=${run._id || run.id}`}
            className="btn btn-secondary"
          >
            View Snapshots →
          </Link>

        </div>

      </section>

    </div>
  );
}