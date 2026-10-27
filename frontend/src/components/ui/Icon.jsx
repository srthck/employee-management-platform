/**
 * PayGuard icon set: 24-unit grid, 1.75 stroke, round caps and joins, no fills.
 * Decorative by default (aria-hidden); pass `label` when an icon carries meaning alone.
 */
const PATHS = {
  overview: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="4.5" rx="1.5" /><rect x="13.5" y="11" width="7" height="9.5" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /></>,
  employees: <><circle cx="9" cy="8" r="3.25" /><path d="M3.5 19.5c.6-3 2.8-4.75 5.5-4.75s4.9 1.75 5.5 4.75" /><path d="M15.5 4.9a3.25 3.25 0 0 1 0 6.2" /><path d="M17.5 14.9c1.6.6 2.7 2.2 3 4.6" /></>,
  payroll: <><path d="M6 3.5h12v17l-2.5-1.5-2 1.5-1.5-1.5-1.5 1.5-2-1.5L6 20.5z" /><path d="M9.5 8h5M9.5 8c2.2 0 3 1 3 2.25S11.7 12.5 9.5 12.5l4 3.5M9.5 10.25h5" /></>,
  compensation: <><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /><path d="M4 12h6M14 12h6" /><circle cx="12" cy="12" r="2" /></>,
  compliance: <><path d="M12 3.5 19.5 6v5.5c0 4.5-3.2 8-7.5 9-4.3-1-7.5-4.5-7.5-9V6z" /><path d="m8.75 12 2.25 2.25 4.25-4.5" /></>,
  audit: <><path d="M8 6.5h12M8 12h12M8 17.5h12" /><circle cx="4.5" cy="6.5" r="1" /><circle cx="4.5" cy="12" r="1" /><circle cx="4.5" cy="17.5" r="1" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3.5v2.25M12 18.25v2.25M3.5 12h2.25M18.25 12h2.25M5.99 5.99l1.59 1.59M16.42 16.42l1.59 1.59M5.99 18.01l1.59-1.59M16.42 7.58l1.59-1.59" /></>,
  payslip: <><path d="M6.5 3.5h7.5l4 4v13h-11.5z" /><path d="M14 3.5v4h4M9.5 12h5M9.5 15.5h5" /></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  collapse: <><rect x="3.5" y="4" width="17" height="16" rx="2.5" /><path d="M9 4v16M15.5 10l-2 2 2 2" /></>,
  expand: <><rect x="3.5" y="4" width="17" height="16" rx="2.5" /><path d="M9 4v16M13.5 10l2 2-2 2" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  'check-circle': <><circle cx="12" cy="12" r="8.5" /><path d="m8.5 12.25 2.5 2.5 4.75-5" /></>,
  'alert-triangle': <><path d="M12 4 21 19.5H3z" /><path d="M12 10v4M12 16.75v.25" /></>,
  'x-circle': <><circle cx="12" cy="12" r="8.5" /><path d="m9.25 9.25 5.5 5.5M14.75 9.25l-5.5 5.5" /></>,
  'pause-circle': <><circle cx="12" cy="12" r="8.5" strokeDasharray="2.5 2.5" /><path d="M10 9.5v5M14 9.5v5" /></>,
  'help-circle': <><circle cx="12" cy="12" r="8.5" /><path d="M9.75 9.75a2.25 2.25 0 1 1 3.4 1.95c-.7.4-1.15.9-1.15 1.8M12 16.5v.25" /></>,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8v.25" /></>,
  'arrow-right': <path d="M5 12h14M13.5 6.5 19 12l-5.5 5.5" />,
  'arrow-left': <path d="M19 12H5M10.5 6.5 5 12l5.5 5.5" />,
  'chevron-right': <path d="m9.5 6 6 6-6 6" />,
  logout: <><path d="M14 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H14" /><path d="M10 12h10M16.5 8.5 20 12l-3.5 3.5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  link: <><path d="M10 14a4 4 0 0 0 5.66 0l2.83-2.83a4 4 0 0 0-5.66-5.66l-1 1" /><path d="M14 10a4 4 0 0 0-5.66 0l-2.83 2.83a4 4 0 0 0 5.66 5.66l1-1" /></>,
};

export default function Icon({ name, size = 18, label, className = '', strokeWidth = 1.75 }) {
  const content = PATHS[name];
  if (!content) return null;
  return (
    <svg
      className={`shrink-0 ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
      focusable="false"
    >
      {content}
    </svg>
  );
}
