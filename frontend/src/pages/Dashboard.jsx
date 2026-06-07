import { useState, useEffect, useContext, useCallback } from 'react';
import { AuthContext } from '../contexts/AuthContext';
import * as employeeService from '../services/employeeService';
import EmployeeModal from '../components/EmployeeModal';
import DeleteConfirmModal from '../components/DeleteConfirmModal';

/**
 * Dashboard Page
 *
 * Full employee management interface:
 * - Stats widgets (total, active, on-leave, new hires)
 * - Employee table with search, filter, sort, pagination
 * - Add / Edit / Delete employee via modals
 */

const DEPARTMENTS = [
  'Engineering', 'Marketing', 'Sales', 'Human Resources',
  'Finance', 'Operations', 'Design', 'Legal', 'Customer Support', 'Other',
];

const STATUS_COLORS = {
  active: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  inactive: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
  'on-leave': 'bg-amber-500/15 text-amber-400 border-amber-500/30',
};

const STATUS_LABELS = {
  active: 'Active',
  inactive: 'Inactive',
  'on-leave': 'On Leave',
};

function StatCard({ label, value, sub, icon, color }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex items-start gap-4 hover:border-slate-700 transition-colors">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${color}`}>
        {icon}
      </div>
      <div>
        <p className="text-slate-400 text-xs font-medium">{label}</p>
        <p className="text-2xl font-bold text-white mt-0.5">{value}</p>
        {sub && <p className="text-slate-500 text-xs mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { user, logout } = useContext(AuthContext);

  // ─── Data State ──────────────────────────────────────────────────────────
  const [employees, setEmployees] = useState([]);
  const [stats, setStats] = useState(null);
  const [pagination, setPagination] = useState({ total: 0, page: 1, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(true);
  const [error, setError] = useState('');

  // ─── Filter/Search State ─────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [department, setDepartment] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState('createdAt');
  const [sortOrder, setSortOrder] = useState('desc');
  const LIMIT = 8;

  // ─── Modal State ─────────────────────────────────────────────────────────
  const [showModal, setShowModal] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState(null); // null = create mode
  const [deleteTarget, setDeleteTarget] = useState(null);

  // ─── Debounce Search ─────────────────────────────────────────────────────
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  // ─── Fetch Employees ─────────────────────────────────────────────────────
  const fetchEmployees = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await employeeService.getEmployees({
        page,
        limit: LIMIT,
        search: debouncedSearch,
        department,
        status,
        sortBy,
        sortOrder,
      });
      setEmployees(data.data.employees);
      setPagination(data.data.pagination);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load employees.');
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, department, status, sortBy, sortOrder]);

  // ─── Fetch Stats ─────────────────────────────────────────────────────────
  const fetchStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const data = await employeeService.getEmployeeStats();
      setStats(data.data.stats);
    } catch {
      // non-critical, stats can fail silently
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => { fetchEmployees(); }, [fetchEmployees]);
  useEffect(() => { fetchStats(); }, [fetchStats]);

  // Reset to page 1 when filters change
  useEffect(() => { setPage(1); }, [department, status, sortBy, sortOrder]);

  // ─── Handlers ────────────────────────────────────────────────────────────
  const handleSort = (field) => {
    if (sortBy === field) {
      setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(field);
      setSortOrder('asc');
    }
  };

  const openCreate = () => {
    setEditingEmployee(null);
    setShowModal(true);
  };

  const openEdit = (emp) => {
    setEditingEmployee(emp);
    setShowModal(true);
  };

  const handleModalSuccess = () => {
    setShowModal(false);
    fetchEmployees();
    fetchStats();
  };

  const handleDeleteConfirm = async () => {
    try {
      await employeeService.deleteEmployee(deleteTarget._id);
      setDeleteTarget(null);
      fetchEmployees();
      fetchStats();
    } catch (err) {
      alert(err.response?.data?.message || 'Delete failed.');
    }
  };

  // ─── Sort Icon ────────────────────────────────────────────────────────────
  const SortIcon = ({ field }) => {
    if (sortBy !== field) return <span className="text-slate-600 ml-1">↕</span>;
    return <span className="text-violet-400 ml-1">{sortOrder === 'asc' ? '↑' : '↓'}</span>;
  };

  return (
    <div className="min-h-screen bg-slate-950">
      {/* Gradient accent bar */}
      <div className="h-1 bg-gradient-to-r from-violet-600 via-indigo-500 to-violet-600" />

      {/* ── Header ── */}
      <header className="bg-slate-900 border-b border-slate-800 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center">
              <span className="text-white text-xs font-bold">EMS</span>
            </div>
            <h2 className="text-lg font-semibold text-white">Employee Management</h2>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-slate-400 hidden sm:block">
              {user?.name}
              <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-300 font-medium">
                {user?.role}
              </span>
            </span>
            <button
              type="button"
              onClick={logout}
              className="text-sm text-slate-400 hover:text-white transition-colors px-3 py-1.5 rounded-lg hover:bg-slate-800"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8">

        {/* ── Stats Grid ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatCard
            label="Total Employees"
            value={statsLoading ? '—' : stats?.total ?? 0}
            sub="All records"
            color="bg-violet-500/20 text-violet-400"
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            }
          />
          <StatCard
            label="Active"
            value={statsLoading ? '—' : stats?.active ?? 0}
            sub="Currently working"
            color="bg-emerald-500/20 text-emerald-400"
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            }
          />
          <StatCard
            label="On Leave"
            value={statsLoading ? '—' : stats?.onLeave ?? 0}
            sub="Temporary absence"
            color="bg-amber-500/20 text-amber-400"
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            }
          />
          <StatCard
            label="New This Month"
            value={statsLoading ? '—' : stats?.newHiresThisMonth ?? 0}
            sub="Recent hires"
            color="bg-indigo-500/20 text-indigo-400"
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
              </svg>
            }
          />
        </div>

        {/* ── Employee Table Card ── */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl">

          {/* Table Header: title + search + filters + add button */}
          <div className="p-5 border-b border-slate-800">
            <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
              <h3 className="text-lg font-semibold text-white flex-shrink-0">Employees</h3>
              <div className="flex flex-wrap gap-2 w-full sm:w-auto">
                {/* Search */}
                <div className="relative flex-1 sm:flex-none">
                  <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <input
                    type="text"
                    placeholder="Search employees…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="w-full sm:w-56 pl-9 pr-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500 transition-all"
                  />
                </div>

                {/* Department filter */}
                <select
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                  className="px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-300 focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500 transition-all"
                >
                  <option value="">All Departments</option>
                  {DEPARTMENTS.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>

                {/* Status filter */}
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  className="px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-300 focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500 transition-all"
                >
                  <option value="">All Status</option>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                  <option value="on-leave">On Leave</option>
                </select>

                {/* Add Employee */}
                <button
                  type="button"
                  onClick={openCreate}
                  className="flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white text-sm font-semibold rounded-lg transition-all shadow-lg shadow-violet-500/20 flex-shrink-0"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  Add Employee
                </button>
              </div>
            </div>
          </div>

          {/* Error Banner */}
          {error && (
            <div className="mx-5 mt-4 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800">
                  {[
                    { label: 'Name', field: 'firstName' },
                    { label: 'Department', field: 'department' },
                    { label: 'Position', field: 'position' },
                    { label: 'Status', field: 'status' },
                    { label: 'Salary', field: 'salary' },
                    { label: 'Hire Date', field: 'hireDate' },
                  ].map(({ label, field }) => (
                    <th
                      key={field}
                      onClick={() => handleSort(field)}
                      className="px-5 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider cursor-pointer select-none hover:text-slate-200 transition-colors"
                    >
                      {label}
                      <SortIcon field={field} />
                    </th>
                  ))}
                  <th className="px-5 py-3 text-right text-xs font-medium text-slate-400 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {loading ? (
                  <tr>
                    <td colSpan={7} className="px-5 py-16 text-center">
                      <div className="flex flex-col items-center gap-3">
                        <div className="w-8 h-8 rounded-full border-2 border-violet-500 border-t-transparent animate-spin" />
                        <p className="text-slate-400 text-sm">Loading employees…</p>
                      </div>
                    </td>
                  </tr>
                ) : employees.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-5 py-16 text-center">
                      <div className="flex flex-col items-center gap-3">
                        <svg className="w-12 h-12 text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                        <p className="text-slate-400 text-sm">
                          {search || department || status ? 'No employees match your filters.' : 'No employees yet. Add your first employee!'}
                        </p>
                        {!search && !department && !status && (
                          <button
                            type="button"
                            onClick={openCreate}
                            className="mt-1 text-violet-400 hover:text-violet-300 text-sm font-medium transition-colors"
                          >
                            + Add Employee
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ) : (
                  employees.map((emp) => (
                    <tr
                      key={emp._id}
                      className="hover:bg-slate-800/40 transition-colors group"
                    >
                      {/* Name + email */}
                      <td className="px-5 py-3.5">
                        <div>
                          <p className="font-medium text-white">
                            {emp.firstName} {emp.lastName}
                          </p>
                          <p className="text-xs text-slate-500 mt-0.5">{emp.email}</p>
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-slate-300">{emp.department}</td>
                      <td className="px-5 py-3.5 text-slate-300">{emp.position}</td>
                      {/* Status badge */}
                      <td className="px-5 py-3.5">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${STATUS_COLORS[emp.status]}`}>
                          {STATUS_LABELS[emp.status]}
                        </span>
                      </td>
                      {/* Salary */}
                      <td className="px-5 py-3.5 text-slate-300">
                        ${emp.salary.toLocaleString()}
                      </td>
                      {/* Hire Date */}
                      <td className="px-5 py-3.5 text-slate-400 text-xs">
                        {new Date(emp.hireDate).toLocaleDateString('en-US', {
                          month: 'short', day: 'numeric', year: 'numeric',
                        })}
                      </td>
                      {/* Actions */}
                      <td className="px-5 py-3.5">
                        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            type="button"
                            onClick={() => openEdit(emp)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
                            title="Edit employee"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(emp)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                            title="Delete employee"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {pagination.totalPages > 1 && (
            <div className="px-5 py-4 border-t border-slate-800 flex items-center justify-between">
              <p className="text-sm text-slate-500">
                Showing {((page - 1) * LIMIT) + 1}–{Math.min(page * LIMIT, pagination.total)} of {pagination.total} employees
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={!pagination.hasPrevPage}
                  className="px-3 py-1.5 rounded-lg text-sm text-slate-400 hover:text-white hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  ← Prev
                </button>
                {/* Page numbers */}
                {Array.from({ length: pagination.totalPages }, (_, i) => i + 1)
                  .filter((p) => Math.abs(p - page) <= 2)
                  .map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPage(p)}
                      className={`w-8 h-8 rounded-lg text-sm font-medium transition-colors ${
                        p === page
                          ? 'bg-violet-600 text-white'
                          : 'text-slate-400 hover:text-white hover:bg-slate-800'
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
                  disabled={!pagination.hasNextPage}
                  className="px-3 py-1.5 rounded-lg text-sm text-slate-400 hover:text-white hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* ── Modals ── */}
      {showModal && (
        <EmployeeModal
          employee={editingEmployee}
          onSuccess={handleModalSuccess}
          onClose={() => setShowModal(false)}
        />
      )}

      {deleteTarget && (
        <DeleteConfirmModal
          employee={deleteTarget}
          onConfirm={handleDeleteConfirm}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
