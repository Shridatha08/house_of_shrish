import { MongoClient } from 'mongodb';

const MEAL_CUSTOMISATIONS = [
  '3 Roti, Vegetable curry, Flavourful rice, Curd, Vegetable/Fruit Salad',
  '4 Roti, Vegetable curry, Curd, Vegetable/Fruit Salad'
];

const defaultData = {
  menu: [
    { id: 1, name: 'Single Meal', description: 'Pure Veg Meals', price: 119, category: 'Pure Veg Meals', image: '', customisations: MEAL_CUSTOMISATIONS },
    { id: 2, name: 'Monthly (Lunch)', description: 'Pure Veg Meals', price: 2999, category: 'Pure Veg Meals', image: '', customisations: MEAL_CUSTOMISATIONS },
    { id: 3, name: 'Monthly (Dinner)', description: 'Pure Veg Meals', price: 2999, category: 'Pure Veg Meals', image: '', customisations: MEAL_CUSTOMISATIONS },
    { id: 4, name: 'Monthly (Lunch + Dinner)', description: 'Pure Veg Meals', price: 5999, category: 'Pure Veg Meals', image: '', customisations: MEAL_CUSTOMISATIONS },
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
  subscriptions: [],
  settings: {
    subscriptionWorkingDays: 26,
    announcement: '',
    orderingPaused: false,
    kitchenClosedDates: [],
    dailyOrderCapacity: 50,
    orderCutoffTime: '10:00',
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

let clientPromise;

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

// Returns a lowdb-like object: { data, write() } backed by a single MongoDB document,
// so existing route handlers (db.data.menu, db.data.orders, etc.) don't need to change.
export async function getDb() {
  const client = await getClient();
  const collection = client.db(MONGODB_DB_NAME).collection('appData');

  let doc = await collection.findOne({ _id: 'main' });
  if (!doc) {
    doc = { _id: 'main', ...structuredClone(defaultData) };
    await collection.insertOne(doc);
  }

  const menuWithoutChocolates = doc.menu.filter((item) => item.id !== 5 && item.category !== 'Artisanal Chocolates');
  if (menuWithoutChocolates.length !== doc.menu.length) {
    doc.menu = menuWithoutChocolates;
    await collection.updateOne({ _id: 'main' }, { $set: { menu: doc.menu } });
  }

  let menuMigrated = false;
  for (const menuItem of defaultData.menu) {
    const existingItem = doc.menu.find((item) => item.id === menuItem.id);
    if (!existingItem) continue;
    if (menuItem.id === 1 && JSON.stringify(existingItem.customisations) !== JSON.stringify(menuItem.customisations)) {
      existingItem.customisations = structuredClone(menuItem.customisations);
      menuMigrated = true;
    }
    if (menuItem.id === 4 && existingItem.price !== menuItem.price) {
      existingItem.price = menuItem.price;
      menuMigrated = true;
    }
  }

  const ladoo = defaultData.menu.find((item) => item.id === 6);
  const existingLadoo = doc.menu.find((item) => item.id === ladoo.id);
  if (!existingLadoo) {
    doc.menu.push(structuredClone(ladoo));
    menuMigrated = true;
  } else if (!Array.isArray(existingLadoo.variants)) {
    Object.assign(existingLadoo, structuredClone(ladoo));
    menuMigrated = true;
  } else if (existingLadoo.description !== ladoo.description) {
    existingLadoo.description = ladoo.description;
    menuMigrated = true;
  }
  if (menuMigrated) {
    const { _id, ...rest } = doc;
    await collection.updateOne({ _id: 'main' }, { $set: rest });
  }

  return {
    data: doc,
    async write() {
      const { _id, ...rest } = doc;
      await collection.updateOne({ _id: 'main' }, { $set: rest }, { upsert: true });
    }
  };
}
