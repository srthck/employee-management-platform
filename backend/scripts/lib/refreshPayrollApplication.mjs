import CompensationComponent from '../../src/models/CompensationComponent.js';
import { payrollApplicationFor } from '../../src/utils/compensation.js';

/**
 * Wave 3.5 catalogue refresh.
 *
 * Until Wave 3.5 a monthly run paid only recurring earnings, so recurring
 * voluntary deductions and employer contributions were recorded as
 * NOT_APPLIED_YET. Payroll now applies them, and the honesty flag has to say
 * so — otherwise the catalogue tells people money does not move when it does.
 *
 * Components are append-only history: a stale flag is corrected by recording a
 * new version, never by rewriting the one that was true at the time.
 *
 * Safe to re-run: components already carrying the right flag are skipped.
 */
export async function refreshPayrollApplication({ dryRun, log }) {
  const components = await CompensationComponent.find({ isCurrent: true }).lean();
  const stale = components.filter(
    (component) => component.payrollApplication !== payrollApplicationFor(component)
  );
  if (stale.length === 0) return;

  log(`compensationcomponents: record the Wave 3.5 payroll application (${stale.length})`);
  if (dryRun) return;

  for (const component of stale) {
    const current = await CompensationComponent.findById(component._id);
    if (!current || !current.isCurrent) continue;

    current.isCurrent = false;
    current.supersededAt = new Date();
    await current.save();

    const { _id, createdAt, updatedAt, __v, ...definition } = component;
    await CompensationComponent.create({
      ...definition,
      payrollApplication: payrollApplicationFor(component),
      version: component.version + 1,
      isCurrent: true,
      supersededAt: null,
    });
  }
}

export default refreshPayrollApplication;
