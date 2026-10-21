import test from 'node:test';
import assert from 'node:assert/strict';

import { walletSplit, entryLabel, referralMessage } from '../src/wallet.js';
import { faqEntries, formatTime } from '../src/faq.js';
import { deadlineMessage, deadlineRisk, daysUntilDeadline, etaText, RISK } from '../src/deadline.js';
import { statusOf, skipAvailability, scheduleByDate, upcomingTotals, planSummary, formatMealDate, withinDays } from '../src/schedule.js';
import { feedbackError, thanksFor } from '../src/feedback.js';
import { formatCountdown, isPaymentUrgent, orderStatusText, paymentWindowClosed, timeLeftToPay, PAYMENT_WINDOW_MS } from '../src/paymentWindow.js';

const subWith = (overrides = {}) => ({
  carryForwardDeadline: '2026-11-20',
  mealsBeyondDeadline: 0,
  remainingMeals: 4,
  expired: false,
  ...overrides
});

const today = new Date(Date.UTC(2026, 10, 15));

test('wallet credit never exceeds the bill', () => {
  assert.deepEqual(walletSplit({ total: 100, balance: 250, useWallet: true }), { credit: 100, payable: 0 });
});

test('a partial balance leaves the rest to pay', () => {
  assert.deepEqual(walletSplit({ total: 299, balance: 50, useWallet: true }), { credit: 50, payable: 249 });
});

test('declining the wallet charges the full total', () => {
  assert.deepEqual(walletSplit({ total: 299, balance: 50, useWallet: false }), { credit: 50, payable: 299 });
});

test('an empty wallet cannot discount anything', () => {
  assert.deepEqual(walletSplit({ total: 299, balance: 0, useWallet: true }), { credit: 0, payable: 299 });
});

test('ledger reasons read as plain English', () => {
  assert.equal(entryLabel('referral_reward'), 'Friend used your code');
  assert.equal(entryLabel('order_payment'), 'Used on an order');
  assert.equal(entryLabel('something_new'), 'something new');
});

test('the share message carries the code', () => {
  assert.ok(referralMessage('ESHWAR9747').includes('ESHWAR9747'));
});

test('cutoff times read the way customers say them', () => {
  assert.equal(formatTime('11:00'), '11 am');
  assert.equal(formatTime('18:30'), '6:30 pm');
  assert.equal(formatTime('12:00'), '12 pm');
  assert.equal(formatTime('00:30'), '12:30 am');
  assert.equal(formatTime('later'), 'later');
});

test('the FAQ quotes the kitchen configured cutoffs', () => {
  const answers = faqEntries({ lunchCutoffTime: '10:00', dinnerCutoffTime: '17:30' })
    .map((entry) => entry.answer)
    .join(' ');
  assert.ok(answers.includes('10 am'));
  assert.ok(answers.includes('5:30 pm'));
  assert.ok(!answers.includes('11 am'));
});

test('the FAQ covers every topic the kitchen is asked about', () => {
  const text = faqEntries({}).map((e) => `${e.question} ${e.answer}`).join(' ').toLowerCase();
  for (const topic of ['carried forward', 'holiday', 'kitchen issue', 'closes at']) {
    assert.ok(text.includes(topic), `missing ${topic}`);
  }
});

test('a far-off deadline is not worth nagging about', () => {
  assert.equal(deadlineRisk(subWith({ carryForwardDeadline: '2026-12-25' }), today), RISK.none);
});

test('a deadline within a week warns', () => {
  assert.equal(deadlineRisk(subWith(), today), RISK.approaching);
});

test('meals that no longer fit are the urgent case', () => {
  assert.equal(deadlineRisk(subWith({ mealsBeyondDeadline: 2 }), today), RISK.overflowing);
});

test('a plan with nothing left to eat is not at risk', () => {
  assert.equal(deadlineRisk(subWith({ remainingMeals: 0 }), today), RISK.none);
});

test('an expired plan is past warning', () => {
  assert.equal(deadlineRisk(subWith({ expired: true, mealsBeyondDeadline: 3 }), today), RISK.none);
});

test('days are counted whole, and go negative once passed', () => {
  assert.equal(daysUntilDeadline(subWith(), today), 5);
  assert.equal(daysUntilDeadline(subWith({ carryForwardDeadline: '2026-11-10' }), today), -5);
});

test('the urgent message names the count and the date', () => {
  const message = deadlineMessage(subWith({ mealsBeyondDeadline: 2 }), today);
  assert.ok(message.includes('2 meals'));
  assert.ok(message.includes('20 Nov'));
});

test('one lost meal is not called "1 meals"', () => {
  assert.ok(deadlineMessage(subWith({ mealsBeyondDeadline: 1 }), today).startsWith('1 meal '));
});

test('the countdown reads naturally on the last days', () => {
  assert.ok(deadlineMessage(subWith(), today).includes('in 5 days'));
  assert.ok(deadlineMessage(subWith({ carryForwardDeadline: '2026-11-16' }), today).includes('tomorrow'));
  assert.ok(deadlineMessage(subWith({ carryForwardDeadline: '2026-11-15' }), today).includes('today'));
});

