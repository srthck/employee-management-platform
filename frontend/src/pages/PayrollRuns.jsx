import { useContext, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AuthContext } from '../contexts/AuthContext';
import * as payrollRunService from '../services/payrollRunService';
import { can } from '../utils/permissions';
import { Status, monthName } from './Overview';

export default function PayrollRuns() {
  const { user } = useContext(AuthContext);
  const canPrepare = can(user, 'payroll.prepare');
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [year, setYear] = useState(new Date().getFullYear());
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);

    payrollRunService
      .listPayrollRuns({ limit: 100 })
      .then((r) => setRuns(r.data?.runs || []))
      .catch((e) =>
        setError(
          e.response?.data?.message ||
            'Unable to load payroll runs.'
        )
      )
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const create = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');

    try {
      const result = await payrollRunService.createPayrollRun({
        periodMonth: Number(month),
        periodYear: Number(year),
        idempotencyKey: `payguard-${year}-${month}`,
      });

      window.location.href = `/payroll/${result.data.run._id}`;
    } catch (e2) {
      setError(
        e2.response?.data?.message ||
          'Payroll run could not be created.'
      );
      setSaving(false);
    }
  };

  return (
    <div className="space-y-8">

      {/* PAGE HEADER */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="eyebrow text-[#A6192E]">
            Payroll operations
          </p>

          <h1 className="page-title text-[#241F20]">
            Payroll Runs
          </h1>

          <p className="page-subtitle text-[#6F6565]">
            Create, preflight, process, and finalize calendar-month payroll.
          </p>
        </div>

        {canPrepare && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setShowCreate(true)}
          >
            Create payroll run{' '}
            <span aria-hidden="true">+</span>
          </button>
        )}
      </div>

      {/* ERROR */}
      {error && (
        <div className="alert alert-danger">
          {error}
        </div>
      )}

      {/* PAYROLL RUNS TABLE */}
      <section className="panel">
        <div className="pg-scrollbar overflow-x-auto">

          {loading ? (
            <div className="py-16 text-center text-sm text-[#6F6565]">
              Loading payroll runs...
            </div>
          ) : runs.length === 0 ? (
            <div className="empty-state">
              <p className="font-semibold text-[#241F20]">
                No payroll runs yet.
              </p>

              <p className="mt-1 text-sm text-[#6F6565]">
                Create the first run for a calendar month.
              </p>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Status</th>
                  <th>Employees</th>
                  <th>Processed</th>
                  <th>Snapshots</th>
                  <th>Created</th>
                  <th className="text-right">Action</th>
                </tr>
              </thead>

              <tbody>
                {runs.map((run) => (
                  <tr key={run._id}>

                    {/* PERIOD */}
                    <td>
                      <span className="font-semibold text-[#241F20]">
                        {monthName(
                          run.periodMonth,
                          run.periodYear
                        )}
                      </span>

                      <span className="block text-xs font-normal text-[#6F6565]">
                        {run.periodStart
                          ? new Date(
                              run.periodStart
                            ).toLocaleDateString('en-IN')
                          : 'Calendar month'}
                      </span>
                    </td>

                    {/* STATUS */}
                    <td>
                      <Status value={run.status} />
                    </td>

                    {/* EMPLOYEES */}
                    <td>
                      <span className="text-[#241F20]">
                        {run.employeeCount ?? 'Not available'}
                      </span>
                    </td>

                    {/* PROCESSED */}
                    <td>
                      <span className="text-[#241F20]">
                        {run.processedEmployeeCount ?? 0}
                        {' / '}
                        {run.employeeCount ?? 0}
                      </span>
                    </td>

                    {/* SNAPSHOTS */}
                    <td>
                      <span className="text-[#241F20]">
                        {run.durableResultCount ?? 'Not available'}
                      </span>
                    </td>

                    {/* CREATED */}
                    <td>
                      <span className="text-xs text-[#6F6565]">
                        {run.createdAt
                          ? new Date(
                              run.createdAt
                            ).toLocaleDateString('en-IN')
                          : 'Not available'}
                      </span>
                    </td>

                    {/* ACTION */}
                    <td className="text-right">
                      <Link
                        className="btn btn-small"
                        to={`/payroll/${run._id}`}
                      >
                        Open run
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* CREATE PAYROLL RUN DIALOG */}
      {showCreate && (
        <div className="dialog-backdrop">

          <form
            className="dialog"
            onSubmit={create}
          >

            {/* DIALOG HEADER */}
            <div className="flex items-start justify-between">
              <div>
                <p className="eyebrow text-[#A6192E]">
                  New operation
                </p>

                <h2 className="section-title text-[#241F20]">
                  Create payroll run
                </h2>
              </div>

              <button
                type="button"
                className="icon-button text-[#A6192E]"
                aria-label="Close dialog"
                onClick={() => setShowCreate(false)}
              >
                ×
              </button>
            </div>

            {/* DESCRIPTION */}
            <p className="mt-3 text-sm text-[#6F6565]">
              Single-tenant company context is derived by the server
              from your authenticated account.
            </p>

            {/* MONTH / YEAR */}
            <div className="mt-6 grid gap-4 sm:grid-cols-2">

              <label className="label text-[#241F20]">
                Payroll month

                <select
                  className="field mt-2 border-[#E7D8D5] bg-[#FFFDF8] text-[#241F20]"
                  value={month}
                  onChange={(e) => setMonth(e.target.value)}
                >
                  {Array.from(
                    { length: 12 },
                    (_, i) => (
                      <option
                        key={i + 1}
                        value={i + 1}
                      >
                        {new Date(
                          2020,
                          i,
                          1
                        ).toLocaleDateString('en-IN', {
                          month: 'long',
                        })}
                      </option>
                    )
                  )}
                </select>
              </label>

              <label className="label text-[#241F20]">
                Payroll year

                <input
                  className="field mt-2 border-[#E7D8D5] bg-[#FFFDF8] text-[#241F20]"
                  type="number"
                  min="2000"
                  max="2100"
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                />
              </label>
            </div>

            {/* ACTIONS */}
            <div className="mt-7 flex justify-end gap-3">

              <button
                type="button"
                className="btn"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>

              <button
                disabled={saving}
                className="btn btn-primary"
                type="submit"
              >
                {saving
                  ? 'Creating...'
                  : 'Create payroll run'}
              </button>

            </div>
          </form>
        </div>
      )}
    </div>
  );
}