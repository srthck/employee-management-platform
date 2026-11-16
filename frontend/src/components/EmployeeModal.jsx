import { useState, useEffect } from 'react';
import * as employeeService from '../services/employeeService';

const DEPARTMENTS = [
  'Engineering',
  'Marketing',
  'Sales',
  'Human Resources',
  'Finance',
  'Operations',
  'Design',
  'Legal',
  'Customer Support',
  'Other',
];

const EMPTY_FORM = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  department: '',
  position: '',
  salary: '',
  hireDate: '',
  status: 'active',
  notes: '',
};

function Field({
  id,
  name,
  label,
  type = 'text',
  placeholder,
  required,
  autoComplete,
  form,
  errors,
  handleChange,
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="label mb-1.5 block"
      >
        {label}
        {required && (
          <span className="ml-1 text-crimson">*</span>
        )}
      </label>

      <input
        id={id}
        name={name}
        type={type}
        autoComplete={autoComplete || 'off'}
        value={form[name]}
        onChange={handleChange}
        placeholder={placeholder}
        className={`w-full rounded-[9px] border bg-[var(--pg-well)] px-3.5 py-2.5 text-sm text-ink placeholder-ink-3 outline-none transition-all duration-200
          focus:border-crimson focus:ring-2 focus:ring-crimson/10
          ${
            errors[name]
              ? 'border-crimson bg-[var(--pg-well)]'
              : 'border-line hover:border-line-strong'
          }`}
      />

      {errors[name] && (
        <p className="mt-1.5 text-xs font-medium text-bad">
          {errors[name]}
        </p>
      )}
    </div>
  );
}

