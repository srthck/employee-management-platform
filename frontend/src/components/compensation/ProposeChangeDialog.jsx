import { useState } from 'react';
import * as compensationService from '../../services/compensationService';
import { Dialog, FieldError, apiError, todayInput } from '../employee360/shared';
import { COMPONENT_TYPE_LABELS, ImpactSummary, METHOD_LABELS, money } from './shared';

const EDITABLE_METHODS = ['FIXED_AMOUNT', 'PERCENT_OF_BASIC', 'PERCENT_OF_GROSS', 'PERCENT_OF_COMPONENT'];

const emptyLine = (componentCode = '') => ({
  componentCode,
  calculationMethod: 'FIXED_AMOUNT',
  amount: '',
  percentage: '',
  ofComponentCode: '',
});

const lineFromVersion = (line) => ({
  componentCode: line.componentCode,
  calculationMethod: EDITABLE_METHODS.includes(line.calculationMethod) ? line.calculationMethod : 'FIXED_AMOUNT',
  amount: line.calculationMethod === 'FIXED_AMOUNT' ? String(line.basis?.amount ?? line.amountMonthly ?? '') : '',
  percentage: line.basis?.percentage != null ? String(line.basis.percentage) : '',
  ofComponentCode: line.basis?.ofComponentCode || '',
  formula: line.calculationMethod === 'FORMULA' ? line.basis?.formula : null,
  fixedFromFormula: line.calculationMethod === 'FORMULA',
});

/**
 * Propose a pay change: choose the components, see what it costs, then send it
 * for approval (or apply it, when the company does not require a second person).
 */
