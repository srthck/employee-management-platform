import { createRequire } from 'node:module';
import { E2E_MONGO_URI } from './env.js';

/** Drop the disposable end-to-end database so no test data is left behind. */
export default async function globalTeardown() {
  const require = createRequire(import.meta.url);
  const { MongoClient } = require('../../backend/node_modules/mongoose').mongo;
  const client = await MongoClient.connect(E2E_MONGO_URI);
  try {
    const db = client.db();
    if (!db.databaseName.endsWith('_e2e')) {
      throw new Error(`Refusing to drop "${db.databaseName}": not an _e2e database.`);
    }
    await db.dropDatabase();
  } finally {
    await client.close();
  }
}
