import { useCallback, useContext, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AuthContext } from '../contexts/AuthContext';
import { can } from '../utils/permissions';
import * as employeeService from '../services/employeeService';
import * as payrollRunService from '../services/payrollRunService';
import * as auditService from '../services/auditService';
import * as complianceService from '../services/complianceService';
import * as profileService from '../services/employeeProfileService';
import Icon from '../components/ui/Icon';
import StatusBadge, { RunStatusBadge } from '../components/ui/StatusBadge';
import { PageHeader, EmptyState, LoadingState, Figure } from '../components/ui/PageParts';

const money = (value) =>
  typeof value === 'number'
    ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(value)
    : 'Not available';

const monthName = (month, year) =>
  month && year
    ? new Date(year, month - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
    : 'No payroll run';

const dateTime = (value) =>
  value
    ? new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;

const clock = (value) => new Date(value).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Run status badge, kept under its historical name for the pages that import it. */
export function Status({ value }) {
  return <RunStatusBadge status={value} />;
}

/** Each source loads on its own: one forbidden or failed call never blanks the page. */
const settle = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));

function useOverviewData(user) {
  const [state, setState] = useState({ loading: true });

  const load = useCallback(() => {
    setState((prev) => ({ ...prev, loading: true }));
    Promise.all([
      settle(payrollRunService.listPayrollRuns({ limit: 10 })),
      can(user, 'employee.read') ? settle(employeeService.getEmployeeStats()) : Promise.resolve(null),
      // A broken chain answers 409 with the verification result in its body.
      can(user, 'audit.verify')
        ? settle(auditService.verifyAuditChain().then((r) => r.data).catch((err) => {
          if (err.response?.data?.data) return err.response.data.data;
          throw err;
        }))
        : Promise.resolve(null),
      can(user, 'compliance.read') ? settle(complianceService.listRules({ limit: 100 })) : Promise.resolve(null),
      settle(profileService.getCompanyReadiness()),
    ]).then(([runs, stats, chain, rules, readiness]) => {
      setState({
        loading: false,
        loadedAt: new Date(),
        runs: runs.ok ? runs.value.data?.runs || [] : null,
        runsError: runs.ok ? null : runs.error.response?.data?.message || 'Payroll runs could not be loaded.',
        stats: stats?.ok ? stats.value.data?.stats || null : null,
        statsState: stats == null ? 'forbidden' : stats.ok ? 'ok' : 'error',
        chain: chain?.ok ? chain.value : null,
        chainState: chain == null ? 'forbidden' : chain.ok ? 'ok' : 'error',
        chainCheckedAt: chain?.ok ? new Date() : null,
        rules: rules?.ok ? rules.value.data?.rules || rules.value.data || [] : null,
        rulesState: rules == null ? 'forbidden' : rules.ok ? 'ok' : 'error',
        readiness: readiness.ok ? readiness.value?.data || null : null,
        readinessState: readiness.ok ? 'ok' : 'error',
      });
    });
  }, [user]);

  useEffect(() => { load(); }, [load]);
  return [state, load];
}

/* ── Latest payroll run ─────────────────────────────────────────────────── */

