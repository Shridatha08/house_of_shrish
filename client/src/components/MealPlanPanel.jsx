import { useState } from 'react';
import { statusOf, mealLabel, formatMealDate, skipAvailability, mealKey, scheduleByDate, upcomingTotals, withinDays, LEGEND, MEAL_STATUSES } from '../schedule';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// The grid is a glance, the list below is where skipping happens. Earlier both
// lived in the calendar cell, which left a 0.56rem Skip link on phones.
export default function MealPlanPanel({ subscriptions, onSkip, skippingMealKey, skipError, today }) {
  const [month, setMonth] = useState(() => new Date());
  const [selectedDate, setSelectedDate] = useState('');
  const [showAll, setShowAll] = useState(false);

  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const monthKey = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
  const monthTitle = month.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const leadingBlanks = (new Date(year, monthIndex, 1).getDay() + 6) % 7;
  const cells = [
    ...Array(leadingBlanks).fill(null),
    ...Array.from({ length: daysInMonth }, (_, index) => index + 1)
  ];
  while (cells.length % 7) cells.push(null);

  const byDate = scheduleByDate(subscriptions);
  const { days: upcomingDays, meals: upcomingMeals } = upcomingTotals(subscriptions);
  const todayKey = today || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  // The short window only means anything while looking at the month today is
  // in; paging back to September has to list September.
  const viewingThisMonth = todayKey.startsWith(monthKey);
  const windowed = viewingThisMonth && !showAll && !selectedDate;
  const allDates = Object.keys(byDate).sort();
  const listedDates = selectedDate
    ? [selectedDate]
    : windowed
      ? allDates.filter((date) => withinDays(date, todayKey))
      : allDates.filter((date) => date.startsWith(monthKey));

  function changeMonth(step) {
    setSelectedDate('');
    setMonth((current) => new Date(current.getFullYear(), current.getMonth() + step, 1));
  }

  return (
    <div className="subscription-calendar-section">
      <div className="subscription-calendar-heading">
        <div>
          <h3>Meal Calendar</h3>
          <p className="subscription-summary-dates">{upcomingDays} delivery days remaining · {upcomingMeals} meals remaining</p>
        </div>
        <div className="calendar-month-controls">
          <button type="button" className="btn-add" aria-label="Previous month" onClick={() => changeMonth(-1)}>‹</button>
          <strong>{monthTitle}</strong>
          <button type="button" className="btn-add" aria-label="Next month" onClick={() => changeMonth(1)}>›</button>
        </div>
      </div>

      <div className="subscription-calendar-grid">
        {WEEKDAYS.map((weekday) => <strong key={weekday} className="subscription-calendar-weekday">{weekday}</strong>)}
        {cells.map((day, index) => {
          if (!day) return <div key={`empty-${index}`} className="subscription-calendar-empty" />;
          const date = `${monthKey}-${String(day).padStart(2, '0')}`;
          const entries = byDate[date] || [];
          const classes = ['subscription-calendar-day'];
          if (entries.length) classes.push('has-meals');
          if (date === todayKey) classes.push('is-today');
          if (date === selectedDate) classes.push('is-selected');
          return (
            <button
              key={date}
              type="button"
              className={classes.join(' ')}
              disabled={!entries.length}
              aria-pressed={date === selectedDate}
              aria-label={entries.length
                ? `${formatMealDate(date)}: ${entries.map((entry) => `${mealLabel(entry.meal)} ${statusOf(entry.status).label}`).join(', ')}`
                : formatMealDate(date)}
              onClick={() => setSelectedDate((current) => current === date ? '' : date)}
            >
              <span className="subscription-calendar-date">{day}</span>
              <span className="subscription-calendar-dots">
                {entries.map((entry, entryIndex) => (
                  <span key={`${entry.subscriptionId}-${entry.meal}-${entryIndex}`} className={`subscription-meal-dot ${statusOf(entry.status).tone}`} />
                ))}
              </span>
            </button>
          );
        })}
      </div>

      <div className="subscription-calendar-legend">
        {LEGEND.map((tone) => (
          <span key={tone} className="subscription-legend-item">
            <span className={`subscription-meal-dot ${tone}`} />
            {tone === 'past' ? 'Past' : Object.values(MEAL_STATUSES).find((status) => status.tone === tone).label}
          </span>
        ))}
      </div>

      <div className="meal-list-heading">
        <h4>
          {selectedDate
            ? formatMealDate(selectedDate)
            : windowed
              ? 'This week'
              : `${monthTitle} meals`}
        </h4>
        {selectedDate
          ? <button type="button" className="btn-link" onClick={() => setSelectedDate('')}>Back to this week</button>
          : viewingThisMonth && (
            <button type="button" className="btn-link" onClick={() => setShowAll((current) => !current)}>
              {showAll ? 'Show less' : 'Show whole month'}
            </button>
          )}
      </div>
      {skipError && <p className="status-text error">{skipError}</p>}
      {listedDates.length === 0 && (
        <p className="status-text">
          {windowed ? 'Nothing in the last or next three days.' : 'Nothing scheduled here.'}
        </p>
      )}

      <ul className="meal-list">
        {listedDates.flatMap((date) => (byDate[date] || []).map((entry, entryIndex) => {
          const status = statusOf(entry.status);
          const { canSkip, reason } = skipAvailability(entry);
          const key = mealKey(entry.subscriptionId, date, entry.meal);
          const busy = skippingMealKey === key;
          return (
            <li key={`${key}-${entryIndex}`} className={`meal-row ${status.tone}`}>
              <div className="meal-row-main">
                <span className="meal-row-when">{mealLabel(entry.meal)} · {formatMealDate(date)}</span>
                <span className="meal-row-plan">{entry.subscriptionName}</span>
                {status.note && <span className="meal-row-note">{status.note}</span>}
              </div>
              <div className="meal-row-action">
                <span className={`meal-status-pill ${status.tone}`}>{status.label}</span>
                {entry.status === 'upcoming' && (canSkip
                  ? (
                    <button
                      type="button"
                      className="btn-add meal-skip-btn"
                      disabled={busy}
                      onClick={() => {
                        const subscription = subscriptions.find((candidate) => candidate.id === entry.subscriptionId);
                        if (subscription) onSkip(subscription, entry);
                      }}
                    >
                      {busy ? 'Skipping…' : 'Skip'}
                    </button>
                  )
                  : <span className="meal-row-note">{reason}</span>)}
              </div>
            </li>
          );
        }))}
      </ul>
    </div>
  );
}
