import { useState } from 'react';
import { referralMessage } from '../wallet';

export default function ReferralCard({ code, balance = 0 }) {
  const [copied, setCopied] = useState(false);

  if (!code) {
    return <p className="status-text">Your referral code will appear here shortly.</p>;
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  const share = `https://wa.me/?text=${encodeURIComponent(referralMessage(code))}`;

  return (
    <div className="referral-card">
      <strong>Give ₹50, Get ₹50</strong>
      <p className="status-text">
        Share your code with friends and family. When they place their first
        order, you both get ₹50 towards your next one.
      </p>
      {balance > 0 && (
        <p className="status-text">You have ₹{balance} waiting in your wallet.</p>
      )}
      <div className="referral-code">{code}</div>
      <div className="referral-actions">
        <button type="button" className="btn-link" onClick={copy}>
          {copied ? 'Copied' : 'Copy code'}
        </button>
        <a className="btn-primary" href={share} target="_blank" rel="noreferrer">
          Share on WhatsApp
        </a>
      </div>
    </div>
  );
}
