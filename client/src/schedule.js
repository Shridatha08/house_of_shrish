// The skip cutoffs the server enforces in canCancelSubscriptionMeal. They are
// deliberately not read from store settings: those are the *ordering* cutoffs,
// and a customer told the wrong time would hit a refusal they cannot explain.
export const SKIP_CUTOFFS = { lunch: '11:00', dinner: '18:00' };

// Every state a scheduled meal can be in. `elapsed` is a meal from before the
// kitchen recorded deliveries, so it reads as served rather than as unknown.
export const MEAL_STATUSES = {
  upcoming: { label: 'Upcoming', tone: 'upcoming' },
  delivered: { label: 'Delivered', tone: 'delivered' },
  elapsed: { label: 'Delivered', tone: 'past' },
  skipped: { label: 'Skipped', tone: 'skipped', note: 'Carried forward to the end of your plan.' },
  maintenance: { label: 'Kitchen closed', tone: 'maintenance', note: 'We could not cook this one. It is back on your plan and your end date moved out to fit it.' }
};

export const LEGEND = ['upcoming', 'delivered', 'past', 'maintenance', 'skipped'];

export function statusOf(status) {
  return MEAL_STATUSES[status] || { label: status || 'Scheduled', tone: 'past' };
}

export function mealLabel(meal) {
  return meal === 'lunch' ? 'Lunch' : meal === 'dinner' ? 'Dinner' : meal;
}

export function formatMealDate(date) {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatCutoff(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const suffix = h < 12 ? 'am' : 'pm';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m ? `:${String(m).padStart(2, '0')}` : ''} ${suffix}`;
}

// Why the Skip button is or is not there, so the absence of one is never a
// mystery.
export function skipAvailability(entry) {
  if (!entry || entry.status !== 'upcoming') return { canSkip: false, reason: '' };
  if (entry.canCancel) return { canSkip: true, reason: '' };
  const cutoff = SKIP_CUTOFFS[entry.meal];
  return {
    canSkip: false,
    reason: cutoff
      ? `Skipping closed at ${formatCutoff(cutoff)}`
      : 'Skipping has closed'
  };
}

export function mealKey(subscriptionId, date, meal) {
  return `${subscriptionId}:${date}:${meal}`;
}

// Flattens every plan into one date-keyed calendar, because a customer on both
// a lunch and a dinner plan thinks in days, not in subscriptions.
export function scheduleByDate(subscriptions, monthKey) {
  const byDate = {};
  for (const subscription of subscriptions || []) {
    for (const entry of subscription.schedule || []) {
      if (monthKey && !entry.date.startsWith(monthKey)) continue;
      (byDate[entry.date] ||= []).push({
        ...entry,
        subscriptionId: subscription.id,
        subscriptionName: subscription.itemName
      });
    }
  }
  // Chronological, not alphabetical: sorting by name would serve dinner first.
  const order = ['lunch', 'dinner'];
  for (const entries of Object.values(byDate)) {
    entries.sort((a, b) => order.indexOf(a.meal) - order.indexOf(b.meal));
  }
  return byDate;
}

export function upcomingTotals(subscriptions) {
  const dates = new Set();
  let meals = 0;
  for (const subscription of subscriptions || []) {
    for (const entry of subscription.schedule || []) {
      if (entry.status !== 'upcoming') continue;
      dates.add(entry.date);
      meals++;
    }
  }
  return { days: dates.size, meals };
}

export function planSummary(subscriptions) {
  if (!subscriptions?.length) return 'No active plan';
  const { days, meals } = upcomingTotals(subscriptions);
  if (!meals) return 'No meals left';
  return `${days} delivery day${days === 1 ? '' : 's'} · ${meals} meal${meals === 1 ? '' : 's'} left`;
}
