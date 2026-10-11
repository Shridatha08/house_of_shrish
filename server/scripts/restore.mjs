// Restores a dump produced by backup.mjs.
//
//   node scripts/restore.mjs backups/backup-....json            # dry run
//   MONGODB_URI='...' node scripts/restore.mjs <file> --confirm # merge by _id
//   MONGODB_URI='...' node scripts/restore.mjs <file> --confirm --replace
//
// Merge is the default and only ever writes documents present in the dump.
// --replace empties each collection first, so anything created after the
// backup was taken is lost.
import fs from 'fs';
import { MongoClient } from 'mongodb';

const [, , file] = process.argv;
const confirmed = process.argv.includes('--confirm');
const replace = process.argv.includes('--replace');

if (!file) {
  console.error('Usage: node scripts/restore.mjs <backup.json> [--confirm] [--replace]');
  process.exit(2);
}

const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
console.log(`backup taken ${dump.takenAt} from database "${dump.database}"`);
for (const [name, docs] of Object.entries(dump.collections)) {
  console.log(`  ${name.padEnd(22)} ${String(docs.length).padStart(5)}`);
}
console.log(`\nmode: ${replace ? 'REPLACE (collections emptied first)' : 'merge (upsert by _id)'}`);

if (!confirmed) {
  console.log('\nDry run. Re-run with --confirm to write.');
  process.exit(0);
}

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI is required.');
  process.exit(2);
}

const client = await new MongoClient(uri).connect();
const database = client.db(process.env.MONGODB_DB_NAME || dump.database);

try {
  for (const [name, docs] of Object.entries(dump.collections)) {
    const collection = database.collection(name);
    if (replace) await collection.deleteMany({});
    if (docs.length === 0) continue;
    await collection.bulkWrite(
      docs.map((doc) => ({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } })),
      { ordered: false }
    );
    console.log(`${name.padEnd(22)} restored ${docs.length}`);
  }
  console.log('\nDone. Restart the API so it reloads from the database.');
} finally {
  await client.close();
}
