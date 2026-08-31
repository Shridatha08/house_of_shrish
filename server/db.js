import { JSONFilePreset } from 'lowdb/node';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbFile = path.join(__dirname, 'data.json');

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


export async function getDb() {
  const db = await JSONFilePreset(dbFile, defaultData);
  return db;
}
