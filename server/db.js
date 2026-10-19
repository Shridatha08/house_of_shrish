import crypto from 'crypto';
import { MongoClient } from 'mongodb';

const MEAL_CUSTOMISATIONS = [
  '3 Roti, Vegetable curry, Flavourful rice, Curd, Vegetable/Fruit Salad',
  '4 Roti, Vegetable curry, Curd, Vegetable/Fruit Salad'
];

const defaultData = {
  menu: [
    { id: 1, name: 'Single Meal', description: 'Pure Veg Meals', price: 129, category: 'Pure Veg Meals', image: '', customisations: MEAL_CUSTOMISATIONS },
    { id: 2, name: 'Monthly (Lunch)', description: 'Pure Veg Meals', price: 3299, category: 'Pure Veg Meals', image: '', customisations: MEAL_CUSTOMISATIONS },
    { id: 3, name: 'Monthly (Dinner)', description: 'Pure Veg Meals', price: 3299, category: 'Pure Veg Meals', image: '', customisations: MEAL_CUSTOMISATIONS },
    { id: 4, name: 'Monthly (Lunch + Dinner)', description: 'Pure Veg Meals', price: 5499, category: 'Pure Veg Meals', image: '', customisations: MEAL_CUSTOMISATIONS },
    {
      id: 6,
      name: 'Dry Fruits Ladoo',
      description: 'Naturally sweetened with dates, made with premium dry fruits and crafted with care',
      price: 299,
      category: 'Artisanal Sweets',
      image: 'ladoo.png',
      variants: [
        { label: '200g', price: 299 },
        { label: '500g', price: 699 },
        { label: '1000g', price: 1299 }
      ]
    }
  ],
  orders: [],
  users: [],
  sessions: [],
  passwordResetRequests: [],
  subscriptions: [],
  settings: {
    subscriptionWorkingDays: 26,
    announcement: '',
    orderingPaused: false,
    kitchenClosedDates: [],
    dailyOrderCapacity: 50,
    lunchCutoffTime: '11:00',
    dinnerCutoffTime: '18:30',
    deliveryTimeSlots: ['11:00-13:00', '18:00-20:00']
  },
  holidays: [
    { id: 1, date: '2026-01-01', name: "New Year's Day" },
    { id: 2, date: '2026-01-26', name: 'Republic Day' },
    { id: 3, date: '2026-05-01', name: 'Labour Day' },
    { id: 4, date: '2026-08-15', name: 'Independence Day' },
    { id: 5, date: '2026-10-02', name: 'Gandhi Jayanti' },
    { id: 6, date: '2026-12-25', name: 'Christmas Day' }
  ]
};

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'house_of_shrish';
const LEGACY_DOCUMENT_ID = 'main';
const SETTINGS_ID = 'main';
const SCHEMA_VERSION = 1;

// Each array that used to live inside one document is now its own collection,
// keyed so that two requests only contend when they touch the same record.
// Device tokens are digested because an FCM token can exceed MongoDB's index
// key limit.
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
  deviceTokens: (entry) => digest(entry.token)
};
const COLLECTION_NAMES = Object.keys(COLLECTION_KEYS);

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

class StaleWrite extends Error {
  constructor() {
    super('Another update completed first. Please refresh and try again.');
    this.status = 409;
  }
}

let clientPromise;
let transactionsSupported = null;

// Reuses a single MongoDB connection across requests instead of reconnecting each time.
function getClient() {
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI environment variable is not set.');
  }
  if (!clientPromise) {
    clientPromise = new MongoClient(MONGODB_URI).connect();
  }
  return clientPromise;
}

// Storage bookkeeping never reaches the route handlers or the API responses.
function strip(doc) {
  if (!doc) return null;
  const { _id, _rev, ...rest } = doc;
  return rest;
}

function keyFor(name, entry) {
  const id = COLLECTION_KEYS[name](entry);
  return id === undefined || id === null ? null : id;
}

