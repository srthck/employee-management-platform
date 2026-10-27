import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useContext, useEffect, useId, useRef, useState } from 'react';
import { AuthContext } from '../contexts/AuthContext';
import { can, roleLabel } from '../utils/permissions';
import Icon from './ui/Icon';
import ProoflineMark from './site/ProoflineMark';

const allLinks = [
  { to: '/dashboard', label: 'Overview', icon: 'overview', permission: 'payroll.read' },
  { to: '/employees', label: 'Employees', icon: 'employees', permission: 'employee.read' },
  { to: '/payroll', label: 'Payroll runs', icon: 'payroll', permission: 'payroll.read' },
  { to: '/compensation', label: 'Compensation', icon: 'compensation', permission: 'compensation.read' },
  { to: '/compliance', label: 'Compliance', icon: 'compliance', permission: 'compliance.read' },
  { to: '/audit', label: 'Audit trail', icon: 'audit', permission: 'audit.read' },
  { to: '/my/payslips', label: 'My payslips', icon: 'payslip', permission: 'self.service' },
];

const settingsLink = { to: '/settings', label: 'Settings', icon: 'settings' };

const RAIL_KEY = 'pg.rail.collapsed';
const readCollapsed = () => {
  try { return window.localStorage.getItem(RAIL_KEY) === '1'; } catch { return false; }
};

/** Closes a disclosure on Escape or an outside click, returning focus to its trigger. */
function useDismiss(open, setOpen, ref, triggerRef) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); } };
    const onPointer = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointer); };
  }, [open, setOpen, ref, triggerRef]);
}

