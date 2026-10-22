/// Mirrors the Flutter app's walletSplit so both clients agree on what the
/// customer is shown before the server does the same arithmetic.
export function walletSplit({ total, balance, useWallet }) {
  const available = balance <= 0 ? 0 : Math.min(balance, total);
  return {
    credit: available,
    // In paise, so a GST total like 313.96 minus credit never shows float noise.
    payable: useWallet ? (Math.round(total * 100) - Math.round(available * 100)) / 100 : total
  };
}

const LABELS = {
  referral_reward: 'Friend used your code',
  referral_joined: 'Joined with a referral code',
  order_payment: 'Used on an order',
  order_cancelled: 'Order cancelled, credit returned',
  admin_adjustment: 'Adjusted by House of Shrish'
};

export function entryLabel(reason) {
  return LABELS[reason] || String(reason || '').replace(/_/g, ' ');
}

export function referralMessage(code) {
  return (
    'Give ₹50, Get ₹50! 💸 Share the taste of House of Shrish’s home-cooked ' +
    'meals with your friends and family. Ask them to enter your referral code ' +
    `${code} when they sign up — once their first order is confirmed, you both ` +
    'get ₹50 in your wallet, redeemable on your next order! 🍛'
  );
}
