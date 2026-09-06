import { useEffect, useState } from 'react';
import * as complianceService from '../services/complianceService';

export default function Compliance() {
  const [rules, setRules] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    complianceService
      .listRules({ limit: 100 })
      .then((result) => setRules(result.data?.rules || []))
      .catch((err) =>
        setError(
          err.response?.data?.message ||
            'Unable to load compliance rules.'
        )
      )
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-8">

      {/* ==================== PAGE HEADER ==================== */}
      <div>
        <p
          className="eyebrow"
          style={{ color: '#A6192E' }}
        >
          Versioned configuration
        </p>

        <h1
          className="page-title"
          style={{ color: '#241F20' }}
        >
          Compliance Center
        </h1>

        <p
          className="page-subtitle"
          style={{ color: '#6F6565' }}
        >
          Read-only statutory rule versions returned by the backend.
        </p>
      </div>

      {/* ==================== ERROR ==================== */}
      {error && (
        <div
          className="alert alert-danger"
          role="alert"
        >
          {error}
        </div>
      )}

      {/* ==================== RULE SUMMARY CARDS ==================== */}
      <div className="grid gap-4 md:grid-cols-3">

        <RuleCard
          title="EPF"
          rules={rules.filter(
            (rule) => rule.ruleType === 'EPF'
          )}
        />

        <RuleCard
          title="ESI"
          rules={rules.filter(
            (rule) => rule.ruleType === 'ESI'
          )}
        />

        <RuleCard
          title="PT"
          rules={rules.filter(
            (rule) => rule.ruleType === 'PT'
          )}
        />

      </div>

      {/* ==================== RULE REGISTRY ==================== */}
      <section
        className="panel"
        style={{
          backgroundColor: '#FFFFFF',
          borderColor: '#E7D8D5',
        }}
      >

        <div
          className="flex items-center justify-between border-b pb-5"
          style={{ borderColor: '#E7D8D5' }}
        >

          <div>
            <p
              className="eyebrow"
              style={{ color: '#A6192E' }}
            >
              Rule registry
            </p>

            <h2
              className="section-title"
              style={{ color: '#241F20' }}
            >
              Configured rule versions
            </h2>
          </div>

          <span
            className="status"
            style={{
              backgroundColor: '#F8E8EA',
              borderColor: '#E7D8D5',
              color: '#A6192E',
            }}
          >
            Read only
          </span>

        </div>

        {/* ==================== LOADING ==================== */}
        {loading ? (

          <div
            className="py-14 text-center text-sm"
            style={{ color: '#6F6565' }}
          >
            Loading compliance rules...
          </div>

        ) : rules.length === 0 ? (

          /* ==================== EMPTY ==================== */
          <div className="empty-state">

            <p
              className="font-semibold"
              style={{ color: '#241F20' }}
            >
              No rule configuration available.
            </p>

            <p
              className="mt-1 text-sm"
              style={{ color: '#6F6565' }}
            >
              The backend returned no configured statutory rules.
            </p>

          </div>

        ) : (

          /* ==================== TABLE ==================== */
          <div className="pg-scrollbar mt-5 overflow-x-auto">

            <table className="data-table">

              <thead>
                <tr>
                  <th>Rule type</th>
                  <th>Jurisdiction</th>
                  <th>Effective from</th>
                  <th>Effective to</th>
                  <th>Source</th>
                  <th />
                </tr>
              </thead>

              <tbody>

                {rules.map((rule) => (

                  <tr key={rule._id}>

                    {/* RULE TYPE */}
                    <td>
                      <span
                        className="font-semibold"
                        style={{ color: '#A6192E' }}
                      >
                        {rule.ruleType}
                      </span>
                    </td>

                    {/* JURISDICTION */}
                    <td>
                      <span style={{ color: '#241F20' }}>
                        {rule.jurisdiction}
                      </span>
                    </td>

                    {/* EFFECTIVE FROM */}
                    <td>
                      {formatDate(rule.effectiveFrom)}
                    </td>

                    {/* EFFECTIVE TO */}
                    <td>
                      {rule.effectiveTo
                        ? formatDate(rule.effectiveTo)
                        : 'Open-ended'}
                    </td>

                    {/* SOURCE */}
                    <td>
                      <span
                        className="text-sm"
                        style={{ color: '#6F6565' }}
                      >
                        {rule.description || 'Not provided'}
                      </span>
                    </td>

                    {/* ACTION */}
                    <td className="text-right">

                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => setSelected(rule)}
                        style={{
                          backgroundColor: '#FFFFFF',
                          borderColor: '#E7D8D5',
                          color: '#A6192E',
                        }}
                      >
                        View detail
                      </button>

                    </td>

                  </tr>

                ))}

              </tbody>

            </table>

          </div>

        )}

      </section>

      {/* ==================== DEFERRED FEATURES ==================== */}
      <section className="grid gap-4 md:grid-cols-2">

        <div
          className="panel"
          style={{
            backgroundColor: '#FFF7F0',
            borderColor: '#E7D8D5',
          }}
        >

          <p
            className="eyebrow"
            style={{ color: '#A6192E' }}
          >
            TDS
          </p>

          <h2
            className="section-title"
            style={{ color: '#241F20' }}
          >
            DEFERRED
          </h2>

          <p
            className="mt-3 text-sm leading-6"
            style={{ color: '#6F6565' }}
          >
            TDS calculation is outside the current MVP scope.
          </p>

        </div>

        <div
          className="panel"
          style={{
            backgroundColor: '#FFF7F0',
            borderColor: '#E7D8D5',
          }}
        >

          <p
            className="eyebrow"
            style={{ color: '#A6192E' }}
          >
            Attendance adjustment
          </p>

          <h2
            className="section-title"
            style={{ color: '#241F20' }}
          >
            DEFERRED
          </h2>

          <p
            className="mt-3 text-sm leading-6"
            style={{ color: '#6F6565' }}
          >
            No attendance subsystem exists in the current backend.
          </p>

        </div>

      </section>

      {/* ==================== RULE DETAIL MODAL ==================== */}
      {selected && (
        <RuleDetail
          rule={selected}
          onClose={() => setSelected(null)}
        />
      )}

    </div>
  );
}


