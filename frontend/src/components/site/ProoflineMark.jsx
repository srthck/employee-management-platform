/**
 * PayGuard mark: a "P" whose stem continues as the proofline and ends in a
 * coral proof point. Drawn as an open glyph rather than a filled tile, so it
 * sits on the lit navy canvas the way the rest of the chrome does.
 * Decorative; the wordmark beside it carries the name.
 *
 * `inverse` draws it for a light surface (used where the canvas is cream).
 */
export default function ProoflineMark({ size = 28, inverse = false }) {
  const stroke = inverse ? 'var(--pg-obsidian)' : 'var(--pg-ink)';
  return (
    <svg
      className="site-mark"
      width={size}
      height={size}
      viewBox="0 0 28 28"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M8.5 22.2V5.8h6a4.9 4.9 0 0 1 0 9.8h-6"
        fill="none"
        stroke={stroke}
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8.5" cy="22.2" r="2.7" fill="var(--pg-signal)" />
    </svg>
  );
}
