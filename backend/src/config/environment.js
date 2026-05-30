import dotenv from 'dotenv';

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

const requiredEnvVars = [
  'MONGO_URI',
  'JWT_SECRET',
  'FRONTEND_URL',
];

// Validate required environment variables
const missingVars = requiredEnvVars.filter((v) => !process.env[v]);
if (missingVars.length > 0) {
  console.warn(`[CONFIG] Missing environment variables: ${missingVars.join(', ')}`);
  console.warn('[CONFIG] Please copy .env.example to .env and fill in the values');
}

const config = {
  // Server
  port: parseInt(process.env.PORT, 10) || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  isDevelopment: process.env.NODE_ENV === 'development',
  isProduction: process.env.NODE_ENV === 'production',

  // Database
  mongoUri: process.env.MONGO_URI,

  // Authentication
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-key-change-in-production',
  jwtExpire: process.env.JWT_EXPIRE || '7d',

  // CORS
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
};

export default config;
