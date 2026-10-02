/**
 * Pay basis: how many days a payroll period pays for, and how many of them a
 * person was actually employed.
 *
 * Indian law does not prescribe one divisor. Employers choose a basis and must
 * apply it consistently, so it is a company setting, recorded on every payroll
 * result rather than assumed:
 *
 *   CALENDAR_DAYS  the days in the month (28–31)
 *   FIXED_DAYS     a fixed divisor every month (commonly 30, sometimes 26)
 *   WORKING_DAYS   calendar days minus the weekly offs
 *
 * Paid days are the days inside the period the person was employed, from their
 * joining date to their last working day. Attendance and loss of pay are NOT
 * part of this: they arrive with the time and leave engine and will reduce paid
 * days through the same factor.
 *
 * Proration factor = paid days ÷ payable days. A full month is exactly 1, so a
 * full-month employee is calculated precisely as before.
 */

export const PAYABLE_DAYS_BASES = Object.freeze(['CALENDAR_DAYS', 'FIXED_DAYS', 'WORKING_DAYS']);
export const PROFESSIONAL_TAX_BASES = Object.freeze(['EARNED_GROSS', 'FULL_MONTHLY_GROSS']);

export const DEFAULT_PAYROLL_BASIS = Object.freeze({
  payableDaysBasis: 'CALENDAR_DAYS',
  fixedPayableDays: 30,
  weeklyOffDays: [0],
  professionalTaxBasis: 'EARNED_GROSS',
});

const DAY_MS = 24 * 60 * 60 * 1000;

const startOfUtcDay = (value) => {
  const date = new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
};

const round2 = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const round6 = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 1e6) / 1e6;

const inclusiveDays = (from, to) => (to < from ? 0 : Math.round((to - from) / DAY_MS) + 1);

const countDays = (from, to, includeDay) => {
  if (to < from) return 0;
  let count = 0;
  for (let day = new Date(from); day <= to; day = new Date(day.getTime() + DAY_MS)) {
    if (includeDay(day)) count += 1;
  }
  return count;
};

/** Company basis with defaults filled in, for old companies and partial settings. */
export const payrollBasisFrom = (settings = {}) => ({
  payableDaysBasis: PAYABLE_DAYS_BASES.includes(settings.payableDaysBasis)
    ? settings.payableDaysBasis
    : DEFAULT_PAYROLL_BASIS.payableDaysBasis,
  fixedPayableDays: Number.isFinite(settings.fixedPayableDays)
    ? settings.fixedPayableDays
    : DEFAULT_PAYROLL_BASIS.fixedPayableDays,
  weeklyOffDays: Array.isArray(settings.weeklyOffDays) && settings.weeklyOffDays.length > 0
    ? [...settings.weeklyOffDays]
    : [...DEFAULT_PAYROLL_BASIS.weeklyOffDays],
  professionalTaxBasis: PROFESSIONAL_TAX_BASES.includes(settings.professionalTaxBasis)
    ? settings.professionalTaxBasis
    : DEFAULT_PAYROLL_BASIS.professionalTaxBasis,
});

/**
 * Payable and paid days for one employee in one period.
 *
 * @param {object} params
 * @param {Date} params.periodStart
 * @param {Date} params.periodEnd
 * @param {object} params.basis            company pay basis (payrollBasisFrom)
 * @param {Date} [params.hireDate]         employment starts
 * @param {Date} [params.lastWorkingDay]   employment ends
 * @returns {{
 *   payableDaysBasis: string, payableDays: number, paidDays: number,
 *   prorationFactor: number, calendarDays: number, employedFrom: Date,
 *   employedTo: Date, prorated: boolean, reasons: string[], description: string
 * }}
 */
export function computePayPeriodDays({ periodStart, periodEnd, basis = DEFAULT_PAYROLL_BASIS, hireDate = null, lastWorkingDay = null }) {
  const start = startOfUtcDay(periodStart);
  const end = startOfUtcDay(periodEnd);
  const calendarDays = inclusiveDays(start, end);

  const joined = hireDate ? startOfUtcDay(hireDate) : null;
  const left = lastWorkingDay ? startOfUtcDay(lastWorkingDay) : null;
  const employedFrom = joined && joined > start ? joined : start;
  const employedTo = left && left < end ? left : end;

  const reasons = [];
  if (joined && joined > start) reasons.push('JOINED_MID_PERIOD');
  if (left && left < end) reasons.push('EXITED_MID_PERIOD');

  const isWorkingDay = (day) => !basis.weeklyOffDays.includes(day.getUTCDay());
  let payableDays;
  let paidDays;

  switch (basis.payableDaysBasis) {
    case 'FIXED_DAYS':
      payableDays = basis.fixedPayableDays;
      // A fixed divisor still has to reflect the part of the month worked, so
      // paid days carry decimals (the same way Keka and greytHR report them).
      paidDays = round2((payableDays * inclusiveDays(employedFrom, employedTo)) / calendarDays);
      break;
    case 'WORKING_DAYS':
      payableDays = countDays(start, end, isWorkingDay);
      paidDays = countDays(employedFrom, employedTo, isWorkingDay);
      break;
    case 'CALENDAR_DAYS':
    default:
      payableDays = calendarDays;
      paidDays = inclusiveDays(employedFrom, employedTo);
      break;
  }

  paidDays = Math.max(0, Math.min(paidDays, payableDays));
  const prorationFactor = payableDays > 0 ? round6(paidDays / payableDays) : 0;

  const basisLabel = {
    CALENDAR_DAYS: 'calendar days',
    FIXED_DAYS: `a fixed ${payableDays}-day month`,
    WORKING_DAYS: 'working days (weekly offs excluded)',
  }[basis.payableDaysBasis] || 'calendar days';

  return {
    payableDaysBasis: basis.payableDaysBasis,
    payableDays,
    paidDays,
    prorationFactor,
    calendarDays,
    employedFrom,
    employedTo,
    prorated: prorationFactor !== 1,
    reasons,
    description: `${paidDays} of ${payableDays} payable days (${basisLabel})`,
  };
}

/** Apply the proration factor to a monthly amount, rounded to paise once. */
export const proratedAmount = (amount, factor) => round2(Number(amount || 0) * factor);
