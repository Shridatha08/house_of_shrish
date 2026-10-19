export function formatTime(hhmm) {
  const [h, m] = String(hhmm || '').split(':');
  const hour = Number.parseInt(h, 10);
  const minute = Number.parseInt(m, 10);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return hhmm;
  const suffix = hour < 12 ? 'am' : 'pm';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  const minutes = minute === 0 ? '' : `:${String(minute).padStart(2, '0')}`;
  return `${display}${minutes} ${suffix}`;
}

export function faqEntries(config) {
  const lunch = formatTime(config?.lunchCutoffTime || '11:00');
  const dinner = formatTime(config?.dinnerCutoffTime || '18:30');
  return [
    {
      question: 'By when do I need to order?',
      answer:
        `Lunch closes at ${lunch} and dinner closes at ${dinner}, both IST. ` +
        'Order after that and the kitchen has already started cooking, so the ' +
        'site will ask you to order for the next meal instead.'
    },
    {
      question: 'Can I skip a meal on my plan?',
      answer:
        `Yes. Cancel a lunch before ${lunch}, or a dinner before 6 pm, on the ` +
        'day itself. Once the cutoff passes that meal is locked in.'
    },
    {
      question: 'Do I lose a meal if I skip it?',
      answer:
        'No. A skipped meal is carried forward — your plan simply runs one ' +
        'delivery day longer, so you still get every meal you paid for.'
    },
    {
      question: 'What happens on a kitchen holiday?',
      answer:
        'We do not cook that day and nothing is delivered. Your plan is not ' +
        'charged for it: the day is added back at the end, and the date by ' +
        'which you must finish your meals moves out as well. Sundays work the ' +
        'same way and are never delivery days.'
    },
    {
      question: 'What if the kitchen cannot deliver my meal?',
      answer:
        'If something goes wrong on our side — a supply or equipment problem — ' +
        'we mark it as a kitchen issue. The meal goes straight back onto your ' +
        'plan, your end date moves out to make room for it, and we let you know ' +
        'so you are not left guessing.'
    },
    {
      question: 'How long do I have to finish my meals?',
      answer:
        'Carried-forward meals stay available for about a month past your ' +
        'original end date, and that window stretches further for every holiday ' +
        'and kitchen issue along the way.'
    }
  ];
}
