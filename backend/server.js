import mongoose from 'mongoose';
import app from './src/app.js';
import connectDatabase from './src/config/database.js';
import config from './src/config/environment.js';
import auditService from './src/services/auditService.js';
import logger from './src/utils/logger.js';
import { supportsTransactions } from './src/utils/transaction.js';
import { assertFieldEncryptionConfigured } from './src/utils/fieldEncryption.js';
import { startStuckRunMonitor } from './src/jobs/stuckRunMonitor.js';
import { startCompensationActivationJob } from './src/jobs/compensationActivationJob.js';

/**
 * Server Entry Point
 *
 * Bootstraps the Express server and MongoDB connection
 * Production standards:
 * - Fail fast in production when the database is unreachable or cannot run
 *   transactions (payroll finalization must be atomic)
 * - Graceful shutdown on SIGTERM / SIGINT (stop accepting, drain, close DB)
 * - Background stuck-run recovery
 * - Structured logging
 */

const startServer = async () => {
  // Statutory and bank identifiers are only ever stored encrypted: without
  // working keys the server must not accept traffic, in any environment.
  try {
    assertFieldEncryptionConfigured();
  } catch (err) {
    logger.error('Startup aborted: sensitive-data encryption is not configured', { error: err.message });
    process.exit(1);
  }

  try {
    await connectDatabase();

    // The policy is always visible in the log, including an opt-out that was requested but NOT honoured.
    logger.info('Transaction policy', {
      environmentClass: config.transactionPolicy.environmentClass,
      requireTransactions: config.requireTransactions,
      optOutRequested: config.transactionPolicy.optOutRequested,
      optOutHonoured: config.transactionPolicy.optOutHonoured,
    });
    for (const note of config.transactionPolicy.notes) logger.warn(note);

    const transactions = await supportsTransactions();
    if (!transactions) {
      if (config.requireTransactions) {
        // Never serve requests with different transaction semantics than the
        // verified environment, in any NODE_ENV.
        logger.error(
          'Startup aborted: MongoDB transactions are required but the server is not a replica set member. ' +
          'Start one with scripts/start-replica-set.ps1 and use ?replicaSet=rs0 in MONGO_URI.'
        );
        process.exit(1);
      }
      logger.warn('REQUIRE_TRANSACTIONS=false on a standalone MongoDB: payroll writes are NOT atomic.');
    }

    // Startup NEVER rewrites, repairs or re-seals audit history. Records that predate the hash chain are only
    // reported; migrating them is an explicit, reviewed maintenance step (scripts/audit-chain-legacy-backfill.mjs).
    const { unchainedRecords } = await auditService.legacyChainStatus();
    if (unchainedRecords > 0) {
      logger.warn('Audit records that predate the hash chain exist and were NOT migrated (startup never changes audit history). Review and run scripts/audit-chain-legacy-backfill.mjs.', { unchainedRecords });
    }
  } catch (dbError) {
    if (config.isProduction) {
      logger.error('Startup aborted: database is not usable', { error: dbError.message });
      process.exit(1);
    }
    logger.warn('Continuing without a working database (development only)', { error: dbError.message });
  }

  const server = app.listen(config.port, () => {
    logger.info('Server ready', {
      url: `http://localhost:${config.port}`,
      environment: config.nodeEnv,
      frontendUrl: config.frontendUrl,
    });
  });

  const monitor = startStuckRunMonitor();
  const compensationActivation = startCompensationActivationJob();

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down', { signal });
    monitor.stop();
    compensationActivation.stop();
    server.close(async () => {
      await mongoose.connection.close().catch(() => {});
      process.exit(0);
    });
    // Do not hang forever on long-lived connections.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { error: reason?.message || String(reason), stack: reason?.stack });
  });
};

startServer();
