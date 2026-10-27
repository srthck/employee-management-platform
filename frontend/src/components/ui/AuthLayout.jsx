import { Link } from 'react-router-dom';
import ProoflineMark from '../site/ProoflineMark';
import Icon from './Icon';

const TRACE = ['Inputs', 'Statutory rules', 'Variance check', 'Approval', 'Frozen record'];

/**
 * Sign-in and registration frame. Desktop: a brand panel with the Proofline
 * beside the form. Narrow screens: the form alone under the wordmark.
 */
export default function AuthLayout({ title, subtitle, children, footer }) {
  return (
    <div className="min-h-screen bg-porcelain lg:grid lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <aside className="relative hidden overflow-hidden bg-obsidian px-12 py-12 text-white lg:flex lg:flex-col">
        <Link to="/" className="inline-flex min-h-[44px] items-center gap-2.5 self-start">
          <ProoflineMark size={30} inverse />
          <span className="text-[18px] font-bold tracking-[-0.02em]">PayGuard</span>
        </Link>

        <div className="my-auto max-w-[420px] py-12">
          <p className="text-[52px] font-bold leading-[0.95] tracking-[-0.045em]">
            Payroll, with proof<span className="text-scarlet">.</span>
          </p>
          <p className="mt-5 text-[16px] leading-7 text-[#CFC4C9]">
            Every payslip is tied to the salary version, statutory rule and approval behind it.
          </p>
          <ol className="relative mt-10 space-y-4 pl-7" aria-label="How a result is traced">
            <span aria-hidden="true" className="absolute bottom-2 left-[5px] top-2 w-[2px] rounded-full bg-scarlet" />
            {TRACE.map((step, i) => (
              <li key={step} className="relative flex items-center gap-3 text-[14px] text-[#E9E1E5]">
                <span aria-hidden="true" className={`absolute -left-7 h-3 w-3 rounded-full border-2 border-scarlet ${i === TRACE.length - 1 ? 'bg-scarlet' : 'bg-obsidian'}`} />
                <span className="font-mono text-[11px] text-[#A99BA2]">{String(i + 1).padStart(2, '0')}</span>
                {step}
              </li>
            ))}
          </ol>
        </div>

        <p className="text-xs leading-5 text-[#A99BA2]">
          Income tax (TDS) and attendance are not calculated yet. Net pay is shown before TDS.
        </p>
      </aside>

      <main className="flex min-h-screen flex-col px-4 py-8 sm:px-8 lg:min-h-0 lg:justify-center lg:px-16">
        <Link to="/" className="mb-10 inline-flex min-h-[44px] items-center gap-2.5 self-start lg:hidden">
          <ProoflineMark size={28} />
          <span className="text-[17px] font-bold tracking-[-0.02em] text-ink">PayGuard</span>
        </Link>
        <div className="w-full max-w-[420px] lg:mx-auto">
          <h1 className="text-[30px] font-bold leading-tight tracking-[-0.03em] text-ink">{title}</h1>
          {subtitle && <p className="mt-2 text-[15px] leading-6 text-ink-2">{subtitle}</p>}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-8 border-t border-line pt-6 text-sm text-ink-2">{footer}</div>}
        </div>
      </main>
    </div>
  );
}

/** Form-level error with an icon and live announcement. */
export function FormError({ children }) {
  if (!children) return null;
  return (
    <div role="alert" className="mb-6 flex items-start gap-2.5 rounded-[10px] border border-bad-line bg-bad-tint px-4 py-3 text-sm leading-6 text-bad">
      <Icon name="x-circle" size={18} strokeWidth={2} className="mt-0.5" />
      <span>{children}</span>
    </div>
  );
}
