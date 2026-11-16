import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useContext, useEffect, useId, useRef, useState } from 'react';
import { AuthContext } from '../contexts/AuthContext';
import { can, roleLabel } from '../utils/permissions';
import Icon from './ui/Icon';
import ProoflineMark from './site/ProoflineMark';
import ThemePicker from './ui/ThemePicker';

/**
 * The signed-in shell.
 *
 * Layout follows the product's design language: a lit navy canvas, the brand
 * at the left, the sections in a centred glass capsule, and circular glass
 * controls at the right. Below the pill breakpoint — and at any width, via the
 * menu control — every section is reachable from a glass drawer.
 *
 * Which links appear is still decided by the signed-in user's permissions;
 * nothing here grants access that `can()` does not already allow.
 */

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

/** One section inside the centred capsule. The current section keeps a coral point. */
function PillLink({ link }) {
  return (
    <NavLink
      to={link.to}
      className={({ isActive }) => `pill-nav__item${isActive ? ' is-active' : ''}`}
    >
      {({ isActive }) => (
        <>
          {isActive && <span className="pill-nav__dot" aria-hidden="true" />}
          {link.label}
        </>
      )}
    </NavLink>
  );
}

/** A section row inside the drawer. */
function DrawerLink({ link, onNavigate }) {
  return (
    <NavLink
      to={link.to}
      onClick={onNavigate}
      className={({ isActive }) => [
        'group relative flex min-h-[46px] items-center gap-3 rounded-full px-4 text-[14.5px] font-medium transition-colors duration-150',
        isActive ? 'text-ink' : 'text-ink-2 hover:text-ink',
      ].join(' ')}
    >
      {({ isActive }) => (
        <>
          <span
            aria-hidden="true"
            className={`absolute inset-0 rounded-full border transition-colors ${
              isActive
                ? 'border-[var(--pg-glass-line-strong)] bg-[var(--pg-glass-strong)]'
                : 'border-transparent group-hover:border-[var(--pg-glass-line)] group-hover:bg-[var(--pg-glass)]'
            }`}
          />
          <Icon name={link.icon} size={18} className="relative" />
          <span className="relative">{link.label}</span>
          {isActive && <span className="pill-nav__dot relative ml-auto" aria-hidden="true" />}
        </>
      )}
    </NavLink>
  );
}

/**
 * The scope disclosure. PayGuard does not calculate TDS or apply attendance,
 * and the product states that wherever figures are shown — here as a circular
 * control carrying a coral point, and again in the shell footer.
 */
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
        className="icon-button relative h-10 w-10"
      >
        <Icon name="pause-circle" size={17} strokeWidth={2} />
        <span className="absolute right-1.5 top-1.5 h-[6px] w-[6px] rounded-full bg-crimson" aria-hidden="true" />
        <span className="sr-only">Scope: TDS and attendance are deferred</span>
      </button>
      {open && (
        <div
          id={id}
          className="dialog absolute right-0 top-full z-50 mt-2.5 max-h-none w-[min(380px,calc(100vw-32px))] p-5 text-sm"
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
        className="icon-button h-10 gap-2.5 pl-1 pr-1 sm:pr-3.5"
      >
        <span
          aria-hidden="true"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-[12px] font-bold text-on-accent"
        >
          {initials}
        </span>
        <span className="hidden text-left sm:block">
          <span className="block max-w-[150px] truncate text-[13px] font-semibold leading-4 text-ink">{user?.name || 'Signed in'}</span>
          <span className="block text-[11px] leading-4 text-ink-2">{roleLabel(user?.role)}</span>
        </span>
        <span className="sr-only sm:hidden">Account: {user?.name}</span>
      </button>
      {open && (
        <div id={id} className="dialog absolute right-0 top-full z-50 mt-2.5 max-h-none w-[272px] p-1.5 text-sm">
          <div className="px-3 py-2 sm:hidden">
            <p className="truncate font-semibold text-ink">{user?.name}</p>
            <p className="text-xs text-ink-2">{roleLabel(user?.role)}</p>
          </div>
          <NavLink
            to="/settings"
            onClick={() => setOpen(false)}
            className="flex min-h-[40px] items-center gap-2.5 rounded-full px-3 text-ink transition-colors hover:bg-[var(--pg-glass)]"
          >
            <Icon name="settings" size={17} className="text-ink-2" /> Settings
          </NavLink>
          <button
            type="button"
            onClick={logout}
            className="flex min-h-[40px] w-full items-center gap-2.5 rounded-full px-3 text-left text-ink transition-colors hover:bg-[var(--pg-glass)]"
          >
            <Icon name="logout" size={17} className="text-ink-2" /> Sign out
          </button>
          <button
            type="button"
            onClick={logoutAll}
            className="flex min-h-[40px] w-full items-center gap-2.5 rounded-full px-3 text-left text-ink-2 transition-colors hover:bg-[var(--pg-glass)] hover:text-ink"
          >
            <span className="w-[17px]" aria-hidden="true" /> Sign out on all devices
          </button>
          <div className="mt-1.5 border-t pt-2.5" style={{ borderColor: 'var(--pg-glass-line)' }}>
            <ThemePicker />
          </div>
        </div>
      )}
    </div>
  );
}

