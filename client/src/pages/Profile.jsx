import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { updateProfile, getMySubscriptions, getMyOrders, cancelOrder, requestRefund, skipSubscriptionMeal } from '../api';

export default function Profile() {
  const { user, token, ready, updateUser } = useAuth();

  const [name, setName] = useState(user?.name || '');
  const [phone, setPhone] = useState(user?.phone || '');
  const [address, setAddress] = useState(user?.address || '');
  const [flatNumber, setFlatNumber] = useState(user?.flatNumber || '');
  const [pincode, setPincode] = useState(user?.pincode || '');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [subscriptions, setSubscriptions] = useState([]);
  const [orders, setOrders] = useState([]);
  const [orderError, setOrderError] = useState('');
  const [updatingOrderId, setUpdatingOrderId] = useState(null);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());
  const [skipError, setSkipError] = useState('');
  const [skippingMealKey, setSkippingMealKey] = useState('');
  const [subscriptionsError, setSubscriptionsError] = useState('');
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [historyRefresh, setHistoryRefresh] = useState(0);

  useEffect(() => {
    if (!user) return;
    setName(user.name);
    setPhone(user.phone);
    setAddress(user.address || '');
    setFlatNumber(user.flatNumber || '');
    setPincode(user.pincode || '');
  }, [user]);

  useEffect(() => {
    if (user) {
      let cancelled = false;
      setLoadingHistory(true);
      setSubscriptionsError('');
      setOrderError('');
      Promise.all([
        getMySubscriptions(token).then((data) => { if (!cancelled) setSubscriptions(data); }).catch((err) => { if (!cancelled) setSubscriptionsError(err.message); }),
        getMyOrders(token).then((data) => { if (!cancelled) setOrders(data); }).catch((err) => { if (!cancelled) setOrderError(err.message); })
      ]).finally(() => { if (!cancelled) setLoadingHistory(false); });
      return () => { cancelled = true; };
    }
  }, [user, token, historyRefresh]);

  async function handleCancelOrder(order) {
    setOrderError('');
    setUpdatingOrderId(order.id);
    try {
      const updated = await cancelOrder(order.id, token);
      setOrders((prev) => prev.map((item) => item.id === updated.id ? updated : item));
      setSubscriptions(await getMySubscriptions(token));
    } catch (err) {
      setOrderError(err.message);
    } finally {
      setUpdatingOrderId(null);
    }
  }

  async function handleRefundRequest(order) {
    setOrderError('');
    setUpdatingOrderId(order.id);
    try {
      const updated = await requestRefund(order.id, token);
      setOrders((prev) => prev.map((item) => item.id === updated.id ? updated : item));
      setSubscriptions(await getMySubscriptions(token));
    } catch (err) {
      setOrderError(err.message);
    } finally {
      setUpdatingOrderId(null);
    }
  }

  async function handleSkipMeal(subscription, mealEntry) {
    const mealName = mealEntry.meal === 'lunch' ? 'lunch' : 'dinner';
    if (!window.confirm(`Skip ${mealName} on ${mealEntry.date}? Carry-forward is allowed only until ${subscription.carryForwardDeadline || subscription.endDate}.`)) return;
    const key = `${subscription.id}:${mealEntry.date}:${mealEntry.meal}`;
    setSkipError('');
    setSkippingMealKey(key);
    try {
      const updated = await skipSubscriptionMeal(subscription.id, { date: mealEntry.date, meal: mealEntry.meal }, token);
      setSubscriptions((previous) => previous.map((entry) => entry.id === updated.id ? updated : entry));
    } catch (err) {
      setSkipError(err.message);
      if (err.message === 'Cannot be carry forwarded beyond this date') {
        window.alert('Cannot be carry forwarded beyond this date');
      }
    } finally {
      setSkippingMealKey('');
    }
  }

  const calendarYear = calendarMonth.getFullYear();
  const calendarMonthIndex = calendarMonth.getMonth();
  const calendarMonthKey = `${calendarYear}-${String(calendarMonthIndex + 1).padStart(2, '0')}`;
  const calendarTitle = calendarMonth.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const daysInCalendarMonth = new Date(calendarYear, calendarMonthIndex + 1, 0).getDate();
  const calendarOffset = (new Date(calendarYear, calendarMonthIndex, 1).getDay() + 6) % 7;
  const calendarCells = [
    ...Array(calendarOffset).fill(null),
    ...Array.from({ length: daysInCalendarMonth }, (_, index) => index + 1)
  ];
  while (calendarCells.length % 7) calendarCells.push(null);

  const scheduleByDate = {};
  for (const subscription of subscriptions) {
    for (const mealEntry of subscription.schedule || []) {
      if (!mealEntry.date.startsWith(calendarMonthKey)) continue;
      scheduleByDate[mealEntry.date] ||= [];
      scheduleByDate[mealEntry.date].push({ ...mealEntry, subscriptionId: subscription.id });
    }
  }
  const upcomingDates = new Set();
  let upcomingMealCount = 0;
  for (const subscription of subscriptions) {
    for (const mealEntry of subscription.schedule || []) {
      if (mealEntry.status === 'upcoming') {
        upcomingDates.add(mealEntry.date);
        upcomingMealCount++;
      }
    }
  }

  if (ready && !user) {
    return <Navigate to="/login?redirect=/profile" replace />;
  }
  if (!ready) return <p className="status-text">Loading profile...</p>;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSaved(false);
    setSubmitting(true);
    try {
      const { user: updated } = await updateProfile({ name, phone, address, flatNumber, pincode }, token);
      updateUser(updated);
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card profile-card">
        <Link to="/" className="btn-link back-link">‹ Back to Menu</Link>
        <h2>My Profile</h2>
        <form className="checkout-form" onSubmit={handleSubmit}>
          <label>
            Full name
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            Phone number
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              maxLength={10}
              inputMode="numeric"
              required
            />
          </label>
          <label>
            Flat / door number
            <input value={flatNumber} onChange={(event) => setFlatNumber(event.target.value)} maxLength={100} required />
          </label>
          <label>
            Delivery address
            <textarea value={address} onChange={(e) => setAddress(e.target.value)} rows={3} required />
          </label>
          <label>
            Pincode
            <input value={pincode} onChange={(event) => setPincode(event.target.value)} inputMode="numeric" pattern="[1-9][0-9]{5}" maxLength={6} autoComplete="postal-code" required />
          </label>

          {error && <p className="status-text error">{error}</p>}
          {saved && <p className="status-text">Profile updated.</p>}

          <button className="btn-primary" type="submit" disabled={submitting}>
            {submitting ? 'Saving…' : 'Save Changes'}
          </button>
        </form>

        {subscriptionsError && <p className="status-text error">Subscriptions: {subscriptionsError}</p>}
        {subscriptions.length > 0 && (
          <div className="profile-subscriptions">
            <h2>My Monthly Subscriptions</h2>
            {subscriptions.map((sub) => (
              <div key={sub.id} className="subscription-summary-card">
                <div className="subscription-summary-header">
                  <strong>{sub.itemName}</strong>
                  <span
                    className={
                      sub.expired
                        ? 'subscription-badge expired'
                        : sub.expiresToday
                          ? 'subscription-badge expiring'
                          : 'subscription-badge active'
                    }
                  >
                    {sub.expired ? 'Expired' : sub.expiresToday ? 'Expires today' : 'Active'}
                  </span>
                </div>
                <p className="subscription-summary-dates">
                  {sub.startDate} → {sub.endDate}
                </p>
                {sub.carryForwardDeadline && <p className="subscription-summary-dates">Carry-forward deadline: {sub.carryForwardDeadline}</p>}
                {sub.mealsBeyondDeadline > 0 && <p className="status-text error">{sub.mealsBeyondDeadline} meal(s) cannot be scheduled before the carry-forward deadline.</p>}
                {!sub.expired && (
                  <p className="subscription-days-remaining">
                    {sub.daysRemaining === 0 ? 'Ends today' : `${sub.daysRemaining} day${sub.daysRemaining === 1 ? '' : 's'} remaining`}
                  </p>
                )}
              </div>
            ))}
            <div className="subscription-calendar-section">
              <div className="subscription-calendar-heading">
                <div>
                  <h3>Meal Calendar</h3>
                  <p className="subscription-summary-dates">{upcomingDates.size} delivery days remaining · {upcomingMealCount} meals remaining</p>
                </div>
                <div className="calendar-month-controls">
                  <button type="button" className="btn-add" aria-label="Previous month" onClick={() => setCalendarMonth((month) => new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button>
                  <strong>{calendarTitle}</strong>
                  <button type="button" className="btn-add" aria-label="Next month" onClick={() => setCalendarMonth((month) => new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button>
                </div>
              </div>
              <div className="subscription-calendar-grid">
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((weekday) => <strong key={weekday} className="subscription-calendar-weekday">{weekday}</strong>)}
                {calendarCells.map((day, index) => {
                  if (!day) return <div key={`empty-${index}`} className="subscription-calendar-empty" />;
                  const date = `${calendarMonthKey}-${String(day).padStart(2, '0')}`;
                  const entries = (scheduleByDate[date] || []).sort((a, b) => a.meal.localeCompare(b.meal));
                  return (
                    <div key={date} className={`subscription-calendar-day ${entries.length ? 'has-meals' : ''}`}>
                      <span className="subscription-calendar-date">{day}</span>
                      <div className="subscription-calendar-dots" aria-label={`${entries.filter((entry) => entry.status === 'upcoming').length} upcoming meals`}>
                        {entries.map((entry, entryIndex) => (
                          <span key={`${entry.subscriptionId}-${entry.meal}-${entryIndex}`} className={`subscription-meal-dot ${entry.status}`} title={`${entry.meal} ${entry.status}`} />
                        ))}
                      </div>
                      <div className="subscription-calendar-events">
                        {entries.map((entry, entryIndex) => (
                          <div key={`${entry.subscriptionId}-${entry.meal}-event-${entryIndex}`} className={`subscription-calendar-event ${entry.status}`}>
                            <span>{entry.meal === 'lunch' ? 'Lunch' : 'Dinner'}{entry.status === 'skipped' ? ' · Carried forward' : ''}</span>
                            {entry.status === 'upcoming' && entry.canCancel && (
                              <button
                                type="button"
                                className="btn-link"
                                disabled={skippingMealKey === `${entry.subscriptionId}:${date}:${entry.meal}`}
                                onClick={() => {
                                  const subscription = subscriptions.find((candidate) => candidate.id === entry.subscriptionId);
                                  if (subscription) handleSkipMeal(subscription, entry);
                                }}
                              >
                                {skippingMealKey === `${entry.subscriptionId}:${date}:${entry.meal}` ? 'Skipping…' : 'Skip'}
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              {skipError && <p className="status-text error">{skipError}</p>}
              <div className="subscription-calendar-legend"><span className="subscription-meal-dot upcoming" /> Upcoming meal <span className="subscription-meal-dot skipped" /> Carried forward</div>
            </div>
          </div>
        )}

        <div className="profile-subscriptions">
          <h2>My Orders</h2>
          <button type="button" className="btn-add" disabled={loadingHistory} onClick={() => setHistoryRefresh((value) => value + 1)}>Refresh orders and subscriptions</button>
          {orderError && <p className="status-text error">{orderError}</p>}
          {loadingHistory ? <p className="status-text">Loading orders...</p> : orders.length === 0 && !orderError ? <p className="status-text">No orders yet.</p> : orders.map((order) => (
            <div key={order.id} className="subscription-summary-card">
              <div className="subscription-summary-header">
                <strong>#{order.orderNumber || order.id}</strong>
                <span className={`subscription-badge ${order.status === 'delivered' ? 'active' : order.status === 'cancelled' || order.status === 'refunded' ? 'expired' : order.status === 'refund_requested' ? 'pending' : 'expiring'}`}>{order.status.replaceAll('_', ' ')}</span>
              </div>
              <p className="subscription-summary-dates">
                {order.scheduledDate ? `${order.scheduledDate} · ${order.timeSlot} · ` : 'No scheduled delivery · '}₹{order.total}
              </p>
              <p className="subscription-summary-dates">Payment / delivery status: {order.status.replaceAll('_', ' ')}</p>
              <p className="subscription-summary-dates">{order.items.map((item) => `${item.name} × ${item.quantity}`).join(', ')}</p>
              <div className="order-actions">
                {order.status === 'pending_payment' && <Link to={`/payment/${order.id}`} className="btn-link">Continue payment</Link>}
                {(order.paymentStatus === 'verified' || (!order.paymentStatus && ['paid', 'preparing', 'out_for_delivery', 'delivered', 'refunded'].includes(order.status))) && <Link to={`/invoice/${order.id}`} className="btn-link">View invoice</Link>}
                {['pending_payment', 'payment_review', 'paid'].includes(order.status) && (
                  <button type="button" className="btn-add" onClick={() => handleCancelOrder(order)} disabled={updatingOrderId === order.id}>Cancel order</button>
                )}
                {['paid', 'cancelled', 'delivered'].includes(order.status) && (order.paymentStatus === 'verified' || (!order.paymentStatus && ['paid', 'delivered'].includes(order.status))) && (
                  <button type="button" className="btn-add" onClick={() => handleRefundRequest(order)} disabled={updatingOrderId === order.id}>Request refund</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