export default function ProposeChangeDialog({
  employeeId, current, components, workState, canApprove, approvalMode, onClose, onDone,
}) {
  const [lines, setLines] = useState(
    current?.lines?.length ? current.lines.map(lineFromVersion) : [emptyLine('BASIC')]
  );
  const [effectiveFrom, setEffectiveFrom] = useState(todayInput());
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const assignable = components.filter((component) => !component.statutory && !component.isArchived);
  const used = new Set(lines.map((line) => line.componentCode).filter(Boolean));
  const appliesInPayroll = (code) => assignable.find((component) => component.code === code)?.payrollApplication !== 'NOT_APPLIED_YET';

  const update = (index, patch) => {
    setPreview(null);
    setLines((previous) => previous.map((line, position) => (position === index ? { ...line, ...patch } : line)));
  };
  const removeLine = (index) => {
    setPreview(null);
    setLines((previous) => previous.filter((_, position) => position !== index));
  };

  const payload = () => ({
    effectiveFrom,
    workState: workState || undefined,
    lines: lines
      .filter((line) => line.componentCode)
      .map((line) => {
        if (line.fixedFromFormula) {
          return { componentCode: line.componentCode, calculationMethod: 'FORMULA', basis: { formula: line.formula } };
        }
        const basis = {};
        if (line.calculationMethod === 'FIXED_AMOUNT') basis.amount = Number(line.amount || 0);
        else basis.percentage = Number(line.percentage || 0);
        if (line.calculationMethod === 'PERCENT_OF_COMPONENT') basis.ofComponentCode = line.ofComponentCode;
        return { componentCode: line.componentCode, calculationMethod: line.calculationMethod, basis };
      }),
  });

  const runPreview = async () => {
    setPreviewing(true);
    setError(null);
    try {
      const result = await compensationService.previewImpact(employeeId, payload());
      setPreview(result.data);
    } catch (err) {
      setError(apiError(err, 'The impact could not be calculated.'));
    } finally {
      setPreviewing(false);
    }
  };

  const applyDirectly = canApprove && approvalMode === 'single';

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const proposal = await compensationService.proposeChange(employeeId, { ...payload(), reason: reason.trim() });
      const changeId = proposal.data.change.id;
      // The button says what happens: the change is sent for approval, and
      // approved straight away when this company does not need a second person.
      await compensationService.submitChange(changeId);
      if (applyDirectly) await compensationService.approveChange(changeId);
      onDone(applyDirectly ? 'applied' : 'proposed');
    } catch (err) {
      setError(apiError(err, 'The change could not be saved.'));
      setSaving(false);
    }
  };

  const fieldError = (code) => error?.fields?.[code] || error?.fields?.[`${code}.amount`] || error?.fields?.[`${code}.percentage`];

  return (
    <Dialog
      eyebrow="Compensation change"
      title="Propose a pay change"
      onClose={onClose}
      onSubmit={submit}
      submitLabel={applyDirectly ? 'Apply change' : 'Send for approval'}
      submitting={saving}
      submitDisabled={reason.trim().length < 5}
      wide
    >
      <p className="mt-3 text-sm leading-6 text-ink-2">
        {applyDirectly
          ? 'This company does not require a second approver, so this change applies as soon as you save it.'
          : 'The change is recorded and waits for an approver. Nobody is paid differently until it is approved.'}
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <label className="label">
          Effective from
          <input type="date" className="field mt-2" value={effectiveFrom} onChange={(event) => { setEffectiveFrom(event.target.value); setPreview(null); }} required />
          <FieldError message={error?.fields?.effectiveFrom} />
        </label>
        <label className="label">
          Reason (recorded with the change)
          <input className="field mt-2" maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="For example: annual review, promotion to senior engineer" />
          <FieldError message={error?.fields?.reason} />
        </label>
      </div>

      <div tabIndex={0} className="pg-scrollbar mt-6 overflow-x-auto">
        <table className="data-table" aria-label="Proposed components">
          <thead>
            <tr>
              <th>Component</th>
              <th>How it is calculated</th>
              <th>Value</th>
              <th className="text-right">Remove</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={`${line.componentCode}-${index}`}>
                <td>
                  <select
                    className="field"
                    aria-label={`Component ${index + 1}`}
                    value={line.componentCode}
                    onChange={(event) => update(index, { componentCode: event.target.value })}
                  >
                    <option value="">Choose a component</option>
                    {assignable
                      .filter((component) => component.code === line.componentCode || !used.has(component.code))
                      .map((component) => (
                        <option key={component.code} value={component.code}>
                          {component.name} · {COMPONENT_TYPE_LABELS[component.type]}
                        </option>
                      ))}
                  </select>
                  {line.componentCode && !appliesInPayroll(line.componentCode) && (
                    <span className="mt-1 block text-xs text-warn">Counted in CTC; payroll does not pay or deduct it yet.</span>
                  )}
                  <FieldError message={fieldError(line.componentCode)} />
                </td>
                <td>
                  {line.fixedFromFormula ? (
                    <span className="text-xs text-ink-2">Formula (kept as recorded)</span>
                  ) : (
                    <select
                      className="field"
                      aria-label={`Calculation for ${line.componentCode || index + 1}`}
                      value={line.calculationMethod}
                      onChange={(event) => update(index, { calculationMethod: event.target.value })}
                    >
                      {EDITABLE_METHODS.map((method) => <option key={method} value={method}>{METHOD_LABELS[method]}</option>)}
                    </select>
                  )}
                </td>
                <td>
                  {line.fixedFromFormula ? (
                    <span className="text-xs text-ink-2">Recalculated from the formula</span>
                  ) : line.calculationMethod === 'FIXED_AMOUNT' ? (
                    <input
                      type="number" min="0" step="0.01" className="field" aria-label={`Amount for ${line.componentCode || index + 1}`}
                      value={line.amount} onChange={(event) => update(index, { amount: event.target.value })}
                    />
                  ) : (
                    <div className="flex gap-2">
                      <input
                        type="number" min="0" max="100" step="0.01" className="field" aria-label={`Percentage for ${line.componentCode || index + 1}`}
                        value={line.percentage} onChange={(event) => update(index, { percentage: event.target.value })}
                      />
                      {line.calculationMethod === 'PERCENT_OF_COMPONENT' && (
                        <select
                          className="field" aria-label={`Percentage of which component for ${line.componentCode || index + 1}`}
                          value={line.ofComponentCode} onChange={(event) => update(index, { ofComponentCode: event.target.value })}
                        >
                          <option value="">of…</option>
                          {lines
                            .filter((other) => other.componentCode && other.componentCode !== line.componentCode)
                            .map((other) => <option key={other.componentCode} value={other.componentCode}>{other.componentCode}</option>)}
                        </select>
                      )}
                    </div>
                  )}
                </td>
                <td className="text-right">
                  <button type="button" className="btn btn-small" onClick={() => removeLine(index)} aria-label={`Remove ${line.componentCode || `component ${index + 1}`}`}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <button type="button" className="btn btn-small mt-3" onClick={() => setLines((previous) => [...previous, emptyLine()])}>
        Add component
      </button>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button type="button" className="btn" onClick={runPreview} disabled={previewing}>
          {previewing ? 'Calculating...' : 'Preview impact'}
        </button>
        {preview && (
          <span className="text-sm text-ink-2">
            New monthly gross {money(preview.proposed.totals.monthlyGross)} · annual cost to company {money(preview.proposed.totals.annualCtc)}
          </span>
        )}
      </div>

      {preview && <ImpactSummary impact={preview.impact} />}

      {error?.message && <div className="alert alert-danger mt-4" role="alert">{error.message}</div>}
    </Dialog>
  );
}
