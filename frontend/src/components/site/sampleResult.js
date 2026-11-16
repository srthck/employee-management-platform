/**
 * The one illustrative payroll result shown on the public site.
 *
 * SAMPLE DATA — not read from any workspace. The figures follow the baseline
 * rules in backend/scripts/seed-compliance-rules.js:
 *   EPF  12% of PF wage capped at ₹15,000           → ₹1,800
 *   ESI  gross ₹62,500 is above the ₹21,000 ceiling  → not applicable
 *   PT   Maharashtra, above ₹10,000: ₹200 (₹300 in February)
 * TDS is not calculated by PayGuard (snapshot tdsStatus DEFERRED), so the
 * result is net pay before TDS, exactly as the product names it.
 *
 * February (previous finalized run): gross ₹58,000, EPF ₹1,800, PT ₹300 → ₹55,900.
 * March: ₹62,500 − ₹1,800 − ₹200 = ₹60,500 → +₹4,600, every rupee attributed below.
 */

export const SAMPLE_RESULT = {
  employee: 'EMP-0142',
  location: 'Pune, Maharashtra',
  period: 'March 2026',
  netPayBeforeTds: 60500,
  lines: [
    { label: 'Gross earnings', amount: 62500 },
    { label: 'EPF, employee share', amount: -1800 },
    { label: 'ESI', note: 'Not applicable' },
    { label: 'Professional tax', amount: -200 },
    { label: 'TDS', note: 'Not calculated' },
  ],
};

/**
 * The same illustrative scenario as two payroll runs, for the hero card stack:
 * March 2026 (the result traced above) and the February run it is compared
 * against. SAMPLE DATA, labelled as such wherever it is shown. The states are
 * the ones the backend state machine actually uses.
 */
export const SAMPLE_RUNS = [
  {
    id: 'mar-2026',
    period: 'March 2026',
    status: 'Finalized',
    tone: 'ok',
    openedLabel: 'Opened',
    opened: 'Mar 01',
    closedLabel: 'Frozen',
    closed: 'Mar 28',
    span: '31 days',
  },
  {
    id: 'feb-2026',
    period: 'February 2026',
    status: 'Disbursed',
    tone: 'ok',
    openedLabel: 'Opened',
    opened: 'Feb 01',
    closedLabel: 'Frozen',
    closed: 'Feb 26',
    span: '28 days',
  },
];

/**
 * The evidence behind the result, in the order PayGuard produces it.
 * `where` names the real screen a user opens to see this evidence.
 */
export const PROOF_STAGES = [
  {
    id: 'inputs',
    title: 'Inputs',
    summary: 'Salary version 3, full month, Maharashtra',
    facts: [
      ['Salary version', 'v3, effective 1 Mar 2026'],
      ['Basic (PF wage)', '₹31,250.00'],
      ['Paid days', '31 of 31'],
      ['Work state', 'Maharashtra'],
    ],
    note: 'The salary version and employment record in effect for the period are copied into the result.',
    where: 'Employee profile → Compensation',
  },
  {
    id: 'rules',
    title: 'Statutory rules',
    summary: 'EPF, ESI and PT versions in effect on 31 Mar',
    facts: [
      ['EPF · IN · from 1 Sep 2014', '12% × ₹15,000 cap = ₹1,800'],
      ['ESI · IN · from 1 Jul 2019', 'Gross above ₹21,000: n/a'],
      ['PT · MH', 'Above ₹10,000: ₹200'],
    ],
    note: 'The rule parameters themselves are stored with the result, so the payslip can be explained without re-reading today’s rules.',
    where: 'Compliance → Rule versions',
  },
  {
    id: 'variance',
    title: 'Variance check',
    summary: '+₹4,600 against February, every rupee explained',
    facts: [
      ['Gross +₹4,500', 'Salary revision, v2 → v3'],
      ['Professional tax −₹100', 'February amount was ₹300'],
      ['Classification', 'Expected'],
    ],
    note: 'A change with no cause in the payroll inputs is marked unexplained. If the company enables the gate, it blocks finalization until someone authorised records a reason.',
    where: 'Payroll run → Variance',
  },
  {
    id: 'approval',
    title: 'Approval',
    summary: 'Calculated by one person, finalized by another',
    facts: [
      ['Calculated by', 'Payroll administrator'],
      ['Finalized by', 'Payroll approver'],
      ['Approval mode', 'Maker-checker'],
    ],
    note: 'Under maker-checker, the person who calculated a run cannot finalize it.',
    where: 'Payroll run → Finalize',
  },
  {
    id: 'record',
    title: 'Frozen record',
    summary: 'Finalized snapshot with a SHA-256 hash',
    facts: [
      ['Snapshot status', 'Finalized'],
      ['SHA-256', '3f9a…c21e (sample)'],
      ['Verify', 'Recomputes the hash from stored fields'],
    ],
    note: 'Tamper-evident, not tamper-proof: a mismatch shows the record changed; it cannot stop a change.',
    where: 'Snapshot → Verify',
  },
];

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "₹60,500.00", "−₹1,800.00" (true minus sign, so columns read as arithmetic). */
export function formatInr(amount) {
  const sign = amount < 0 ? '−' : '';
  return `${sign}₹${inr.format(Math.abs(amount))}`;
}
