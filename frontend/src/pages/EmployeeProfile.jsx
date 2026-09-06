import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import * as employeeService from '../services/employeeService';
import * as salaryService from '../services/salaryService';

const money = (value) =>
  typeof value === 'number'
    ? new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        minimumFractionDigits: 2,
      }).format(value)
    : 'Not available';

const emptyForm = {
  effectiveFrom: '',
  basic: '',
  hra: '',
  conveyanceAllowance: '',
  medicalAllowance: '',
  specialAllowance: '',
  otherAllowances: '',
  currency: 'INR',
  payFrequency: 'monthly',
  workState: 'MH',
  pfEnrolled: true,
  esiEnrolled: true,
  ptEnrolled: true,
  pfWageOverride: '',
  remarks: '',
};

export default function EmployeeProfile() {
  const { id } = useParams();

  const [employee, setEmployee] = useState(null);
  const [current, setCurrent] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showRevision, setShowRevision] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);

    try {
      const [
        employeeResult,
        currentResult,
        historyResult,
      ] = await Promise.all([
        employeeService.getEmployee(id),
        salaryService.getCurrentSalary(id),
        salaryService.getSalaryHistory(id),
      ]);

      setEmployee(employeeResult.data?.employee);
      setCurrent(currentResult.data?.salary);
      setHistory(historyResult.data?.salaries || []);
    } catch (err) {
      setError(
        err.response?.data?.message ||
          'Unable to load employee profile.'
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [id]);

  const update = (event) => {
    const {
      name,
      value,
      type,
      checked,
    } = event.target;

    setForm((previous) => ({
      ...previous,
      [name]:
        type === 'checkbox'
          ? checked
          : value,
    }));
  };

  const submitRevision = async (event) => {
    event.preventDefault();

    setSaving(true);
    setError('');

    const components = {};

    [
      'basic',
      'hra',
      'conveyanceAllowance',
      'medicalAllowance',
      'specialAllowance',
      'otherAllowances',
    ].forEach((field) => {
      components[field] = Number(form[field] || 0);
    });

    try {
      await salaryService.createSalaryRevision(id, {
        effectiveFrom: form.effectiveFrom,
        components,
        currency: form.currency,
        payFrequency: form.payFrequency,
        workState: form.workState,
        pfEnrolled: form.pfEnrolled,
        esiEnrolled: form.esiEnrolled,
        ptEnrolled: form.ptEnrolled,
        pfWageOverride:
          form.pfWageOverride === ''
            ? undefined
            : Number(form.pfWageOverride),
        remarks: form.remarks || undefined,
      });

      setShowRevision(false);
      setForm(emptyForm);

      await load();
    } catch (err) {
      setError(
        err.response?.data?.message ||
          'Salary revision failed.'
      );
    } finally {
      setSaving(false);
    }
  };

  /* ==================== LOADING ==================== */

  if (loading) {
    return (
      <div className="panel py-16 text-center text-sm text-[#6F6565]">
        Loading employee profile...
      </div>
    );
  }

  /* ==================== NOT FOUND ==================== */

  if (!employee) {
    return (
      <div className="alert alert-danger">
        {error || 'Employee not found.'}
      </div>
    );
  }

  return (
    <div className="space-y-8">

      {/* ==================== BACK LINK ==================== */}

      <Link
        to="/employees"
        className="text-sm font-semibold transition hover:underline"
        style={{ color: '#A6192E' }}
      >
        ← Employees
      </Link>

      {/* ==================== PAGE HEADER ==================== */}

      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">

        <div>
          <p
            className="eyebrow"
            style={{ color: '#A6192E' }}
          >
            Payroll employee profile
          </p>

          <h1
            className="page-title"
            style={{ color: '#241F20' }}
          >
            {employee.employeeCode ||
              `${employee.firstName} ${employee.lastName}`}
          </h1>

          <p
            className="page-subtitle"
            style={{ color: '#6F6565' }}
          >
            {employee.firstName} {employee.lastName} ·{' '}
            {employee.status || 'Status unavailable'}
          </p>
        </div>

        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setShowRevision(true)}
        >
          Change salary
        </button>

      </div>

      {/* ==================== ERROR ==================== */}

      {error && (
        <div
          className="alert alert-danger"
          role="alert"
        >
          {error}
        </div>
      )}

      {/* ==================== EMPLOYEE + CURRENT SALARY ==================== */}

      <div className="grid gap-6 lg:grid-cols-2">

        {/* EMPLOYMENT CONTEXT */}

        <section className="panel">

          <p
            className="eyebrow"
            style={{ color: '#A6192E' }}
          >
            Overview
          </p>

          <h2
            className="section-title"
            style={{ color: '#241F20' }}
          >
            Employment context
          </h2>

          <Rows
            rows={[
              ['Department', employee.department],
              ['Position', employee.position],
              [
                'Joining date',
                employee.hireDate &&
                  formatDate(employee.hireDate),
              ],
              ['Employment status', employee.status],
            ]}
          />

        </section>

        {/* CURRENT SALARY */}

        <section className="panel">

          <p
            className="eyebrow"
            style={{ color: '#A6192E' }}
          >
            Current salary
          </p>

          <h2
            className="section-title"
            style={{ color: '#241F20' }}
          >
            Authoritative salary version
          </h2>

          {current ? (
            <Rows
              rows={[
                [
                  'Gross monthly',
                  money(current.grossMonthly),
                ],
                [
                  'Effective from',
                  formatDate(current.effectiveFrom),
                ],
                ['Work state', current.workState],
                [
                  'PF',
                  current.pfEnrolled
                    ? 'Enrolled'
                    : 'Not enrolled',
                ],
                [
                  'ESI',
                  current.esiEnrolled
                    ? 'Enrolled'
                    : 'Not enrolled',
                ],
                [
                  'PT',
                  current.ptEnrolled
                    ? 'Enrolled'
                    : 'Not enrolled',
                ],
              ]}
            />
          ) : (
            <div className="empty-state">

              <p
                className="font-semibold"
                style={{ color: '#241F20' }}
              >
                No salary version available.
              </p>

              <p
                className="mt-1 text-sm"
                style={{ color: '#6F6565' }}
              >
                Create a salary version before payroll
                preflight.
              </p>

            </div>
          )}

        </section>

      </div>

      {/* ==================== SALARY HISTORY ==================== */}

      <section className="panel">

        <div className="flex items-center justify-between">

          <div>
            <p
              className="eyebrow"
              style={{ color: '#A6192E' }}
            >
              Versioned compensation
            </p>

            <h2
              className="section-title"
              style={{ color: '#241F20' }}
            >
              Salary History
            </h2>
          </div>

          <span className="status status-neutral">
            Historical records read-only
          </span>

        </div>

        {history.length === 0 ? (

          <div className="empty-state">

            <p
              className="font-semibold"
              style={{ color: '#241F20' }}
            >
              No salary history available.
            </p>

          </div>

        ) : (

          <div className="pg-scrollbar mt-5 overflow-x-auto">

            <table className="data-table">

              <thead>
                <tr>
                  <th>Effective period</th>
                  <th>Basic</th>
                  <th>HRA</th>
                  <th>Allowances</th>
                  <th>Gross monthly</th>
                  <th>Status</th>
                </tr>
              </thead>

              <tbody>

                {history.map((salary) => (

                  <tr key={salary._id}>

                    <td>
                      {formatDate(salary.effectiveFrom)}
                      {' → '}
                      {salary.effectiveTo
                        ? formatDate(salary.effectiveTo)
                        : 'Current'}
                    </td>

                    <td>
                      {money(
                        salary.components?.basic
                      )}
                    </td>

                    <td>
                      {money(
                        salary.components?.hra
                      )}
                    </td>

                    <td>
                      {money(
                        (salary.components
                          ?.conveyanceAllowance || 0) +
                          (salary.components
                            ?.medicalAllowance || 0) +
                          (salary.components
                            ?.specialAllowance || 0) +
                          (salary.components
                            ?.otherAllowances || 0)
                      )}
                    </td>

                    <td
                      className="font-semibold"
                      style={{ color: '#241F20' }}
                    >
                      {money(salary.grossMonthly)}
                    </td>

                    <td>
                      <span
                        className={`status ${
                          salary.effectiveTo
                            ? 'status-neutral'
                            : 'status-success'
                        }`}
                      >
                        {salary.effectiveTo
                          ? 'Historical · read only'
                          : 'Current'}
                      </span>
                    </td>

                  </tr>

                ))}

              </tbody>

            </table>

          </div>

        )}

      </section>

      {/* ==================== SALARY REVISION DIALOG ==================== */}

      {showRevision && (
        <RevisionDialog
          form={form}
          update={update}
          submit={submitRevision}
          saving={saving}
          onClose={() => setShowRevision(false)}
        />
      )}

    </div>
  );
}


