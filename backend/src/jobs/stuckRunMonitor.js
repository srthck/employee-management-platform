import mongoose from 'mongoose';
import config from '../config/environment.js';
import logger from '../utils/logger.js';
import payrollRunService from '../services/payrollRunService.js';

/**
 * Stuck-run monitor.
 *
 * A server crash during processing leaves a run in PROCESSING forever. This
 * job periodically fails any PROCESSING run whose heartbeat is older than
 * STUCK_RUN_THRESHOLD_MS so an admin can simply retry it. Recovery updates
 * are conditional on the heartbeat still being stale, so several server
 * instances can run the monitor at the same time.
 *
 * Disabled when STUCK_RUN_MONITOR_INTERVAL_MS <= 0.
 */
export function startStuckRunMonitor({
  intervalMs = config.stuckRunMonitorIntervalMs,
  thresholdMs = config.stuckRunThresholdMs,
} = {}) {
  let running = false;

  const tick = async () => {
    if (running || mongoose.connection.readyState !== 1) return 0;
    running = true;
    try {
      const recovered = await payrollRunService.autoRecoverStuckRuns({ thresholdMs });
      if (recovered > 0) {
        logger.warn('Recovered stuck payroll runs', { recovered, thresholdMs });
      }
      return recovered;
    } catch (err) {
      logger.error('Stuck-run monitor failed', { error: err.message, stack: err.stack });
      return 0;
    } finally {
      running = false;
    }
  };

  if (intervalMs <= 0) {
    return { stop: () => {}, tick };
  }

  const timer = setInterval(tick, intervalMs);
  timer.unref();

  return {
    stop: () => clearInterval(timer),
    tick,
  };
}
