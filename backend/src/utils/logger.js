import config from '../config/environment.js';
import { getContext } from './requestContext.js';

/**
 * Structured JSON logger.
 *
 * - One JSON object per line so log shippers (CloudWatch, Datadog, Loki) can
 *   index fields without parsing free text.
 * - Every line carries the request ID, which is also returned to clients in
 *   the X-Request-Id header and in error bodies.
 * - Keys that commonly hold credentials or financial identifiers are redacted
 *   before anything is written.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;
const SENSITIVE_SUBSTRINGS = /password|secret|token|authorization|cookie|jwt|bank|aadhaar/i;
const SENSITIVE_EXACT = new Set(['pan', 'ifsc', 'accountnumber', 'salary', 'grossmonthly', 'netpaybeforetds', 'components']);
const isSensitiveKey = (key) =>
  SENSITIVE_SUBSTRINGS.test(key) || SENSITIVE_EXACT.has(key.toLowerCase());
const REDACTED = '[REDACTED]';

const redact = (value, depth = 0) => {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[TRUNCATED]';
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSensitiveKey(key) ? REDACTED : redact(item, depth + 1),
    ])
  );
};

const write = (level, message, meta = {}) => {
  if (LEVELS[level] > threshold) return;
  const { requestId } = getContext();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...(requestId && { requestId }),
    ...redact(meta),
  });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
};

const logger = {
  error: (message, meta) => write('error', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  info: (message, meta) => write('info', message, meta),
  debug: (message, meta) => write('debug', message, meta),
};

export default logger;
