import { useCallback, useContext, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AuthContext } from '../contexts/AuthContext';
import * as compensationService from '../services/compensationService';
import * as employeeService from '../services/employeeService';
import { can } from '../utils/permissions';
import { Dialog, FieldError, SectionHeader, apiError, formatDate } from '../components/employee360/shared';
import {
  ChangeStatus,
  COMPONENT_TYPE_LABELS,
  ImpactSummary,
  METHOD_LABELS,
  PAYROLL_APPLICATION_LABELS,
  money,
} from '../components/compensation/shared';

/**
 * Compensation control plane: pay changes waiting for a decision, and the
 * component catalogue that defines what each component means.
 */
export default function Compensation() {
  const { user } = useContext(AuthContext);
  const canApprove = can(user, 'compensation.approve');
  const canPropose = can(user, 'compensation.propose');
  const canManageComponents = can(user, 'compensation.component.manage');

  const [changes, setChanges] = useState([]);
  const [components, setComponents] = useState([]);
  const [employees, setEmployees] = useState(new Map());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const [addingComponent, setAddingComponent] = useState(false);

  const load = useCallback(async () => {
    try {
      const [changesResult, componentsResult, employeesResult] = await Promise.all([
        compensationService.getChanges({ limit: 100 }),
        compensationService.getComponents(),
        employeeService.getEmployees({ limit: 100 }),
      ]);
      setChanges(changesResult.data.changes);
      setComponents(componentsResult.data.components);
      setEmployees(new Map((employeesResult.data?.employees || []).map((employee) => [employee._id, employee])));
      setError('');
    } catch (err) {
      setError(apiError(err, 'Unable to load compensation.').message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const act = async (action, id, argument) => {
    setError('');
    setNotice('');
    try {
      const result = await action(id, argument);
      setNotice(result.message || 'Done.');
      setRejecting(null);
      await load();
    } catch (err) {
      setError(apiError(err, 'The action could not be completed.').message);
    }
  };

  const nameOf = (employeeId) => {
    const employee = employees.get(employeeId);
    return employee ? `${employee.firstName} ${employee.lastName}` : employeeId;
  };

  const waiting = changes.filter((change) => change.status === 'SUBMITTED');
  const scheduled = changes.filter((change) => change.status === 'SCHEDULED');
  const rest = changes.filter((change) => !['SUBMITTED', 'SCHEDULED'].includes(change.status));

  const changeRow = (change) => (
    <tr key={change.id}>
      <td>
        <Link to={`/employees/${change.employeeId}`} className="font-semibold text-crimson hover:underline">
          {nameOf(change.employeeId)}
        </Link>
        <span className="block text-xs text-ink-2">proposed by {change.proposedByEmail}</span>
      </td>
      <td className="whitespace-nowrap">{formatDate(change.effectiveFrom)}</td>
      <td><ChangeStatus status={change.status} /></td>
      <td className="text-sm">
        {change.reason}
        {change.decisionNote && <span className="block text-xs text-ink-2">Note: {change.decisionNote}</span>}
        <button type="button" className="mt-1 block text-xs font-semibold text-crimson hover:text-crimson-strong" onClick={() => setExpanded(expanded === change.id ? null : change.id)}>
          {expanded === change.id ? 'Hide impact' : 'Show impact'}
        </button>
        {expanded === change.id && <ImpactSummary impact={change.impactAtApproval || change.impact} compact />}
      </td>
      <td className="text-right tabular-nums">
        {money((change.impactAtApproval || change.impact)?.annualCtc?.after)}
        {(change.impactAtApproval || change.impact)?.annualCtc?.delta != null && (
          <span className="block text-xs text-ink-2">
            {(change.impactAtApproval || change.impact).annualCtc.delta > 0 ? '+' : ''}
            {money((change.impactAtApproval || change.impact).annualCtc.delta)} a year
          </span>
        )}
      </td>
      <td className="text-right">
        <div className="flex flex-wrap justify-end gap-2">
          {change.status === 'PROPOSED' && canPropose && (
            <button type="button" className="btn btn-small" onClick={() => act(compensationService.submitChange, change.id)}>
              Send for approval
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
  );

  const table = (rows, label) => (
    <div tabIndex={0} className="pg-scrollbar mt-5 overflow-x-auto">
      <table className="data-table" aria-label={label}>
        <thead>
          <tr>
            <th>Employee</th>
            <th>Effective</th>
            <th>Status</th>
            <th>Reason</th>
            <th className="text-right">Annual cost to company</th>
            <th className="text-right">Action</th>
          </tr>
        </thead>
        <tbody>{rows.map(changeRow)}</tbody>
      </table>
    </div>
  );

  return (
    <div className="space-y-8">
      <div>
        <p className="eyebrow">Compensation control plane</p>
        <h1 className="page-title text-ink">Compensation</h1>
        <p className="page-subtitle text-ink-2">
          Pay changes and the components they are built from. Every change carries its cost, its approver and its effective date.
        </p>
      </div>

      {error && <div className="alert alert-danger" role="alert">{error}</div>}
      {notice && <div className="alert alert-success" role="status">{notice}</div>}

      <section className="panel" aria-labelledby="awaiting-title">
        <SectionHeader
          eyebrow="Decisions"
          title="Waiting for approval"
          id="awaiting-title"
          subtitle="Nobody is paid differently until a change here is approved."
        />
        {waiting.length === 0 ? (
          <div className="empty-state">
            <p className="font-semibold text-ink">Nothing is waiting for a decision.</p>
          </div>
        ) : table(waiting, 'Changes waiting for approval')}
      </section>

      {scheduled.length > 0 && (
        <section className="panel" aria-labelledby="scheduled-title">
          <SectionHeader
            eyebrow="Approved"
            title="Scheduled for a future date"
            id="scheduled-title"
            subtitle="Approved and already recorded; payroll uses them from their effective date."
          />
          {table(scheduled, 'Scheduled changes')}
        </section>
      )}

      {rest.length > 0 && (
        <section className="panel" aria-labelledby="history-title">
          <SectionHeader eyebrow="History" title="Decided changes" id="history-title" />
          {table(rest, 'Decided changes')}
        </section>
      )}

      <section className="panel" aria-labelledby="components-title">
        <SectionHeader
          eyebrow="Catalogue"
          title="Pay components"
          id="components-title"
          subtitle="What each component is and how payroll concepts treat it. Statutory amounts always come from versioned compliance rules."
        >
          {canManageComponents && (
            <button type="button" className="btn" onClick={() => setAddingComponent(true)}>
              Add component
            </button>
          )}
        </SectionHeader>

        <div tabIndex={0} className="pg-scrollbar mt-5 overflow-x-auto">
          <table className="data-table" aria-label="Pay components">
            <thead>
              <tr>
                <th>Component</th>
                <th>Type</th>
                <th>Default calculation</th>
                <th>Treatment</th>
                <th>In payroll</th>
                <th className="text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {components.map((component) => (
                <tr key={component.code}>
                  <td>
                    <span className="font-semibold text-ink">{component.name}</span>
                    <span className="block font-mono text-xs text-ink-2">{component.code} · v{component.version}</span>
                  </td>
                  <td>{COMPONENT_TYPE_LABELS[component.type]}</td>
                  <td className="text-sm">
                    {METHOD_LABELS[component.calculationMethod]}
                    {component.defaultBasis?.percentage != null && ` · ${component.defaultBasis.percentage}%`}
                  </td>
                  <td className="text-xs text-ink-2">
                    {[
                      component.treatments.pfWage === 'INCLUDED' && 'PF wage',
                      component.treatments.esiWage === 'INCLUDED' && 'ESI wage',
                      component.treatments.ctc === 'INCLUDED' ? 'in CTC' : 'outside CTC',
                    ].filter(Boolean).join(' · ')}
                  </td>
                  <td className={`text-xs ${component.payrollApplication === 'NOT_APPLIED_YET' ? 'text-warn' : 'text-ink-2'}`}>
                    {PAYROLL_APPLICATION_LABELS[component.payrollApplication]}
                  </td>
                  <td className="text-right">
                    {canManageComponents && !component.statutory && (
                      <button type="button" className="btn btn-small" onClick={() => act(compensationService.archiveComponent, component.code)}>
                        Archive
                      </button>
                    )}
                    {component.statutory && <span className="text-xs text-ink-2">System-managed</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {addingComponent && (
        <AddComponentDialog
          onClose={() => setAddingComponent(false)}
          onSaved={() => {
            setAddingComponent(false);
            setNotice('Component added.');
            load();
          }}
        />
      )}

      {rejecting && (
        <RejectDialog
          change={rejecting}
          employeeName={nameOf(rejecting.employeeId)}
          onClose={() => setRejecting(null)}
          onReject={(note) => act(compensationService.rejectChange, rejecting.id, note)}
        />
      )}
    </div>
  );
}

function AddComponentDialog({ onClose, onSaved }) {
  const [form, setForm] = useState({
    code: '', name: '', type: 'EARNING', recurrence: 'RECURRING', calculationMethod: 'FIXED_AMOUNT',
    pfWage: 'EXCLUDED', esiWage: 'INCLUDED', ptWage: 'INCLUDED', ctc: 'INCLUDED', taxable: 'TAXABLE', description: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const update = (event) => setForm((previous) => ({ ...previous, [event.target.name]: event.target.value }));

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await compensationService.createComponent({
        code: form.code.trim().toUpperCase(),
        name: form.name.trim(),
        type: form.type,
        recurrence: form.recurrence,
        calculationMethod: form.calculationMethod,
        description: form.description.trim() || undefined,
        treatments: {
          pfWage: form.pfWage, esiWage: form.esiWage, ptWage: form.ptWage, ctc: form.ctc, taxable: form.taxable,
        },
      });
      onSaved();
    } catch (err) {
      setError(apiError(err, 'The component could not be created.'));
      setSaving(false);
    }
  };

  const select = (name, label, options) => (
    <label className="label">
      {label}
      <select name={name} className="field mt-2" value={form[name]} onChange={update}>
        {options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
      </select>
    </label>
  );

  return (
    <Dialog eyebrow="Catalogue" title="Add a pay component" onClose={onClose} onSubmit={submit} submitLabel="Add component" submitting={saving} wide>
      <p className="mt-3 text-sm leading-6 text-ink-2">
        A component describes what it is and how payroll concepts treat it. Statutory amounts are never defined here.
      </p>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <label className="label">
          Code
          <input name="code" className="field mt-2 font-mono" value={form.code} onChange={update} placeholder="SHIFT_ALLOWANCE" required />
          <FieldError message={error?.fields?.code} />
        </label>
        <label className="label">
          Name
          <input name="name" className="field mt-2" value={form.name} onChange={update} placeholder="Shift allowance" required />
          <FieldError message={error?.fields?.name} />
        </label>
        {select('type', 'Type', Object.entries(COMPONENT_TYPE_LABELS))}
        {select('recurrence', 'Paid', [['RECURRING', 'Every month'], ['ONE_TIME', 'One time']])}
        {select('calculationMethod', 'Default calculation', [
          ['FIXED_AMOUNT', METHOD_LABELS.FIXED_AMOUNT],
          ['PERCENT_OF_BASIC', METHOD_LABELS.PERCENT_OF_BASIC],
          ['PERCENT_OF_GROSS', METHOD_LABELS.PERCENT_OF_GROSS],
          ['PERCENT_OF_COMPONENT', METHOD_LABELS.PERCENT_OF_COMPONENT],
        ])}
        {select('taxable', 'Income tax', [['TAXABLE', 'Taxable'], ['PARTIALLY_EXEMPT', 'Partly exempt'], ['EXEMPT', 'Exempt']])}
        {select('pfWage', 'Part of the PF wage', [['EXCLUDED', 'No'], ['INCLUDED', 'Yes']])}
        {select('esiWage', 'Part of the ESI wage', [['INCLUDED', 'Yes'], ['EXCLUDED', 'No']])}
        {select('ptWage', 'Part of the professional tax wage', [['INCLUDED', 'Yes'], ['EXCLUDED', 'No']])}
        {select('ctc', 'Part of cost to company', [['INCLUDED', 'Yes'], ['EXCLUDED', 'No']])}
      </div>
      <label className="label mt-4 block">
        Description
        <input name="description" className="field mt-2" maxLength={400} value={form.description} onChange={update} />
      </label>
      {error?.message && <div className="alert alert-danger mt-4" role="alert">{error.message}</div>}
    </Dialog>
  );
}

function RejectDialog({ change, employeeName, onClose, onReject }) {
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  return (
    <Dialog
      eyebrow="Decision"
      title={`Reject the change for ${employeeName}`}
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
