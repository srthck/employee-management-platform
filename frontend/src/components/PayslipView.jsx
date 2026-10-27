/**
 * PayslipView
 *
 * Renders an explained payslip returned by the API (admin explain endpoint or
 * employee self-service). Every deduction shows the formula with real numbers
 * and the rule version it came from, plus the payslip's own consistency checks
 * and integrity verification.
 */

const money = (value) =>
  typeof value === 'number'
    ? new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        minimumFractionDigits: 2,
      }).format(value)
    : 'Not available';

const formatDate = (value) =>
  value ? new Date(value).toLocaleDateString('en-IN') : 'Not available';

function Metric({ label, value, note }) {
  return (
    <div className="min-w-0">
      <p className="text-[12.5px] font-medium text-ink-2">
        {label}
      </p>
      <p className="mt-1.5 break-words text-[19px] font-medium leading-tight tabular-nums text-ink">
        {value}
      </p>
      {note && <p className="mt-1 text-xs text-ink-2">{note}</p>}
    </div>
  );
}

function LineSection({ eyebrow, title, lines, total, totalLabel }) {
  return (
    <section className="panel">
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="section-title">{title}</h2>

      {lines.length === 0 ? (
        <p className="mt-5 text-sm text-ink-2">None for this period.</p>
      ) : (
        <ul className="mt-5 divide-y divide-line">
          {lines.map((line) => (
            <li key={line.code} className="py-3">
              <div className="flex justify-between gap-4 text-sm">
                <span
                  className={
                    line.includedInEmployerTotal
                      ? 'pl-4 text-ink-2'
                      : 'font-medium text-ink'
                  }
                >
                  {line.label}
                </span>
                <span className="font-semibold tabular-nums text-ink">
                  {money(line.amount)}
                </span>
              </div>

              {line.formula && (
                <p className="mt-1 break-words font-mono text-xs leading-5 text-ink-2">
                  {line.formula}
                </p>
              )}

              {line.source && (
                <p className="mt-1 text-[11px] leading-4 text-ink-2">
                  Rule {line.source.ruleType} · {line.source.jurisdiction} · effective{' '}
                  {formatDate(line.source.effectiveFrom)}
                  {line.source.reference ? ` · ${line.source.reference}` : ''}
                </p>
              )}

              {line.rateDerivedFromAmounts && (
                <p className="mt-1 text-[11px] text-warn">
                  Rate derived from stored amounts: this record predates frozen rule parameters.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex justify-between gap-4 border-t border-line pt-4 text-sm font-semibold text-ink">
        <span>{totalLabel}</span>
        <span className="tabular-nums">{money(total)}</span>
      </div>
    </section>
  );
}

export default function PayslipView({ payslip }) {
  const {
    period,
    employee,
    earnings,
    deductions,
    employerContributions,
    totals,
    checks,
    integrity,
    notes,
    limitations,
  } = payslip;

  const checksPass = Object.values(checks).every(Boolean);

  return (
    <div className="space-y-6">
      <section className="panel">
        <div className="flex flex-col justify-between gap-4 border-b border-line pb-5 sm:flex-row sm:items-start">
          <div>
            <p className="eyebrow">Payslip · {period.label}</p>
            <h2 className="section-title">{employee.name}</h2>
            <p className="mt-1 text-sm text-ink-2">
              {[employee.position, employee.department, employee.workState && `Work state ${employee.workState}`]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <span className={`status ${integrity.verified ? 'status-success' : 'status-danger'}`}>
              {integrity.verified ? '✓ Integrity verified' : '✕ Integrity failure'}
            </span>
            <span className={`status ${checksPass ? 'status-success' : 'status-warn'}`}>
              {checksPass ? '✓ Totals reconcile' : '⚠ Totals do not reconcile'}
            </span>
          </div>
        </div>

        <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Gross earnings" value={money(totals.gross)} />
          <Metric label="Deductions" value={money(totals.totalDeductions)} />
          <Metric label="Net pay" value={money(totals.netPayBeforeTDS)} note="Before income tax (TDS)" />
          <Metric label="Cost to company" value={money(totals.costToCompany)} note="Gross + employer contributions" />
        </div>

        <p className="mt-5 break-words font-mono text-xs text-ink-2">
          Net pay: {totals.netPayFormula}
        </p>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <LineSection
          eyebrow="Salary components"
          title="Earnings"
          lines={earnings}
          total={totals.gross}
          totalLabel="Gross"
        />
        <LineSection
          eyebrow="How each deduction was calculated"
          title="Deductions"
          lines={deductions}
          total={totals.totalDeductions}
          totalLabel="Total deductions"
        />
      </div>

      {employerContributions.length > 0 && (
        <LineSection
          eyebrow="Paid by the employer, not deducted from pay"
          title="Employer contributions"
          lines={employerContributions}
          total={totals.employerContributions}
          totalLabel="Employer total"
        />
      )}

      {(notes.length > 0 || limitations.length > 0) && (
        <section className="panel space-y-4">
          {notes.length > 0 && (
            <div>
              <p className="eyebrow">Notes</p>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink-2">
                {notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          )}

          {limitations.length > 0 && (
            <div className="alert alert-warn">
              <p className="font-semibold">Not included in this payslip</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {limitations.map((limitation) => (
                  <li key={limitation}>{limitation}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
