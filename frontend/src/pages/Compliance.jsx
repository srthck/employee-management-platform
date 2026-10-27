import { useEffect, useState } from 'react';
import * as complianceService from '../services/complianceService';
import StatusBadge from '../components/ui/StatusBadge';
import { PageHeader, EmptyState, LoadingState } from '../components/ui/PageParts';

const AREAS = [
  { type: 'EPF', name: 'Provident fund (EPF)', missing: 'Employees enrolled in PF cannot be calculated.' },
  { type: 'ESI', name: 'Employee state insurance (ESI)', missing: 'Employees covered by ESI cannot be calculated.' },
  { type: 'PT', name: 'Professional tax (PT)', missing: 'Employees in a state without a PT version cannot be calculated.' },
];

function CoverageRow({ name, children }) {
  return (
    <li className="grid gap-x-4 gap-y-1.5 px-5 py-3.5 sm:grid-cols-[230px_minmax(0,1fr)] sm:items-center sm:px-6">
      <p className="text-sm font-semibold text-ink">{name}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">{children}</div>
    </li>
  );
}

export default function Compliance() {
  const [rules, setRules] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    complianceService
      .listRules({ limit: 100 })
      .then((result) => setRules(result.data?.rules || []))
      .catch((err) => setError(err.response?.data?.message || 'Unable to load compliance rules.'))
      .finally(() => setLoading(false));
  }, []);

  const coverage = AREAS.map((area) => {
    const versions = rules.filter((rule) => rule.ruleType === area.type);
    const jurisdictions = [...new Set(versions.map((rule) => rule.jurisdiction))].sort();
    return { ...area, versions, jurisdictions };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Statutory configuration"
        title="Compliance Center"
        subtitle="The statutory rule versions payroll calculates with. This page is read only."
      />

      {error && <div className="alert alert-danger" role="alert">{error}</div>}

      <section className="panel !p-0" aria-labelledby="coverage-title">
        <div className="px-5 pt-5 sm:px-6 sm:pt-6">
          <p className="eyebrow">Coverage</p>
          <h2 className="section-title" id="coverage-title">What payroll can calculate</h2>
          <p className="mt-1 text-[13px] leading-5 text-ink-2">
            “Configured” means a rule version exists for the area. It is not a statement that payroll is compliant:
            check each version’s source against the current notification.
          </p>
        </div>
        {loading ? (
          <div className="px-6 py-6"><LoadingState label="Loading rule coverage" /></div>
        ) : (
          <ul className="mt-4 divide-y divide-line border-t border-line">
            {coverage.map((area) => (
              <CoverageRow key={area.type} name={area.name}>
                {area.versions.length
                  ? <StatusBadge tone="verified">Configured</StatusBadge>
                  : <StatusBadge tone="attention">No version on file</StatusBadge>}
                <span className="text-[13px] text-ink-2">
                  {area.versions.length
                    ? `${area.versions.length} ${area.versions.length === 1 ? 'version' : 'versions'} · jurisdiction ${area.jurisdictions.join(', ')}`
                    : area.missing}
                </span>
              </CoverageRow>
            ))}
            <CoverageRow name="Income tax (TDS)">
              <StatusBadge tone="deferred">Deferred</StatusBadge>
              <span className="text-[13px] text-ink-2">Outside the current scope. Payroll shows net pay before TDS.</span>
            </CoverageRow>
            <CoverageRow name="Attendance adjustment">
              <StatusBadge tone="deferred">Deferred</StatusBadge>
              <span className="text-[13px] text-ink-2">No attendance subsystem. Pay is prorated only for joiners and leavers.</span>
            </CoverageRow>
          </ul>
        )}
      </section>

      <section className="panel !p-0" aria-labelledby="versions-title">
        <div className="flex flex-wrap items-end justify-between gap-3 px-5 pt-5 sm:px-6 sm:pt-6">
          <div>
            <p className="eyebrow">Rule registry</p>
            <h2 className="section-title" id="versions-title">Configured rule versions</h2>
          </div>
          <StatusBadge tone="neutral">Read only</StatusBadge>
        </div>

        {loading ? (
          <div className="px-6 py-6"><LoadingState label="Loading compliance rules" /></div>
        ) : rules.length === 0 ? (
          <EmptyState kind="blocked" title="No rule versions configured">
            The backend returned no statutory rule versions, so payroll cannot calculate statutory deductions.
          </EmptyState>
        ) : (
          <div tabIndex={0} className="pg-scrollbar mt-4 overflow-x-auto border-t border-line">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="!rounded-none">Rule</th>
                  <th>Effective</th>
                  <th>What it encodes</th>
                  <th className="!rounded-none"><span className="sr-only">Detail</span></th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule._id}>
                    <td className="whitespace-nowrap">
                      <span className="block font-semibold text-ink">{rule.ruleType}</span>
                      <span className="block text-xs text-ink-2">Jurisdiction {rule.jurisdiction}</span>
                    </td>
                    <td className="whitespace-nowrap">
                      <span className="block text-ink">From {formatDate(rule.effectiveFrom)}</span>
                      <span className="block text-xs text-ink-2">{rule.effectiveTo ? `Until ${formatDate(rule.effectiveTo)}` : 'No end date'}</span>
                    </td>
                    <td className="max-w-[640px] text-[13px] leading-5 text-ink-2">{rule.description || 'Not provided'}</td>
                    <td className="text-right">
                      <button type="button" className="btn btn-small" onClick={() => setSelected(rule)}>
                        Details<span className="sr-only"> for {rule.ruleType} {rule.jurisdiction}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selected && <RuleDetail rule={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function RuleDetail({ rule, onClose }) {
  return (
    <div className="dialog-backdrop">

      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rule-detail-title"
        style={{
          backgroundColor: 'var(--pg-surface)',
          borderColor: 'var(--pg-line)',
        }}
      >

        {/* MODAL HEADER */}
        <div className="flex items-start justify-between">

          <div>

            <p
              className="eyebrow"
            >
              Rule detail
            </p>

            <h2
              id="rule-detail-title"
              className="section-title"
              style={{ color: 'var(--pg-ink)' }}
            >
              {rule.ruleType} · {rule.jurisdiction}
            </h2>

          </div>

          <button
            type="button"
            className="icon-button"
            aria-label="Close rule detail"
            onClick={onClose}
            style={{
              color: 'var(--pg-crimson)',
            }}
          >
            ×
          </button>

        </div>

        {/* RULE INFORMATION */}
        <dl
          className="mt-6 divide-y text-sm"
          style={{ borderColor: 'var(--pg-line)' }}
        >

          {[
            ['Version ID', rule._id],
            [
              'Effective from',
              formatDate(rule.effectiveFrom),
            ],
            [
              'Effective to',
              rule.effectiveTo
                ? formatDate(rule.effectiveTo)
                : 'Open-ended',
            ],
            [
              'Source',
              rule.description || 'Not provided',
            ],
            ['Created', formatDate(rule.createdAt)],
          ].map(([label, value]) => (

            <div
              key={label}
              className="flex justify-between gap-4 py-3"
            >

              <dt style={{ color: 'var(--pg-ink-2)' }}>
                {label}
              </dt>

              <dd
                className="text-right font-medium"
                style={{ color: 'var(--pg-ink)' }}
              >
                {value}
              </dd>

            </div>

          ))}

        </dl>

        <p
          className="mt-5 text-xs leading-5"
          style={{ color: 'var(--pg-ink-2)' }}
        >
          This exact rule version can be preserved with historical
          payroll records.
        </p>

      </div>

    </div>
  );
}


/* ============================================================
   DATE FORMATTER
============================================================ */

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Not available';
}