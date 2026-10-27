import { useCallback, useEffect, useState } from 'react';
import * as compensationService from '../../services/compensationService';
import * as companyService from '../../services/companyService';
import { can } from '../../utils/permissions';
import ProposeChangeDialog from '../compensation/ProposeChangeDialog';
import {
  ChangeStatus,
  COMPONENT_TYPE_LABELS,
  ImpactSummary,
  METHOD_LABELS,
  PAYROLL_APPLICATION_LABELS,
  money,
} from '../compensation/shared';
import { Dialog, Rows, SectionHeader, apiError, formatDate } from './shared';

/**
 * Compensation for one employee: what it costs, what each component is, how
 * each amount was derived, what is scheduled, and which changes are in flight.
 */
export default function CompensationSection({ employeeId, user, onChanged }) {
  const canPropose = can(user, 'compensation.propose');
  const canApprove = can(user, 'compensation.approve');

  const [compensation, setCompensation] = useState(null);
  const [changes, setChanges] = useState([]);
  const [components, setComponents] = useState([]);
  const [approvalMode, setApprovalMode] = useState('single');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [proposing, setProposing] = useState(false);
  const [rejecting, setRejecting] = useState(null);
  const [expanded, setExpanded] = useState(null);

  const load = useCallback(async () => {
    try {
      const [compensationResult, changesResult] = await Promise.all([
        compensationService.getCompensation(employeeId),
        compensationService.getEmployeeChanges(employeeId),
      ]);
      setCompensation(compensationResult.data);
      setChanges(changesResult.data.changes);
      setError('');
    } catch (err) {
      setError(apiError(err, 'Unable to load compensation.').message);
    }
  }, [employeeId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!canPropose) return;
    compensationService.getComponents().then((result) => setComponents(result.data.components)).catch(() => setComponents([]));
    companyService.getCompany()
      .then((result) => setApprovalMode(result.data?.company?.settings?.compensationApprovalMode || 'single'))
      .catch(() => setApprovalMode('single'));
  }, [canPropose]);

  const act = async (action, changeId, argument) => {
    setError('');
    setNotice('');
    try {
      const result = await action(changeId, argument);
      setNotice(result.message || 'Done.');
      setRejecting(null);
      await load();
      onChanged();
    } catch (err) {
      setError(apiError(err, 'The action could not be completed.').message);
    }
  };

  const current = compensation?.current;
  const open = changes.filter((change) => ['PROPOSED', 'SUBMITTED', 'SCHEDULED'].includes(change.status));
  const decided = changes.filter((change) => !['PROPOSED', 'SUBMITTED', 'SCHEDULED'].includes(change.status));

  return (
    <section className="panel" aria-labelledby="compensation-title">
      <SectionHeader
        eyebrow="Compensation"
        title="Pay and cost to company"
        id="compensation-title"
        subtitle="Effective-dated. Cost to company is gross plus employer contributions; net pay is gross less deductions."
      >
        {canPropose && (
          <button type="button" className="btn btn-primary" onClick={() => setProposing(true)}>
            Propose a change
          </button>
        )}
      </SectionHeader>

      {error && <div className="alert alert-danger mt-5" role="alert">{error}</div>}
      {notice && <div className="alert alert-success mt-5" role="status">{notice}</div>}

      {compensation && !current && (
        <div className="empty-state">
          <p className="font-semibold text-ink">No compensation recorded.</p>
          <p className="mt-1 text-sm text-ink-2">Payroll blocks this employee until pay is recorded.</p>
        </div>
      )}

      {current && (
        <>
          <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5">
            {[
              ['Monthly gross', money(current.totals.monthlyGross), 'Recurring earnings'],
              ['Monthly cost to company', money(current.totals.monthlyCtc), 'Gross + employer contributions'],
              ['Annual cost to company', money(current.totals.annualCtc), 'Including one-time pay'],
              ['Net pay (estimate)', money(current.statutoryEstimate?.netPayBeforeTds), 'Before income tax'],
            ].map(([label, value, note]) => (
              <div key={label} className="min-w-0">
                <p className="text-[12.5px] font-medium text-ink-2">{label}</p>
                <p className="mt-1.5 break-words text-[19px] font-medium leading-tight tabular-nums text-ink">{value}</p>
                <p className="mt-1 text-xs text-ink-2">{note}</p>
              </div>
            ))}
          </div>

          <p className="mt-4 text-sm text-ink-2">
            Version {current.version} · effective {formatDate(current.effectiveFrom)} · recorded by {current.recordedByEmail || 'system'}
            {current.reason && ` · ${current.reason}`}
          </p>

          <div tabIndex={0} className="pg-scrollbar mt-5 overflow-x-auto">
            <table className="data-table" aria-label="Compensation components">
              <thead>
                <tr>
                  <th>Component</th>
                  <th>Type</th>
                  <th>How the amount was calculated</th>
                  <th className="text-right">Monthly</th>
                </tr>
              </thead>
              <tbody>
                {current.lines.map((line) => (
                  <tr key={line.componentCode}>
                    <td>
                      <span className="font-semibold text-ink">{line.name}</span>
                      <span className="block text-xs text-ink-2">
                        {[
                          line.treatments.pfWage === 'INCLUDED' && 'PF wage',
                          line.treatments.esiWage === 'INCLUDED' && 'ESI wage',
                          line.treatments.ptWage === 'INCLUDED' && 'PT wage',
                          line.treatments.ctc === 'INCLUDED' ? 'in CTC' : 'outside CTC',
                          line.treatments.taxable === 'PARTIALLY_EXEMPT' ? 'partly exempt' : line.treatments.taxable === 'EXEMPT' ? 'exempt' : 'taxable',
                        ].filter(Boolean).join(' · ')}
                      </span>
                    </td>
                    <td>
                      {COMPONENT_TYPE_LABELS[line.type]}
                      <span className={`mt-1 block text-xs ${line.payrollApplication === 'NOT_APPLIED_YET' ? 'text-warn' : 'text-ink-2'}`}>
                        {PAYROLL_APPLICATION_LABELS[line.payrollApplication]}
                      </span>
                    </td>
                    <td className="text-sm">
                      {line.lineage.explanation}
                      <span className="block text-xs text-ink-2">{METHOD_LABELS[line.calculationMethod]}</span>
                    </td>
                    <td className="text-right font-semibold tabular-nums text-ink">{money(line.amountMonthly)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {current.statutoryEstimate && (
            <div className="mt-5 rounded-[10px] border border-line bg-canvas-2 p-4 text-sm text-ink-2">
              <p className="font-semibold text-ink">Statutory estimate</p>
              <p className="mt-1">
                Provident fund {money(current.statutoryEstimate.employeePf)} employee · {money(current.statutoryEstimate.employerPf)} employer
                (PF wage {money(current.pfWageBase)}) · ESI {money(current.statutoryEstimate.employeeEsi)} employee ·
                {' '}{money(current.statutoryEstimate.employerEsi)} employer · professional tax {money(current.statutoryEstimate.professionalTax)}.
              </p>
              <p className="mt-2 text-xs">
                Calculated from the rule versions in force on {formatDate(current.effectiveFrom)}. Payroll recalculates these for each run and
                freezes the rule versions it used, so a payslip never depends on this estimate.
              </p>
            </div>
          )}

          {current.notApplied?.length > 0 && (
            <div className="alert alert-warn mt-4">
              {current.notApplied.map((line) => line.name).join(', ')} count towards cost to company, but payroll does not pay or deduct them yet.
            </div>
          )}
        </>
      )}

      {compensation?.scheduled?.length > 0 && (
        <div className="alert alert-warn mt-5">
          Scheduled: monthly gross becomes {money(compensation.scheduled[0].totals.monthlyGross)} on {formatDate(compensation.scheduled[0].effectiveFrom)}.
        </div>
      )}

      {(open.length > 0 || decided.length > 0) && (
        <div className="mt-7">
          <p className="eyebrow">Change workflow</p>
          <div tabIndex={0} className="pg-scrollbar mt-3 overflow-x-auto">
            <table className="data-table" aria-label="Compensation changes">
              <thead>
                <tr>
                  <th>Effective</th>
                  <th>Status</th>
                  <th>Reason</th>
                  <th className="text-right">Annual cost to company</th>
                  <th className="text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {[...open, ...decided].map((change) => (
                  <tr key={change.id}>
                    <td className="whitespace-nowrap">
                      {formatDate(change.effectiveFrom)}
                      <span className="block text-xs text-ink-2">by {change.proposedByEmail}</span>
                    </td>
                    <td><ChangeStatus status={change.status} /></td>
                    <td className="text-sm">
                      {change.reason}
                      {change.decisionNote && <span className="block text-xs text-ink-2">Note: {change.decisionNote}</span>}
                      <button type="button" className="mt-1 text-xs font-semibold text-crimson" onClick={() => setExpanded(expanded === change.id ? null : change.id)}>
                        {expanded === change.id ? 'Hide impact' : 'Show impact'}
                      </button>
                      {expanded === change.id && <ImpactSummary impact={change.impactAtApproval || change.impact} compact />}
                    </td>
                    <td className="text-right tabular-nums">
                      {money((change.impactAtApproval || change.impact)?.annualCtc?.after)}
                    </td>
                    <td className="text-right">
                      <div className="flex flex-wrap justify-end gap-2">
                        {change.status === 'PROPOSED' && canPropose && (
                          <button type="button" className="btn btn-small" onClick={() => act(compensationService.submitChange, change.id)}>
                            Send for approval
                          </button>
                        )}
                        {change.status === 'PROPOSED' && canPropose && (
                          <button type="button" className="btn btn-small" onClick={() => act(compensationService.cancelChange, change.id)}>
                            Cancel
                          </button>
                        )}
                        {change.status === 'SUBMITTED' && canApprove && (
                          <>
                            <button type="button" className="btn btn-small" onClick={() => act(compensationService.approveChange, change.id)}>
                              Approve
                            </button>
                            <button type="button" className="btn btn-small" onClick={() => setRejecting(change)}>
                              Reject
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {compensation?.history?.length > 1 && (
        <div tabIndex={0} className="pg-scrollbar mt-7 overflow-x-auto">
          <table className="data-table" aria-label="Compensation history">
            <thead>
              <tr>
                <th>Effective period</th>
                <th>Monthly gross</th>
                <th>Annual cost to company</th>
                <th>Recorded</th>
              </tr>
            </thead>
            <tbody>
              {compensation.history.map((version) => (
                <tr key={version.id}>
                  <td>
                    {formatDate(version.effectiveFrom)} → {version.effectiveTo ? formatDate(version.effectiveTo) : 'Current'}
                  </td>
                  <td className="tabular-nums">{money(version.totals.monthlyGross)}</td>
                  <td className="tabular-nums">{money(version.totals.annualCtc)}</td>
                  <td className="text-xs text-ink-2">
                    {version.recordedByEmail || 'system'}
                    <span className="block">{version.source === 'CHANGE_REQUEST' ? 'Approved change' : version.source === 'MIGRATION' ? 'Recorded by migration' : 'Direct revision'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {proposing && (
        <ProposeChangeDialog
          employeeId={employeeId}
          current={current}
          components={components}
          workState={current?.workState}
          canApprove={canApprove}
          approvalMode={approvalMode}
          onClose={() => setProposing(false)}
          onDone={(outcome) => {
            setProposing(false);
            setNotice(outcome === 'applied' ? 'Compensation change applied.' : 'Compensation change sent for approval.');
            load();
            onChanged();
          }}
        />
      )}

      {rejecting && (
        <RejectDialog
          change={rejecting}
          onClose={() => setRejecting(null)}
          onReject={(note) => act(compensationService.rejectChange, rejecting.id, note)}
        />
      )}
    </section>
  );
}

function RejectDialog({ change, onClose, onReject }) {
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  return (
    <Dialog
      eyebrow="Decision"
      title="Reject this pay change"
      onClose={onClose}
      onSubmit={async () => {
        setSaving(true);
        await onReject(note.trim());
        setSaving(false);
      }}
      submitLabel="Reject change"
      submitting={saving}
      submitDisabled={note.trim().length < 5}
    >
      <p className="mt-3 text-sm text-ink-2">Effective {formatDate(change.effectiveFrom)} · {change.reason}</p>
      <label className="label mt-5 block">
        Why is it rejected?
        <textarea className="field mt-2 min-h-[80px]" maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
    </Dialog>
  );
}
