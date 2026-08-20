import express from 'express';
import cors from 'cors';
import 'express-async-errors';
import config from './config/environment.js';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/authRoutes.js';
import employeeRoutes from './routes/employeeRoutes.js';
import payrollRunRoutes from './routes/payrollRunRoutes.js';
import { runScopedRouter, snapshotRouter } from './routes/payrollSnapshotRoutes.js';

/**
 * Express Application Setup
 * 
 * Production standards:
 * - CORS configured for frontend security
 * - JSON body parsing with size limits
 * - Async error handling
 * - Structured routing
 * - Centralized error middleware
 */

const app = express();

// Middleware: CORS
// Browsers treat localhost and 127.0.0.1 as different origins. Support both
// local development URLs so the Vite dev server can be opened either way.
const allowedOrigins = new Set([
  config.frontendUrl,
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

app.use(
  cors({
    origin(origin, callback) {
      // Requests without an Origin header (health checks, CLI clients) are safe.
      if (!origin || allowedOrigins.has(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Origin not allowed by CORS'));
    },
    credentials: true,
    optionsSuccessStatus: 200,
  })
);

// Middleware: Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Health check route (for load balancers and monitoring)
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: config.nodeEnv,
  });
});

// Authentication routes
app.use('/api/auth', authRoutes);

// Employee routes
app.use('/api/employees', employeeRoutes);

// Payroll Run routes (Phase 8)
app.use('/api/payroll-runs', payrollRunRoutes);

// PayrollSnapshot routes — run-scoped (Phase 9)
// Mounts: materialize, finalize-run, snapshots under /api/payroll-runs/:runId/
app.use('/api/payroll-runs/:runId', runScopedRouter);

// PayrollSnapshot routes — standalone (Phase 9)
app.use('/api/payroll-snapshots', snapshotRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
    path: req.path,
  });
});

// Error handling middleware (must be last)
app.use(errorHandler);

export default app;
