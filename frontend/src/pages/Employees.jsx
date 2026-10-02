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
    <div className="space-y-8">

      {/* ==================== PAGE HEADER ==================== */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">

        <div>
          <p
            className="eyebrow"
            style={{ color: '#A6192E' }}
          >
            Payroll workforce
          </p>

          <h1
            className="page-title"
            style={{ color: '#241F20' }}
          >
            Employees
          </h1>

          <p
            className="page-subtitle"
            style={{ color: '#6F6565' }}
          >
            Employee identity and payroll eligibility context.
          </p>
        </div>

        {canWrite && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setModal({ employee: null })}
            style={{
              backgroundColor: '#A6192E',
              borderColor: '#A6192E',
              color: '#FFFFFF',
            }}
          >
            Add employee <span aria-hidden="true">+</span>
          </button>
        )}

      </div>

      {/* ==================== DIRECTORY ==================== */}
      <section
        className="panel"
        style={{
          backgroundColor: '#FFFFFF',
          borderColor: '#E7D8D5',
        }}
      >

        {/* DIRECTORY HEADER */}
        <div
          className="flex flex-col gap-4 border-b pb-5 sm:flex-row sm:items-center sm:justify-between"
          style={{ borderColor: '#E7D8D5' }}
        >

          <div>
            <p
              className="eyebrow"
              style={{ color: '#A6192E' }}
            >
              Directory
            </p>

            <h2
              className="section-title"
              style={{ color: '#241F20' }}
            >
              Payroll employee directory
            </h2>

            {readiness && (
              <p className="mt-2 text-sm text-[#5F5555]" aria-label="Payroll readiness summary">
                {monthLabel(readiness.period.periodYear, readiness.period.periodMonth)} payroll:{' '}
                <span className="font-semibold text-[#26765F]">{readiness.summary.ready} ready</span>
                {' · '}
                <span className="font-semibold text-[#845B00]">{readiness.summary.warning} need attention</span>
                {' · '}
                <span className="font-semibold text-[#A33D35]">{readiness.summary.blocked} blocked</span>
              </p>
            )}
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <label className="flex items-center gap-2 text-sm text-[#6F6565]">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="accent-[#A6192E]"
            />
            Show archived
          </label>

          <input
            aria-label="Search employees"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email, department"
            className="field sm:w-80"
            style={{
              backgroundColor: '#FFFDF8',
              borderColor: '#E7D8D5',
              color: '#241F20',
            }}
          />
          </div>

        </div>

        {/* ERROR */}
        {error && (
          <div
            className="alert alert-danger mt-5"
            role="alert"
          >
            {error}
          </div>
        )}

        {/* ==================== TABLE ==================== */}
        <div className="pg-scrollbar mt-5 overflow-x-auto">

          {loading ? (
            <div
              className="py-16 text-center text-sm"
              style={{ color: '#6F6565' }}
            >
              Loading employees...
            </div>
          ) : employees.length === 0 ? (

            <div className="empty-state">

              <p
                className="font-semibold"
                style={{ color: '#241F20' }}
              >
                No employees found.
              </p>

              <p
                className="mt-1 text-sm"
                style={{ color: '#6F6565' }}
              >
                Try another search or add an employee record.
              </p>

            </div>

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
                          style={{ color: '#A6192E' }}
                        >
                          {employee.firstName} {employee.lastName}
                        </Link>

                        <span
                          className="block text-xs"
                          style={{ color: '#6F6565' }}
                        >
                          {employee.employeeCode || employee.email}
                        </span>

                      </td>

                      {/* DEPARTMENT */}
                      <td>

                        <span style={{ color: '#241F20' }}>
                          {employee.department || 'Not available'}
                        </span>

                        <span
                          className="block text-xs"
                          style={{ color: '#6F6565' }}
                        >
                          {employee.position || 'Not available'}
                        </span>

                      </td>

                      {/* SALARY */}
                      <td>

                        <span
                          className="text-xs"
                          style={{ color: '#6F6565' }}
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
                                <span className="mt-1 block text-xs text-[#6F6565]">
                                  {reasons[0].message.split('. ')[0]}
                                  {reasons.length > 1 && ` (+${reasons.length - 1} more)`}
                                </span>
                              )}
                            </>
                          );
                        })() : (
                          <span className="text-xs text-[#6F6565]">Open the employee for details</span>
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
                                backgroundColor: '#FFFFFF',
                                borderColor: '#E7D8D5',
                                color: '#A6192E',
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
                              backgroundColor: '#FFFFFF',
                              borderColor: '#E7D8D5',
                              color: '#A6192E',
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
                                ? '#F8E8EA'
                                : '#F5F1EF',
                              borderColor: isActive
                                ? '#E7D8D5'
                                : '#E7D8D5',
                              color: isActive
                                ? '#A6192E'
                                : '#9A9090',
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
                              backgroundColor: '#FFFFFF',
                              borderColor: '#E7D8D5',
                              color: '#9B1C31',
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
              backgroundColor: '#FFFDF8',
              borderColor: '#E7D8D5',
            }}
          >

            {/* MODAL HEADER */}
            <div className="mb-6">

              <p
                className="eyebrow"
                style={{ color: '#A6192E' }}
              >
                Employee access
              </p>

              <h2
                className="text-xl font-semibold"
                style={{ color: '#241F20' }}
              >
                Create login account
              </h2>

              <p
                className="mt-2 text-sm"
                style={{ color: '#6F6565' }}
              >
                Create login credentials for{' '}
                <strong style={{ color: '#241F20' }}>
                  {accountTarget.firstName}{' '}
                  {accountTarget.lastName}
                </strong>.
              </p>

            </div>

            {/* EMPLOYEE DETAILS */}
            <div
              className="mb-5 rounded-lg border p-4"
              style={{
                backgroundColor: '#F8E8EA',
                borderColor: '#E7D8D5',
              }}
            >

              <p
                className="text-sm font-semibold"
                style={{ color: '#241F20' }}
              >
                {accountTarget.firstName}{' '}
                {accountTarget.lastName}
              </p>

              <p
                className="mt-1 text-xs"
                style={{ color: '#6F6565' }}
              >
                {accountTarget.email}
              </p>

              <p
                className="mt-1 text-xs"
                style={{ color: '#6F6565' }}
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
                  style={{ color: '#241F20' }}
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
                    backgroundColor: '#FFFFFF',
                    borderColor: '#E7D8D5',
                    color: '#241F20',
                  }}
                />

              </div>

              {/* CONFIRM PASSWORD */}
              <div className="mb-4">

                <label
                  htmlFor="employee-account-confirm-password"
                  className="mb-2 block text-sm font-medium"
                  style={{ color: '#241F20' }}
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
                    backgroundColor: '#FFFFFF',
                    borderColor: '#E7D8D5',
                    color: '#241F20',
                  }}
                />

              </div>

              {/* ERROR */}
              {accountError && (
                <div
                  className="mb-4 rounded-lg border px-4 py-3 text-sm"
                  role="alert"
                  style={{
                    backgroundColor: '#FBE9EC',
                    borderColor: '#E7D8D5',
                    color: '#9B1C31',
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
                    backgroundColor: '#EDF7EE',
                    borderColor: '#CFE5D1',
                    color: '#2E7D32',
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
                    backgroundColor: '#FFFFFF',
                    borderColor: '#E7D8D5',
                    color: '#6F6565',
                  }}
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  className="btn btn-small"
                  disabled={accountLoading}
                  style={{
                    backgroundColor: '#A6192E',
                    borderColor: '#A6192E',
                    color: '#FFFFFF',
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