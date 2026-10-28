const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8');

class DuplicateKey extends Error {
  constructor() {
    super('E11000 duplicate key error');
    this.code = 11000;
  }
}

function matches(doc, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === 'object' && '$exists' in value) {
      return (doc[key] !== undefined) === value.$exists;
    }
    return doc[key] === value;
  });
}

// Minimal stand-in for the slice of the driver the adapter actually uses.
function mockMongo({ transactions = true } = {}) {
  const store = new Map();
  const of = (name) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name);
  };

  const collection = (name) => ({
    find() {
      return { toArray: async () => [...of(name).values()].map((doc) => structuredClone(doc)) };
    },
    async findOne(filter) {
      const found = [...of(name).values()].find((doc) => matches(doc, filter));
      return found ? structuredClone(found) : null;
    },
    async insertOne(doc) {
      if (of(name).has(doc._id)) throw new DuplicateKey();
      of(name).set(doc._id, structuredClone(doc));
      return { insertedId: doc._id };
    },
    async replaceOne(filter, replacement) {
      const existing = of(name).get(filter._id);
      if (!existing || !matches(existing, filter)) return { matchedCount: 0 };
      of(name).set(filter._id, structuredClone({ _id: filter._id, ...replacement }));
      return { matchedCount: 1 };
    },
    async deleteOne(filter) {
      const existing = of(name).get(filter._id);
      if (!existing || !matches(existing, filter)) return { deletedCount: 0 };
      of(name).delete(filter._id);
      return { deletedCount: 1 };
    },
    async updateOne(filter, update, options = {}) {
      const existing = [...of(name).values()].find((doc) => matches(doc, filter));
      if (existing) {
        if (update.$set) Object.assign(existing, structuredClone(update.$set));
        return { matchedCount: 1 };
      }
      if (!options.upsert) return { matchedCount: 0 };
      const seeded = { _id: filter._id, ...structuredClone(update.$setOnInsert || {}), ...structuredClone(update.$set || {}) };
      of(name).set(seeded._id, seeded);
      return { matchedCount: 0, upsertedId: seeded._id };
    },
    async bulkWrite(operations) {
      for (const operation of operations) {
        const { filter, update, upsert } = operation.updateOne;
        await collection(name).updateOne(filter, update, { upsert });
      }
      return { ok: 1 };
    }
  });

  const client = {
    db: () => ({ collection }),
    startSession() {
      return {
        async withTransaction(run) {
          if (!transactions) throw Object.assign(new Error('Transaction numbers are only allowed on a replica set member or mongos'), { code: 20 });
          return run();
        },
        async endSession() {}
      };
    }
  };

  return { client, store, raw: (name) => of(name) };
}

