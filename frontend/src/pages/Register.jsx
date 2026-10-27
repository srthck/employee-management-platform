import { useState, useContext } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthContext } from '../contexts/AuthContext';
import { requestErrorMessage } from '../services/requestErrors';

/**
 * Register Page
 *
 * Features:
 * - Name, email, password, confirmPassword form
 * - Client-side validation mirroring backend rules:
 *   · Name: 2-50 chars
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
    companyName: '',
    email: '',
    password: '',
    confirmPassword: '',
  });

  const [errors, setErrors] = useState({});
  const [apiError, setApiError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // ─── Client-side validation ────────────────────────────────────────────────
  const validate = () => {
    const errs = {};

    // Name
    const trimmedName = form.name.trim();

    if (!trimmedName) {
      errs.name = 'Name is required';
    } else if (trimmedName.length < 2) {
      errs.name = 'Name must be at least 2 characters';
    } else if (trimmedName.length > 50) {
      errs.name = 'Name cannot exceed 50 characters';
    }

    // Company name (optional)
    const trimmedCompany = form.companyName.trim();

    if (trimmedCompany && (trimmedCompany.length < 2 || trimmedCompany.length > 120)) {
      errs.companyName = 'Company name must be 2-120 characters';
    }

    // Email
    if (!form.email.trim()) {
      errs.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      errs.email = 'Enter a valid email address';
    }

    // Password
    if (!form.password) {
      errs.password = 'Password is required';
    } else if (!PASSWORD_REGEX.test(form.password)) {
      errs.password =
        'Password must be 8-64 characters with at least one uppercase letter, one lowercase letter, and one digit';
    }

    // Confirm password
    if (!form.confirmPassword) {
      errs.confirmPassword = 'Please confirm your password';
    } else if (form.password !== form.confirmPassword) {
      errs.confirmPassword = 'Passwords do not match';
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
      await register({
        name: form.name.trim(),
        companyName: form.companyName.trim() || undefined,
        email: form.email.trim(),
        password: form.password,
        confirmPassword: form.confirmPassword,
      });

      navigate('/dashboard');
    } catch (err) {
      // Handle structured validation errors from backend
      if (err.response?.data?.errors?.length) {
        const fieldErrors = {};
        const otherMessages = [];

        err.response.data.errors.forEach(({ field, message }) => {
          if (field && field in form && !fieldErrors[field]) fieldErrors[field] = message;
          else otherMessages.push(message);
        });

        setErrors(fieldErrors);
        if (otherMessages.length) setApiError(otherMessages.join(' '));
      } else {
        setApiError(requestErrorMessage(err, 'Registration failed. Please try again.'));
      }
    } finally {
      setIsLoading(false);
    }
  };

  // ─── Reusable input renderer ──────────────────────────────────────────────
  const renderField = (
    id,
    name,
    label,
    type,
    placeholder,
    autoComplete
  ) => (
    <div>
      <label
        htmlFor={id}
        className="mb-2 block text-sm font-semibold text-[#241F20]"
      >
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
        className={`w-full rounded-[9px] border bg-white px-4 py-3 text-sm text-[#241F20] placeholder-[#A59A96] outline-none transition-all duration-200 ${
          errors[name]
            ? 'border-[#9B1C31] focus:border-[#9B1C31] focus:ring-2 focus:ring-[#A6192E]/10'
            : 'border-[#E7D8D5] hover:border-[#D5BFBB] focus:border-[#A6192E] focus:ring-2 focus:ring-[#A6192E]/10'
        }`}
      />

      {errors[name] && (
        <p className="mt-1.5 text-xs font-medium text-[#9B1C31]">
          {errors[name]}
        </p>
      )}
    </div>
  );

  // ─── Page ──────────────────────────────────────────────────────────────────
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#FFFDF8] px-4 py-10">
      {/* =========================================================
          BACKGROUND DECORATION
      ========================================================== */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {/* Top-right warm glow */}
        <div className="absolute -right-40 -top-40 h-[420px] w-[420px] rounded-full bg-[#F8E8EA] opacity-60 blur-3xl" />

        {/* Bottom-left warm glow */}
        <div className="absolute -bottom-40 -left-40 h-[420px] w-[420px] rounded-full bg-[#FFF7F0] opacity-80 blur-3xl" />
      </div>

      {/* =========================================================
          MAIN CONTAINER
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
            <div className="flex h-11 w-11 items-center justify-center rounded-[12px] bg-[#A6192E] shadow-[0_8px_20px_rgba(125,16,34,0.18)]">
              <span className="text-xl font-bold text-white">
                P
              </span>
            </div>

            <span className="text-[22px] font-semibold tracking-[-0.03em] text-[#241F20]">
              PayGuard
            </span>
          </Link>
        </div>

        {/* =======================================================
            REGISTER CARD
        ======================================================== */}
        <div className="rounded-[16px] border border-[#E7D8D5] bg-white p-7 shadow-[0_18px_50px_rgba(60,25,30,0.08)] sm:p-8">

          {/* -----------------------------------------------------
              HEADER
          ------------------------------------------------------ */}
          <div className="mb-7 text-center">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#A6192E]">
              PayGuard Portal
            </p>

            <h1 className="mt-2 text-[28px] font-bold tracking-[-0.035em] text-[#241F20]">
              Create your account
            </h1>

            <p className="mt-2 text-sm text-[#6F6565]">
              Set up your PayGuard account to get started
            </p>
          </div>

          {/* =====================================================
              API ERROR
          ====================================================== */}
          {apiError && (
            <div className="mb-6 flex items-start gap-2.5 rounded-[9px] border border-[#E6BFC4] bg-[#FDF1F3] px-4 py-3 text-sm text-[#9B1C31]">
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
              REGISTRATION FORM
          ====================================================== */}
          <form
            onSubmit={handleSubmit}
            noValidate
            className="space-y-5"
          >
            {renderField(
              'register-name',
              'name',
              'Full name',
              'text',
              'John Doe',
              'name'
            )}

            {renderField(
              'register-company',
              'companyName',
              'Company name (optional)',
              'text',
              'Acme Private Limited',
              'organization'
            )}

            {renderField(
              'register-email',
              'email',
              'Email address',
              'email',
              'admin@example.com',
              'email'
            )}

            {renderField(
              'register-password',
              'password',
              'Password',
              'password',
              '••••••••',
              'new-password'
            )}

            {renderField(
              'register-confirm',
              'confirmPassword',
              'Confirm password',
              'password',
              '••••••••',
              'new-password'
            )}

            {/* ===================================================
                PASSWORD REQUIREMENTS
            ==================================================== */}
            <div className="rounded-[10px] border border-[#E7D8D5] bg-[#FFF7F0] px-4 py-3.5">
              <p className="mb-2 text-xs font-semibold text-[#6F6565]">
                Password requirements
              </p>

              <ul className="space-y-1 text-xs">

                <li
                  className={
                    form.password.length >= 8 &&
                    form.password.length <= 64
                      ? 'text-[#2E7D32]'
                      : 'text-[#8A807C]'
                  }
                >
                  <span className="mr-1.5">
                    {form.password.length >= 8 &&
                    form.password.length <= 64
                      ? '✓'
                      : '•'}
                  </span>
                  8–64 characters
                </li>

                <li
                  className={
                    /[A-Z]/.test(form.password)
                      ? 'text-[#2E7D32]'
                      : 'text-[#8A807C]'
                  }
                >
                  <span className="mr-1.5">
                    {/[A-Z]/.test(form.password) ? '✓' : '•'}
                  </span>
                  At least one uppercase letter
                </li>

                <li
                  className={
                    /[a-z]/.test(form.password)
                      ? 'text-[#2E7D32]'
                      : 'text-[#8A807C]'
                  }
                >
                  <span className="mr-1.5">
                    {/[a-z]/.test(form.password) ? '✓' : '•'}
                  </span>
                  At least one lowercase letter
                </li>

                <li
                  className={
                    /\d/.test(form.password)
                      ? 'text-[#2E7D32]'
                      : 'text-[#8A807C]'
                  }
                >
                  <span className="mr-1.5">
                    {/\d/.test(form.password) ? '✓' : '•'}
                  </span>
                  At least one digit
                </li>

              </ul>
            </div>

            {/* ===================================================
                SUBMIT BUTTON
            ==================================================== */}
            <button
              id="register-submit"
              type="submit"
              disabled={isLoading}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-[9px] bg-[#A6192E] px-4 py-3 text-sm font-bold tracking-wide text-white shadow-[0_10px_22px_rgba(125,16,34,0.17)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#7D1022] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
            >
              {isLoading ? (
                <>
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  Creating account…
                </>
              ) : (
                <>
                  Create account
                  <span className="ml-1">
                    →
                  </span>
                </>
              )}
            </button>
          </form>

          {/* =====================================================
              LOGIN LINK
          ====================================================== */}
          <div className="mt-7 border-t border-[#E7D8D5] pt-6 text-center">
            <p className="text-sm text-[#6F6565]">
              Already have an account?{' '}

              <Link
                to="/login"
                className="font-semibold text-[#A6192E] transition-colors hover:text-[#7D1022]"
              >
                Sign in
              </Link>
            </p>
          </div>
        </div>

        {/* =======================================================
            SECURITY NOTE
        ======================================================== */}
        <div className="mt-5 flex items-center justify-center gap-2 text-xs text-[#8A807C]">
          <span className="font-bold text-[#2E7D32]">
            ✓
          </span>

          <span>
            Secure account creation for PayGuard payroll operations
          </span>
        </div>
      </div>
    </div>
  );
}