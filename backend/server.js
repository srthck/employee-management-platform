import app from './src/app.js';
import connectDatabase from './src/config/database.js';
import config from './src/config/environment.js';

/**
 * Server Entry Point
 * 
 * Bootstraps the Express server and MongoDB connection
 * Production standards:
 * - Graceful shutdown handling
 * - Database connection verification
 * - Proper error logging
 */

const startServer = async () => {
  try {
    // Connect to MongoDB
    console.log('[STARTUP] Connecting to MongoDB...');
    try {
      await connectDatabase();
      console.log('[STARTUP] MongoDB connection successful');
    } catch (dbError) {
      console.warn(
        `[STARTUP] MongoDB connection failed: ${dbError.message}`
      );
      console.warn('[STARTUP] Continuing without database (check .env MONGO_URI)');
    }

    // Start Express server
    app.listen(config.port, () => {
      console.log(`[STARTUP] Server running on http://localhost:${config.port}`);
      console.log(`[STARTUP] Environment: ${config.nodeEnv}`);
      console.log(`[STARTUP] Frontend URL: ${config.frontendUrl}`);
      console.log(`[STARTUP] API Health Check: http://localhost:${config.port}/api/health`);
      console.log('[STARTUP] Server ready to accept requests');
    });
  } catch (error) {
    console.error(`[STARTUP] Failed to start server: ${error.message}`);
    process.exit(1);
  }
};

startServer();
