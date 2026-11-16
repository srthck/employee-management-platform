import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * ThemeContext
 *
 * Four palettes over one material system (src/styles/themes.css). A theme
 * only changes colour — the canvas, the glass film, the ink ladder and the
 * accent. Structure, type and motion never vary.
 *
 * The chosen theme is an attribute on <html>, so CSS alone resolves it and
 * no component has to know which one is active. The same attribute is set by
 * the inline script in index.html before first paint, so the page never
 * flashes the default theme on the way to the stored one.
 *
 * Persisted per browser only; it is a display preference, not account data.
 */

export const THEMES = [
  {
    id: 'midnight',
    label: 'Midnight',
    hint: 'Deep navy, warm light, coral accent',
    canvas: '#12213C',
    accent: '#FF6A5C',
  },
  {
    id: 'graphite',
    label: 'Graphite',
    hint: 'Neutral charcoal, the quietest for long sessions',
    canvas: '#1B1E23',
    accent: '#4C9DFF',
  },
  {
    id: 'aurora',
    label: 'Aurora',
    hint: 'Indigo with a violet accent',
    canvas: '#1D1B44',
    accent: '#A78BFA',
  },
  {
    id: 'daylight',
    label: 'Daylight',
    hint: 'Light glass, for bright rooms and printing',
    canvas: '#EDF0F6',
    accent: '#0066CC',
  },
];

export const DEFAULT_THEME = 'midnight';
export const THEME_KEY = 'pg.theme';

const isKnown = (id) => THEMES.some((theme) => theme.id === id);

/** Reads the stored choice, falling back to whatever the boot script applied. */
export function readStoredTheme() {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (isKnown(stored)) return stored;
  } catch {
    /* storage unavailable (private window, blocked cookies) */
  }
  try {
    const applied = document.documentElement.getAttribute('data-theme');
    if (isKnown(applied)) return applied;
  } catch {
    /* no document (SSR, tests) */
  }
  return DEFAULT_THEME;
}

export const ThemeContext = createContext({
  theme: DEFAULT_THEME,
  setTheme: () => {},
  themes: THEMES,
});

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(readStoredTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    // Keep the browser chrome (address bar, form controls) in step.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEMES.find((t) => t.id === theme)?.canvas || '#0A1424');
  }, [theme]);

  const setTheme = useCallback((id) => {
    if (!isKnown(id)) return;
    setThemeState(id);
    try {
      window.localStorage.setItem(THEME_KEY, id);
    } catch {
      /* storage unavailable: the choice still applies for this session */
    }
  }, []);

  const value = useMemo(() => ({ theme, setTheme, themes: THEMES }), [theme, setTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
