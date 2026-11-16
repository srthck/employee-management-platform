import { useState, useContext } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthContext } from '../contexts/AuthContext';
import { requestErrorMessage } from '../services/requestErrors';
import AuthLayout, { FormError } from '../components/ui/AuthLayout';
import Icon from '../components/ui/Icon';

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
  const renderField = (id, name, label, type, placeholder, autoComplete, hint) => (
    <div>
      <label htmlFor={id} className="label mb-1.5 block">{label}</label>
      <input
        id={id}
        name={name}
        type={type}
        autoComplete={autoComplete}
        value={form[name]}
        onChange={handleChange}
        placeholder={placeholder}
        aria-invalid={errors[name] ? 'true' : undefined}
        aria-describedby={[errors[name] && `${id}-error`, hint && `${id}-hint`].filter(Boolean).join(' ') || undefined}
        className={`field min-h-[46px] ${errors[name] ? 'border-bad focus:border-bad focus:ring-bad/15' : ''}`}
      />
      {hint && <p id={`${id}-hint`} className="hint">{hint}</p>}
      {errors[name] && <p id={`${id}-error`} className="field-error">{errors[name]}</p>}
    </div>
  );

  const rules = [
    ['8–64 characters', form.password.length >= 8 && form.password.length <= 64],
    ['An uppercase letter', /[A-Z]/.test(form.password)],
    ['A lowercase letter', /[a-z]/.test(form.password)],
    ['A digit', /\d/.test(form.password)],
  ];

  // ─── Page ──────────────────────────────────────────────────────────────────
  return (
    <AuthLayout
      title="Create an account"
      subtitle="You become the administrator of a new PayGuard workspace."
      footer={(
        <p>
          Already have an account?{' '}
          <Link to="/login" className="link">Sign in</Link>
        </p>
      )}
    >
      <FormError>{apiError}</FormError>

      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        {renderField('register-name', 'name', 'Full name', 'text', '', 'name')}
        {renderField('register-company', 'companyName', 'Company name (optional)', 'text', '', 'organization', 'You can change it later in Settings.')}
        {renderField('register-email', 'email', 'Email address', 'email', 'you@company.com', 'email')}
        {renderField('register-password', 'password', 'Password', 'password', '', 'new-password')}

        <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12.5px]" aria-label="Password requirements">
          {rules.map(([text, met]) => (
            <li key={text} className={`flex items-center gap-1.5 ${met ? 'text-ok' : 'text-ink-2'}`}>
              <Icon name={met ? 'check' : 'help-circle'} size={14} strokeWidth={2} className={met ? '' : 'opacity-60'} />
              {text}
              <span className="sr-only">{met ? '(met)' : '(not yet met)'}</span>
            </li>
          ))}
        </ul>

        {renderField('register-confirm', 'confirmPassword', 'Confirm password', 'password', '', 'new-password')}

        <button id="register-submit" type="submit" disabled={isLoading} className="btn btn-primary min-h-[46px] w-full">
          {isLoading ? (
            <>
              <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-on-accent/30 border-t-on-accent" />
              Creating account…
            </>
          ) : (
            <>Create account <Icon name="arrow-right" size={16} /></>
          )}
        </button>
      </form>
    </AuthLayout>
  );
}
