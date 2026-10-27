import Icon from './Icon';

/**
 * One vocabulary for every status in the product. Each tone has its own colour,
 * icon AND text, so meaning never depends on colour alone.
 *
 *   verified   positive, restrained: a check that actually ran and passed
 *   attention  action required
 *   failed     failed / error
 *   deferred   out of scope by design: neutral, not alarming, not a success
 *   unknown    not checked or unavailable: never shown as verified
 *   neutral    a plain state (draft, cancelled, read only)
 *   progress   in progress
 */
export const TONES = {
  verified: { cls: 'status-success', icon: 'check-circle' },
  attention: { cls: 'status-warn', icon: 'alert-triangle' },
  failed: { cls: 'status-danger', icon: 'x-circle' },
  deferred: { cls: 'status-deferred', icon: 'pause-circle' },
  unknown: { cls: 'status-unknown', icon: 'help-circle' },
  neutral: { cls: 'status-neutral', icon: null },
  progress: { cls: 'status-info', icon: null },
};

export default function StatusBadge({ tone = 'neutral', children, title }) {
  const t = TONES[tone] || TONES.neutral;
  return (
    <span className={`status ${t.cls}`} title={title}>
      {t.icon ? <Icon name={t.icon} size={14} strokeWidth={2} /> : <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

/** Payroll run statuses, as the backend state machine names them. */
export const RUN_STATUS = {
  DRAFT: { tone: 'neutral', label: 'Draft' },
  PROCESSING: { tone: 'progress', label: 'Processing' },
  READY_FOR_FINALIZATION: { tone: 'attention', label: 'Ready for review' },
  FINALIZED: { tone: 'verified', label: 'Finalized' },
  DISBURSED: { tone: 'verified', label: 'Disbursed' },
  FAILED: { tone: 'failed', label: 'Failed' },
  CANCELLED: { tone: 'neutral', label: 'Cancelled' },
};

export function RunStatusBadge({ status }) {
  const s = RUN_STATUS[status] || { tone: 'unknown', label: status ? status.replaceAll('_', ' ').toLowerCase() : 'Unknown' };
  return <StatusBadge tone={s.tone}>{s.label}</StatusBadge>;
}
