import { ReadinessBadge, monthLabel } from './shared';

/** "Can this employee safely enter the next payroll?" with the reasons. */
export default function ReadinessPanel({ data }) {
  if (!data) return null;
  const { period, readiness } = data;

  return (
    <section className="panel" aria-labelledby="readiness-title">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <p className="eyebrow">Payroll readiness</p>
          <h2 id="readiness-title" className="section-title">
            {monthLabel(period.periodYear, period.periodMonth)} payroll
          </h2>
        </div>
        <ReadinessBadge state={readiness.state} />
      </div>

      {readiness.state === 'READY' ? (
        <p className="mt-4 text-sm text-[#26765F]">
          Nothing is missing. Payroll can calculate this employee and has what it needs to pay them.
        </p>
      ) : (
        <ul className="mt-5 space-y-2" aria-label="Readiness findings">
          {readiness.blockers.map((blocker) => (
            <li key={blocker.code} className="alert alert-danger">
              <span className="font-semibold">Blocks payroll:</span> {blocker.message}
            </li>
          ))}
          {readiness.warnings.map((warning) => (
            <li key={`${warning.code}-${warning.message}`} className="alert alert-warn">
              {warning.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
