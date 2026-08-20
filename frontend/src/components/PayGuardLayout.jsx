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
  const current = links.find((link) => location.pathname.startsWith(link.to));

  return (
    <div className="min-h-screen bg-[#f4f7f9] text-[#182230]">
      <aside className={`fixed inset-y-0 left-0 z-40 w-64 bg-[#14232d] text-white transition-transform lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex h-full flex-col">
          <div className="border-b border-white/10 px-6 py-6">
            <div className="flex items-center gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-md bg-[#55b9c6] font-bold text-[#10242c]">P</div><div><p className="text-lg font-semibold tracking-tight">PAYGUARD</p><p className="text-[10px] uppercase tracking-[0.18em] text-[#9bb4bb]">Payroll operations</p></div></div>
          </div>
          <nav aria-label="Primary navigation" className="flex-1 space-y-1 px-3 py-6">
            <p className="px-3 pb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#78929a]">Workspace</p>
            {links.map((link) => <NavLink key={link.to} to={link.to} onClick={() => setOpen(false)} className={({ isActive }) => `flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition ${isActive ? 'bg-[#25434d] text-white' : 'text-[#adc0c5] hover:bg-white/5 hover:text-white'}`}><span aria-hidden="true" className="w-5 text-center text-[#70c7cc]">{link.icon}</span>{link.label}</NavLink>)}
            <div className="my-6 border-t border-white/10" />
            <NavLink to="/settings" onClick={() => setOpen(false)} className={({ isActive }) => `flex items-center gap-3 rounded-md px-3 py-2.5 text-sm ${isActive ? 'bg-[#25434d] text-white' : 'text-[#adc0c5] hover:bg-white/5 hover:text-white'}`}><span className="w-5 text-center text-[#70c7cc]">⚙</span>Settings</NavLink>
          </nav>
          <div className="border-t border-white/10 p-4"><p className="truncate text-sm font-medium">{user?.name || 'Authenticated user'}</p><p className="mt-1 text-xs text-[#8ca6ad]">{user?.role || 'Admin'} · single tenant</p><button type="button" onClick={logout} className="mt-4 w-full rounded-md border border-white/15 px-3 py-2 text-left text-xs text-[#bfd0d3] hover:bg-white/5">Sign out</button></div>
        </div>
      </aside>
      {open && <button aria-label="Close navigation" type="button" className="fixed inset-0 z-30 bg-[#071116]/50 lg:hidden" onClick={() => setOpen(false)} />}
      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 border-b border-[#dce5e8] bg-[#f8fafb]/95 backdrop-blur"><div className="flex h-16 items-center justify-between px-4 sm:px-8"><div className="flex items-center gap-3"><button type="button" aria-label="Open navigation" onClick={() => setOpen(true)} className="rounded-md border border-[#d4e0e3] px-2 py-1.5 text-lg lg:hidden">☰</button><div><p className="text-sm font-semibold">{current?.label || 'PayGuard'}</p><p className="text-xs text-[#6d8188]">Payroll and compliance operations</p></div></div><div className="flex items-center gap-3"><span className="hidden text-xs text-[#6d8188] sm:block">MVP scope · TDS deferred</span><div className="h-2 w-2 rounded-full bg-[#2b9e7d]" title="Session active" /><span className="hidden text-sm font-medium sm:block">{user?.name}</span></div></div></header>
        <main className="mx-auto max-w-[1480px] p-4 sm:p-8"><Outlet /></main>
      </div>
    </div>
  );
}
