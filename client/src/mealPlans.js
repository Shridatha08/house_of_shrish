// Meal packages are recognised by name prefix, matching the server.
const nameOf = (item) => String((typeof item === 'string' ? item : item?.name) || '').toLowerCase();

export const isMonthlyPlan = (item) => nameOf(item).startsWith('monthly');
export const isWeeklyPlan = (item) => nameOf(item).startsWith('weekly');
export const isMealPackage = (item) => isMonthlyPlan(item) || isWeeklyPlan(item);

// Prefers the server's `plan` field and falls back to the item name.
export function subscriptionPlan(subscription) {
  if (subscription?.plan === 'weekly' || subscription?.plan === 'monthly') return subscription.plan;
  return isWeeklyPlan(subscription?.itemName) ? 'weekly' : 'monthly';
}

export const planName = (subscription) => (subscriptionPlan(subscription) === 'weekly' ? 'Weekly' : 'Monthly');

export function isSkippable(subscription) {
  if (subscription?.skippable === false) return false;
  return subscriptionPlan(subscription) !== 'weekly';
}

export const WEEKLY_START_MESSAGE = 'Weekly packages start on a Monday. Choose a Monday start date.';

// Today's date in IST as YYYY-MM-DD.
export function istToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function parseDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date ? null : parsed;
}

export function isMonday(date) {
  return parseDate(date)?.getUTCDay() === 1;
}

// The given date if it is a Monday, otherwise the following Monday.
export function nextMonday(date) {
  const parsed = parseDate(date);
  if (!parsed) return '';
  const offset = (8 - parsed.getUTCDay()) % 7;
  parsed.setUTCDate(parsed.getUTCDate() + offset);
  return parsed.toISOString().slice(0, 10);
}
