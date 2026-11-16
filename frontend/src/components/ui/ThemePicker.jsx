import { useTheme } from '../../contexts/ThemeContext';

/**
 * Picks the surface theme. A radiogroup rather than a menu, so the whole set
 * is visible at once and arrow keys move between options the way a native
 * segmented control does.
 *
 * Each option shows the theme's own canvas and accent, so the choice is made
 * from the colours themselves rather than from their names.
 */
export default function ThemePicker({ label = 'Appearance' }) {
  const { theme, setTheme, themes } = useTheme();

  const onKeyDown = (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const index = themes.findIndex((t) => t.id === theme);
    const next = themes[(index + step + themes.length) % themes.length];
    setTheme(next.id);
    event.currentTarget.querySelector(`[data-theme-id="${next.id}"]`)?.focus();
  };

  return (
    <div>
      <p className="px-1 pb-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-ink-3">
        {label}
      </p>
      {/* Two columns: four labelled options do not fit one row inside the
          account menu, and a 2×2 keeps every name readable. */}
      <div
        role="radiogroup"
        aria-label={label}
        className="segmented grid w-full grid-cols-2 gap-1"
        onKeyDown={onKeyDown}
      >
        {themes.map((option) => {
          const checked = option.id === theme;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={`${option.label}. ${option.hint}`}
              data-theme-id={option.id}
              tabIndex={checked ? 0 : -1}
              onClick={() => setTheme(option.id)}
              className="segmented__option w-full justify-start"
              title={option.hint}
            >
              <span
                aria-hidden="true"
                className="theme-swatch"
                style={{ background: `linear-gradient(135deg, ${option.canvas} 52%, ${option.accent} 52%)` }}
              />
              <span className="truncate">{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
