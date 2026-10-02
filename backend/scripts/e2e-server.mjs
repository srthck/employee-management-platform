/**
 * Start the backend for browser end-to-end tests on a disposable database.
 *
 * Used by frontend/playwright.config.js. The database is dropped and seeded
 * with the baseline statutory rules, then the normal server starts with the
 * same transaction requirement as every other environment.
 *
 * Safety: refuses to run unless the database name ends with "_e2e", so it can
 * never drop a development or production database.
 */

import mongoose from 'mongoose';

const uri = process.env.MONGO_URI;
const databaseName = uri ? new URL(uri).pathname.replace(/^\//, '') : '';

if (!databaseName.endsWith('_e2e')) {
  console.error(`[e2e] Refusing to reset "${databaseName || '(none)'}": the database name must end with "_e2e".`);
  process.exit(2);
}

await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
await mongoose.connection.dropDatabase();
const { seedComplianceRules } = await import('./seed-compliance-rules.js');
await seedComplianceRules();
await mongoose.disconnect();

console.log(`[e2e] Database ${databaseName} reset and seeded; starting server`);
await import('../server.js');
