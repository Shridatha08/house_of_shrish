import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useCart } from '../context/CartContext';
import { useAuth } from '../context/AuthContext';
import { placeOrder } from '../api';
import LocationPicker from '../components/LocationPicker';

export default function Checkout() {
  const { items, decreaseItem, addItem, removeItem, total } = useCart();
  const { user, token } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [position, setPosition] = useState(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const requiresAccount = items.some((i) => i.name.toLowerCase().startsWith('monthly'));
  const blockedByAuth = requiresAccount && !user;

  // Prefill delivery details from the saved profile for logged-in users.
  useEffect(() => {
    if (user) {
      setName(user.name);
      setPhone(user.phone);
      setAddress(user.address || '');
    }
  }, [user]);

  function useMyLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setError('Could not access your location. Please pick it on the map instead.')
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (items.length === 0) {
      setError('Your cart is empty.');
      return;
    }
    if (blockedByAuth) {
      setError('Please sign up or log in to order Monthly packages.');
      return;
    }
    if (!/^\d{10}$/.test(phone.trim())) {
      setError('Enter a valid 10-digit phone number.');
      return;
    }
    if (!address.trim()) {
      setError('Please enter your delivery address.');
      return;
    }

    setSubmitting(true);
    try {
      const { order, upiUri } = await placeOrder(
        {
          items: items.map((i) => ({ id: i.id, quantity: i.quantity, customisation: i.customisation })),
          customer: {
            name,
            phone,
            address,
            lat: position?.lat ?? null,
            lng: position?.lng ?? null
          }
        },
        token
      );
      navigate(`/payment/${order.id}`, { state: { order, upiUri } });
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="checkout-page">
      <Link to="/" className="btn-link back-link">‹ Back to Menu</Link>
      <h2>Your Cart</h2>
      {items.length === 0 ? (
        <p className="status-text">Your cart is empty.</p>
      ) : (
        <div className="cart-list">
          {items.map((item) => (
            <div key={item.key} className="cart-row">
              <span className="cart-row-name">
                {item.name}
                {item.customisation && <span className="cart-row-note">{item.customisation}</span>}
              </span>
              <div className="qty-control">
                <button type="button" onClick={() => decreaseItem(item.key)}>−</button>
                <span>{item.quantity}</span>
                <button type="button" onClick={() => addItem(item, item.customisation)}>+</button>
              </div>
              <span className="cart-row-price">₹{item.price * item.quantity}</span>
              <button type="button" className="btn-remove" onClick={() => removeItem(item.key)}>✕</button>
            </div>
          ))}
          <div className="cart-total-row">
            <strong>Total</strong>
            <strong>₹{total}</strong>
          </div>
        </div>
      )}

      <h2>Delivery Details</h2>
      {blockedByAuth && (
        <p className="auth-required-notice">
          Monthly packages require an account. <Link to="/login?redirect=/checkout">Sign up or log in</Link> to continue.
        </p>
      )}
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
            placeholder="10-digit mobile number"
            required
          />
        </label>
        <label>
          Delivery address
          <textarea value={address} onChange={(e) => setAddress(e.target.value)} rows={3} required />
        </label>

        <div className="location-section">
          <div className="location-header">
            <span>Pin your location</span>
            <button type="button" className="btn-link" onClick={useMyLocation}>Use my current location</button>
          </div>
          <LocationPicker
            position={position}
            onChange={setPosition}
            onAddressResolved={(resolvedAddress) => setAddress(resolvedAddress)}
          />
        </div>

        {error && <p className="status-text error">{error}</p>}

        <button className="btn-primary" type="submit" disabled={submitting || items.length === 0 || blockedByAuth}>
          {submitting ? 'Placing order…' : `Place order · ₹${total}`}
        </button>
      </form>
    </div>
  );
}
