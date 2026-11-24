// Meal box tiles and the weekly menu preview, shared by the menu and box pages.

export const WEEK_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Matches the server, for responses from before it sent mealBoxes.
export const DEFAULT_MEAL_BOXES = [
  { label: 'Royal Nourish Box', fixedItems: ['3 Roti', 'Curd', 'Vegetable/Fruit Salad'], dailyItems: ['curry', 'rice'] },
  { label: 'Chapati Nourish Box', fixedItems: ['3 Roti', 'Vegetable/Fruit Salad'], dailyItems: ['curry'] },
  { label: 'Rice Nourish Box', fixedItems: ['Vegetable/Fruit Salad'], dailyItems: ['curry', 'rice'] }
];

export const SECTIONS = {
  single: { title: 'Single Meal', note: null, unit: 'meal', days: 6 },
  workweek: { title: 'Work Week Plan', note: '5 days, Monday to Friday', unit: '5 days', days: 5 },
  weekly: { title: 'Weekly Plan', note: '6 days, Monday to Saturday', unit: 'week', days: 6 },
  monthly: { title: 'Monthly Package', note: 'Monday to Saturday', unit: 'month', days: 6 }
};

// "Royal Nourish Box" -> "royal-nourish-box", used in /box/:section/:box.
export function boxSlug(label) {
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function hasMealBoxes(item) {
  return Boolean(item?.variants?.some((variant) => variant.description));
}

export function boxContents(storeConfig, label) {
  const boxes = Array.isArray(storeConfig?.mealBoxes) ? storeConfig.mealBoxes : DEFAULT_MEAL_BOXES;
  return boxes.find((box) => box.label === label) ||
    DEFAULT_MEAL_BOXES.find((box) => box.label === label) ||
    { label, fixedItems: [], dailyItems: [] };
}

// The day's curry and/or rice for a box, in the order the box lists them.
export function dishesFor(storeConfig, label, day, service) {
  const dishes = storeConfig?.weeklyMenu?.[day]?.[service] || {};
  return boxContents(storeConfig, label).dailyItems.map((kind) => ({
    kind,
    title: kind === 'rice' ? 'Flavourful rice' : 'Vegetable curry',
    name: String(dishes[kind] || '').trim()
  }));
}

function clock(hhmm) {
  const [hourText, minute = '00'] = String(hhmm).trim().split(':');
  const hour = Number(hourText) || 0;
  return `${hour % 12 === 0 ? 12 : hour % 12}:${minute} ${hour < 12 ? 'AM' : 'PM'}`;
}

// "11:00 AM – 1:00 PM" from a "11:00-13:00" delivery slot; index 0 is lunch.
export function deliveryWindow(slots, index) {
  const slot = Array.isArray(slots) ? slots[index] : null;
  if (!slot) return null;
  const parts = slot.split('-');
  return parts.length === 2 ? `${clock(parts[0])} – ${clock(parts[1])}` : slot;
}

// Monday is 0; Sunday, or a day beyond the section's last, falls back to Monday.
export function defaultDayIndex(dayCount, now = new Date()) {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' }).format(now);
  const index = DAY_SHORT.indexOf(weekday);
  return index >= 0 && index < dayCount ? index : 0;
}

export function availableSingleMealServices(storeConfig, now = new Date()) {
  if (storeConfig.singleMealClosedToday) return [];
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const current = `${parts.find((part) => part.type === 'hour').value}:${parts.find((part) => part.type === 'minute').value}`;
  const lunchOpen = current < (storeConfig.lunchCutoffTime || '11:00');
  const dinnerOpen = current < (storeConfig.dinnerCutoffTime || '18:00');
  if (lunchOpen && dinnerOpen) return ['lunch', 'dinner'];
  if (lunchOpen) return ['lunch'];
  if (dinnerOpen) return ['dinner'];
  return [];
}