test('a safe plan is told nothing', () => {
  assert.equal(deadlineMessage(subWith({ carryForwardDeadline: '2026-12-25' }), today), null);
});

test('tracking explains itself before the driver sets off', () => {
  assert.match(etaText({ trackable: false, status: 'preparing' }), /out for delivery/);
  assert.match(etaText({ trackable: false, status: 'delivered' }), /delivered/);
});

test('tracking reports eta, queue position and distance', () => {
  const text = etaText({ trackable: true, etaMinutes: 12, stopsAway: 2, distanceKm: 3.4 });
  assert.ok(text.includes('About 12 min away'));
  assert.ok(text.includes('2 stop(s) before you'));
  assert.ok(text.includes('3.4 km'));
});

test('the customer being next is said plainly', () => {
  assert.ok(etaText({ trackable: true, etaMinutes: 1, stopsAway: 0 }).includes('Arriving now'));
  assert.ok(etaText({ trackable: true, etaMinutes: 1, stopsAway: 0 }).includes('you are next'));
});

test('a trackable order with no numbers still says something', () => {
  assert.equal(etaText({ trackable: true }), 'On the way');
});

test('a delivered order shows the kitchen note rather than a generic line', () => {
  assert.equal(
    etaText({ trackable: false, status: 'delivered', note: 'Your box of homemade goodness has been delivered! Enjoy the rich, healthy crunch.' }),
    'Your box of homemade goodness has been delivered! Enjoy the rich, healthy crunch.'
  );
});

test('an older server with no note still says something sensible', () => {
  assert.equal(etaText({ trackable: false, status: 'delivered' }), 'This order has been delivered.');
});

test('a past meal nobody skipped reads as served, not as unknown', () => {
  assert.equal(statusOf('elapsed').label, 'Delivered');
  assert.equal(statusOf('delivered').label, 'Delivered');
});

test('the two carry-forward states are told apart', () => {
  assert.equal(statusOf('skipped').label, 'Skipped');
  assert.equal(statusOf('maintenance').label, 'Kitchen closed');
  assert.notEqual(statusOf('skipped').tone, statusOf('maintenance').tone);
});

test('an unknown status still renders rather than blanking the row', () => {
  assert.equal(statusOf('something_new').label, 'something_new');
  assert.equal(statusOf(undefined).label, 'Scheduled');
});

test('a closed skip says when it closed instead of hiding the button', () => {
  const lunch = skipAvailability({ status: 'upcoming', meal: 'lunch', canCancel: false });
  assert.equal(lunch.canSkip, false);
  assert.equal(lunch.reason, 'Skipping closed at 11 am');
  assert.equal(skipAvailability({ status: 'upcoming', meal: 'dinner', canCancel: false }).reason, 'Skipping closed at 6 pm');
});

test('only an upcoming meal offers a skip', () => {
  assert.equal(skipAvailability({ status: 'upcoming', meal: 'lunch', canCancel: true }).canSkip, true);
  assert.equal(skipAvailability({ status: 'delivered', meal: 'lunch', canCancel: true }).canSkip, false);
  assert.equal(skipAvailability({ status: 'skipped', meal: 'lunch' }).reason, '');
});

test('two plans on one day land in one calendar cell, lunch before dinner', () => {
  const byDate = scheduleByDate([
    { id: 'a', itemName: 'Dinner plan', schedule: [{ date: '2026-10-21', meal: 'dinner', status: 'upcoming' }] },
    { id: 'b', itemName: 'Lunch plan', schedule: [{ date: '2026-10-21', meal: 'lunch', status: 'upcoming' }] }
  ], '2026-10');
  assert.equal(byDate['2026-10-21'].map((entry) => entry.meal).join(','), 'lunch,dinner');
  assert.equal(byDate['2026-10-21'][0].subscriptionName, 'Lunch plan');
});

test('the calendar only loads the month being looked at', () => {
  const byDate = scheduleByDate([
    { id: 'a', schedule: [{ date: '2026-10-21', meal: 'lunch' }, { date: '2026-11-03', meal: 'lunch' }] }
  ], '2026-10');
  assert.equal(Object.keys(byDate).join(','), '2026-10-21');
});

test('skipped and delivered meals are not counted as still to come', () => {
  const subs = [{ id: 'a', schedule: [
    { date: '2026-10-21', meal: 'lunch', status: 'upcoming' },
    { date: '2026-10-21', meal: 'dinner', status: 'upcoming' },
    { date: '2026-10-20', meal: 'lunch', status: 'delivered' },
    { date: '2026-10-22', meal: 'lunch', status: 'skipped' }
  ] }];
  assert.deepEqual(upcomingTotals(subs), { days: 1, meals: 2 });
  assert.equal(planSummary(subs), '1 delivery day · 2 meals left');
});

