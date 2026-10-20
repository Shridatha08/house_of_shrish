export const FEEDBACK_TYPES = [
  { value: 'suggestion', label: 'Suggestion', hint: 'Something we could do better' },
  { value: 'praise', label: 'Praise', hint: 'Something you liked' },
  { value: 'complaint', label: 'Complaint', hint: 'Something went wrong' }
];

export const MAX_FEEDBACK_LENGTH = 2000;
const MIN_FEEDBACK_LENGTH = 4;

export function feedbackTypeLabel(value) {
  return FEEDBACK_TYPES.find((entry) => entry.value === value)?.label || value;
}

// Mirrors the server's rules so the button explains itself before a round trip.
export function feedbackError({ type, message }) {
  if (!FEEDBACK_TYPES.some((entry) => entry.value === type)) {
    return 'Pick suggestion, praise or complaint.';
  }
  const text = String(message || '').trim();
  if (text.length < MIN_FEEDBACK_LENGTH) return 'Please tell us a little more.';
  if (text.length > MAX_FEEDBACK_LENGTH) return `Please keep it under ${MAX_FEEDBACK_LENGTH} characters.`;
  return '';
}

export function thanksFor(type) {
  if (type === 'complaint') return 'Thank you — we have passed this to the kitchen and will look into it.';
  if (type === 'praise') return 'Thank you — the kitchen will love reading this.';
  return 'Thank you — every suggestion gets read.';
}