// MongoDB makes no promise about the order of an unsorted find, but /api/menu
// and /api/holidays serve their arrays as-is, so loads are ordered by key to
// keep what the apps display stable.
function byKey(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

// Only ever upserts, so an interrupted or repeated migration cannot lose data.
// The legacy single document is deliberately left in place as a backup.
async function ensureSchema(database) {
  const meta = database.collection('meta');
  const current = await meta.findOne({ _id: 'schema' });
  if (current && current.version >= SCHEMA_VERSION) return;

  const legacy = await database.collection('appData').findOne({ _id: LEGACY_DOCUMENT_ID });
  const source = legacy || structuredClone(defaultData);

  for (const name of COLLECTION_NAMES) {
    const entries = Array.isArray(source[name]) ? source[name] : (defaultData[name] || []);
    const writes = [];
    let skipped = 0;
    for (const entry of entries) {
      const record = strip(entry);
      const id = record ? keyFor(name, record) : null;
      if (id === null) {
        skipped++;
        continue;
      }
      writes.push({
        updateOne: {
          filter: { _id: id },
          update: { $setOnInsert: { ...record, _rev: 0 } },
          upsert: true
        }
      });
    }
    if (skipped > 0) console.warn(`Migration skipped ${skipped} ${name} record(s) with no usable key.`);
    if (writes.length > 0) await database.collection(name).bulkWrite(writes, { ordered: false });
  }

  await database.collection('settings').updateOne(
    { _id: SETTINGS_ID },
    { $setOnInsert: { ...structuredClone(source.settings || defaultData.settings), _rev: 0 } },
    { upsert: true }
  );

  await meta.updateOne(
    { _id: 'schema' },
    { $set: { version: SCHEMA_VERSION, migratedAt: new Date().toISOString() } },
    { upsert: true }
  );
}

// Forces menu items back to the shipped definitions, as the single-document
// adapter did on every read.
function reconcileMenu(menu) {
  let changed = false;

  const withoutChocolates = menu.filter((item) => item.id !== 5 && item.category !== 'Artisanal Chocolates');
  if (withoutChocolates.length !== menu.length) {
    menu.splice(0, menu.length, ...withoutChocolates);
    changed = true;
  }

  for (const menuItem of defaultData.menu) {
    const existingItem = menu.find((item) => item.id === menuItem.id);
    if (!existingItem) continue;
    if (Array.isArray(menuItem.customisations) && JSON.stringify(existingItem.customisations) !== JSON.stringify(menuItem.customisations)) {
      existingItem.customisations = structuredClone(menuItem.customisations);
      changed = true;
    }
  }

  const ladoo = defaultData.menu.find((item) => item.id === 6);
  const existingLadoo = menu.find((item) => item.id === ladoo.id);
  if (!existingLadoo) {
    menu.push(structuredClone(ladoo));
    changed = true;
  } else if (!Array.isArray(existingLadoo.variants)) {
    Object.assign(existingLadoo, structuredClone(ladoo));
    changed = true;
  } else if (existingLadoo.description !== ladoo.description) {
    existingLadoo.description = ladoo.description;
    changed = true;
  }

  return changed;
}

// Compares the handler's copy against what was loaded and emits one operation
// per genuinely changed record.
function planWrites(data, baseline) {
  const operations = [];

  for (const name of COLLECTION_NAMES) {
    const before = baseline.collections[name];
    const after = new Map();
    for (const entry of data[name] || []) {
      const id = keyFor(name, entry);
      if (id !== null) after.set(id, entry);
    }

    for (const [id, entry] of after) {
      const previous = before.get(id);
      const json = JSON.stringify(entry);
      if (previous && previous.json === json) continue;
      operations.push({ collection: name, id, entry, json, rev: previous ? previous.rev : null });
    }
    for (const id of before.keys()) {
      if (!after.has(id)) operations.push({ collection: name, id, remove: true });
    }
  }

  const settingsJson = JSON.stringify(data.settings);
  if (settingsJson !== baseline.settings.json) {
    operations.push({
      collection: 'settings',
      id: SETTINGS_ID,
      entry: data.settings,
      json: settingsJson,
      rev: baseline.settings.rev
    });
  }

  return operations;
}

// Resolves false when another request has already changed this record.
async function runOperation(database, operation, session) {
  const collection = database.collection(operation.collection);
  const options = session ? { session } : {};

  if (operation.remove) {
    await collection.deleteOne({ _id: operation.id }, options);
    return true;
  }

  if (operation.rev === null) {
    try {
      await collection.insertOne({ _id: operation.id, _rev: 0, ...operation.entry }, options);
      return true;
    } catch (error) {
      if (error && (error.code === 11000 || error.code === 'DUPLICATE_KEY')) return false;
      throw error;
    }
  }

  const result = await collection.replaceOne(
    { _id: operation.id, _rev: operation.rev },
    { _rev: operation.rev + 1, ...operation.entry },
    options
  );
  return result.matchedCount === 1;
}

function lacksTransactionSupport(error) {
  const message = String(error && error.message);
  return error?.code === 20 || /replica set|Transaction numbers|transactions are not supported|not supported/i.test(message);
}

async function applyWrites(client, database, operations) {
  if (operations.length === 0) return;

  // A lone operation is already atomic, so skip the session overhead.
  const useTransaction =
    operations.length > 1 && transactionsSupported !== false && typeof client.startSession === 'function';

  if (useTransaction) {
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        for (const operation of operations) {
          if (!(await runOperation(database, operation, session))) throw new StaleWrite();
        }
      });
      transactionsSupported = true;
      return;
    } catch (error) {
      if (error instanceof StaleWrite) throw error;
      if (!lacksTransactionSupport(error)) throw error;
      // A standalone mongod cannot do multi-document transactions; the writes
      // still have to happen, just without all-or-nothing across collections.
      transactionsSupported = false;
    } finally {
      await session.endSession();
    }
  }

  for (const operation of operations) {
    if (!(await runOperation(database, operation))) throw new StaleWrite();
  }
}

