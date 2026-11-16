import { Link } from 'react-router-dom';
import ProoflineMark from '../site/ProoflineMark';
import Icon from './Icon';

const TRACE = ['Inputs', 'Statutory rules', 'Variance check', 'Approval', 'Frozen record'];

/**
 * Sign-in and registration frame.
 *
 * The same lit navy canvas as the rest of the product: the promise and the
 * trace at the left, the form in a frosted card at the right. Below the
 * desktop breakpoint the brand panel drops away and the card carries the page.
 */
export default function AuthLayout({ title, subtitle, children, footer }) {
  return (
    <div className="pg-canvas min-h-screen lg:grid lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
      <aside className="relative hidden overflow-hidden px-12 py-12 text-ink lg:flex lg:flex-col">
        <Link to="/" className="inline-flex min-h-[44px] items-center gap-2.5 self-start">
          <ProoflineMark size={30} />
          <span className="text-[18px] font-bold tracking-[-0.03em]">PayGuard</span>
        </Link>

        <div className="my-auto max-w-[440px] py-12">
          <p className="text-[clamp(40px,4.4vw,56px)] font-bold leading-[0.98] tracking-[-0.045em]">
            Payroll, with proof<span className="text-crimson">.</span>
          </p>
          <p className="mt-6 text-[15.5px] leading-7 text-ink-2">
            Every payslip is tied to the salary version, statutory rule and approval behind it.
          </p>
          <ol className="relative mt-11 space-y-4 pl-8" aria-label="How a result is traced">
            <span aria-hidden="true" className="absolute bottom-2 left-[6px] top-2 w-[2px] rounded-full bg-crimson" />
            {TRACE.map((step, i) => (
              <li key={step} className="relative flex items-center gap-3 text-[14.5px] text-ink">
                <span
                  aria-hidden="true"
                  className={`absolute -left-8 h-[13px] w-[13px] rounded-full border-2 border-crimson ${
                    i === TRACE.length - 1 ? 'bg-crimson' : 'bg-[rgb(var(--pg-canvas-solid-rgb))]'
                  }`}
                />
                <span className="font-mono text-[11px] text-ink-3">{String(i + 1).padStart(2, '0')}</span>
                {step}
              </li>
            ))}
          </ol>
        </div>

        <p className="max-w-[46ch] text-xs leading-5 text-ink-3">
          Income tax (TDS) and attendance are not calculated yet. Net pay is shown before TDS.
        </p>
      </aside>

      <main className="flex min-h-screen flex-col justify-center px-4 py-10 sm:px-8 lg:min-h-0 lg:px-12 xl:px-16">
        <Link to="/" className="mb-8 inline-flex min-h-[44px] items-center gap-2.5 self-start lg:hidden">
          <ProoflineMark size={28} />
          <span className="text-[17px] font-bold tracking-[-0.03em] text-ink">PayGuard</span>
        </Link>

        <div className="panel panel-float w-full max-w-[440px] p-6 sm:p-8 lg:mx-auto">
          <h1 className="text-[30px] font-bold leading-tight tracking-[-0.035em] text-ink">{title}</h1>
          {subtitle && <p className="mt-2.5 text-[15px] leading-6 text-ink-2">{subtitle}</p>}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-8 border-t border-line pt-6 text-sm text-ink-2">{footer}</div>}
        </div>

        <p className="mt-6 max-w-[440px] text-xs leading-5 text-ink-3 lg:mx-auto lg:hidden">
          Income tax (TDS) and attendance are not calculated yet. Net pay is shown before TDS.
        </p>
      </main>
    </div>
  );
}

/** Form-level error with an icon and live announcement. */
export function FormError({ children }) {
  if (!children) return null;
  return (
    <div
      role="alert"
      className="mb-6 flex items-start gap-2.5 rounded-[14px] border border-bad-line bg-bad-tint px-4 py-3 text-sm leading-6 text-bad"
    >
      <Icon name="x-circle" size={18} strokeWidth={2} className="mt-0.5" />
      <span>{children}</span>
    </div>
  );
}
