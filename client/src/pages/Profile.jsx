import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { updateProfile } from '../api';

export default function Profile() {
  const { user, token, ready, updateUser } = useAuth();

  const [name, setName] = useState(user?.name || '');
  const [phone, setPhone] = useState(user?.phone || '');
  const [address, setAddress] = useState(user?.address || '');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

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
      </div>
    </div>
  );
}
