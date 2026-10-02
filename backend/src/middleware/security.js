import crypto from 'node:crypto';
import config from '../config/environment.js';
import { runWithContext } from '../utils/requestContext.js';

/**
 * Request context: assigns a request ID (accepting a well-formed upstream
 * X-Request-Id) and opens the async context read by the logger and audit
 * service.
 */
export const requestContext = (req, res, next) => {
  const incoming = req.get('x-request-id');
  const requestId = incoming && /^[A-Za-z0-9._-]{8,128}$/.test(incoming)
    ? incoming
    : crypto.randomUUID();

  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  runWithContext({ requestId, ipAddress: req.ip || null }, () => next());
};

/**
 * Security headers for a JSON API that serves payroll data.
 * Written in-house (instead of pulling in helmet) because the policy for an
 * API that never renders HTML is short and fixed.
 */
export const securityHeaders = (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // Salary data must never be written to shared or browser caches.
  res.setHeader('Cache-Control', 'no-store');
  if (config.isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }
  next();
};

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const findUnsafeKey = (value, depth = 0) => {
  if (value === null || typeof value !== 'object') return null;
  if (depth > 20) return '(nesting too deep)';
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith('$') || key.includes('.') || FORBIDDEN_KEYS.has(key)) return key;
    const nested = findUnsafeKey(item, depth + 1);
    if (nested) return nested;
  }
  return null;
};

/**
 * Rejects MongoDB operator injection and prototype pollution payloads such as
 * `{"email": {"$gt": ""}}` or `?status[$ne]=x` before they reach a query.
 * Rejecting (rather than silently stripping) makes probing visible in logs.
 */
export const rejectOperatorInjection = (req, res, next) => {
  for (const [source, value] of [['body', req.body], ['query', req.query]]) {
    const key = findUnsafeKey(value);
    if (key) {
      return res.status(400).json({
        success: false,
        message: `Invalid key "${key}" in request ${source}. Keys may not start with "$" or contain ".".`,
        requestId: req.requestId,
      });
    }
  }
  return next();
};
