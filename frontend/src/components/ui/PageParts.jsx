import Icon from './Icon';

/** Consistent page header: eyebrow, title, one-line purpose, actions on the right. */
export function PageHeader({ eyebrow, title, subtitle, actions, children }) {
  return (
    <header className="page-header">
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
        {children}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  );
}

/**
 * Explains why something is empty and what (if anything) can be done.
 * `kind` picks the icon: none (no data yet), blocked (setup incomplete), error.
 */
export function EmptyState({ title, children, action, kind = 'none' }) {
  const icon = kind === 'error' ? 'x-circle' : kind === 'blocked' ? 'alert-triangle' : 'info';
  return (
    <div className="flex flex-col items-center px-4 py-10 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full border border-[var(--pg-glass-line)] bg-[var(--pg-glass)] text-ink-2">
        <Icon name={icon} size={20} />
      </span>
      <p className="mt-3 text-[15px] font-semibold text-ink">{title}</p>
      {children && <div className="mt-1 max-w-[46ch] text-sm leading-6 text-ink-2">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Loading placeholder with a polite live region. */
export function LoadingState({ label = 'Loading…', rows = 3 }) {
  return (
    <div role="status" aria-live="polite" className="space-y-3 py-2">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton h-4" style={{ width: `${88 - i * 14}%` }} aria-hidden="true" />
      ))}
    </div>
  );
}

/** A labelled figure. Numbers use tabular figures so columns of figures align. */
export function Figure({ label, value, note, emphasis = false }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12.5px] font-medium text-ink-2">{label}</dt>
      <dd className={`tabular mt-1 font-semibold tracking-[-0.02em] text-ink ${emphasis ? 'text-[30px] leading-none' : 'text-[22px] leading-tight'}`}>
        {value}
      </dd>
      {note && <dd className="mt-1 text-xs leading-5 text-ink-2">{note}</dd>}
    </div>
  );
}
