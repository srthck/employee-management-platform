import mongoose from 'mongoose';
import config from '../config/environment.js';
import logger from '../utils/logger.js';
import compensationChangeService from '../services/compensationChangeService.js';

/**
 * Compensation activation job.
 *
 * An approved future-dated pay change is SCHEDULED: its compensation version
 * and payroll projection are already written, so payroll is correct whether or
 * not this job runs. The job only moves the request to EFFECTIVE on its date,
 * so the workflow state matches reality and the audit trail records when the
 * change actually landed.
 *
 * Disabled when COMPENSATION_ACTIVATION_INTERVAL_MS <= 0.
 */
export function startCompensationActivationJob({
  intervalMs = config.compensationActivationIntervalMs,
} = {}) {
  let running = false;

  const tick = async () => {
    if (running || mongoose.connection.readyState !== 1) return 0;
    running = true;
    try {
      const activated = await compensationChangeService.activateDue();
      if (activated > 0) logger.info('Scheduled compensation changes are now effective', { activated });
      return activated;
    } catch (err) {
      logger.error('Compensation activation job failed', { error: err.message, stack: err.stack });
      return 0;
    } finally {
      running = false;
    }
  };

  if (intervalMs <= 0) return { stop: () => {}, tick };

  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), tick };
}