function LatestRun({ run, error, canWriteEmployees }) {
  if (error) {
    return (
      <section className="panel" aria-labelledby="latest-run-title">
        <p className="eyebrow" id="latest-run-title">Latest payroll run</p>
        <EmptyState kind="error" title="Payroll runs could not be loaded">{error}</EmptyState>
      </section>
    );
  }
  if (!run) {
    return (
      <section className="panel" aria-labelledby="latest-run-title">
        <p className="eyebrow" id="latest-run-title">Latest payroll run</p>
        <EmptyState
          title="No payroll run yet"
          action={<Link className="btn btn-primary" to="/payroll">Create a payroll run</Link>}
        >
          A run covers one calendar month. Creating one starts with a preflight check of every active employee.
        </EmptyState>
      </section>
    );
  }

  const preflight = run.preflightResult;
  const eligible = preflight?.eligibleEmployeeCount;
  const blockingErrors = preflight?.blockingErrors || [];
  const scopeNotes = preflight?.warnings || [];
  const failed = run.status === 'FAILED';
  const zeroEligible = preflight && eligible === 0;
  const updated = run.failedAt || run.finalizedAt || run.readyForFinalizationAt || run.completedAt || run.lastActivityAt || run.updatedAt || run.createdAt;

  return (
    <section className={`panel overflow-hidden !p-0 ${failed ? 'border-bad-line' : ''}`} aria-labelledby="latest-run-title">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5 sm:px-6 sm:pt-6">
        <div className="min-w-0">
          <p className="eyebrow">Latest payroll run</p>
          <h2 className="mt-1 text-[24px] font-bold tracking-[-0.025em] text-ink" id="latest-run-title">
            {monthName(run.periodMonth, run.periodYear)}
          </h2>
          <p className="mt-1 text-[12.5px] text-ink-2">
            <span className="font-mono">Run {String(run._id).slice(-8)}</span>
            {updated && <> · {failed ? 'Failed' : 'Updated'} {dateTime(updated)}</>}
          </p>
        </div>
        <RunStatusBadge status={run.status} />
      </div>

      {failed && (
        <div className="mx-5 mt-5 rounded-[12px] border border-bad-line bg-bad-tint p-4 sm:mx-6" role="group" aria-label="Why this run failed">
          <p className="flex items-center gap-2 text-sm font-semibold text-bad">
            <Icon name="x-circle" size={17} strokeWidth={2} /> Why this run failed
          </p>
          <p className="mt-1.5 text-sm leading-6 text-ink">
            {run.failureReason || 'The run did not record a failure reason. Open the run to inspect its preflight and processing results.'}
          </p>
          {blockingErrors.length > 0 && (
            <div className="mt-3 border-t border-bad-line/70 pt-3">
              <p className="text-[12.5px] font-semibold text-ink">Preflight blocking {blockingErrors.length === 1 ? 'error' : 'errors'}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm leading-6 text-ink">
                {blockingErrors.map((message) => <li key={message}>{message}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* The run's figures read as the product's hairline strip: one rule per
          cell, coral on the figure that is holding the run up. */}
      <dl className="feature-strip mx-5 mb-6 mt-5 sm:mx-6">
        <div className="feature-strip__item">
          <Figure
            label="Employees"
            value={run.employeeCount ?? '—'}
            note={run.employeeCount === 0 ? 'No employee was in scope for this run' : 'In scope for this run'}
          />
        </div>
        <div className="feature-strip__item" data-active={!preflight || zeroEligible || preflight.blockedEmployeeCount ? '' : undefined}>
          <Figure
            label="Eligible"
            value={preflight ? eligible ?? '—' : 'Not evaluated'}
            note={!preflight ? 'Preflight has not run' : zeroEligible ? 'Nobody passed preflight' : `Passed preflight${preflight.blockedEmployeeCount ? `, ${preflight.blockedEmployeeCount} blocked` : ''}`}
          />
        </div>
        <div className="feature-strip__item" data-active={run.failedEmployeeCount ? '' : undefined}>
          <Figure
            label="Processed"
            value={`${run.processedEmployeeCount ?? 0} / ${run.employeeCount ?? 0}`}
            note={run.failedEmployeeCount ? `${run.failedEmployeeCount} failed in calculation` : `${run.successfulEmployeeCount ?? 0} calculated successfully`}
          />
        </div>
        <div className="feature-strip__item">
          <Figure
            label="Snapshots"
            value={run.durableResultCount ?? 0}
            note={run.durableResultCount ? 'Stored results for finalization' : 'No results stored'}
          />
        </div>
      </dl>

      {scopeNotes.length > 0 && (
        <details className="group border-t border-line px-5 py-3 sm:px-6">
          <summary className="flex min-h-[32px] cursor-pointer list-none items-center gap-2 text-[13px] font-medium text-ink-2 hover:text-ink">
            <Icon name="chevron-right" size={15} className="transition-transform group-open:rotate-90" />
            {scopeNotes.length} scope {scopeNotes.length === 1 ? 'note' : 'notes'} recorded at preflight
          </summary>
          <ul className="mt-2 space-y-2 pb-1 pl-6 text-[13px] leading-5 text-ink-2">
            {scopeNotes.map((note) => <li key={note}>{note}</li>)}
          </ul>
        </details>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-line bg-[var(--pg-glass-quiet)] px-5 py-4 sm:px-6">
        <Link to={`/payroll/${run._id}`} className="btn btn-primary">
          Inspect run <Icon name="arrow-right" size={16} />
        </Link>
        {zeroEligible && canWriteEmployees && (
          <Link to="/employees" className="btn">Review employees</Link>
        )}
        {failed && (
          <p className="text-xs leading-5 text-ink-2 sm:ml-2">
            The run page shows its preflight results and the actions its state allows.
          </p>
        )}
      </div>
    </section>
  );
}

/* ── Control checks ─────────────────────────────────────────────────────── */

function buildChecks(data) {
  const { readiness, readinessState, rules, rulesState, chain, chainState } = data;
  const summary = readiness?.summary;
  const people = readiness?.employees || [];
  const periodLabel = readiness?.period ? monthName(readiness.period.periodMonth, readiness.period.periodYear) : 'the next period';
  const withCode = (codes) => people.filter((p) => p.blockers?.some((b) => codes.includes(b.code))).length;

  const checks = [];

  // Employee eligibility (payroll readiness)
  if (readinessState !== 'ok') {
    checks.push({ key: 'eligibility', label: 'Employee eligibility', tone: 'unknown', status: 'Unavailable', detail: 'Payroll readiness could not be loaded.' });
  } else if (!summary?.total) {
    checks.push({ key: 'eligibility', label: 'Employee eligibility', tone: 'attention', status: 'No employees', detail: `No active employee to evaluate for ${periodLabel}.`, to: '/employees', action: 'Open employees' });
  } else if (summary.blocked) {
    checks.push({ key: 'eligibility', label: 'Employee eligibility', tone: 'attention', status: `${summary.blocked} blocked`, detail: `${summary.ready} ready, ${summary.warning} with warnings, ${summary.blocked} cannot be calculated for ${periodLabel}.`, to: '/employees', action: 'Review blocked' });
  } else {
    checks.push({ key: 'eligibility', label: 'Employee eligibility', tone: 'verified', status: `${summary.total} can be calculated`, detail: `${summary.warning ? `${summary.warning} with warnings. ` : ''}Evaluated for ${periodLabel}.`, to: summary.warning ? '/employees' : undefined, action: summary.warning ? 'Review warnings' : undefined });
  }

  // Salary configuration
  if (readinessState !== 'ok') {
    checks.push({ key: 'salary', label: 'Salary configuration', tone: 'unknown', status: 'Unavailable', detail: 'Depends on payroll readiness, which could not be loaded.' });
  } else if (!summary?.total) {
    checks.push({ key: 'salary', label: 'Salary configuration', tone: 'unknown', status: 'Not checked', detail: 'There are no active employees whose salary could be checked.' });
  } else {
    const missing = withCode(['NO_SALARY_VERSION']);
    checks.push(missing
      ? { key: 'salary', label: 'Salary configuration', tone: 'attention', status: `${missing} without salary`, detail: `No salary version is in effect for ${periodLabel}.`, to: '/employees', action: 'Open employees' }
      : { key: 'salary', label: 'Salary configuration', tone: 'verified', status: 'In effect for all', detail: `Every evaluated employee has a salary version for ${periodLabel}.` });
  }

  // Compliance rule versions
  const types = Array.isArray(rules) ? [...new Set(rules.map((r) => r.ruleType))].sort() : [];
  const ruleBlocked = readinessState === 'ok' ? withCode(['EPF_RULE_MISSING', 'ESI_RULE_MISSING', 'MISSING_PT_JURISDICTION', 'UNSUPPORTED_PT_JURISDICTION']) : 0;
  if (rulesState === 'forbidden') {
    checks.push({ key: 'rules', label: 'Compliance rules', tone: 'unknown', status: 'Not visible to your role', detail: 'Rule versions need the compliance read permission.' });
  } else if (rulesState !== 'ok') {
    checks.push({ key: 'rules', label: 'Compliance rules', tone: 'unknown', status: 'Unavailable', detail: 'Rule versions could not be loaded.' });
  } else if (ruleBlocked) {
    checks.push({ key: 'rules', label: 'Compliance rules', tone: 'attention', status: `${ruleBlocked} employee${ruleBlocked === 1 ? '' : 's'} blocked`, detail: 'A required rule version or professional-tax state is missing.', to: '/compliance', action: 'Open compliance' });
  } else if (!types.length) {
    checks.push({ key: 'rules', label: 'Compliance rules', tone: 'attention', status: 'None on file', detail: 'No statutory rule versions are configured.', to: '/compliance', action: 'Open compliance' });
  } else {
    checks.push({ key: 'rules', label: 'Compliance rules', tone: 'verified', status: `${types.join(', ')} on file`, detail: 'Versions exist for these rule types. This is not a statement that payroll is compliant.', to: '/compliance', action: 'View versions' });
  }

  // Audit chain
  if (chainState === 'forbidden') {
    checks.push({ key: 'audit', label: 'Audit chain', tone: 'unknown', status: 'Not checked', detail: 'Verifying the chain needs the audit verify permission.' });
  } else if (chainState !== 'ok' || !chain) {
    checks.push({ key: 'audit', label: 'Audit chain', tone: 'unknown', status: 'Unavailable', detail: 'Verification did not complete.' });
  } else if (chain.valid) {
    checks.push({ key: 'audit', label: 'Audit chain', tone: 'verified', status: 'Verified', detail: `${chain.checkedRecords} records checked at ${clock(data.chainCheckedAt)}.`, to: '/audit', action: 'Open audit trail' });
  } else {
    checks.push({ key: 'audit', label: 'Audit chain', tone: 'failed', status: `Broken at #${chain.firstBrokenSequence}`, detail: chain.reason || 'A record does not match the chain.', to: '/audit', action: 'Open audit trail' });
  }

  checks.push({ key: 'tds', label: 'TDS', tone: 'deferred', status: 'Deferred', detail: 'Not calculated. Net pay is shown before TDS.' });
  checks.push({ key: 'attendance', label: 'Attendance adjustment', tone: 'deferred', status: 'Deferred', detail: 'No attendance subsystem. Pay is prorated only for joiners and leavers.' });
  return checks;
}

function ControlChecks({ checks }) {
  return (
    <section className="panel !p-0" aria-labelledby="checks-title">
      <div className="px-5 pt-5 sm:px-6 sm:pt-6">
        <p className="eyebrow">Control checks</p>
        <h2 className="section-title" id="checks-title">Before the next run</h2>
        <p className="mt-1 text-[13px] leading-5 text-ink-2">
          Each check is separate. A passing check covers only what it names; it does not make the payroll compliant.
        </p>
      </div>
      <ul className="mt-4 divide-y divide-line border-t border-line">
        {checks.map((check) => (
          <li key={check.key} className="grid grid-cols-1 gap-x-4 gap-y-1.5 px-5 py-3.5 sm:grid-cols-[170px_minmax(0,1fr)_150px] sm:items-center sm:px-6">
            <p className="text-sm font-semibold text-ink">{check.label}</p>
            <div className="min-w-0">
              <StatusBadge tone={check.tone}>{check.status}</StatusBadge>
              <p className="mt-1 text-[12.5px] leading-5 text-ink-2">{check.detail}</p>
            </div>
            {check.to ? (
              <Link to={check.to} className="inline-flex min-h-[32px] items-center gap-1 justify-self-start text-[13px] font-semibold text-crimson hover:text-crimson-strong sm:justify-self-end">
                {check.action} <Icon name="chevron-right" size={15} />
              </Link>
            ) : <span className="hidden sm:block" />}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ── Workforce ──────────────────────────────────────────────────────────── */

function Workforce({ stats, statsState, readiness, canWriteEmployees }) {
  const summary = readiness?.summary;
  return (
    <section className="panel" aria-labelledby="workforce-title">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Workforce</p>
          <h2 className="section-title" id="workforce-title">Employee records</h2>
        </div>
        <Link to="/employees" className="inline-flex min-h-[32px] items-center gap-1 text-[13px] font-semibold text-crimson hover:text-crimson-strong">
          Directory <Icon name="chevron-right" size={15} />
        </Link>
      </div>

      {statsState === 'forbidden' ? (
        <EmptyState kind="none" title="Not visible to your role">Employee figures need the employee read permission.</EmptyState>
      ) : statsState !== 'ok' ? (
        <EmptyState kind="error" title="Employee figures could not be loaded" />
      ) : !stats?.total ? (
        <EmptyState
          kind="blocked"
          title="No employee records"
          action={canWriteEmployees ? <Link to="/employees" className="btn btn-primary"><Icon name="plus" size={16} /> Add an employee</Link> : null}
        >
          Payroll needs at least one active employee with a salary version before a run can calculate anyone.
        </EmptyState>
      ) : (
        <dl className="mt-5 grid grid-cols-3 gap-4">
          <Figure label="Records" value={stats.total} note="Active and past" />
          <Figure label="Active" value={stats.active ?? 0} note="Current status" />
          <Figure
            label="Ready"
            value={summary ? summary.ready + summary.warning : '—'}
            note={summary ? `of ${summary.total} evaluated${summary.blocked ? `, ${summary.blocked} blocked` : ''}` : 'Readiness unavailable'}
          />
        </dl>
      )}
    </section>
  );
}

/* ── Audit integrity ────────────────────────────────────────────────────── */

function AuditIntegrity({ chain, chainState, checkedAt }) {
  const tone = chainState === 'ok' && chain ? (chain.valid ? 'verified' : 'failed') : 'unknown';
  const label = chainState === 'forbidden' ? 'Not checked' : chainState !== 'ok' || !chain ? 'Unavailable' : chain.valid ? 'Chain verified' : 'Chain broken';
  return (
    <section className="panel" aria-labelledby="audit-title">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Audit integrity</p>
          <h2 className="section-title" id="audit-title">Hash-chain verification</h2>
        </div>
        <StatusBadge tone={tone}>{label}</StatusBadge>
      </div>
      {chainState === 'ok' && chain ? (
        <dl className="mt-4 divide-y divide-line text-sm">
          <div className="flex justify-between gap-4 py-2"><dt className="text-ink-2">Records checked</dt><dd className="tabular font-semibold">{chain.checkedRecords}</dd></div>
          <div className="flex justify-between gap-4 py-2"><dt className="text-ink-2">Checked at</dt><dd className="text-right">{clock(checkedAt)}, on this page load</dd></div>
          <div className="flex justify-between gap-4 py-2"><dt className="text-ink-2">Scope</dt><dd className="text-right">Whole chain, first record onward</dd></div>
          {!chain.valid && (
            <div className="flex justify-between gap-4 py-2"><dt className="text-ink-2">First broken record</dt><dd className="tabular font-semibold text-bad">#{chain.firstBrokenSequence}</dd></div>
          )}
        </dl>
      ) : (
        <p className="mt-3 text-sm leading-6 text-ink-2">
          {chainState === 'forbidden' ? 'Your role cannot run chain verification.' : 'Verification did not complete. The audit trail page can run it again.'}
        </p>
      )}
      <p className="mt-3 text-[12.5px] leading-5 text-ink-2">
        Verification recomputes each record’s hash and its link to the one before, so it shows whether the stored
        records are consistent with their chain. It is tamper-evident, not tamper-proof, and says nothing about
        connectivity, data freshness, payroll status or compliance.
      </p>
    </section>
  );
}

/* ── Needs attention ────────────────────────────────────────────────────── */

function NeedsAttention({ run, checks }) {
  const items = [];
  if (run?.status === 'FAILED') {
    items.push({ key: 'run', tone: 'failed', text: `${monthName(run.periodMonth, run.periodYear)} run failed`, to: `/payroll/${run._id}`, action: 'Inspect run' });
  }
  if (run?.status === 'READY_FOR_FINALIZATION') {
    items.push({ key: 'run', tone: 'attention', text: `${monthName(run.periodMonth, run.periodYear)} is calculated and waiting for review`, to: `/payroll/${run._id}`, action: 'Review run' });
  }
  for (const check of checks) {
    if (check.tone === 'failed' || check.tone === 'attention') {
      items.push({ key: check.key, tone: check.tone, text: `${check.label}: ${check.status.toLowerCase()}`, to: check.to, action: check.action });
    }
  }
  if (!items.length) return null;
  return (
    <section aria-labelledby="attention-title" className="panel !p-0">
      <h2 id="attention-title" className="flex items-center gap-2 border-b border-line px-5 py-3.5 text-sm font-semibold text-ink sm:px-6">
        Needs attention <span className="tabular rounded-full border border-line bg-[var(--pg-glass)] px-2 text-xs font-semibold text-ink-2">{items.length}</span>
      </h2>
      <ul className="divide-y divide-line">
        {items.slice(0, 4).map((item) => (
          <li key={item.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 sm:px-6">
            <Icon name={item.tone === 'failed' ? 'x-circle' : 'alert-triangle'} size={17} strokeWidth={2} className={item.tone === 'failed' ? 'text-bad' : 'text-warn'} />
            <span className="sr-only">{item.tone === 'failed' ? 'Failed:' : 'Action required:'}</span>
            <span className="min-w-0 flex-1 text-sm text-ink">{item.text}</span>
            {item.to && (
              <Link to={item.to} className="inline-flex min-h-[32px] items-center gap-1 text-[13px] font-semibold text-crimson hover:text-crimson-strong">
                {item.action} <Icon name="chevron-right" size={15} />
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ── Page ───────────────────────────────────────────────────────────────── */

export default function Overview() {
  const { user } = useContext(AuthContext);
  const [data, reload] = useOverviewData(user);
  const run = data.runs?.[0];
  const checks = data.loadedAt ? buildChecks(data) : [];
  const canWriteEmployees = can(user, 'employee.write');

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Payroll operations"
        title="Payroll overview"
        subtitle="The latest run, the checks that gate the next one, and the state of the audit record."
        actions={(
          <>
            <button type="button" className="btn btn-quiet" onClick={reload} disabled={data.loading}>
              {data.loading ? 'Refreshing…' : 'Refresh'}
            </button>
            <Link to="/payroll" className="btn btn-primary">View payroll runs <Icon name="arrow-right" size={16} /></Link>
          </>
        )}
      >
        {data.loadedAt && (
          <p className="mt-2 text-xs text-ink-2" aria-live="polite">Figures loaded at {clock(data.loadedAt)}</p>
        )}
      </PageHeader>

      {!data.loadedAt ? (
        <div className="panel"><LoadingState label="Loading payroll overview" rows={4} /></div>
      ) : (
        <>
          <NeedsAttention run={run} checks={checks} />
          <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
            <div className="space-y-6">
              <LatestRun run={run} error={data.runsError} canWriteEmployees={canWriteEmployees} />
              <ControlChecks checks={checks} />
            </div>
            <div className="space-y-6">
              <Workforce stats={data.stats} statsState={data.statsState} readiness={data.readiness} canWriteEmployees={canWriteEmployees} />
              <AuditIntegrity chain={data.chain} chainState={data.chainState} checkedAt={data.chainCheckedAt} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export { money, monthName };
