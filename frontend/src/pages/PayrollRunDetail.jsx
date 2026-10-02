import { useCallback, useContext, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AuthContext } from '../contexts/AuthContext';
import * as payrollRunService from '../services/payrollRunService';
import * as snapshotService from '../services/payrollSnapshotService';
import { can } from '../utils/permissions';
import { Status, money, monthName } from './Overview';

/**
 * Payroll run workspace.
 *
 * Workflow mirrors the backend state machine, with the finalization controls
 * layered on top:
 *   DRAFT / FAILED          → preflight, calculate (and cancel when FAILED)
 *   PROCESSING              → wait; recover if the run is stuck
 *   READY_FOR_FINALIZATION  → review register + classified variance, then
 *                             finalize (segregation of duties, variance gate,
 *                             override with a recorded reason)
 *   FINALIZED               → locked payslips, register, variance, approval record
 */

const PROCESSED = ['READY_FOR_FINALIZATION', 'FINALIZED', 'DISBURSED'];
const LOCKED = ['FINALIZED', 'DISBURSED'];
const OVERRIDE_REASON_MIN = 15;

const SEVERITY_TONE = { critical: 'danger', high: 'danger', warning: 'warn', info: 'neutral' };
const CLASSIFICATION_TONE = { EXPECTED: 'success', UNEXPLAINED: 'danger', INVALID: 'danger', REVIEW: 'warn' };

const COMPONENT_LABELS = {
  gross: 'Gross',
  epfEmployee: 'PF',
  esiEmployee: 'ESI',
  professionalTax: 'Professional tax',
  voluntaryDeductions: 'Voluntary deductions',
  unreconciled: 'Unreconciled',
};

const CAUSE_LABELS = {
  SALARY_REVISION: 'salary revision',
  EPF_RULE_CHANGE: 'EPF rule change',
  ESI_RULE_CHANGE: 'ESI rule change',
  PT_RULE_CHANGE: 'PT rule change',
  PT_MONTH_SPECIFIC_AMOUNT: 'month-specific PT amount',
  PF_ENROLMENT_CHANGE: 'PF enrolment change',
  ESI_ENROLMENT_CHANGE: 'ESI enrolment change',
  PT_ENROLMENT_CHANGE: 'PT enrolment change',
  WORK_STATE_CHANGE: 'work state change',
  COMPENSATION_CHANGE: 'compensation change',
  PRORATION_CHANGE: 'part-period pay',
};

const STEPS = [
  { key: 'preflight', label: 'Preflight', statuses: ['DRAFT'] },
  { key: 'calculate', label: 'Calculate', statuses: ['FAILED', 'PROCESSING'] },
  { key: 'review', label: 'Review', statuses: ['READY_FOR_FINALIZATION'] },
  { key: 'finalize', label: 'Locked', statuses: ['FINALIZED', 'DISBURSED'] },
];

const signedMoney = (value) => `${value > 0 ? '+' : ''}${money(value)}`;

function Metric({ label, value, note }) {
  return (
    <div className="border-l-2 border-[#A6192E] pl-4">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#6F6565]">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums text-[#241F20]">
        {value}
      </p>
      {note && <p className="mt-1 text-xs text-[#6F6565]">{note}</p>}
    </div>
  );
}

function StepIndicator({ status }) {
  const activeIndex = STEPS.findIndex((step) => step.statuses.includes(status));

  return (
    <ol className="flex flex-wrap gap-2" aria-label="Payroll run progress">
      {STEPS.map((step, index) => {
        const done = index < activeIndex;
        const active = index === activeIndex;
        return (
          <li
            key={step.key}
            className={`status ${
              active ? 'status-info' : done ? 'status-success' : 'status-neutral'
            }`}
            aria-current={active ? 'step' : undefined}
          >
            {done ? '✓' : `${index + 1}`} {step.label}
          </li>
        );
      })}
    </ol>
  );
}

