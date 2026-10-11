// Read-only check that the split into per-record collections kept everything.
// Compares the preserved legacy document against the migrated collections.
//
//   MONGODB_URI='...' node scripts/verify-migration.mjs
//
// Exits non-zero if any record is missing, so it is safe to run after a deploy.
import crypto from 'crypto';
import { MongoClient } from 'mongodb';

const COLLECTION_KEYS = {
  menu: (entry) => entry.id,
  orders: (entry) => entry.id,
  users: (entry) => entry.id,
  sessions: (entry) => entry.token,
  passwordResetRequests: (entry) => entry.id,
  subscriptions: (entry) => entry.id,
  holidays: (entry) => entry.id,
  drivers: (entry) => entry.id,
  driverSessions: (entry) => entry.token,
  deviceTokens: (entry) => (entry.token ? crypto.createHash('sha256').update(String(entry.token)).digest('hex') : null)
};

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI is required.');
  process.exit(2);
}

const client = await new MongoClient(uri).connect();
const database = client.db(process.env.MONGODB_DB_NAME || 'house_of_shrish');

try {
  const schema = await database.collection('meta').findOne({ _id: 'schema' });
  console.log(`schema version: ${schema ? schema.version : 'not migrated'}${schema?.migratedAt ? ` (${schema.migratedAt})` : ''}`);

  const legacy = await database.collection('appData').findOne({ _id: 'main' });
  if (!legacy) {
    console.log('No legacy document present - nothing to compare against.');
    process.exit(0);
  }

  let failures = 0;
  for (const [name, key] of Object.entries(COLLECTION_KEYS)) {
    const expected = Array.isArray(legacy[name]) ? legacy[name] : [];
    const expectedIds = new Set(expected.map(key).filter((id) => id !== null && id !== undefined));
    const actualIds = new Set((await database.collection(name).find({}, { projection: { _id: 1 } }).toArray()).map((doc) => doc._id));

    const missing = [...expectedIds].filter((id) => !actualIds.has(id));
    const status = missing.length === 0 ? 'ok' : `MISSING ${missing.length}`;
    console.log(`${name.padEnd(22)} legacy ${String(expectedIds.size).padStart(5)} -> live ${String(actualIds.size).padStart(5)}  ${status}`);
    if (missing.length > 0) {
      failures += missing.length;
      console.log(`  missing ids: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ' ...' : ''}`);
    }
  }

  const settings = await database.collection('settings').findOne({ _id: 'main' });
  console.log(`${'settings'.padEnd(22)} ${settings ? 'ok' : 'MISSING'}`);
  if (!settings) failures++;

  if (failures > 0) {
    console.error(`\n${failures} record(s) did not make it across. The legacy document is intact; do not delete it.`);
    process.exit(1);
  }
  console.log('\nEverything in the legacy document is present in the new collections.');
} finally {
  await client.close();
}