test('a customer with no plan is not shown a count of zero', () => {
  assert.equal(planSummary([]), 'No active plan');
  assert.equal(planSummary([{ id: 'a', schedule: [{ date: '2026-10-20', meal: 'lunch', status: 'delivered' }] }]), 'No meals left');
});

test('dates read as a person would say them', () => {
  assert.equal(formatMealDate('2026-10-21'), 'Wed, 21 Oct');
  assert.equal(formatMealDate('not-a-date'), 'not-a-date');
});

test('the short list reaches three days either side of today', () => {
  assert.equal(withinDays('2026-10-17', '2026-10-20'), true);
  assert.equal(withinDays('2026-10-23', '2026-10-20'), true);
  assert.equal(withinDays('2026-10-16', '2026-10-20'), false);
  assert.equal(withinDays('2026-10-24', '2026-10-20'), false);
});

test('the window spans a month boundary rather than stopping at the 1st', () => {
  assert.equal(withinDays('2026-09-29', '2026-10-01'), true);
  assert.equal(withinDays('2026-11-02', '2026-10-31'), true);
});

test('a missing or broken date is never counted as nearby', () => {
  assert.equal(withinDays('not-a-date', '2026-10-20'), false);
  assert.equal(withinDays('2026-10-20', ''), false);
});

test('feedback has to be one of the three kinds the kitchen sorts by', () => {
  assert.equal(feedbackError({ type: 'rant', message: 'Something is wrong.' }), 'Pick suggestion, praise or complaint.');
  assert.equal(feedbackError({ type: 'praise', message: 'Lovely food.' }), '');
});

test('the form refuses what the server would refuse, before the round trip', () => {
  assert.equal(feedbackError({ type: 'suggestion', message: '   ' }), 'Please tell us a little more.');
  assert.equal(feedbackError({ type: 'suggestion', message: 'ok' }), 'Please tell us a little more.');
  assert.match(feedbackError({ type: 'suggestion', message: 'x'.repeat(2001) }), /2000 characters/);
});

test('whitespace does not count towards the minimum', () => {
  assert.equal(feedbackError({ type: 'praise', message: '  ok  ' }), 'Please tell us a little more.');
  assert.equal(feedbackError({ type: 'praise', message: '  good  ' }), '');
});

test('a complaint is answered differently from a compliment', () => {
  assert.match(thanksFor('complaint'), /look into it/);
  assert.match(thanksFor('praise'), /kitchen will love/);
  assert.match(thanksFor('suggestion'), /gets read/);
});

test('an unpaid order counts down 30 minutes from when it was placed', () => {
  const placed = Date.parse('2026-10-21T10:00:00Z');
  const order = { status: 'pending_payment', createdAt: '2026-10-21T10:00:00Z' };
  assert.equal(timeLeftToPay(order, placed), PAYMENT_WINDOW_MS);
  assert.equal(formatCountdown(timeLeftToPay(order, placed)), '30:00');
  assert.equal(formatCountdown(timeLeftToPay(order, placed + 61_500)), '28:59');
  assert.equal(paymentWindowClosed(order, placed + PAYMENT_WINDOW_MS - 1), false);
  assert.equal(formatCountdown(timeLeftToPay(order, placed + PAYMENT_WINDOW_MS - 1)), '00:01');
  assert.equal(paymentWindowClosed(order, placed + PAYMENT_WINDOW_MS), true);
  assert.equal(timeLeftToPay(order, placed + PAYMENT_WINDOW_MS + 60_000), 0);
});

test('the countdown only applies while payment is still owed', () => {
  const createdAt = '2026-10-21T10:00:00Z';
  const later = Date.parse(createdAt) + 2 * PAYMENT_WINDOW_MS;
  for (const status of ['payment_review', 'paid', 'cancelled']) {
    assert.equal(timeLeftToPay({ status, createdAt }, later), null, status);
    assert.equal(paymentWindowClosed({ status, createdAt }, later), false, status);
  }
  assert.equal(timeLeftToPay(null), null);
  assert.equal(timeLeftToPay({ status: 'pending_payment', createdAt: 'nonsense' }), null);
});

test('the last five minutes are flagged as urgent', () => {
  assert.equal(isPaymentUrgent(5 * 60 * 1000), false);
  assert.equal(isPaymentUrgent(5 * 60 * 1000 - 1), true);
  assert.equal(isPaymentUrgent(null), false);
});

test('an order the server cancelled for non-payment reads as a closed window', () => {
  const timedOut = { status: 'cancelled', cancelReason: 'payment_timeout', createdAt: new Date().toISOString() };
  assert.equal(paymentWindowClosed(timedOut), true);
  assert.equal(orderStatusText(timedOut), 'cancelled · not paid in time');
  const byCustomer = { status: 'cancelled', createdAt: new Date().toISOString() };
  assert.equal(paymentWindowClosed(byCustomer), false);
  assert.equal(orderStatusText(byCustomer), 'cancelled');
  assert.equal(orderStatusText({ status: 'out_for_delivery' }), 'out for delivery');
});