function ChangeBreakdown({ components }) {
  if (!components?.length) return null;
  return (
    <ul className="mt-2 space-y-1 text-xs">
      {components.map((component) => (
        <li key={component.component} className="flex flex-wrap gap-x-2">
          <span className="font-medium text-[#241F20]">
            {COMPONENT_LABELS[component.component] || component.component} {signedMoney(component.delta)}
          </span>
          <span className={component.explained ? 'text-[#26765F]' : 'font-semibold text-[#A33D35]'}>
            {component.explained
              ? `explained by ${component.explainedBy.map((cause) => CAUSE_LABELS[cause] || cause).join(', ')}`
              : 'no cause found in payroll inputs'}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function PayrollRunDetail() {
  const { id } = useParams();
  const { user } = useContext(AuthContext);
  const canPreflight = can(user, 'payroll.preflight');
  const canPrepare = can(user, 'payroll.prepare');
  const canFinalize = can(user, 'payroll.finalize');

  const [run, setRun] = useState(null);
  const [loading, setLoading] = useState(true);
  const [preflight, setPreflight] = useState(null);
  const [register, setRegister] = useState(null);
  const [variance, setVariance] = useState(null);
  const [readiness, setReadiness] = useState(null);
  const [snapshots, setSnapshots] = useState([]);

  const [actionLoading, setActionLoading] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await payrollRunService.getPayrollRun(id);
      const current = response.data.run;
      setRun(current);

      if (PROCESSED.includes(current.status)) {
        const [registerResult, varianceResult] = await Promise.all([
          payrollRunService.getPayrollRegister(id),
          payrollRunService.getVarianceReport(id),
        ]);
        setRegister(registerResult.data);
        setVariance(varianceResult.data);
      } else {
        setRegister(null);
        setVariance(null);
      }

      if (current.status === 'READY_FOR_FINALIZATION') {
        setReadiness((await payrollRunService.getFinalizationReadiness(id)).data);
      } else {
        setReadiness(null);
      }

      if (LOCKED.includes(current.status)) {
        const snapshotResult = await snapshotService.getRunSnapshots(id, { limit: 200 });
        setSnapshots(snapshotResult.data?.snapshots || []);
      } else {
        setSnapshots([]);
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load payroll run.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const runAction = async (name, action, successMessage) => {
    setActionLoading(name);
    setError('');
    setSuccess('');

    try {
      const result = await action();
      setSuccess(typeof successMessage === 'function' ? successMessage(result) : successMessage);
      await load();
    } catch (err) {
      setError(
        err.response?.data?.message ||
          err.message ||
          `Unable to ${name.toLowerCase()} the payroll run.`
      );
    } finally {
      setActionLoading('');
    }
  };

  const handlePreflight = () =>
    runAction('Preflight', () => payrollRunService.preflightPayrollRun(id), (result) => {
      setPreflight(result.data);
      return result.data.canProcess
        ? 'Preflight passed. The run can be calculated.'
        : 'Preflight found blocking issues. Resolve them before calculating.';
    });

  const handleProcess = () =>
    runAction(
      'Calculate',
      () => payrollRunService.processPayrollRun(id),
      'Payroll calculated. Review the register and variance report before it is finalized.'
    );

  const closeFinalizeDialog = () => {
    setConfirmFinalize(false);
    setReviewed(false);
    setOverrideReason('');
  };

  const handleFinalize = () => {
    const payload = readiness?.requiresOverride ? { override: { reason: overrideReason.trim() } } : {};
    closeFinalizeDialog();
    return runAction(
      'Finalize',
      () => payrollRunService.finalizePayrollRun(id, payload),
      'Payroll finalized. Payslips are locked and independently verifiable.'
    );
  };

  const handleCancel = () =>
    runAction(
      'Cancel',
      () => payrollRunService.cancelPayrollRun(id),
      'Run cancelled. It stays in history, and a new run can be created for this period.'
    );

  const handleRecover = () =>
    runAction(
      'Recover',
      () => payrollRunService.recoverPayrollRun(id),
      'Run marked as failed. Calculate again to retry.'
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
        <div className="alert alert-danger">{error || 'Payroll run not found.'}</div>
      </div>
    );
  }

  const busy = actionLoading !== '';
  const hardBlockers = (readiness?.blockers || []).filter((blocker) => blocker.code !== 'FORBIDDEN');
  const reviewNeeded = Boolean(variance?.flags?.some((flag) => flag.severity !== 'info'));
  const overrideValid = overrideReason.trim().length >= OVERRIDE_REASON_MIN;
  const finalizeDisabled =
    busy ||
    (reviewNeeded && !reviewed) ||
    (readiness?.requiresOverride && (!readiness.canOverride || !overrideValid));
  const controls = run.finalizationControls;

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
          <p className="eyebrow mt-5">Payroll operation</p>
          <h1 className="page-title">{monthName(run.periodMonth, run.periodYear)}</h1>
          <p className="page-subtitle">
            Preflight, calculate, review exceptions, then lock the period.
          </p>
        </div>
        <Status value={run.status} />
      </div>

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
      {run.status === 'FAILED' && run.failureReason && (
        <div className="alert alert-danger" role="alert">
          <span className="font-semibold">Last attempt failed:</span> {run.failureReason}
        </div>
      )}

      {/* Workflow */}
      <section className="panel">
        <div className="flex flex-col gap-4 border-b border-[#E7D8D5] pb-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="eyebrow">Workflow</p>
            <h2 className="section-title">Next step</h2>
          </div>
          <StepIndicator status={run.status} />
        </div>

        <div className="mt-6 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Employees" value={run.employeeCount ?? 0} note="Considered for this period" />
          <Metric label="Paid" value={run.successfulEmployeeCount ?? 0} note="Calculated successfully" />
          <Metric label="Blocked" value={run.failedEmployeeCount ?? 0} note="Excluded: missing data" />
          <Metric label="Attempt" value={run.processingVersion || 0} note="Calculation attempts" />
        </div>

        <div className="mt-7 flex flex-wrap gap-3">
          {canPreflight && ['DRAFT', 'FAILED'].includes(run.status) && (
            <button type="button" className="btn" disabled={busy} onClick={handlePreflight}>
              {actionLoading === 'Preflight' ? 'Checking...' : 'Run preflight'}
            </button>
          )}

          {canPrepare && ['DRAFT', 'FAILED'].includes(run.status) && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={handleProcess}>
              {actionLoading === 'Calculate'
                ? 'Calculating payroll...'
                : run.status === 'FAILED' ? 'Retry calculation' : 'Calculate payroll'}
            </button>
          )}

          {canPrepare && run.status === 'FAILED' && (
            <button type="button" className="btn btn-danger" disabled={busy} onClick={handleCancel}>
              {actionLoading === 'Cancel' ? 'Cancelling...' : 'Cancel run'}
            </button>
          )}

          {canPrepare && run.status === 'PROCESSING' && (
            <button type="button" className="btn btn-danger" disabled={busy} onClick={handleRecover}>
              {actionLoading === 'Recover' ? 'Recovering...' : 'Mark stuck run as failed'}
            </button>
          )}

          {canFinalize && run.status === 'READY_FOR_FINALIZATION' && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || hardBlockers.length > 0 || (readiness?.requiresOverride && !readiness.canOverride)}
              onClick={() => setConfirmFinalize(true)}
            >
              {actionLoading === 'Finalize' ? 'Finalizing...' : 'Finalize and lock payslips'}
            </button>
          )}
        </div>

        {run.status === 'READY_FOR_FINALIZATION' && !canFinalize && (
          <p className="mt-4 text-sm text-[#6F6565]">
            Calculated and awaiting an approver with finalization permission.
          </p>
        )}

        {canFinalize && hardBlockers.length > 0 && (
          <div className="mt-5 space-y-2">
            {hardBlockers.map((blocker) => (
              <div key={blocker.code} className="alert alert-warn">
                {blocker.message}
              </div>
            ))}
          </div>
        )}

        {canFinalize && readiness?.requiresOverride && hardBlockers.length === 0 && (
          <div className="mt-5 alert alert-danger">
            {readiness.blockingFlags.length} unexplained pay change(s) block finalization.
            {readiness.canOverride
              ? ' Correct them and recalculate, or finalize with a recorded override reason.'
              : ' An approver with override permission must review them.'}
          </div>
        )}

        {run.status === 'PROCESSING' && (
          <p className="mt-4 text-sm text-[#6F6565]">
            Calculation in progress. Runs without progress for 30 minutes are
            marked failed automatically.
          </p>
        )}

        {controls && (
          <div className="mt-6 rounded-[10px] border border-[#E7D8D5] bg-[#FFF7F0] p-4 text-sm text-[#5F5555]">
            <p className="font-semibold text-[#241F20]">Approval record</p>
            <p className="mt-1">
              {controls.approvalMode === 'maker_checker'
                ? 'Maker-checker: calculated and finalized by different people.'
                : 'Single approval.'}
              {controls.variance?.counts && ` Variance at finalization: ${controls.variance.counts.unexplained} unexplained, ${controls.variance.counts.expected} expected.`}
            </p>
            {controls.override && (
              <p className="mt-2 text-[#A33D35]">
                <span className="font-semibold">Override recorded</span> by {controls.override.byEmail || 'approver'}:{' '}
                “{controls.override.reason}”
              </p>
            )}
          </div>
        )}
      </section>

      {/* Preflight result */}
      {preflight && (
        <section className="panel">
          <p className="eyebrow">Preflight</p>
          <h2 className="section-title">
            {preflight.canProcess ? 'Ready to calculate' : 'Action required'}
          </h2>

          <div className="mt-5 space-y-3">
            {preflight.blockingErrors.map((message) => (
              <div key={message} className="alert alert-danger">{message}</div>
            ))}
            {preflight.warnings.map((message) => (
              <div key={message} className="alert alert-warn">{message}</div>
            ))}
          </div>

          <p className="mt-5 text-sm text-[#6F6565]">
            {preflight.eligibleEmployees.length} eligible ·{' '}
            {preflight.blockedEmployees.length} blocked
          </p>

          {preflight.blockedEmployees.length > 0 && (
            <div className="pg-scrollbar mt-4 overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Why it is blocked</th>
                  </tr>
                </thead>
                <tbody>
                  {preflight.blockedEmployees.map((blocked) => (
                    <tr key={blocked.employeeId}>
                      <td>
                        <Link
                          to={`/employees/${blocked.employeeId}`}
                          className="font-semibold text-[#A6192E] hover:underline"
                        >
                          {blocked.name}
                        </Link>
                      </td>
                      <td>
                        <ul className="list-disc space-y-1 pl-4 text-xs">
                          {blocked.issues.map((issue) => (
                            <li key={issue}>{issue}</li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Payroll register */}
      {register && (
        <section className="panel">
          <div className="flex flex-col justify-between gap-2 border-b border-[#E7D8D5] pb-5 sm:flex-row sm:items-end">
            <div>
              <p className="eyebrow">Payroll register</p>
              <h2 className="section-title">Company totals</h2>
            </div>
            <span className="text-xs text-[#6F6565]">
              {register.source === 'STAGING'
                ? 'From calculated results awaiting finalization'
                : 'From finalized payslips'}
            </span>
          </div>

          <div className="mt-6 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            <Metric label="Gross pay" value={money(register.totals.gross)} note={`${register.totals.headcount} employees`} />
            <Metric label="Net pay" value={money(register.totals.netPayBeforeTDS)} note="Before income tax (TDS)" />
            <Metric label="Cost to company" value={money(register.totals.costToCompany)} note="Gross + employer contributions" />
          </div>

          <div className="pg-scrollbar mt-7 overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Statutory item</th>
                  <th className="text-right">Employee</th>
                  <th className="text-right">Employer</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Provident fund</td>
                  <td className="text-right tabular-nums">{money(register.totals.statutory.epfEmployee)}</td>
                  <td className="text-right tabular-nums">
                    {money(register.totals.statutory.epfEmployer)}
                    <span className="block text-xs text-[#6F6565]">
                      incl. pension {money(register.totals.statutory.epsWithinEmployer)}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>Employee state insurance</td>
                  <td className="text-right tabular-nums">{money(register.totals.statutory.esiEmployee)}</td>
                  <td className="text-right tabular-nums">{money(register.totals.statutory.esiEmployer)}</td>
                </tr>
                <tr>
                  <td>Professional tax</td>
                  <td className="text-right tabular-nums">{money(register.totals.statutory.professionalTax)}</td>
                  <td className="text-right text-[#6F6565]">—</td>
                </tr>
                <tr>
                  <td className="font-semibold text-[#241F20]">Total</td>
                  <td className="text-right font-semibold tabular-nums text-[#241F20]">
                    {money(register.totals.employeeDeductions)}
                  </td>
                  <td className="text-right font-semibold tabular-nums text-[#241F20]">
                    {money(register.totals.employerContributions)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Variance report */}
      {variance && (
        <section className="panel">
          <div className="flex flex-col justify-between gap-3 border-b border-[#E7D8D5] pb-5 sm:flex-row sm:items-end">
            <div>
              <p className="eyebrow">Exceptions review</p>
              <h2 className="section-title">Variance report</h2>
              <p className="mt-2 text-sm text-[#6F6565]">
                {variance.baseline
                  ? `Compared with ${monthName(variance.baseline.periodMonth, variance.baseline.periodYear)} · material at ${variance.thresholdPercent}%`
                  : variance.note}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="status status-danger">{variance.counts.unexplained} unexplained</span>
              <span className="status status-success">{variance.counts.expected} expected</span>
              <span className="status status-warn">{variance.counts.warning} to review</span>
            </div>
          </div>

          {variance.totals.change && (
            <p className="mt-5 text-sm text-[#5F5555]">
              Headcount {variance.totals.change.headcount >= 0 ? '+' : ''}{variance.totals.change.headcount} ·
              gross {variance.totals.change.grossPercent ?? 0}% ·
              net {variance.totals.change.netPercent ?? 0}% ·
              cost to company {variance.totals.change.costToCompanyPercent ?? 0}%
            </p>
          )}

          {variance.flags.length === 0 ? (
            <div className="empty-state">
              <p className="font-semibold text-[#241F20]">No pay changes to review.</p>
              <p className="mt-1 text-sm">Every employee is paid exactly as in the previous period.</p>
            </div>
          ) : (
            <div className="pg-scrollbar mt-5 overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Result</th>
                    <th>Employee</th>
                    <th>Finding</th>
                  </tr>
                </thead>
                <tbody>
                  {variance.flags.map((flag) => (
                    <tr key={`${flag.employeeId}-${flag.code}`}>
                      <td>
                        <div className="flex flex-col items-start gap-1">
                          <span className={`status status-${CLASSIFICATION_TONE[flag.classification] || 'neutral'}`}>
                            {flag.classification}
                          </span>
                          <span className={`status status-${SEVERITY_TONE[flag.severity]}`}>
                            {flag.severity}
                          </span>
                        </div>
                      </td>
                      <td className="font-medium text-[#241F20]">
                        {flag.employeeName}
                        {flag.blocking && (
                          <span className="block text-xs font-semibold text-[#A33D35]">Blocks finalization</span>
                        )}
                      </td>
                      <td>
                        {flag.message}
                        <ChangeBreakdown components={flag.components} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Locked payslips */}
      {snapshots.length > 0 && (
        <section className="panel">
          <p className="eyebrow">Locked records</p>
          <h2 className="section-title">Payslips</h2>

          <div className="pg-scrollbar mt-5 overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th className="text-right">Gross</th>
                  <th className="text-right">Deductions</th>
                  <th className="text-right">Net pay (before TDS)</th>
                  <th className="text-right">Payslip</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((snapshot) => (
                  <tr key={snapshot._id}>
                    <td>
                      <span className="font-semibold text-[#241F20]">
                        {snapshot.employeeSnapshot.fullName}
                      </span>
                      <span className="block text-xs text-[#6F6565]">
                        {snapshot.employeeSnapshot.department}
                      </span>
                    </td>
                    <td className="text-right tabular-nums">{money(snapshot.payrollInputs.grossMonthly)}</td>
                    <td className="text-right tabular-nums">{money(snapshot.payrollResults.totalEmployeeDeductions)}</td>
                    <td className="text-right font-semibold tabular-nums text-[#241F20]">
                      {money(snapshot.payrollResults.netPayBeforeTDS)}
                    </td>
                    <td className="text-right">
                      <Link className="btn btn-small" to={`/snapshots/${snapshot._id}`}>
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Finalize confirmation */}
      {confirmFinalize && (
        <div className="dialog-backdrop">
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="finalize-title"
          >
            <p className="eyebrow">Irreversible</p>
            <h2 id="finalize-title" className="section-title">
              Finalize {monthName(run.periodMonth, run.periodYear)}?
            </h2>
            <p className="mt-3 text-sm leading-6 text-[#5F5555]">
              Payslips for {run.successfulEmployeeCount} employee(s) are written,
              verified and permanently locked. Later corrections must be paid
              as arrears in a future run.
            </p>

            {reviewNeeded && (
              <label className="mt-5 flex items-start gap-3 rounded-[8px] border border-[#EFD8A4] bg-[#FFF8E8] p-3 text-sm text-[#845B00]">
                <input
                  type="checkbox"
                  className="mt-1 accent-[#A6192E]"
                  checked={reviewed}
                  onChange={(event) => setReviewed(event.target.checked)}
                />
                I have reviewed the exceptions in the variance report.
              </label>
            )}

            {readiness?.requiresOverride && (
              <label className="mt-5 block text-sm text-[#A33D35]">
                <span className="font-semibold">
                  Override reason for {readiness.blockingFlags.length} unexplained change(s)
                </span>
                <textarea
                  className="field mt-2 min-h-[90px]"
                  value={overrideReason}
                  onChange={(event) => setOverrideReason(event.target.value)}
                  placeholder="Why these results are correct, and the evidence (e.g. approval ticket)"
                  maxLength={1000}
                />
                <span className="mt-1 block text-xs text-[#6F6565]">
                  Recorded permanently with the run and in the audit trail
                  {overrideValid ? '.' : ` · at least ${OVERRIDE_REASON_MIN} characters`}
                </span>
              </label>
            )}

            <div className="mt-7 flex justify-end gap-3">
              <button type="button" className="btn" onClick={closeFinalizeDialog}>
                Keep reviewing
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={finalizeDisabled}
                onClick={handleFinalize}
              >
                {readiness?.requiresOverride ? 'Override and finalize' : 'Finalize and lock'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
