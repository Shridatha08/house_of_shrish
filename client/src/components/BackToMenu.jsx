import { Link } from 'react-router-dom';

export default function BackToMenu({ className = '' }) {
  return (
    <Link to="/" className={`back-to-menu${className ? ` ${className}` : ''}`}>
      <span className="back-to-menu-mark">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M1.8 11.9 10.8 2.9v5c3.6.15 6.5 1.35 8.5 3.6 2 2.25 3 5.25 3.1 9 .03 1.1-1.35 1.5-1.9.5-1.1-2-2.5-3.4-4.1-4.25-1.6-.85-3.5-1.3-5.6-1.35v5.5L1.8 11.9z" />
        </svg>
      </span>
      <span className="back-to-menu-text">
        <span className="back-to-menu-kicker">Back to</span>
        <span className="back-to-menu-label">Menu</span>
      </span>
    </Link>
  );
}
