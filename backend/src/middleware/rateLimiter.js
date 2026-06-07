import rateLimit from 'express-rate-limit';

// Rate limiter for authentication endpoints (e.g., login)
// Limits to 5 requests per minute per IP address.
export const authRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  message: {
    success: false,
    message: 'Too many login attempts. Please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});
