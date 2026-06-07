import { useState, useEffect } from 'react';
import * as employeeService from '../services/employeeService';

/**
 * EmployeeModal
 *
 * Handles both Create and Edit modes.
 *   employee = null  → Create mode
 *   employee = {...} → Edit mode (fields pre-filled)
 *
 * Props:
 *   employee   – employee object or null
 *   onSuccess  – called after successful save
 *   onClose    – called to dismiss modal
 */

const DEPARTMENTS = [
  'Engineering', 'Marketing', 'Sales', 'Human Resources',
  'Finance', 'Operations', 'Design', 'Legal', 'Customer Support', 'Other',
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

const PASSWORD_LIKE_FIELDS = new Set(); // no password fields here

export default function EmployeeModal({ employee, onSuccess, onClose }) {
  const isEdit = Boolean(employee);

  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [apiError, setApiError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // Pre-fill form in edit mode
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
          ? new Date(employee.hireDate).toISOString().split('T')[0]
          : '',
        status: employee.status || 'active',
        notes: employee.notes || '',
      });
    }
  }, [employee]);

  // ─── Client-side validation ──────────────────────────────────────────────
  const validate = () => {
    const errs = {};

    if (!form.firstName.trim()) errs.firstName = 'First name is required';
    else if (form.firstName.trim().length < 2) errs.firstName = 'Must be at least 2 characters';

    if (!form.lastName.trim()) errs.lastName = 'Last name is required';
    else if (form.lastName.trim().length < 2) errs.lastName = 'Must be at least 2 characters';

    if (!form.email.trim()) errs.email = 'Email is required';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errs.email = 'Invalid email format';

    if (form.phone && !/^[\+]?[\d\s\-\(\)]{7,20}$/.test(form.phone.trim())) {
      errs.phone = 'Invalid phone number';
    }

    if (!form.department) errs.department = 'Department is required';
    if (!form.position.trim()) errs.position = 'Position is required';

    if (!form.salary) errs.salary = 'Salary is required';
    else if (isNaN(form.salary) || Number(form.salary) < 0) errs.salary = 'Enter a valid positive salary';

    if (!form.hireDate) errs.hireDate = 'Hire date is required';

    return errs;
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
    if (errors[name]) setErrors((prev) => ({ ...prev, [name]: '' }));
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

    try {
      if (isEdit) {
        await employeeService.updateEmployee(employee._id, payload);
      } else {
        await employeeService.createEmployee(payload);
      }
      onSuccess();
    } catch (err) {
      if (err.response?.data?.errors?.length) {
        const fieldErrors = {};
        err.response.data.errors.forEach(({ field, message }) => {
          fieldErrors[field] = message;
        });
        setErrors(fieldErrors);
      } else {
        setApiError(err.response?.data?.message || 'Save failed. Please try again.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Close on backdrop click
  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  // ─── Field helper ────────────────────────────────────────────────────────
  const Field = ({ id, name, label, type = 'text', placeholder, required, autoComplete }) => (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-slate-400 mb-1">
        {label}{required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        autoComplete={autoComplete || 'off'}
        value={form[name]}
        onChange={handleChange}
        placeholder={placeholder}
        className={`w-full px-3 py-2 rounded-lg bg-slate-800 border text-white text-sm placeholder-slate-600 outline-none transition-all
          focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500
          ${errors[name] ? 'border-red-500/60' : 'border-slate-700 hover:border-slate-600'}`}
      />
      {errors[name] && <p className="mt-1 text-xs text-red-400">{errors[name]}</p>}
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center">
              <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {isEdit ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
                )}
              </svg>
            </div>
            <h2 className="text-base font-semibold text-white">
              {isEdit ? 'Edit Employee' : 'Add New Employee'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors p-1 rounded-lg hover:bg-slate-800"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} noValidate className="px-6 py-5 space-y-5">
          {apiError && (
            <div className="px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm flex items-center gap-2">
              <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              {apiError}
            </div>
          )}

          {/* Section: Personal Info */}
          <div>
            <p className="text-xs text-slate-500 font-medium uppercase tracking-wider mb-3">Personal Information</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field id="emp-firstName" name="firstName" label="First Name" placeholder="John" required />
              <Field id="emp-lastName" name="lastName" label="Last Name" placeholder="Doe" required />
              <Field id="emp-email" name="email" label="Email" type="email" placeholder="john.doe@company.com" required autoComplete="email" />
              <Field id="emp-phone" name="phone" label="Phone" type="tel" placeholder="+1 555 123 4567" />
            </div>
          </div>

          {/* Section: Employment Info */}
          <div>
            <p className="text-xs text-slate-500 font-medium uppercase tracking-wider mb-3">Employment Information</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Department */}
              <div>
                <label htmlFor="emp-dept" className="block text-xs font-medium text-slate-400 mb-1">
                  Department <span className="text-red-400">*</span>
                </label>
                <select
                  id="emp-dept"
                  name="department"
                  value={form.department}
                  onChange={handleChange}
                  className={`w-full px-3 py-2 rounded-lg bg-slate-800 border text-sm text-white outline-none transition-all
                    focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500
                    ${errors.department ? 'border-red-500/60' : 'border-slate-700 hover:border-slate-600'}`}
                >
                  <option value="">Select department</option>
                  {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
                {errors.department && <p className="mt-1 text-xs text-red-400">{errors.department}</p>}
              </div>

              <Field id="emp-position" name="position" label="Position / Job Title" placeholder="Software Engineer" required />

              <div>
                <label htmlFor="emp-salary" className="block text-xs font-medium text-slate-400 mb-1">
                  Annual Salary (USD) <span className="text-red-400">*</span>
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">$</span>
                  <input
                    id="emp-salary"
                    name="salary"
                    type="number"
                    min="0"
                    step="1000"
                    value={form.salary}
                    onChange={handleChange}
                    placeholder="60000"
                    className={`w-full pl-7 pr-3 py-2 rounded-lg bg-slate-800 border text-white text-sm placeholder-slate-600 outline-none transition-all
                      focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500
                      ${errors.salary ? 'border-red-500/60' : 'border-slate-700 hover:border-slate-600'}`}
                  />
                </div>
                {errors.salary && <p className="mt-1 text-xs text-red-400">{errors.salary}</p>}
              </div>

              <Field id="emp-hireDate" name="hireDate" label="Hire Date" type="date" required />

              {/* Status */}
              <div>
                <label htmlFor="emp-status" className="block text-xs font-medium text-slate-400 mb-1">
                  Status
                </label>
                <select
                  id="emp-status"
                  name="status"
                  value={form.status}
                  onChange={handleChange}
                  className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 hover:border-slate-600 text-sm text-white outline-none transition-all focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500"
                >
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                  <option value="on-leave">On Leave</option>
                </select>
              </div>
            </div>
          </div>

          {/* Notes */}
          <div>
            <label htmlFor="emp-notes" className="block text-xs font-medium text-slate-400 mb-1">
              Notes <span className="text-slate-600 font-normal">(optional)</span>
            </label>
            <textarea
              id="emp-notes"
              name="notes"
              value={form.notes}
              onChange={handleChange}
              rows={3}
              maxLength={500}
              placeholder="Any additional information…"
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 hover:border-slate-600 text-white text-sm placeholder-slate-600 outline-none transition-all resize-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500"
            />
            <p className="mt-1 text-xs text-slate-600 text-right">{form.notes.length}/500</p>
          </div>

          {/* Footer Buttons */}
          <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="flex items-center gap-2 px-5 py-2 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white text-sm font-semibold transition-all shadow-lg shadow-violet-500/20 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <>
                  <div className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Saving…
                </>
              ) : (
                <>{isEdit ? 'Save Changes' : 'Add Employee'}</>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
