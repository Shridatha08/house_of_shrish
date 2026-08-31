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
  updateAdminSubscription
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

  const [subscriptions, setSubscriptions] = useState([]);
  const [subsEdits, setSubsEdits] = useState({}); // { [id]: { startDate, workingDaysRequired } }
  const [subsError, setSubsError] = useState('');
  const [savingSubId, setSavingSubId] = useState(null);

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
        .then((s) => setWorkingDays(String(s.subscriptionWorkingDays)))
        .catch(() => {});
      getAdminSubscriptions(adminKey).then(setSubscriptions).catch(() => setSubscriptions([]));
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
      await updateAdminSettings({ subscriptionWorkingDays: Number(workingDays) }, adminKey);
      setSettingsSaved(true);
    } catch (err) {
      setSettingsError(err.message);
    } finally {
      setSavingSettings(false);
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
        {settingsError && <p className="status-text error">{settingsError}</p>}
        {settingsSaved && <p className="status-text">Saved.</p>}
        <button className="btn-primary" type="submit" disabled={savingSettings}>
          {savingSettings ? 'Saving…' : 'Save Setting'}
        </button>
      </form>

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
                    sub.expiresToday ? 'subscription-badge expiring' : sub.expired ? 'subscription-badge expired' : 'subscription-badge active'
                  }
                >
                  {sub.expiresToday ? 'Expires today' : sub.expired ? 'Expired' : 'Active'}
                </span>
              </div>
              <p className="subscription-item-name">{sub.itemName}</p>

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
    </div>
  );
}
