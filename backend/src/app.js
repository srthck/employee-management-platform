import express from 'express';
import cors from 'cors';
import 'express-async-errors';
import config from './config/environment.js';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/authRoutes.js';

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
app.use(
  cors({
    origin: config.frontendUrl,
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

// API routes (placeholder for future routes)
// app.use('/api/employees', employeeRoutes);

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
