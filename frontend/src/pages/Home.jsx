import { useContext } from 'react';
import { Link } from 'react-router-dom';
import '../components/site/site.css';
import { AuthContext } from '../contexts/AuthContext';
import SiteNav from '../components/site/SiteNav';
import ProoflineDemo from '../components/site/ProoflineDemo';
import RunLifecycle from '../components/site/RunLifecycle';
import ServiceStatus from '../components/site/ServiceStatus';
import ProoflineMark from '../components/site/ProoflineMark';

/**
 * PayGuard public site — "The Proofline".
 *
 * Narrative: promise → a traced sample result → how a run closes → what the
 * product does → what its integrity checks can and cannot prove → action.
 * Design rules: docs/design/PROOFLINE-DESIGN-SYSTEM.md. Every product claim on
 * this page names behaviour that exists in the backend today.
 */

const CAPABILITIES = [
  {
    title: 'Payslips that explain themselves',
    body: 'Each deduction shows the amount it was calculated on and the rule version that set it. Where a basis was not recorded, the payslip says so instead of guessing.',
    where: 'Payslips · Employee self-service',
  },
  {
    title: 'Variance that names a cause',
    body: 'Pay changes against the last finalized run are matched to causes the payroll data can prove: a salary revision, a rule change, an enrolment change, a work-state change or part-period pay.',
    where: 'Payroll run → Variance',
  },
  {
    title: 'Effective-dated statutory rules',
    body: 'EPF, ESI and professional-tax rules are stored as versions with effective dates and source notes. Past payroll keeps the version it used.',
    where: 'Compliance',
  },
  {
    title: 'Pay changes priced before approval',
    body: 'A proposed change shows before, after and delta for gross, deductions, net pay and CTC, with the same rule versions on both sides. Under maker-checker, a second person approves it.',
    where: 'Compensation',
  },
  {
    title: 'Sensitive details, revealed on record',
    body: 'Bank accounts and PAN, UAN, ESIC and PF identifiers are encrypted field by field. Revealing one takes a written reason, recorded in the audit trail before the value is shown.',
    where: 'Employee profile',
  },
  {
    title: 'Roles and separation of duties',
    body: 'Administrator, payroll administrator, payroll approver, HR manager, auditor and employee. Under maker-checker, nobody approves their own calculation or pay proposal.',
    where: 'Settings',
  },
];

const CHECKS = [
  ['Snapshot hash', 'Every finalized payroll record carries a SHA-256 hash of its canonical content. Verify recomputes it and reports a mismatch.'],
  ['Audit chain', 'Each audit record holds the hash of the one before it. New records are appended through a single chain head inside a transaction, and verification walks the whole chain.'],
  ['Atomic finalization', 'Finalization requires database transactions: the run and its snapshots are finalized together or not at all.'],
  ['Encrypted fields', 'Bank and statutory identifiers are encrypted at field level and looked up through blind indexes.'],
];

const LIMITS = [
  ['Tamper-evident, not tamper-proof', 'A hash shows that a record changed. It cannot stop someone with database access from changing it.'],
  ['The chain starts from a trusted point', 'Without an external checkpoint, removal of records before the chain’s recorded starting point cannot be proven.'],
  ['Income tax is not calculated yet', 'Net pay is shown before TDS, and every payslip says so.'],
  ['No certification claimed', 'PayGuard does not claim any third-party security or compliance certification.'],
];

function SectionMark({ index, label }) {
  return (
    <p className="site-section-mark">
      <span className="site-section-mark__node" aria-hidden="true" />
      <span className="site-section-mark__index" aria-hidden="true">{index}</span>
      {label}
    </p>
  );
}

