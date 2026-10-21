// Mirrors the server's reservesStock: an unpaid order holds its items for 30
// minutes, after which the server refuses payment for it.
export const PAYMENT_WINDOW_MS = 30 * 60 * 1000;
const URGENT_MS = 5 * 60 * 1000;

/// Milliseconds left to pay, or null when the order is not awaiting payment.
export function timeLeftToPay(order, now = Date.now()) {
  if (order?.status !== 'pending_payment') return null;
  const created = new Date(order.createdAt).getTime();
  if (Number.isNaN(created)) return null;
  return Math.max(0, created + PAYMENT_WINDOW_MS - now);
}

export function paymentWindowClosed(order, now = Date.now()) {
  return timeLeftToPay(order, now) === 0;
}

export function isPaymentUrgent(left) {
  return left != null && left < URGENT_MS;
}

/// "mm:ss", rounding up so the timer only reads 00:00 once time is really up.
export function formatCountdown(left) {
  const seconds = Math.ceil(Math.max(0, left) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