function RailLink({ link, collapsed, onNavigate }) {
  return (
    <NavLink
      to={link.to}
      onClick={onNavigate}
      aria-label={collapsed ? link.label : undefined}
      className={({ isActive }) => [
        'group relative flex min-h-[40px] items-center gap-3 rounded-[10px] px-3 text-[14px] font-medium transition-colors duration-150',
        collapsed ? 'lg:justify-center lg:px-0' : '',
        isActive ? 'bg-white/[0.08] text-white' : 'text-[#CFC4C9] hover:bg-white/[0.05] hover:text-white',
      ].join(' ')}
    >
      {({ isActive }) => (
        <>
          <span
            aria-hidden="true"
            className={`absolute bottom-2 left-0 top-2 w-[2px] rounded-full bg-scarlet transition-opacity ${isActive ? 'opacity-100' : 'opacity-0'}`}
          />
          <Icon name={link.icon} size={19} className={isActive ? 'text-white' : 'text-[#A99BA2] group-hover:text-white'} />
          <span className={collapsed ? 'lg:sr-only' : ''}>{link.label}</span>
          {collapsed && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-full z-50 ml-3 hidden whitespace-nowrap rounded-[8px] bg-obsidian px-2.5 py-1.5 text-xs font-medium text-white opacity-0 shadow-lg ring-1 ring-white/10 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 lg:block"
            >
              {link.label}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

function ScopeNote() {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef(null);
  const triggerRef = useRef(null);
  useDismiss(open, setOpen, ref, triggerRef);
  return (
    <div className="relative" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-h-[36px] items-center gap-2 rounded-full border border-dashed border-defer-line bg-defer-tint px-3 text-[12.5px] font-semibold text-defer transition-colors hover:border-defer"
      >
        <Icon name="pause-circle" size={15} strokeWidth={2} />
        <span className="hidden md:inline">Scope: TDS and attendance deferred</span>
        <span className="md:hidden">Scope</span>
      </button>
      {open && (
        <div
          id={id}
          className="absolute right-0 top-full z-50 mt-2 w-[min(360px,calc(100vw-32px))] rounded-[14px] border border-line bg-surface p-4 text-sm"
          style={{ boxShadow: 'var(--pg-shadow-overlay)' }}
        >
          <p className="font-semibold text-ink">What PayGuard does not calculate yet</p>
          <dl className="mt-3 space-y-3">
            <div>
              <dt className="font-medium text-ink">Income tax (TDS)</dt>
              <dd className="mt-0.5 leading-5 text-ink-2">Not calculated. Payroll results and payslips show net pay before TDS.</dd>
            </div>
            <div>
              <dt className="font-medium text-ink">Attendance and loss of pay</dt>
              <dd className="mt-0.5 leading-5 text-ink-2">Not applied: there is no attendance subsystem. Pay is prorated only for employees who join or leave inside a period.</dd>
            </div>
          </dl>
          <p className="mt-3 border-t border-line pt-3 text-xs leading-5 text-ink-2">
            These are deliberate scope limits, not errors. Checks that depend on them are marked “deferred”.
          </p>
        </div>
      )}
    </div>
  );
}

function AccountMenu({ user, logout, logoutAll }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef(null);
  const triggerRef = useRef(null);
  useDismiss(open, setOpen, ref, triggerRef);
  const initials = (user?.name || '?').split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div className="relative" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-[40px] items-center gap-2.5 rounded-full p-1 transition-colors hover:bg-canvas-2 sm:pr-3"
      >
        <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-full bg-obsidian text-[12px] font-semibold text-white">
          {initials}
        </span>
        <span className="hidden text-left sm:block">
          <span className="block max-w-[160px] truncate text-[13px] font-semibold leading-4 text-ink">{user?.name || 'Signed in'}</span>
          <span className="block text-[11.5px] leading-4 text-ink-2">{roleLabel(user?.role)}</span>
        </span>
        <span className="sr-only sm:hidden">Account: {user?.name}</span>
      </button>
      {open && (
        <div
          id={id}
          className="absolute right-0 top-full z-50 mt-2 w-60 rounded-[14px] border border-line bg-surface p-1.5 text-sm"
          style={{ boxShadow: 'var(--pg-shadow-overlay)' }}
        >
          <div className="px-3 py-2 sm:hidden">
            <p className="truncate font-semibold text-ink">{user?.name}</p>
            <p className="text-xs text-ink-2">{roleLabel(user?.role)}</p>
          </div>
          <NavLink to="/settings" onClick={() => setOpen(false)} className="flex min-h-[38px] items-center gap-2.5 rounded-[8px] px-3 text-ink hover:bg-canvas-2">
            <Icon name="settings" size={17} className="text-ink-2" /> Settings
          </NavLink>
          <button type="button" onClick={logout} className="flex min-h-[38px] w-full items-center gap-2.5 rounded-[8px] px-3 text-left text-ink hover:bg-canvas-2">
            <Icon name="logout" size={17} className="text-ink-2" /> Sign out
          </button>
          <button type="button" onClick={logoutAll} className="flex min-h-[38px] w-full items-center gap-2.5 rounded-[8px] px-3 text-left text-ink-2 hover:bg-canvas-2 hover:text-ink">
            <span className="w-[17px]" aria-hidden="true" /> Sign out on all devices
          </button>
        </div>
      )}
    </div>
  );
}

export default function PayGuardLayout() {
  const { user, logout, logoutAll } = useContext(AuthContext);
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const location = useLocation();
  const menuButtonRef = useRef(null);
  const drawerRef = useRef(null);

  const links = allLinks.filter((link) => can(user, link.permission));
  const current = [...links, settingsLink].find((link) => location.pathname.startsWith(link.to));

  useEffect(() => {
    try { window.localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0'); } catch { /* storage unavailable */ }
  }, [collapsed]);

  // Mobile drawer: focus moves into it, Escape closes it, the page behind does not scroll.
  useEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(() => drawerRef.current?.querySelector('nav a')?.focus());
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); menuButtonRef.current?.focus(); } };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; };
  }, [open]);

  useEffect(() => { setOpen(false); }, [location.pathname]);

  const closeDrawer = () => setOpen(false);

  return (
    <div className="min-h-screen bg-porcelain text-ink">
      <a href="#app-main" className="sr-only z-[60] rounded-[8px] bg-obsidian px-3 py-2 text-sm font-semibold text-white focus:not-sr-only focus:fixed focus:left-3 focus:top-3">
        Skip to content
      </a>

      {/* One sidebar: a rail on desktop, a drawer below 1024px (invisible, so unfocusable, while closed). */}
      <aside
        ref={drawerRef}
        className={[
          'fixed inset-y-0 left-0 z-40 flex w-[264px] flex-col bg-obsidian text-white',
          'lg:visible lg:translate-x-0',
          collapsed ? 'lg:w-[76px]' : 'lg:w-[var(--pg-rail)]',
          open ? 'visible translate-x-0' : 'invisible -translate-x-full',
        ].join(' ')}
        // Visible at once when opening (so focus can move in); hidden only after sliding out.
        style={{
          transition: open
            ? 'transform 200ms ease-out, width 200ms ease-out, visibility 0s'
            : 'transform 200ms ease-out, width 200ms ease-out, visibility 0s linear 200ms',
        }}
        aria-label="Sidebar"
      >
        <div className={`flex h-[var(--pg-topbar)] shrink-0 items-center gap-2.5 border-b border-white/10 px-4 ${collapsed ? 'lg:justify-center lg:px-0' : ''}`}>
          <ProoflineMark size={28} inverse />
          <span className={`text-[16px] font-bold tracking-[-0.02em] ${collapsed ? 'lg:sr-only' : ''}`}>PayGuard</span>
          <button
            type="button"
            onClick={closeDrawer}
            className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded-[8px] text-[#CFC4C9] hover:bg-white/10 hover:text-white lg:hidden"
            aria-label="Close navigation"
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        <nav aria-label="Primary navigation" className="pg-scrollbar flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
          <p className={`px-3 pb-2 font-mono text-[10.5px] font-medium uppercase tracking-[0.12em] text-[#A99BA2] ${collapsed ? 'lg:sr-only' : ''}`}>
            Workspace
          </p>
          {links.map((link) => (
            <RailLink key={link.to} link={link} collapsed={collapsed} onNavigate={closeDrawer} />
          ))}
          <div className="!my-4 border-t border-white/10" />
          <RailLink link={settingsLink} collapsed={collapsed} onNavigate={closeDrawer} />
        </nav>

        <div className={`shrink-0 border-t border-white/10 p-3 ${collapsed ? 'lg:px-2' : ''}`}>
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-pressed={collapsed}
            className={`hidden min-h-[40px] w-full items-center gap-3 rounded-[10px] px-3 text-[13px] font-medium text-[#CFC4C9] transition-colors hover:bg-white/[0.05] hover:text-white lg:flex ${collapsed ? 'lg:justify-center lg:px-0' : ''}`}
          >
            <Icon name={collapsed ? 'expand' : 'collapse'} size={18} />
            <span className={collapsed ? 'sr-only' : ''}>{collapsed ? 'Expand sidebar' : 'Collapse sidebar'}</span>
          </button>
          <div className="px-3 pt-1 lg:hidden">
            <p className="truncate text-sm font-semibold">{user?.name}</p>
            <p className="text-xs text-[#A99BA2]">{roleLabel(user?.role)}</p>
          </div>
        </div>
      </aside>

      {open && (
        <button
          aria-label="Close navigation"
          type="button"
          tabIndex={-1}
          className="fixed inset-0 z-30 bg-obsidian/45 backdrop-blur-[1px] lg:hidden"
          onClick={closeDrawer}
        />
      )}

      <div className={`transition-[padding] duration-200 ${collapsed ? 'lg:pl-[76px]' : 'lg:pl-[var(--pg-rail)]'}`}>
        <header className="sticky top-0 z-20 border-b border-line bg-porcelain/90 backdrop-blur-md">
          <div className="mx-auto flex h-[var(--pg-topbar)] max-w-[1400px] items-center gap-3 px-4 sm:px-8">
            <button
              ref={menuButtonRef}
              type="button"
              aria-label="Open navigation"
              aria-expanded={open}
              onClick={() => setOpen(true)}
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-line-strong bg-surface text-ink hover:bg-canvas-2 lg:hidden"
            >
              <Icon name="menu" size={18} />
            </button>
            <p className="min-w-0 truncate text-[15px] font-semibold text-ink">
              <span className="sr-only">Current section: </span>
              {current?.label || 'PayGuard'}
            </p>
            <div className="ml-auto flex items-center gap-2 sm:gap-3">
              <ScopeNote />
              <AccountMenu user={user} logout={logout} logoutAll={logoutAll} />
            </div>
          </div>
        </header>

        <main id="app-main" tabIndex={-1} className="mx-auto max-w-[1400px] px-4 pb-16 pt-6 outline-none sm:px-8 sm:pt-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
