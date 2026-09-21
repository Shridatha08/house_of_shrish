import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getHolidays,
  addHoliday,
  deleteHoliday,
  verifyAdminKey,
  getAdminSettings,
  updateAdminSettings,
  getAdminSubscriptions,
  updateAdminSubscription,
  approveAdminSubscription,
  getAdminUsers,
  deleteAdminUser,
  getAdminOrders,
  updateAdminOrderStatus,
  getMenu,
  updateAdminMenuItem
} from '../api';

const ADMIN_KEY_STORAGE = 'houseOfShrishAdminKey';

export default function AdminHolidays() {
  const [adminKey, setAdminKey] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [unlockError, setUnlockError] = useState('');
  const [checking, setChecking] = useState(true);

  const [holidays, setHolidays] = useState([]);
  const [newDate, setNewDate] = useState('');
  const [newName, setNewName] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [workingDays, setWorkingDays] = useState('');
  const [settingsError, setSettingsError] = useState('');
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [orderingPaused, setOrderingPaused] = useState(false);
  const [dailyOrderCapacity, setDailyOrderCapacity] = useState('50');
  const [orderCutoffTime, setOrderCutoffTime] = useState('10:00');
  const [kitchenClosedDates, setKitchenClosedDates] = useState('');
  const [deliveryTimeSlots, setDeliveryTimeSlots] = useState('11:00-13:00,18:00-20:00');
  const [menuItems, setMenuItems] = useState([]);
  const [savingMenuId, setSavingMenuId] = useState(null);

  const [subscriptions, setSubscriptions] = useState([]);
  const [subsEdits, setSubsEdits] = useState({}); // { [id]: { startDate, workingDaysRequired } }
  const [subsError, setSubsError] = useState('');
  const [savingSubId, setSavingSubId] = useState(null);
  const [approvingSubId, setApprovingSubId] = useState(null);

  const [users, setUsers] = useState([]);
  const [usersError, setUsersError] = useState('');
  const [removingUserId, setRemovingUserId] = useState(null);
  const [orders, setOrders] = useState([]);
  const [ordersError, setOrdersError] = useState('');
  const [updatingOrderId, setUpdatingOrderId] = useState(null);

  useEffect(() => {
    const saved = sessionStorage.getItem(ADMIN_KEY_STORAGE);
    if (!saved) {
      setChecking(false);
      return;
    }
    verifyAdminKey(saved)
      .then(() => {
        setAdminKey(saved);
        setUnlocked(true);
      })
      .catch(() => sessionStorage.removeItem(ADMIN_KEY_STORAGE))
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    if (unlocked) {
      getHolidays().then(setHolidays).catch(() => setHolidays([]));
      getAdminSettings(adminKey)
        .then((s) => {
          setWorkingDays(String(s.subscriptionWorkingDays));
          setAnnouncement(s.announcement || '');
          setOrderingPaused(Boolean(s.orderingPaused));
          setDailyOrderCapacity(String(s.dailyOrderCapacity || 50));
          setOrderCutoffTime(s.orderCutoffTime || '10:00');
          setKitchenClosedDates((s.kitchenClosedDates || []).join(','));
          setDeliveryTimeSlots((s.deliveryTimeSlots || []).join(','));
        })
        .catch(() => {});
      getAdminSubscriptions(adminKey).then(setSubscriptions).catch(() => setSubscriptions([]));
      getAdminUsers(adminKey).then(setUsers).catch(() => setUsers([]));
      getAdminOrders(adminKey).then(setOrders).catch(() => setOrders([]));
      getMenu().then(setMenuItems).catch(() => setMenuItems([]));
    }
  }, [unlocked, adminKey]);

  async function handleUnlock(e) {
    e.preventDefault();
    setUnlockError('');
    try {
      await verifyAdminKey(adminKey);
      sessionStorage.setItem(ADMIN_KEY_STORAGE, adminKey);
      setUnlocked(true);
    } catch (err) {
      setUnlockError(err.message);
    }
  }

  async function handleAddHoliday(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const holiday = await addHoliday({ date: newDate, name: newName }, adminKey);
      setHolidays((prev) => [...prev, holiday].sort((a, b) => a.date.localeCompare(b.date)));
      setNewDate('');
      setNewName('');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id) {
    try {
      await deleteHoliday(id, adminKey);
      setHolidays((prev) => prev.filter((h) => h.id !== id));
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleSaveSettings(e) {
    e.preventDefault();
    setSettingsError('');
    setSettingsSaved(false);
    setSavingSettings(true);
    try {
      await updateAdminSettings({
        subscriptionWorkingDays: Number(workingDays),
        announcement,
        orderingPaused,
        dailyOrderCapacity: Number(dailyOrderCapacity),
        orderCutoffTime,
        kitchenClosedDates: kitchenClosedDates.split(',').map((value) => value.trim()).filter(Boolean),
        deliveryTimeSlots: deliveryTimeSlots.split(',').map((value) => value.trim()).filter(Boolean)
      }, adminKey);
      setSettingsSaved(true);
    } catch (err) {
      setSettingsError(err.message);
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleSaveMenuItem(item) {
    setSavingMenuId(item.id);
    try {
      const updated = await updateAdminMenuItem(item.id, { available: item.available !== false, dailyStock: item.dailyStock ?? null }, adminKey);
      setMenuItems((prev) => prev.map((candidate) => candidate.id === updated.id ? updated : candidate));
    } catch (err) {
      setSettingsError(err.message);
    } finally {
      setSavingMenuId(null);
    }
  }

  function editValue(sub, field) {
    return subsEdits[sub.id]?.[field] ?? sub[field];
  }

  function setEditValue(subId, field, value) {
    setSubsEdits((prev) => ({ ...prev, [subId]: { ...prev[subId], [field]: value } }));
  }

  async function handleSaveSubscription(sub) {
    setSubsError('');
    setSavingSubId(sub.id);
    try {
      const updated = await updateAdminSubscription(
        sub.id,
        {
          startDate: editValue(sub, 'startDate'),
          workingDaysRequired: Number(editValue(sub, 'workingDaysRequired'))
        },
        adminKey
      );
      setSubscriptions((prev) => prev.map((s) => (s.id === sub.id ? { ...s, ...updated } : s)));
      setSubsEdits((prev) => {
        const next = { ...prev };
        delete next[sub.id];
        return next;
      });
    } catch (err) {
      setSubsError(err.message);
    } finally {
      setSavingSubId(null);
    }
  }

  async function handleApproveSubscription(sub) {
    setSubsError('');
    setApprovingSubId(sub.id);
    try {
      const updated = await approveAdminSubscription(sub.id, adminKey);
      setSubscriptions((prev) => prev.map((s) => (s.id === sub.id ? { ...s, ...updated } : s)));
    } catch (err) {
      setSubsError(err.message);
    } finally {
      setApprovingSubId(null);
    }
  }

  async function handleRemoveUser(user) {
    setUsersError('');
    setRemovingUserId(user.id);
    try {
      await deleteAdminUser(user.id, adminKey);
      setUsers((prev) => prev.filter((u) => u.id !== user.id));
    } catch (err) {
      setUsersError(err.message);
    } finally {
      setRemovingUserId(null);
    }
  }

  async function handleOrderStatus(order, status) {
    setOrdersError('');
    setUpdatingOrderId(order.id);
    try {
      const updated = await updateAdminOrderStatus(order.id, status, adminKey);
      setOrders((prev) => prev.map((item) => item.id === updated.id ? updated : item));
    } catch (err) {
      setOrdersError(err.message);
    } finally {
      setUpdatingOrderId(null);
    }
  }

  if (checking) return null;

  if (!unlocked) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <Link to="/" className="btn-link back-link">‹ Back to Menu</Link>
          <h2>Admin Access</h2>
          <form className="checkout-form" onSubmit={handleUnlock}>
            <label>
              Admin key
              <input
                type="password"
                value={adminKey}
                onChange={(e) => setAdminKey(e.target.value)}
                required
              />
            </label>
            {unlockError && <p className="status-text error">{unlockError}</p>}
            <button className="btn-primary" type="submit">Unlock</button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="events-page">
      <Link to="/" className="btn-link back-link">‹ Back to Menu</Link>
      <h2>Subscription Settings</h2>
      <form className="checkout-form" onSubmit={handleSaveSettings}>
        <label>
          Monthly subscription duration (working days, excludes Sundays &amp; kitchen-closed days)
          <input
            type="number"
            min={1}
            max={365}
            value={workingDays}
            onChange={(e) => {
              setWorkingDays(e.target.value);
              setSettingsSaved(false);
            }}
            required
          />
        </label>
        <label>
          Kitchen announcement
          <textarea rows={2} value={announcement} onChange={(e) => setAnnouncement(e.target.value)} placeholder="Optional notice shown on the menu" />
        </label>
        <label><input type="checkbox" checked={orderingPaused} onChange={(e) => setOrderingPaused(e.target.checked)} /> Pause ordering</label>
        <label>Daily order capacity<input type="number" min={1} value={dailyOrderCapacity} onChange={(e) => setDailyOrderCapacity(e.target.value)} /></label>
        <label>Same-day order cutoff (UTC)<input type="time" value={orderCutoffTime} onChange={(e) => setOrderCutoffTime(e.target.value)} /></label>
        <label>Kitchen closed dates<input value={kitchenClosedDates} onChange={(e) => setKitchenClosedDates(e.target.value)} placeholder="YYYY-MM-DD, YYYY-MM-DD" /></label>
        <label>Delivery slots<input value={deliveryTimeSlots} onChange={(e) => setDeliveryTimeSlots(e.target.value)} placeholder="11:00-13:00,18:00-20:00" /></label>
        {settingsError && <p className="status-text error">{settingsError}</p>}
        {settingsSaved && <p className="status-text">Saved.</p>}
        <button className="btn-primary" type="submit" disabled={savingSettings}>
          {savingSettings ? 'Saving…' : 'Save Setting'}
        </button>
      </form>

      <h2 style={{ marginTop: 32 }}>Menu Availability &amp; Stock</h2>
      <div className="cart-list">
        {menuItems.map((item) => (
          <div key={item.id} className="cart-row">
            <span className="cart-row-name">{item.name}</span>
            <label><input type="checkbox" checked={item.available !== false} onChange={(e) => setMenuItems((prev) => prev.map((candidate) => candidate.id === item.id ? { ...candidate, available: e.target.checked } : candidate))} /> Available</label>
            <input type="number" min={0} placeholder="Unlimited" value={item.dailyStock ?? ''} onChange={(e) => setMenuItems((prev) => prev.map((candidate) => candidate.id === item.id ? { ...candidate, dailyStock: e.target.value === '' ? null : Number(e.target.value) } : candidate))} />
            <button type="button" className="btn-add" onClick={() => handleSaveMenuItem(item)} disabled={savingMenuId === item.id}>{savingMenuId === item.id ? 'Saving…' : 'Save'}</button>
          </div>
        ))}
      </div>

      <h2 style={{ marginTop: 32 }}>Manage Holidays</h2>

      <form className="checkout-form" onSubmit={handleAddHoliday}>
        <label>
          Date
          <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} required />
        </label>
        <label>
          Holiday name
          <input value={newName} onChange={(e) => setNewName(e.target.value)} required />
        </label>
        {error && <p className="status-text error">{error}</p>}
        <button className="btn-primary" type="submit" disabled={submitting}>
          {submitting ? 'Adding…' : 'Add Holiday'}
        </button>
      </form>

      <div className="cart-list" style={{ marginTop: 20 }}>
        {holidays.length === 0 ? (
          <p className="status-text">No holidays added yet.</p>
        ) : (
          holidays.map((h) => (
            <div key={h.id} className="cart-row">
              <span className="cart-row-name">{h.date} — {h.name}</span>
              <button type="button" className="btn-remove" onClick={() => handleDelete(h.id)}>✕</button>
            </div>
          ))
        )}
      </div>

      <h2 style={{ marginTop: 32 }}>Monthly Subscriptions</h2>
      {subsError && <p className="status-text error">{subsError}</p>}
      {subscriptions.length === 0 ? (
        <p className="status-text">No subscriptions yet.</p>
      ) : (
        <div className="subscription-list">
          {subscriptions.map((sub) => (
            <div key={sub.id} className="subscription-card">
              <div className="subscription-card-header">
                <strong>{sub.customerName}</strong>
                <span>{sub.customerPhone}</span>
                <span
                  className={
                    !sub.approved
                      ? 'subscription-badge pending'
                      : sub.expiresToday
                        ? 'subscription-badge expiring'
                        : sub.expired
                          ? 'subscription-badge expired'
                          : 'subscription-badge active'
                  }
                >
                  {!sub.approved ? 'Pending approval' : sub.expiresToday ? 'Expires today' : sub.expired ? 'Expired' : 'Active'}
                </span>
              </div>
              <p className="subscription-item-name">{sub.itemName}</p>

              {!sub.approved && (
                <button
                  type="button"
                  className="btn-primary"
                  style={{ marginBottom: 10 }}
                  onClick={() => handleApproveSubscription(sub)}
                  disabled={approvingSubId === sub.id}
                >
                  {approvingSubId === sub.id ? 'Approving…' : 'Approve Subscription'}
                </button>
              )}

              <div className="subscription-edit-row">
                <label>
                  Start date
                  <input
                    type="date"
                    value={editValue(sub, 'startDate')}
                    onChange={(e) => setEditValue(sub.id, 'startDate', e.target.value)}
                  />
                </label>
                <label>
                  Working days
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={editValue(sub, 'workingDaysRequired')}
                    onChange={(e) => setEditValue(sub.id, 'workingDaysRequired', e.target.value)}
                  />
                </label>
                <div className="subscription-end-date">
                  <span>Ends</span>
                  <strong>{sub.endDate || '—'}</strong>
                </div>
                <button
                  type="button"
                  className="btn-add"
                  onClick={() => handleSaveSubscription(sub)}
                  disabled={savingSubId === sub.id}
                >
                  {savingSubId === sub.id ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <h2 style={{ marginTop: 32 }}>Order Dashboard</h2>
      {ordersError && <p className="status-text error">{ordersError}</p>}
      {orders.length === 0 ? (
        <p className="status-text">No orders yet.</p>
      ) : (
        <div className="subscription-list">
          {orders.map((order) => (
            <div key={order.id} className="subscription-card">
              <div className="subscription-card-header">
                <strong>#{order.orderNumber || order.id}</strong>
                <span>{order.customer.name} · {order.customer.phone}</span>
                <span className="subscription-badge active">{order.status.replaceAll('_', ' ')}</span>
              </div>
              <p className="subscription-item-name">{order.items.map((item) => `${item.name} × ${item.quantity}`).join(', ')}</p>
              <p className="subscription-summary-dates">₹{order.total} · Delivery: {order.scheduledDate} · {order.timeSlot}</p>
              <p className="subscription-summary-dates">{order.customer.address}</p>
              <div className="order-actions">
                {['paid', 'preparing'].includes(order.status) && <button type="button" className="btn-add" onClick={() => handleOrderStatus(order, 'preparing')} disabled={updatingOrderId === order.id}>Preparing</button>}
                {['preparing'].includes(order.status) && <button type="button" className="btn-add" onClick={() => handleOrderStatus(order, 'out_for_delivery')} disabled={updatingOrderId === order.id}>Out for delivery</button>}
                {['out_for_delivery'].includes(order.status) && <button type="button" className="btn-add" onClick={() => handleOrderStatus(order, 'delivered')} disabled={updatingOrderId === order.id}>Delivered</button>}
                {['refund_requested'].includes(order.status) && <button type="button" className="btn-add" onClick={() => handleOrderStatus(order, 'refunded')} disabled={updatingOrderId === order.id}>Mark refunded</button>}
              </div>
            </div>
          ))}
        </div>
      )}

      <h2 style={{ marginTop: 32 }}>Registered Users</h2>
      {usersError && <p className="status-text error">{usersError}</p>}
      {users.length === 0 ? (
        <p className="status-text">No registered users yet.</p>
      ) : (
        <div className="cart-list">
          {users.map((u) => (
            <div key={u.id} className="cart-row">
              <span className="cart-row-name">
                {u.name}
                <span className="cart-row-note">{u.phone}{u.address ? ` · ${u.address}` : ''}</span>
              </span>
              <button
                type="button"
                className="btn-remove"
                onClick={() => handleRemoveUser(u)}
                disabled={removingUserId === u.id}
              >
                {removingUserId === u.id ? 'Removing…' : '✕ Remove'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
