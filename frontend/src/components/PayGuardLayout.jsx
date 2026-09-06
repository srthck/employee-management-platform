import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useContext, useState } from 'react';
import { AuthContext } from '../contexts/AuthContext';

const links = [
  { to: '/dashboard', label: 'Overview', icon: '▦' },
  { to: '/employees', label: 'Employees', icon: '♙' },
  { to: '/payroll', label: 'Payroll runs', icon: '₹' },
  { to: '/compliance', label: 'Compliance', icon: '✓' },
  { to: '/audit', label: 'Audit trail', icon: '⌁' },
];

export default function PayGuardLayout() {
  const { user, logout } = useContext(AuthContext);
  const [open, setOpen] = useState(false);
  const location = useLocation();

  const current = links.find((link) =>
    location.pathname.startsWith(link.to)
  );

  return (
    <div className="min-h-screen bg-[#FFFDF8] text-[#241F20]">

      {/* ==================== SIDEBAR ==================== */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 bg-[#7D1022] text-white transition-transform duration-200 lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-full flex-col">

          {/* BRAND */}
          <div className="border-b border-white/15 px-6 py-6">
            <div className="flex items-center gap-3">

              <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[#FFF7F0] font-bold text-[#A6192E]">
                P
              </div>

              <div>
                <p className="text-base font-semibold tracking-[0.04em]">
                  PAYGUARD
                </p>

                <p className="text-[10px] uppercase tracking-[0.18em] text-[#F8E8EA]">
                  Payroll operations
                </p>
              </div>

            </div>
          </div>

          {/* NAVIGATION */}
          <nav
            aria-label="Primary navigation"
            className="flex-1 space-y-1 px-3 py-6"
          >
            <p className="px-3 pb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#EFC9CF]">
              Workspace
            </p>

            {links.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                onClick={() => setOpen(false)}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-[10px] px-3 py-2.5 text-sm transition ${
                    isActive
                      ? 'bg-[#A6192E] text-white shadow-sm'
                      : 'text-[#F3DDE0] hover:bg-white/10 hover:text-white'
                  }`
                }
              >
                <span
                  aria-hidden="true"
                  className="w-5 text-center text-[#FFF7F0]"
                >
                  {link.icon}
                </span>

                {link.label}
              </NavLink>
            ))}

            <div className="my-6 border-t border-white/15" />

            {/* SETTINGS */}
            <NavLink
              to="/settings"
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-[10px] px-3 py-2.5 text-sm transition ${
                  isActive
                    ? 'bg-[#A6192E] text-white shadow-sm'
                    : 'text-[#F3DDE0] hover:bg-white/10 hover:text-white'
                }`
              }
            >
              <span
                aria-hidden="true"
                className="w-5 text-center text-[#FFF7F0]"
              >
                ⚙
              </span>

              Settings
            </NavLink>
          </nav>

          {/* USER SECTION */}
          <div className="border-t border-white/15 p-4">

            <p className="truncate text-sm font-medium text-white">
              {user?.name || 'Authenticated user'}
            </p>

            <p className="mt-1 text-xs text-[#EFC9CF]">
              {user?.role || 'Admin'} · single tenant
            </p>

            <button
              type="button"
              onClick={logout}
              className="mt-4 w-full rounded-[8px] border border-white/20 px-3 py-2 text-left text-xs text-[#F8E8EA] transition hover:bg-white/10 hover:text-white"
            >
              Sign out
            </button>

          </div>
        </div>
      </aside>

      {/* ==================== MOBILE OVERLAY ==================== */}
      {open && (
        <button
          aria-label="Close navigation"
          type="button"
          className="fixed inset-0 z-30 bg-[#241F20]/40 lg:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      {/* ==================== MAIN AREA ==================== */}
      <div className="lg:pl-64">

        {/* ==================== HEADER ==================== */}
        <header className="sticky top-0 z-20 border-b border-[#E7D8D5] bg-[#FFFDF8]/95 backdrop-blur">

          <div className="flex h-16 items-center justify-between px-4 sm:px-8">

            {/* LEFT SIDE */}
            <div className="flex items-center gap-3">

              {/* MOBILE MENU BUTTON */}
              <button
                type="button"
                aria-label="Open navigation"
                onClick={() => setOpen(true)}
                className="rounded-[8px] border border-[#E7D8D5] bg-white px-2 py-1.5 text-lg text-[#A6192E] transition hover:bg-[#F8E8EA] lg:hidden"
              >
                ☰
              </button>

              <div>
                <p className="text-sm font-semibold text-[#241F20]">
                  {current?.label || 'PayGuard'}
                </p>

                <p className="text-xs text-[#6F6565]">
                  Payroll and compliance operations
                </p>
              </div>

            </div>

            {/* RIGHT SIDE */}
            <div className="flex items-center gap-3">

              <span className="hidden text-xs text-[#6F6565] sm:block">
                MVP scope · TDS deferred
              </span>

              {/* ACTIVE SESSION */}
              <div
                className="h-2 w-2 rounded-full bg-[#2E7D32]"
                title="Session active"
              />

              <span className="hidden text-sm font-medium text-[#241F20] sm:block">
                {user?.name}
              </span>

            </div>

          </div>

        </header>

        {/* ==================== PAGE CONTENT ==================== */}
        <main className="mx-auto max-w-[1480px] p-4 sm:p-8">
          <Outlet />
        </main>

      </div>
    </div>
  );
}
