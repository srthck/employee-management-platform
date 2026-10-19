import express from 'express';
import cors from 'cors';
import 'express-async-errors';
import mongoose from 'mongoose';
import config from './config/environment.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestContext, securityHeaders, rejectOperatorInjection } from './middleware/security.js';
import { errorEnvelope } from './middleware/errorEnvelope.js';
import { apiRateLimiter } from './middleware/rateLimiter.js';
import { supportsTransactions } from './utils/transaction.js';
import logger from './utils/logger.js';

import authRoutes from './routes/authRoutes.js';
import employeeRoutes from './routes/employeeRoutes.js';
import employeeAccountRoutes from './routes/employeeAccountRoutes.js';
import salaryRoutes from './routes/salaryRoutes.js';
import complianceRuleRoutes from './routes/complianceRuleRoutes.js';
import auditRoutes from './routes/auditRoutes.js';
import payrollRunRoutes from './routes/payrollRunRoutes.js';
import meRoutes from './routes/meRoutes.js';
import companyRoutes from './routes/companyRoutes.js';
import employeeProfileRoutes, { readinessRouter } from './routes/employeeProfileRoutes.js';
import compensationRoutes, { employeeCompensationRouter } from './routes/compensationRoutes.js';
import {
  runScopedRouter,
  snapshotRouter,
} from './routes/payrollSnapshotRoutes.js';

/**
 * Express Application Setup
 *
 * Production standards:
 * - Request IDs on every request and response
 * - Security headers, explicit CORS allowlist with credentials
 * - JSON body parsing with a conservative size limit
 * - MongoDB operator-injection guard before any route
 * - Baseline API rate limit plus stricter per-route limits
 * - Liveness (/api/health) and readiness (/api/ready) probes
 * - Centralized error middleware
 */

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

app.use(requestContext);
app.use(errorEnvelope);
app.use(securityHeaders);

// CORS: the configured frontend URL, CORS_ORIGINS, and (outside production
// only) the local Vite dev server origins.
const allowedOrigins = new Set(config.corsOrigins);

app.use(
  cors({
    origin(origin, callback) {
      // Requests without an Origin header (health checks, CLI clients)
      // are safe.
      if (!origin || allowedOrigins.has(origin)) {
        return callback(null, true);
      }

      return callback(new Error('Origin not allowed by CORS'));
    },
    credentials: true,
    optionsSuccessStatus: 200,
    exposedHeaders: ['X-Request-Id'],
  })
);

// Middleware: Body parsing
app.use(express.json({ limit: config.jsonBodyLimit }));
app.use(express.urlencoded({ limit: config.jsonBodyLimit, extended: false }));
app.use(rejectOperatorInjection);

// Liveness: the process is up.
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: config.nodeEnv,
  });
});

// Readiness: the process can safely serve payroll traffic. The transaction policy is part of the answer, so
// an operator (or a deployment gate) can see not only whether transactions work but whether the process is
// allowed to run without them.
let lastReadinessKey = null;
app.get('/api/ready', async (req, res) => {
  const databaseConnected = mongoose.connection.readyState === 1;
  const transactions = databaseConnected ? await supportsTransactions() : false;
  const ready = databaseConnected && (transactions || !config.requireTransactions);
  const policy = config.transactionPolicy;

  // Structured log on every CHANGE of readiness state (not on every probe).
  const key = `${ready}|${databaseConnected}|${transactions}`;
  if (key !== lastReadinessKey) {
    lastReadinessKey = key;
    logger[ready ? 'info' : 'error']('Readiness changed', {
      ready, databaseConnected, transactions, requireTransactions: config.requireTransactions, environmentClass: policy.environmentClass,
    });
  }

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    database: databaseConnected ? 'connected' : 'disconnected',
    transactions: transactions ? 'supported' : 'unavailable',
    transactionPolicy: {
      environmentClass: policy.environmentClass,
      requireTransactions: policy.requireTransactions,
      optOutRequested: policy.optOutRequested,
      optOutHonoured: policy.optOutHonoured,
    },
  });
});

app.use('/api', apiRateLimiter);

// Authentication routes
app.use('/api/auth', authRoutes);

// Versioned salary APIs must be mounted before generic employee :id routes.
app.use('/api/employees', salaryRoutes);

// Employee 360: employment history, statutory, bank, documents, readiness
app.use('/api/employees', employeeProfileRoutes);
app.use('/api/payroll-readiness', readinessRouter);

// Compensation control plane: components, versions, impact, change workflow
app.use('/api/employees', employeeCompensationRouter);
app.use('/api/compensation', compensationRoutes);

// Employee routes
app.use('/api/employees', employeeRoutes);

// Employee login account routes
app.use('/api/employee-accounts', employeeAccountRoutes);

// Read-only statutory rule and audit history APIs
app.use('/api/compliance/rules', complianceRuleRoutes);
app.use('/api/audit', auditRoutes);

// Payroll Run routes
app.use('/api/payroll-runs', payrollRunRoutes);

// PayrollSnapshot routes — run-scoped
// Mounts: materialize, finalize-run, snapshots under /api/payroll-runs/:runId/
app.use('/api/payroll-runs/:runId', runScopedRouter);

// PayrollSnapshot routes — standalone
app.use('/api/payroll-snapshots', snapshotRouter);

// Employee self-service
app.use('/api/me', meRoutes);

// Company settings and staff users
app.use('/api/company', companyRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
    path: req.path,
    requestId: req.requestId,
  });
});

// Error handling middleware (must be last)
app.use(errorHandler);

export default app;
