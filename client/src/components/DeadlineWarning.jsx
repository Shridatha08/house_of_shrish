import { deadlineMessage, deadlineRisk, RISK } from '../deadline';

export default function DeadlineWarning({ subscription, today = new Date() }) {
  const message = deadlineMessage(subscription, today);
  if (!message) return null;
  const severe = deadlineRisk(subscription, today) === RISK.overflowing;
  return (
    <p className={severe ? 'deadline-warning severe' : 'deadline-warning'}>
      {message}
    </p>
  );
}
