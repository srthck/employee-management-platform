/** @type {import('tailwindcss').Config} */

// Colours come from src/styles/tokens.css so Tailwind utilities and plain CSS share one source.
const token = (name) => `rgb(var(--pg-${name}-rgb) / <alpha-value>)`;
const names = [
  'obsidian', 'wine', 'crimson', 'crimson-strong', 'scarlet', 'crimson-tint', 'crimson-line',
  'on-accent',
  'porcelain', 'canvas-2', 'surface', 'ink', 'ink-2', 'ink-3', 'line', 'line-strong', 'field',
  'ok', 'ok-tint', 'ok-line', 'warn', 'warn-tint', 'warn-line',
  'bad', 'bad-tint', 'bad-line', 'defer', 'defer-tint', 'defer-line',
];

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx}",
  ],
  theme: {
    extend: {
      colors: Object.fromEntries(names.map((name) => [name, token(name)])),
      // One source for the stacks: src/styles/tokens.css.
      fontFamily: {
        sans: 'var(--pg-sans)',
        mono: 'var(--pg-mono)',
      },
    },
  },
  plugins: [],
};
