// Dumps every collection to a single timestamped JSON file.
//
//   MONGODB_URI='...' node scripts/backup.mjs [--out <dir>]
//
// Read-only. M0 clusters have no automated backups, so this is the only
// recovery point if data is lost. Output lands in server/backups/, which is
// gitignored: it contains customer addresses, password hashes and session
// tokens.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';

const COLLECTIONS = [
  'menu', 'orders', 'users', 'sessions', 'passwordResetRequests', 'subscriptions',
  'holidays', 'drivers', 'driverSessions', 'deviceTokens', 'walletEntries', 'invoiceCounters', 'settings', 'meta', 'appData'
];

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI is required.');
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const outIndex = process.argv.indexOf('--out');
const outDir = outIndex === -1 ? path.join(here, '..', 'backups') : process.argv[outIndex + 1];
fs.mkdirSync(outDir, { recursive: true });

const client = await new MongoClient(uri).connect();
const databaseName = process.env.MONGODB_DB_NAME || 'house_of_shrish';
const database = client.db(databaseName);

try {
  const dump = { takenAt: new Date().toISOString(), database: databaseName, collections: {} };

  for (const name of COLLECTIONS) {
    const docs = await database.collection(name).find({}).toArray();
    dump.collections[name] = docs;
    console.log(`${name.padEnd(22)} ${String(docs.length).padStart(5)}`);
  }

  const stamp = dump.takenAt.replace(/[:.]/g, '-');
  const file = path.join(outDir, `backup-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(dump, null, 2), { mode: 0o600 });

  const totals = Object.values(dump.collections).reduce((sum, docs) => sum + docs.length, 0);
  console.log(`\n${totals} documents written to ${file}`);
  if (totals === 0) console.warn('Nothing was backed up - check the connection string points at the right database.');
} finally {
  await client.close();
}
