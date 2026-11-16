import { useState, useContext } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthContext } from '../contexts/AuthContext';
import { requestErrorMessage } from '../services/requestErrors';
import AuthLayout, { FormError } from '../components/ui/AuthLayout';
import Icon from '../components/ui/Icon';

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
    <AuthLayout
      title="Sign in"
      subtitle="Use the account your administrator created, or the one you registered."
      footer={(
        <p>
          New to PayGuard?{' '}
          <Link to="/register" className="link">Create an account</Link>
        </p>
      )}
    >
      <FormError>{apiError}</FormError>

      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        <div>
          <label htmlFor="login-email" className="label mb-1.5 block">Email address</label>
          <input
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            value={form.email}
            onChange={handleChange}
            placeholder="you@company.com"
            aria-invalid={errors.email ? 'true' : undefined}
            aria-describedby={errors.email ? 'login-email-error' : undefined}
            className={`field min-h-[46px] ${errors.email ? 'border-bad focus:border-bad focus:ring-bad/15' : ''}`}
          />
          {errors.email && <p id="login-email-error" className="field-error">{errors.email}</p>}
        </div>

        <div>
          <label htmlFor="login-password" className="label mb-1.5 block">Password</label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={form.password}
            onChange={handleChange}
            aria-invalid={errors.password ? 'true' : undefined}
            aria-describedby={errors.password ? 'login-password-error' : undefined}
            className={`field min-h-[46px] ${errors.password ? 'border-bad focus:border-bad focus:ring-bad/15' : ''}`}
          />
          {errors.password && <p id="login-password-error" className="field-error">{errors.password}</p>}
        </div>

        <button id="login-submit" type="submit" disabled={isLoading} className="btn btn-primary min-h-[46px] w-full">
          {isLoading ? (
            <>
              <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-on-accent/30 border-t-on-accent" />
              Signing in…
            </>
          ) : (
            <>Sign in <Icon name="arrow-right" size={16} /></>
          )}
        </button>
      </form>
    </AuthLayout>
  );
}
