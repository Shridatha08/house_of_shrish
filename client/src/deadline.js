export const RISK = { none: 'none', approaching: 'approaching', overflowing: 'overflowing' };

function startOfDayUtc(date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

export function daysUntilDeadline(sub, today) {
  if (!sub?.carryForwardDeadline) return null;
  const end = Date.parse(`${sub.carryForwardDeadline}T00:00:00Z`);
  if (Number.isNaN(end)) return null;
  return Math.round((end - startOfDayUtc(today)) / 86400000);
}

export function deadlineRisk(sub, today) {
  if (!sub || sub.expired) return RISK.none;
  if ((sub.mealsBeyondDeadline || 0) > 0) return RISK.overflowing;
  if ((sub.remainingMeals || 0) === 0) return RISK.none;
  const days = daysUntilDeadline(sub, today);
  if (days === null) return RISK.none;
  return days <= 7 ? RISK.approaching : RISK.none;
}

export function formatDate(iso) {
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function deadlineMessage(sub, today) {
  const risk = deadlineRisk(sub, today);
  if (risk === RISK.none || !sub.carryForwardDeadline) return null;

  const by = formatDate(sub.carryForwardDeadline);
  if (risk === RISK.overflowing) {
    const count = sub.mealsBeyondDeadline;
    const meals = count === 1 ? '1 meal' : `${count} meals`;
    return `${meals} no longer fit before ${by} and will be lost. Message us and we will sort it out.`;
  }

  const days = daysUntilDeadline(sub, today) ?? 0;
  const left = sub.remainingMeals === 1 ? '1 meal' : `${sub.remainingMeals} meals`;
  const when = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
  return `You have ${left} left and your plan ends ${when} (${by}). Anything unused after that is lost.`;
}

/// What the customer is told while the driver is on the way.
export function etaText(tracking) {
  if (!tracking) return '';
  if (!tracking.trackable) {
    return tracking.status === 'delivered'
      ? 'This order has been delivered.'
      : 'Live tracking starts once your order is out for delivery.';
  }
  const parts = [];
  if (tracking.etaMinutes != null) {
    parts.push(tracking.etaMinutes <= 1 ? 'Arriving now' : `About ${tracking.etaMinutes} min away`);
  }
  if (tracking.stopsAway != null) {
    parts.push(tracking.stopsAway === 0 ? 'you are next' : `${tracking.stopsAway} stop(s) before you`);
  }
  if (tracking.distanceKm != null) parts.push(`${tracking.distanceKm} km`);
  return parts.join(' · ') || 'On the way';
}
