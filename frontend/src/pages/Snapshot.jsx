import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import * as snapshotService from '../services/payrollSnapshotService';
import { money } from './Overview';

export default function Snapshot() {
  const { id } = useParams();

  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [verification, setVerification] = useState(null);
  const [error, setError] = useState('');
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    snapshotService
      .getSnapshot(id)
      .then((r) => setSnapshot(r.data?.snapshot))
      .catch((e) =>
        setError(
          e.response?.data?.message || 'Unable to load snapshot.'
        )
      )
      .finally(() => setLoading(false));
  }, [id]);

  const verify = async () => {
    setVerifying(true);

    try {
      const result = await snapshotService.verifySnapshot(id);
      setVerification(result.data || result);
    } catch (e) {
      setError(
        e.response?.data?.message || 'Snapshot verification failed.'
      );
    } finally {
      setVerifying(false);
    }
  };

  if (loading) {
    return (
      <div className="panel py-16 text-center text-sm text-[#6F6565]">
        Loading snapshot...
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="alert alert-danger">
        {error || 'Snapshot not found.'}
      </div>
    );
  }

  const employee = snapshot.employeeSnapshot;
  const salary = snapshot.salarySnapshot;
  const result = snapshot.payrollResults;

  return (
    <div className="space-y-8">
      {/* BACK LINK */}
      <Link
        to="/payroll"
        className="inline-flex items-center text-sm font-semibold text-[#A6192E] transition hover:text-[#7D1022]"
      >
        ← Payroll runs
      </Link>

      {/* PAGE HEADER */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="eyebrow">Immutable payroll record</p>

          <h1 className="page-title">
            Payroll Snapshot
          </h1>

          <p className="page-subtitle">
            {employee?.fullName} · {snapshot.periodMonth}/
            {snapshot.periodYear}
          </p>
        </div>

        <span className="status status-success">
          ✓ {snapshot.snapshotStatus}
        </span>
      </div>

      {/* ERROR */}
      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}

      {/* SNAPSHOT CARDS */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Employee snapshot">
          <Rows
            rows={[
              ['Name', employee?.fullName],
              ['Department', employee?.department],
              ['Position', employee?.position],
              ['Employment status', employee?.employmentStatus],
              ['Work state', salary?.workState],
            ]}
          />
        </Card>

        <Card title="Salary snapshot">
          <Rows
            rows={[
              [
                'Salary version',
                salary?.salaryStructureId || 'Historical structure',
              ],
              [
                'Effective from',
                salary?.effectiveFrom
                  ? new Date(
                      salary.effectiveFrom
                    ).toLocaleDateString('en-IN')
                  : undefined,
              ],
              [
                'Basic',
                money(salary?.components?.basic),
              ],
              [
                'HRA',
                money(salary?.components?.hra),
              ],
              [
                'Special allowance',
                money(salary?.components?.specialAllowance),
              ],
              [
                'Gross',
                money(salary?.grossMonthly),
              ],
            ]}
          />
        </Card>

        <Card title="Compliance and provenance">
          <Rows
            rows={[
              [
                'EPF',
                result?.epf?.enrolled
                  ? 'Enrolled'
                  : 'Not enrolled',
              ],
              [
                'ESI',
                result?.esi?.applicable
                  ? 'Applicable'
                  : 'Not applicable',
              ],
              [
                'PT',
                result?.pt?.applicable
                  ? money(result.pt.pt)
                  : 'Not applicable',
              ],
              [
                'TDS',
                result?.tdsStatus || 'DEFERRED',
              ],
              [
                'Attendance',
                snapshot.payrollInputs
                  ?.attendanceAdjustment || 'DEFERRED',
              ],
            ]}
          />

          {snapshot.complianceProvenance?.length > 0 && (
            <div className="mt-5 border-t border-[#E7D8D5] pt-4">
              <p className="label">
                Rule provenance
              </p>

              {snapshot.complianceProvenance.map((rule) => (
                <div
                  key={rule.ruleId}
                  className="mt-3 rounded-[10px] border border-[#E7D8D5] bg-[#FFF7F0] p-3"
                >
                  <p className="text-sm font-semibold text-[#241F20]">
                    {rule.ruleType} · {rule.jurisdiction} · v
                    {String(rule.ruleId).slice(-6)}
                  </p>

                  <p className="mt-1 text-xs leading-5 text-[#6F6565]">
                    Effective{' '}
                    {new Date(
                      rule.effectiveFrom
                    ).toLocaleDateString('en-IN')}{' '}
                    ·{' '}
                    {rule.sourceReference ||
                      'Source not provided'}
                  </p>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Calculation result">
          <Rows
            rows={[
              [
                'Employee EPF',
                money(result?.epf?.employeeEpf),
              ],
              [
                'Employer EPF',
                money(result?.epf?.employerEpf),
              ],
              [
                'Employee ESI',
                money(result?.esi?.employeeEsi),
              ],
              [
                'Employer ESI',
                money(result?.esi?.employerEsi),
              ],
              [
                'Professional tax',
                money(result?.pt?.pt),
              ],
              [
                'Net pay before TDS',
                money(result?.netPayBeforeTDS),
              ],
            ]}
          />
        </Card>
      </div>

      {/* SNAPSHOT INTEGRITY */}
      <section className="panel">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <p className="eyebrow">Audit / integrity</p>

            <h2 className="section-title">
              Snapshot hash
            </h2>

            <p className="mt-2 font-mono text-xs text-[#6F6565]">
              {snapshot.snapshotHash
                ? `${snapshot.snapshotHash.slice(
                    0,
                    8
                  )}...${snapshot.snapshotHash.slice(-6)}`
                : 'Hash not returned'}
            </p>
          </div>

          <button
            type="button"
            className="btn btn-primary"
            disabled={verifying}
            onClick={verify}
          >
            {verifying
              ? 'Verifying snapshot...'
              : 'Verify snapshot'}
          </button>
        </div>

        {verification && (
          <div
            className={`mt-5 alert ${
              verification.valid
                ? 'alert-success'
                : 'alert-danger'
            }`}
            role="status"
          >
            {verification.valid
              ? '✓ SNAPSHOT INTEGRITY VERIFIED'
              : '✕ SNAPSHOT INTEGRITY FAILURE'}
          </div>
        )}
      </section>
    </div>
  );
}

function Card({ title, children }) {
  return (
    <section className="panel">
      <p className="eyebrow">Payroll record</p>

      <h2 className="section-title">
        {title}
      </h2>

      <div className="mt-5">
        {children}
      </div>
    </section>
  );
}

function Rows({ rows }) {
  return (
    <dl className="divide-y divide-[#E7D8D5]">
      {rows.map(([label, value]) => (
        <div
          key={label}
          className="flex justify-between gap-4 py-3 text-sm"
        >
          <dt className="text-[#6F6565]">
            {label}
          </dt>

          <dd className="max-w-[60%] text-right font-medium text-[#241F20]">
            {value ?? 'Not available'}
          </dd>
        </div>
      ))}
    </dl>
  );
}