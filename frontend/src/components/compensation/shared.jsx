/**
 * Shared pieces of the compensation screens.
 */

export const money = (value) =>
  typeof value === 'number'
    ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(value)
    : 'Not available';

export const signedMoney = (value) => `${value > 0 ? '+' : ''}${money(value)}`;

export const COMPONENT_TYPE_LABELS = {
  EARNING: 'Earning',
  DEDUCTION: 'Deduction',
  EMPLOYER_CONTRIBUTION: 'Employer contribution',
  BENEFIT: 'Benefit',
};

export const METHOD_LABELS = {
  FIXED_AMOUNT: 'Fixed amount',
  PERCENT_OF_BASIC: '% of basic',
  PERCENT_OF_GROSS: '% of gross',
  PERCENT_OF_COMPONENT: '% of a component',
  FORMULA: 'Formula',
  STATUTORY: 'Statutory',
};

export const CHANGE_STATUS_TONE = {
  PROPOSED: 'neutral',
  SUBMITTED: 'warn',
  SCHEDULED: 'info',
  EFFECTIVE: 'success',
  REJECTED: 'danger',
  CANCELLED: 'neutral',
};

export const CHANGE_STATUS_LABELS = {
  PROPOSED: 'Draft',
  SUBMITTED: 'Awaiting approval',
  SCHEDULED: 'Scheduled',
  EFFECTIVE: 'In effect',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};

/** Payroll honesty label: what payroll actually does with a component. */
export const PAYROLL_APPLICATION_LABELS = {
  GROSS_INPUT: 'Paid in payroll',
  STATUTORY_ENGINE: 'Calculated by statutory rules',
  NET_DEDUCTION: 'Deducted from net pay',
  EMPLOYER_COST: 'Paid by the employer',
  NOT_APPLIED_YET: 'Not paid by payroll yet',
};

export function ChangeStatus({ status }) {
  return (
    <span className={`status status-${CHANGE_STATUS_TONE[status] || 'neutral'}`}>
      {CHANGE_STATUS_LABELS[status] || status}
    </span>
  );
}

/** before → after with the difference, the way a reviewer reads it. */
export function ImpactRow({ label, amount, note }) {
  if (!amount) return null;
  const tone = amount.delta > 0 ? 'text-[#A33D35]' : amount.delta < 0 ? 'text-[#26765F]' : 'text-[#6F6565]';
  return (
    <tr>
      <td>
        {label}
        {note && <span className="block text-xs text-[#6F6565]">{note}</span>}
      </td>
      <td className="text-right tabular-nums">{money(amount.before)}</td>
      <td className="text-right tabular-nums font-semibold text-[#241F20]">{money(amount.after)}</td>
      <td className={`text-right tabular-nums font-semibold ${tone}`}>{signedMoney(amount.delta)}</td>
    </tr>
  );
}

/** The financial impact of a proposed change, as money and as warnings. */
export function ImpactSummary({ impact, compact = false }) {
  if (!impact) return null;
  return (
    <div className={compact ? '' : 'mt-5'}>
      <div className="pg-scrollbar overflow-x-auto">
        <table className="data-table" aria-label="Financial impact">
          <thead>
            <tr>
              <th>Per month</th>
              <th className="text-right">Now</th>
              <th className="text-right">After</th>
              <th className="text-right">Change</th>
            </tr>
          </thead>
          <tbody>
            <ImpactRow label="Gross pay" amount={impact.monthlyGross} />
            <ImpactRow label="Employee deductions" amount={impact.monthlyEmployeeDeductions} note="Statutory deductions payroll applies" />
            <ImpactRow label="Net pay" amount={impact.monthlyNetPayBeforeTds} note="Before income tax, which is not calculated yet" />
            <ImpactRow label="Employer contributions" amount={impact.monthlyEmployerContributions} />
            <ImpactRow label="Cost to company" amount={impact.monthlyCtc} />
          </tbody>
          <tfoot>
            <tr>
              <td className="font-semibold text-[#241F20]">
                Annual cost to company
                {impact.annualCtcChangePercent != null && (
                  <span className="block text-xs text-[#6F6565]">{impact.annualCtcChangePercent}% change</span>
                )}
              </td>
              <td className="text-right tabular-nums">{money(impact.annualCtc.before)}</td>
              <td className="text-right font-semibold tabular-nums text-[#241F20]">{money(impact.annualCtc.after)}</td>
              <td className={`text-right font-semibold tabular-nums ${impact.annualCtc.delta > 0 ? 'text-[#A33D35]' : 'text-[#26765F]'}`}>
                {signedMoney(impact.annualCtc.delta)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {impact.affectedPeriod && (
        <p className="mt-3 text-sm text-[#5F5555]">
          First affects payroll for {String(impact.affectedPeriod.periodMonth).padStart(2, '0')}/{impact.affectedPeriod.periodYear}
          {impact.affectedPeriod.alreadyFinalized
            ? ' — that period is already finalized, so the difference has to be paid as arrears.'
            : ` (run status: ${impact.affectedPeriod.runStatus.toLowerCase().replace(/_/g, ' ')}).`}
        </p>
      )}

      {impact.notes?.length > 0 && (
        <ul className="mt-3 space-y-2">
          {impact.notes.map((note) => (
            <li key={note.code} className="alert alert-warn">{note.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
