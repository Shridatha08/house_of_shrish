import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { completePasswordReset, requestPasswordReset } from '../api';

export default function Login() {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTo = new URLSearchParams(location.search).get('redirect') || '/';

  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [forgotPassword, setForgotPassword] = useState(false);
  const [resetRequested, setResetRequested] = useState(false);
  const [resetPhone, setResetPhone] = useState('');
  const [resetKey, setResetKey] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [notice, setNotice] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (mode === 'register' && password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      if (mode === 'register') {
        await register({ name, phone, password, address });
      } else {
        await login({ phone, password });
      }
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRequestReset(e) {
    e.preventDefault();
    setError('');
    setNotice('');
    setSubmitting(true);
    try {
      await requestPasswordReset(resetPhone);
      setResetRequested(true);
      setNotice('If an account exists for that number, a reset request has been sent to the admin. Contact the admin for your unique reset key.');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResetPassword(e) {
    e.preventDefault();
    setError('');
    if (newPassword !== confirmNewPassword) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      await completePasswordReset({ phone: resetPhone, resetKey, password: newPassword });
      setForgotPassword(false);
      setResetRequested(false);
      setResetPhone('');
      setResetKey('');
      setNewPassword('');
      setConfirmNewPassword('');
      setPassword('');
      setNotice('Password reset. Log in with your new password.');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  function showForgotPassword() {
    setForgotPassword(true);
    setResetPhone(phone);
    setResetRequested(false);
    setNotice('');
    setError('');
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <Link to="/" className="btn-link back-link">‹ Back to Menu</Link>
        {forgotPassword ? (
          <>
            <h2>Reset password</h2>
            <p className="auth-help-text">Request a reset key using your registered phone number. The admin will share a unique key with you.</p>
            <form className="checkout-form" onSubmit={handleRequestReset}>
              <label>
                Registered phone number
                <input value={resetPhone} onChange={(e) => setResetPhone(e.target.value)} maxLength={10} inputMode="numeric" placeholder="10-digit mobile number" required />
              </label>
              <button className="btn-primary" type="submit" disabled={submitting}>
                {submitting ? 'Please wait…' : 'Request reset key'}
              </button>
            </form>
            {resetRequested && (
              <form className="checkout-form" onSubmit={handleResetPassword}>
                <label>
                  Unique reset key
                  <input value={resetKey} onChange={(e) => setResetKey(e.target.value)} autoComplete="one-time-code" required />
                </label>
                <label>
                  New password
                  <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={6} required />
                </label>
                <label>
                  Confirm new password
                  <input type="password" value={confirmNewPassword} onChange={(e) => setConfirmNewPassword(e.target.value)} minLength={6} required />
                </label>
                <button className="btn-primary" type="submit" disabled={submitting}>
                  {submitting ? 'Please wait...' : 'Set new password'}
                </button>
              </form>
            )}
            {notice && <p className="status-text">{notice}</p>}
            {error && <p className="status-text error">{error}</p>}
            <button className="btn-link forgot-password-link" type="button" onClick={() => { setForgotPassword(false); setResetRequested(false); setError(''); }}>
              Back to login
            </button>
          </>
        ) : <>
        <div className="auth-tabs">
          <button
            type="button"
            className={mode === 'login' ? 'auth-tab active' : 'auth-tab'}
            onClick={() => setMode('login')}
          >
            Log In
          </button>
          <button
            type="button"
            className={mode === 'register' ? 'auth-tab active' : 'auth-tab'}
            onClick={() => setMode('register')}
          >
            Register
          </button>
        </div>

        <form className="checkout-form" onSubmit={handleSubmit}>
          {mode === 'register' && (
            <label>
              Full name
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
          )}
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
          {mode === 'register' && (
            <label>
              Delivery address
              <textarea value={address} onChange={(e) => setAddress(e.target.value)} rows={3} required />
            </label>
          )}
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={6}
              required
            />
          </label>
          {mode === 'register' && (
            <label>
              Confirm password
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                minLength={6}
                required
              />
            </label>
          )}

          {error && <p className="status-text error">{error}</p>}
          {notice && <p className="status-text">{notice}</p>}

          {mode === 'login' && (
            <button className="btn-link forgot-password-link" type="button" onClick={showForgotPassword}>
              Forgot Password?
            </button>
          )}

          <button className="btn-primary" type="submit" disabled={submitting}>
            {submitting ? 'Please wait…' : mode === 'register' ? 'Create account' : 'Log In'}
          </button>
        </form>
        </>}
      </div>
    </div>
  );
}
