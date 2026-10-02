import config from '../config/environment.js';
import logger from '../utils/logger.js';

/**
 * Global Error Handler Middleware
 * Centralized error handling for all routes
 *
 * Production standards:
 * - Known error types mapped to precise HTTP status codes (400/401/403/409/413/422)
 * - Unexpected errors logged with request ID and stack; clients get a generic
 *   message plus the request ID in production
 * - Operational errors raised by services (errors carrying statusCode) keep
 *   their authored message
 */

class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
  }
}

const classify = (err) => {
  if (err.name === 'CastError') {
    return { statusCode: 400, message: `Invalid value for ${err.path}.` };
  }
  if (err.name === 'ValidationError' && err.errors) {
    return {
      statusCode: 422,
      message: 'Validation failed',
      errors: Object.values(err.errors).map((e) => ({ field: e.path, message: e.message })),
    };
  }
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern || err.keyValue || {})[0];
    return {
      statusCode: 409,
      message: field ? `A record with this ${field} already exists.` : 'Duplicate record.',
    };
  }
  if (err.name === 'JsonWebTokenError') {
    return { statusCode: 401, message: 'Invalid token. Please login again.' };
  }
  if (err.name === 'TokenExpiredError') {
    return { statusCode: 401, message: 'Token has expired. Please login again.' };
  }
  if (err.type === 'entity.too.large') {
    return { statusCode: 413, message: 'Request body is too large.' };
  }
  if (err.type === 'entity.parse.failed') {
    return { statusCode: 400, message: 'Malformed JSON request body.' };
  }
  if (err.message === 'Origin not allowed by CORS') {
    return { statusCode: 403, message: 'Origin not allowed.' };
  }

  const explicitStatus = Number(err.statusCode || err.status);
  if (explicitStatus) {
    return { statusCode: explicitStatus, message: err.message || 'Request failed.' };
  }
  return { statusCode: 500, message: err.message || 'Internal Server Error', unexpected: true };
};

const errorHandler = (err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  const { statusCode, message, errors, unexpected } = classify(err);

  if (statusCode >= 500) {
    logger.error('Request failed', {
      method: req.method,
      path: req.originalUrl,
      statusCode,
      error: err.message,
      code: err.code,
      stack: err.stack,
    });
  }

  const clientMessage = unexpected && config.isProduction
    ? 'An unexpected error occurred. Quote the request ID when contacting support.'
    : message;

  return res.status(statusCode).json({
    success: false,
    // Services attach machine-readable string codes (e.g. VARIANCE_UNEXPLAINED);
    // numeric driver codes (11000) are not client-facing.
    ...(typeof err.code === 'string' && !unexpected && { code: err.code }),
    message: clientMessage,
    ...(err.blockingFlags && { blockingFlags: err.blockingFlags }),
    ...(errors && { errors }),
    // Field-level validation errors raised by services.
    ...(!errors && !unexpected && Array.isArray(err.errors) && { errors: err.errors }),
    ...(err.hashFailures && { hashFailures: err.hashFailures }),
    requestId: req.requestId,
    ...(config.isDevelopment && statusCode >= 500 && { stack: err.stack }),
  });
};

export { AppError, errorHandler };
