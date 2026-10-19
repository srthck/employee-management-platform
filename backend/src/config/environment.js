import dotenv from 'dotenv';
import { resolveTransactionPolicy } from './transactionPolicy.js';

/**
 * Environment Configuration
 * Loads and validates environment variables
 *
 * Production standards:
 * - All env vars defined in one place
 * - Validation on startup (fail fast principle)
 * - Clear defaults for development
 * - No secrets in code
 */

dotenv.config();

const env = process.env;
const isProduction = env.NODE_ENV === 'production';

const requiredEnvVars = [
  'MONGO_URI',
  'JWT_SECRET',
  'FRONTEND_URL',
];

// Validate required environment variables
const missingVars = requiredEnvVars.filter((v) => !env[v]);

if (missingVars.length > 0) {
  const message = `[CONFIG] Missing environment variables: ${missingVars.join(', ')}`;
  if (isProduction) {
    throw new Error(`${message}. Copy .env.example to .env and configure values.`);
  }
  console.warn(message);
  console.warn('[CONFIG] Please copy .env.example to .env and fill in the values');
}

if (isProduction && (env.JWT_SECRET || '').length < 32) {
  throw new Error('[CONFIG] JWT_SECRET must be at least 32 characters in production.');
}

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const csv = (value) => (value || '').split(',').map((item) => item.trim()).filter(Boolean);

/**
 * Convert a JWT-style duration ("1d", "12h", "30m", "900") to seconds so the
 * session cookie expires together with the token it carries.
 */
const durationToSeconds = (value, fallback) => {
  const match = /^(\d+)\s*([smhd]?)$/i.exec(String(value || '').trim());
  if (!match) return fallback;
  const multipliers = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };
  return Number(match[1]) * multipliers[match[2].toLowerCase()];
};

/**
 * TRUST_PROXY mirrors Express's "trust proxy" setting. Behind a load balancer
 * it must be set, otherwise every client shares the proxy's IP and the rate
 * limiters lock out the whole company at once.
 */
const parseTrustProxy = (value) => {
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  const hops = Number(value);
  return Number.isInteger(hops) ? hops : value;
};

const sameSite = (() => {
  const value = (env.AUTH_COOKIE_SAMESITE || 'strict').toLowerCase();
  return { strict: 'Strict', lax: 'Lax', none: 'None' }[value] || 'Strict';
})();

// Financial writes are atomic in every environment. The one escape hatch (a standalone mongod for local
// development) needs BOTH an explicit REQUIRE_TRANSACTIONS=false with NODE_ENV exactly development/test AND a
// loopback-only database URI; see transactionPolicy.js.
const transactionPolicy = resolveTransactionPolicy({
  nodeEnv: env.NODE_ENV,
  requireTransactionsFlag: env.REQUIRE_TRANSACTIONS,
  mongoUri: env.MONGO_URI,
});

const frontendUrl = env.FRONTEND_URL || 'http://localhost:5173';
const developmentOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
];
const jwtExpire = env.JWT_EXPIRE || '1d';

const config = {
  // Server
  port: toInt(env.PORT, 5000),
  nodeEnv: env.NODE_ENV || 'development',
  isDevelopment: env.NODE_ENV === 'development',
  isProduction,
  isTest: env.NODE_ENV === 'test',
  trustProxy: parseTrustProxy(env.TRUST_PROXY),
  jsonBodyLimit: env.JSON_BODY_LIMIT || '1mb',

  // Database
  mongoUri: env.MONGO_URI,
  // Financial writes are atomic in every environment, so development, tests
  // and production share one set of semantics. The opt-out is honoured only
  // under the two-boundary rule in transactionPolicy.js (never in production,
  // never for an unrecognized NODE_ENV, never against a non-loopback database).
  requireTransactions: transactionPolicy.requireTransactions,
  transactionPolicy,

  // Authentication
  jwtSecret:
    env.JWT_SECRET ||
    (isProduction ? undefined : 'dev-secret-key-change-in-production'),
  jwtExpire,
  bcryptRounds: toInt(env.BCRYPT_ROUNDS, 12),
  loginMaxAttempts: toInt(env.LOGIN_MAX_ATTEMPTS, 5),
  loginLockMs: toInt(env.LOGIN_LOCK_MS, 15 * 60 * 1000),

  // CORS
  frontendUrl,
  corsOrigins: [...new Set([
    frontendUrl,
    ...csv(env.CORS_ORIGINS),
    ...(isProduction ? [] : developmentOrigins),
  ])],

  // Authentication cookie
  authCookieName: env.AUTH_COOKIE_NAME || 'payguard_session',
  authCookieSameSite: sameSite,
  // SameSite=None is rejected by browsers unless the cookie is also Secure.
  authCookieSecure: isProduction || sameSite === 'None',
  authCookieMaxAgeSeconds: durationToSeconds(jwtExpire, 86400),

  // Abuse protection
  rateLimitEnabled: env.RATE_LIMIT_ENABLED !== 'false',

  // Compensation: how often scheduled pay changes are marked effective (0 disables)
  compensationActivationIntervalMs: toInt(env.COMPENSATION_ACTIVATION_INTERVAL_MS, 15 * 60 * 1000),

  // Payroll operations
  stuckRunThresholdMs: toInt(env.STUCK_RUN_THRESHOLD_MS, 30 * 60 * 1000),
  stuckRunMonitorIntervalMs: toInt(env.STUCK_RUN_MONITOR_INTERVAL_MS, 5 * 60 * 1000),
  varianceThresholdPercent: toInt(env.VARIANCE_THRESHOLD_PERCENT, 10),

  // Idempotency-Key retention
  idempotencyTtlHours: toInt(env.IDEMPOTENCY_TTL_HOURS, 24),

  // Sensitive field encryption (AES-256-GCM); see utils/fieldEncryption.js
  fieldEncryptionKeys: env.FIELD_ENCRYPTION_KEYS || '',
  fieldEncryptionActiveKeyId: env.FIELD_ENCRYPTION_ACTIVE_KEY || null,
  blindIndexKey: env.FIELD_BLIND_INDEX_KEY || '',

  // Logging
  logLevel: env.LOG_LEVEL || 'info',
};

export default config;