export default function PayGuardLayout() {
  const { user, logout, logoutAll } = useContext(AuthContext);
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const menuButtonRef = useRef(null);
  const drawerRef = useRef(null);

  const links = allLinks.filter((link) => can(user, link.permission));
  const current = [...links, settingsLink].find((link) => location.pathname.startsWith(link.to));

  // Drawer: focus moves into it, Escape closes it, the page behind does not scroll.
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
    <div className="pg-canvas flex min-h-screen flex-col text-ink">
      <a
        href="#app-main"
        className="sr-only z-[60] rounded-full bg-crimson px-4 py-2 text-sm font-semibold text-on-accent focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>

      {/* The bar: brand, the sections in a centred capsule, circular controls. */}
      <header className="sticky top-0 z-30">
        <div className="glass-strong border-b" style={{ borderColor: 'var(--pg-glass-line)' }}>
          <div className="relative mx-auto flex h-[var(--pg-topbar)] max-w-[1480px] items-center gap-3 px-4 sm:px-6">
            <NavLink to="/dashboard" className="flex shrink-0 items-center gap-2.5" aria-label="PayGuard overview">
              <ProoflineMark size={28} />
              <span className="text-[17px] font-bold tracking-[-0.03em] text-ink">PayGuard</span>
            </NavLink>

            {/* Centred capsule, as in the reference. */}
            <nav
              aria-label="Primary navigation"
              className="pill-nav absolute left-1/2 hidden -translate-x-1/2 xl:flex"
            >
              {links.map((link) => (
                <PillLink key={link.to} link={link} />
              ))}
            </nav>

            {/* The current section, named where the capsule is not shown. */}
            <p className="min-w-0 flex-1 truncate pl-1 text-[14px] font-semibold text-ink-2 xl:hidden">
              <span className="sr-only">Current section: </span>
              {current?.label || 'PayGuard'}
            </p>

            <div className="ml-auto flex shrink-0 items-center gap-2">
              <ScopeNote />
              <AccountMenu user={user} logout={logout} logoutAll={logoutAll} />
              <button
                ref={menuButtonRef}
                type="button"
                aria-label="Open navigation"
                aria-expanded={open}
                onClick={() => setOpen(true)}
                className="icon-button h-10 w-10"
              >
                <Icon name="menu" size={18} />
              </button>
            </div>
          </div>
        </div>
      </header>

      <main
        id="app-main"
        tabIndex={-1}
        className="mx-auto w-full max-w-[1480px] flex-1 px-4 pb-14 pt-7 outline-none sm:px-6 sm:pt-9"
      >
        <Outlet />
      </main>

      {/* The scope limits stay stated on every screen, not only in the disclosure. */}
      <footer className="mx-auto w-full max-w-[1480px] px-4 pb-8 sm:px-6">
        <div
          className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t pt-5 text-[12px] leading-5 text-ink-2"
          style={{ borderColor: 'var(--pg-glass-line)' }}
        >
          <span className="inline-flex items-center gap-2">
            <ProoflineMark size={18} />
            © {new Date().getFullYear()} PayGuard
          </span>
          <span className="inline-flex items-center gap-2">
            <Icon name="pause-circle" size={14} className="text-defer" />
            Income tax (TDS) and attendance are not calculated. Net pay is shown before TDS.
          </span>
        </div>
      </footer>

      {/* Drawer: every section, at any width. */}
      {open && (
        <button
          aria-label="Close navigation"
          type="button"
          tabIndex={-1}
          className="fixed inset-0 z-40 backdrop-blur-[6px]"
          style={{ background: 'rgb(var(--pg-obsidian-rgb) / 0.62)' }}
          onClick={closeDrawer}
        />
      )}
      <aside
        ref={drawerRef}
        className={[
          'glass-strong fixed inset-y-0 right-0 z-50 flex w-[min(310px,88vw)] flex-col border-l',
          open ? 'visible translate-x-0' : 'invisible translate-x-full',
        ].join(' ')}
        style={{
          borderColor: 'var(--pg-glass-line)',
          boxShadow: 'var(--pg-shadow-overlay)',
          // Visible at once when opening (so focus can move in); hidden only after sliding out.
          transition: open
            ? 'transform 220ms var(--pg-ease), visibility 0s'
            : 'transform 220ms var(--pg-ease), visibility 0s linear 220ms',
        }}
        aria-label="Sections"
      >
        <div
          className="flex h-[var(--pg-topbar)] shrink-0 items-center gap-2.5 border-b px-4"
          style={{ borderColor: 'var(--pg-glass-line)' }}
        >
          <ProoflineMark size={26} />
          <span className="text-[16px] font-bold tracking-[-0.03em]">PayGuard</span>
          <button
            type="button"
            onClick={closeDrawer}
            className="icon-button ml-auto h-9 w-9"
            aria-label="Close navigation"
          >
            <Icon name="close" size={17} />
          </button>
        </div>

        <nav aria-label="All sections" className="pg-scrollbar flex-1 space-y-1 overflow-y-auto p-3">
          <p className="px-4 pb-2 pt-1 font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-ink-3">
            Workspace
          </p>
          {links.map((link) => (
            <DrawerLink key={link.to} link={link} onNavigate={closeDrawer} />
          ))}
          <div className="!my-3 border-t" style={{ borderColor: 'var(--pg-glass-line)' }} />
          <DrawerLink link={settingsLink} onNavigate={closeDrawer} />
        </nav>

        <div className="shrink-0 border-t p-4" style={{ borderColor: 'var(--pg-glass-line)' }}>
          <p className="truncate text-sm font-semibold">{user?.name}</p>
          <p className="text-xs text-ink-2">{roleLabel(user?.role)}</p>
        </div>
      </aside>
    </div>
  );
}
