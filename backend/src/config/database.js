import mongoose from 'mongoose';

/**
 * Database Configuration
 * Handles MongoDB connection with proper error handling and reconnection logic
 * 
 * Production standards:
 * - Connection pooling via Mongoose
 * - Proper event handlers (connection, error, disconnected)
 * - No hardcoded credentials (uses environment variables)
 * - Graceful error handling
 */

const connectDatabase = async () => {
  try {
    if (!process.env.MONGO_URI) {
      throw new Error('MONGO_URI environment variable is not defined');
    }

    const conn = await mongoose.connect(process.env.MONGO_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
    });

    console.log(`[DB] Connected to MongoDB: ${conn.connection.host}`);
    return conn;
  } catch (error) {
    console.error(`[DB] Connection failed: ${error.message}`);
    throw error;
  }
};

// Connection event handlers
mongoose.connection.on('connected', () => {
  console.log('[DB] Mongoose connected to MongoDB');
});

mongoose.connection.on('error', (err) => {
  console.error(`[DB] Mongoose connection error: ${err}`);
});

mongoose.connection.on('disconnected', () => {
  console.log('[DB] Mongoose disconnected from MongoDB');
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[SHUTDOWN] Gracefully shutting down...');
  await mongoose.connection.close();
  console.log('[DB] MongoDB connection closed');
  process.exit(0);
});

export default connectDatabase;
