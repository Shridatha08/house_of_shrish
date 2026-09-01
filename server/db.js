import { MongoClient } from 'mongodb';

const MEAL_CUSTOMISATIONS = [
  '2 Roti, Vegetable curry, Flavourful rice, Curd, Vegetable/Fruit Salad',
  '4 Roti, Vegetable curry, Curd, Vegetable/Fruit Salad'
];

const defaultData = {
  menu: [
    { id: 1, name: 'Single Meal', description: 'Pure Veg Meals', price: 119, category: 'Pure Veg Meals', image: '', customisations: MEAL_CUSTOMISATIONS },
    { id: 2, name: 'Monthly (Lunch)', description: 'Pure Veg Meals', price: 2999, category: 'Pure Veg Meals', image: '', customisations: MEAL_CUSTOMISATIONS },
    { id: 3, name: 'Monthly (Dinner)', description: 'Pure Veg Meals', price: 2999, category: 'Pure Veg Meals', image: '', customisations: MEAL_CUSTOMISATIONS },
    { id: 4, name: 'Monthly (Lunch + Dinner)', description: 'Pure Veg Meals', price: 5499, category: 'Pure Veg Meals', image: '', customisations: MEAL_CUSTOMISATIONS },
    { id: 5, name: 'Signature Fruit & Nut Selection', description: 'Handcrafted with premium cocoa, roasted nuts, and dried fruits for a luxurious finish.', price: 169, category: 'Artisanal Chocolates', image: '' }
  ],
  orders: [],
  users: [],
  sessions: [],
  subscriptions: [],
  settings: {
    subscriptionWorkingDays: 26
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

  return {
    data: doc,
    async write() {
      const { _id, ...rest } = doc;
      await collection.updateOne({ _id: 'main' }, { $set: rest }, { upsert: true });
    }
  };
}
