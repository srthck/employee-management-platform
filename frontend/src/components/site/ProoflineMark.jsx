/**
 * PayGuard mark: a "P" whose stem continues as the proofline and ends in a
 * signal-red proof point. Decorative; the wordmark beside it carries the name.
 */
export default function ProoflineMark({ size = 28, inverse = false }) {
  return (
    <svg className="site-mark" width={size} height={size} viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      <rect width="28" height="28" rx="7" fill={inverse ? 'var(--pg-porcelain)' : 'var(--pg-ink)'} />
      <path
        d="M10 21.5V6.5h5.25a4.75 4.75 0 0 1 0 9.5H10"
        fill="none"
        stroke={inverse ? 'var(--pg-ink)' : 'var(--pg-porcelain)'}
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="21.75" r="2.6" fill="var(--pg-signal)" />
    </svg>
  );
}