/* ============================================================
   REVISION DIALOG
============================================================ */

function RevisionDialog({
  form,
  update,
  submit,
  saving,
  onClose,
}) {
  const fields = [
    ['basic', 'Basic'],
    ['hra', 'HRA'],
    ['conveyanceAllowance', 'Conveyance allowance'],
    ['medicalAllowance', 'Medical allowance'],
    ['specialAllowance', 'Special allowance'],
    ['otherAllowances', 'Other allowances'],
  ];

  return (
    <div className="dialog-backdrop">

      <form
        className="dialog max-w-2xl"
        onSubmit={submit}
      >

        {/* MODAL HEADER */}

        <div className="flex items-start justify-between">

          <div>
            <p
              className="eyebrow"
              style={{ color: '#A6192E' }}
            >
              Versioned salary
            </p>

            <h2
              className="section-title"
              style={{ color: '#241F20' }}
            >
              Change salary
            </h2>
          </div>

          <button
            type="button"
            className="icon-button"
            aria-label="Close salary dialog"
            onClick={onClose}
            style={{ color: '#A6192E' }}
          >
            ×
          </button>

        </div>

        <p
          className="mt-3 text-sm leading-6"
          style={{ color: '#6F6565' }}
        >
          Creating a new salary version does not modify
          finalized payroll history. Gross monthly is
          calculated and stored by the backend.
        </p>

        {/* FORM */}

        <div className="mt-6 grid gap-4 sm:grid-cols-2">

          <label className="label">
            Effective from

            <input
              required
              name="effectiveFrom"
              type="date"
              className="field mt-2"
              value={form.effectiveFrom}
              onChange={update}
            />
          </label>

          <label className="label">
            Work state

            <input
              required
              name="workState"
              className="field mt-2"
              value={form.workState}
              onChange={update}
            />
          </label>

          {fields.map(([name, label]) => (

            <label
              className="label"
              key={name}
            >
              {label}

              <input
                name={name}
                type="number"
                min="0"
                step="0.01"
                className="field mt-2"
                value={form[name]}
                onChange={update}
              />
            </label>

          ))}

        </div>

        {/* STATUTORY ENROLLMENT */}

        <div className="mt-5 flex flex-wrap gap-5 text-sm text-[#241F20]">

          <label className="flex items-center gap-2">
            <input
              name="pfEnrolled"
              type="checkbox"
              checked={form.pfEnrolled}
              onChange={update}
              className="accent-[#A6192E]"
            />
            PF enrolled
          </label>

          <label className="flex items-center gap-2">
            <input
              name="esiEnrolled"
              type="checkbox"
              checked={form.esiEnrolled}
              onChange={update}
              className="accent-[#A6192E]"
            />
            ESI enrolled
          </label>

          <label className="flex items-center gap-2">
            <input
              name="ptEnrolled"
              type="checkbox"
              checked={form.ptEnrolled}
              onChange={update}
              className="accent-[#A6192E]"
            />
            PT enrolled
          </label>

        </div>

        {/* ACTIONS */}

        <div className="mt-7 flex justify-end gap-3">

          <button
            type="button"
            className="btn"
            onClick={onClose}
          >
            Cancel
          </button>

          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving}
          >
            {saving
              ? 'Saving...'
              : 'Create salary version'}
          </button>

        </div>

      </form>

    </div>
  );
}


/* ============================================================
   DETAIL ROWS
============================================================ */

function Rows({ rows }) {
  return (
    <dl className="mt-5 divide-y divide-[#E7D8D5] text-sm">

      {rows.map(([label, value]) => (

        <div
          key={label}
          className="flex justify-between gap-4 py-3"
        >

          <dt
            style={{ color: '#6F6565' }}
          >
            {label}
          </dt>

          <dd
            className="text-right font-medium"
            style={{ color: '#241F20' }}
          >
            {value || 'Not available'}
          </dd>

        </div>

      ))}

    </dl>
  );
}


/* ============================================================
   DATE FORMATTER
============================================================ */

function formatDate(value) {
  return value
    ? new Date(value).toLocaleDateString('en-IN')
    : 'Not available';
}