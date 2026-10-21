import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import BackToMenu from '../components/BackToMenu';
import Icon from '../components/Icon';
import whatsappIcon from '../../../whatsapp.png';
import { QRCodeSVG } from 'qrcode.react';
import { getOrder, getStoreConfig, markOrderPaid, startOnlinePayment } from '../api';
import { useCart } from '../context/CartContext';
import { useAuth } from '../context/AuthContext';
import { formatCountdown, isPaymentUrgent, paymentWindowClosed, timeLeftToPay } from '../paymentWindow';

const WHATSAPP_LINK = 'https://wa.me/919180381854';

export default function Payment() {
  const { id } = useParams();
  const location = useLocation();
  const { clearCart } = useCart();
  const { token, ready } = useAuth();
  const accessToken = location.state?.accessToken || sessionStorage.getItem(`orderAccess:${id}`);
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const [onlinePayment, setOnlinePayment] = useState(false);
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    getStoreConfig().then((config) => setOnlinePayment(Boolean(config.onlinePayment))).catch(() => {});
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    if (accessToken) sessionStorage.setItem(`orderAccess:${id}`, accessToken);
    getOrder(id, token, accessToken)
      .then((result) => { if (!cancelled) setOrder(result); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id, token, ready, accessToken, refreshKey]);

  // After the gateway sends the customer back, its webhook may land a moment
  // later, so keep checking quietly until the order moves on.
  const awaitingGateway = order?.youpi?.paymentIds?.length > 0 && timeLeftToPay(order, clock) > 0;
  useEffect(() => {
    if (!awaitingGateway) return;
    const timer = setInterval(() => {
      getOrder(id, token, accessToken).then(setOrder).catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [awaitingGateway, id, token, accessToken]);

  async function handleConfirmPaid() {
    setSubmitting(true);
    setError('');
    try {
      const updated = await markOrderPaid(id, token, accessToken);
      setOrder((previous) => ({ ...previous, ...updated }));
      clearCart();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePayOnline() {
    setRedirecting(true);
    setError('');
    try {
      const { checkoutUrl } = await startOnlinePayment(id, token, accessToken);
      clearCart();
      // The gateway returns the customer to this page once the payment settles.
      window.location.assign(checkoutUrl);
    } catch (err) {
      setError(err.message);
      setRedirecting(false);
    }
  }

  if (!ready || loading) return <p className="status-text">Loading order...</p>;
  if (!order) return <div className="payment-page"><p className="status-text error">{error || 'Order not found.'}</p><Link to="/" className="btn-link">Back to menu</Link></div>;
  const expired = paymentWindowClosed(order, clock);
  const left = timeLeftToPay(order, clock);
  const orderLabel = `#${order.orderNumber || order.id}`;
  const paid = order.paymentStatus === 'verified' || (!order.paymentStatus && ['paid', 'preparing', 'out_for_delivery', 'delivered', 'refunded'].includes(order.status));

  return (
    <div className="payment-page">
      <BackToMenu />
      <h2>{expired ? 'Payment window closed' : order.status === 'pending_payment' ? 'Scan & Pay' : order.status === 'payment_review' ? 'Payment awaiting verification' : 'Order status'}</h2>
      <p className="status-text">Order {orderLabel} · Amount ₹{order.total}</p>
      {left > 0 && (
        <p className={`pay-countdown${isPaymentUrgent(left) ? ' urgent' : ''}`} role="timer">
          <Icon name="timer" size={16} />
          Pay within {formatCountdown(left)} to keep this order
        </p>
      )}
      {order.walletApplied > 0 && (
        <p className="status-text">₹{order.walletApplied} of ₹{order.subtotal} covered by your wallet.</p>
      )}
      {expired ? (
        <div className="expired-card">
          <p>
            Order {orderLabel} was not paid within 30 minutes, so it no longer holds your items. Please order again.
          </p>
          <p>If you have already paid, send the payment screenshot on WhatsApp and the admin will sort it out.</p>
          <a
            className="btn-whatsapp"
            href={`${WHATSAPP_LINK}?text=${encodeURIComponent(`Payment proof for order ${orderLabel}`)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <img src={whatsappIcon} alt="" className="contact-icon" />
            Contact us on WhatsApp
          </a>
          <Link to="/" className="btn-primary pay-wide btn-as-link">Back to menu</Link>
        </div>
      ) : order.status === 'pending_payment' ? (
        <>
          {onlinePayment && (
            <button className="btn-primary pay-wide" type="button" disabled={redirecting} onClick={handlePayOnline}>
              {redirecting ? 'Opening secure checkout...' : `Pay ₹${order.total} online (auto-verified)`}
            </button>
          )}
          {/* Opens GPay, PhonePe, Paytm etc. on phones; desktops fall back to the QR. */}
          <a className={`btn-upi-app${onlinePayment ? ' secondary' : ''}`} href={order.upiUri}>
            Pay ₹{order.total} with a UPI app
          </a>
          <p className="pay-divider">or scan</p>
          <div className="qr-card">
            <QRCodeSVG value={order.upiUri} size={220} marginSize={2} />
            <p className="upi-id">Pay to: House of Shrish (houseofshrish@ybl)</p>
          </div>
          <button className="btn-primary" type="button" disabled={submitting} onClick={handleConfirmPaid}>
            {submitting ? 'Submitting...' : "I've completed the payment"}
          </button>
        </>
      ) : (
        <>
          <p className="status-text">{order.status.replaceAll('_', ' ')}</p>
          {order.status === 'payment_review' && order.youpi?.utr && <p className="status-text">UPI payment detected (UTR {order.youpi.utr}). The admin will confirm it shortly.</p>}
          {order.status === 'payment_review' && !order.youpi?.utr && <p className="status-text">Payment will be verified by the admin. <a href={`${WHATSAPP_LINK}?text=${encodeURIComponent(`Payment proof for order #${order.orderNumber || order.id}`)}`} target="_blank" rel="noopener noreferrer">Share payment proof</a></p>}
          {paid && <Link to={`/invoice/${id}`} state={{ accessToken }} className="btn-link">View Invoice</Link>}
        </>
      )}
      {error && <p className="status-text error">{error}</p>}
      {!expired && <button type="button" className="btn-add" onClick={() => setRefreshKey((value) => value + 1)}>Refresh status</button>}
    </div>
  );
}

