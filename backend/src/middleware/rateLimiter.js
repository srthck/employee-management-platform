import rateLimit from 'express-rate-limit';
import config from '../config/environment.js';

/**
 * Rate limiters.
 *
 * Limits are per client IP. Behind a proxy, TRUST_PROXY must be configured so
 * req.ip is the real client and not the load balancer.
 *
 * Login attempts are additionally protected per account by the lockout logic
 * in authController, so distributed guessing against one account still stops.
 */

const limiter = (windowMs, limit, message) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => !config.rateLimitEnabled,
    message: { success: false, message },
  });

// Login: 5 requests per minute per IP.
export const authRateLimiter = limiter(
  60 * 1000,
  5,
  'Too many login attempts. Please try again later.'
);

// Registration creates a new company workspace: 5 per hour per IP.
export const registerRateLimiter = limiter(
  60 * 60 * 1000,
  5,
  'Too many registration attempts. Please try again later.'
);

// Payroll state-changing actions (process, materialize, finalize): 30 per minute.
export const payrollActionRateLimiter = limiter(
  60 * 1000,
  30,
  'Too many payroll actions in a short period. Please wait and retry.'
);

// Revealing decrypted statutory or bank identifiers: 30 per 15 minutes per IP.
export const sensitiveRevealRateLimiter = limiter(
  15 * 60 * 1000,
  30,
  'Too many sensitive data reveals in a short period. Please wait and retry.'
);

// Baseline for every API call: 600 per minute per IP.
export const apiRateLimiter = limiter(
  60 * 1000,
  600,
  'Too many requests. Please slow down.'
);
