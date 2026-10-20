import { Link } from 'react-router-dom';
import Icon from './Icon';
// The full crest is unreadable at this size, so this is just its emblem.
import emblem from '../assets/emblem.png';

export default function BackToMenu({ className = '' }) {
  return (
    <Link to="/" className={`back-to-menu${className ? ` ${className}` : ''}`}>
      <span className="back-to-menu-mark">
        <img src={emblem} alt="" />
        <span className="back-to-menu-arrow"><Icon name="arrowLeft" size={15} /></span>
      </span>
      <span className="back-to-menu-text">
        <span className="back-to-menu-kicker">Back to</span>
        <span className="back-to-menu-label">Our Menu</span>
      </span>
    </Link>
  );
}
