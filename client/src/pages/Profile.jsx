import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { updateProfile, getMySubscriptions, getMyOrders, cancelOrder, requestRefund } from '../api';

export default function Profile() {
  const { user, token, ready, updateUser } = useAuth();

  const [name, setName] = useState(user?.name || '');
  const [phone, setPhone] = useState(user?.phone || '');
  const [address, setAddress] = useState(user?.address || '');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [subscriptions, setSubscriptions] = useState([]);
  const [orders, setOrders] = useState([]);
  const [orderError, setOrderError] = useState('');
  const [updatingOrderId, setUpdatingOrderId] = useState(null);

  useEffect(() => {
    if (user) {
      getMySubscriptions(token).then(setSubscriptions).catch(() => setSubscriptions([]));
      getMyOrders(token).then(setOrders).catch(() => setOrders([]));
    }
  }, [user, token]);

  async function handleCancelOrder(order) {
    setOrderError('');
    setUpdatingOrderId(order.id);
    try {
      const updated = await cancelOrder(order.id, token);
      setOrders((prev) => prev.map((item) => item.id === updated.id ? updated : item));
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
    } catch (err) {
      setOrderError(err.message);
    } finally {
      setUpdatingOrderId(null);
    }
  }

  if (ready && !user) {
    return <Navigate to="/login?redirect=/profile" replace />;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSaved(false);
    setSubmitting(true);
    try {
      const { user: updated } = await updateProfile({ name, phone, address }, token);
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
      <div className="auth-card">
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
            Delivery address
            <textarea value={address} onChange={(e) => setAddress(e.target.value)} rows={3} required />
          </label>

          {error && <p className="status-text error">{error}</p>}
          {saved && <p className="status-text">Profile updated.</p>}

          <button className="btn-primary" type="submit" disabled={submitting}>
            {submitting ? 'Saving…' : 'Save Changes'}
          </button>
        </form>

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
                {!sub.expired && (
                  <p className="subscription-days-remaining">
                    {sub.daysRemaining === 0 ? 'Ends today' : `${sub.daysRemaining} day${sub.daysRemaining === 1 ? '' : 's'} remaining`}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="profile-subscriptions">
          <h2>My Orders</h2>
          {orderError && <p className="status-text error">{orderError}</p>}
          {orders.length === 0 ? <p className="status-text">No orders yet.</p> : orders.map((order) => (
            <div key={order.id} className="subscription-summary-card">
              <div className="subscription-summary-header">
                <strong>#{order.orderNumber || order.id}</strong>
                <span className={`subscription-badge ${order.status === 'delivered' ? 'active' : order.status === 'cancelled' || order.status === 'refunded' ? 'expired' : order.status === 'refund_requested' ? 'pending' : 'expiring'}`}>{order.status.replaceAll('_', ' ')}</span>
              </div>
              <p className="subscription-summary-dates">
                {order.scheduledDate} · {order.timeSlot} · ₹{order.total}
              </p>
              <p className="subscription-summary-dates">Payment / delivery status: {order.status.replaceAll('_', ' ')}</p>
              <p className="subscription-summary-dates">{order.items.map((item) => `${item.name} × ${item.quantity}`).join(', ')}</p>
              <div className="order-actions">
                {order.status !== 'pending_payment' && <Link to={`/invoice/${order.id}`} className="btn-link">View invoice</Link>}
                {['pending_payment', 'paid'].includes(order.status) && (
                  <button type="button" className="btn-add" onClick={() => handleCancelOrder(order)} disabled={updatingOrderId === order.id}>Cancel order</button>
                )}
                {['paid', 'cancelled'].includes(order.status) && (
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
