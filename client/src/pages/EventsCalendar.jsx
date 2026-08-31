import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import calendarIcon from '../../../calendar.png';
import { useAuth } from '../context/AuthContext';
import { getHolidays } from '../api';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function pad(n) {
  return String(n).padStart(2, '0');
}

export default function EventsCalendar() {
  const { user, ready } = useAuth();
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth()); // 0-indexed
  const [holidays, setHolidays] = useState([]);

  useEffect(() => {
    getHolidays()
      .then(setHolidays)
      .catch(() => setHolidays([]));
  }, []);

  if (ready && !user) {
    return <Navigate to="/login?redirect=/events" replace />;
  }

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(day);

  const holidaysByDate = new Map(holidays.map((h) => [h.date, h.name]));

  function changeMonth(delta) {
    let newMonth = month + delta;
    let newYear = year;
    if (newMonth < 0) {
      newMonth = 11;
      newYear -= 1;
    } else if (newMonth > 11) {
      newMonth = 0;
      newYear += 1;
    }
    setMonth(newMonth);
    setYear(newYear);
  }

  return (
    <div className="events-page">
      <Link to="/" className="btn-link back-link">‹ Back to Menu</Link>

      <div className="events-heading">
        <img src={calendarIcon} alt="Events Calendar" className="events-icon" />
        <h2>Events Calendar</h2>
      </div>

      <div className="calendar-nav">
        <button type="button" onClick={() => changeMonth(-1)}>‹</button>
        <strong>{MONTH_NAMES[month]} {year}</strong>
        <button type="button" onClick={() => changeMonth(1)}>›</button>
      </div>

      <div className="calendar-grid">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
          <div key={d} className="calendar-day-label">{d}</div>
        ))}
        {cells.map((day, idx) => {
          if (!day) return <div key={`blank-${idx}`} className="calendar-cell empty" />;

          const dateStr = `${year}-${pad(month + 1)}-${pad(day)}`;
          const isSunday = new Date(year, month, day).getDay() === 0;
          const adminHoliday = holidaysByDate.get(dateStr);
          const isHoliday = isSunday || Boolean(adminHoliday);

          return (
            <div key={dateStr} className={`calendar-cell${isHoliday ? ' holiday' : ''}`}>
              <span className="calendar-date">{day}</span>
              {adminHoliday && <span className="calendar-holiday-name">{adminHoliday}</span>}
              {!adminHoliday && isSunday && <span className="calendar-holiday-name">Sunday</span>}
            </div>
          );
        })}
      </div>

      <p className="status-text">Sundays and admin-added dates are shown as holidays in red.</p>
    </div>
  );
}
