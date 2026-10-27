import { useState, useContext } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthContext } from '../contexts/AuthContext';
import { requestErrorMessage } from '../services/requestErrors';

/**
 * Login Page
 *
 * Features:
 * - Email + password form with client-side validation
 * - Mirrors backend password rules (presence check only on login)
 * - Error handling with structured API error messages
 * - Loading state during request
 * - Redirects to /dashboard on success
 */

export default function Login() {
  const { login } = useContext(AuthContext);
  const navigate = useNavigate();

  const [form, setForm] = useState({
    email: '',
    password: '',
  });

  const [errors, setErrors] = useState({});
  const [apiError, setApiError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // ─── Client-side validation ────────────────────────────────────────────────

  const validate = () => {
    const errs = {};

    if (!form.email.trim()) {
      errs.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      errs.email = 'Enter a valid email address';
    }

    if (!form.password) {
      errs.password = 'Password is required';
    }

    return errs;
  };

  // ─── Input change ──────────────────────────────────────────────────────────

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

  // ─── Submit ────────────────────────────────────────────────────────────────

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
      const result = await login({
        email: form.email,
        password: form.password,
      });

      // Employees land on self-service; admins and managers on operations.
      navigate(
        result?.data?.user?.role === 'employee' ? '/my/payslips' : '/dashboard'
      );
    } catch (err) {
      setApiError(requestErrorMessage(err, 'Login failed. Please try again.'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#FFFDF8] px-4 py-10">

      {/* =========================================================
          BACKGROUND DECORATION
      ========================================================== */}

      <div className="pointer-events-none absolute inset-0 overflow-hidden">

        {/* Top-right warm glow */}
        <div className="absolute -right-40 -top-40 h-[420px] w-[420px] rounded-full bg-[#F8E8EA] opacity-45 blur-3xl" />

        {/* Bottom-left warm glow */}
        <div className="absolute -bottom-40 -left-40 h-[420px] w-[420px] rounded-full bg-[#FFF7F0] opacity-70 blur-3xl" />

      </div>

      {/* =========================================================
          LOGIN CONTAINER
      ========================================================== */}

      <div className="relative w-full max-w-[440px]">

        {/* =======================================================
            BRAND
        ======================================================== */}

        <div className="mb-7 flex justify-center">

          <Link
            to="/"
            className="flex items-center gap-3"
          >

            <div className="flex h-10 w-10 items-center justify-center rounded-[11px] bg-[#A6192E] shadow-[0_7px_18px_rgba(60,25,30,0.12)]">
              <span className="text-lg font-semibold text-white">
                P
              </span>
            </div>

            <span className="text-[20px] font-semibold tracking-[-0.025em] text-[#241F20]">
              PayGuard
            </span>

          </Link>

        </div>

        {/* =======================================================
            LOGIN CARD
        ======================================================== */}

        <div className="rounded-[16px] border border-[#E7D8D5] bg-white p-7 shadow-[0_18px_50px_rgba(60,25,30,0.08)] sm:p-8">

          {/* -----------------------------------------------------
              HEADER
          ------------------------------------------------------ */}

          <div className="mb-7 text-center">

            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#A6192E]">
              PayGuard Portal
            </p>

            <h1 className="mt-2 text-[28px] font-semibold tracking-[-0.035em] text-[#241F20]">
              Welcome back
            </h1>

            <p className="mt-2 text-sm text-[#6F6565]">
              Sign in to your PayGuard account
            </p>

          </div>

          {/* =====================================================
              API ERROR
          ====================================================== */}

          {apiError && (
            <div className="mb-6 flex items-start gap-2.5 rounded-[9px] border border-[#E7D8D5] bg-[#F8E8EA] px-4 py-3 text-sm text-[#9B1C31]">

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

          {/* =====================================================
              LOGIN FORM
          ====================================================== */}

          <form
            onSubmit={handleSubmit}
            noValidate
            className="space-y-5"
          >

            {/* ---------------------------------------------------
                EMAIL
            ---------------------------------------------------- */}

            <div>

              <label
                htmlFor="login-email"
                className="mb-2 block text-sm font-semibold text-[#241F20]"
              >
                Email address
              </label>

              <input
                id="login-email"
                name="email"
                type="email"
                autoComplete="email"
                value={form.email}
                onChange={handleChange}
                placeholder="admin@example.com"
                className={`w-full rounded-[9px] border bg-white px-4 py-3 text-sm text-[#241F20] placeholder-[#A59A96] outline-none transition-all duration-200 ${
                  errors.email
                    ? 'border-[#9B1C31] focus:border-[#9B1C31] focus:ring-2 focus:ring-[#A6192E]/10'
                    : 'border-[#E7D8D5] hover:border-[#CDBBB7] focus:border-[#A6192E] focus:ring-2 focus:ring-[#A6192E]/10'
                }`}
              />

              {errors.email && (
                <p className="mt-1.5 text-xs font-medium text-[#9B1C31]">
                  {errors.email}
                </p>
              )}

            </div>

            {/* ---------------------------------------------------
                PASSWORD
            ---------------------------------------------------- */}

            <div>

              <label
                htmlFor="login-password"
                className="mb-2 block text-sm font-semibold text-[#241F20]"
              >
                Password
              </label>

              <input
                id="login-password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={form.password}
                onChange={handleChange}
                placeholder="••••••••"
                className={`w-full rounded-[9px] border bg-white px-4 py-3 text-sm text-[#241F20] placeholder-[#A59A96] outline-none transition-all duration-200 ${
                  errors.password
                    ? 'border-[#9B1C31] focus:border-[#9B1C31] focus:ring-2 focus:ring-[#A6192E]/10'
                    : 'border-[#E7D8D5] hover:border-[#CDBBB7] focus:border-[#A6192E] focus:ring-2 focus:ring-[#A6192E]/10'
                }`}
              />

              {errors.password && (
                <p className="mt-1.5 text-xs font-medium text-[#9B1C31]">
                  {errors.password}
                </p>
              )}

            </div>

            {/* ---------------------------------------------------
                SUBMIT BUTTON
            ---------------------------------------------------- */}

            <button
              id="login-submit"
              type="submit"
              disabled={isLoading}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-[9px] bg-[#A6192E] px-4 py-3 text-sm font-semibold tracking-wide text-white shadow-[0_10px_22px_rgba(60,25,30,0.12)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#7D1022] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
            >

              {isLoading ? (
                <>
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  Signing in…
                </>
              ) : (
                <>
                  Sign in
                  <span className="ml-1">
                    →
                  </span>
                </>
              )}

            </button>

          </form>

          {/* =====================================================
              REGISTER LINK
          ====================================================== */}

          <div className="mt-7 border-t border-[#E7D8D5] pt-6 text-center">

            <p className="text-sm text-[#6F6565]">
              Don&apos;t have an account?{' '}

              <Link
                to="/register"
                className="font-semibold text-[#A6192E] transition-colors hover:text-[#7D1022]"
              >
                Create one
              </Link>
            </p>

          </div>

        </div>

        {/* =======================================================
            SECURITY NOTE
        ======================================================== */}

        <div className="mt-5 flex items-center justify-center gap-2 text-xs text-[#6F6565]">

          <span className="font-bold text-[#2E7D32]">
            ✓
          </span>

          <span>
            Secure access to PayGuard payroll operations
          </span>

        </div>

      </div>

    </div>
  );
}