/* ============================================================
   RULE CARD
============================================================ */

function RuleCard({ title, rules }) {
  return (
    <div
      className="panel"
      style={{
        backgroundColor: '#FFFFFF',
        borderColor: '#E7D8D5',
      }}
    >

      <div className="flex items-center justify-between">

        <h2
          className="text-lg font-semibold"
          style={{ color: '#241F20' }}
        >
          {title}
        </h2>

        <span
          className="status"
          style={
            rules.length
              ? {
                  backgroundColor: '#F8E8EA',
                  borderColor: '#E7D8D5',
                  color: '#A6192E',
                }
              : {
                  backgroundColor: '#F7F5F3',
                  borderColor: '#E7D8D5',
                  color: '#6F6565',
                }
          }
        >
          {rules.length
            ? `${rules.length} version${
                rules.length === 1 ? '' : 's'
              }`
            : 'Unavailable'}
        </span>

      </div>

      <p
        className="mt-4 text-sm"
        style={{ color: '#6F6565' }}
      >
        {rules.length
          ? 'Configured in the backend rule registry.'
          : 'No rule returned by the backend.'}
      </p>

    </div>
  );
}


/* ============================================================
   RULE DETAIL MODAL
============================================================ */

function RuleDetail({ rule, onClose }) {
  return (
    <div className="dialog-backdrop">

      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rule-detail-title"
        style={{
          backgroundColor: '#FFFFFF',
          borderColor: '#E7D8D5',
        }}
      >

        {/* MODAL HEADER */}
        <div className="flex items-start justify-between">

          <div>

            <p
              className="eyebrow"
              style={{ color: '#A6192E' }}
            >
              Rule detail
            </p>

            <h2
              id="rule-detail-title"
              className="section-title"
              style={{ color: '#241F20' }}
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
              color: '#A6192E',
            }}
          >
            ×
          </button>

        </div>

        {/* RULE INFORMATION */}
        <dl
          className="mt-6 divide-y text-sm"
          style={{ borderColor: '#E7D8D5' }}
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

              <dt style={{ color: '#6F6565' }}>
                {label}
              </dt>

              <dd
                className="text-right font-medium"
                style={{ color: '#241F20' }}
              >
                {value}
              </dd>

            </div>

          ))}

        </dl>

        <p
          className="mt-5 text-xs leading-5"
          style={{ color: '#6F6565' }}
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
  return value
    ? new Date(value).toLocaleDateString('en-IN')
    : 'Not available';
}