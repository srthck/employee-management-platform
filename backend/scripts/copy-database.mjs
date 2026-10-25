/**
 * Copy a PayGuard database to another MongoDB deployment, e.g. from a
 * standalone mongod to a transaction-capable replica set.
 *
 * Usage:
 *   npm run db:copy -- <source-uri> <target-uri>
 *   npm run db:copy -- mongodb://127.0.0.1:27017/employee_management \
 *                      "mongodb://127.0.0.1:27018/employee_management?replicaSet=rs0"
 *
 * Guarantees:
 *   - Documents are copied byte-for-byte (same _id, same fields), so snapshot
 *     hashes and the audit hash chain stay verifiable.
 *   - Index definitions are recreated on the target.
 *   - Collection validators (for example the audit chain's, which refuses audit records that lack headVersion) are applied
 *     AFTER the documents are copied, so documents that predate a validator do not stop the copy.
 *   - Refuses to write into a target database that already has collections:
 *     it never merges into or overwrites existing data.
 *   - The source is only read.
 */

import mongoose from 'mongoose';

const [sourceUri, targetUri] = process.argv.slice(2);
if (!sourceUri || !targetUri) {
  console.error('Usage: node scripts/copy-database.mjs <source-uri> <target-uri>');
  process.exit(2);
}

const BATCH_SIZE = 500;

const source = await mongoose.createConnection(sourceUri, { serverSelectionTimeoutMS: 5000 }).asPromise();
const target = await mongoose.createConnection(targetUri, { serverSelectionTimeoutMS: 5000 }).asPromise();

try {
  if (source.db.databaseName === target.db.databaseName && source.host === target.host && source.port === target.port) {
    throw new Error('Source and target are the same database.');
  }

  const existing = await target.db.listCollections({}, { nameOnly: true }).toArray();
  if (existing.length > 0) {
    throw new Error(
      `Target database "${target.db.databaseName}" already has ${existing.length} collection(s). ` +
      'Copy into an empty database.'
    );
  }

  const collections = (await source.db.listCollections({ type: 'collection' }).toArray())
    .filter((c) => !c.name.startsWith('system.'));

  const summary = [];
  for (const { name, options } of collections) {
    // The collection is created WITHOUT its validator and the validator is applied after the documents are in. Existing
    // documents can legitimately fail a validator that governs NEW inserts: after the audit chain cutover every audit record
    // written before the head protocol lacks headVersion, and loading them into a collection that already carries the
    // validator would stop the copy at the first record. The documents are not changed; the same validator is in force afterwards.
    const { validator, validationLevel, validationAction, ...creationOptions } = options ?? {};
    await target.db.createCollection(name, creationOptions);
    const from = source.db.collection(name);
    const to = target.db.collection(name);

    let copied = 0;
    let batch = [];
    for await (const doc of from.find({})) {
      batch.push(doc);
      if (batch.length === BATCH_SIZE) {
        await to.insertMany(batch, { ordered: true });
        copied += batch.length;
        batch = [];
      }
    }
    if (batch.length) {
      await to.insertMany(batch, { ordered: true });
      copied += batch.length;
    }

    const indexes = (await from.indexes()).filter((index) => index.name !== '_id_');
    for (const { key, v, ns, ...indexOptions } of indexes) {
      await to.createIndex(key, indexOptions);
    }

    const sourceCount = await from.countDocuments();
    const targetCount = await to.countDocuments();
    if (sourceCount !== targetCount) {
      throw new Error(`Count mismatch in ${name}: source ${sourceCount}, target ${targetCount}`);
    }
    const hasValidator = Boolean(validator) && Object.keys(validator).length > 0;
    if (hasValidator) {
      await target.db.command({ collMod: name, validator, ...(validationLevel && { validationLevel }), ...(validationAction && { validationAction }) });
    }
    summary.push({ collection: name, documents: copied, indexes: indexes.length, validator: hasValidator });
  }

  console.table(summary);
  console.log(`Copied ${summary.length} collections from ${source.db.databaseName} to ${target.db.databaseName}.`);
} catch (err) {
  console.error(`Copy failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await Promise.all([source.close(), target.close()]);
}