function loadAdapter(options) {
  const mongo = mockMongo(options);
  const context = {
    crypto,
    structuredClone,
    console,
    process: { env: { MONGODB_URI: 'mock://', MONGODB_DB_NAME: 'test' } },
    MongoClient: class {
      connect() {
        return Promise.resolve(mongo.client);
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(
    source.replace(/^import .*;\r?$/gm, '').replace(/export async function/g, 'async function'),
    context
  );
  return { getDb: context.getDb, ...mongo };
}

const legacyDocument = {
  _id: 'main',
  revision: 7,
  menu: [{ id: 1, name: 'Single Meal', price: 129, category: 'Pure Veg Meals', customisations: ['a'] }],
  orders: [
    { id: 1, orderNumber: '1', status: 'paid', total: 129, customer: { name: 'A' } },
    { id: 2, orderNumber: '2', status: 'delivered', total: 299, customer: { name: 'B' } }
  ],
  users: [{ id: 1, name: 'A', phone: '9000000000' }],
  sessions: [{ token: 'tok-1', userId: 1, createdAt: '2026-10-10T00:00:00Z' }],
  subscriptions: [{ id: 'sub-1', userId: 1, approved: true }],
  passwordResetRequests: [],
  holidays: [{ id: 1, date: '2026-01-01', name: "New Year's Day" }],
  drivers: [{ id: 77, name: 'Ravi', phone: '9777777777' }],
  driverSessions: [{ token: 'driver-1', driverId: 77 }],
  deviceTokens: [{ token: 'f'.repeat(600), userId: 1 }],
  settings: { subscriptionWorkingDays: 26, announcement: 'Hello', dailyOrderCapacity: 50 }
};

async function migrated(options) {
  const adapter = loadAdapter(options);
  adapter.raw('appData').set('main', structuredClone(legacyDocument));
  return adapter;
}

test('migration copies every record out of the legacy document', async () => {
  const adapter = await migrated();
  const db = await adapter.getDb();

  assert.equal(db.data.orders.length, 2);
  assert.equal(db.data.users[0].phone, '9000000000');
  assert.equal(db.data.sessions[0].token, 'tok-1');
  assert.equal(db.data.subscriptions[0].id, 'sub-1');
  assert.equal(db.data.drivers[0].name, 'Ravi');
  assert.equal(db.data.driverSessions[0].driverId, 77);
  assert.equal(db.data.deviceTokens[0].userId, 1);
  assert.equal(db.data.settings.announcement, 'Hello');
  assert.ok(db.data.holidays.length >= 1);
});

test('the legacy document is kept as a backup and never mutated', async () => {
  const adapter = await migrated();
  const db = await adapter.getDb();
  db.data.orders[0].status = 'refunded';
  await db.write();

  const legacy = adapter.raw('appData').get('main');
  assert.equal(legacy.orders[0].status, 'paid', 'backup untouched');
  assert.equal(legacy.revision, 7);
});

test('migration is idempotent and does not resurrect deleted records', async () => {
  const adapter = await migrated();

  const first = await adapter.getDb();
  first.data.orders = first.data.orders.filter((order) => order.id !== 2);
  await first.write();
  assert.equal(adapter.raw('orders').size, 1);

  // A later boot must not re-seed from the legacy document.
  const second = await adapter.getDb();
  assert.equal(second.data.orders.length, 1);
  assert.equal(second.data.orders[0].id, 1);
});

test('storage bookkeeping never leaks into handler data', async () => {
  const adapter = await migrated();
  const db = await adapter.getDb();

  for (const order of db.data.orders) {
    assert.equal(order._id, undefined);
    assert.equal(order._rev, undefined);
  }
  assert.equal(db.data.settings._id, undefined);
  assert.equal(db.data.settings._rev, undefined);

  db.data.orders[0].status = 'preparing';
  await db.write();
  const reloaded = await adapter.getDb();
  assert.equal(reloaded.data.orders.find((o) => o.id === 1)._id, undefined);
  assert.equal(reloaded.data.orders.find((o) => o.id === 1).status, 'preparing');
});

test('writes to different records no longer collide', async () => {
  const adapter = await migrated();
  const first = await adapter.getDb();
  const second = await adapter.getDb();

  first.data.orders.find((order) => order.id === 1).status = 'preparing';
  second.data.orders.find((order) => order.id === 2).status = 'refunded';

  await first.write();
  await second.write();

  const reloaded = await adapter.getDb();
  assert.equal(reloaded.data.orders.find((o) => o.id === 1).status, 'preparing');
  assert.equal(reloaded.data.orders.find((o) => o.id === 2).status, 'refunded');
});

test('writes across different collections no longer collide', async () => {
  const adapter = await migrated();
  const ordering = await adapter.getDb();
  const admin = await adapter.getDb();

  ordering.data.orders.push({ id: 3, orderNumber: '3', status: 'pending_payment', total: 99, customer: {} });
  admin.data.settings.announcement = 'Closed Monday';

  await ordering.write();
  await admin.write();

  const reloaded = await adapter.getDb();
  assert.equal(reloaded.data.orders.length, 3);
  assert.equal(reloaded.data.settings.announcement, 'Closed Monday');
});

test('the same record still cannot be written from two stale snapshots', async () => {
  const adapter = await migrated();
  const first = await adapter.getDb();
  const second = await adapter.getDb();

  first.data.orders.find((order) => order.id === 1).status = 'preparing';
  second.data.orders.find((order) => order.id === 1).status = 'cancelled';

  await first.write();
  await assert.rejects(second.write(), (error) => error.status === 409 && /Another update completed first/.test(error.message));

  const reloaded = await adapter.getDb();
  assert.equal(reloaded.data.orders.find((o) => o.id === 1).status, 'preparing', 'the first write is not lost');
});

test('two requests cannot insert the same new record', async () => {
  const adapter = await migrated();
  const first = await adapter.getDb();
  const second = await adapter.getDb();

  first.data.orders.push({ id: 9, orderNumber: '9', status: 'paid', total: 1, customer: {} });
  second.data.orders.push({ id: 9, orderNumber: '9-other', status: 'paid', total: 2, customer: {} });

  await first.write();
  await assert.rejects(second.write(), (error) => error.status === 409);
  assert.equal(adapter.raw('orders').get(9).orderNumber, '9');
});

test('competing edits to the one settings record are rejected', async () => {
  const adapter = await migrated();
  const first = await adapter.getDb();
  const second = await adapter.getDb();

  first.data.settings.announcement = 'One';
  second.data.settings.announcement = 'Two';

  await first.write();
  await assert.rejects(second.write(), (error) => error.status === 409);
  assert.equal((await adapter.getDb()).data.settings.announcement, 'One');
});

test('deletions are applied and survive a reload', async () => {
  const adapter = await migrated();
  const db = await adapter.getDb();

  db.data.sessions = db.data.sessions.filter((session) => session.token !== 'tok-1');
  await db.write();

  assert.equal(adapter.raw('sessions').size, 0);
  assert.equal((await adapter.getDb()).data.sessions.length, 0);
});

test('a handler can write more than once in a request', async () => {
  const adapter = await migrated();
  const db = await adapter.getDb();

  db.data.orders.find((order) => order.id === 1).status = 'preparing';
  await db.write();
  db.data.orders.find((order) => order.id === 1).status = 'out_for_delivery';
  await db.write();

  assert.equal((await adapter.getDb()).data.orders.find((o) => o.id === 1).status, 'out_for_delivery');
});

test('device tokens too long to index are keyed by digest', async () => {
  const adapter = await migrated();
  const db = await adapter.getDb();

  const long = 'g'.repeat(4000);
  db.data.deviceTokens.push({ token: long, userId: 1 });
  await db.write();

  const keys = [...adapter.raw('deviceTokens').keys()];
  assert.ok(keys.every((key) => key.length === 64), 'every key is a sha256 digest');
  assert.ok((await adapter.getDb()).data.deviceTokens.some((entry) => entry.token === long));
});

test('a standalone mongod without transactions still persists every change', async () => {
  const adapter = await migrated({ transactions: false });
  const db = await adapter.getDb();

  db.data.orders.push({ id: 4, orderNumber: '4', status: 'paid', total: 50, customer: {} });
  db.data.users.push({ id: 2, name: 'C', phone: '9000000002' });
  await db.write();

  const reloaded = await adapter.getDb();
  assert.equal(reloaded.data.orders.length, 3);
  assert.equal(reloaded.data.users.length, 2);
});

test('a fresh database is seeded from the shipped defaults', async () => {
  const adapter = loadAdapter();
  const db = await adapter.getDb();

  assert.ok(db.data.menu.some((item) => item.name === 'Single Meal'));
  assert.ok(db.data.menu.some((item) => item.name === 'Dry Fruits Ladoo'));
  assert.equal(db.data.orders.length, 0);
  assert.equal(db.data.settings.subscriptionWorkingDays, 26);
  assert.ok(db.data.holidays.length > 0);
});

test('menu items are reconciled back to the shipped definitions', async () => {
  const adapter = await migrated();
  const first = await adapter.getDb();

  // The legacy fixture carries a stale customisation list.
  assert.ok(first.data.menu.find((item) => item.id === 1).customisations.length > 1);
  assert.ok(first.data.menu.some((item) => item.id === 6), 'missing items are restored');

  const second = await adapter.getDb();
  assert.deepEqual(
    second.data.menu.find((item) => item.id === 1).customisations,
    first.data.menu.find((item) => item.id === 1).customisations
  );
});

test('the legacy ladoo size and price migrate to the new 100g option', async () => {
  const adapter = loadAdapter();
  adapter.raw('menu').set(6, {
    _id: 6,
    id: 6,
    name: 'Dry Fruits Ladoo',
    description: 'Naturally sweetened with dates, made with premium dry fruits and crafted with care',
    price: 249,
    category: 'Artisanal Sweets',
    image: 'ladoo.png',
    variants: [
      { label: '200g', price: 249 },
      { label: '500g', price: 699 }
    ]
  });

  const first = await adapter.getDb();
  const ladoo = first.data.menu.find((item) => item.id === 6);
  assert.equal(ladoo.price, 129);
  assert.deepEqual(
    Array.from(ladoo.variants, (variant) => `${variant.label}:${variant.price}`),
    ['100g:129', '500g:699']
  );

  const second = await adapter.getDb();
  assert.deepEqual(
    Array.from(
      second.data.menu.find((item) => item.id === 6).variants,
      (variant) => `${variant.label}:${variant.price}`
    ),
    ['100g:129', '500g:699']
  );
});

test('collections load in a stable order regardless of storage order', async () => {
  const adapter = loadAdapter();
  await adapter.getDb();

  // Re-insert the menu in reverse so an unsorted find would return it jumbled.
  const menu = adapter.raw('menu');
  const shuffled = [...menu.entries()].reverse();
  menu.clear();
  for (const [id, doc] of shuffled) menu.set(id, doc);

  const db = await adapter.getDb();
  const ids = db.data.menu.map((item) => item.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'menu is served in id order');

  const again = await adapter.getDb();
  assert.deepEqual(again.data.menu.map((item) => item.id), ids, 'and the order is repeatable');
});

test('records with no usable key are reported rather than silently dropped', async () => {
  const warnings = [];
  const adapter = loadAdapter();
  adapter.raw('appData').set('main', {
    _id: 'main',
    ...structuredClone(legacyDocument),
    sessions: [{ token: 'good', userId: 1 }, { userId: 2 }]
  });
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    const db = await adapter.getDb();
    assert.equal(db.data.sessions.length, 1);
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(warnings.some((message) => /skipped 1 sessions/.test(message)), warnings.join('|'));
});