export default function EmployeeModal({
  employee,
  onSuccess,
  onClose,
}) {
  const isEdit = Boolean(employee);

  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [apiError, setApiError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (employee) {
      setForm({
        firstName: employee.firstName || '',
        lastName: employee.lastName || '',
        email: employee.email || '',
        phone: employee.phone || '',
        department: employee.department || '',
        position: employee.position || '',
        salary: employee.salary?.toString() || '',
        hireDate: employee.hireDate
          ? new Date(employee.hireDate)
              .toISOString()
              .split('T')[0]
          : '',
        status: employee.status || 'active',
        notes: employee.notes || '',
      });
    } else {
      setForm(EMPTY_FORM);
    }

    setErrors({});
    setApiError('');
  }, [employee]);

  const validate = () => {
    const errs = {};

    if (!form.firstName.trim()) {
      errs.firstName = 'First name is required';
    } else if (form.firstName.trim().length < 2) {
      errs.firstName = 'Must be at least 2 characters';
    }

    if (!form.lastName.trim()) {
      errs.lastName = 'Last name is required';
    } else if (form.lastName.trim().length < 2) {
      errs.lastName = 'Must be at least 2 characters';
    }

    if (!form.email.trim()) {
      errs.email = 'Email is required';
    } else if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)
    ) {
      errs.email = 'Invalid email format';
    }

    if (
      form.phone &&
      !/^[+]?[0-9\s\-()]{7,20}$/.test(form.phone.trim())
    ) {
      errs.phone = 'Invalid phone number';
    }

    if (!form.department) {
      errs.department = 'Department is required';
    }

    if (!form.position.trim()) {
      errs.position = 'Position is required';
    }

    if (!form.salary) {
      errs.salary = 'Salary is required';
    } else if (
      isNaN(form.salary) ||
      Number(form.salary) < 0
    ) {
      errs.salary = 'Enter a valid positive salary';
    }

    if (!form.hireDate) {
      errs.hireDate = 'Hire date is required';
    }

    return errs;
  };

  const handleChange = (e) => {
    const { name, value } = e.target;

    setForm((prev) => ({
      ...prev,
      [name]: value,
    }));

    if (errors[name]) {
      setErrors((prev) => ({
        ...prev,
        [name]: '',
      }));
    }

    setApiError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    const errs = validate();

    if (Object.keys(errs).length) {
      setErrors(errs);
      return;
    }

    setIsLoading(true);
    setApiError('');

    const payload = {
      ...form,
      salary: Number(form.salary),
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      position: form.position.trim(),
      phone: form.phone.trim() || undefined,
      notes: form.notes.trim() || undefined,
    };

    if (isEdit) {
      delete payload.salary;
    }

    try {
      if (isEdit) {
        await employeeService.updateEmployee(
          employee._id,
          payload
        );
      } else {
        await employeeService.createEmployee(payload);
      }

      onSuccess();
    } catch (err) {
      if (err.response?.data?.errors?.length) {
        const fieldErrors = {};

        err.response.data.errors.forEach(
          ({ field, message }) => {
            fieldErrors[field] = message;
          }
        );

        setErrors(fieldErrors);
      } else {
        setApiError(
          err.response?.data?.message ||
            'Save failed. Please try again.'
        );
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="dialog-backdrop"
      onClick={handleBackdropClick}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="employee-modal-title"
        className="dialog max-w-2xl max-h-[90vh]"
      >

        {/* Header */}
        <div className="flex items-center justify-between border-b border-line px-6 py-5">
          <div className="flex items-center gap-3">

            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-crimson">
              <svg
                className="h-4.5 w-4.5 text-on-accent"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                {isEdit ? (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                  />
                ) : (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"
                  />
                )}
              </svg>
            </div>

            <div>
              <p className="eyebrow">
                Employee record
              </p>

              <h2 id="employee-modal-title" className="mt-0.5 text-lg font-semibold tracking-tight text-ink">
                {isEdit ? 'Edit Employee' : 'Add New Employee'}
              </h2>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-[8px] p-2 text-ink-2 transition-colors hover:bg-crimson-tint hover:text-crimson"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Form */}
        <form
          onSubmit={handleSubmit}
          noValidate
          className="space-y-6 px-6 py-6"
        >

          {/* API Error */}
          {apiError && (
            <div className="flex items-start gap-2.5 rounded-[10px] border border-bad-line bg-bad-tint px-4 py-3 text-sm text-bad">
              <svg
                className="mt-0.5 h-4 w-4 flex-shrink-0"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                  clipRule="evenodd"
                />
              </svg>

              <span>{apiError}</span>
            </div>
          )}

          {/* Personal Information */}
          <section className="card-inset p-5">
            <div className="mb-4 flex items-center gap-2">

              <div>
                <p className="text-sm font-semibold text-ink">
                  Personal Information
                </p>

                <p className="mt-0.5 text-xs text-ink-2">
                  Basic employee contact details
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                id="emp-firstName"
                name="firstName"
                label="First Name"
                placeholder="John"
                required
                form={form}
                errors={errors}
                handleChange={handleChange}
              />

              <Field
                id="emp-lastName"
                name="lastName"
                label="Last Name"
                placeholder="Doe"
                required
                form={form}
                errors={errors}
                handleChange={handleChange}
              />

              <Field
                id="emp-email"
                name="email"
                label="Email"
                type="email"
                placeholder="john.doe@company.com"
                required
                autoComplete="email"
                form={form}
                errors={errors}
                handleChange={handleChange}
              />

              <Field
                id="emp-phone"
                name="phone"
                label="Phone"
                type="tel"
                placeholder="+91 98765 43210"
                form={form}
                errors={errors}
                handleChange={handleChange}
              />
            </div>
          </section>

          {/* Employment Information */}
          <section className="card-inset p-5">
            <div className="mb-4 flex items-center gap-2">

              <div>
                <p className="text-sm font-semibold text-ink">
                  Employment Information
                </p>

                <p className="mt-0.5 text-xs text-ink-2">
                  Role, department and employment details
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">

              {/* Department */}
              <div>
                <label
                  htmlFor="emp-dept"
                  className="label mb-1.5 block"
                >
                  Department
                  <span className="ml-1 text-crimson">*</span>
                </label>

                <select
                  id="emp-dept"
                  name="department"
                  value={form.department}
                  onChange={handleChange}
                  className={`w-full rounded-[9px] border bg-[var(--pg-well)] px-3.5 py-2.5 text-sm text-ink outline-none transition-all
                    focus:border-crimson focus:ring-2 focus:ring-crimson/10
                    ${
                      errors.department
                        ? 'border-crimson bg-[var(--pg-well)]'
                        : 'border-line hover:border-line-strong'
                    }`}
                >
                  <option value="">
                    Select department
                  </option>

                  {DEPARTMENTS.map((department) => (
                    <option
                      key={department}
                      value={department}
                    >
                      {department}
                    </option>
                  ))}
                </select>

                {errors.department && (
                  <p className="mt-1.5 text-xs font-medium text-bad">
                    {errors.department}
                  </p>
                )}
              </div>

              <Field
                id="emp-position"
                name="position"
                label="Position / Job Title"
                placeholder="Software Engineer"
                required
                form={form}
                errors={errors}
                handleChange={handleChange}
              />

              {/* Salary */}
              <div>
                <label
                  htmlFor="emp-salary"
                  className="label mb-1.5 block"
                >
                  Salary
                  <span className="ml-1 text-crimson">*</span>
                </label>

                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-ink-2">
                    ₹
                  </span>

                  <input
                    id="emp-salary"
                    name="salary"
                    type="number"
                    min="0"
                    step="1000"
                    value={form.salary}
                    onChange={handleChange}
                    readOnly={isEdit}
                    aria-readonly={isEdit}
                    placeholder="60000"
                    className={`w-full rounded-[9px] border bg-[var(--pg-well)] py-2.5 pl-8 pr-3 text-sm text-ink placeholder-ink-3 outline-none transition-all
                      focus:border-crimson focus:ring-2 focus:ring-crimson/10
                      ${
                        errors.salary
                          ? 'border-crimson bg-[var(--pg-well)]'
                          : 'border-line hover:border-line-strong'
                      }
                      ${isEdit ? 'bg-[var(--pg-well)] text-ink-2' : ''}`}
                  />
                </div>

                {isEdit && (
                  <p className="mt-1.5 text-[11px] text-ink-2">
                    Salary is managed through the versioned salary structure.
                  </p>
                )}

                {errors.salary && (
                  <p className="mt-1.5 text-xs font-medium text-bad">
                    {errors.salary}
                  </p>
                )}
              </div>

              <Field
                id="emp-hireDate"
                name="hireDate"
                label="Hire Date"
                type="date"
                required
                form={form}
                errors={errors}
                handleChange={handleChange}
              />

              {/* Status */}
              <div>
                <label
                  htmlFor="emp-status"
                  className="label mb-1.5 block"
                >
                  Status
                </label>

                <select
                  id="emp-status"
                  name="status"
                  value={form.status}
                  onChange={handleChange}
                  className="w-full rounded-[9px] border border-line bg-[var(--pg-well)] px-3.5 py-2.5 text-sm text-ink outline-none transition-all hover:border-line-strong focus:border-crimson focus:ring-2 focus:ring-crimson/10"
                >
                  <option value="active">
                    Active
                  </option>

                  <option value="inactive">
                    Inactive
                  </option>

                  <option value="on-leave">
                    On Leave
                  </option>
                </select>
              </div>
            </div>
          </section>

          {/* Notes */}
          <section className="card-inset p-5">
            <div className="mb-4">
              <p className="text-sm font-semibold text-ink">
                Notes
              </p>

              <p className="mt-0.5 text-xs text-ink-2">
                Optional information about this employee
              </p>
            </div>

            <textarea
              id="emp-notes"
              name="notes"
              value={form.notes}
              onChange={handleChange}
              rows={3}
              maxLength={500}
              placeholder="Any additional information…"
              className="w-full resize-none rounded-[9px] border border-line bg-[var(--pg-well)] px-3.5 py-2.5 text-sm text-ink placeholder-ink-3 outline-none transition-all hover:border-line-strong focus:border-crimson focus:ring-2 focus:ring-crimson/10"
            />

            <p className="mt-1.5 text-right text-[11px] text-ink-2">
              {form.notes.length}/500
            </p>
          </section>

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 border-t border-line pt-5">

            <button
              type="button"
              onClick={onClose}
              className="rounded-[9px] border border-line bg-transparent px-4 py-2.5 text-sm font-semibold text-ink-2 transition-all hover:border-line-strong hover:bg-[var(--pg-glass)]"
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={isLoading}
              className="flex items-center gap-2 rounded-[9px] bg-crimson px-5 py-2.5 text-sm font-semibold text-on-accent shadow-[0_8px_18px_rgba(198,40,40,0.18)] transition-all hover:-translate-y-0.5 hover:bg-crimson-strong disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
            >
              {isLoading ? (
                <>
                  <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-on-accent/30 border-t-on-accent" />
                  Saving…
                </>
              ) : (
                <>
                  {isEdit ? 'Save Changes' : 'Add Employee'}
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}