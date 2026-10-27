import { useContext, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AuthContext } from '../contexts/AuthContext';
import { can } from '../utils/permissions';
import * as employeeService from '../services/employeeService';
import * as profileService from '../services/employeeProfileService';
import axiosInstance from '../services/axiosInstance';
import EmployeeModal from '../components/EmployeeModal';
import DeleteConfirmModal from '../components/DeleteConfirmModal';
import { ReadinessBadge, monthLabel } from '../components/employee360/shared';
import Icon from '../components/ui/Icon';
import { PageHeader, EmptyState, LoadingState } from '../components/ui/PageParts';

export default function Employees() {
  const { user } = useContext(AuthContext);
  const canWrite = can(user, 'employee.write');
  const canArchive = can(user, 'employee.archive');
  const canManageAccounts = can(user, 'employee_account.manage');
  const canReadPayroll = can(user, 'payroll.read');

  // Next payroll period readiness, one request for the whole directory.
  const [readiness, setReadiness] = useState(null);

  useEffect(() => {
    if (!canReadPayroll) return;
    profileService
      .getCompanyReadiness()
      .then((result) => setReadiness(result.data))
      .catch(() => setReadiness(null));
  }, [canReadPayroll]);

  const readinessById = new Map((readiness?.employees || []).map((entry) => [entry.employeeId, entry]));

  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [showArchived, setShowArchived] = useState(false);

  // Employee login account state
  const [accountTarget, setAccountTarget] = useState(null);
  const [accountPassword, setAccountPassword] = useState('');
  const [accountConfirmPassword, setAccountConfirmPassword] = useState('');
  const [accountError, setAccountError] = useState('');
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountSuccess, setAccountSuccess] = useState('');

  const load = () => {
    setLoading(true);
    setError('');

    employeeService
      .getEmployees({ limit: 50, search, ...(showArchived && { archived: 'true' }) })
      .then((r) => setEmployees(r.data?.employees || []))
      .catch((e) =>
        setError(
          e.response?.data?.message || 'Unable to load employees.'
        )
      )
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    const timer = setTimeout(load, 250);

    return () => clearTimeout(timer);
  }, [search, showArchived]);

  const afterMutation = () => {
    setModal(null);
    setDeleteTarget(null);
    load();
  };

  const restoreEmployee = async (employee) => {
    setError('');
    try {
      await employeeService.restoreEmployee(employee._id);
      load();
    } catch (e) {
      setError(e.response?.data?.message || 'Unable to restore the employee.');
    }
  };

  const openAccountModal = (employee) => {
    setAccountTarget(employee);
    setAccountPassword('');
    setAccountConfirmPassword('');
    setAccountError('');
    setAccountSuccess('');
  };

  const closeAccountModal = () => {
    if (accountLoading) return;

    setAccountTarget(null);
    setAccountPassword('');
    setAccountConfirmPassword('');
    setAccountError('');
    setAccountSuccess('');
  };

  const createLoginAccount = async (event) => {
    event.preventDefault();

    setAccountError('');
    setAccountSuccess('');

    if (!accountPassword || !accountConfirmPassword) {
      setAccountError('Please enter and confirm the password.');
      return;
    }

    if (accountPassword.length < 8) {
      setAccountError('Password must be at least 8 characters.');
      return;
    }

    if (accountPassword !== accountConfirmPassword) {
      setAccountError('Passwords do not match.');
      return;
    }

    if (!accountTarget?._id) {
      setAccountError('Employee information is missing.');
      return;
    }

    setAccountLoading(true);

    try {
      await axiosInstance.post('/employee-accounts', {
        employeeId: accountTarget._id,
        password: accountPassword,
      });

      setAccountSuccess(
        'Login account created successfully.'
      );

      setAccountPassword('');
      setAccountConfirmPassword('');

      setTimeout(() => {
        closeAccountModal();
      }, 1000);
    } catch (e) {
      setAccountError(
        e.response?.data?.message ||
          'Unable to create the employee login account.'
      );
    } finally {
      setAccountLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Payroll workforce"
        title="Employees"
        subtitle="Employee records and whether each one can be calculated in the next payroll."
        actions={canWrite && (
          <button type="button" className="btn btn-primary" onClick={() => setModal({ employee: null })}>
            <Icon name="plus" size={16} /> Add employee
          </button>
        )}
      />

      <section className="panel !p-0" aria-labelledby="directory-title">
        <div className="flex flex-col gap-4 px-5 pt-5 sm:px-6 sm:pt-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="eyebrow">Directory</p>
            <h2 className="section-title" id="directory-title">Payroll employee directory</h2>
            {readiness && (
              <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-2" aria-label="Payroll readiness summary">
                <span>{monthLabel(readiness.period.periodYear, readiness.period.periodMonth)} payroll:</span>
                <span className="inline-flex items-center gap-1 font-semibold text-ok"><Icon name="check-circle" size={14} strokeWidth={2} />{readiness.summary.ready} ready</span>
                <span className="inline-flex items-center gap-1 font-semibold text-warn"><Icon name="alert-triangle" size={14} strokeWidth={2} />{readiness.summary.warning} need attention</span>
                <span className="inline-flex items-center gap-1 font-semibold text-bad"><Icon name="x-circle" size={14} strokeWidth={2} />{readiness.summary.blocked} blocked</span>
              </p>
            )}
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <label className="inline-flex min-h-[40px] items-center gap-2 text-sm text-ink-2">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
                className="h-4 w-4 accent-crimson"
              />
              Show archived
            </label>
            <input
              type="search"
              aria-label="Search employees"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, email, department"
              className="field sm:w-80"
            />
          </div>
        </div>

        {error && <div className="alert alert-danger mx-5 mt-5 sm:mx-6" role="alert">{error}</div>}

        <div tabIndex={0} className="pg-scrollbar mt-4 overflow-x-auto border-t border-line">
          {loading ? (
            <div className="px-6 py-6"><LoadingState label="Loading employees" /></div>
          ) : employees.length === 0 ? (
            search.trim() ? (
              <EmptyState title={`No employee matches “${search.trim()}”`}>
                Search looks at names, email addresses and departments{showArchived ? ', including archived records' : ''}.
              </EmptyState>
            ) : (
              <EmptyState
                kind="blocked"
                title={showArchived ? 'No employee records, including archived' : 'No employee records yet'}
                action={canWrite ? (
                  <button type="button" className="btn btn-primary" onClick={() => setModal({ employee: null })}>
                    <Icon name="plus" size={16} /> Add the first employee
                  </button>
                ) : null}
              >
                Payroll needs at least one active employee with a salary version before a run can calculate anyone.
              </EmptyState>
            )
          ) : (

            <table className="data-table">

              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Department</th>
                  <th>Salary Context</th>
                  <th>Employment</th>
                  <th>Payroll readiness</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>

              <tbody>

                {employees.map((employee) => {

                  const isActive = employee.status === 'active';

                  return (
                    <tr key={employee._id}>

                      {/* EMPLOYEE */}
                      <td>

                        <Link
                          to={`/employees/${employee._id}`}
                          className="font-semibold transition hover:underline"
                          style={{ color: 'var(--pg-crimson)' }}
                        >
                          {employee.firstName} {employee.lastName}
                        </Link>

                        <span
                          className="block text-xs"
                          style={{ color: 'var(--pg-ink-2)' }}
                        >
                          {employee.employeeCode || employee.email}
                        </span>

                      </td>

                      {/* DEPARTMENT */}
                      <td>

                        <span style={{ color: 'var(--pg-ink)' }}>
                          {employee.department || 'Not available'}
                        </span>

                        <span
                          className="block text-xs"
                          style={{ color: 'var(--pg-ink-2)' }}
                        >
                          {employee.position || 'Not available'}
                        </span>

                      </td>

                      {/* SALARY */}
                      <td>

                        <span
                          className="text-xs"
                          style={{ color: 'var(--pg-ink-2)' }}
                        >
                          Not payroll-authoritative
                        </span>

                      </td>

                      {/* EMPLOYMENT */}
                      <td>

                        <span className="status status-neutral">
                          ● {employee.status || 'UNKNOWN'}
                        </span>

                      </td>

                      {/* PAYROLL READINESS */}
                      <td>
                        {readiness ? (() => {
                          const entry = readinessById.get(employee._id);
                          const reasons = entry ? [...entry.blockers, ...entry.warnings] : [];
                          return (
                            <>
                              <ReadinessBadge state={entry?.state} title={reasons.map((r) => r.message).join('\n')} />
                              {reasons.length > 0 && (
                                <span className="mt-1 block text-xs text-ink-2">
                                  {reasons[0].message.split('. ')[0]}
                                  {reasons.length > 1 && ` (+${reasons.length - 1} more)`}
                                </span>
                              )}
                            </>
                          );
                        })() : (
                          <span className="text-xs text-ink-2">Open the employee for details</span>
                        )}
                      </td>

                      {/* ACTIONS */}
                      <td>

                        <div className="flex justify-end gap-2">

                          {employee.isDeleted ? (canArchive && (
                            <button
                              type="button"
                              className="btn btn-small"
                              onClick={() => restoreEmployee(employee)}
                              style={{
                                backgroundColor: 'var(--pg-surface)',
                                borderColor: 'var(--pg-line)',
                                color: 'var(--pg-crimson)',
                              }}
                            >
                              Restore
                            </button>
                          )) : (
                          <>

                          {/* EDIT */}
                          {canWrite && (
                          <button
                            type="button"
                            className="btn btn-small"
                            onClick={() => setModal({ employee })}
                            style={{
                              backgroundColor: 'var(--pg-surface)',
                              borderColor: 'var(--pg-line)',
                              color: 'var(--pg-crimson)',
                            }}
                          >
                            Edit
                          </button>
                          )}

                          {/* CREATE LOGIN */}
                          {canManageAccounts && (
                          <button
                            type="button"
                            className="btn btn-small"
                            disabled={!isActive}
                            onClick={() => openAccountModal(employee)}
                            title={
                              isActive
                                ? 'Create employee login account'
                                : 'Login accounts can only be created for active employees'
                            }
                            style={{
                              backgroundColor: isActive
                                ? 'var(--pg-crimson-tint)'
                                : 'var(--pg-canvas-2)',
                              borderColor: isActive
                                ? 'var(--pg-line)'
                                : 'var(--pg-line)',
                              color: isActive
                                ? 'var(--pg-crimson)'
                                : 'var(--pg-ink-2)',
                              cursor: isActive
                                ? 'pointer'
                                : 'not-allowed',
                              opacity: isActive ? 1 : 0.65,
                            }}
                          >
                            Create Login
                          </button>
                          )}

                          {/* ARCHIVE */}
                          {canArchive && (
                          <button
                            type="button"
                            className="btn btn-small"
                            onClick={() => setDeleteTarget(employee)}
                            style={{
                              backgroundColor: 'var(--pg-surface)',
                              borderColor: 'var(--pg-line)',
                              color: 'var(--pg-bad)',
                            }}
                          >
                            Archive
                          </button>
                          )}
                          </>
                          )}

                        </div>

                      </td>

                    </tr>
                  );
                })}

              </tbody>

            </table>

          )}

        </div>

      </section>

      {/* ==================== ADD / EDIT EMPLOYEE ==================== */}
      {modal && (
        <EmployeeModal
          employee={modal.employee}
          onSuccess={afterMutation}
          onClose={() => setModal(null)}
        />
      )}

      {/* ==================== DEACTIVATE CONFIRMATION ==================== */}
      {deleteTarget && (
        <DeleteConfirmModal
          employee={deleteTarget}
          onConfirm={async () => {
            try {
              await employeeService.deleteEmployee(deleteTarget._id);
              afterMutation();
            } catch (e) {
              setDeleteTarget(null);
              setError(e.response?.data?.message || 'Unable to archive the employee.');
            }
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* ==================== CREATE EMPLOYEE LOGIN MODAL ==================== */}
      {accountTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          style={{
            backgroundColor: 'rgba(36, 31, 32, 0.45)',
          }}
        >

          <div
            className="w-full max-w-md rounded-xl border p-6 shadow-xl"
            style={{
              backgroundColor: 'var(--pg-porcelain)',
              borderColor: 'var(--pg-line)',
            }}
          >

            {/* MODAL HEADER */}
            <div className="mb-6">

              <p
                className="eyebrow"
              >
                Employee access
              </p>

              <h2
                className="text-xl font-semibold"
                style={{ color: 'var(--pg-ink)' }}
              >
                Create login account
              </h2>

              <p
                className="mt-2 text-sm"
                style={{ color: 'var(--pg-ink-2)' }}
              >
                Create login credentials for{' '}
                <strong style={{ color: 'var(--pg-ink)' }}>
                  {accountTarget.firstName}{' '}
                  {accountTarget.lastName}
                </strong>.
              </p>

            </div>

            {/* EMPLOYEE DETAILS */}
            <div
              className="mb-5 rounded-lg border p-4"
              style={{
                backgroundColor: 'var(--pg-crimson-tint)',
                borderColor: 'var(--pg-line)',
              }}
            >

              <p
                className="text-sm font-semibold"
                style={{ color: 'var(--pg-ink)' }}
              >
                {accountTarget.firstName}{' '}
                {accountTarget.lastName}
              </p>

              <p
                className="mt-1 text-xs"
                style={{ color: 'var(--pg-ink-2)' }}
              >
                {accountTarget.email}
              </p>

              <p
                className="mt-1 text-xs"
                style={{ color: 'var(--pg-ink-2)' }}
              >
                Role: Employee
              </p>

            </div>

            <form onSubmit={createLoginAccount}>

              {/* PASSWORD */}
              <div className="mb-4">

                <label
                  htmlFor="employee-account-password"
                  className="mb-2 block text-sm font-medium"
                  style={{ color: 'var(--pg-ink)' }}
                >
                  Initial password
                </label>

                <input
                  id="employee-account-password"
                  type="password"
                  value={accountPassword}
                  onChange={(e) =>
                    setAccountPassword(e.target.value)
                  }
                  placeholder="Minimum 8 characters"
                  minLength={8}
                  autoComplete="new-password"
                  className="field w-full"
                  disabled={accountLoading}
                  style={{
                    backgroundColor: 'var(--pg-surface)',
                    borderColor: 'var(--pg-line)',
                    color: 'var(--pg-ink)',
                  }}
                />

              </div>

              {/* CONFIRM PASSWORD */}
              <div className="mb-4">

                <label
                  htmlFor="employee-account-confirm-password"
                  className="mb-2 block text-sm font-medium"
                  style={{ color: 'var(--pg-ink)' }}
                >
                  Confirm password
                </label>

                <input
                  id="employee-account-confirm-password"
                  type="password"
                  value={accountConfirmPassword}
                  onChange={(e) =>
                    setAccountConfirmPassword(e.target.value)
                  }
                  placeholder="Re-enter password"
                  minLength={8}
                  autoComplete="new-password"
                  className="field w-full"
                  disabled={accountLoading}
                  style={{
                    backgroundColor: 'var(--pg-surface)',
                    borderColor: 'var(--pg-line)',
                    color: 'var(--pg-ink)',
                  }}
                />

              </div>

              {/* ERROR */}
              {accountError && (
                <div
                  className="mb-4 rounded-lg border px-4 py-3 text-sm"
                  role="alert"
                  style={{
                    backgroundColor: 'var(--pg-crimson-tint)',
                    borderColor: 'var(--pg-line)',
                    color: 'var(--pg-bad)',
                  }}
                >
                  {accountError}
                </div>
              )}

              {/* SUCCESS */}
              {accountSuccess && (
                <div
                  className="mb-4 rounded-lg border px-4 py-3 text-sm"
                  role="status"
                  style={{
                    backgroundColor: 'var(--pg-ok-tint)',
                    borderColor: 'var(--pg-ok-line)',
                    color: 'var(--pg-ok)',
                  }}
                >
                  {accountSuccess}
                </div>
              )}

              {/* BUTTONS */}
              <div className="flex justify-end gap-3 pt-2">

                <button
                  type="button"
                  className="btn btn-small"
                  onClick={closeAccountModal}
                  disabled={accountLoading}
                  style={{
                    backgroundColor: 'var(--pg-surface)',
                    borderColor: 'var(--pg-line)',
                    color: 'var(--pg-ink-2)',
                  }}
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  className="btn btn-small"
                  disabled={accountLoading}
                  style={{
                    backgroundColor: 'var(--pg-crimson)',
                    borderColor: 'var(--pg-crimson)',
                    color: 'var(--pg-surface)',
                    opacity: accountLoading ? 0.7 : 1,
                  }}
                >
                  {accountLoading
                    ? 'Creating...'
                    : 'Create Login'}
                </button>

              </div>

            </form>

          </div>

        </div>
      )}

    </div>
  );
}