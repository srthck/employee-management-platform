import { useState, useContext } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthContext } from '../contexts/AuthContext';

/**
 * Register Page
 *
 * Features:
 * - Name, email, password, confirmPassword form
 * - Client-side validation mirroring backend rules:
 *   · Name: 2-50 chars, letters/spaces/hyphens/apostrophes
 *   · Email: standard format
 *   · Password: 8-64 chars, 1 uppercase, 1 lowercase, 1 digit
 *   · ConfirmPassword: must match password
 * - Structured API error handling
 * - Loading state during request
 * - Redirects to /dashboard on success
 */

const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,64}$/;

export default function Register() {
  const { register } = useContext(AuthContext);
  const navigate = useNavigate();

  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
  });
  const [errors, setErrors] = useState({});
  const [apiError, setApiError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // ─── Client-side validation (mirrors backend authValidator rules) ──────────
  const validate = () => {
    const errs = {};

    // Name
    const trimmedName = form.name.trim();
    if (!trimmedName) errs.name = 'Name is required';
    else if (trimmedName.length < 2) errs.name = 'Name must be at least 2 characters';
    else if (trimmedName.length > 50) errs.name = 'Name cannot exceed 50 characters';

    // Email
    if (!form.email.trim()) errs.email = 'Email is required';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email))
      errs.email = 'Enter a valid email address';

    // Password
    if (!form.password) errs.password = 'Password is required';
    else if (!PASSWORD_REGEX.test(form.password))
      errs.password =
        'Password must be 8-64 characters with at least one uppercase letter, one lowercase letter, and one digit';

    // Confirm Password
    if (!form.confirmPassword) errs.confirmPassword = 'Please confirm your password';
    else if (form.password !== form.confirmPassword)
      errs.confirmPassword = 'Passwords do not match';

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

    try {
      await register({
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        confirmPassword: form.confirmPassword,
      });
      navigate('/dashboard');
    } catch (err) {
      // Handle structured validation errors from backend
      if (err.response?.data?.errors?.length) {
        const fieldErrors = {};
        err.response.data.errors.forEach(({ field, message }) => {
          fieldErrors[field] = message;
        });
        setErrors(fieldErrors);
      } else {
        const message =
          err.response?.data?.message || 'Registration failed. Please try again.';
        setApiError(message);
      }
    } finally {
      setIsLoading(false);
    }
  };

  // ─── Reusable input field renderer ─────────────────────────────────────────
  const renderField = (id, name, label, type, placeholder, autoComplete) => (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-300 mb-1.5">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        autoComplete={autoComplete}
        value={form[name]}
        onChange={handleChange}
        placeholder={placeholder}
        className={`w-full px-4 py-2.5 rounded-lg bg-slate-800 border text-white placeholder-slate-500 text-sm outline-none transition-all duration-200
          focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500
          ${errors[name] ? 'border-red-500/60 focus:ring-red-500/30 focus:border-red-500' : 'border-slate-700 hover:border-slate-600'}`}
      />
      {errors[name] && (
        <p className="mt-1.5 text-xs text-red-400">{errors[name]}</p>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
      {/* Background gradient orbs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-96 h-96 bg-violet-600/20 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-96 h-96 bg-indigo-600/20 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-md">
        {/* Card */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl shadow-black/50">
          {/* Header */}
          <div className="mb-8">
            <div className="flex items-center gap-2 mb-6">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center">
                <span className="text-white text-xs font-bold">EMS</span>
              </div>
              <span className="text-slate-400 text-sm font-medium">Employee Management System</span>
            </div>
            <h1 className="text-2xl font-bold text-white">Create your account</h1>
            <p className="text-slate-400 text-sm mt-1">Set up your admin credentials to get started</p>
          </div>

          {/* API Error Banner */}
          {apiError && (
            <div className="mb-6 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm flex items-center gap-2">
              <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              {apiError}
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} noValidate className="space-y-5">
            {renderField('register-name', 'name', 'Full name', 'text', 'John Doe', 'name')}
            {renderField('register-email', 'email', 'Email address', 'email', 'admin@example.com', 'email')}
            {renderField('register-password', 'password', 'Password', 'password', '••••••••', 'new-password')}
            {renderField('register-confirm', 'confirmPassword', 'Confirm password', 'password', '••••••••', 'new-password')}

            {/* Password requirements hint */}
            <div className="rounded-lg bg-slate-800/50 border border-slate-700/50 px-4 py-3">
              <p className="text-xs text-slate-500 font-medium mb-1.5">Password requirements</p>
              <ul className="text-xs text-slate-500 space-y-0.5 list-disc list-inside">
                <li className={form.password.length >= 8 && form.password.length <= 64 ? 'text-emerald-400' : ''}>
                  8–64 characters
                </li>
                <li className={/[A-Z]/.test(form.password) ? 'text-emerald-400' : ''}>
                  At least one uppercase letter
                </li>
                <li className={/[a-z]/.test(form.password) ? 'text-emerald-400' : ''}>
                  At least one lowercase letter
                </li>
                <li className={/\d/.test(form.password) ? 'text-emerald-400' : ''}>
                  At least one digit
                </li>
              </ul>
            </div>

            {/* Submit */}
            <button
              id="register-submit"
              type="submit"
              disabled={isLoading}
              className="w-full mt-2 py-2.5 px-4 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500
                text-white text-sm font-semibold tracking-wide transition-all duration-200 shadow-lg shadow-violet-500/25
                disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <>
                  <div className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Creating account…
                </>
              ) : (
                'Create account'
              )}
            </button>
          </form>

          {/* Footer */}
          <p className="mt-6 text-center text-sm text-slate-500">
            Already have an account?{' '}
            <Link to="/login" className="text-violet-400 hover:text-violet-300 font-medium transition-colors">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
