import { faqEntries } from '../faq';

export default function FaqPanel({ config }) {
  return (
    <div className="faq-panel">
      {faqEntries(config).map((entry) => (
        <details key={entry.question} className="faq-item">
          <summary>{entry.question}</summary>
          <p>{entry.answer}</p>
        </details>
      ))}
    </div>
  );
}
