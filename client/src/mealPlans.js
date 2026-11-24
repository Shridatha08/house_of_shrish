// Meal packages are recognised by name prefix, matching the server.
const nameOf = (item) => String((typeof item === 'string' ? item : item?.name) || '').toLowerCase();

export const isMonthlyPlan = (item) => nameOf(item).startsWith('monthly');
export const isWorkWeekPlan = (item) => nameOf(item).startsWith('work week');
export const isWeeklyPlan = (item) => nameOf(item).startsWith('weekly');
export const isMealPackage = (item) => isMonthlyPlan(item) || isWorkWeekPlan(item) || isWeeklyPlan(item);

const PLAN_NAMES = { monthly: 'Monthly', weekly: 'Weekly', workweek: 'Work Week' };

// Prefers the server's `plan` field. Older subscriptions named "Weekly" ran
// Monday to Friday, which is today's Work Week plan.
export function subscriptionPlan(subscription) {
  if (PLAN_NAMES[subscription?.plan]) return subscription.plan;
  if (isMonthlyPlan(subscription?.itemName)) return 'monthly';
  return isWorkWeekPlan(subscription?.itemName) || isWeeklyPlan(subscription?.itemName) ? 'workweek' : 'monthly';
}

export const planName = (subscription) => PLAN_NAMES[subscriptionPlan(subscription)];

// "Work Week plan · Monday to Friday" for the short, non-skippable plans.
export function planDaysNote(subscription) {
  return subscriptionPlan(subscription) === 'weekly'
    ? 'Weekly plan · 6 days, Monday to Saturday'
    : 'Work Week plan · 5 days, Monday to Friday';
}

export function isSkippable(subscription) {
  if (subscription?.skippable === false) return false;
  return subscriptionPlan(subscription) === 'monthly';
}

// Today's date in IST as YYYY-MM-DD.
export function istToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

