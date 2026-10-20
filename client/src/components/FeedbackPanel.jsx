import { useEffect, useState } from 'react';
import { sendFeedback, getMyFeedback } from '../api';
import { FEEDBACK_TYPES, MAX_FEEDBACK_LENGTH, feedbackError, feedbackTypeLabel, thanksFor } from '../feedback';

export default function FeedbackPanel({ token }) {
  const [type, setType] = useState('suggestion');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [thanks, setThanks] = useState('');
  const [history, setHistory] = useState([]);

  useEffect(() => {
    let cancelled = false;
    getMyFeedback(token).then((data) => { if (!cancelled) setHistory(data); }).catch(() => {});
    return () => { cancelled = true; };
  }, [token]);

  async function submit(event) {
    event.preventDefault();
    const invalid = feedbackError({ type, message });
    if (invalid) { setError(invalid); return; }
    setError('');
    setThanks('');
    setSending(true);
    try {
      const saved = await sendFeedback({ type, message: message.trim() }, token);
      setHistory((previous) => [saved, ...previous]);
      setMessage('');
      setThanks(thanksFor(saved.type));
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="feedback-panel" onSubmit={submit}>
      <p className="feedback-question">What&apos;s on your mind?</p>
      <div className="feedback-types">
        {FEEDBACK_TYPES.map((entry) => (
          <button
            key={entry.value}
            type="button"
            className={`feedback-type${type === entry.value ? ' selected' : ''}`}
            aria-pressed={type === entry.value}
            onClick={() => setType(entry.value)}
          >
            <span className="feedback-type-label">{entry.label}</span>
            <span className="feedback-type-hint">{entry.hint}</span>
          </button>
        ))}
      </div>

      <textarea
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        maxLength={MAX_FEEDBACK_LENGTH}
        rows={4}
        placeholder="Share your thoughts, ideas or concerns…"
      />
      <div className="feedback-foot">
        <span className="feedback-count">{message.trim().length}/{MAX_FEEDBACK_LENGTH}</span>
        <button className="btn-primary" type="submit" disabled={sending}>
          {sending ? 'Sending…' : 'Submit feedback'}
        </button>
      </div>

      {error && <p className="status-text error">{error}</p>}
      {thanks && <p className="status-text">{thanks}</p>}

      {history.length > 0 && (
        <>
          <h4 className="feedback-history-heading">What you&apos;ve sent</h4>
          <ul className="feedback-history">
            {history.map((entry) => (
              <li key={entry.id} className={`feedback-entry ${entry.type}`}>
                <div className="feedback-entry-head">
                  <span className={`meal-status-pill ${entry.type}`}>{feedbackTypeLabel(entry.type)}</span>
                  <span className="feedback-entry-date">{new Date(entry.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>
                </div>
                <p>{entry.message}</p>
                {entry.handled && <span className="feedback-handled">Reviewed by the kitchen</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </form>
  );
}
