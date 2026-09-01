import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { markOrderPaid } from '../api';
import { useCart } from '../context/CartContext';

export default function Payment() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { clearCart } = useCart();
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');

  const { order, upiUri } = location.state || {};

  if (!order || !upiUri) {
    return (
      <div className="payment-page">
        <Link to="/" className="btn-link back-link">‹ Back to Menu</Link>
        <p className="status-text error">
          No order details found. Please place your order again.
        </p>
      </div>
    );
  }

  async function handleConfirmPaid() {
    try {
      await markOrderPaid(id);
      setConfirmed(true);
      clearCart();
    } catch (err) {
      setError(err.message);
    }
  }

  if (confirmed) {
    return (
      <div className="payment-page">
        <div className="success-card">
          <h2>🎉 Order confirmed!</h2>
          <p>Order #{order.orderNumber || order.id} for ₹{order.total} has been placed.</p>
          <Link to={`/invoice/${order.id}`} className="btn-link">View Invoice</Link>
          <button className="btn-primary" onClick={() => navigate('/')}>Back to menu</button>
        </div>
      </div>
    );
  }

  return (
    <div className="payment-page">
      <Link to="/checkout" className="btn-link back-link">‹ Back to Checkout</Link>
      <h2>Scan &amp; Pay</h2>
      <p className="status-text">Order #{order.orderNumber || order.id} · Amount ₹{order.total}</p>
      <div className="qr-card">
        <QRCodeSVG value={upiUri} size={220} marginSize={2} />
        <p className="upi-id">Pay to: House of Shrish (houseofshrish@ybl)</p>
      </div>
      <p className="map-hint">Scan this QR with any UPI app (GPay, PhonePe, Paytm) to pay ₹{order.total}.</p>
      {error && <p className="status-text error">{error}</p>}
      <button className="btn-primary" onClick={handleConfirmPaid}>I've completed the payment</button>
    </div>
  );
}
