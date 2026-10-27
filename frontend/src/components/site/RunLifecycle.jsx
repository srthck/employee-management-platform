/**
 * The payroll run state machine as enforced by backend/src/models/PayrollRun.js
 * (ALLOWED_TRANSITIONS). Copy states only what the code does.
 */
const STATES = [
  {
    code: 'DRAFT',
    name: 'Opened',
    does: 'A run is opened for one company and one pay period.',
    checks: 'A period holds at most one run that is not cancelled.',
  },
  {
    code: 'PROCESSING',
    name: 'Calculated',
    does: 'Each employee is calculated from the salary and rule versions in effect for the period.',
    checks: 'Readiness lists employees who cannot be calculated, and missing UAN, ESIC or bank details.',
  },
  {
    code: 'READY_FOR_FINALIZATION',
    name: 'Reviewed',
    does: 'Results are staged. The payroll register and variance report are built from them.',
    checks: 'With the variance gate on, an unexplained change blocks finalization until an authorised person records a reason.',
  },
  {
    code: 'FINALIZED',
    name: 'Approved and frozen',
    does: 'Snapshots are hash-checked, then the run and its snapshots are finalized in one database transaction.',
    checks: 'Under maker-checker, a different person finalizes.',
  },
  {
    code: 'DISBURSED',
    name: 'Paid',
    does: 'The run is recorded as paid.',
    checks: 'Employees read payslips built from the frozen snapshot.',
  },
];

export default function RunLifecycle() {
  return (
    <div className="lifecycle">
      <ol className="lifecycle__track">
        {STATES.map((state, index) => (
          <li key={state.code} className="lifecycle__state">
            <span className="lifecycle__node" aria-hidden="true" />
            <div className="lifecycle__label">
              <p className="lifecycle__code">
                <span aria-hidden="true">{String(index + 1).padStart(2, '0')} </span>
                {state.code.replaceAll('_', ' ')}
              </p>
              <h3 className="lifecycle__name">{state.name}</h3>
            </div>
            <div className="lifecycle__body">
              <p className="lifecycle__does">{state.does}</p>
              <p className="lifecycle__checks"><span>Check</span> {state.checks}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="lifecycle__branch">
        <span className="lifecycle__branch-code">FAILED</span>
        A failed run can be processed again or cancelled. There is no path from calculated straight to finalized:
        the database rejects it.
      </p>
    </div>
  );
}