export default function Home() {
  const { user, loading } = useContext(AuthContext);
  const primaryAction = user
    ? { to: '/dashboard', label: 'Open dashboard' }
    : { to: '/register', label: 'Create an account' };

  return (
    <div className="pg-site">
      <a className="skip-link" href="#main">Skip to content</a>
      <SiteNav />

      <main id="main">
        <section className="hero site-container" aria-labelledby="hero-title">
          <div className="hero__copy">
            <p className="hero__eyebrow">
              Payroll operations for India · <span className="nowrap">EPF · ESI · Professional tax</span>
            </p>
            <h1 className="hero__title" id="hero-title">
              Payroll, <span className="hero__title-line">with proof<span className="hero__point">.</span></span>
            </h1>
            <p className="hero__lede">
              <strong>Every rupee, every reason.</strong> PayGuard ties each payslip to the salary version,
              statutory rule and approval behind it, then freezes the finalized result so it can be checked later.
            </p>
            <div className="hero__actions" data-loading={loading ? '' : undefined}>
              <Link to={primaryAction.to} className="site-btn site-btn--primary site-btn--large">
                {primaryAction.label}
                <span aria-hidden="true" className="site-btn__arrow">→</span>
              </Link>
              <a href="#lifecycle" className="site-link">How a payroll run closes</a>
            </div>
          </div>

          <div className="hero__proof" id="trace">
            <SectionMark index="01" label="Trace a result" />
            <ProoflineDemo />
          </div>
        </section>

        <section className="band band--ink" id="lifecycle" aria-labelledby="lifecycle-title">
          <div className="site-container">
            <header className="site-section-head">
              <SectionMark index="02" label="Run lifecycle" />
              <h2 className="site-section-title" id="lifecycle-title">Five states, in order. None skipped.</h2>
              <p className="site-section-lede">
                A payroll run cannot jump from calculated to finalized. The state machine is enforced where runs are
                written, so every finalized result has passed review first.
              </p>
            </header>
            <RunLifecycle />
          </div>
        </section>

        <section className="band" id="capabilities" aria-labelledby="capabilities-title">
          <div className="site-container">
            <header className="site-section-head site-section-head--split">
              <div>
                <SectionMark index="03" label="Capabilities" />
                <h2 className="site-section-title" id="capabilities-title">Built around the questions payroll gets asked.</h2>
              </div>
              <p className="site-section-lede">
                Why did my pay change? Which rule applied? Who approved it? Each capability exists to answer one of
                these from the record, not from memory.
              </p>
            </header>
            <ol className="capabilities">
              {CAPABILITIES.map((item, index) => (
                <li key={item.title} className="capability">
                  <span className="capability__index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                  <div className="capability__head">
                    <h3 className="capability__title">{item.title}</h3>
                    <p className="capability__where">{item.where}</p>
                  </div>
                  <p className="capability__body">{item.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="band band--paper" id="integrity" aria-labelledby="integrity-title">
          <div className="site-container integrity">
            <header className="site-section-head integrity__head">
              <SectionMark index="04" label="Integrity" />
              <h2 className="site-section-title" id="integrity-title">What the record can prove, and what it can’t.</h2>
              <p className="site-section-lede">
                Integrity claims are only useful when their limits are stated next to them.
              </p>
            </header>
            <div className="integrity__columns">
              <div>
                <h3 className="integrity__label">Checks in place</h3>
                <dl className="ledger">
                  {CHECKS.map(([term, detail]) => (
                    <div className="ledger__row" key={term}>
                      <dt>{term}</dt>
                      <dd>{detail}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              <div>
                <h3 className="integrity__label integrity__label--limits">Limits, stated plainly</h3>
                <dl className="ledger ledger--limits">
                  {LIMITS.map(([term, detail]) => (
                    <div className="ledger__row" key={term}>
                      <dt>{term}</dt>
                      <dd>{detail}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          </div>
        </section>

        <section className="closing" aria-labelledby="closing-title">
          <div className="site-container closing__inner">
            <h2 className="closing__title" id="closing-title">
              Close next month’s payroll with the evidence attached<span className="hero__point">.</span>
            </h2>
            <div className="closing__actions" data-loading={loading ? '' : undefined}>
              <Link to={primaryAction.to} className="site-btn site-btn--primary site-btn--large">
                {primaryAction.label}
                <span aria-hidden="true" className="site-btn__arrow">→</span>
              </Link>
              {!user && <Link to="/login" className="site-link">Sign in to an existing workspace</Link>}
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="site-container site-footer__inner">
          <div className="site-footer__brand">
            <ProoflineMark size={24} />
            <span>© {new Date().getFullYear()} PayGuard</span>
          </div>
          <ServiceStatus />
        </div>
      </footer>
    </div>
  );
}
