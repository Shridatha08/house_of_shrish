/// Stroke icons drawn from primitives so they stay crisp at any size and
/// follow the surrounding text colour. The app uses Flutter's built-in
/// Material set, which has no asset equivalent on the web.
const PATHS = {
  details: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.6 3.1-5.5 7-5.5s7 1.9 7 5.5" />
    </>
  ),
  plan: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" />
      <path d="M8.5 14.5h3.5M12 14.5l-1.5-1.5M12 14.5l-1.5 1.5" />
    </>
  ),
  orders: (
    <>
      <path d="M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z" />
      <path d="M9 8h6M9 11.5h6M9 15h3.5" />
    </>
  ),
  wallet: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="2.5" />
      <path d="M3 10h18" />
      <circle cx="16.5" cy="14.5" r="1.3" />
    </>
  ),
  referral: (
    <>
      <rect x="3.5" y="9" width="17" height="11.5" rx="2" />
      <path d="M3.5 13h17M12 9v11.5" />
      <path d="M12 9S9.5 4 7.5 5.2 9.5 9 12 9zM12 9s2.5-5 4.5-3.8S14.5 9 12 9z" />
    </>
  ),
  faq: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.6 9.5a2.5 2.5 0 1 1 3.2 2.9c-.6.2-.9.7-.9 1.3v.4" />
      <path d="M12 17.2h.01" />
    </>
  ),
  account: (
    <>
      <path d="M14.5 4.5h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3" />
      <path d="M10 8.5 6 12l4 3.5M6 12h8.5" />
    </>
  ),
};

export default function Icon({ name, size = 20, className = '' }) {
  const paths = PATHS[name];
  if (!paths) return null;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths}
    </svg>
  );
}
