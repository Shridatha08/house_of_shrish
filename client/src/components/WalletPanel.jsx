import { entryLabel } from '../wallet';

function formatWhen(iso) {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '';
  return when.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit'
  });
}

export default function WalletPanel({ wallet }) {
  const { balance = 0, reward = 50, entries = [] } = wallet || {};

  return (
    <div className="wallet-panel">
      <div className="wallet-balance">
        <span className="wallet-balance-label">Available balance</span>
        <strong className="wallet-balance-amount">₹{balance}</strong>
        <span className="wallet-balance-note">
          Applied at checkout when you choose to use it.
        </span>
      </div>

      {entries.length === 0 ? (
        <p className="status-text">
          No wallet activity yet. Share your referral code to earn ₹{reward}.
        </p>
      ) : (
        <>
          <h3 className="wallet-heading">Recent activity</h3>
          <ul className="wallet-entries">
            {entries.map((entry) => {
              const credit = entry.amount > 0;
              return (
                <li key={entry.id} className="wallet-entry">
                  <span className="wallet-entry-detail">
                    <span>{entryLabel(entry.reason)}</span>
                    <small>{formatWhen(entry.createdAt)}</small>
                  </span>
                  <span className={credit ? 'wallet-credit' : 'wallet-debit'}>
                    {credit ? '+' : '−'}₹{Math.abs(entry.amount)}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
