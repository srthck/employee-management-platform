/**
 * Small building blocks shared by the Employee 360 sections.
 */

// Dates are stored as UTC midnight; format them in UTC so a date never shifts.
export const formatDate = (value) =>
  value ? new Date(value).toLocaleDateString('en-IN', { timeZone: 'UTC' }) : 'Not available';

export const todayInput = () => new Date().toISOString().slice(0, 10);

export const monthLabel = (year, month) =>
  new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export const DEPARTMENTS = [
  'Engineering', 'Marketing', 'Sales', 'Human Resources', 'Finance',
  'Operations', 'Design', 'Legal', 'Customer Support', 'Other',
];

/** Message plus per-field errors from an API failure. */
export function apiError(err, fallback) {
  const body = err?.response?.data;
  return {
    message: body?.message && body.message !== 'Validation failed' ? body.message : body?.errors?.length ? 'Check the highlighted fields.' : fallback,
    fields: Object.fromEntries((body?.errors || []).map((e) => [e.field, e.message])),
  };
}

const READINESS = {
  READY: { tone: 'success', label: 'Ready for payroll' },
  WARNING: { tone: 'warn', label: 'Needs attention' },
  BLOCKED: { tone: 'danger', label: 'Blocked from payroll' },
};

export function ReadinessBadge({ state, title }) {
  const meta = READINESS[state];
  if (!meta) return <span className="status status-neutral">Not in payroll</span>;
  return (
    <span className={`status status-${meta.tone}`} title={title}>
      {meta.label}
    </span>
  );
}

export function Rows({ rows }) {
  return (
    <dl className="mt-5 divide-y divide-[#E7D8D5] text-sm">
      {rows.map(([label, value, action]) => (
        <div key={label} className="flex items-center justify-between gap-4 py-3">
          <dt className="text-[#6F6565]">{label}</dt>
          <dd className="flex items-center gap-3 text-right font-medium text-[#241F20]">
            <span>{value || 'Not available'}</span>
            {action}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function FieldError({ message }) {
  return message ? <span className="mt-1 block text-xs font-medium text-[#9B1C31]">{message}</span> : null;
}

export function SectionHeader({ eyebrow, title, id, subtitle, children }) {
  return (
    <div className="flex flex-col justify-between gap-4 border-b border-[#E7D8D5] pb-5 sm:flex-row sm:items-end">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2 id={id} className="section-title">{title}</h2>
        {subtitle && <p className="mt-2 text-sm text-[#6F6565]">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}

/** Form dialog with the app's dialog styling. */
export function Dialog({ eyebrow, title, children, onClose, onSubmit, submitLabel, submitting, submitDisabled, wide }) {
  return (
    <div className="dialog-backdrop">
      <form
        className={`dialog ${wide ? 'max-w-2xl' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="flex items-start justify-between">
          <div>
            <p className="eyebrow">{eyebrow}</p>
            <h2 className="section-title">{title}</h2>
          </div>
          <button type="button" className="icon-button text-[#A6192E]" aria-label="Close dialog" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
        <div className="mt-7 flex justify-end gap-3">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={submitting || submitDisabled}>
            {submitting ? 'Saving...' : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