// Keeps a copy of what an admin data reset is about to destroy, so a mistaken
// erase is recoverable.
export async function saveResetSnapshot(snapshot) {
  const client = await getClient();
  const collection = client.db(MONGODB_DB_NAME).collection('resetSnapshots');
  const id = `reset-${new Date().toISOString()}`;
  await collection.insertOne({ _id: id, ...snapshot });
  // Keeping every snapshot forever would dwarf the live data.
  const stale = await collection.find({}, { projection: { _id: 1 } }).sort({ _id: -1 }).skip(5).toArray();
  if (stale.length > 0) await collection.deleteMany({ _id: { $in: stale.map((entry) => entry._id) } });
  return id;
}

function rebase(baseline, operations) {
  for (const operation of operations) {
    if (operation.collection === 'settings') {
      baseline.settings = { rev: (operation.rev || 0) + 1, json: operation.json };
      continue;
    }
    const entries = baseline.collections[operation.collection];
    if (operation.remove) entries.delete(operation.id);
    else entries.set(operation.id, { rev: operation.rev === null ? 0 : operation.rev + 1, json: operation.json });
  }
}

// Returns a lowdb-like object: { data, write() }. Handlers still see plain
// arrays (db.data.orders, db.data.users) and still call write() once at the
// end; only the storage underneath changed.
export async function getDb() {
  const client = await getClient();
  const database = client.db(MONGODB_DB_NAME);
  await ensureSchema(database);

  const [settingsDoc, ...lists] = await Promise.all([
    database.collection('settings').findOne({ _id: SETTINGS_ID }),
    ...COLLECTION_NAMES.map((name) => database.collection(name).find({}).toArray())
  ]);

  const data = {};
  const baseline = { collections: {}, settings: null };

  COLLECTION_NAMES.forEach((name, index) => {
    const docs = (lists[index] || []).slice().sort((a, b) => byKey(a._id, b._id));
    const entries = new Map();
    data[name] = docs.map((doc) => {
      const entry = strip(doc);
      entries.set(doc._id, { rev: doc._rev || 0, json: JSON.stringify(entry) });
      return entry;
    });
    baseline.collections[name] = entries;
  });

  data.settings = strip(settingsDoc) || structuredClone(defaultData.settings);
  baseline.settings = { rev: settingsDoc ? (settingsDoc._rev || 0) : 0, json: JSON.stringify(data.settings) };

  if (reconcileMenu(data.menu)) {
    const repairs = planWrites(data, baseline).filter((operation) => operation.collection === 'menu');
    try {
      await applyWrites(client, database, repairs);
      rebase(baseline, repairs);
    } catch (error) {
      // Another request is repairing the same rows; serving the corrected menu
      // matters more than winning the race to persist it.
      if (!(error instanceof StaleWrite)) throw error;
    }
  }

  return {
    data,
    async write() {
      const operations = planWrites(data, baseline);
      await applyWrites(client, database, operations);
      rebase(baseline, operations);
    }
  };
}
